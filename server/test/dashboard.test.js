const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const stylesCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');

function loadDashboardScript(overrides = {}) {
  const elements = new Map();
  const intervals = [];
  const timeouts = [];
  const getElement = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        disabled: false,
        hidden: false,
        innerHTML: '',
        textContent: '',
        value: '',
        addEventListener() {},
        close() {},
        removeAttribute() {},
        setAttribute() {},
        showModal() {},
      });
    }
    return elements.get(selector);
  };
  const summary = {
    eventCounts: { sms: 0, telegram: 0 },
    offers: [],
    rules: [],
    scans: [],
    sources: { listingUrls: [], manualUrls: [] },
    now: '2026-05-18T21:20:08.882+08:00',
    windows: [],
  };
  const sandbox = {
    document: { querySelector: getElement },
    fetch: overrides.fetch || (async () => ({ ok: true, json: async () => summary })),
    setInterval: (callback) => {
      intervals.push(callback);
      return intervals.length;
    },
    clearInterval(id) {
      intervals[id - 1] = null;
    },
    setTimeout: (callback) => {
      timeouts.push(callback);
      return timeouts.length;
    },
    clearTimeout(id) {
      timeouts[id - 1] = null;
    },
    URL,
    URLSearchParams,
    window: { addEventListener() {}, location: { search: overrides.search || '' } },
    __elements: elements,
    __intervals: intervals,
    __timeouts: timeouts,
  };
  vm.runInNewContext(appJs, sandbox);
  return sandbox;
}

test('dashboard moves scan source editing into a modal opened from the top action bar', () => {
  const refreshIndex = html.indexOf('id="refreshButton"');
  const sourcesIndex = html.indexOf('id="sourceButton"');
  const scanIndex = html.indexOf('id="scanButton"');

  assert.ok(refreshIndex > -1);
  assert.ok(sourcesIndex > refreshIndex);
  assert.ok(scanIndex > sourcesIndex);
  assert.match(html, /<dialog[^>]+id="sourceDialog"/);
  assert.match(html, /id="listingUrlsInput"/);
  assert.match(html, /id="manualUrlsInput"/);
  assert.match(html, /id="sourceForm"/);
});

test('dashboard moves alert rule editing into a modal opened from the top action bar', () => {
  const refreshIndex = html.indexOf('id="refreshButton"');
  const ruleIndex = html.indexOf('id="ruleButton"');
  const sourcesIndex = html.indexOf('id="sourceButton"');
  const scanIndex = html.indexOf('id="scanButton"');

  assert.ok(ruleIndex > refreshIndex);
  assert.ok(sourcesIndex > ruleIndex);
  assert.ok(scanIndex > sourcesIndex);
  assert.match(html, /<dialog[^>]+id="ruleDialog"/);
  assert.match(html, /id="ruleForm"/);
  assert.match(html, /id="ruleCloseButton"/);
  assert.equal(html.includes('id="ruleForm" class="panel"'), false);
});

test('dashboard only shows top action buttons for management sessions', () => {
  const sandbox = loadDashboardScript({
    fetch: async (path) => ({
      ok: true,
      json: async () =>
        path === '/api/session'
          ? { ok: true, canManage: false }
          : {
              eventCounts: { sms: 0, telegram: 0 },
              offers: [],
              rules: [],
              scans: [],
              sources: { listingUrls: [], manualUrls: [] },
              now: '2026-05-18T21:20:08.882+08:00',
              windows: [],
            },
    }),
  });

  assert.match(html, /id="adminActions"[^>]*hidden/);
  sandbox.applySession({ canManage: false });
  assert.equal(sandbox.__elements.get('#adminActions').hidden, true);

  sandbox.applySession({ canManage: true });

  assert.equal(sandbox.__elements.get('#adminActions').hidden, false);
});

test('dashboard sends the current URL token as the management authorization header', async () => {
  const token = 'a'.repeat(32);
  const requests = [];
  const sandbox = loadDashboardScript({
    search: `?token=${token}`,
    fetch: async (path, options) => {
      requests.push({ path, options });
      return {
        ok: true,
        json: async () => ({ ok: true, canManage: true }),
      };
    },
  });

  await sandbox.api('/api/session');

  assert.equal(requests.at(-1).options.headers.authorization, `Bearer ${token}`);
  assert.equal(requests.at(-1).options.credentials, 'omit');
});

test('dashboard CSS keeps the hidden management action bar invisible', () => {
  assert.match(stylesCss, /\.actions\[hidden\]\s*\{[^}]*display:\s*none\s*;/s);
});

test('dashboard uses numeric inputs for alert price and repeat threshold fields', () => {
  assert.match(html, /id="ruleMaxPrice"[^>]+type="number"/);
  assert.match(html, /id="ruleRepeatAfter"[^>]+type="number"/);
  assert.match(appJs, /function\s+optionalNumberInput\(/);
});

test('dashboard nests summary metric cards inside the runtime status panel', () => {
  const gridIndex = html.indexOf('<section class="grid">');
  const runtimePanelIndex = html.indexOf('<section class="panel wide">');
  const metricsIndex = html.indexOf('<section class="metrics');
  const statusStripIndex = html.indexOf('<div class="status-strip">');

  assert.ok(gridIndex > -1);
  assert.ok(runtimePanelIndex > gridIndex);
  assert.ok(metricsIndex > runtimePanelIndex);
  assert.ok(metricsIndex < statusStripIndex);
  assert.match(html, /id="offerCount"/);
  assert.match(html, /id="windowCount"/);
  assert.match(html, /id="smsCount"/);
  assert.match(html, /id="telegramCount"/);
});

test('dashboard refreshes summary automatically every 10 seconds', () => {
  assert.match(appJs, /AUTO_REFRESH_INTERVAL_MS\s*=\s*10_?000/);
  assert.match(appJs, /function\s+refreshDashboard\(\)/);
  assert.match(appJs, /setInterval\(\s*refreshDashboard\s*,\s*AUTO_REFRESH_INTERVAL_MS\s*\)/);
  assert.match(appJs, /clearInterval\(\s*autoRefreshTimer\s*\)/);
});

test('dashboard displays UTC+8 timestamps without ISO separators or milliseconds', () => {
  const sandbox = loadDashboardScript();

  assert.equal(sandbox.formatDisplayTime('2026-05-18T21:20:08.882+08:00'), '2026-05-18 21:20:08 UTC+8');

  sandbox.renderSummary({
    eventCounts: { sms: 0, telegram: 0 },
    offers: [
      {
        availabilityStatus: 'available',
        canonicalUrl: 'https://www.apple.com.cn/shop/product/g1cepch/a',
        lastSeenAt: '2026-05-18T21:20:08.882+08:00',
        model: 'Mac Studio',
        price: { amount: '12345' },
        productId: 'g1cepch',
      },
    ],
    rules: [],
    scans: [],
    sources: { listingUrls: [], manualUrls: [] },
    now: '2026-05-18T21:20:08.882+08:00',
    windows: [
      {
        alertCount: 1,
        canonicalUrl: 'https://www.apple.com.cn/shop/product/g1cepch/a',
        fingerprint: 'fp',
        openedAt: '2026-05-18T21:20:08.882+08:00',
        openReason: 'first_seen_available',
        productId: 'g1cepch',
        status: 'open',
      },
    ],
  });

  assert.equal(sandbox.__elements.get('#lastUpdated').textContent, '更新时间 2026-05-18 21:20:08 UTC+8');
  assert.match(sandbox.__elements.get('#offersBody').innerHTML, /2026-05-18 21:20:08 UTC\+8/);
  assert.match(sandbox.__elements.get('#windows').innerHTML, /2026-05-18 21:20:08 UTC\+8/);
  assert.doesNotMatch(sandbox.__elements.get('#offersBody').innerHTML, /2026-05-18T21:20:08\.882\+08:00/);
  assert.doesNotMatch(sandbox.__elements.get('#windows').innerHTML, /2026-05-18T21:20:08\.882\+08:00/);
});

test('dashboard escapes reminder window fields before rendering HTML', () => {
  const sandbox = loadDashboardScript();

  sandbox.renderWindows([
    {
      alertCount: 1,
      canonicalUrl: 'https://www.apple.com.cn/shop/product/g1cepch/a?x=" onclick="alert(1)',
      fingerprint: 'fp',
      openedAt: '2026-05-18T21:20:08.882+08:00',
      openReason: '<script>alert(1)</script>',
      productId: '<img src=x onerror=alert(1)>',
      status: '<svg onload=alert(1)>',
    },
  ]);

  const html = sandbox.__elements.get('#windows').innerHTML;
  assert.doesNotMatch(html, /<script|<img|<svg|onclick=/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('dashboard renders running scan status without previous completion details', () => {
  const sandbox = loadDashboardScript();

  assert.equal(sandbox.scanStatusText([]), '等待');
  assert.equal(sandbox.scanStatusText([{ status: 'completed' }]), '已完成');
  assert.equal(sandbox.scanStatusText([{ status: 'completed_with_errors' }]), '已完成，有错误');
  assert.equal(sandbox.scanStatusText([{ status: 'failed' }]), '失败');
  assert.equal(sandbox.scanStatusText([{ status: 'running' }, { status: 'completed' }]), '扫描中');

  sandbox.renderSummary({
    eventCounts: { sms: 0, telegram: 0 },
    offers: [],
    rules: [],
    scans: [{ status: 'running' }, { status: 'completed' }],
    sources: { listingUrls: [], manualUrls: [] },
    now: '2026-05-18T21:20:08.882+08:00',
    windows: [],
  });

  assert.equal(sandbox.__elements.get('#lastScanState').textContent, '扫描中');
});

test('dashboard keeps source edits in the open dialog during automatic refreshes', () => {
  const sandbox = loadDashboardScript();
  sandbox.renderSources({ listingUrls: [], manualUrls: [] });
  sandbox.openSourceDialog();
  const sourceDialog = sandbox.__elements.get('#sourceDialog');
  const listingInput = sandbox.__elements.get('#listingUrlsInput');
  const manualInput = sandbox.__elements.get('#manualUrlsInput');

  sourceDialog.open = true;
  listingInput.value = 'https://www.apple.com.cn/shop/refurbished/mac/mac-studio?local-edit=1';
  manualInput.value = 'https://www.apple.com.cn/shop/product/g1cepch/a?local-edit=1';

  sandbox.renderSummary({
    eventCounts: { sms: 0, telegram: 0 },
    offers: [],
    rules: [],
    scans: [],
    sources: {
      listingUrls: ['https://www.apple.com.cn/shop/refurbished/mac/mac-studio?from-server=1'],
      manualUrls: ['https://www.apple.com.cn/shop/product/g1cepch/a?from-server=1'],
    },
    now: '2026-05-18T21:20:08.882+08:00',
    windows: [],
  });

  assert.equal(listingInput.value, 'https://www.apple.com.cn/shop/refurbished/mac/mac-studio?local-edit=1');
  assert.equal(manualInput.value, 'https://www.apple.com.cn/shop/product/g1cepch/a?local-edit=1');
});

test('dashboard disables browser cache for API reads and writes', async () => {
  const requests = [];
  const sandbox = loadDashboardScript({
    fetch: async (path, options) => {
      requests.push({ path, options });
      return {
        ok: true,
        json: async () => ({
          eventCounts: { sms: 0, telegram: 0 },
          offers: [],
          rules: [],
          scans: [],
          sources: { listingUrls: [], manualUrls: [] },
          now: '2026-05-18T21:20:08.882+08:00',
          windows: [],
        }),
      };
    },
  });

  await sandbox.loadSummary();

  assert.equal(requests.at(-1).path, '/api/summary');
  assert.equal(requests.at(-1).options.cache, 'no-store');
});

test('dashboard renders the product name as the Apple product link', () => {
  const sandbox = loadDashboardScript();

  sandbox.renderOffers([
    {
      availabilityStatus: 'available',
      canonicalUrl: 'https://www.apple.com.cn/shop/product/g1cepch/a',
      lastSeenAt: '2026-05-18T21:20:08.882+08:00',
      model: 'Mac Studio',
      title: 'Mac Studio 512GB',
      price: { amount: '12345' },
      productId: 'G1CEPCH/A',
    },
  ]);

  const html = sandbox.__elements.get('#offersBody').innerHTML;
  assert.match(html, /<a href="https:\/\/www\.apple\.com\.cn\/shop\/product\/g1cepch\/a"[^>]*>Mac Studio 512GB<\/a>/);
  assert.doesNotMatch(html, />G1CEPCH\/A<\/a>/);
});

test('dashboard only renders Apple product URLs as clickable product links', () => {
  const sandbox = loadDashboardScript();

  sandbox.renderOffers([
    {
      availabilityStatus: 'available',
      canonicalUrl: 'javascript:alert(1)',
      lastSeenAt: '2026-05-18T21:20:08.882+08:00',
      model: 'Mac Studio',
      title: 'Mac Studio 512GB',
      price: { amount: '12345' },
      productId: 'G1CEPCH/A',
    },
  ]);

  const html = sandbox.__elements.get('#offersBody').innerHTML;
  assert.match(html, /<a href="#"[^>]*>Mac Studio 512GB<\/a>/);
  assert.doesNotMatch(html, /javascript:alert/);
});

test('dashboard renders core products in a separate section before recent products', () => {
  const coreIndex = html.indexOf('<h2>核心商品</h2>');
  const recentIndex = html.indexOf('<h2>最近商品</h2>');

  assert.ok(coreIndex > -1);
  assert.ok(recentIndex > coreIndex);
  assert.match(html, /id="coreOffersBody"/);
  assert.match(html, /class="product-table"/);
  assert.match(html, /class="col-product"/);
});

test('dashboard separates independent monitor products from recent product rows', () => {
  const sandbox = loadDashboardScript();

  sandbox.renderSummary({
    coreOffers: [
      {
        availabilityStatus: 'available',
        canonicalUrl: 'https://www.apple.com.cn/shop/product/g1cepch/a',
        lastSeenAt: '2026-05-18T21:20:08.882+08:00',
        model: 'Mac Studio',
        title: 'Core Mac Studio',
        price: { amount: 'RMB 63,099' },
        productId: 'G1CEPCH/A',
      },
    ],
    eventCounts: { sms: 0, telegram: 0 },
    offers: [
      {
        availabilityStatus: 'available',
        canonicalUrl: 'https://www.apple.com.cn/shop/product/g1cepch/a',
        lastSeenAt: '2026-05-18T21:20:08.882+08:00',
        model: 'Mac Studio',
        title: 'Core Mac Studio',
        price: { amount: 'RMB 63,099' },
        productId: 'G1CEPCH/A',
      },
      {
        availabilityStatus: 'unavailable',
        canonicalUrl: 'https://www.apple.com.cn/shop/product/listing/a',
        lastSeenAt: '2026-05-18T21:21:08.882+08:00',
        model: 'Mac Studio',
        title: 'Listing Mac Studio',
        price: { amount: 'RMB 65,599' },
        productId: 'LISTING/A',
      },
    ],
    rules: [],
    scans: [],
    sources: { listingUrls: [], manualUrls: [] },
    now: '2026-05-18T21:20:08.882+08:00',
    windows: [],
  });

  assert.match(sandbox.__elements.get('#coreOffersBody').innerHTML, /Core Mac Studio/);
  assert.doesNotMatch(sandbox.__elements.get('#offersBody').innerHTML, /Core Mac Studio/);
  assert.match(sandbox.__elements.get('#offersBody').innerHTML, /Listing Mac Studio/);
});

test('dashboard hides recent products when global listing scan is disabled', () => {
  const sandbox = loadDashboardScript();

  sandbox.renderSummary({
    coreOffers: [
      {
        availabilityStatus: 'unavailable',
        canonicalUrl: 'https://www.apple.com.cn/shop/product/g1cepch/a',
        lastSeenAt: '2026-05-18T21:20:08.882+08:00',
        model: 'Mac Studio',
        title: 'Core Mac Studio',
        price: { amount: 'RMB 63,099' },
        productId: 'G1CEPCH/A',
      },
    ],
    eventCounts: { sms: 0, telegram: 0 },
    offers: [
      {
        availabilityStatus: 'available',
        canonicalUrl: 'https://www.apple.com.cn/shop/product/listing/a',
        lastSeenAt: '2026-05-18T21:21:08.882+08:00',
        model: 'Mac Studio',
        title: 'Listing Mac Studio',
        price: { amount: 'RMB 65,599' },
        productId: 'LISTING/A',
      },
    ],
    rules: [],
    scans: [],
    sources: { listingEnabled: false, listingUrls: ['https://www.apple.com.cn/shop/refurbished/mac/mac-studio'], manualUrls: [] },
    now: '2026-05-18T21:20:08.882+08:00',
    windows: [],
  });

  assert.equal(sandbox.__elements.get('#recentProductsPanel').hidden, true);
  assert.equal(sandbox.__elements.get('#offersBody').innerHTML, '');
  assert.match(sandbox.__elements.get('#coreOffersBody').innerHTML, /Core Mac Studio/);
});

test('manual refresh disables the refresh button until summary reload finishes', async () => {
  const sandbox = loadDashboardScript();
  let resolveFetch;
  sandbox.fetch = () =>
    new Promise((resolve) => {
      resolveFetch = () =>
        resolve({
          ok: true,
          json: async () => ({
            eventCounts: { sms: 0, telegram: 0 },
            offers: [],
            rules: [],
            scans: [],
            sources: { listingUrls: [], manualUrls: [] },
            now: '2026-05-18T21:20:08.882+08:00',
            windows: [],
          }),
        });
    });

  const refreshPromise = sandbox.handleManualRefresh();
  assert.equal(sandbox.__elements.get('#refreshButton').disabled, true);
  assert.equal(sandbox.__elements.get('#refreshButton').textContent, '刷新中');

  resolveFetch();
  await refreshPromise;

  assert.equal(sandbox.__elements.get('#refreshButton').disabled, false);
  assert.equal(sandbox.__elements.get('#refreshButton').textContent, '刷新');
});

test('manual scan keeps the scan button in a 10 second cooldown after the request', async () => {
  const sandbox = loadDashboardScript();
  sandbox.fetch = async (path) => {
    if (path === '/api/scan/run') {
      return {
        ok: true,
        json: async () => ({ summary: { scannedOffers: 1, matchedOffers: 1, alertsCreated: 0 } }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        eventCounts: { sms: 0, telegram: 0 },
        offers: [],
        rules: [],
        scans: [],
        sources: { listingUrls: [], manualUrls: [] },
        now: '2026-05-18T21:20:08.882+08:00',
        windows: [],
      }),
    };
  };

  await sandbox.runScan();

  const scanButton = sandbox.__elements.get('#scanButton');
  assert.equal(scanButton.disabled, true);
  assert.equal(scanButton.textContent, '冷却 10s');

  sandbox.__timeouts.at(-1)();
  assert.equal(scanButton.disabled, true);
  assert.equal(scanButton.textContent, '冷却 9s');

  for (let index = 0; index < 9; index += 1) {
    sandbox.__timeouts.at(-1)();
  }

  assert.equal(scanButton.disabled, false);
  assert.equal(scanButton.textContent, '立即扫描');
});
