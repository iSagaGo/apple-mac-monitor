const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildOfferFingerprint } = require('../src/rules');
const {
  backupDatabase,
  createRepository,
  openDatabase,
} = require('../src/db');

function tempDbPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-monitor-db-'));
  return path.join(dir, 'apple-monitor.sqlite');
}

function macStudioOffer(overrides = {}) {
  return {
    source: 'detail',
    productId: 'G1CEPCH/A',
    canonicalUrl: 'https://www.apple.com.cn/shop/product/g1cepch/a',
    title: 'Refurbished Mac Studio Apple M3 Ultra chip with 32-Core CPU and 80-Core GPU',
    model: 'Mac Studio',
    chip: 'M3 Ultra',
    cpuCores: 32,
    gpuCores: 80,
    memory: '512gb',
    memoryText: '512GB',
    storage: '16tb',
    storageText: '16TB',
    price: { amount: 'RMB 92,399', rawAmount: 92399 },
    availabilityStatus: 'available',
    ...overrides,
  };
}

test('openDatabase migrates schema and enables WAL mode', () => {
  const db = openDatabase(tempDbPath());
  const journalMode = db.pragma('journal_mode', { simple: true });
  const tables = db
    .prepare("select name from sqlite_master where type = 'table'")
    .all()
    .map((row) => row.name);

  assert.equal(String(journalMode).toLowerCase(), 'wal');
  assert.ok(tables.includes('offer_snapshots'));
  assert.ok(tables.includes('offer_states'));
  assert.ok(tables.includes('availability_windows'));
  assert.ok(tables.includes('sms_events'));
  assert.ok(tables.includes('telegram_events'));
  assert.ok(tables.includes('local_events'));
  db.close();
});

test('repository stores offer snapshots and per-url availability state', () => {
  const db = openDatabase(tempDbPath());
  const repo = createRepository(db);
  const offer = macStudioOffer();
  const fingerprint = buildOfferFingerprint(offer);

  repo.upsertOfferSnapshot(offer, {
    fingerprint,
    seenAt: '2026-05-18T20:00:00+08:00',
  });
  repo.saveOfferState(offer.canonicalUrl, {
    fingerprint,
    productId: offer.productId,
    status: 'available',
    windowOpen: true,
    availableSince: '2026-05-18T20:00:00+08:00',
    lastSeenAt: '2026-05-18T20:00:10+08:00',
    lastAlertAt: '2026-05-18T20:00:00+08:00',
  });

  const storedOffer = repo.getOfferSnapshot(fingerprint);
  const storedState = repo.getOfferState(offer.canonicalUrl);

  assert.equal(storedOffer.productId, 'G1CEPCH/A');
  assert.equal(storedOffer.seenCount, 1);
  assert.equal(storedOffer.raw.model, 'Mac Studio');
  assert.equal(storedState.fingerprint, fingerprint);
  assert.equal(storedState.windowOpen, true);

  repo.upsertOfferSnapshot(offer, {
    fingerprint,
    seenAt: '2026-05-18T20:00:20+08:00',
  });
  assert.equal(repo.getOfferSnapshot(fingerprint).seenCount, 2);
  db.close();
});

test('repository opens and closes availability windows', () => {
  const db = openDatabase(tempDbPath());
  const repo = createRepository(db);
  const offer = macStudioOffer();
  const fingerprint = buildOfferFingerprint(offer);

  const windowRecord = repo.openAvailabilityWindow({
    fingerprint,
    canonicalUrl: offer.canonicalUrl,
    productId: offer.productId,
    openedAt: '2026-05-18T20:00:00+08:00',
    openReason: 'first_available',
  });
  repo.incrementWindowAlert(windowRecord.id, {
    channel: 'telegram',
    alertedAt: '2026-05-18T20:00:01+08:00',
  });
  repo.closeAvailabilityWindow(windowRecord.id, {
    closedAt: '2026-05-18T20:01:00+08:00',
    closeReason: 'unavailable',
  });

  const windows = repo.listAvailabilityWindows({ limit: 5 });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].status, 'closed');
  assert.equal(windows[0].alertCount, 1);
  assert.equal(windows[0].lastAlertChannel, 'telegram');
  db.close();
});

test('backupDatabase creates a timestamped SQLite backup', async () => {
  const dbPath = tempDbPath();
  const db = openDatabase(dbPath);
  const repo = createRepository(db);
  const offer = macStudioOffer();
  repo.upsertOfferSnapshot(offer, {
    fingerprint: buildOfferFingerprint(offer),
    seenAt: '2026-05-18T20:00:00+08:00',
  });
  db.close();

  const backupDir = path.join(path.dirname(dbPath), 'backups');
  const backupPath = await backupDatabase({
    dbPath,
    backupDir,
    now: '2026-05-18T20:00:00+08:00',
  });
  const backupDb = openDatabase(backupPath, { readonly: true, migrate: false });
  const count = backupDb.prepare('select count(*) as count from offer_snapshots').get().count;

  assert.match(path.basename(backupPath), /^apple-monitor-20260518-200000\.sqlite$/);
  assert.equal(count, 1);
  backupDb.close();
});
