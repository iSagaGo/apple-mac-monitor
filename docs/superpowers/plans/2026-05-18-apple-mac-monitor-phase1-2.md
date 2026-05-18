# Apple Mac Monitor Phase 1/2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first server version that deterministically discovers Apple China refurbished Mac Studio products, parses specs, evaluates the 512GB rule, persists state in SQLite, and exposes a token-protected dry-run dashboard/API.

**Architecture:** Add a `server/` Node.js 22 app beside the existing PowerShell monitor. Phase 1 builds parser, discovery, rules, fingerprints, and availability-window logic with fixtures and tests. Phase 2 adds SQLite persistence, API, static dashboard, scheduler, dry-run delivery records, backup, Docker Compose, and OpenCloudOS deployment assets.

**Tech Stack:** Node.js 22, Node test runner, built-in `fetch`, `better-sqlite3`, plain HTTP server, static HTML/CSS/JS, Docker Compose v2, SQLite WAL.

---

## Repository Note

The current workspace `D:\codex\apple mac` is not a git repository. Do not run commit commands unless the workspace is initialized as git before implementation. If git is initialized, commit after each task with the suggested message.

## File Structure

- Create: `server/package.json` - Node scripts and dependencies.
- Create: `server/.gitignore` - ignores `.env`, runtime data, backups, and logs.
- Create: `server/.env.example` - documented non-secret configuration.
- Create: `server/src/config.js` - env parsing, defaults, high-entropy token validation, source URLs.
- Create: `server/src/time.js` - UTC+8 timestamp helpers.
- Create: `server/src/apple/availability.js` - deterministic availability signal parsing.
- Create: `server/src/apple/parser.js` - detail parser and offer fingerprint builder.
- Create: `server/src/apple/discovery.js` - listing/manual URL discovery and URL normalization.
- Create: `server/src/rules.js` - rule matching plus diagnostics.
- Create: `server/src/windows.js` - availability-window state transition logic.
- Create: `server/src/db/schema.js` - SQLite open, WAL, migrations, schema.
- Create: `server/src/db/repository.js` - product, snapshot, rule, window, alert, delivery, local-event persistence.
- Create: `server/src/delivery/dry-run.js` - dry-run SMS/TG delivery rows.
- Create: `server/src/scanner.js` - scan orchestration with concurrency, pacing, and dry-run alert creation.
- Create: `server/src/rate-limit.js` - simple in-memory rate limit for mutation endpoints.
- Create: `server/src/http.js` - token auth, API routes, static serving.
- Create: `server/src/worker.js` - scheduler loop and worker lock coordination.
- Create: `server/src/backup.js` - timestamped SQLite backup script.
- Create: `server/src/index.js` - app entrypoint.
- Create: `server/public/index.html` - operational dashboard shell.
- Create: `server/public/styles.css` - dashboard styling.
- Create: `server/public/app.js` - dashboard API client and rendering.
- Create: `server/test/fixtures/apple/mac-studio-listing.html` - saved listing HTML fixture.
- Create: `server/test/fixtures/apple/g1cepch-detail.html` - saved detail HTML fixture.
- Create: `server/test/*.test.js` - focused unit/integration tests.
- Create: `server/Dockerfile` - production Node image.
- Create: `server/docker-compose.yml` - app service, data mount, healthcheck.
- Create: `server/README.md` - local dev and OpenCloudOS deployment commands.
- Modify: root `README.md` - link server and local script responsibilities.

## Task 1: Server Scaffold And Configuration

**Files:**
- Create: `server/package.json`
- Create: `server/.gitignore`
- Create: `server/.env.example`
- Create: `server/src/config.js`
- Create: `server/src/time.js`
- Test: `server/test/config.test.js`
- Test: `server/test/time.test.js`

- [ ] **Step 1: Write failing config/time tests**

Create `server/test/config.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, maskSecret } = require('../src/config');

test('loadConfig applies Apple scan defaults and canonical sources', () => {
  const config = loadConfig({
    ADMIN_TOKEN: 'a'.repeat(32),
    LOCAL_SCRIPT_TOKEN: 'b'.repeat(32),
  });

  assert.equal(config.apple.listIntervalSeconds, 45);
  assert.equal(config.apple.detailIntervalSeconds, 15);
  assert.equal(config.apple.scanConcurrency, 2);
  assert.equal(config.apple.requestTimeoutMs, 15000);
  assert.deepEqual(config.apple.listingUrls, ['https://www.apple.com.cn/shop/refurbished/mac/mac-studio']);
  assert.deepEqual(config.apple.manualUrls, ['https://www.apple.com.cn/shop/product/g1cepch/a']);
});

test('loadConfig rejects short production tokens unless local auth is disabled', () => {
  assert.throws(
    () => loadConfig({ ADMIN_TOKEN: 'short', LOCAL_SCRIPT_TOKEN: 'also-short' }),
    /ADMIN_TOKEN/
  );

  const config = loadConfig({ LOCAL_DEV_AUTH_DISABLED: 'true' });
  assert.equal(config.auth.localDevAuthDisabled, true);
});

test('maskSecret redacts sensitive values', () => {
  assert.equal(maskSecret('1234567890abcdef'), '<redacted:12>');
  assert.equal(maskSecret(''), '<empty>');
});
```

Create `server/test/time.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { nowUtc8Iso, toUtc8Iso } = require('../src/time');

test('toUtc8Iso formats timestamps with explicit +08:00 offset', () => {
  assert.equal(toUtc8Iso(new Date('2026-05-18T10:00:00.123Z')), '2026-05-18T18:00:00.123+08:00');
});

test('nowUtc8Iso returns UTC+8 timestamp shape', () => {
  assert.match(nowUtc8Iso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm test -- --test-reporter=spec
```

Expected: fail because `package.json`, `src/config.js`, and `src/time.js` do not exist.

- [ ] **Step 3: Add package scripts and config/time implementation**

Create `server/package.json`:

```json
{
  "name": "apple-mac-monitor-server",
  "version": "0.1.0",
  "private": true,
  "type": "commonjs",
  "scripts": {
    "test": "node --test",
    "start": "node src/index.js",
    "scan:once": "node src/scanner.js --once",
    "backup": "node src/backup.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.9.1"
  }
}
```

Create `server/.gitignore`:

```gitignore
.env
data/
backups/
logs/
node_modules/
```

Create `server/.env.example`:

```env
ADMIN_TOKEN=replace_with_32_plus_random_chars
LOCAL_SCRIPT_TOKEN=replace_with_32_plus_random_chars
LOCAL_DEV_AUTH_DISABLED=false
PORT=8787
DATA_DIR=/app/data

APPLE_LIST_INTERVAL_SECONDS=45
APPLE_DETAIL_INTERVAL_SECONDS=15
APPLE_SCAN_CONCURRENCY=2
APPLE_REQUEST_TIMEOUT_MS=15000
APPLE_LISTING_URLS=https://www.apple.com.cn/shop/refurbished/mac/mac-studio
APPLE_MANUAL_URLS=https://www.apple.com.cn/shop/product/g1cepch/a

SMS_DRY_RUN=true
TENCENT_SECRET_ID=
TENCENT_SECRET_KEY=
TENCENT_SMS_SDK_APP_ID=
TENCENT_SMS_SIGN_NAME=
TENCENT_SMS_TEMPLATE_ID=
TENCENT_SMS_PHONE_NUMBERS=

TG_NOTIFY_ENABLED=true
TG_BOT_TOKEN=
TG_CHAT_ID=
TG_NOTIFY_PROXY_URL=
```

Create `server/src/time.js`:

```js
function pad(value, size = 2) {
  return String(value).padStart(size, '0');
}

function toUtc8Iso(date = new Date()) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  return [
    shifted.getUTCFullYear(),
    '-',
    pad(shifted.getUTCMonth() + 1),
    '-',
    pad(shifted.getUTCDate()),
    'T',
    pad(shifted.getUTCHours()),
    ':',
    pad(shifted.getUTCMinutes()),
    ':',
    pad(shifted.getUTCSeconds()),
    '.',
    pad(shifted.getUTCMilliseconds(), 3),
    '+08:00',
  ].join('');
}

function nowUtc8Iso() {
  return toUtc8Iso(new Date());
}

module.exports = { nowUtc8Iso, toUtc8Iso };
```

Create `server/src/config.js`:

```js
const path = require('node:path');

const DEFAULT_LISTING_URL = 'https://www.apple.com.cn/shop/refurbished/mac/mac-studio';
const DEFAULT_MANUAL_URL = 'https://www.apple.com.cn/shop/product/g1cepch/a';

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseIntWithDefault(value, fallback) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCsv(value, fallback) {
  const parsed = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function requireStrongToken(name, value, localDevAuthDisabled) {
  if (localDevAuthDisabled) return value || '';
  if (!value || String(value).length < 32) {
    throw new Error(`${name} must be at least 32 characters unless LOCAL_DEV_AUTH_DISABLED=true`);
  }
  return String(value);
}

function maskSecret(value) {
  if (!value) return '<empty>';
  return `<redacted:${String(value).length}>`;
}

function loadConfig(env = process.env) {
  const localDevAuthDisabled = parseBool(env.LOCAL_DEV_AUTH_DISABLED, false);
  const dataDir = env.DATA_DIR || path.join(__dirname, '..', 'data');
  return {
    port: parseIntWithDefault(env.PORT, 8787),
    dataDir,
    databasePath: path.join(dataDir, 'apple-monitor.sqlite'),
    auth: {
      adminToken: requireStrongToken('ADMIN_TOKEN', env.ADMIN_TOKEN, localDevAuthDisabled),
      localScriptToken: requireStrongToken('LOCAL_SCRIPT_TOKEN', env.LOCAL_SCRIPT_TOKEN, localDevAuthDisabled),
      localDevAuthDisabled,
    },
    apple: {
      listingUrls: parseCsv(env.APPLE_LISTING_URLS, [DEFAULT_LISTING_URL]),
      manualUrls: parseCsv(env.APPLE_MANUAL_URLS, [DEFAULT_MANUAL_URL]),
      listIntervalSeconds: parseIntWithDefault(env.APPLE_LIST_INTERVAL_SECONDS, 45),
      detailIntervalSeconds: parseIntWithDefault(env.APPLE_DETAIL_INTERVAL_SECONDS, 15),
      scanConcurrency: parseIntWithDefault(env.APPLE_SCAN_CONCURRENCY, 2),
      requestTimeoutMs: parseIntWithDefault(env.APPLE_REQUEST_TIMEOUT_MS, 15000),
    },
    delivery: {
      smsDryRun: parseBool(env.SMS_DRY_RUN, true),
      telegramEnabled: parseBool(env.TG_NOTIFY_ENABLED, true),
    },
  };
}

module.exports = {
  DEFAULT_LISTING_URL,
  DEFAULT_MANUAL_URL,
  loadConfig,
  maskSecret,
};
```

- [ ] **Step 4: Run scaffold tests**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm install
npm test -- --test-reporter=spec
```

Expected: config/time tests pass.

## Task 2: Apple Fixtures, URL Discovery, And Detail Parser

**Files:**
- Create: `server/src/apple/availability.js`
- Create: `server/src/apple/discovery.js`
- Create: `server/src/apple/parser.js`
- Create: `server/test/fixtures/apple/mac-studio-listing.html`
- Create: `server/test/fixtures/apple/g1cepch-detail.html`
- Test: `server/test/apple-parser.test.js`
- Test: `server/test/apple-discovery.test.js`

- [ ] **Step 1: Save initial HTML fixtures**

Run:

```powershell
Set-Location "D:\codex\apple mac"
New-Item -ItemType Directory -Force -Path ".\server\test\fixtures\apple" | Out-Null
curl.exe -L -sS --compressed -A "Mozilla/5.0 AppleMacMonitor/1.0" "https://www.apple.com.cn/shop/refurbished/mac/mac-studio" -o ".\server\test\fixtures\apple\mac-studio-listing.html"
curl.exe -L -sS --compressed -A "Mozilla/5.0 AppleMacMonitor/1.0" "https://www.apple.com.cn/shop/product/g1cepch/a" -o ".\server\test\fixtures\apple\g1cepch-detail.html"
```

Expected: both fixture files exist and are non-empty.

- [ ] **Step 2: Write failing parser/discovery tests**

Create `server/test/apple-discovery.test.js`:

```js
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { discoverProductLinks, normalizeProductUrl, productIdFromUrl } = require('../src/apple/discovery');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/apple/mac-studio-listing.html'), 'utf8');

test('productIdFromUrl normalizes Apple product URLs', () => {
  assert.equal(productIdFromUrl('https://www.apple.com.cn/shop/product/G1CEPCH/A?fnode=x'), 'g1cepch-a');
});

test('discoverProductLinks finds Mac Studio product links from listing HTML', () => {
  const links = discoverProductLinks(fixture, 'https://www.apple.com.cn/shop/refurbished/mac/mac-studio');
  assert.ok(Array.isArray(links));
  assert.ok(links.length >= 1);
  assert.ok(links.every((item) => item.url.includes('/shop/product/')));
  assert.ok(links.some((item) => productIdFromUrl(item.url) === 'g1cepch-a'));
});

test('normalizeProductUrl strips query and lowercases product code', () => {
  assert.equal(
    normalizeProductUrl('https://www.apple.com.cn/shop/product/G1CEPCH/A?abc=1'),
    'https://www.apple.com.cn/shop/product/g1cepch/a'
  );
});
```

Create `server/test/apple-parser.test.js`:

```js
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProductDetail, buildOfferFingerprint } = require('../src/apple/parser');

const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/apple/g1cepch-detail.html'), 'utf8');
const url = 'https://www.apple.com.cn/shop/product/g1cepch/a';

test('parseProductDetail extracts Mac Studio fields from detail HTML', () => {
  const parsed = parseProductDetail(fixture, url);
  assert.equal(parsed.productId, 'g1cepch-a');
  assert.equal(parsed.model, 'Mac Studio');
  assert.match(parsed.chip || '', /M\d|Ultra|Max/);
  assert.equal(parsed.availabilityStatus, 'available');
  assert.equal(parsed.available, true);
  assert.ok(parsed.priceCny > 0);
  assert.ok(parsed.title.length > 0);
});

test('buildOfferFingerprint ignores title-only changes when structured fields exist', () => {
  const base = {
    productId: 'g1cepch-a',
    title: 'Title A',
    model: 'Mac Studio',
    chip: 'M3 Ultra',
    cpuCores: 32,
    gpuCores: 80,
    unifiedMemoryGb: 512,
    storageGb: 1024,
    configurationText: 'stable',
  };
  const changedTitle = { ...base, title: 'Title B' };
  assert.equal(buildOfferFingerprint(base), buildOfferFingerprint(changedTitle));
});
```

- [ ] **Step 3: Run tests and verify they fail**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm test -- --test-reporter=spec .\test\apple-discovery.test.js .\test\apple-parser.test.js
```

Expected: fail because discovery/parser modules do not exist.

- [ ] **Step 4: Implement discovery and parser modules**

Implement `server/src/apple/discovery.js` with:

- `normalizeProductUrl(url)`.
- `productIdFromUrl(url)`.
- `discoverProductLinks(html, baseUrl)`.
- Only return links whose text or nearby HTML contains `Mac Studio`, or whose URL is a product URL and listing page is Mac Studio scoped.

Implement `server/src/apple/availability.js` with:

- `detectAvailability(text)` returning `available`, `unavailable`, or `unknown`.
- Chinese strings stored as Unicode escapes or read from UTF-8 fixtures, not PowerShell literals.

Implement `server/src/apple/parser.js` with:

- `parseProductDetail(html, url)`.
- `buildOfferFingerprint(parsed)`.
- `priceCny` normalization from `RMB 92,399`.
- memory/storage parsing for `GB` and `TB`.
- `parseConfidence`.
- `rawTextSnippet`.

- [ ] **Step 5: Run parser/discovery tests**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm test -- --test-reporter=spec .\test\apple-discovery.test.js .\test\apple-parser.test.js
```

Expected: all parser/discovery tests pass against saved fixtures.

## Task 3: Rules, Diagnostics, And Availability Windows

**Files:**
- Create: `server/src/rules.js`
- Create: `server/src/windows.js`
- Test: `server/test/rules.test.js`
- Test: `server/test/windows.test.js`

- [ ] **Step 1: Write failing tests for rules and state transitions**

Create `server/test/rules.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateRule } = require('../src/rules');

const defaultRule = {
  id: 'rule-512',
  name: 'Mac Studio 512GB unified memory',
  enabled: true,
  model: 'Mac Studio',
  unifiedMemoryGb: 512,
  available: true,
};

test('evaluateRule matches available 512GB Mac Studio', () => {
  const result = evaluateRule(defaultRule, {
    model: 'Mac Studio',
    unifiedMemoryGb: 512,
    availabilityStatus: 'available',
  });
  assert.equal(result.matches, true);
  assert.deepEqual(result.reasons, []);
});

test('evaluateRule explains mismatch reasons', () => {
  const result = evaluateRule(defaultRule, {
    model: 'Mac Studio',
    unifiedMemoryGb: 128,
    availabilityStatus: 'unknown',
  });
  assert.equal(result.matches, false);
  assert.ok(result.reasons.includes('memory 128 != 512'));
  assert.ok(result.reasons.includes('availabilityStatus unknown != available'));
});
```

Create `server/test/windows.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { decideAvailabilityWindow } = require('../src/windows');

test('first available scan opens a new window', () => {
  const result = decideAvailabilityWindow({
    previousWindow: null,
    previousProduct: null,
    scan: { availabilityStatus: 'available', offerFingerprint: 'fp-a' },
    now: '2026-05-18T18:00:00.000+08:00',
  });
  assert.equal(result.action, 'open');
  assert.equal(result.shouldAlert, true);
});

test('same offer still available does not alert again', () => {
  const result = decideAvailabilityWindow({
    previousWindow: { id: 10, status: 'open', offerFingerprint: 'fp-a' },
    previousProduct: { consecutiveUnavailable: 0 },
    scan: { availabilityStatus: 'available', offerFingerprint: 'fp-a' },
    now: '2026-05-18T18:01:00.000+08:00',
  });
  assert.equal(result.action, 'keep-open');
  assert.equal(result.shouldAlert, false);
});

test('same product with changed fingerprint opens a new offer window', () => {
  const result = decideAvailabilityWindow({
    previousWindow: { id: 10, status: 'open', offerFingerprint: 'fp-a' },
    previousProduct: { consecutiveUnavailable: 0 },
    scan: { availabilityStatus: 'available', offerFingerprint: 'fp-b' },
    now: '2026-05-18T18:02:00.000+08:00',
  });
  assert.equal(result.action, 'open-new-offer');
  assert.equal(result.shouldAlert, true);
});

test('one unavailable scan does not close the window', () => {
  const result = decideAvailabilityWindow({
    previousWindow: { id: 10, status: 'open', offerFingerprint: 'fp-a' },
    previousProduct: { consecutiveUnavailable: 0 },
    scan: { availabilityStatus: 'unavailable', offerFingerprint: 'fp-a' },
    now: '2026-05-18T18:03:00.000+08:00',
  });
  assert.equal(result.action, 'pending-close');
  assert.equal(result.shouldAlert, false);
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm test -- --test-reporter=spec .\test\rules.test.js .\test\windows.test.js
```

Expected: fail because `rules.js` and `windows.js` do not exist.

- [ ] **Step 3: Implement rules and window decision logic**

Implement:

- `evaluateRule(rule, product)` returns `{ matches, reasons }`.
- `defaultRule()` returns the Mac Studio 512GB rule object.
- `decideAvailabilityWindow({ previousWindow, previousProduct, scan, now })`.
- Two consecutive unavailable scans required before close.
- `unknown` does not open or close windows.

- [ ] **Step 4: Run rules/window tests**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm test -- --test-reporter=spec .\test\rules.test.js .\test\windows.test.js
```

Expected: tests pass.

## Task 4: SQLite Schema, Repository, Backup, And Retention

**Files:**
- Create: `server/src/db/schema.js`
- Create: `server/src/db/repository.js`
- Create: `server/src/backup.js`
- Test: `server/test/db.test.js`
- Test: `server/test/backup.test.js`

- [ ] **Step 1: Write failing persistence tests**

Create `server/test/db.test.js`:

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db/schema');
const { createRepository } = require('../src/db/repository');

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-monitor-'));
  return path.join(dir, 'apple-monitor.sqlite');
}

test('openDatabase enables WAL and applies migrations', () => {
  const db = openDatabase(tempDb());
  assert.equal(db.pragma('journal_mode', { simple: true }).toLowerCase(), 'wal');
  const tables = db.prepare("select name from sqlite_master where type='table'").all().map((row) => row.name);
  assert.ok(tables.includes('products'));
  assert.ok(tables.includes('availability_windows'));
  db.close();
});

test('repository upserts product and prevents duplicate alert events', () => {
  const db = openDatabase(tempDb());
  const repo = createRepository(db);
  repo.upsertProduct({
    productId: 'g1cepch-a',
    url: 'https://www.apple.com.cn/shop/product/g1cepch/a',
    title: 'Mac Studio',
    availabilityStatus: 'available',
    offerFingerprint: 'fp-a',
    lastSeenAt: '2026-05-18T18:00:00.000+08:00',
  });
  const window = repo.openAvailabilityWindow({
    productId: 'g1cepch-a',
    offerFingerprint: 'fp-a',
    openedAt: '2026-05-18T18:00:00.000+08:00',
  });
  const first = repo.createAlertEvent({
    ruleId: 'rule-512',
    productId: 'g1cepch-a',
    availabilityWindowId: window.id,
    createdAt: '2026-05-18T18:00:00.000+08:00',
  });
  const second = repo.createAlertEvent({
    ruleId: 'rule-512',
    productId: 'g1cepch-a',
    availabilityWindowId: window.id,
    createdAt: '2026-05-18T18:00:01.000+08:00',
  });
  assert.equal(first.id, second.id);
  db.close();
});
```

Create `server/test/backup.test.js`:

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { backupSqliteFiles } = require('../src/backup');

test('backupSqliteFiles copies sqlite, wal, and shm companions when present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apple-backup-'));
  const dbPath = path.join(dir, 'apple-monitor.sqlite');
  fs.writeFileSync(dbPath, 'db');
  fs.writeFileSync(`${dbPath}-wal`, 'wal');
  fs.writeFileSync(`${dbPath}-shm`, 'shm');
  const output = backupSqliteFiles({ databasePath: dbPath, backupRoot: path.join(dir, 'backups'), timestamp: '20260518T180000+0800' });
  assert.ok(fs.existsSync(path.join(output.backupDir, 'apple-monitor.sqlite')));
  assert.ok(fs.existsSync(path.join(output.backupDir, 'apple-monitor.sqlite-wal')));
  assert.ok(fs.existsSync(path.join(output.backupDir, 'apple-monitor.sqlite-shm')));
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm test -- --test-reporter=spec .\test\db.test.js .\test\backup.test.js
```

Expected: fail because DB modules do not exist.

- [ ] **Step 3: Implement schema, repository, backup**

Implement:

- SQLite WAL.
- `schema_migrations` table.
- Tables listed in the design.
- Unique indexes for alert/delivery de-duplication.
- `worker_locks` table.
- repository methods used by tests.
- `backupSqliteFiles`.
- `npm run backup` invokes `server/src/backup.js`.

- [ ] **Step 4: Run persistence tests**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm test -- --test-reporter=spec .\test\db.test.js .\test\backup.test.js
```

Expected: pass.

## Task 5: Scanner Orchestration And Dry-Run Delivery Events

**Files:**
- Create: `server/src/delivery/dry-run.js`
- Create: `server/src/scanner.js`
- Test: `server/test/scanner.test.js`
- Test: `server/test/dry-run.test.js`

- [ ] **Step 1: Write failing scanner/dry-run tests**

Create `server/test/dry-run.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDryRunDeliveries } = require('../src/delivery/dry-run');

test('buildDryRunDeliveries creates SMS and Telegram dry-run rows', () => {
  const rows = buildDryRunDeliveries({
    alertEventId: 42,
    now: '2026-05-18T18:00:00.000+08:00',
    product: { productId: 'g1cepch-a', title: 'Mac Studio', priceText: 'RMB 92,399' },
  });
  assert.deepEqual(rows.map((row) => row.channel).sort(), ['sms', 'telegram']);
  assert.ok(rows.every((row) => row.status === 'dry_run'));
});
```

Create `server/test/scanner.test.js` with faked fetch and in-memory DB:

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db/schema');
const { createRepository } = require('../src/db/repository');
const { runScanOnce } = require('../src/scanner');

test('runScanOnce stores products and creates dry-run deliveries for matching first available product', async () => {
  const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apple-scan-')), 'apple-monitor.sqlite');
  const db = openDatabase(dbPath);
  const repo = createRepository(db);
  const listing = fs.readFileSync(path.join(__dirname, 'fixtures/apple/mac-studio-listing.html'), 'utf8');
  const detail = fs.readFileSync(path.join(__dirname, 'fixtures/apple/g1cepch-detail.html'), 'utf8');
  const result = await runScanOnce({
    repo,
    now: '2026-05-18T18:00:00.000+08:00',
    listingUrls: ['https://www.apple.com.cn/shop/refurbished/mac/mac-studio'],
    manualUrls: ['https://www.apple.com.cn/shop/product/g1cepch/a'],
    fetchText: async (url) => (url.includes('/refurbished/') ? listing : detail),
    concurrency: 2,
  });

  assert.ok(result.productsSeen >= 1);
  assert.ok(repo.listProducts().some((item) => item.productId === 'g1cepch-a'));
  assert.ok(repo.listAlertEvents().length >= 1);
  assert.ok(repo.listDeliveryEvents().some((item) => item.status === 'dry_run'));
  db.close();
});
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm test -- --test-reporter=spec .\test\scanner.test.js .\test\dry-run.test.js
```

Expected: fail because scanner/delivery modules do not exist.

- [ ] **Step 3: Implement scanner and dry-run delivery**

Implement:

- Listing fetch.
- Manual URL inclusion.
- Detail fetch with concurrency limit.
- Product upsert and snapshots.
- Rule diagnostics.
- Window decision.
- Alert event creation.
- Dry-run SMS/TG delivery event rows.
- `unknown` scan handling.

- [ ] **Step 4: Run scanner tests and one live smoke scan**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm test -- --test-reporter=spec .\test\scanner.test.js .\test\dry-run.test.js
npm run scan:once
```

Expected: tests pass. Live scan completes and writes parse status even if no matching alert is found.

## Task 6: API, Auth, Rate Limits, And Static Dashboard

**Files:**
- Create: `server/src/rate-limit.js`
- Create: `server/src/http.js`
- Create: `server/src/index.js`
- Create: `server/public/index.html`
- Create: `server/public/styles.css`
- Create: `server/public/app.js`
- Test: `server/test/http.test.js`
- Test: `server/test/rate-limit.test.js`

- [ ] **Step 1: Write failing API/rate limit tests**

Create `server/test/rate-limit.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRateLimiter } = require('../src/rate-limit');

test('rate limiter blocks repeated calls within the window', () => {
  const limiter = createRateLimiter({ limit: 1, windowMs: 1000 });
  assert.equal(limiter.allow('scan').allowed, true);
  assert.equal(limiter.allow('scan').allowed, false);
});
```

Create `server/test/http.test.js`:

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/http');

test('health endpoint is unauthenticated', async () => {
  const app = createApp({ config: { auth: { adminToken: 'a'.repeat(32), localDevAuthDisabled: false } }, repo: fakeRepo() });
  const response = await app.inject({ method: 'GET', url: '/api/health' });
  assert.equal(response.statusCode, 200);
});

test('products endpoint requires bearer token by default', async () => {
  const app = createApp({ config: { auth: { adminToken: 'a'.repeat(32), localDevAuthDisabled: false } }, repo: fakeRepo() });
  assert.equal((await app.inject({ method: 'GET', url: '/api/products' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'GET', url: '/api/products', headers: { authorization: `Bearer ${'a'.repeat(32)}` } })).statusCode, 200);
});

function fakeRepo() {
  return {
    listProducts: () => [],
    listRules: () => [],
    listAlertEvents: () => [],
    listDeliveryEvents: () => [],
  };
}
```

- [ ] **Step 2: Run tests and verify they fail**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm test -- --test-reporter=spec .\test\http.test.js .\test\rate-limit.test.js
```

Expected: fail because HTTP and rate-limit modules do not exist.

- [ ] **Step 3: Implement API and dashboard**

Implement:

- `/api/health` unauthenticated.
- Bearer token auth for other routes unless `LOCAL_DEV_AUTH_DISABLED=true`.
- `/api/products`, `/api/rules`, `/api/alerts`, `/api/local/events`.
- `POST /api/scan/run`, `/api/sms/test`, `/api/telegram/test` with auth and rate limit.
- `createApp().inject()` test helper. It can be a lightweight wrapper around the route handler, not a full framework.
- Static dashboard that shows Products, Matching Alerts, Rules, History, Settings.
- Product rows include rule diagnostic reasons.

- [ ] **Step 4: Run API/dashboard tests**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm test -- --test-reporter=spec .\test\http.test.js .\test\rate-limit.test.js
```

Expected: pass.

## Task 7: Worker Lock, Scheduler, Docker, Backup Command, And Docs

**Files:**
- Create: `server/src/worker.js`
- Create: `server/Dockerfile`
- Create: `server/docker-compose.yml`
- Create: `server/README.md`
- Modify: `server/package.json`
- Modify: `README.md`
- Test: `server/test/worker.test.js`

- [ ] **Step 1: Write failing worker lock test**

Create `server/test/worker.test.js`:

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase } = require('../src/db/schema');
const { createRepository } = require('../src/db/repository');
const { tryAcquireWorkerLock } = require('../src/worker');

test('worker lock allows only one active scanner owner', () => {
  const db = openDatabase(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'apple-worker-')), 'apple-monitor.sqlite'));
  const repo = createRepository(db);
  assert.equal(tryAcquireWorkerLock(repo, 'worker-a', '2026-05-18T18:00:00.000+08:00'), true);
  assert.equal(tryAcquireWorkerLock(repo, 'worker-b', '2026-05-18T18:00:01.000+08:00'), false);
  db.close();
});
```

- [ ] **Step 2: Run test and verify it fails**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm test -- --test-reporter=spec .\test\worker.test.js
```

Expected: fail because `worker.js` lock function does not exist.

- [ ] **Step 3: Implement worker, Docker, docs**

Implement:

- Worker lock with TTL.
- Scheduler loops for listing and detail intervals.
- Startup resumes retryable delivery rows.
- Retention cleanup.
- Dockerfile using Node 22.
- Docker Compose app service with `/app/data` volume and healthcheck.
- `server/README.md` with OpenCloudOS 9 `dnf`, Docker, compose, `.env`, backup, and smoke scan commands.
- Root `README.md` adds server/local split and points to `server/README.md`.

Create `server/Dockerfile`:

```dockerfile
FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY . .
EXPOSE 8787
CMD ["npm", "start"]
```

Create `server/docker-compose.yml`:

```yaml
services:
  apple-monitor:
    build: .
    env_file:
      - .env
    ports:
      - "8787:8787"
    volumes:
      - ./data:/app/data
      - ./backups:/app/backups
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
```

- [ ] **Step 4: Run broad verification**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm test -- --test-reporter=spec
npm run backup
```

Expected: all tests pass; backup command creates a timestamped backup directory.

## Task 8: Final Phase 1/2 Verification

**Files:**
- No new files unless verification reveals defects.

- [ ] **Step 1: Run complete automated tests**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm test -- --test-reporter=spec
```

Expected: all tests pass.

- [ ] **Step 2: Run local server in dry-run mode**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
$env:LOCAL_DEV_AUTH_DISABLED='true'
$env:SMS_DRY_RUN='true'
npm start
```

Expected: server starts on `http://127.0.0.1:8787`, health endpoint returns `200`, and logs do not print secrets.

- [ ] **Step 3: Trigger a scan and inspect dashboard**

In a second PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:8787/api/scan/run"
Invoke-RestMethod -Uri "http://127.0.0.1:8787/api/products"
```

Expected: scan completes, products are listed, rule diagnostics are present, and dry-run delivery events appear when matching products are found.

- [ ] **Step 4: Run live scan smoke**

Run:

```powershell
Set-Location "D:\codex\apple mac\server"
npm run scan:once
```

Expected: command completes without crashing. It records listing/detail parse status even if no products match the 512GB rule.

- [ ] **Step 5: Confirm first implementation scope**

Check:

- Phase 1 parser/rules/window tests pass.
- Phase 2 API/dashboard/SQLite/dry-run tests pass.
- Real Tencent SMS and Telegram sending remain disabled/dry-run.
- Existing Windows PowerShell monitor still runs independently.

Expected: implementation is ready for review before Phase 3.
