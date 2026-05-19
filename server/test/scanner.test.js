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
      localEventsEnabled: true,
      ...overrides.delivery,
    },
    sms: {
      ...overrides.sms,
    },
    telegram: {
      ...overrides.telegram,
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

