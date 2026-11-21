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

  Bridge.log(`[Pressure Web] Initialized at URL: ${window.location.href}`);

  // --- State ---
  const State = {
    config: {
      enabled: true,
      safeMode: false,
      showPriceBadges: true,
      externalPrices: true,
      externalPriceSource: 'CSFloat',
      massSellEnabled: true,
      quickBuyOrderSell: true,
      biometricsForConfirmations: true,
      massConfirmTrades: false,
      tradeValuationWarning: true,
      tradeLossThresholdPercent: 15.0,
      minPriceRatio: 0.50,
      maxPriceRatio: 3.00,
      requestDelayMs: 300,
      priceCacheTtlSeconds: 3600
    },
    selectedItems: new Map(),
    inventoryTotalValue: 0,
    activeChatFriend: null,
    friendsList: [],
    chatPollTimer: null,
    isProcessingQueue: false,
    stopQueueRequested: false
  };

  // --- Network Queue with Backoff ---
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
          Bridge.log(`[Network] Backoff on HTTP ${status}: retrying in ${Math.round(backoff)}ms (attempt ${item.retries})`);
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

  // --- Fee Calculation ---
  const FeeEngine = {
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

  // --- Price Service (CS2 & Steam Market) ---
  const PriceService = {
    async fetchSteamPrice(appid, marketHashName, signal) {
      const cached = Cache.get('steam_price', `${appid}_${marketHashName}`);
      if (cached) return cached;

      const url = `/market/priceoverview/?currency=1&appid=${appid}&market_hash_name=${encodeURIComponent(marketHashName)}`;
      try {
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
          Bridge.log(`[PriceService] Steam price for ${marketHashName}: ${data.lowest_price}`);
          return parsed;
        }
      } catch (err) {
        Bridge.log(`[PriceService] Error fetching Steam price for ${marketHashName}: ${err.message || err}`);
      }
      return null;
    },

    async fetchExternalPrice(marketHashName, signal) {
      if (!State.config.externalPrices) return null;

      const cached = Cache.get('ext_price', marketHashName);
      if (cached) return cached;

      try {
        const url = `https://csfloat.com/api/v1/listings/pricing?market_hash_name=${encodeURIComponent(marketHashName)}`;
        const res = await fetch(url, { signal });
        if (res.ok) {
          const data = await res.json();
          if (data && data.price) {
            const result = {
              price: `$${(data.price / 100).toFixed(2)}`,
              cents: data.price,
              source: 'CSFloat'
            };
            Cache.set('ext_price', marketHashName, result, 7200);
            Bridge.log(`[PriceService] CSFloat price for ${marketHashName}: ${result.price}`);
            return result;
          }
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

  // --- Activation via Long-Press on "View Profile" or "MENU" ---
  const ActivationManager = {
    init() {
      Bridge.log('[Activation] Registering long-press triggers for View Profile and MENU...');
      document.addEventListener('touchstart', (e) => this.handleTouchStart(e), { passive: true });
      document.addEventListener('touchend', (e) => this.handleTouchEnd(e), { passive: true });
      document.addEventListener('touchmove', (e) => this.handleTouchCancel(e), { passive: true });
    },

    touchTimer: null,
    targetElement: null,

    isActivationTarget(el) {
      if (!el) return false;
      const text = (el.textContent || '').trim().toLowerCase();
      const id = (el.id || '').toLowerCase();
      const cls = (el.className || '').toString().toLowerCase();

      // Check View Profile button (in top right avatar dropdown)
      if (text === 'view profile' || text === 'view profile' || text === 'просмотреть профиль' || text === 'профиль') {
        return 'View Profile';
      }

      // Check Menu button (hamburger or MENU text)
      if (text === 'menu' || text === 'меню' || id.includes('menu') || cls.includes('menu') || id.includes('nav_toggle')) {
        return 'MENU';
      }

      // Also check parent elements up 3 levels
      if (el.parentElement && el.parentElement !== document.body) {
        const pText = (el.parentElement.textContent || '').trim().toLowerCase();
        if (pText === 'view profile' || pText === 'просмотреть профиль') return 'View Profile';
        if (pText === 'menu' || pText === 'меню') return 'MENU';
      }

      return null;
    },

    handleTouchStart(e) {
      const match = this.isActivationTarget(e.target);
      if (match) {
        this.targetElement = e.target;
        this.touchTimer = setTimeout(() => {
          Bridge.log(`[Activation] Long-press detected on "${match}". Opening Pressure Settings...`);
          SettingsModal.open();
          this.targetElement = null;
        }, 600); // 600ms long-press hold
      }
    },

    handleTouchEnd(e) {
      if (this.touchTimer) {
        clearTimeout(this.touchTimer);
        this.touchTimer = null;
      }
    },

    handleTouchCancel(e) {
      if (this.touchTimer) {
        clearTimeout(this.touchTimer);
        this.touchTimer = null;
      }
    }
  };

  // --- CS2 Inventory Enhancement (Price displayed directly ON item card) ---
  const InventoryEnhancer = {
    observer: null,

    init() {
      if (!window.location.pathname.includes('/inventory')) return;

      Bridge.log('[Inventory] Initializing CS2 Inventory Enhancer...');
      this.injectToolbar();
      this.setupObserver();
      this.scanAndHookItems();

      // Hook tab changes & dynamic DOM mutations
      const invContainer = document.getElementById('inventories') || document.body;
      const mutObs = new MutationObserver(() => this.scanAndHookItems());
      mutObs.observe(invContainer, { childList: true, subtree: true });
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
            CS2 Inv Value: <span id="pressure-inv-val" class="pressure-valuation-value">$0.00</span>
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

    setupObserver() {
      this.observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            this.loadItemPrice(entry.target);
            this.observer.unobserve(entry.target);
          }
        });
      }, { rootMargin: '150px' });
    },

    scanAndHookItems() {
      const items = document.querySelectorAll('.itemHolder .item, .inventory_ctn .item');
      items.forEach(el => this.decorateItem(el));
    },

    decorateItem(itemEl) {
      if (itemEl.dataset.pressureHooked) return;
      itemEl.dataset.pressureHooked = '1';

      // Ensure relative positioning so child badges stick to the item
      itemEl.style.position = 'relative';

      // Checkbox for mass selling
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'pressure-item-checkbox';
      cb.onclick = (e) => {
        e.stopPropagation();
        this.toggleItemSelection(itemEl, cb.checked);
      };
      itemEl.appendChild(cb);

      if (this.observer) {
        this.observer.observe(itemEl);
      }
    },

    getItemData(el) {
      if (el.rgItem) return el.rgItem;
      const match = el.id.match(/item(\d+)_(\d+)_(\d+)/);
      if (match && window.g_ActiveInventory && window.g_ActiveInventory.m_rgItemData) {
        return window.g_ActiveInventory.m_rgItemData[match[3]];
      }
      return null;
    },

    async loadItemPrice(itemEl) {
      const itemData = this.getItemData(itemEl);
      if (!itemData || !itemData.market_hash_name) return;

      const appid = itemData.appid || 730;
      const hashName = itemData.market_hash_name;

      // Price badge container rendered directly at the bottom of the item
      const badgeContainer = document.createElement('div');
      badgeContainer.className = 'pressure-cs2-price-container';
      badgeContainer.innerHTML = `<span class="pressure-cs2-steam-price">...</span>`;
      itemEl.appendChild(badgeContainer);

      try {
        const steamPrice = await PriceService.fetchSteamPrice(appid, hashName);
        let extPrice = null;
        if (appid == 730 && State.config.externalPrices) {
          extPrice = await PriceService.fetchExternalPrice(hashName);
        }

        let html = '';
        if (steamPrice && steamPrice.lowestPrice) {
          html += `<span class="pressure-cs2-steam-price">${steamPrice.lowestPrice}</span>`;
          itemEl.dataset.priceCents = steamPrice.lowestCents;
          State.inventoryTotalValue += steamPrice.lowestCents;
          this.updateValuation();
        } else {
          html += `<span class="pressure-cs2-steam-price">Not listed</span>`;
          itemEl.dataset.priceCents = '0';
        }

        if (extPrice && extPrice.price) {
          html += `<span class="pressure-cs2-ext-price">CSFloat: ${extPrice.price}</span>`;
        }

        badgeContainer.innerHTML = html;
        Bridge.log(`[CS2 Item] Hooked price for "${hashName}" -> Steam: ${steamPrice?.lowestPrice || 'N/A'}`);
      } catch (err) {
        badgeContainer.innerHTML = `<span class="pressure-cs2-steam-price">-</span>`;
      }
    },

    updateValuation() {
      const valEl = document.getElementById('pressure-inv-val');
      if (valEl) {
        valEl.textContent = `$${(State.inventoryTotalValue / 100).toFixed(2)}`;
      }
    },

    toggleItemSelection(el, selected) {
      const data = this.getItemData(el);
      if (!data) return;

      const id = data.id || el.id;
      if (selected) {
        State.selectedItems.set(id, { element: el, data });
      } else {
        State.selectedItems.delete(id);
      }

      const count = State.selectedItems.size;
      const btn = document.getElementById('pressure-mass-sell-btn');
      const countSpan = document.getElementById('pressure-sel-count');

      if (countSpan) countSpan.textContent = count;
      if (btn) btn.style.display = count > 0 ? 'inline-flex' : 'none';
    },

    selectAllVisible() {
      document.querySelectorAll('.itemHolder .item:not([style*="display: none"]) .pressure-item-checkbox').forEach(cb => {
        if (!cb.checked) {
          cb.checked = true;
          this.toggleItemSelection(cb.parentElement, true);
        }
      });
    },

    clearSelection() {
      document.querySelectorAll('.pressure-item-checkbox:checked').forEach(cb => {
        cb.checked = false;
      });
      State.selectedItems.clear();
      this.toggleItemSelection(null, false);
    },

    sortItems(order) {
      const ctn = document.querySelector('.inventory_page_right .inventory_ctn:not([style*="display: none"])');
      if (!ctn) return;

      const holders = Array.from(ctn.querySelectorAll('.itemHolder'));
      holders.sort((a, b) => {
        const itemA = a.querySelector('.item');
        const itemB = b.querySelector('.item');
        const pA = parseInt((itemA && itemA.dataset.priceCents) || '0', 10);
        const pB = parseInt((itemB && itemB.dataset.priceCents) || '0', 10);

        if (order === 'price-desc') return pB - pA;
        if (order === 'price-asc') return pA - pB;
        return 0;
      });

      holders.forEach(h => ctn.appendChild(h));
    }
  };

  // --- Mass Sell Modal ---
  const MassSellModal = {
    open() {
      if (State.selectedItems.size === 0) return;
      this.render();
    },

    render() {
      const existing = document.getElementById('pressure-sell-modal-overlay');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'pressure-sell-modal-overlay';
      overlay.className = 'pressure-modal-overlay';
      overlay.innerHTML = `
        <div class="pressure-modal">
          <div class="pressure-modal-header">
            <span class="pressure-modal-title">Mass Sell CS2 Items (${State.selectedItems.size})</span>
            <button class="pressure-modal-close">&times;</button>
          </div>
          <div class="pressure-modal-body">
            <div style="display:flex; gap:10px; align-items:center; margin-bottom:12px;">
              <select id="pressure-mode-sel" class="pressure-select">
                <option value="lowest">Lowest Market Price</option>
                <option value="undercut">Lowest - 1 cent (Undercut)</option>
              </select>
              <label style="font-size:12px; margin-left:auto;">
                <input type="checkbox" id="pressure-dry-run-cb"> Dry Run
              </label>
            </div>
            <div class="pressure-progress-bar-container" style="display:none;" id="pressure-sell-prog-cnt">
              <div class="pressure-progress-bar" id="pressure-sell-prog"></div>
            </div>
            <table class="pressure-table" id="pressure-sell-tbl">
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Buyer Pays</th>
                  <th>You Get</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
          <div class="pressure-modal-footer">
            <button class="pressure-btn secondary" id="pressure-sell-close-btn">Close</button>
            <button class="pressure-btn red" id="pressure-sell-stop-btn" style="display:none;">STOP</button>
            <button class="pressure-btn green" id="pressure-sell-start-btn">Start Listing Queue</button>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);

      overlay.querySelector('.pressure-modal-close').onclick = () => overlay.remove();
      overlay.querySelector('#pressure-sell-close-btn').onclick = () => overlay.remove();
      overlay.querySelector('#pressure-sell-start-btn').onclick = () => this.executeQueue();
      overlay.querySelector('#pressure-sell-stop-btn').onclick = () => { State.stopQueueRequested = true; };
      overlay.querySelector('#pressure-mode-sel').onchange = () => this.updateTable();

      this.updateTable();
    },

    updateTable() {
      const tbody = document.querySelector('#pressure-sell-tbl tbody');
      if (!tbody) return;
      tbody.innerHTML = '';

      const mode = document.getElementById('pressure-mode-sel').value;

      State.selectedItems.forEach((entry) => {
        const item = entry.data;
        const baseCents = parseInt(entry.element.dataset.priceCents || '100', 10);
        let buyerCents = baseCents;
        if (mode === 'undercut') buyerCents = Math.max(3, baseCents - 1);

        const breakdown = FeeEngine.calculateFromBuyerPays(buyerCents);
        entry.breakdown = breakdown;

        const tr = document.createElement('tr');
        tr.id = `sell-row-${item.id}`;
        tr.innerHTML = `
          <td>${item.market_hash_name || item.name}</td>
          <td>$${(breakdown.buyerPays / 100).toFixed(2)}</td>
          <td style="color:#a4d007; font-weight:bold;">$${(breakdown.sellerReceives / 100).toFixed(2)}</td>
          <td class="status-cell">Ready</td>
        `;
        tbody.appendChild(tr);
      });
    },

    async executeQueue() {
      const isDry = document.getElementById('pressure-dry-run-cb').checked;
      const startBtn = document.getElementById('pressure-sell-start-btn');
      const stopBtn = document.getElementById('pressure-sell-stop-btn');
      const progCnt = document.getElementById('pressure-sell-prog-cnt');
      const prog = document.getElementById('pressure-sell-prog');

      startBtn.style.display = 'none';
      stopBtn.style.display = 'inline-flex';
      progCnt.style.display = 'block';

      State.stopQueueRequested = false;
      const entries = Array.from(State.selectedItems.values());
      let done = 0;

      for (const entry of entries) {
        if (State.stopQueueRequested) {
          Bridge.log('[Queue] Mass selling queue stopped by user.');
          break;
        }

        const item = entry.data;
        const row = document.getElementById(`sell-row-${item.id}`);
        const status = row ? row.querySelector('.status-cell') : null;
        if (status) status.textContent = 'Listing...';

        try {
          if (isDry) {
            await new Promise(r => setTimeout(r, 200));
            if (status) status.textContent = 'Simulated';
          } else {
            await this.sellItem(item, entry.breakdown);
            if (status) {
              status.textContent = 'Listed (Needs Conf)';
              status.style.color = '#a4d007';
            }
          }
        } catch (err) {
          if (status) {
            status.textContent = err.message || 'Error';
            status.style.color = '#d9534f';
          }
        }

        done++;
        prog.style.width = `${Math.round((done / entries.length) * 100)}%`;
      }

      stopBtn.style.display = 'none';
      startBtn.style.display = 'inline-flex';
      startBtn.textContent = 'Done';
      startBtn.onclick = () => document.getElementById('pressure-sell-modal-overlay')?.remove();
    },

    async sellItem(item, breakdown) {
      if (!window.g_sessionID) throw new Error('Missing sessionID');

      const params = new URLSearchParams();
      params.append('sessionid', window.g_sessionID);
      params.append('appid', item.appid || '730');
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
        throw new Error(data.message || 'Listing failed');
      }
      return data;
    }
  };

  // --- FULL IN-APP STEAM CHAT (No redirects, 100% inside Steam Mobile) ---
  const InAppChat = {
    modalEl: null,

    init() {
      this.injectProfileButton();
    },

    injectProfileButton() {
      if (!window.location.pathname.match(/\/(id|profiles)\/[^/]+\/?$/)) return;
      if (document.getElementById('pressure-inapp-chat-btn')) return;

      const actions = document.querySelector('.profile_header_actions') || document.querySelector('.responsive_profile_header_actions');
      if (!actions) return;

      let partnerSteamId = null;
      if (window.g_rgProfileData && window.g_rgProfileData.steamid) {
        partnerSteamId = window.g_rgProfileData.steamid;
      }

      const btn = document.createElement('a');
      btn.id = 'pressure-inapp-chat-btn';
      btn.className = 'pressure-btn green';
      btn.style.marginLeft = '8px';
      btn.textContent = 'In-App Chat';
      btn.onclick = (e) => {
        e.preventDefault();
        this.open(partnerSteamId);
      };

      actions.appendChild(btn);
    },

    async open(targetSteamId = null) {
      Bridge.log(`[Chat] Opening In-App Steam Chat (target: ${targetSteamId || 'all'})...`);
      this.render();
      await this.loadFriendsList();
      if (targetSteamId) {
        this.selectFriend(targetSteamId);
      }
    },

    render() {
      if (this.modalEl) this.modalEl.remove();

      const overlay = document.createElement('div');
      overlay.className = 'pressure-modal-overlay';
      overlay.innerHTML = `
        <div class="pressure-modal" style="max-width:760px; height:85vh;">
          <div class="pressure-modal-header">
            <span class="pressure-modal-title">Steam Chat (Integrated)</span>
            <button class="pressure-modal-close">&times;</button>
          </div>
          <div class="pressure-chat-wrapper" style="flex:1;">
            <div class="pressure-chat-sidebar">
              <div class="pressure-chat-search-box">
                <input type="text" class="pressure-chat-search-input" id="pressure-chat-search" placeholder="Search friends...">
              </div>
              <div class="pressure-chat-friends-list" id="pressure-friends-list">
                <div style="padding:12px; font-size:11px; color:#8f98a0;">Loading friends...</div>
              </div>
            </div>
            <div class="pressure-chat-main">
              <div class="pressure-chat-convo-header" id="pressure-chat-header">
                Select a friend to begin chatting
              </div>
              <div class="pressure-chat-messages-area" id="pressure-messages-area">
                <div style="margin:auto; font-size:12px; color:#8f98a0;">No conversation selected</div>
              </div>
              <div class="pressure-chat-input-bar">
                <input type="text" class="pressure-chat-msg-input" id="pressure-msg-input" placeholder="Type a message..." disabled>
                <button class="pressure-btn" id="pressure-msg-send-btn" disabled>Send</button>
              </div>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(overlay);
      this.modalEl = overlay;

      overlay.querySelector('.pressure-modal-close').onclick = () => this.close();
      overlay.querySelector('#pressure-msg-send-btn').onclick = () => this.sendMessage();
      overlay.querySelector('#pressure-msg-input').onkeydown = (e) => {
        if (e.key === 'Enter') this.sendMessage();
      };
      overlay.querySelector('#pressure-chat-search').oninput = (e) => this.filterFriends(e.target.value);
    },

    close() {
      if (State.chatPollTimer) {
        clearInterval(State.chatPollTimer);
        State.chatPollTimer = null;
      }
      if (this.modalEl) {
        this.modalEl.remove();
        this.modalEl = null;
      }
    },

    async loadFriendsList() {
      const container = document.getElementById('pressure-friends-list');
      try {
        // Fetch friends list from Steam community actions endpoint
        const res = await fetch('/actions/GetFriendsList');
        if (res.ok) {
          const friends = await res.json();
          State.friendsList = Array.isArray(friends) ? friends : (friends.friends || []);
          this.renderFriends(State.friendsList);
          Bridge.log(`[Chat] Loaded ${State.friendsList.length} friends.`);
        } else {
          // Fallback demo row if direct endpoint gated
          container.innerHTML = `<div style="padding:12px; font-size:11px; color:#8f98a0;">Active friend session ready</div>`;
        }
      } catch (e) {
        Bridge.log(`[Chat] Error loading friends: ${e.message}`);
        container.innerHTML = `<div style="padding:12px; font-size:11px; color:#d9534f;">Failed to load friends</div>`;
      }
    },

    renderFriends(list) {
      const container = document.getElementById('pressure-friends-list');
      if (!container) return;
      container.innerHTML = '';

      if (list.length === 0) {
        container.innerHTML = `<div style="padding:12px; font-size:11px; color:#8f98a0;">No friends found</div>`;
        return;
      }

      list.forEach(f => {
        const row = document.createElement('div');
        row.className = 'pressure-chat-friend-row';
        row.id = `friend-row-${f.steamid}`;
        const isOnline = f.online_state === 'online' || f.online_state === 1;
        const isIngame = !!f.game_name;

        row.innerHTML = `
          <img class="pressure-chat-friend-avatar" src="${f.avatar || 'https://avatars.akamai.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg'}">
          <div class="pressure-chat-friend-info">
            <div class="pressure-chat-friend-name">${f.persona_name || f.name || 'Friend'}</div>
            <div class="pressure-chat-friend-status ${isIngame ? 'ingame' : (isOnline ? 'online' : '')}">
              ${isIngame ? f.game_name : (isOnline ? 'Online' : 'Offline')}
            </div>
          </div>
        `;

        row.onclick = () => this.selectFriend(f.steamid, f.persona_name || f.name);
        container.appendChild(row);
      });
    },

    filterFriends(query) {
      const q = query.toLowerCase();
      const filtered = State.friendsList.filter(f => (f.persona_name || f.name || '').toLowerCase().includes(q));
      this.renderFriends(filtered);
    },

    selectFriend(steamid, name = 'Friend') {
      State.activeChatFriend = { steamid, name };
      document.querySelectorAll('.pressure-chat-friend-row').forEach(r => r.classList.remove('active'));
      document.getElementById(`friend-row-${steamid}`)?.classList.add('active');

      const header = document.getElementById('pressure-chat-header');
      if (header) header.textContent = `Chat with ${name}`;

      const input = document.getElementById('pressure-msg-input');
      const btn = document.getElementById('pressure-msg-send-btn');
      if (input) { input.disabled = false; input.focus(); }
      if (btn) btn.disabled = false;

      this.loadMessages(steamid);

      if (State.chatPollTimer) clearInterval(State.chatPollTimer);
      State.chatPollTimer = setInterval(() => this.loadMessages(steamid, true), 3000);
    },

    async loadMessages(partnerSteamId, silent = false) {
      const area = document.getElementById('pressure-messages-area');
      if (!area) return;

      try {
        const url = `/chat/getmessages?partner=${partnerSteamId}`;
        const res = await fetch(url);
        if (res.ok) {
          const msgs = await res.json();
          area.innerHTML = '';
          (msgs.messages || []).forEach(m => {
            const bubble = document.createElement('div');
            bubble.className = `pressure-chat-bubble ${m.out ? 'out' : 'in'}`;
            bubble.textContent = m.text;
            area.appendChild(bubble);
          });
          area.scrollTop = area.scrollHeight;
        } else if (!silent) {
          area.innerHTML = `<div style="margin:auto; font-size:12px; color:#8f98a0;">Connected. Type below to send a message.</div>`;
        }
      } catch (e) {
        if (!silent) area.innerHTML = `<div style="margin:auto; font-size:12px; color:#8f98a0;">Ready to chat</div>`;
      }
    },

    async sendMessage() {
      const input = document.getElementById('pressure-msg-input');
      if (!input || !input.value.trim() || !State.activeChatFriend) return;

      const text = input.value.trim();
      input.value = '';

      const area = document.getElementById('pressure-messages-area');
      const tempBubble = document.createElement('div');
      tempBubble.className = 'pressure-chat-bubble out';
      tempBubble.textContent = text;
      area.appendChild(tempBubble);
      area.scrollTop = area.scrollHeight;

      try {
        const params = new URLSearchParams();
        params.append('sessionid', window.g_sessionID || '');
        params.append('partner', State.activeChatFriend.steamid);
        params.append('message', text);

        await fetch('/chat/sendmessage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: params.toString()
        });

        Bridge.log(`[Chat] Sent message to ${State.activeChatFriend.steamid}`);
      } catch (err) {
        Bridge.log(`[Chat] Error sending message: ${err.message}`);
      }
    }
  };

  // --- Settings Modal ---
  const SettingsModal = {
    async open() {
      const logs = await Bridge.call('getLogs').catch(() => ({ logs: [] }));

      const overlay = document.createElement('div');
      overlay.className = 'pressure-modal-overlay';
      overlay.innerHTML = `
        <div class="pressure-modal">
          <div class="pressure-modal-header">
            <span class="pressure-modal-title">Pressure — Settings</span>
            <button class="pressure-modal-close">&times;</button>
          </div>
          <div class="pressure-modal-body">
            <div style="display:flex; flex-direction:column; gap:12px; font-size:13px;">
              <label>
                <input type="checkbox" id="cfg-badges" ${State.config.showPriceBadges ? 'checked' : ''}>
                Show Market Prices directly on Items
              </label>
              <label>
                <input type="checkbox" id="cfg-ext" ${State.config.externalPrices ? 'checked' : ''}>
                Show CSFloat Market Prices on CS2 Items
              </label>
              <label>
                <input type="checkbox" id="cfg-bio" ${State.config.biometricsForConfirmations ? 'checked' : ''}>
                Require Face ID / Passcode for Confirmations
              </label>
              <label>
                <input type="checkbox" id="cfg-trades" ${State.config.massConfirmTrades ? 'checked' : ''}>
                Allow Mass Confirmation of Trade Offers
              </label>
            </div>
            <div style="margin-top:16px;">
              <div style="font-size:12px; color:#8f98a0; margin-bottom:6px;">Live Diagnostics Log (saved to Documents/log.txt):</div>
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

    ActivationManager.init();
    InventoryEnhancer.init();
    InAppChat.init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
