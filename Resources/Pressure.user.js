// Pressure - Steam Mobile Power-User Suite
// Execution scope: WKWebView on steamcommunity.com and store.steampowered.com

(function () {
  'use strict';

  if (window.__pressure_initialized) return;
  window.__pressure_initialized = true;

  // --- Native Bridge Interface ---
  const Bridge = {
    callbacks: new Map(),

    call(action, payload = {}) {
      return new Promise((resolve, reject) => {
        const callbackId = 'cb_' + Math.random().toString(36).substring(2, 11);
        this.callbacks.set(callbackId, { resolve, reject });

        const message = { action, callbackId, payload };
        if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.pressureBridge) {
          window.webkit.messageHandlers.pressureBridge.postMessage(message);
        } else {
          // Web preview fallback
          if (action === 'getConfig') resolve({});
          else if (action === 'authenticateBiometrics') resolve({ authenticated: true });
          else resolve({});
        }
      });
    },

    log(msg) {
      this.call('log', { message: msg }).catch(() => {});
    }
  };

  window.__pressureNativeResponse = function (res) {
    if (!res || !res.callbackId) return;
    const pending = Bridge.callbacks.get(res.callbackId);
    if (!pending) return;

    Bridge.callbacks.delete(res.callbackId);
    if (res.error) {
      pending.reject(new Error(res.error));
    } else {
      pending.resolve(res.data);
    }
  };

  // --- State & Defaults ---
  const State = {
    config: {
      enabled: true,
      safeMode: false,
      showPriceBadges: true,
      externalPrices: false,
      externalPriceSource: 'CSFloat',
      massSellEnabled: true,
      quickBuyOrderSell: true,
      biometricsForConfirmations: true,
      massConfirmTrades: false,
      tradeValuationWarning: true,
      tradeLossThresholdPercent: 15.0,
      minPriceRatio: 0.50,
      maxPriceRatio: 3.00,
      requestDelayMs: 350,
      priceCacheTtlSeconds: 3600
    },
    selectedItems: new Map(),
    inventoryTotalValue: 0,
    currencySymbol: '$',
    isProcessingQueue: false,
    stopQueueRequested: false
  };

  // --- Network Layer with Throttle, Queue, and Exponential Backoff ---
  class NetworkQueue {
    constructor() {
      this.queue = [];
      this.activeWorkers = 0;
      this.maxConcurrent = 2;
      this.lastRequestTime = 0;
    }

    enqueue(requestFn, abortSignal) {
      return new Promise((resolve, reject) => {
        this.queue.push({ requestFn, abortSignal, resolve, reject, retries: 0 });
        this.processNext();
      });
    }

    async processNext() {
      if (this.activeWorkers >= this.maxConcurrent || this.queue.length === 0) return;

      const item = this.queue.shift();
      if (item.abortSignal && item.abortSignal.aborted) {
        item.reject(new DOMException('Aborted', 'AbortError'));
        return this.processNext();
      }

      this.activeWorkers++;

      const now = Date.now();
      const elapsed = now - this.lastRequestTime;
      const delay = Math.max(0, State.config.requestDelayMs - elapsed);
      if (delay > 0) {
        await new Promise(r => setTimeout(r, delay));
      }
      this.lastRequestTime = Date.now();

      try {
        const response = await item.requestFn();
        if (response.status === 429 || response.status >= 500) {
          throw { status: response.status, response };
        }
        item.resolve(response);
      } catch (err) {
        const status = err.status || (err.response && err.response.status);
        if ((status === 429 || status >= 500) && item.retries < 3) {
          item.retries++;
          const backoff = Math.pow(2, item.retries) * 1000 + Math.random() * 500;
          Bridge.log(`Backoff on HTTP ${status}: retrying in ${Math.round(backoff)}ms (attempt ${item.retries})`);
          await new Promise(r => setTimeout(r, backoff));
          this.queue.unshift(item);
        } else {
          item.reject(err);
        }
      } finally {
        this.activeWorkers--;
        this.processNext();
      }
    }
  }

  const Net = new NetworkQueue();

  // --- Cache Engine ---
  const Cache = {
    getKey(type, id) {
      return `pressure_cache_${type}_${id}`;
    },

    get(type, id) {
      try {
        const raw = localStorage.getItem(this.getKey(type, id));
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (Date.now() > entry.expiry) {
          localStorage.removeItem(this.getKey(type, id));
          return null;
        }
        return entry.data;
      } catch (e) {
        return null;
      }
    },

    set(type, id, data, ttlSeconds = State.config.priceCacheTtlSeconds) {
      try {
        const entry = {
          data,
          expiry: Date.now() + ttlSeconds * 1000
        };
        localStorage.setItem(this.getKey(type, id), JSON.stringify(entry));
      } catch (e) {}
    }
  };

  // --- Steam Fee Calculation Engine ---
  const FeeEngine = {
    // Dynamic fees taken from page context (g_rgWalletInfo) or defaults
    getFees() {
      let steamFee = 0.05;
      let publisherFee = 0.10;

      if (window.g_rgWalletInfo) {
        if (typeof window.g_rgWalletInfo.wallet_fee_percent !== 'undefined') {
          steamFee = parseFloat(window.g_rgWalletInfo.wallet_fee_percent);
        }
        if (typeof window.g_rgWalletInfo.wallet_publisher_fee_percent_default !== 'undefined') {
          publisherFee = parseFloat(window.g_rgWalletInfo.wallet_publisher_fee_percent_default);
        }
      }
      return { steamFee, publisherFee };
    },

    // Standard Valve integer cents rounding algorithm
    calculateAmounts(receiveAmountCents) {
      const { steamFee, publisherFee } = this.getFees();

      const steamCut = Math.max(Math.floor(receiveAmountCents * steamFee), 1);
      const publisherCut = Math.max(Math.floor(receiveAmountCents * publisherFee), 1);
      const buyerPaysCents = receiveAmountCents + steamCut + publisherCut;

      return {
        sellerReceives: receiveAmountCents,
        buyerPays: buyerPaysCents,
        steamFee: steamCut,
        publisherFee: publisherCut
      };
    },

    calculateFromBuyerPays(buyerPaysCents) {
      let low = 1;
      let high = buyerPaysCents;
      let best = 1;

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const res = this.calculateAmounts(mid);
        if (res.buyerPays <= buyerPaysCents) {
          best = mid;
          low = mid + 1;
        } else {
          high = mid - 1;
        }
      }
      return this.calculateAmounts(best);
    }
  };

  // --- Price Services ---
  const PriceService = {
    async fetchSteamPrice(appid, marketHashName, signal) {
      const cached = Cache.get('steam_price', `${appid}_${marketHashName}`);
      if (cached) return cached;

      const url = `/market/priceoverview/?currency=1&appid=${appid}&market_hash_name=${encodeURIComponent(marketHashName)}`;
      const res = await Net.enqueue(() => fetch(url, { signal }), signal);
      const data = await res.json();

      if (data && data.success) {
        const parsed = {
          lowestPrice: data.lowest_price || null,
          medianPrice: data.median_price || null,
          volume: data.volume || null,
          lowestCents: PriceService.parsePriceToCents(data.lowest_price),
          medianCents: PriceService.parsePriceToCents(data.median_price)
        };
        Cache.set('steam_price', `${appid}_${marketHashName}`, parsed);
        return parsed;
      }
      return null;
    },

    async fetchExternalPrice(marketHashName, signal) {
      if (!State.config.externalPrices) return null;

      const cached = Cache.get('ext_price', marketHashName);
      if (cached) return cached;

      try {
        // Safe public read-only pricing endpoint (CSFloat reference)
        const url = `https://csfloat.com/api/v1/listings/pricing?market_hash_name=${encodeURIComponent(marketHashName)}`;
        const res = await fetch(url, { signal });
        if (res.ok) {
          const data = await res.json();
          const result = {
            price: data.price ? `$${(data.price / 100).toFixed(2)}` : null,
            source: 'CSFloat'
          };
          Cache.set('ext_price', marketHashName, result, 7200);
          return result;
        }
      } catch (e) {}
      return null;
    },

    async fetchItemNameId(marketUrl, signal) {
      const cached = Cache.get('item_nameid', marketUrl);
      if (cached) return cached;

      try {
        const res = await Net.enqueue(() => fetch(marketUrl, { signal }), signal);
        const html = await res.text();
        const match = html.match(/Market_LoadOrderSpread\(\s*(\d+)\s*\)/);
        if (match && match[1]) {
          const id = match[1];
          Cache.set('item_nameid', marketUrl, id, 86400 * 30);
          return id;
        }
      } catch (e) {}
      return null;
    },

    async fetchHighestBuyOrder(itemNameId, signal) {
      if (!itemNameId) return null;
      const url = `/market/itemordershistogram?country=US&language=english&currency=1&item_nameid=${itemNameId}&two_factor=0`;
      try {
        const res = await Net.enqueue(() => fetch(url, { signal }), signal);
        const data = await res.json();
        if (data && data.buy_order_graph && data.buy_order_graph.length > 0) {
          const highestOrderPrice = data.buy_order_graph[0][0]; // price in dollars
          return Math.round(highestOrderPrice * 100);
        }
      } catch (e) {}
      return null;
    },

    parsePriceToCents(str) {
      if (!str) return 0;
      const num = parseFloat(str.replace(/[^0-9.]/g, ''));
      return isNaN(num) ? 0 : Math.round(num * 100);
    }
  };

  // --- UI Module: Inventory Enhancement ---
  const InventoryEnhancer = {
    observer: null,

    init() {
      if (!window.location.pathname.includes('/inventory')) return;

      this.injectToolbar();
      this.setupItemObserver();
      this.hookInventoryGrid();
    },

    injectToolbar() {
      if (document.getElementById('pressure-inv-toolbar')) return;

      const container = document.querySelector('.inventory_page_left') || document.getElementById('inventories');
      if (!container) return;

      const toolbar = document.createElement('div');
      toolbar.id = 'pressure-inv-toolbar';
      toolbar.className = 'pressure-inventory-toolbar';
      toolbar.innerHTML = `
        <div class="pressure-toolbar-group">
          <div class="pressure-valuation-box">
            Est. Value: <span id="pressure-inv-val" class="pressure-valuation-value">$0.00</span>
          </div>
          <button id="pressure-select-all-btn" class="pressure-btn secondary">Select All</button>
          <button id="pressure-clear-sel-btn" class="pressure-btn secondary">Clear</button>
        </div>
        <div class="pressure-toolbar-group">
          <select id="pressure-sort-select" class="pressure-select">
            <option value="default">Sort: Default</option>
            <option value="price-desc">Price: High → Low</option>
            <option value="price-asc">Price: Low → High</option>
            <option value="name">Name: A-Z</option>
          </select>
          <button id="pressure-mass-sell-btn" class="pressure-btn green" style="display:none;">
            Sell Selected (<span id="pressure-sel-count">0</span>)
          </button>
        </div>
      `;

      container.parentNode.insertBefore(toolbar, container);

      document.getElementById('pressure-select-all-btn').onclick = () => this.selectAllVisible();
      document.getElementById('pressure-clear-sel-btn').onclick = () => this.clearSelection();
      document.getElementById('pressure-mass-sell-btn').onclick = () => MassSellModal.open();
      document.getElementById('pressure-sort-select').onchange = (e) => this.sortItems(e.target.value);
    },

    setupItemObserver() {
      // Lazy loading price data only for visible cards to avoid rate limit spikes
      this.observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            this.loadItemPrice(entry.target);
            this.observer.unobserve(entry.target);
          }
        });
      }, { rootMargin: '100px' });
    },

    hookInventoryGrid() {
      const items = document.querySelectorAll('.itemHolder .item');
      items.forEach(el => this.decorateItem(el));

      const mutationObs = new MutationObserver(() => {
        const newItems = document.querySelectorAll('.itemHolder .item:not([data-pressure-hooked])');
        newItems.forEach(el => this.decorateItem(el));
      });

      const invRoot = document.getElementById('inventories');
      if (invRoot) mutationObs.observe(invRoot, { childList: true, subtree: true });
    },

    decorateItem(itemEl) {
      if (itemEl.dataset.pressureHooked) return;
      itemEl.dataset.pressureHooked = '1';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'pressure-item-checkbox';
      checkbox.onclick = (e) => {
        e.stopPropagation();
        this.toggleItemSelection(itemEl, checkbox.checked);
      };

      itemEl.style.position = 'relative';
      itemEl.appendChild(checkbox);

      if (State.config.showPriceBadges && this.observer) {
        this.observer.observe(itemEl);
      }
    },

    async loadItemPrice(itemEl) {
      const itemData = this.getItemDataFromElement(itemEl);
      if (!itemData || !itemData.market_hash_name) return;

      const priceBadge = document.createElement('div');
      priceBadge.className = 'pressure-price-badge';
      priceBadge.textContent = '...';
      itemEl.appendChild(priceBadge);

      try {
        const prices = await PriceService.fetchSteamPrice(itemData.appid, itemData.market_hash_name);
        if (prices && prices.lowestPrice) {
          priceBadge.textContent = prices.lowestPrice;
          itemEl.dataset.priceCents = prices.lowestCents;

          State.inventoryTotalValue += prices.lowestCents;
          this.updateValuationDisplay();

          if (State.config.externalPrices) {
            const ext = await PriceService.fetchExternalPrice(itemData.market_hash_name);
            if (ext && ext.price) {
              priceBadge.textContent = `${prices.lowestPrice} (${ext.price})`;
              priceBadge.classList.add('external');
            }
          }
        } else {
          priceBadge.textContent = 'No listing';
          itemEl.dataset.priceCents = '0';
        }
      } catch (e) {
        priceBadge.textContent = '-';
      }
    },

    getItemDataFromElement(el) {
      // Steam inventory objects are attached to g_rgAppContextData or el.rgItem
      if (el.rgItem) return el.rgItem;
      const match = el.id.match(/item(\d+)_(\d+)_(\d+)/);
      if (match && window.g_ActiveInventory && window.g_ActiveInventory.m_rgItemData) {
        return window.g_ActiveInventory.m_rgItemData[match[3]];
      }
      return null;
    },

    toggleItemSelection(el, selected) {
      const data = this.getItemDataFromElement(el);
      if (!data) return;

      if (selected) {
        State.selectedItems.set(data.id || el.id, { element: el, data });
      } else {
        State.selectedItems.delete(data.id || el.id);
      }

      this.updateSelectionUI();
    },

    selectAllVisible() {
      const items = document.querySelectorAll('.itemHolder .item:not([style*="display: none"])');
      items.forEach(el => {
        const cb = el.querySelector('.pressure-item-checkbox');
        if (cb && !cb.checked) {
          cb.checked = true;
          this.toggleItemSelection(el, true);
        }
      });
    },

    clearSelection() {
      document.querySelectorAll('.pressure-item-checkbox:checked').forEach(cb => {
        cb.checked = false;
      });
      State.selectedItems.clear();
      this.updateSelectionUI();
    },

    updateSelectionUI() {
      const count = State.selectedItems.size;
      const btn = document.getElementById('pressure-mass-sell-btn');
      const countSpan = document.getElementById('pressure-sel-count');

      if (countSpan) countSpan.textContent = count;
      if (btn) btn.style.display = count > 0 ? 'inline-block' : 'none';
    },

    updateValuationDisplay() {
      const valEl = document.getElementById('pressure-inv-val');
      if (valEl) {
        valEl.textContent = `$${(State.inventoryTotalValue / 100).toFixed(2)}`;
      }
    },

    sortItems(order) {
      const container = document.querySelector('.inventory_page_right .inventory_ctn:not([style*="display: none"])');
      if (!container) return;

      const holders = Array.from(container.querySelectorAll('.itemHolder'));
      holders.sort((a, b) => {
        const itemA = a.querySelector('.item');
        const itemB = b.querySelector('.item');
        const pA = parseInt((itemA && itemA.dataset.priceCents) || '0', 10);
        const pB = parseInt((itemB && itemB.dataset.priceCents) || '0', 10);

        if (order === 'price-desc') return pB - pA;
        if (order === 'price-asc') return pA - pB;
        return 0;
      });

      holders.forEach(h => container.appendChild(h));
    }
  };

  // --- UI Module: Mass Sell Modal & Engine ---
  const MassSellModal = {
    modalEl: null,

    open() {
      if (State.selectedItems.size === 0) return;

      this.createModal();
      this.populatePreview();
    },

    createModal() {
      if (this.modalEl) this.modalEl.remove();

      const overlay = document.createElement('div');
      overlay.className = 'pressure-modal-overlay';
      overlay.innerHTML = `
        <div class="pressure-modal">
          <div class="pressure-modal-header">
            <span class="pressure-modal-title">Pressure — Mass Sell (${State.selectedItems.size} items)</span>
            <button class="pressure-modal-close">&times;</button>
          </div>
          <div class="pressure-modal-body">
            <div style="display:flex; gap:12px; align-items:center; margin-bottom:12px;">
              <label style="font-size:12px;">Pricing Mode:</label>
              <select id="pressure-mode-select" class="pressure-select">
                <option value="lowest">Lowest Market Listing</option>
                <option value="undercut">Lowest Listing - 1 cent</option>
                <option value="buyorder">Instant Buy Order</option>
                <option value="median">100% of Median Price</option>
              </select>
              <label style="font-size:12px; margin-left:auto;">
                <input type="checkbox" id="pressure-dry-run"> Dry Run (Simulation)
              </label>
            </div>
            <div id="pressure-safeguard-warning" style="display:none; color:#f0ad4e; font-size:11px; margin-bottom:8px;"></div>
            <div class="pressure-progress-bar-container" style="display:none;" id="pressure-progress-cnt">
              <div class="pressure-progress-bar" id="pressure-progress-bar"></div>
            </div>
            <table class="pressure-table" id="pressure-sell-table">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Buyer Pays</th>
                  <th>You Receive</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
          <div class="pressure-modal-footer">
            <button class="pressure-btn secondary" id="pressure-sell-cancel-btn">Cancel</button>
            <button class="pressure-btn red" id="pressure-sell-stop-btn" style="display:none;">STOP</button>
            <button class="pressure-btn green" id="pressure-sell-confirm-btn">Start Listing Queue</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);
      this.modalEl = overlay;

      overlay.querySelector('.pressure-modal-close').onclick = () => this.close();
      overlay.querySelector('#pressure-sell-cancel-btn').onclick = () => this.close();
      overlay.querySelector('#pressure-sell-stop-btn').onclick = () => { State.stopQueueRequested = true; };
      overlay.querySelector('#pressure-sell-confirm-btn').onclick = () => this.startExecutionQueue();
      overlay.querySelector('#pressure-mode-select').onchange = () => this.populatePreview();
    },

    close() {
      if (this.modalEl) {
        this.modalEl.remove();
        this.modalEl = null;
      }
    },

    populatePreview() {
      const tbody = this.modalEl.querySelector('#pressure-sell-table tbody');
      tbody.innerHTML = '';

      const mode = this.modalEl.querySelector('#pressure-mode-select').value;

      State.selectedItems.forEach((entry) => {
        const item = entry.data;
        const baseCents = parseInt(entry.element.dataset.priceCents || '100', 10);
        let buyerCents = baseCents;

        if (mode === 'undercut') buyerCents = Math.max(3, baseCents - 1);
        else if (mode === 'median') buyerCents = baseCents;

        const breakdown = FeeEngine.calculateFromBuyerPays(buyerCents);
        entry.computedBreakdown = breakdown;

        const tr = document.createElement('tr');
        tr.id = `sell-row-${item.id}`;
        tr.innerHTML = `
          <td>${item.market_hash_name || item.name || 'Steam Item'}</td>
          <td>$${(breakdown.buyerPays / 100).toFixed(2)}</td>
          <td style="color:#a4d007; font-weight:bold;">$${(breakdown.sellerReceives / 100).toFixed(2)}</td>
          <td class="status-cell">Ready</td>
        `;
        tbody.appendChild(tr);
      });
    },

    async startExecutionQueue() {
      const isDryRun = this.modalEl.querySelector('#pressure-dry-run').checked;
      const confirmBtn = this.modalEl.querySelector('#pressure-sell-confirm-btn');
      const stopBtn = this.modalEl.querySelector('#pressure-sell-stop-btn');
      const progressCnt = this.modalEl.querySelector('#pressure-progress-cnt');
      const progressBar = this.modalEl.querySelector('#pressure-progress-bar');

      confirmBtn.style.display = 'none';
      stopBtn.style.display = 'inline-block';
      progressCnt.style.display = 'block';

      State.isProcessingQueue = true;
      State.stopQueueRequested = false;

      const items = Array.from(State.selectedItems.values());
      const total = items.length;
      let completed = 0;

      for (const entry of items) {
        if (State.stopQueueRequested) {
          Bridge.log('Execution queue stopped by user request.');
          break;
        }

        const item = entry.data;
        const row = document.getElementById(`sell-row-${item.id}`);
        const statusCell = row ? row.querySelector('.status-cell') : null;
        if (statusCell) statusCell.textContent = 'Listing...';

        try {
          if (isDryRun) {
            await new Promise(r => setTimeout(r, 150));
            if (statusCell) statusCell.textContent = 'Simulation OK';
          } else {
            await this.sellItemOnMarket(item, entry.computedBreakdown);
            if (statusCell) {
              statusCell.textContent = 'Success (Pending Conf)';
              statusCell.style.color = '#5c7e10';
            }
          }
        } catch (err) {
          if (statusCell) {
            statusCell.textContent = `Failed: ${err.message || 'Error'}`;
            statusCell.style.color = '#d9534f';
          }
        }

        completed++;
        progressBar.style.width = `${Math.round((completed / total) * 100)}%`;
      }

      State.isProcessingQueue = false;
      stopBtn.style.display = 'none';
      confirmBtn.style.display = 'inline-block';
      confirmBtn.textContent = 'Done';
      confirmBtn.onclick = () => this.close();
    },

    async sellItemOnMarket(item, breakdown) {
      if (!window.g_sessionID) throw new Error('Session ID not found');

      const params = new URLSearchParams();
      params.append('sessionid', window.g_sessionID);
      params.append('appid', item.appid);
      params.append('contextid', item.contextid || '2');
      params.append('assetid', item.id || item.assetid);
      params.append('amount', '1');
      params.append('price', breakdown.sellerReceives);

      const res = await Net.enqueue(() => fetch('/market/sellitem/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
        body: params.toString()
      }));

      const data = await res.json();
      if (!data || !data.success) {
        throw new Error(data.message || 'Market rejected listing');
      }
      return data;
    }
  };

  // --- UI Module: Trade Valuation Warning ---
  const TradeEnhancer = {
    init() {
      if (!window.location.pathname.includes('/tradeoffer')) return;

      this.injectValuationBanner();
      this.monitorTradeChanges();
    },

    injectValuationBanner() {
      if (document.getElementById('pressure-trade-banner')) return;

      const container = document.getElementById('trade_offer_reciprocal') || document.querySelector('.trade_offer_container');
      if (!container) return;

      const banner = document.createElement('div');
      banner.id = 'pressure-trade-banner';
      banner.className = 'pressure-trade-banner';
      banner.innerHTML = `
        <div class="pressure-trade-comparison">
          <div class="pressure-trade-side">
            <div>You Give</div>
            <div class="amount" id="pressure-give-val">$0.00</div>
          </div>
          <div class="pressure-trade-side">
            <div>You Receive</div>
            <div class="amount" id="pressure-receive-val">$0.00</div>
          </div>
          <div class="pressure-trade-side">
            <div>Net Difference</div>
            <div class="amount" id="pressure-diff-val">$0.00</div>
          </div>
        </div>
        <div id="pressure-trade-alert" class="pressure-trade-warning" style="display:none;"></div>
      `;

      container.parentNode.insertBefore(banner, container);
    },

    monitorTradeChanges() {
      const obs = new MutationObserver(() => this.recalculateTrade());
      const yourSlots = document.getElementById('your_slots');
      const theirSlots = document.getElementById('their_slots');
      if (yourSlots) obs.observe(yourSlots, { childList: true, subtree: true });
      if (theirSlots) obs.observe(theirSlots, { childList: true, subtree: true });
    },

    async recalculateTrade() {
      // Recalculates value using cached market pricing
      const giveItems = document.querySelectorAll('#your_slots .item');
      const receiveItems = document.querySelectorAll('#their_slots .item');

      let giveCents = 0;
      let receiveCents = 0;

      giveItems.forEach(el => { giveCents += parseInt(el.dataset.priceCents || '0', 10); });
      receiveItems.forEach(el => { receiveCents += parseInt(el.dataset.priceCents || '0', 10); });

      const giveValEl = document.getElementById('pressure-give-val');
      const receiveValEl = document.getElementById('pressure-receive-val');
      const diffValEl = document.getElementById('pressure-diff-val');
      const alertEl = document.getElementById('pressure-trade-alert');

      if (giveValEl) giveValEl.textContent = `$${(giveCents / 100).toFixed(2)}`;
      if (receiveValEl) receiveValEl.textContent = `$${(receiveCents / 100).toFixed(2)}`;

      const diff = receiveCents - giveCents;
      if (diffValEl) {
        diffValEl.textContent = `${diff >= 0 ? '+' : '-'}$${(Math.abs(diff) / 100).toFixed(2)}`;
        diffValEl.style.color = diff >= 0 ? '#5c7e10' : '#d9534f';
      }

      if (giveCents > 0 && State.config.tradeValuationWarning) {
        const lossPercent = ((giveCents - receiveCents) / giveCents) * 100;
        if (lossPercent >= State.config.tradeLossThresholdPercent) {
          alertEl.style.display = 'block';
          alertEl.textContent = `Warning: You are losing ${lossPercent.toFixed(1)}% of total value in this trade offer.`;
        } else {
          alertEl.style.display = 'none';
        }
      }
    }
  };

  // --- UI Module: Profile Chat Launcher ---
  const ProfileEnhancer = {
    init() {
      if (!window.location.pathname.match(/\/(id|profiles)\/[^/]+\/?$/)) return;

      this.injectChatButtons();
    },

    injectChatButtons() {
      if (document.getElementById('pressure-profile-chat-btn')) return;

      const actionPanel = document.querySelector('.profile_header_actions') || document.querySelector('.responsive_profile_header_actions');
      if (!actionPanel) return;

      // Extract target SteamID from page source or links
      let targetSteamId = null;
      if (window.g_rgProfileData && window.g_rgProfileData.steamid) {
        targetSteamId = window.g_rgProfileData.steamid;
      }

      const btn = document.createElement('a');
      btn.id = 'pressure-profile-chat-btn';
      btn.className = 'pressure-btn';
      btn.style.marginLeft = '8px';
      btn.textContent = 'Steam Chat';
      btn.onclick = (e) => {
        e.preventDefault();
        if (targetSteamId) {
          Bridge.call('openChatDeepLink', { steamId: targetSteamId });
        } else {
          alert('Could not resolve user SteamID');
        }
      };

      actionPanel.appendChild(btn);
    }
  };

  // --- UI Module: Floating Launcher & Settings Modal ---
  const SettingsLauncher = {
    init() {
      if (document.getElementById('pressure-fab-btn')) return;

      const fab = document.createElement('div');
      fab.id = 'pressure-fab-btn';
      fab.className = 'pressure-fab';
      fab.title = 'Pressure Settings';
      fab.textContent = 'P';
      fab.onclick = () => this.openSettings();

      document.body.appendChild(fab);
    },

    async openSettings() {
      const logs = await Bridge.call('getLogs').catch(() => ({ logs: [] }));

      const overlay = document.createElement('div');
      overlay.className = 'pressure-modal-overlay';
      overlay.innerHTML = `
        <div class="pressure-modal">
          <div class="pressure-modal-header">
            <span class="pressure-modal-title">Pressure — Settings & Diagnostics</span>
            <button class="pressure-modal-close">&times;</button>
          </div>
          <div class="pressure-modal-body">
            <div style="display:flex; flex-direction:column; gap:12px; font-size:13px;">
              <label>
                <input type="checkbox" id="cfg-badges" ${State.config.showPriceBadges ? 'checked' : ''}>
                Show Market Prices on Inventory Items
              </label>
              <label>
                <input type="checkbox" id="cfg-ext" ${State.config.externalPrices ? 'checked' : ''}>
                Enable External Pricing (CSFloat / Skinport)
              </label>
              <label>
                <input type="checkbox" id="cfg-bio" ${State.config.biometricsForConfirmations ? 'checked' : ''}>
                Require Face ID / Passcode for Mass Confirmations
              </label>
              <label>
                <input type="checkbox" id="cfg-trades" ${State.config.massConfirmTrades ? 'checked' : ''}>
                Allow Mass Confirmation of Trade Offers (Dangerous)
              </label>
              <label>
                <input type="checkbox" id="cfg-trade-warn" ${State.config.tradeValuationWarning ? 'checked' : ''}>
                Warn on Trade Value Deficit (> ${State.config.tradeLossThresholdPercent}%)
              </label>
            </div>
            <div style="margin-top:16px;">
              <div style="font-size:12px; color:#8f98a0; margin-bottom:6px;">Circular Diagnostics Log (Redacted):</div>
              <textarea readonly style="width:100%; height:140px; background:#101418; color:#a4d007; font-family:monospace; font-size:10px; border:1px solid #2a475e; border-radius:4px; padding:6px;">${(logs.logs || []).join('\n')}</textarea>
            </div>
          </div>
          <div class="pressure-modal-footer">
            <button class="pressure-btn green" id="cfg-save-btn">Save Settings</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      overlay.querySelector('.pressure-modal-close').onclick = () => overlay.remove();
      overlay.querySelector('#cfg-save-btn').onclick = async () => {
        State.config.showPriceBadges = overlay.querySelector('#cfg-badges').checked;
        State.config.externalPrices = overlay.querySelector('#cfg-ext').checked;
        State.config.biometricsForConfirmations = overlay.querySelector('#cfg-bio').checked;
        State.config.massConfirmTrades = overlay.querySelector('#cfg-trades').checked;
        State.config.tradeValuationWarning = overlay.querySelector('#cfg-trade-warn').checked;

        await Bridge.call('saveConfig', State.config);
        overlay.remove();
      };
    }
  };

  // --- Bootstrap ---
  async function bootstrap() {
    try {
      const cfg = await Bridge.call('getConfig');
      if (cfg) Object.assign(State.config, cfg);
    } catch (e) {}

    if (!State.config.enabled || State.config.safeMode) return;

    SettingsLauncher.init();
    InventoryEnhancer.init();
    TradeEnhancer.init();
    ProfileEnhancer.init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
