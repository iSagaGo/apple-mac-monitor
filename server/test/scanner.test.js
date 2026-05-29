const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createRepository, openDatabase } = require('../src/db');
const { processOffer, scanOnce } = require('../src/scanner');

const fixturesDir = path.join(__dirname, 'fixtures', 'apple');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-monitor-scan-'));
  const db = openDatabase(path.join(dir, 'apple-monitor.sqlite'));
  return { db, repo: createRepository(db) };
}

function macStudioListingHtml() {
  const bootstrap = {
    dictionaries: {
      dimensions: {
        dimensionCapacity: { '16tb': { text: '16TB' } },
        refurbClearModel: { macstudio: { text: 'Mac Studio' } },
        tsMemorySize: { '512gb': { text: '512GB' } },
      },
    },
    tiles: [
      {
        productDetailsUrl: '/shop/product/g1cepch/a?fnode=session',
        partNumber: 'G1CEPCH/A',
        title: 'Refurbished Mac Studio Apple M3 Ultra chip with 32-Core CPU and 80-Core GPU',
        price: {
          basePartNumber: 'G1CEP',
          currentPrice: { amount: 'RMB 92,399', raw_amount: '92399.00' },
        },
        filters: {
          dimensions: {
            dimensionCapacity: '16tb',
            refurbClearModel: 'macstudio',
            tsMemorySize: '512gb',
          },
        },
      },
    ],
  };
  return `<script>window.REFURB_GRID_BOOTSTRAP = ${JSON.stringify(bootstrap)};</script>`;
}

function macStudioDetailHtml({ productId, pathProductId, available = false }) {
  const base = fs
    .readFileSync(path.join(fixturesDir, 'g1cepch-detail.html'), 'utf8')
    .replace(/G1CEPCH\/A/g, productId)
    .replace(/g1cepch/g, pathProductId);
  return available
    ? base
        .replace(/"isBuyable":false/g, '"isBuyable":true')
        .replace(/"buyable":false/g, '"buyable":true')
        .replace(/"availability":false/g, '"availability":true')
        .replace('class="button button-block disabled"', 'class="button button-block"')
        .replace(' disabled="disabled" data-autom="add-to-cart"', ' data-autom="add-to-cart"')
    : base;
}

function fakeFetch(responses) {
  return async (url) => {
    const html = responses[url];
    if (html === undefined) {
      return { ok: false, status: 404, text: async () => 'not found' };
    }
    return { ok: true, status: 200, text: async () => html };
  };
}

function scannerConfig(overrides = {}) {
  return {
    apple: {
      listingUrls: [],
      manualUrls: [],
      dynamicVariantsEnabled: false,
      dynamicVariantMode: 'shadow',
      requestTimeoutMs: 1000,
      ...overrides.apple,
    },
    alerts: {
      rules: [
        {
          id: 'mac-studio-512gb',
          model: 'Mac Studio',
          memory: ['512gb'],
        },
      ],
      ...overrides.alerts,
    },
    delivery: {
      smsDryRun: true,
      telegramEnabled: true,
      ntfyEnabled: false,
      localEventsEnabled: true,
      ...overrides.delivery,
    },
    sms: {
      ...overrides.sms,
    },
    telegram: {
      ...overrides.telegram,
    },
    ntfy: {
      ...overrides.ntfy,
    },
    observability: {
      scanEvidenceEnabled: false,
      scanEvidenceRetentionHours: 24,
      healthAlertsEnabled: false,
      healthAlertConsecutiveFailures: 3,
      healthAlertMinScannedOffers: 1,
      healthAlertCooldownSeconds: 1800,
      ...overrides.observability,
    },
  };
}

test('scanOnce records dry-run alerts for a matching available Mac Studio listing', async () => {
  const listingUrl = 'https://www.apple.com.cn/shop/refurbished/mac/mac-studio';
  const { db, repo } = tempDb();
  const config = scannerConfig({
    apple: { listingUrls: [listingUrl] },
  });

  const firstSummary = await scanOnce({
    config,
    repo,
    fetchImpl: fakeFetch({ [listingUrl]: macStudioListingHtml() }),
    now: '2026-05-18T20:00:00+08:00',
  });
  const secondSummary = await scanOnce({
    config,
    repo,
    fetchImpl: fakeFetch({ [listingUrl]: macStudioListingHtml() }),
    now: '2026-05-18T20:00:10+08:00',
  });

  assert.deepEqual(
    {
      scannedOffers: firstSummary.scannedOffers,
      matchedOffers: firstSummary.matchedOffers,
      alertsCreated: firstSummary.alertsCreated,
    },
    { scannedOffers: 1, matchedOffers: 1, alertsCreated: 1 },
  );
  assert.equal(secondSummary.alertsCreated, 0);
  assert.equal(repo.listAvailabilityWindows({ limit: 10 }).length, 1);
  assert.equal(db.prepare('select count(*) as count from sms_events').get().count, 1);
  assert.equal(db.prepare('select count(*) as count from telegram_events').get().count, 0);
  assert.equal(db.prepare('select count(*) as count from local_events').get().count, 1);
  assert.equal(db.prepare('select status from sms_events').get().status, 'dry_run');
  db.close();
});

test('scanOnce stores unavailable manual detail without creating alerts', async () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1cepch/a';
  const detailHtml = fs.readFileSync(path.join(fixturesDir, 'g1cepch-detail.html'), 'utf8');
  const { db, repo } = tempDb();
  const config = scannerConfig({
    apple: { manualUrls: [manualUrl] },
  });

  const summary = await scanOnce({
    config,
    repo,
    fetchImpl: fakeFetch({ [manualUrl]: detailHtml }),
    now: '2026-05-18T20:00:00+08:00',
  });
  const state = repo.getOfferState(manualUrl);

  assert.equal(summary.scannedOffers, 1);
  assert.equal(summary.matchedOffers, 1);
  assert.equal(summary.alertsCreated, 0);
  assert.equal(state.status, 'unavailable');
  assert.equal(db.prepare('select count(*) as count from sms_events').get().count, 0);
  db.close();
});

test('scanOnce records passive evidence for unavailable manual detail without creating alerts', async () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1cepch/a';
  const detailHtml = fs.readFileSync(path.join(fixturesDir, 'g1cepch-detail.html'), 'utf8');
  const { db, repo } = tempDb();
  const config = scannerConfig({
    apple: { manualUrls: [manualUrl] },
    observability: {
      scanEvidenceEnabled: true,
    },
  });

  const summary = await scanOnce({
    config,
    repo,
    fetchImpl: fakeFetch({ [manualUrl]: detailHtml }),
    now: '2026-05-18T20:00:00+08:00',
  });
  const evidenceRows = repo.listScanEvidence({ limit: 5 });

  assert.equal(summary.scannedOffers, 1);
  assert.equal(summary.matchedOffers, 1);
  assert.equal(summary.alertsCreated, 0);
  assert.equal(evidenceRows.length, 1);
  assert.equal(evidenceRows[0].sourceType, 'detail');
  assert.equal(evidenceRows[0].sourceUrl, manualUrl);
  assert.equal(evidenceRows[0].canonicalUrl, manualUrl);
  assert.equal(evidenceRows[0].productId, 'G1CEPCH/A');
  assert.equal(evidenceRows[0].availabilityStatus, 'unavailable');
  assert.equal(evidenceRows[0].matchedRule, true);
  assert.match(evidenceRows[0].htmlSha256, /^[a-f0-9]{64}$/);
  assert.equal(evidenceRows[0].evidence.title.includes('Mac Studio'), true);
  assert.equal(evidenceRows[0].evidence.availabilityEvidence.addToCartButtonDisabled, true);
  assert.equal(db.prepare('select count(*) as count from sms_events').get().count, 0);
  db.close();
});

test('scanOnce discovers Mac Studio detail variants in shadow mode without creating alerts', async () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1cepch/a';
  const variantIds = [
    'G1CE1CH/A',
    'G1CE6CH/A',
    'G1CEBCH/A',
    'G1CEGCH/A',
    'G1CEMCH/A',
    'G1CE2CH/A',
    'G1CE7CH/A',
    'G1CECCH/A',
    'G1CEHCH/A',
    'G1CENCH/A',
    'G1CE3CH/A',
    'G1CE8CH/A',
    'G1CEDCH/A',
    'G1CEJCH/A',
    'G1CEPCH/A',
  ];
  const responses = Object.fromEntries(
    variantIds.map((productId) => {
      const pathProductId = productId.split('/')[0].toLowerCase();
      return [
        `https://www.apple.com.cn/shop/product/${pathProductId}/a`,
        macStudioDetailHtml({
          productId,
          pathProductId,
          available: productId === 'G1CE1CH/A',
        }),
      ];
    }),
  );
  const requestedUrls = [];
  const { db, repo } = tempDb();
  const config = scannerConfig({
    apple: {
      manualUrls: [manualUrl],
      dynamicVariantsEnabled: true,
      dynamicVariantMode: 'shadow',
    },
    observability: {
      scanEvidenceEnabled: true,
    },
  });

  const summary = await scanOnce({
    config,
    repo,
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      const html = responses[url];
      return html === undefined
        ? { ok: false, status: 404, text: async () => 'not found' }
        : { ok: true, status: 200, text: async () => html };
    },
    now: '2026-05-18T20:00:00+08:00',
  });
  const requestedDetailUrls = new Set(requestedUrls.filter((url) => url.includes('/shop/product/')));

  assert.equal(requestedDetailUrls.size, 15);
  assert.equal(summary.dynamicVariantsDiscovered, 15);
  assert.equal(summary.dynamicVariantsScanned, 14);
  assert.equal(summary.scannedOffers, 15);
  assert.equal(summary.matchedOffers, 1);
  assert.equal(summary.alertsCreated, 0);
  assert.equal(repo.listOfferSnapshots({ limit: 20 }).length, 15);
  assert.equal(db.prepare("select count(*) as count from scan_evidence where source_type = 'dynamic_variant'").get().count, 14);
  assert.equal(db.prepare('select count(*) as count from availability_windows').get().count, 0);
  db.close();
});

test('scanOnce treats available manual monitor products as highest priority over alert filters', async () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1ce3ch/a';
  const { db, repo } = tempDb();
  const telegramRequests = [];
  const config = scannerConfig({
    apple: { manualUrls: [manualUrl] },
    alerts: {
      rules: [
        {
          id: 'intentionally-non-matching-rule',
          model: 'MacBook Pro',
          memory: ['16gb'],
        },
      ],
    },
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
    },
  });
  const responses = {
    [manualUrl]: macStudioDetailHtml({
      productId: 'G1CE3CH/A',
      pathProductId: 'g1ce3ch',
      available: true,
    }),
  };

  const summary = await scanOnce({
    config,
    repo,
    fetchImpl: async (url, options = {}) => {
      if (options.method === 'POST' && String(url).includes('telegram.example.test')) {
        telegramRequests.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ ok: true, result: { message_id: telegramRequests.length } }) };
      }
      const html = responses[url];
      return html === undefined
        ? { ok: false, status: 404, text: async () => 'not found' }
        : { ok: true, status: 200, text: async () => html };
    },
    now: '2026-05-19T12:10:00+08:00',
  });

  assert.equal(summary.scannedOffers, 1);
  assert.equal(summary.matchedOffers, 1);
  assert.equal(summary.alertsCreated, 1);
  assert.equal(telegramRequests.length, 2);
  assert.match(telegramRequests[0].text, /https:\/\/www\.apple\.com\.cn\/shop\/product\/g1ce3ch\/a/);
  assert.equal(db.prepare('select count(*) as count from availability_windows').get().count, 1);
  db.close();
});

test('processOffer alerts again when availability returns after an unknown scan', async () => {
  const { db, repo } = tempDb();
  const config = scannerConfig({
    delivery: {
      localEventsEnabled: false,
      telegramEnabled: false,
    },
  });
  const offer = {
    source: 'detail',
    productId: 'G1CEPCH/A',
    canonicalUrl: 'https://www.apple.com.cn/shop/product/g1cepch/a',
    url: 'https://www.apple.com.cn/shop/product/g1cepch/a',
    title: 'Mac Studio',
    model: 'Mac Studio',
    memory: '512gb',
    storage: '1tb',
    price: { amount: 'RMB 63,099', rawAmount: 63099 },
  };

  const first = await processOffer({
    repo,
    config,
    offer: { ...offer, availabilityStatus: 'available' },
    now: '2026-05-18T10:00:00+08:00',
  });
  const unknown = await processOffer({
    repo,
    config,
    offer: { ...offer, availabilityStatus: 'unknown' },
    now: '2026-05-18T10:00:10+08:00',
  });
  const returned = await processOffer({
    repo,
    config,
    offer: { ...offer, availabilityStatus: 'available' },
    now: '2026-05-18T10:00:20+08:00',
  });

  assert.equal(first.alerted, true);
  assert.equal(unknown.alerted, false);
  assert.equal(returned.alerted, true);
  assert.equal(returned.reason, 'restocked');
  assert.equal(repo.listAvailabilityWindows({ limit: 10 }).filter((window) => window.status === 'open').length, 1);
  db.close();
});

test('scanOnce sends manual Telegram summary again when a monitored URL restocks after selling out', async () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1ce3ch/a';
  const { db, repo } = tempDb();
  const telegramRequests = [];
  const config = scannerConfig({
    apple: {
      manualUrls: [manualUrl],
    },
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
      separatorEnabled: false,
    },
  });
  let available = true;
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST' && String(url).includes('telegram.example.test')) {
      telegramRequests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: telegramRequests.length } }) };
    }
    if (url === manualUrl) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          macStudioDetailHtml({
            productId: 'G1CE3CH/A',
            pathProductId: 'g1ce3ch',
            available,
          }),
      };
    }
    return { ok: false, status: 404, text: async () => 'not found' };
  };

  const first = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-19T10:00:00+08:00',
  });
  available = false;
  const soldOut = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-19T10:01:00+08:00',
  });
  available = true;
  const restocked = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-19T10:02:00+08:00',
  });
  const windows = repo.listAvailabilityWindows({ limit: 10 });

  assert.equal(first.alertsCreated, 1);
  assert.equal(soldOut.alertsCreated, 0);
  assert.equal(restocked.alertsCreated, 1);
  assert.equal(telegramRequests.length, 2);
  assert.match(telegramRequests[0].text, /https:\/\/www\.apple\.com\.cn\/shop\/product\/g1ce3ch\/a/);
  assert.match(telegramRequests[1].text, /https:\/\/www\.apple\.com\.cn\/shop\/product\/g1ce3ch\/a/);
  assert.equal(windows.length, 2);
  assert.equal(windows[0].status, 'open');
  assert.equal(windows[0].openReason, 'restocked');
  assert.equal(windows[1].status, 'closed');
  assert.equal(windows[1].closeReason, 'unavailable');
  assert.deepEqual(db.prepare('select status from telegram_events order by id').all(), [
    { status: 'sent' },
    { status: 'sent' },
  ]);
  db.close();
});

test('processOffer alerts manual priority offers that were previously seen without a reminder window', async () => {
  const { db, repo } = tempDb();
  const config = scannerConfig({
    alerts: {
      rules: [
        {
          id: 'intentionally-non-matching-rule',
          model: 'MacBook Pro',
          memory: ['16gb'],
        },
      ],
    },
    delivery: {
      localEventsEnabled: false,
      telegramEnabled: false,
    },
  });
  const offer = {
    source: 'detail',
    productId: 'ZZTESTCH/A',
    canonicalUrl: 'https://www.apple.com.cn/shop/product/zztestch/a',
    url: 'https://www.apple.com.cn/shop/product/zztestch/a',
    title: 'Refurbished iMac',
    model: 'iMac',
    chip: 'M4',
    memory: '16gb',
    memoryText: '16GB',
    storage: '256gb',
    storageText: '256GB',
    price: { amount: 'RMB 9,299', rawAmount: 9299 },
    availabilityStatus: 'available',
  };

  const first = await processOffer({
    repo,
    config,
    offer,
    now: '2026-05-19T12:00:00+08:00',
  });
  const stateAfterFirstScan = repo.getOfferState(offer.canonicalUrl);
  repo.saveOfferState(offer.canonicalUrl, {
    ...stateAfterFirstScan,
    windowOpen: true,
    lastAlertAt: '2026-05-19T12:00:00+08:00',
  });
  const second = await processOffer({
    repo,
    config,
    offer,
    now: '2026-05-19T12:00:10+08:00',
    bypassAlertRules: true,
  });

  assert.equal(first.matched, false);
  assert.equal(first.alerted, false);
  assert.equal(stateAfterFirstScan.windowOpen, false);
  assert.equal(second.matched, true);
  assert.equal(second.alerted, true);
  assert.equal(repo.listAvailabilityWindows({ limit: 10 }).length, 1);
  db.close();
});

test('scanOnce skips listing URLs when global listing scan is disabled', async () => {
  const listingUrl = 'https://www.apple.com.cn/shop/refurbished/mac/mac-studio';
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1ce8ch/a';
  const { db, repo } = tempDb();
  const requestedUrls = [];
  const config = scannerConfig({
    apple: {
      listingEnabled: false,
      listingUrls: [listingUrl],
      manualUrls: [manualUrl],
    },
    delivery: {
      telegramEnabled: false,
    },
  });

  const summary = await scanOnce({
    config,
    repo,
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      if (url === manualUrl) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            macStudioDetailHtml({
              productId: 'G1CE8CH/A',
              pathProductId: 'g1ce8ch',
              available: false,
            }),
        };
      }
      return { ok: true, status: 200, text: async () => macStudioListingHtml() };
    },
    now: '2026-05-18T20:05:00+08:00',
  });

  assert.deepEqual(requestedUrls, [manualUrl]);
  assert.equal(summary.scannedOffers, 1);
  assert.equal(repo.listOfferSnapshots({ limit: 10 }).length, 1);
  db.close();
});

test('scanOnce sends one Telegram summary for manual monitored products only', async () => {
  const availableManualUrl = 'https://www.apple.com.cn/shop/product/g1ce3ch/a';
  const unavailableManualUrl = 'https://www.apple.com.cn/shop/product/g1ce8ch/a';
  const listingUrl = 'https://www.apple.com.cn/shop/refurbished/mac/mac-studio';
  const { db, repo } = tempDb();
  const telegramRequests = [];
  const config = scannerConfig({
    apple: {
      listingUrls: [listingUrl],
      manualUrls: [availableManualUrl, unavailableManualUrl],
    },
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
    },
  });
  const responses = {
    [listingUrl]: macStudioListingHtml(),
    [availableManualUrl]: macStudioDetailHtml({
      productId: 'G1CE3CH/A',
      pathProductId: 'g1ce3ch',
      available: true,
    }),
    [unavailableManualUrl]: macStudioDetailHtml({
      productId: 'G1CE8CH/A',
      pathProductId: 'g1ce8ch',
      available: false,
    }),
  };

  const summary = await scanOnce({
    config,
    repo,
    fetchImpl: async (url, options = {}) => {
      if (options.method === 'POST' && String(url).includes('telegram.example.test')) {
        telegramRequests.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
      }
      const html = responses[url];
      return html === undefined
        ? { ok: false, status: 404, text: async () => 'not found' }
        : { ok: true, status: 200, text: async () => html };
    },
    now: '2026-05-18T23:20:00+08:00',
  });

  assert.equal(summary.alertsCreated, 2);
  assert.equal(telegramRequests.length, 2);
  assert.equal(telegramRequests[0].parse_mode, 'HTML');
  assert.match(telegramRequests[0].text, /^<b>.*2026-05-18 23:20:00 UTC\+8<\/b>\n\nApple /);
  assert.match(telegramRequests[0].text, /https:\/\/www\.apple\.com\.cn\/shop\/product\/g1ce3ch\/a/);
  assert.match(telegramRequests[0].text, /512GB \/ 16TB/);
  assert.doesNotMatch(telegramRequests[0].text, /https:\/\/www\.apple\.com\.cn\/shop\/product\/g1ce8ch\/a/);
  assert.doesNotMatch(telegramRequests[0].text, /shop\/refurbished\/mac\/mac-studio/);
  assert.equal(telegramRequests[1].parse_mode, 'HTML');
  assert.match(telegramRequests[1].text, /^<b>.*<\/b>$/);
  assert.equal([...telegramRequests[1].text.replace(/^<b>|<\/b>$/g, '')].length, 30);
  assert.equal(db.prepare('select count(*) as count from telegram_events').get().count, 2);
  db.close();
});

test('scanOnce sends ntfy manual summary alongside Telegram', async () => {
  const availableManualUrl = 'https://www.apple.com.cn/shop/product/g1ce3ch/a';
  const unavailableManualUrl = 'https://www.apple.com.cn/shop/product/g1ce8ch/a';
  const { db, repo } = tempDb();
  const telegramRequests = [];
  const ntfyRequests = [];
  const config = scannerConfig({
    apple: {
      manualUrls: [availableManualUrl, unavailableManualUrl],
    },
    delivery: {
      ntfyEnabled: true,
    },
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
      separatorEnabled: false,
    },
    ntfy: {
      baseUrl: 'https://ntfy.example.test',
      topic: 'apple-openclaw-test',
      accessToken: 'tk_testtoken',
      priority: 'urgent',
    },
  });
  const responses = {
    [availableManualUrl]: macStudioDetailHtml({
      productId: 'G1CE3CH/A',
      pathProductId: 'g1ce3ch',
      available: true,
    }),
    [unavailableManualUrl]: macStudioDetailHtml({
      productId: 'G1CE8CH/A',
      pathProductId: 'g1ce8ch',
      available: false,
    }),
  };

  const summary = await scanOnce({
    config,
    repo,
    fetchImpl: async (url, options = {}) => {
      if (options.method === 'POST' && String(url).includes('telegram.example.test')) {
        telegramRequests.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ ok: true, result: { message_id: telegramRequests.length } }) };
      }
      if (options.method === 'POST' && String(url).includes('ntfy.example.test')) {
        ntfyRequests.push({ url: String(url), options });
        return { ok: true, json: async () => ({ id: `ntfy-${ntfyRequests.length}` }) };
      }
      const html = responses[url];
      return html === undefined
        ? { ok: false, status: 404, text: async () => 'not found' }
        : { ok: true, status: 200, text: async () => html };
    },
    now: '2026-05-18T23:20:00+08:00',
  });

  assert.equal(summary.alertsCreated, 1);
  assert.equal(telegramRequests.length, 1);
  assert.equal(ntfyRequests.length, 1);
  assert.equal(ntfyRequests[0].url, 'https://ntfy.example.test/apple-openclaw-test');
  assert.match(ntfyRequests[0].options.body, /Apple monitor alert/);
  assert.match(ntfyRequests[0].options.body, /Available:/);
  assert.match(ntfyRequests[0].options.body, /Unavailable:/);
  assert.match(ntfyRequests[0].options.body, /https:\/\/www\.apple\.com\.cn\/shop\/product\/g1ce3ch\/a/);
  assert.deepEqual(db.prepare('select status, topic from ntfy_events').all(), [
    { status: 'sent', topic: 'apple-openclaw-test' },
  ]);
  db.close();
});

test('scanOnce does not retry manual summary when Telegram fails but ntfy succeeds', async () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1ce3ch/a';
  const { db, repo } = tempDb();
  const telegramRequests = [];
  const ntfyRequests = [];
  const config = scannerConfig({
    apple: {
      manualUrls: [manualUrl],
    },
    delivery: {
      localEventsEnabled: false,
      ntfyEnabled: true,
    },
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
      separatorEnabled: false,
    },
    ntfy: {
      baseUrl: 'https://ntfy.example.test',
      topic: 'apple-openclaw-test',
      accessToken: 'tk_testtoken',
      priority: 'urgent',
    },
  });
  const responses = {
    [manualUrl]: macStudioDetailHtml({
      productId: 'G1CE3CH/A',
      pathProductId: 'g1ce3ch',
      available: true,
    }),
  };
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST' && String(url).includes('telegram.example.test')) {
      telegramRequests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: false, description: 'telegram down' }) };
    }
    if (options.method === 'POST' && String(url).includes('ntfy.example.test')) {
      ntfyRequests.push({ url: String(url), body: options.body });
      return { ok: true, json: async () => ({ id: `ntfy-${ntfyRequests.length}` }) };
    }
    const html = responses[url];
    return html === undefined
      ? { ok: false, status: 404, text: async () => 'not found' }
      : { ok: true, status: 200, text: async () => html };
  };

  const first = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-18T23:20:00+08:00',
  });
  const second = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-18T23:20:10+08:00',
  });

  assert.equal(first.alertsCreated, 1);
  assert.equal(second.alertsCreated, 0);
  assert.equal(telegramRequests.length, 1);
  assert.equal(ntfyRequests.length, 1);
  assert.deepEqual(db.prepare('select status from telegram_events order by id').all(), [{ status: 'failed' }]);
  assert.deepEqual(db.prepare('select status from ntfy_events order by id').all(), [{ status: 'sent' }]);
  assert.equal(repo.getSetting('manual_telegram_retry'), null);
  db.close();
});

test('scanOnce sends cooldown-protected ntfy health alert after repeated unhealthy scans', async () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1cepch/a';
  const { db, repo } = tempDb();
  const ntfyRequests = [];
  const config = scannerConfig({
    apple: {
      manualUrls: [manualUrl],
    },
    delivery: {
      telegramEnabled: false,
      ntfyEnabled: true,
    },
    ntfy: {
      baseUrl: 'https://ntfy.example.test',
      topic: 'apple-openclaw-test',
      priority: 'urgent',
    },
    observability: {
      healthAlertsEnabled: true,
      healthAlertConsecutiveFailures: 2,
      healthAlertMinScannedOffers: 1,
      healthAlertCooldownSeconds: 600,
    },
  });
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST' && String(url).includes('ntfy.example.test')) {
      ntfyRequests.push({ url: String(url), options });
      return { ok: true, json: async () => ({ id: `ntfy-${ntfyRequests.length}` }) };
    }
    return { ok: false, status: 503, text: async () => 'apple unavailable' };
  };

  const first = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-18T20:00:00+08:00',
  });
  const second = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-18T20:00:10+08:00',
  });
  const third = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-18T20:00:20+08:00',
  });

  assert.equal(first.alertsCreated, 0);
  assert.equal(second.alertsCreated, 0);
  assert.equal(third.alertsCreated, 0);
  assert.equal(first.deliveryEvents, 0);
  assert.equal(second.deliveryEvents, 1);
  assert.equal(third.deliveryEvents, 0);
  assert.equal(ntfyRequests.length, 1);
  assert.equal(ntfyRequests[0].url, 'https://ntfy.example.test/apple-openclaw-test');
  assert.match(ntfyRequests[0].options.body, /Apple monitor health warning/);
  assert.match(ntfyRequests[0].options.body, /consecutive unhealthy scans: 2/i);
  assert.deepEqual(db.prepare('select status, topic from ntfy_events').all(), [
    { status: 'sent', topic: 'apple-openclaw-test' },
  ]);
  assert.deepEqual(repo.getSetting('monitor_health_consecutive_failures'), {
    count: 3,
    lastFailedAt: '2026-05-18T20:00:20+08:00',
    reasons: ['errors:1', 'scanned_offers_below_minimum:0<1'],
  });
  assert.equal(repo.getSetting('monitor_health_last_alert_at'), '2026-05-18T20:00:10+08:00');
  db.close();
});

test('scanOnce retries manual Telegram summary after a failed send', async () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1ce3ch/a';
  const { db, repo } = tempDb();
  const config = scannerConfig({
    apple: {
      manualUrls: [manualUrl],
    },
    delivery: {
      localEventsEnabled: false,
    },
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
    },
  });
  const responses = {
    [manualUrl]: macStudioDetailHtml({
      productId: 'G1CE3CH/A',
      pathProductId: 'g1ce3ch',
      available: true,
    }),
  };
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST' && String(url).includes('telegram.example.test')) {
      return { ok: true, json: async () => ({ ok: false, description: 'telegram down' }) };
    }
    const html = responses[url];
    return html === undefined
      ? { ok: false, status: 404, text: async () => 'not found' }
      : { ok: true, status: 200, text: async () => html };
  };

  const first = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-18T23:20:00+08:00',
  });
  const second = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-18T23:20:10+08:00',
  });

  assert.equal(first.alertsCreated, 1);
  assert.equal(second.alertsCreated, 0);
  assert.deepEqual(db.prepare('select status from telegram_events order by id').all(), [
    { status: 'failed' },
    { status: 'failed' },
  ]);
  db.close();
});

test('scanOnce retries only the failed manual Telegram summary without duplicating SMS or local events', async () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1ce3ch/a';
  const { db, repo } = tempDb();
  let telegramAttempts = 0;
  const config = scannerConfig({
    apple: {
      manualUrls: [manualUrl],
    },
    delivery: {
      smsDryRun: false,
      localEventsEnabled: true,
    },
    sms: {
      secretId: 'sid',
      secretKey: 'skey',
      sdkAppId: '1400000000',
      signName: 'Apple Notify',
      templateId: '123456',
      phoneNumbers: ['+8613800000000'],
      templateParams: ['{productLabel}', '{price}', '{productId}'],
      endpoint: 'https://sms.tencentcloudapi.com',
    },
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
      separatorEnabled: false,
    },
  });
  const responses = {
    [manualUrl]: macStudioDetailHtml({
      productId: 'G1CE3CH/A',
      pathProductId: 'g1ce3ch',
      available: true,
    }),
  };
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('sms.tencentcloudapi.com')) {
      return {
        ok: true,
        json: async () => ({ Response: { RequestId: 'req-1', SendStatusSet: [{ Code: 'Ok' }] } }),
      };
    }
    if (options.method === 'POST' && String(url).includes('telegram.example.test')) {
      telegramAttempts += 1;
      return {
        ok: true,
        json: async () =>
          telegramAttempts === 1
            ? { ok: false, description: 'telegram down' }
            : { ok: true, result: { message_id: telegramAttempts } },
      };
    }
    const html = responses[url];
    return html === undefined
      ? { ok: false, status: 404, text: async () => 'not found' }
      : { ok: true, status: 200, text: async () => html };
  };

  const first = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-18T23:20:00+08:00',
  });
  const second = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-18T23:20:10+08:00',
  });

  assert.equal(first.alertsCreated, 1);
  assert.equal(second.alertsCreated, 0);
  assert.equal(db.prepare('select count(*) as count from sms_events').get().count, 1);
  assert.equal(db.prepare('select count(*) as count from local_events').get().count, 1);
  assert.deepEqual(db.prepare('select status from telegram_events order by id').all(), [
    { status: 'failed' },
    { status: 'sent' },
  ]);
  db.close();
});

test('scanOnce does not duplicate manual alerts when SMS fails but Telegram summary succeeds', async () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1ce3ch/a';
  const { db, repo } = tempDb();
  const config = scannerConfig({
    apple: {
      manualUrls: [manualUrl],
    },
    delivery: {
      smsDryRun: false,
      localEventsEnabled: true,
    },
    sms: {
      secretId: 'sid',
      secretKey: 'skey',
      sdkAppId: '1400000000',
      signName: 'Apple Notify',
      templateId: '123456',
      phoneNumbers: ['+8613800000000'],
      templateParams: ['{productLabel}', '{price}', '{productId}'],
      endpoint: 'https://sms.tencentcloudapi.com',
    },
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
      separatorEnabled: false,
    },
  });
  const responses = {
    [manualUrl]: macStudioDetailHtml({
      productId: 'G1CE3CH/A',
      pathProductId: 'g1ce3ch',
      available: true,
    }),
  };
  const fetchImpl = async (url, options = {}) => {
    if (String(url).includes('sms.tencentcloudapi.com')) {
      return {
        ok: true,
        json: async () => ({
          Response: {
            Error: {
              Code: 'InternalError',
              Message: 'sms down',
            },
          },
        }),
      };
    }
    if (options.method === 'POST' && String(url).includes('telegram.example.test')) {
      return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
    }
    const html = responses[url];
    return html === undefined
      ? { ok: false, status: 404, text: async () => 'not found' }
      : { ok: true, status: 200, text: async () => html };
  };

  const first = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-18T23:20:00+08:00',
  });
  const second = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-18T23:20:10+08:00',
  });

  assert.equal(first.alertsCreated, 1);
  assert.equal(second.alertsCreated, 0);
  assert.deepEqual(db.prepare('select status from sms_events order by id').all(), [{ status: 'failed' }]);
  assert.deepEqual(db.prepare('select status from telegram_events order by id').all(), [{ status: 'sent' }]);
  assert.equal(db.prepare('select count(*) as count from local_events').get().count, 1);
  db.close();
});

test('scanOnce retries a failed manual Telegram summary with the original manual offer snapshot', async () => {
  const firstManualUrl = 'https://www.apple.com.cn/shop/product/g1ce3ch/a';
  const secondManualUrl = 'https://www.apple.com.cn/shop/product/g1ce8ch/a';
  const { db, repo } = tempDb();
  let telegramAttempts = 0;
  const config = scannerConfig({
    apple: {
      manualUrls: [firstManualUrl],
    },
    delivery: {
      localEventsEnabled: false,
    },
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
      separatorEnabled: false,
    },
  });
  const responses = {
    [firstManualUrl]: macStudioDetailHtml({
      productId: 'G1CE3CH/A',
      pathProductId: 'g1ce3ch',
      available: true,
    }),
    [secondManualUrl]: macStudioDetailHtml({
      productId: 'G1CE8CH/A',
      pathProductId: 'g1ce8ch',
      available: false,
    }),
  };
  const telegramRequests = [];
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST' && String(url).includes('telegram.example.test')) {
      telegramAttempts += 1;
      telegramRequests.push(JSON.parse(options.body));
      return {
        ok: true,
        json: async () =>
          telegramAttempts === 1
            ? { ok: false, description: 'telegram down' }
            : { ok: true, result: { message_id: telegramAttempts } },
      };
    }
    const html = responses[url];
    return html === undefined
      ? { ok: false, status: 404, text: async () => 'not found' }
      : { ok: true, status: 200, text: async () => html };
  };

  await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-18T23:20:00+08:00',
  });
  config.apple.manualUrls = [secondManualUrl];
  const second = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-18T23:20:10+08:00',
  });

  assert.equal(second.alertsCreated, 0);
  assert.equal(telegramRequests.length, 2);
  assert.match(telegramRequests[1].text, /https:\/\/www\.apple\.com\.cn\/shop\/product\/g1ce3ch\/a/);
  assert.doesNotMatch(telegramRequests[1].text, /g1ce8ch/);
  assert.equal(repo.getSetting('manual_telegram_retry'), null);
  db.close();
});

test('processOffer does not mark an alert as sent if delivery persistence fails', async () => {
  const { db, repo } = tempDb();
  const config = scannerConfig({
    delivery: {
      smsDryRun: true,
      telegramEnabled: false,
      localEventsEnabled: false,
    },
  });
  const offer = {
    source: 'detail',
    productId: 'G1CE3CH/A',
    canonicalUrl: 'https://www.apple.com.cn/shop/product/g1ce3ch/a',
    url: 'https://www.apple.com.cn/shop/product/g1ce3ch/a',
    title: 'Mac Studio',
    model: 'Mac Studio',
    memory: '512gb',
    storage: '16tb',
    availabilityStatus: 'available',
    price: { amount: 'RMB 92,399', rawAmount: 92399 },
  };
  const originalRecordSmsEvent = repo.recordSmsEvent;
  repo.recordSmsEvent = () => {
    throw new Error('sms_event_db_down');
  };

  await assert.rejects(
    processOffer({
      repo,
      config,
      offer,
      now: '2026-05-18T23:45:00+08:00',
    }),
    /sms_event_db_down/,
  );

  const state = repo.getOfferState(offer.canonicalUrl);
  assert.equal(state, null);
  repo.recordSmsEvent = originalRecordSmsEvent;
  db.close();
});

test('processOffer retries real SMS delivery failures even when local events are enabled', async () => {
  const { db, repo } = tempDb();
  const config = scannerConfig({
    delivery: {
      smsDryRun: false,
      telegramEnabled: false,
      localEventsEnabled: true,
    },
    sms: {
      secretId: 'sid',
      secretKey: 'skey',
      sdkAppId: '1400000000',
      signName: 'Apple Notify',
      templateId: '123456',
      phoneNumbers: ['+8613800000000'],
      templateParams: ['{productLabel}', '{price}', '{productId}'],
      endpoint: 'https://sms.tencentcloudapi.com',
    },
  });
  const offer = {
    source: 'detail',
    productId: 'G1CE3CH/A',
    canonicalUrl: 'https://www.apple.com.cn/shop/product/g1ce3ch/a',
    url: 'https://www.apple.com.cn/shop/product/g1ce3ch/a',
    title: 'Mac Studio',
    model: 'Mac Studio',
    memory: '512gb',
    storage: '16tb',
    availabilityStatus: 'available',
    price: { amount: 'RMB 92,399', rawAmount: 92399 },
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      Response: {
        Error: {
          Code: 'InternalError',
          Message: 'sms down',
        },
      },
    }),
  });

  const first = await processOffer({
    repo,
    config,
    offer,
    fetchImpl,
    now: '2026-05-18T23:40:00+08:00',
  });
  const second = await processOffer({
    repo,
    config,
    offer,
    fetchImpl,
    now: '2026-05-18T23:40:10+08:00',
  });

  assert.equal(first.alerted, true);
  assert.equal(second.alerted, true);
  assert.deepEqual(db.prepare('select status from sms_events order by id').all(), [
    { status: 'failed' },
    { status: 'failed' },
  ]);
  db.close();
});

test('processOffer retries real Telegram delivery failures even with dry-run SMS events', async () => {
  const { db, repo } = tempDb();
  const config = scannerConfig({
    delivery: {
      smsDryRun: true,
      telegramEnabled: true,
      localEventsEnabled: true,
    },
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
    },
  });
  const offer = {
    source: 'detail',
    productId: 'G1CE3CH/A',
    canonicalUrl: 'https://www.apple.com.cn/shop/product/g1ce3ch/a',
    url: 'https://www.apple.com.cn/shop/product/g1ce3ch/a',
    title: 'Mac Studio',
    model: 'Mac Studio',
    memory: '512gb',
    storage: '16tb',
    availabilityStatus: 'available',
    price: { amount: 'RMB 92,399', rawAmount: 92399 },
  };
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ ok: false, description: 'telegram down' }),
  });

  const first = await processOffer({
    repo,
    config,
    offer,
    fetchImpl,
    telegramDeliveryEnabled: true,
    now: '2026-05-18T23:50:00+08:00',
  });
  const second = await processOffer({
    repo,
    config,
    offer,
    fetchImpl,
    telegramDeliveryEnabled: true,
    now: '2026-05-18T23:50:10+08:00',
  });

  assert.equal(first.alerted, true);
  assert.equal(second.alerted, true);
  assert.deepEqual(db.prepare('select status from telegram_events order by id').all(), [
    { status: 'failed' },
    { status: 'failed' },
  ]);
  db.close();
});

test('scanOnce prefers manual detail when listing and manual URL point to the same product', async () => {
  const listingUrl = 'https://www.apple.com.cn/shop/refurbished/mac/mac-studio';
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1cepch/a';
  const { db, repo } = tempDb();
  const telegramRequests = [];
  const config = scannerConfig({
    apple: {
      listingUrls: [listingUrl],
      manualUrls: [manualUrl],
    },
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
    },
  });
  const responses = {
    [listingUrl]: macStudioListingHtml(),
    [manualUrl]: macStudioDetailHtml({
      productId: 'G1CEPCH/A',
      pathProductId: 'g1cepch',
      available: true,
    }),
  };

  const summary = await scanOnce({
    config,
    repo,
    fetchImpl: async (url, options = {}) => {
      if (options.method === 'POST' && String(url).includes('telegram.example.test')) {
        telegramRequests.push(JSON.parse(options.body));
        return { ok: true, json: async () => ({ ok: true, result: { message_id: telegramRequests.length } }) };
      }
      const html = responses[url];
      return html === undefined
        ? { ok: false, status: 404, text: async () => 'not found' }
        : { ok: true, status: 200, text: async () => html };
    },
    now: '2026-05-18T23:30:00+08:00',
  });

  assert.equal(summary.alertsCreated, 1);
  assert.equal(telegramRequests.length, 2);
  assert.match(telegramRequests[0].text, /^<b>.*2026-05-18 23:30:00 UTC\+8<\/b>\n\nApple /);
  assert.match(telegramRequests[0].text, /https:\/\/www\.apple\.com\.cn\/shop\/product\/g1cepch\/a/);
  assert.equal(repo.listOfferSnapshots({ limit: 10 })[0].source, 'detail');
  db.close();
});

test('scanOnce fetches Apple pages with bounded concurrency', async () => {
  const urls = [
    'https://www.apple.com.cn/shop/product/g1ce3ch/a',
    'https://www.apple.com.cn/shop/product/g1ce8ch/a',
    'https://www.apple.com.cn/shop/product/g1cedch/a',
  ];
  const { db, repo } = tempDb();
  let active = 0;
  let maxActive = 0;
  const config = scannerConfig({
    apple: {
      manualUrls: urls,
      scanConcurrency: 2,
    },
    delivery: {
      telegramEnabled: false,
    },
  });
  const responses = Object.fromEntries(
    urls.map((url, index) => [
      url,
      macStudioDetailHtml({
        productId: `G1CE${index}CH/A`,
        pathProductId: `g1ce${index}ch`,
        available: false,
      }),
    ]),
  );

  await scanOnce({
    config,
    repo,
    fetchImpl: async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      const html = responses[url];
      return html === undefined
        ? { ok: false, status: 404, text: async () => 'not found' }
        : { ok: true, status: 200, text: async () => html };
    },
    now: '2026-05-18T23:30:00+08:00',
  });

  assert.equal(maxActive, 2);
  db.close();
});

test('scanOnce sends a Telegram separator after alerts and then every configured interval', async () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1ce3ch/a';
  const { db, repo } = tempDb();
  const telegramRequests = [];
  const config = scannerConfig({
    apple: {
      manualUrls: [manualUrl],
    },
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
      separatorEnabled: true,
      separatorIntervalSeconds: 21600,
    },
  });
  const responses = {
    [manualUrl]: macStudioDetailHtml({
      productId: 'G1CE3CH/A',
      pathProductId: 'g1ce3ch',
      available: true,
    }),
  };
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST' && String(url).includes('telegram.example.test')) {
      telegramRequests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ ok: true, result: { message_id: telegramRequests.length } }) };
    }
    const html = responses[url];
    return html === undefined
      ? { ok: false, status: 404, text: async () => 'not found' }
      : { ok: true, status: 200, text: async () => html };
  };

  await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-18T23:20:00+08:00',
  });
  await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-19T00:20:00+08:00',
  });
  await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-19T05:20:00+08:00',
  });

  assert.equal(telegramRequests.length, 3);
  assert.match(telegramRequests[0].text, /^<b>.*2026-05-18 23:20:00 UTC\+8<\/b>\n\nApple /);
  assert.equal(telegramRequests[0].parse_mode, 'HTML');
  assert.match(telegramRequests[1].text, /^<b>.*<\/b>$/);
  assert.equal([...telegramRequests[1].text.replace(/^<b>|<\/b>$/g, '')].length, 30);
  assert.equal(telegramRequests[1].parse_mode, 'HTML');
  assert.match(telegramRequests[2].text, /^<b>.*<\/b>$/);
  assert.equal([...telegramRequests[2].text.replace(/^<b>|<\/b>$/g, '')].length, 30);
  assert.equal(repo.getSetting('telegram_separator_last_at'), '2026-05-19T05:20:00+08:00');
  assert.equal(db.prepare('select count(*) as count from telegram_events').get().count, 3);
  db.close();
});

test('scanOnce mirrors periodic separator check-ins to ntfy', async () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1ce3ch/a';
  const { db, repo } = tempDb();
  const ntfyRequests = [];
  const config = scannerConfig({
    apple: {
      manualUrls: [manualUrl],
    },
    delivery: {
      telegramEnabled: false,
      ntfyEnabled: true,
    },
    telegram: {
      separatorEnabled: true,
      separatorIntervalSeconds: 21600,
    },
    ntfy: {
      baseUrl: 'https://ntfy.example.test',
      topic: 'apple-openclaw-test',
      priority: 'urgent',
    },
  });
  const responses = {
    [manualUrl]: macStudioDetailHtml({
      productId: 'G1CE3CH/A',
      pathProductId: 'g1ce3ch',
      available: false,
    }),
  };
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST' && String(url).includes('ntfy.example.test')) {
      ntfyRequests.push({ url: String(url), options });
      return { ok: true, json: async () => ({ id: `ntfy-${ntfyRequests.length}` }) };
    }
    const html = responses[url];
    return html === undefined
      ? { ok: false, status: 404, text: async () => 'not found' }
      : { ok: true, status: 200, text: async () => html };
  };

  repo.setSetting('ntfy_separator_last_at', '2026-05-18T23:20:00+08:00', '2026-05-18T23:20:00+08:00');
  const summary = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-19T05:20:00+08:00',
  });

  assert.equal(summary.alertsCreated, 0);
  assert.equal(summary.deliveryEvents, 1);
  assert.equal(ntfyRequests.length, 1);
  assert.equal(ntfyRequests[0].url, 'https://ntfy.example.test/apple-openclaw-test');
  assert.match(ntfyRequests[0].options.body, /Apple monitor scheduled check-in/);
  assert.deepEqual(db.prepare('select status, topic from ntfy_events order by id').all(), [
    { status: 'sent', topic: 'apple-openclaw-test' },
  ]);
  assert.equal(repo.getSetting('ntfy_separator_last_at'), '2026-05-19T05:20:00+08:00');
  db.close();
});

test('scanOnce does not let a recent Telegram separator suppress the first ntfy check-in', async () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1ce3ch/a';
  const { db, repo } = tempDb();
  const ntfyRequests = [];
  const config = scannerConfig({
    apple: {
      manualUrls: [manualUrl],
    },
    delivery: {
      telegramEnabled: false,
      ntfyEnabled: true,
    },
    telegram: {
      separatorEnabled: true,
      separatorIntervalSeconds: 21600,
    },
    ntfy: {
      baseUrl: 'https://ntfy.example.test',
      topic: 'apple-openclaw-test',
    },
  });
  const responses = {
    [manualUrl]: macStudioDetailHtml({
      productId: 'G1CE3CH/A',
      pathProductId: 'g1ce3ch',
      available: false,
    }),
  };
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST' && String(url).includes('ntfy.example.test')) {
      ntfyRequests.push({ url: String(url), options });
      return { ok: true, json: async () => ({ id: `ntfy-${ntfyRequests.length}` }) };
    }
    const html = responses[url];
    return html === undefined
      ? { ok: false, status: 404, text: async () => 'not found' }
      : { ok: true, status: 200, text: async () => html };
  };

  repo.setSetting('telegram_separator_last_at', '2026-05-19T05:20:00+08:00', '2026-05-19T05:20:00+08:00');
  const first = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-19T05:20:00+08:00',
  });
  const second = await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-19T05:20:10+08:00',
  });

  assert.equal(first.deliveryEvents, 1);
  assert.equal(second.deliveryEvents, 0);
  assert.equal(ntfyRequests.length, 1);
  assert.match(ntfyRequests[0].options.body, /Apple monitor scheduled check-in/);
  assert.deepEqual(db.prepare('select status, topic from ntfy_events order by id').all(), [
    { status: 'sent', topic: 'apple-openclaw-test' },
  ]);
  assert.equal(repo.getSetting('telegram_separator_last_at'), '2026-05-19T05:20:00+08:00');
  assert.equal(repo.getSetting('ntfy_separator_last_at'), '2026-05-19T05:20:00+08:00');
  db.close();
});

test('scanOnce does not advance the periodic Telegram separator time when separator delivery fails', async () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1ce3ch/a';
  const { db, repo } = tempDb();
  const config = scannerConfig({
    apple: {
      manualUrls: [manualUrl],
    },
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
      separatorEnabled: true,
      separatorIntervalSeconds: 21600,
    },
  });
  const responses = {
    [manualUrl]: macStudioDetailHtml({
      productId: 'G1CE3CH/A',
      pathProductId: 'g1ce3ch',
      available: false,
    }),
  };
  const fetchImpl = async (url, options = {}) => {
    if (options.method === 'POST' && String(url).includes('telegram.example.test')) {
      return { ok: true, json: async () => ({ ok: false, description: 'telegram down' }) };
    }
    const html = responses[url];
    return html === undefined
      ? { ok: false, status: 404, text: async () => 'not found' }
      : { ok: true, status: 200, text: async () => html };
  };

  repo.setSetting('telegram_separator_last_at', '2026-05-18T23:20:00+08:00', '2026-05-18T23:20:00+08:00');
  await scanOnce({
    config,
    repo,
    fetchImpl,
    now: '2026-05-19T05:20:00+08:00',
  });

  assert.equal(repo.getSetting('telegram_separator_last_at'), '2026-05-18T23:20:00+08:00');
  assert.deepEqual(db.prepare('select status from telegram_events order by id').all(), [{ status: 'failed' }]);
  db.close();
});

