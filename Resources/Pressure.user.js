// Pressure - Steam Mobile Power-User Suite
// Execution scope: WKWebView on steamcommunity.com and store.steampowered.com

(function () {
  'use strict';

  if (window.__pressure_initialized) return;
  window.__pressure_initialized = true;

  // ==========================================================================
  // 1. NATIVE BRIDGE INTERFACE
  // ==========================================================================

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

  // ==========================================================================
  // 2. STATE & CONFIGURATION
  // ==========================================================================

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
      requestDelayMs: 250,
      priceCacheTtlSeconds: 3600
    },
    selectedItems: new Map(),
    inventoryTotalValue: 0,
    pricedItemCount: 0,
    isSelectionMode: false,
    inventoryDataMap: new Map(), // assetid -> itemData
    activeChatFriend: null,
    friendsList: [],
    chatPollTimer: null,
    selfPersonaState: 1, // 1 = Online, 3 = Away, 7 = Invisible, 0 = Offline
    selfPersonaName: 'You',
    isProcessingQueue: false,
    stopQueueRequested: false
  };

  // ==========================================================================
  // 3. NETWORK QUEUE WITH BACKOFF
  // ==========================================================================

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
          Bridge.log(`[Network] Backoff HTTP ${status}: retrying in ${Math.round(backoff)}ms (attempt ${item.retries})`);
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

  // ==========================================================================
  // 4. CACHE ENGINE
  // ==========================================================================

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

  // ==========================================================================
  // 5. STEAM MARKET FEE CALCULATOR
  // ==========================================================================

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

  // ==========================================================================
  // 6. PRICE SERVICE (CS2 Steam Market & CSFloat)
  // ==========================================================================

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
          return parsed;
        }
      } catch (err) {
        Bridge.log(`[PriceService] Steam price error for ${marketHashName}: ${err.message || err}`);
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

  // ==========================================================================
  // 7. ACTIVATION MANAGER (Long-press on "View Profile" or "MENU")
  // ==========================================================================

  const ActivationManager = {
    touchTimer: null,
    startX: 0,
    startY: 0,
    activeTargetName: null,

    init() {
      Bridge.log('[Activation] Registering long-press triggers for View Profile and MENU...');
      window.addEventListener('touchstart', (e) => this.handleTouchStart(e), { capture: true, passive: true });
      window.addEventListener('touchmove', (e) => this.handleTouchMove(e), { capture: true, passive: true });
      window.addEventListener('touchend', (e) => this.handleTouchEnd(e), { capture: true, passive: true });
      window.addEventListener('touchcancel', (e) => this.handleTouchEnd(e), { capture: true, passive: true });
    },

    findTarget(el) {
      let cur = el;
      let depth = 0;
      while (cur && cur !== document.body && cur !== document.documentElement && depth < 6) {
        const text = (cur.textContent || '').trim().toLowerCase();
        const id = (cur.id || '').toLowerCase();
        const cls = (typeof cur.className === 'string' ? cur.className : '').toLowerCase();
        const href = (cur.getAttribute && cur.getAttribute('href') || '').toLowerCase();

        // 1. "View Profile" / "Просмотреть профиль" (in user avatar dropdown)
        if (text === 'view profile' || text === 'просмотреть профиль' || text === 'открыть профиль' ||
            text.includes('view profile') || text.includes('просмотреть профиль') ||
            id.includes('view_profile') || cls.includes('view_profile') ||
            (cur.closest && (cur.closest('#account_pulldown_menu') || cur.closest('#account_dropdown') || cur.closest('.popup_menu_item')) && (href.includes('/id/') || href.includes('/profiles/')))) {
          return 'View Profile';
        }

        // 2. "MENU" / "МЕНЮ"
        if (text === 'menu' || text === 'меню' || id.includes('menu') || cls.includes('menu') ||
            id === 'responsive_menu_logo' || cls.includes('responsive_menu_toggle') ||
            cls.includes('nav_toggle') || id.includes('nav_toggle')) {
          return 'MENU';
        }

        cur = cur.parentElement;
        depth++;
      }
      return null;
    },

    handleTouchStart(e) {
      if (!e.touches || e.touches.length !== 1) return;
      const touch = e.touches[0];
      this.startX = touch.clientX;
      this.startY = touch.clientY;

      const targetName = this.findTarget(e.target);
      if (targetName) {
        this.activeTargetName = targetName;
        if (this.touchTimer) clearTimeout(this.touchTimer);
        this.touchTimer = setTimeout(() => {
          Bridge.log(`[Activation] Long-press detected on "${this.activeTargetName}". Opening Pressure Settings...`);
          SettingsModal.open();
          Bridge.call('openSettingsModal').catch(() => {});
          this.touchTimer = null;
          this.activeTargetName = null;
        }, 550);
      }
    },

    handleTouchMove(e) {
      if (!this.touchTimer || !e.touches || e.touches.length === 0) return;
      const touch = e.touches[0];
      const dx = touch.clientX - this.startX;
      const dy = touch.clientY - this.startY;
      // Allow slight finger tremor (up to 15px) before cancelling
      if (Math.hypot(dx, dy) > 15) {
        clearTimeout(this.touchTimer);
        this.touchTimer = null;
        this.activeTargetName = null;
      }
    },

    handleTouchEnd(e) {
      if (this.touchTimer) {
        clearTimeout(this.touchTimer);
        this.touchTimer = null;
        this.activeTargetName = null;
      }
    }
  };

  // ==========================================================================
  // 8. CS2 INVENTORY ENHANCER & VALUATION
  // ==========================================================================

  const InventoryEnhancer = {
    initialized: false,
    inventoryLoaded: false,

    init() {
      if (!window.location.pathname.includes('/inventory')) return;
      if (this.initialized) return;
      this.initialized = true;

      Bridge.log('[Inventory] Initializing CS2 Inventory Enhancer...');
      this.injectToolbar();
      this.fetchInventoryData();
      this.scanAndHookItems();

      // Monitor dynamic item loading (AJAX page changes, tab changes)
      const targetCtn = document.getElementById('inventories') || document.body;
      const observer = new MutationObserver(() => this.scanAndHookItems());
      observer.observe(targetCtn, { childList: true, subtree: true });
    },

    injectToolbar() {
      if (document.getElementById('pressure-inv-toolbar')) return;

      const anchor = document.querySelector('.inventory_page_left') ||
                     document.getElementById('inventories') ||
                     document.querySelector('.responsive_inventory_page') ||
                     document.body;

      const toolbar = document.createElement('div');
      toolbar.id = 'pressure-inv-toolbar';
      toolbar.className = 'pressure-inventory-toolbar';
      toolbar.innerHTML = `
        <div class="pressure-toolbar-primary-row">
          <div class="pressure-valuation-container">
            <span>CS2 Value:</span>
            <span id="pressure-inv-val" class="pressure-valuation-badge">$0.00</span>
          </div>
          <div class="pressure-toolbar-actions">
            <button id="pressure-recalc-btn" class="pressure-toolbar-btn secondary">Recalculate</button>
            <button id="pressure-toggle-select-btn" class="pressure-toolbar-btn blue">Select</button>
          </div>
        </div>
        <div class="pressure-toolbar-selection-row" id="pressure-sel-row">
          <button id="pressure-select-all-btn" class="pressure-toolbar-btn secondary">Select All</button>
          <button id="pressure-clear-sel-btn" class="pressure-toolbar-btn secondary">Clear</button>
          <select id="pressure-sort-select" class="pressure-toolbar-select">
            <option value="default">Sort: Default</option>
            <option value="price-desc">Price: High → Low</option>
            <option value="price-asc">Price: Low → High</option>
            <option value="name">Name: A-Z</option>
          </select>
          <button id="pressure-mass-sell-btn" class="pressure-toolbar-btn green" style="display:none;">
            Sell (<span id="pressure-sel-count">0</span>)
          </button>
        </div>
      `;

      anchor.parentNode.insertBefore(toolbar, anchor);

      document.getElementById('pressure-toggle-select-btn').onclick = () => this.toggleSelectionMode();
      document.getElementById('pressure-select-all-btn').onclick = () => this.selectAllVisible();
      document.getElementById('pressure-clear-sel-btn').onclick = () => this.clearSelection();
      document.getElementById('pressure-recalc-btn').onclick = () => this.recalculateAll();
      document.getElementById('pressure-mass-sell-btn').onclick = () => MassSellModal.open();
      document.getElementById('pressure-sort-select').onchange = (e) => this.sortItems(e.target.value);
    },

    toggleSelectionMode() {
      State.isSelectionMode = !State.isSelectionMode;
      const toolbar = document.getElementById('pressure-inv-toolbar');
      const invRoot = document.getElementById('inventories') || document.body;
      const toggleBtn = document.getElementById('pressure-toggle-select-btn');

      if (State.isSelectionMode) {
        toolbar?.classList.add('pressure-selection-active');
        invRoot?.classList.add('pressure-selection-active');
        if (toggleBtn) {
          toggleBtn.textContent = 'Done';
          toggleBtn.className = 'pressure-toolbar-btn secondary';
        }
      } else {
        toolbar?.classList.remove('pressure-selection-active');
        invRoot?.classList.remove('pressure-selection-active');
        if (toggleBtn) {
          toggleBtn.textContent = 'Select';
          toggleBtn.className = 'pressure-toolbar-btn blue';
        }
        this.clearSelection();
      }
    },

    async fetchInventoryData() {
      try {
        let steamid = null;
        if (window.g_rgProfileData && window.g_rgProfileData.steamid) {
          steamid = window.g_rgProfileData.steamid;
        } else {
          const match = window.location.pathname.match(/\/(?:profiles|id)\/([^/]+)/);
          if (match) steamid = match[1];
        }

        if (!steamid) return;

        const url = `/inventory/${steamid}/730/2?l=english&count=2000`;
        const res = await fetch(url, { credentials: 'same-origin' });
        if (res.ok) {
          const data = await res.json();
          if (data && data.assets && data.descriptions) {
            const descMap = new Map();
            data.descriptions.forEach(d => {
              const key = `${d.classid}_${d.instanceid || '0'}`;
              descMap.set(key, d);
            });

            data.assets.forEach(a => {
              const key = `${a.classid}_${a.instanceid || '0'}`;
              const desc = descMap.get(key);
              if (desc) {
                State.inventoryDataMap.set(a.assetid, {
                  id: a.assetid,
                  assetid: a.assetid,
                  classid: a.classid,
                  appid: 730,
                  contextid: '2',
                  market_hash_name: desc.market_hash_name || desc.name,
                  name: desc.name,
                  icon_url: desc.icon_url,
                  marketable: desc.marketable
                });
              }
            });
            this.inventoryLoaded = true;
            Bridge.log(`[Inventory] Pre-fetched ${State.inventoryDataMap.size} CS2 items metadata.`);
            this.scanAndHookItems();
          }
        }
      } catch (err) {
        Bridge.log(`[Inventory] Metadata pre-fetch note: ${err.message}`);
      }
    },

    getItemData(el) {
      if (el.rgItem) return el.rgItem;

      // Extract assetid from element id or href
      let assetid = null;
      const idMatch = (el.id || '').match(/item(?:730_2_|_730_2_)?(\d+)/);
      if (idMatch) assetid = idMatch[1];

      const href = el.getAttribute('href') || '';
      const hrefMatch = href.match(/#730_2_(\d+)/);
      if (hrefMatch) assetid = hrefMatch[1];

      if (assetid && State.inventoryDataMap.has(assetid)) {
        return State.inventoryDataMap.get(assetid);
      }

      if (assetid && window.g_ActiveInventory && window.g_ActiveInventory.m_rgItemData) {
        const item = window.g_ActiveInventory.m_rgItemData[assetid];
        if (item) return item;
      }

      // Fallback: extract name from child image alt attribute or title
      const img = el.querySelector('img');
      const altName = (img && img.getAttribute('alt')) || el.getAttribute('title') || (img && img.getAttribute('title'));
      if (altName && altName.trim().length > 0) {
        return {
          id: assetid || ('dyn_' + Math.random().toString(36).substring(2, 8)),
          appid: 730,
          contextid: '2',
          market_hash_name: altName.trim(),
          name: altName.trim()
        };
      }

      return null;
    },

    scanAndHookItems() {
      const items = document.querySelectorAll('.itemHolder .item, .inventory_page .item, .inventory_item_link, .item[id^="item"]');
      items.forEach(el => this.decorateItem(el));
    },

    decorateItem(itemEl) {
      if (itemEl.dataset.pressureHooked) return;
      itemEl.dataset.pressureHooked = '1';

      // Ensure relative positioning for child badges
      itemEl.style.position = 'relative';

      // Checkbox for selection mode
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'pressure-item-checkbox';
      cb.onclick = (e) => {
        e.stopPropagation();
        this.toggleItemSelection(itemEl, cb.checked);
      };
      itemEl.appendChild(cb);

      // Immediately queue price loading
      this.loadItemPrice(itemEl);
    },

    async loadItemPrice(itemEl) {
      const itemData = this.getItemData(itemEl);
      if (!itemData || !itemData.market_hash_name) return;

      const appid = itemData.appid || 730;
      const hashName = itemData.market_hash_name;

      let badgeContainer = itemEl.querySelector('.pressure-cs2-price-container');
      if (!badgeContainer) {
        badgeContainer = document.createElement('div');
        badgeContainer.className = 'pressure-cs2-price-container';
        badgeContainer.innerHTML = `<span class="pressure-cs2-steam-price">...</span>`;
        itemEl.appendChild(badgeContainer);
      }

      try {
        const steamPrice = await PriceService.fetchSteamPrice(appid, hashName);
        let extPrice = null;
        if (appid == 730 && State.config.externalPrices) {
          extPrice = await PriceService.fetchExternalPrice(hashName);
        }

        let html = '';
        if (steamPrice && steamPrice.lowestPrice) {
          html += `<span class="pressure-cs2-steam-price">${steamPrice.lowestPrice}</span>`;
          const cents = steamPrice.lowestCents || 0;
          if (!itemEl.dataset.countedInValuation) {
            itemEl.dataset.countedInValuation = '1';
            itemEl.dataset.priceCents = cents;
            State.inventoryTotalValue += cents;
            State.pricedItemCount++;
            this.updateValuation();
          }
        } else {
          html += `<span class="pressure-cs2-steam-price">Not listed</span>`;
          itemEl.dataset.priceCents = '0';
        }

        if (extPrice && extPrice.price) {
          html += `<span class="pressure-cs2-ext-price">CSFloat: ${extPrice.price}</span>`;
        }

        badgeContainer.innerHTML = html;
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

    recalculateAll() {
      State.inventoryTotalValue = 0;
      State.pricedItemCount = 0;
      document.querySelectorAll('.itemHolder .item, .inventory_page .item').forEach(el => {
        delete el.dataset.countedInValuation;
        delete el.dataset.pressureHooked;
        this.loadItemPrice(el);
      });
      this.updateValuation();
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
      document.querySelectorAll('.itemHolder .item:not([style*="display: none"]) .pressure-item-checkbox, .inventory_page .item .pressure-item-checkbox').forEach(cb => {
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
      const btn = document.getElementById('pressure-mass-sell-btn');
      const countSpan = document.getElementById('pressure-sel-count');
      if (countSpan) countSpan.textContent = '0';
      if (btn) btn.style.display = 'none';
    },

    sortItems(order) {
      const ctn = document.querySelector('.inventory_page_right .inventory_ctn:not([style*="display: none"])') ||
                  document.querySelector('.inventory_ctn') ||
                  document.getElementById('inventories');
      if (!ctn) return;

      const holders = Array.from(ctn.querySelectorAll('.itemHolder'));
      holders.sort((a, b) => {
        const itemA = a.querySelector('.item') || a;
        const itemB = b.querySelector('.item') || b;
        const pA = parseInt((itemA && itemA.dataset.priceCents) || '0', 10);
        const pB = parseInt((itemB && itemB.dataset.priceCents) || '0', 10);

        if (order === 'price-desc') return pB - pA;
        if (order === 'price-asc') return pA - pB;
        return 0;
      });

      holders.forEach(h => ctn.appendChild(h));
    }
  };

  // ==========================================================================
  // 9. MASS SELL MODAL
  // ==========================================================================

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
              <select id="pressure-mode-sel" class="pressure-toolbar-select">
                <option value="lowest">Lowest Market Price</option>
                <option value="undercut">Lowest - 1 cent (Undercut)</option>
              </select>
              <label style="font-size:12px; margin-left:auto; display:flex; align-items:center; gap:6px;">
                <input type="checkbox" id="pressure-dry-run-cb"> Dry Run (Simulate)
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
                  <th>You Receive</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody></tbody>
            </table>
          </div>
          <div class="pressure-modal-footer">
            <button class="pressure-toolbar-btn secondary" id="pressure-sell-close-btn">Close</button>
            <button class="pressure-toolbar-btn red" id="pressure-sell-stop-btn" style="display:none;">STOP</button>
            <button class="pressure-toolbar-btn green" id="pressure-sell-start-btn">List on Market</button>
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

  // ==========================================================================
  // 10. FULL IN-APP STEAM CHAT TAB (Replaces redirects with full gray/blue tab)
  // ==========================================================================

  const PressureChatTab = {
    tabEl: null,
    currentFilter: 'all',

    init() {
      this.hookProfileMessageButtons();
      this.hookGlobalChatTriggers();
    },

    hookProfileMessageButtons() {
      // Intercept clicks on the REAL Steam "Message" / "Send Message" / "Отправить сообщение" button
      window.addEventListener('click', (e) => {
        let cur = e.target;
        let isMessageBtn = false;
        let partnerSteamId = null;
        let partnerName = null;

        while (cur && cur !== document.body && cur !== document.documentElement) {
          const text = (cur.textContent || '').trim().toLowerCase();
          const href = (cur.getAttribute && cur.getAttribute('href') || '').toLowerCase();
          const onclick = (cur.getAttribute && cur.getAttribute('onclick') || '').toLowerCase();

          if (text === 'message' || text === 'send message' || text === 'сообщение' || text === 'отправить сообщение' ||
              text.includes('message') || text.includes('сообщение') ||
              href.includes('/chat') || href.includes('steam://friends/message') || href.includes('steamchatmobile:') ||
              onclick.includes('openfriendchat') || onclick.includes('chat')) {
            isMessageBtn = true;

            const idMatch = (href + ' ' + onclick).match(/(?:7656119\d{10})/);
            if (idMatch) partnerSteamId = idMatch[0];
            break;
          }
          cur = cur.parentElement;
        }

        if (isMessageBtn) {
          e.preventDefault();
          e.stopPropagation();

          if (!partnerSteamId && window.g_rgProfileData && window.g_rgProfileData.steamid) {
            partnerSteamId = window.g_rgProfileData.steamid;
          }
          if (!partnerSteamId) {
            const pathMatch = window.location.pathname.match(/\/(?:profiles)\/(\d+)/);
            if (pathMatch) partnerSteamId = pathMatch[1];
          }

          const personaEl = document.querySelector('.actual_persona_name') ||
                            document.querySelector('.profile_header_content .persona_name');
          if (personaEl) partnerName = personaEl.textContent.trim();

          Bridge.log(`[Chat] Intercepted Profile Message click for partner ${partnerSteamId || 'unknown'}`);
          this.open(partnerSteamId, partnerName);
        }
      }, true);

      // Override Steam's default OpenFriendChat window function
      window.OpenFriendChat = (steamid) => {
        this.open(steamid);
      };

      // Expose global open trigger for native hook
      window.__pressureOpenChatTab = () => {
        this.open();
      };
    },

    hookGlobalChatTriggers() {
      // Intercept clicks on any navigation links pointing to Steam Chat
      window.addEventListener('click', (e) => {
        const link = e.target.closest && e.target.closest('a[href*="/chat"], a[href*="steamchatmobile"]');
        if (link) {
          e.preventDefault();
          e.stopPropagation();
          this.open();
        }
      }, true);
    },

    async open(targetSteamId = null, targetName = null) {
      Bridge.log(`[Chat] Opening Pressure Chat Tab (target: ${targetSteamId || 'none'})...`);
      this.render();

      if (targetSteamId) {
        State.activeChatFriend = {
          steamid: targetSteamId,
          name: targetName || 'Friend',
          avatar: 'https://avatars.akamai.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg',
          state: 'online',
          statusText: 'Online'
        };
        this.openConversation(State.activeChatFriend);
      }

      await this.loadFriendsList();
    },

    render() {
      if (this.tabEl) this.tabEl.remove();

      const container = document.createElement('div');
      container.id = 'pressure-chat-tab';
      container.className = 'pressure-chat-tab-container';
      container.innerHTML = `
        <div class="pressure-chat-topbar">
          <div class="pressure-chat-title-group">
            <button class="pressure-chat-close-btn" id="pressure-chat-close">&times;</button>
            <span class="pressure-chat-title">Steam Chat</span>
          </div>
          <div class="pressure-chat-persona-controls">
            <div class="pressure-chat-self-status" id="pressure-persona-status-pill">
              <span class="pressure-chat-status-dot online" id="pressure-self-dot"></span>
              <span class="pressure-chat-status-name" id="pressure-self-status-txt">Online</span>
              <span style="font-size:10px; color:#8f98a0;">▼</span>
            </div>
            <div class="pressure-status-dropdown" id="pressure-status-menu">
              <div class="pressure-status-option" data-state="1">
                <span class="pressure-chat-status-dot online"></span>
                <span>Online</span>
              </div>
              <div class="pressure-status-option" data-state="3">
                <span class="pressure-chat-status-dot away"></span>
                <span>Away (Отошел)</span>
              </div>
              <div class="pressure-status-option" data-state="7">
                <span class="pressure-chat-status-dot invisible"></span>
                <span>Invisible (Невидимка)</span>
              </div>
              <div class="pressure-status-option" data-state="0">
                <span class="pressure-chat-status-dot offline"></span>
                <span>Offline</span>
              </div>
            </div>
          </div>
        </div>
        <div class="pressure-chat-body">
          <div class="pressure-chat-list-panel">
            <div class="pressure-chat-filter-bar">
              <input type="text" class="pressure-chat-search-input" id="pressure-chat-search" placeholder="Search friends...">
              <div class="pressure-chat-tabs-row">
                <button class="pressure-chat-tab-pill active" data-filter="all">All</button>
                <button class="pressure-chat-tab-pill" data-filter="online">Online</button>
                <button class="pressure-chat-tab-pill" data-filter="ingame">In-Game</button>
              </div>
            </div>
            <div class="pressure-chat-friends-scroll" id="pressure-friends-list">
              <div style="padding:16px; font-size:12px; color:#8f98a0; text-align:center;">Loading friends...</div>
            </div>
          </div>
          <div class="pressure-chat-convo-panel" id="pressure-convo-panel">
            <div class="pressure-convo-header" id="pressure-convo-header">
              <button class="pressure-convo-back-btn" id="pressure-convo-back">←</button>
              <div class="pressure-convo-header-info">
                <div class="pressure-convo-header-name" id="pressure-active-friend-name">Select a friend to begin chatting</div>
                <div class="pressure-convo-header-status" id="pressure-active-friend-status"></div>
              </div>
            </div>
            <div class="pressure-chat-messages-area" id="pressure-messages-area">
              <div style="margin:auto; font-size:13px; color:#8f98a0; text-align:center;">No conversation selected</div>
            </div>
            <div class="pressure-chat-input-bar">
              <input type="text" class="pressure-chat-msg-input" id="pressure-msg-input" placeholder="Type a message..." disabled>
              <button class="pressure-chat-send-btn" id="pressure-msg-send-btn" disabled>Send</button>
            </div>
          </div>
        </div>
      `;

      document.body.appendChild(container);
      this.tabEl = container;

      // Close button
      container.querySelector('#pressure-chat-close').onclick = () => this.close();

      // Back button on mobile
      container.querySelector('#pressure-convo-back').onclick = () => {
        container.classList.remove('in-convo');
      };

      // Persona status dropdown toggle
      const pill = container.querySelector('#pressure-persona-status-pill');
      const menu = container.querySelector('#pressure-status-menu');
      pill.onclick = (e) => {
        e.stopPropagation();
        menu.classList.toggle('show');
      };

      window.addEventListener('click', () => menu.classList.remove('show'));

      // Status change click
      menu.querySelectorAll('.pressure-status-option').forEach(opt => {
        opt.onclick = () => {
          const state = parseInt(opt.dataset.state, 10);
          this.changePersonaState(state);
        };
      });

      // Filter tabs
      container.querySelectorAll('.pressure-chat-tab-pill').forEach(btn => {
        btn.onclick = () => {
          container.querySelectorAll('.pressure-chat-tab-pill').forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          this.currentFilter = btn.dataset.filter;
          this.filterFriends(container.querySelector('#pressure-chat-search').value);
        };
      });

      // Search input
      container.querySelector('#pressure-chat-search').oninput = (e) => {
        this.filterFriends(e.target.value);
      };

      // Message input
      container.querySelector('#pressure-msg-send-btn').onclick = () => this.sendMessage();
      container.querySelector('#pressure-msg-input').onkeydown = (e) => {
        if (e.key === 'Enter') this.sendMessage();
      };
    },

    close() {
      if (State.chatPollTimer) {
        clearInterval(State.chatPollTimer);
        State.chatPollTimer = null;
      }
      if (this.tabEl) {
        this.tabEl.remove();
        this.tabEl = null;
      }
    },

    async changePersonaState(state) {
      State.selfPersonaState = state;
      const dot = document.getElementById('pressure-self-dot');
      const txt = document.getElementById('pressure-self-status-txt');

      let stateClass = 'online';
      let stateName = 'Online';

      if (state === 1) { stateClass = 'online'; stateName = 'Online'; }
      else if (state === 3) { stateClass = 'away'; stateName = 'Away'; }
      else if (state === 7) { stateClass = 'invisible'; stateName = 'Invisible'; }
      else if (state === 0) { stateClass = 'offline'; stateName = 'Offline'; }

      if (dot) {
        dot.className = `pressure-chat-status-dot ${stateClass}`;
      }
      if (txt) {
        txt.textContent = stateName;
      }

      Bridge.log(`[Chat] Changed Persona Status to: ${stateName} (${state})`);

      try {
        const body = new URLSearchParams();
        body.append('sessionid', window.g_sessionID || '');
        body.append('state', state);

        fetch('/actions/SetPersonaStatus', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: body.toString()
        }).catch(() => {});

        fetch('/chat/setpersonastate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
          body: body.toString()
        }).catch(() => {});
      } catch (e) {}
    },

    async loadFriendsList() {
      const container = document.getElementById('pressure-friends-list');
      if (!container) return;

      try {
        const res = await fetch('/my/friends/', { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const html = await res.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const parsedFriends = [];

        doc.querySelectorAll('.friendBlock').forEach(el => {
          const steamid = el.dataset.steamid || el.getAttribute('data-steamid') || '';
          let name = '';
          let statusText = 'Offline';
          let state = 'offline';

          const smallText = el.querySelector('.friendSmallText');
          if (smallText) statusText = smallText.textContent.trim();

          if (el.classList.contains('in-game') || el.classList.contains('ingame')) {
            state = 'ingame';
          } else if (el.classList.contains('online')) {
            state = 'online';
            if (!statusText || statusText.length === 0) statusText = 'Online';
          } else {
            state = 'offline';
          }

          const nameEl = el.querySelector('.friendBlockContent');
          if (nameEl) {
            const clone = nameEl.cloneNode(true);
            const sm = clone.querySelector('.friendSmallText');
            if (sm) sm.remove();
            name = clone.textContent.trim();
          }

          const link = el.querySelector('a.selectable_overlay') || el.querySelector('a');
          if (!name && link) name = link.textContent.trim();

          const img = el.querySelector('img');
          const avatar = img ? img.src : 'https://avatars.akamai.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg';

          let resolvedId = steamid;
          if (!resolvedId && link && link.href) {
            const m = link.href.match(/\/(?:id|profiles)\/([^/]+)/);
            if (m) resolvedId = m[1];
          }

          if (resolvedId) {
            parsedFriends.push({
              steamid: resolvedId,
              name: name || 'Friend',
              avatar,
              state,
              statusText: statusText || (state === 'online' ? 'Online' : 'Offline')
            });
          }
        });

        // Ensure active partner is included
        if (State.activeChatFriend && !parsedFriends.some(f => f.steamid === State.activeChatFriend.steamid)) {
          parsedFriends.unshift(State.activeChatFriend);
        }

        State.friendsList = parsedFriends;
        Bridge.log(`[Chat] Successfully loaded ${State.friendsList.length} friends from /my/friends/`);
        this.filterFriends(document.getElementById('pressure-chat-search')?.value || '');
      } catch (err) {
        Bridge.log(`[Chat] Failed to load friends via DOM: ${err.message}`);
        if (State.activeChatFriend) {
          State.friendsList = [State.activeChatFriend];
          this.renderFriendsList(State.friendsList);
        } else {
          container.innerHTML = `<div style="padding:16px; font-size:12px; color:#8f98a0; text-align:center;">No friends found</div>`;
        }
      }
    },

    filterFriends(searchQuery = '') {
      const q = searchQuery.toLowerCase().trim();
      let list = State.friendsList;

      if (this.currentFilter === 'online') {
        list = list.filter(f => f.state === 'online' || f.state === 'ingame');
      } else if (this.currentFilter === 'ingame') {
        list = list.filter(f => f.state === 'ingame');
      }

      if (q.length > 0) {
        list = list.filter(f => f.name.toLowerCase().includes(q) || (f.statusText && f.statusText.toLowerCase().includes(q)));
      }

      this.renderFriendsList(list);
    },

    renderFriendsList(friends) {
      const container = document.getElementById('pressure-friends-list');
      if (!container) return;
      container.innerHTML = '';

      if (friends.length === 0) {
        container.innerHTML = `<div style="padding:16px; font-size:12px; color:#8f98a0; text-align:center;">No matching friends</div>`;
        return;
      }

      friends.forEach(f => {
        const item = document.createElement('div');
        item.className = 'pressure-friend-item';
        item.id = `friend-item-${f.steamid}`;
        if (State.activeChatFriend && State.activeChatFriend.steamid === f.steamid) {
          item.classList.add('active');
        }

        item.innerHTML = `
          <div class="pressure-friend-avatar-wrap ${f.state}">
            <img class="pressure-friend-avatar-img" src="${f.avatar}" onerror="this.src='https://avatars.akamai.steamstatic.com/fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb_full.jpg'">
            <span class="pressure-friend-status-badge ${f.state}"></span>
          </div>
          <div class="pressure-friend-text-wrap">
            <div class="pressure-friend-name">${f.name}</div>
            <div class="pressure-friend-status-sub ${f.state}">${f.statusText}</div>
          </div>
        `;

        item.onclick = () => this.openConversation(f);
        container.appendChild(item);
      });
    },

    openConversation(friend) {
      State.activeChatFriend = friend;
      this.tabEl?.classList.add('in-convo');

      document.querySelectorAll('.pressure-friend-item').forEach(el => el.classList.remove('active'));
      document.getElementById(`friend-item-${friend.steamid}`)?.classList.add('active');

      const nameEl = document.getElementById('pressure-active-friend-name');
      const statusEl = document.getElementById('pressure-active-friend-status');
      if (nameEl) nameEl.textContent = friend.name;
      if (statusEl) {
        statusEl.textContent = friend.statusText;
        statusEl.className = `pressure-convo-header-status ${friend.state}`;
      }

      const input = document.getElementById('pressure-msg-input');
      const sendBtn = document.getElementById('pressure-msg-send-btn');
      if (input) {
        input.disabled = false;
        input.placeholder = `Send message to ${friend.name}...`;
        input.focus();
      }
      if (sendBtn) sendBtn.disabled = false;

      this.loadMessages(friend.steamid);

      if (State.chatPollTimer) clearInterval(State.chatPollTimer);
      State.chatPollTimer = setInterval(() => this.loadMessages(friend.steamid, true), 3500);
    },

    async loadMessages(partnerSteamId, silent = false) {
      const area = document.getElementById('pressure-messages-area');
      if (!area) return;

      try {
        const url = `/chat/getmessages?partner=${partnerSteamId}`;
        const res = await fetch(url, { credentials: 'same-origin' });
        if (res.ok) {
          const data = await res.json();
          area.innerHTML = '';
          (data.messages || []).forEach(m => {
            const bubble = document.createElement('div');
            bubble.className = `pressure-chat-bubble ${m.out ? 'out' : 'in'}`;
            bubble.innerHTML = `
              <div>${m.text}</div>
              <div class="pressure-chat-bubble-time">${m.time ? new Date(m.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</div>
            `;
            area.appendChild(bubble);
          });
          area.scrollTop = area.scrollHeight;
        } else if (!silent) {
          area.innerHTML = `<div style="margin:auto; font-size:12px; color:#8f98a0; text-align:center;">Connected to Steam Chat. Type below to message.</div>`;
        }
      } catch (e) {
        if (!silent) {
          area.innerHTML = `<div style="margin:auto; font-size:12px; color:#8f98a0; text-align:center;">Chat session active. Send a message to begin.</div>`;
        }
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
      tempBubble.innerHTML = `
        <div>${text}</div>
        <div class="pressure-chat-bubble-time">Now</div>
      `;
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

        Bridge.log(`[Chat] Sent message to friend ${State.activeChatFriend.steamid}`);
      } catch (err) {
        Bridge.log(`[Chat] Error sending message: ${err.message}`);
      }
    }
  };

  // ==========================================================================
  // 11. SETTINGS MODAL
  // ==========================================================================

  const SettingsModal = {
    async open() {
      const logs = await Bridge.call('getLogs').catch(() => ({ logs: [] }));

      const existing = document.getElementById('pressure-settings-modal');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'pressure-settings-modal';
      overlay.className = 'pressure-modal-overlay';
      overlay.innerHTML = `
        <div class="pressure-modal">
          <div class="pressure-modal-header">
            <span class="pressure-modal-title">Pressure — Settings</span>
            <button class="pressure-modal-close">&times;</button>
          </div>
          <div class="pressure-modal-body">
            <div style="display:flex; flex-direction:column; gap:14px; font-size:13px;">
              <label style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" id="cfg-badges" ${State.config.showPriceBadges ? 'checked' : ''}>
                Display Market Prices directly on Item Cards
              </label>
              <label style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" id="cfg-ext" ${State.config.externalPrices ? 'checked' : ''}>
                Display CSFloat Prices on CS2 Items
              </label>
              <label style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" id="cfg-bio" ${State.config.biometricsForConfirmations ? 'checked' : ''}>
                Require Face ID / Passcode for Trade Confirmations
              </label>
              <label style="display:flex; align-items:center; gap:8px;">
                <input type="checkbox" id="cfg-trades" ${State.config.massConfirmTrades ? 'checked' : ''}>
                Allow Mass Confirmation of Trade Offers
              </label>
            </div>
            <div style="margin-top:16px;">
              <div style="font-size:12px; color:#8f98a0; margin-bottom:6px;">Live Diagnostics Log (saved to Documents/log.txt):</div>
              <textarea readonly style="width:100%; height:140px; background:#101418; color:#a4d007; font-family:monospace; font-size:10px; border:1px solid #2a475e; border-radius:4px; padding:6px; box-sizing:border-box;">${(logs.logs || []).join('\n')}</textarea>
            </div>
          </div>
          <div class="pressure-modal-footer">
            <button class="pressure-toolbar-btn green" id="cfg-save-btn">Save Settings</button>
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

  // ==========================================================================
  // 12. BOOTSTRAP
  // ==========================================================================

  async function bootstrap() {
    try {
      const cfg = await Bridge.call('getConfig');
      if (cfg) Object.assign(State.config, cfg);
    } catch (e) {}

    ActivationManager.init();
    InventoryEnhancer.init();
    PressureChatTab.init();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();
