const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createRepository, openDatabase } = require('../src/db');
const { createHttpServer, dashboardSummary, safeStaticPath } = require('../src/server');

function tempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-monitor-http-'));
  const db = openDatabase(path.join(dir, 'apple-monitor.sqlite'));
  return { db, repo: createRepository(db) };
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

function testConfig() {
  return {
    auth: {
      adminToken: 'a'.repeat(32),
      localScriptToken: 'b'.repeat(32),
      localDevAuthDisabled: false,
    },
    apple: {
      listingEnabled: false,
      listingUrls: [],
      manualUrls: [],
      requestTimeoutMs: 1000,
    },
    alerts: {
      rules: [{ id: 'mac-studio-512gb', model: 'Mac Studio', memory: ['512gb'] }],
    },
    delivery: {
      smsDryRun: true,
      telegramEnabled: true,
      localEventsEnabled: true,
    },
  };
}

test('HTTP API exposes unauthenticated health and protects dashboard data', async () => {
  const { db, repo } = tempRepo();
  const server = createHttpServer({ config: testConfig(), repo });
  const baseUrl = await listen(server);

  const health = await fetch(`${baseUrl}/api/health`);
  const unauthorized = await fetch(`${baseUrl}/api/summary`);
  const authorized = await fetch(`${baseUrl}/api/summary`, {
    headers: { authorization: `Bearer ${'a'.repeat(32)}` },
  });

  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
  assert.equal(unauthorized.status, 401);
  assert.equal(authorized.status, 200);
  assert.deepEqual((await authorized.json()).rules, testConfig().alerts.rules);

  server.close();
  db.close();
});

test('HTTP API updates alert rules and rate-limits manual scans', async () => {
  const { db, repo } = tempRepo();
  let scanCalls = 0;
  const server = createHttpServer({
    config: testConfig(),
    repo,
    scanOnceImpl: async () => {
      scanCalls += 1;
      return { scannedOffers: 0, matchedOffers: 0, alertsCreated: 0, errors: [] };
    },
  });
  const baseUrl = await listen(server);
  const headers = {
    authorization: `Bearer ${'a'.repeat(32)}`,
    'content-type': 'application/json',
  };

  const update = await fetch(`${baseUrl}/api/rules`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      rules: [{ id: 'mac-studio-256gb', model: 'Mac Studio', memory: ['256gb'] }],
    }),
  });
  const rules = await fetch(`${baseUrl}/api/rules`, { headers });
  const firstScan = await fetch(`${baseUrl}/api/scan/run`, { method: 'POST', headers });
  const secondScan = await fetch(`${baseUrl}/api/scan/run`, { method: 'POST', headers });

  assert.equal(update.status, 200);
  assert.deepEqual((await rules.json()).rules[0].memory, ['256gb']);
  assert.equal(firstScan.status, 200);
  assert.equal(secondScan.status, 429);
  assert.equal(scanCalls, 1);

  server.close();
  db.close();
});

test('HTTP API rejects non-finite numeric alert rule fields', async () => {
  const { db, repo } = tempRepo();
  const server = createHttpServer({ config: testConfig(), repo });
  const baseUrl = await listen(server);
  const headers = {
    authorization: `Bearer ${'a'.repeat(32)}`,
    'content-type': 'application/json',
  };

  const update = await fetch(`${baseUrl}/api/rules`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      rules: [{ id: 'bad-price', model: 'Mac Studio', memory: ['512gb'], maxPrice: 'not-a-number' }],
    }),
  });

  assert.equal(update.status, 400);
  assert.equal((await update.json()).error, 'rule 1 maxPrice must be a finite number');
  assert.equal(repo.getSetting('alert_rules'), null);

  server.close();
  db.close();
});

test('HTTP API persists scan sources and manual scan uses saved sources', async () => {
  const { db, repo } = tempRepo();
  let capturedConfig = null;
  const server = createHttpServer({
    config: testConfig(),
    repo,
    scanOnceImpl: async ({ config }) => {
      capturedConfig = config;
      return { scannedOffers: 0, matchedOffers: 0, alertsCreated: 0, errors: [] };
    },
  });
  const baseUrl = await listen(server);
  const headers = {
    authorization: `Bearer ${'a'.repeat(32)}`,
    'content-type': 'application/json',
  };
  const payload = {
    listingUrls: ['https://www.apple.com.cn/shop/refurbished/mac/mac-studio?filters=custom'],
    manualUrls: ['https://www.apple.com.cn/shop/product/g1cepch/a'],
  };

  const update = await fetch(`${baseUrl}/api/sources`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(payload),
  });
  const sources = await fetch(`${baseUrl}/api/sources`, { headers });
  const scan = await fetch(`${baseUrl}/api/scan/run`, { method: 'POST', headers });

  assert.equal(update.status, 200);
  assert.deepEqual((await update.json()).sources, { ...payload, listingEnabled: false });
  assert.equal(scan.status, 200);
  assert.deepEqual((await sources.json()).sources, { ...payload, listingEnabled: false });
  assert.equal(capturedConfig.apple.listingEnabled, false);
  assert.deepEqual(capturedConfig.apple.listingUrls, payload.listingUrls);
  assert.deepEqual(capturedConfig.apple.manualUrls, payload.manualUrls);

  server.close();
  db.close();
});

test('HTTP local events API returns pending local events for the Windows script', async () => {
  const { db, repo } = tempRepo();
  repo.recordLocalEvent({
    windowId: null,
    fingerprint: 'ofp_local_test',
    eventType: 'availability_alert',
    status: 'pending',
    payload: { title: 'Mac Studio', canonicalUrl: 'https://www.apple.com.cn/shop/product/g1cepch/a' },
    createdAt: '2026-05-18T21:20:08.882+08:00',
  });
  repo.recordLocalEvent({
    windowId: null,
    fingerprint: 'ofp_delivered_test',
    eventType: 'availability_alert',
    status: 'delivered',
    payload: { title: 'Old Mac Studio' },
    createdAt: '2026-05-18T21:19:08.882+08:00',
    deliveredAt: '2026-05-18T21:19:30.000+08:00',
  });
  const server = createHttpServer({ config: testConfig(), repo });
  const baseUrl = await listen(server);

  const unauthorized = await fetch(`${baseUrl}/api/local/events`);
  const authorized = await fetch(`${baseUrl}/api/local/events`, {
    headers: { authorization: `Bearer ${'b'.repeat(32)}` },
  });
  const secondAuthorized = await fetch(`${baseUrl}/api/local/events`, {
    headers: { authorization: `Bearer ${'b'.repeat(32)}` },
  });
  const body = await authorized.json();
  const secondBody = await secondAuthorized.json();

  assert.equal(unauthorized.status, 401);
  assert.equal(authorized.status, 200);
  assert.equal(secondAuthorized.status, 200);
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0].fingerprint, 'ofp_local_test');
  assert.equal(body.events[0].payload.title, 'Mac Studio');
  assert.equal(secondBody.events.length, 0);
  assert.equal(db.prepare('select status from local_events where fingerprint = ?').get('ofp_local_test').status, 'processing');

  server.close();
  db.close();
});

test('HTTP local events API claims the oldest pending events first', async () => {
  const { db, repo } = tempRepo();
  for (let index = 0; index < 101; index += 1) {
    const minute = Math.floor(index / 60);
    const second = index % 60;
    repo.recordLocalEvent({
      windowId: null,
      fingerprint: `ofp_order_${index}`,
      eventType: 'availability_alert',
      status: 'pending',
      payload: { title: `Mac Studio ${index}` },
      createdAt: `2026-05-18T21:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000+08:00`,
    });
  }
  const server = createHttpServer({ config: testConfig(), repo });
  const baseUrl = await listen(server);

  const authorized = await fetch(`${baseUrl}/api/local/events`, {
    headers: { authorization: `Bearer ${'b'.repeat(32)}` },
  });
  const body = await authorized.json();

  assert.equal(authorized.status, 200);
  assert.equal(body.events.length, 100);
  assert.equal(body.events[0].fingerprint, 'ofp_order_0');
  assert.equal(body.events[99].fingerprint, 'ofp_order_99');
  assert.equal(db.prepare('select status from local_events where fingerprint = ?').get('ofp_order_100').status, 'pending');

  server.close();
  db.close();
});

test('HTTP local events API marks events after Windows script delivery', async () => {
  const { db, repo } = tempRepo();
  repo.recordLocalEvent({
    windowId: null,
    fingerprint: 'ofp_ack_test',
    eventType: 'availability_alert',
    status: 'pending',
    payload: { title: 'Mac Studio' },
    createdAt: '2026-05-18T21:20:08.882+08:00',
  });
  const server = createHttpServer({ config: testConfig(), repo });
  const baseUrl = await listen(server);
  const headers = {
    authorization: `Bearer ${'b'.repeat(32)}`,
    'content-type': 'application/json',
  };

  const events = await fetch(`${baseUrl}/api/local/events`, { headers });
  const eventId = (await events.json()).events[0].id;
  const ack = await fetch(`${baseUrl}/api/local/events/${eventId}/ack`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ status: 'delivered' }),
  });
  const afterAck = await fetch(`${baseUrl}/api/local/events`, { headers });
  const row = db.prepare('select status, delivered_at from local_events where id = ?').get(eventId);

  assert.equal(ack.status, 200);
  assert.equal((await afterAck.json()).events.length, 0);
  assert.equal(row.status, 'delivered');
  assert.match(row.delivered_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);

  server.close();
  db.close();
});

test('HTTP API rejects malformed and oversized JSON bodies as client errors', async () => {
  const { db, repo } = tempRepo();
  const server = createHttpServer({ config: testConfig(), repo });
  const baseUrl = await listen(server);
  const headers = {
    authorization: `Bearer ${'a'.repeat(32)}`,
    'content-type': 'application/json',
  };

  const malformed = await fetch(`${baseUrl}/api/rules`, {
    method: 'PUT',
    headers,
    body: '{"rules":',
  });
  const oversized = await fetch(`${baseUrl}/api/rules`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ rules: [], padding: 'x'.repeat(70_000) }),
  });

  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error, 'invalid_json');
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error, 'request_body_too_large');

  server.close();
  db.close();
});

test('safeStaticPath rejects paths that resolve outside the public directory', () => {
  assert.equal(safeStaticPath('/../public-secret/leak.txt'), null);
});

test('dashboard summary prioritizes manual detail offers and alert-rule matches', () => {
  const offers = [
    {
      productId: 'LISTING-NEW',
      source: 'listing',
      model: 'MacBook Air',
      memory: '16gb',
      lastSeenAt: '2026-05-18T21:20:00+08:00',
    },
    {
      productId: 'MATCH-ONLY',
      source: 'listing',
      model: 'Mac Studio',
      memory: '512gb',
      lastSeenAt: '2026-05-18T21:10:00+08:00',
    },
    {
      productId: 'MANUAL-ONLY',
      source: 'detail',
      model: 'Mac Studio',
      memory: '256gb',
      lastSeenAt: '2026-05-18T21:00:00+08:00',
    },
    {
      productId: 'MANUAL-MATCH',
      source: 'detail',
      model: 'Mac Studio',
      memory: '512gb',
      lastSeenAt: '2026-05-18T20:50:00+08:00',
    },
  ];
  const repo = {
    getSetting() {
      return null;
    },
    listOfferSnapshots() {
      return offers;
    },
    listAvailabilityWindows() {
      return [];
    },
    listScanRuns() {
      return [];
    },
    getEventCounts() {
      return { sms: 0, telegram: 0, local: 0 };
    },
  };

  const summary = dashboardSummary(repo, testConfig());

  assert.deepEqual(
    summary.offers.map((offer) => offer.productId),
    ['MANUAL-MATCH', 'MATCH-ONLY', 'MANUAL-ONLY', 'LISTING-NEW'],
  );
});

test('dashboard summary exposes core offers from independent monitor URLs', () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/g1cepch/a';
  const offers = [
    {
      productId: 'GLOBAL-LISTING',
      canonicalUrl: 'https://www.apple.com.cn/shop/product/global/a',
      source: 'listing',
      model: 'Mac Studio',
      memory: '512gb',
      lastSeenAt: '2026-05-18T21:20:00+08:00',
    },
    {
      productId: 'CORE-MANUAL',
      canonicalUrl: manualUrl,
      source: 'detail',
      model: 'Mac Studio',
      memory: '512gb',
      lastSeenAt: '2026-05-18T21:10:00+08:00',
    },
  ];
  const repo = {
    getSetting(name) {
      if (name === 'scan_sources') {
        return {
          listingUrls: ['https://www.apple.com.cn/shop/refurbished/mac/mac-studio'],
          manualUrls: [manualUrl],
        };
      }
      return null;
    },
    listOfferSnapshots() {
      return offers;
    },
    listAvailabilityWindows() {
      return [];
    },
    listScanRuns() {
      return [];
    },
    getEventCounts() {
      return { sms: 0, telegram: 0, local: 0 };
    },
  };

  const summary = dashboardSummary(repo, testConfig());

  assert.deepEqual(
    summary.coreOffers.map((offer) => offer.productId),
    ['CORE-MANUAL'],
  );
});

test('dashboard summary deduplicates snapshots for the same product URL and keeps richer config fields', () => {
  const manualUrl = 'https://www.apple.com.cn/shop/product/fc6k4ch/a';
  const offers = [
    {
      productId: 'FC6K4CH/A',
      canonicalUrl: manualUrl,
      source: 'detail',
      title: 'Refurbished 15-inch MacBook Air M4',
      model: 'MacBook Air',
      chip: 'M4',
      memory: null,
      memoryText: null,
      storage: null,
      storageText: null,
      price: { amount: 'RMB 9,099', rawAmount: 9099 },
      availabilityStatus: 'available',
      lastSeenAt: '2026-05-19T12:35:38+08:00',
    },
    {
      productId: 'FC6K4CH/A',
      canonicalUrl: manualUrl,
      source: 'listing',
      title: 'Refurbished 15-inch MacBook Air M4',
      model: 'MacBook Air',
      chip: 'M4',
      memory: '24gb',
      memoryText: '24GB',
      storage: '512gb',
      storageText: '512GB',
      price: { amount: 'RMB 9,099', rawAmount: 9099 },
      availabilityStatus: 'available',
      lastSeenAt: '2026-05-19T01:00:39+08:00',
    },
  ];
  const repo = {
    getSetting(name) {
      if (name === 'scan_sources') {
        return {
          listingUrls: ['https://www.apple.com.cn/shop/refurbished/mac/mac-studio'],
          manualUrls: [manualUrl],
        };
      }
      return null;
    },
    listOfferSnapshots() {
      return offers;
    },
    listAvailabilityWindows() {
      return [];
    },
    listScanRuns() {
      return [];
    },
    getEventCounts() {
      return { sms: 0, telegram: 0, local: 0 };
    },
  };

  const summary = dashboardSummary(repo, testConfig());

  assert.equal(summary.offers.length, 1);
  assert.equal(summary.coreOffers.length, 1);
  assert.equal(summary.offers[0].productId, 'FC6K4CH/A');
  assert.equal(summary.offers[0].source, 'detail');
  assert.equal(summary.offers[0].memoryText, '24GB');
  assert.equal(summary.offers[0].storageText, '512GB');
  assert.equal(summary.offers[0].lastSeenAt, '2026-05-19T12:35:38+08:00');
});

test('HTTP API notification test endpoints use real senders when configured', async () => {
  const { db, repo } = tempRepo();
  const requests = [];
  const config = {
    ...testConfig(),
    delivery: {
      smsDryRun: false,
      telegramEnabled: true,
      localEventsEnabled: true,
    },
    sms: {
      secretId: 'sid',
      secretKey: 'skey',
      sdkAppId: '1400000000',
      signName: 'Apple鎻愰啋',
      templateId: '123456',
      phoneNumbers: ['+8613800000000'],
      templateParams: [],
      endpoint: 'https://sms.tencentcloudapi.com',
    },
    telegram: {
      botToken: 'dummy-token',
      chatId: '987654321',
      apiBaseUrl: 'https://telegram.example.test',
    },
  };
  const server = createHttpServer({
    config,
    repo,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (String(url).includes('telegram')) {
        return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
      }
      return {
        ok: true,
        json: async () => ({ Response: { RequestId: 'req-1', SendStatusSet: [{ Code: 'Ok' }] } }),
      };
    },
    notifyTestRateLimitMs: 0,
  });
  const baseUrl = await listen(server);
  const headers = {
    authorization: `Bearer ${'a'.repeat(32)}`,
    'content-type': 'application/json',
  };

  const sms = await fetch(`${baseUrl}/api/sms/test`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ templateParams: ['娴嬭瘯'] }),
  });
  const telegram = await fetch(`${baseUrl}/api/telegram/test`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message: '鐪熷疄 TG 娴嬭瘯' }),
  });

  assert.equal(sms.status, 200);
  assert.equal((await sms.json()).status, 'sent');
  assert.equal(telegram.status, 200);
  assert.equal((await telegram.json()).status, 'sent');
  assert.equal(requests.length, 2);

  server.close();
  db.close();
});

