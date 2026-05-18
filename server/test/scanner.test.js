const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createRepository, openDatabase } = require('../src/db');
const { scanOnce } = require('../src/scanner');

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

