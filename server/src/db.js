const fs = require('node:fs');
const path = require('node:path');

const Database = require('better-sqlite3');

function ensureDirectoryForFile(filePath) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
}

function migrateDatabase(db) {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      applied_at text not null
    );

    create table if not exists offer_snapshots (
      fingerprint text primary key,
      product_id text not null,
      base_part_number text,
      canonical_url text not null,
      title text,
      model text,
      chip text,
      cpu_cores integer,
      gpu_cores integer,
      memory text,
      memory_text text,
      storage text,
      storage_text text,
      price_amount text,
      price_raw real,
      availability_status text not null,
      source text,
      raw_json text not null,
      first_seen_at text not null,
      last_seen_at text not null,
      seen_count integer not null default 1
    );

    create index if not exists idx_offer_snapshots_product_id
      on offer_snapshots(product_id);
    create index if not exists idx_offer_snapshots_canonical_url
      on offer_snapshots(canonical_url);
    create index if not exists idx_offer_snapshots_last_seen_at
      on offer_snapshots(last_seen_at);

    create table if not exists offer_states (
      canonical_url text primary key,
      fingerprint text not null,
      product_id text,
      status text not null,
      window_open integer not null default 0,
      available_since text,
      last_seen_at text not null,
      last_alert_at text,
      last_unavailable_at text,
      state_json text not null,
      updated_at text not null
    );

    create index if not exists idx_offer_states_fingerprint
      on offer_states(fingerprint);

    create table if not exists availability_windows (
      id integer primary key autoincrement,
      fingerprint text not null,
      canonical_url text not null,
      product_id text,
      status text not null,
      opened_at text not null,
      closed_at text,
      open_reason text,
      close_reason text,
      alert_count integer not null default 0,
      last_alert_at text,
      last_alert_channel text,
      created_at text not null,
      updated_at text not null
    );

    create index if not exists idx_availability_windows_fingerprint
      on availability_windows(fingerprint);
    create index if not exists idx_availability_windows_canonical_status
      on availability_windows(canonical_url, status);
    create index if not exists idx_availability_windows_opened_at
      on availability_windows(opened_at);

    create table if not exists scan_runs (
      id integer primary key autoincrement,
      started_at text not null,
      finished_at text,
      status text not null,
      source text,
      scanned_count integer not null default 0,
      matched_count integer not null default 0,
      alert_count integer not null default 0,
      error text,
      created_at text not null
    );

    create table if not exists app_settings (
      key text primary key,
      value_json text not null,
      updated_at text not null
    );

    create table if not exists sms_events (
      id integer primary key autoincrement,
      window_id integer,
      fingerprint text,
      idempotency_key text unique,
      status text not null,
      template_id text,
      phone_numbers_json text,
      payload_json text not null,
      created_at text not null,
      sent_at text,
      error text,
      foreign key(window_id) references availability_windows(id)
    );

    create table if not exists telegram_events (
      id integer primary key autoincrement,
      window_id integer,
      fingerprint text,
      idempotency_key text unique,
      status text not null,
      chat_id text,
      payload_json text not null,
      created_at text not null,
      sent_at text,
      error text,
      foreign key(window_id) references availability_windows(id)
    );

    create table if not exists local_events (
      id integer primary key autoincrement,
      window_id integer,
      fingerprint text,
      event_type text not null,
      status text not null,
      payload_json text not null,
      created_at text not null,
      delivered_at text,
      error text,
      foreign key(window_id) references availability_windows(id)
    );

    insert or ignore into schema_migrations(version, applied_at)
      values (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  `);
}

function openDatabase(dbPath, options = {}) {
  if (!options.readonly) {
    ensureDirectoryForFile(dbPath);
  }
  const db = new Database(dbPath, {
    readonly: options.readonly === true,
    fileMustExist: options.readonly === true,
  });
  if (options.migrate !== false && options.readonly !== true) {
    migrateDatabase(db);
  }
  return db;
}

function parseJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }
  return JSON.parse(value);
}

function rowToOfferSnapshot(row) {
  if (!row) {
    return null;
  }
  return {
    fingerprint: row.fingerprint,
    productId: row.product_id,
    basePartNumber: row.base_part_number,
    canonicalUrl: row.canonical_url,
    title: row.title,
    model: row.model,
    chip: row.chip,
    cpuCores: row.cpu_cores,
    gpuCores: row.gpu_cores,
    memory: row.memory,
    memoryText: row.memory_text,
    storage: row.storage,
    storageText: row.storage_text,
    price: {
      amount: row.price_amount,
      rawAmount: row.price_raw,
    },
    availabilityStatus: row.availability_status,
    source: row.source,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    seenCount: row.seen_count,
    raw: parseJson(row.raw_json, {}),
  };
}

function rowToOfferState(row) {
  if (!row) {
    return null;
  }
  return {
    canonicalUrl: row.canonical_url,
    fingerprint: row.fingerprint,
    productId: row.product_id,
    status: row.status,
    windowOpen: row.window_open === 1,
    availableSince: row.available_since,
    lastSeenAt: row.last_seen_at,
    lastAlertAt: row.last_alert_at,
    lastUnavailableAt: row.last_unavailable_at,
    updatedAt: row.updated_at,
    raw: parseJson(row.state_json, {}),
  };
}

function rowToAvailabilityWindow(row) {
  if (!row) {
    return null;
  }
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    canonicalUrl: row.canonical_url,
    productId: row.product_id,
    status: row.status,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    openReason: row.open_reason,
    closeReason: row.close_reason,
    alertCount: row.alert_count,
    lastAlertAt: row.last_alert_at,
    lastAlertChannel: row.last_alert_channel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createRepository(db) {
  const upsertOfferSnapshot = db.prepare(`
    insert into offer_snapshots (
      fingerprint, product_id, base_part_number, canonical_url, title, model, chip,
      cpu_cores, gpu_cores, memory, memory_text, storage, storage_text,
      price_amount, price_raw, availability_status, source, raw_json,
      first_seen_at, last_seen_at, seen_count
    ) values (
      @fingerprint, @productId, @basePartNumber, @canonicalUrl, @title, @model, @chip,
      @cpuCores, @gpuCores, @memory, @memoryText, @storage, @storageText,
      @priceAmount, @priceRaw, @availabilityStatus, @source, @rawJson,
      @seenAt, @seenAt, 1
    )
    on conflict(fingerprint) do update set
      product_id = excluded.product_id,
      base_part_number = excluded.base_part_number,
      canonical_url = excluded.canonical_url,
      title = excluded.title,
      model = excluded.model,
      chip = excluded.chip,
      cpu_cores = excluded.cpu_cores,
      gpu_cores = excluded.gpu_cores,
      memory = excluded.memory,
      memory_text = excluded.memory_text,
      storage = excluded.storage,
      storage_text = excluded.storage_text,
      price_amount = excluded.price_amount,
      price_raw = excluded.price_raw,
      availability_status = excluded.availability_status,
      source = excluded.source,
      raw_json = excluded.raw_json,
      last_seen_at = excluded.last_seen_at,
      seen_count = offer_snapshots.seen_count + 1
  `);

  const saveOfferState = db.prepare(`
    insert into offer_states (
      canonical_url, fingerprint, product_id, status, window_open, available_since,
      last_seen_at, last_alert_at, last_unavailable_at, state_json, updated_at
    ) values (
      @canonicalUrl, @fingerprint, @productId, @status, @windowOpen, @availableSince,
      @lastSeenAt, @lastAlertAt, @lastUnavailableAt, @stateJson, @updatedAt
    )
    on conflict(canonical_url) do update set
      fingerprint = excluded.fingerprint,
      product_id = excluded.product_id,
      status = excluded.status,
      window_open = excluded.window_open,
      available_since = excluded.available_since,
      last_seen_at = excluded.last_seen_at,
      last_alert_at = excluded.last_alert_at,
      last_unavailable_at = excluded.last_unavailable_at,
      state_json = excluded.state_json,
      updated_at = excluded.updated_at
  `);

  const getOfferSnapshot = db.prepare('select * from offer_snapshots where fingerprint = ?');
  const getOfferState = db.prepare('select * from offer_states where canonical_url = ?');
  const openWindow = db.prepare(`
    insert into availability_windows (
      fingerprint, canonical_url, product_id, status, opened_at, open_reason, created_at, updated_at
    ) values (
      @fingerprint, @canonicalUrl, @productId, 'open', @openedAt, @openReason, @openedAt, @openedAt
    )
  `);
  const getWindow = db.prepare('select * from availability_windows where id = ?');
  const closeWindow = db.prepare(`
    update availability_windows
      set status = 'closed',
          closed_at = @closedAt,
          close_reason = @closeReason,
          updated_at = @closedAt
      where id = @id
  `);
  const incrementWindowAlert = db.prepare(`
    update availability_windows
      set alert_count = alert_count + 1,
          last_alert_at = @alertedAt,
          last_alert_channel = @channel,
          updated_at = @alertedAt
      where id = @id
  `);
  const listWindows = db.prepare(`
    select * from availability_windows
      order by opened_at desc, id desc
      limit @limit
  `);
  const listOfferSnapshots = db.prepare(`
    select * from offer_snapshots
      order by last_seen_at desc, product_id asc
      limit @limit
  `);
  const eventCounts = db.prepare(`
    select
      (select count(*) from sms_events) as sms_count,
      (select count(*) from telegram_events) as telegram_count,
      (select count(*) from local_events) as local_count
  `);
  const listScanRuns = db.prepare(`
    select * from scan_runs
      order by started_at desc, id desc
      limit @limit
  `);
  const getSetting = db.prepare('select value_json from app_settings where key = ?');
  const setSetting = db.prepare(`
    insert into app_settings(key, value_json, updated_at)
      values (@key, @valueJson, @updatedAt)
    on conflict(key) do update set
      value_json = excluded.value_json,
      updated_at = excluded.updated_at
  `);
  const findOpenWindow = db.prepare(`
    select * from availability_windows
      where canonical_url = @canonicalUrl
        and fingerprint = @fingerprint
        and status = 'open'
      order by opened_at desc, id desc
      limit 1
  `);
  const recordSmsEvent = db.prepare(`
    insert or ignore into sms_events (
      window_id, fingerprint, idempotency_key, status, template_id,
      phone_numbers_json, payload_json, created_at, sent_at, error
    ) values (
      @windowId, @fingerprint, @idempotencyKey, @status, @templateId,
      @phoneNumbersJson, @payloadJson, @createdAt, @sentAt, @error
    )
  `);
  const recordTelegramEvent = db.prepare(`
    insert or ignore into telegram_events (
      window_id, fingerprint, idempotency_key, status, chat_id,
      payload_json, created_at, sent_at, error
    ) values (
      @windowId, @fingerprint, @idempotencyKey, @status, @chatId,
      @payloadJson, @createdAt, @sentAt, @error
    )
  `);
  const recordLocalEvent = db.prepare(`
    insert into local_events (
      window_id, fingerprint, event_type, status, payload_json, created_at, delivered_at, error
    ) values (
      @windowId, @fingerprint, @eventType, @status, @payloadJson, @createdAt, @deliveredAt, @error
    )
  `);
  const listLocalEvents = db.prepare(`
    select * from local_events
      where status = @status
      order by created_at desc, id desc
      limit @limit
  `);
  const markLocalEvent = db.prepare(`
    update local_events
      set status = @status,
          delivered_at = @deliveredAt,
          error = @error
      where id = @id
  `);
  const startScanRun = db.prepare(`
    insert into scan_runs (started_at, status, source, created_at)
      values (@startedAt, 'running', @source, @startedAt)
  `);
  const finishScanRun = db.prepare(`
    update scan_runs
      set finished_at = @finishedAt,
          status = @status,
          scanned_count = @scannedCount,
          matched_count = @matchedCount,
          alert_count = @alertCount,
          error = @error
      where id = @id
  `);

  return {
    upsertOfferSnapshot(offer, { fingerprint, seenAt }) {
      upsertOfferSnapshot.run({
        fingerprint,
        productId: offer.productId,
        basePartNumber: offer.basePartNumber ?? null,
        canonicalUrl: offer.canonicalUrl,
        title: offer.title ?? null,
        model: offer.model ?? null,
        chip: offer.chip ?? null,
        cpuCores: offer.cpuCores ?? null,
        gpuCores: offer.gpuCores ?? null,
        memory: offer.memory ?? null,
        memoryText: offer.memoryText ?? null,
        storage: offer.storage ?? null,
        storageText: offer.storageText ?? null,
        priceAmount: offer.price?.amount ?? null,
        priceRaw: offer.price?.rawAmount ?? null,
        availabilityStatus: offer.availabilityStatus ?? 'unknown',
        source: offer.source ?? null,
        rawJson: JSON.stringify(offer),
        seenAt,
      });
    },

    getOfferSnapshot(fingerprint) {
      return rowToOfferSnapshot(getOfferSnapshot.get(fingerprint));
    },

    saveOfferState(canonicalUrl, state) {
      saveOfferState.run({
        canonicalUrl,
        fingerprint: state.fingerprint,
        productId: state.productId ?? null,
        status: state.status,
        windowOpen: state.windowOpen ? 1 : 0,
        availableSince: state.availableSince ?? null,
        lastSeenAt: state.lastSeenAt,
        lastAlertAt: state.lastAlertAt ?? null,
        lastUnavailableAt: state.lastUnavailableAt ?? null,
        stateJson: JSON.stringify(state),
        updatedAt: state.lastSeenAt,
      });
    },

    getOfferState(canonicalUrl) {
      return rowToOfferState(getOfferState.get(canonicalUrl));
    },

    openAvailabilityWindow(windowData) {
      const info = openWindow.run({
        fingerprint: windowData.fingerprint,
        canonicalUrl: windowData.canonicalUrl,
        productId: windowData.productId ?? null,
        openedAt: windowData.openedAt,
        openReason: windowData.openReason ?? null,
      });
      return rowToAvailabilityWindow(getWindow.get(info.lastInsertRowid));
    },

    closeAvailabilityWindow(id, { closedAt, closeReason }) {
      closeWindow.run({ id, closedAt, closeReason: closeReason ?? null });
      return rowToAvailabilityWindow(getWindow.get(id));
    },

    incrementWindowAlert(id, { channel, alertedAt }) {
      incrementWindowAlert.run({ id, channel, alertedAt });
      return rowToAvailabilityWindow(getWindow.get(id));
    },

    findOpenAvailabilityWindow({ canonicalUrl, fingerprint }) {
      return rowToAvailabilityWindow(findOpenWindow.get({ canonicalUrl, fingerprint }));
    },

    listAvailabilityWindows({ limit = 50 } = {}) {
      return listWindows.all({ limit }).map(rowToAvailabilityWindow);
    },

    listOfferSnapshots({ limit = 100 } = {}) {
      return listOfferSnapshots.all({ limit }).map(rowToOfferSnapshot);
    },

    getEventCounts() {
      const row = eventCounts.get();
      return {
        sms: row.sms_count,
        telegram: row.telegram_count,
        local: row.local_count,
      };
    },

    listScanRuns({ limit = 20 } = {}) {
      return listScanRuns.all({ limit }).map((row) => ({
        id: row.id,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        source: row.source,
        scannedCount: row.scanned_count,
        matchedCount: row.matched_count,
        alertCount: row.alert_count,
        error: row.error,
        createdAt: row.created_at,
      }));
    },

    recordSmsEvent(event) {
      recordSmsEvent.run({
        windowId: event.windowId ?? null,
        fingerprint: event.fingerprint ?? null,
        idempotencyKey: event.idempotencyKey ?? null,
        status: event.status,
        templateId: event.templateId ?? null,
        phoneNumbersJson: JSON.stringify(event.phoneNumbers ?? []),
        payloadJson: JSON.stringify(event.payload ?? {}),
        createdAt: event.createdAt,
        sentAt: event.sentAt ?? null,
        error: event.error ?? null,
      });
    },

    recordTelegramEvent(event) {
      recordTelegramEvent.run({
        windowId: event.windowId ?? null,
        fingerprint: event.fingerprint ?? null,
        idempotencyKey: event.idempotencyKey ?? null,
        status: event.status,
        chatId: event.chatId ?? null,
        payloadJson: JSON.stringify(event.payload ?? {}),
        createdAt: event.createdAt,
        sentAt: event.sentAt ?? null,
        error: event.error ?? null,
      });
    },

    recordLocalEvent(event) {
      recordLocalEvent.run({
        windowId: event.windowId ?? null,
        fingerprint: event.fingerprint ?? null,
        eventType: event.eventType,
        status: event.status,
        payloadJson: JSON.stringify(event.payload ?? {}),
        createdAt: event.createdAt,
        deliveredAt: event.deliveredAt ?? null,
        error: event.error ?? null,
      });
    },

    listLocalEvents({ limit = 100, status = 'pending' } = {}) {
      return listLocalEvents.all({ limit, status }).map((row) => ({
        id: row.id,
        windowId: row.window_id,
        fingerprint: row.fingerprint,
        eventType: row.event_type,
        status: row.status,
        payload: parseJson(row.payload_json, {}),
        createdAt: row.created_at,
        deliveredAt: row.delivered_at,
        error: row.error,
      }));
    },

    markLocalEvent(id, { status, deliveredAt, error = null }) {
      const info = markLocalEvent.run({
        id,
        status,
        deliveredAt,
        error,
      });
      return info.changes > 0;
    },

    startScanRun({ startedAt, source = 'manual' }) {
      const info = startScanRun.run({ startedAt, source });
      return Number(info.lastInsertRowid);
    },

    finishScanRun(id, result) {
      finishScanRun.run({
        id,
        finishedAt: result.finishedAt,
        status: result.status,
        scannedCount: result.scannedCount ?? 0,
        matchedCount: result.matchedCount ?? 0,
        alertCount: result.alertCount ?? 0,
        error: result.error ?? null,
      });
    },

    getSetting(key) {
      const row = getSetting.get(key);
      return row ? parseJson(row.value_json) : null;
    },

    setSetting(key, value, updatedAt) {
      setSetting.run({
        key,
        valueJson: JSON.stringify(value),
        updatedAt,
      });
    },
  };
}

function backupTimestamp(now) {
  const match = String(now).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!match) {
    throw new Error(`Invalid backup timestamp: ${now}`);
  }
  return `${match[1]}${match[2]}${match[3]}-${match[4]}${match[5]}${match[6]}`;
}

async function backupDatabase({ dbPath, backupDir, now }) {
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `apple-monitor-${backupTimestamp(now)}.sqlite`);
  const db = openDatabase(dbPath, { migrate: false });
  try {
    await db.backup(backupPath);
  } finally {
    db.close();
  }
  return backupPath;
}

module.exports = {
  backupDatabase,
  createRepository,
  migrateDatabase,
  openDatabase,
};
