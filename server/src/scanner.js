const { canonicalizeAppleProductUrl, parseProductDetail, parseRefurbListings } = require('./apple');
const { loadConfig } = require('./config');
const { createRepository, openDatabase } = require('./db');
const {
  alertTelegramText,
  renderSmsTemplateParams,
  sendTelegramMessage,
  sendTencentSms,
  telegramSeparatorText,
} = require('./delivery');
const { buildOfferFingerprint, decideAvailabilityWindow, matchesAlertRule } = require('./rules');
const { nowUtc8Iso } = require('./time');

const USER_AGENT =
  'Mozilla/5.0 AppleMacMonitor/0.1 (+https://www.apple.com.cn/shop/refurbished/mac/mac-studio)';
const MANUAL_TELEGRAM_RETRY_SETTING = 'manual_telegram_retry';

async function fetchHtml(url, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();

  try {
    const response = await fetchImpl(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Apple request failed ${response.status}: ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
}

function ruleRepeatThreshold(rule) {
  return rule?.repeatAlertAfterSeconds === undefined ? null : rule.repeatAlertAfterSeconds;
}

function alertPayload({ offer, rule, windowRecord, transition, now }) {
  const productLabel = [offer.model, offer.memoryText || offer.memory, offer.storageText || offer.storage]
    .filter(Boolean)
    .join(' ');
  return {
    windowId: windowRecord.id,
    reason: transition.reason,
    ruleId: rule?.id ?? null,
    productLabel,
    productId: offer.productId,
    title: offer.title,
    price: offer.price?.amount ?? null,
    canonicalUrl: offer.canonicalUrl,
    url: offer.url ?? offer.canonicalUrl,
    detectedAt: now,
  };
}

function telegramOfferPayload(offer) {
  return {
    productId: offer.productId,
    title: offer.title,
    model: offer.model,
    memory: offer.memory,
    memoryText: offer.memoryText,
    storage: offer.storage,
    storageText: offer.storageText,
    price: offer.price ?? null,
    availabilityStatus: offer.availabilityStatus ?? 'unknown',
    canonicalUrl: offer.canonicalUrl,
    url: offer.url ?? offer.canonicalUrl,
  };
}

function manualOfferKey(offer) {
  return offer?.canonicalUrl || offer?.url || offer?.productId || '';
}

function mergeManualOffers(...groups) {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    for (const offer of group || []) {
      const compact = telegramOfferPayload(offer);
      const key = manualOfferKey(compact);
      if (key && seen.has(key)) {
        continue;
      }
      if (key) {
        seen.add(key);
      }
      merged.push(compact);
    }
  }
  return merged;
}

function compactAlertResult(result) {
  return {
    fingerprint: result.fingerprint ?? null,
    windowId: result.windowId ?? null,
    canonicalUrl: result.canonicalUrl ?? null,
  };
}

function alertResultKey(result) {
  return `${result.windowId ?? ''}:${result.fingerprint ?? ''}:${result.canonicalUrl ?? ''}`;
}

function mergeAlertResults(...groups) {
  const merged = [];
  const seen = new Set();
  for (const group of groups) {
    for (const result of group || []) {
      const compact = compactAlertResult(result);
      const key = alertResultKey(compact);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      merged.push(compact);
    }
  }
  return merged;
}

function pendingManualTelegramRetry(repo) {
  const retry = repo.getSetting?.(MANUAL_TELEGRAM_RETRY_SETTING);
  return {
    alertResults: Array.isArray(retry?.alertResults) ? retry.alertResults.map(compactAlertResult) : [],
    manualOffers: Array.isArray(retry?.manualOffers) ? retry.manualOffers.map(telegramOfferPayload) : [],
  };
}

function saveManualTelegramRetry(repo, alertResults, manualOffers, now) {
  repo.setSetting?.(
    MANUAL_TELEGRAM_RETRY_SETTING,
    {
      failedAt: now,
      alertResults: alertResults.map(compactAlertResult),
      manualOffers: manualOffers.map(telegramOfferPayload),
    },
    now,
  );
}

function clearManualTelegramRetry(repo, now) {
  repo.setSetting?.(MANUAL_TELEGRAM_RETRY_SETTING, null, now);
}

async function recordDeliveries({
  repo,
  config,
  offer,
  rule,
  fingerprint,
  windowRecord,
  transition,
  now,
  fetchImpl,
  telegramDeliveryEnabled = true,
}) {
  const payload = alertPayload({ offer, rule, windowRecord, transition, now });
  let eventsRecorded = 0;
  const realNotificationStatuses = [];

  if (config.delivery?.localEventsEnabled !== false) {
    repo.recordLocalEvent({
      windowId: windowRecord.id,
      fingerprint,
      eventType: 'availability_alert',
      status: 'pending',
      payload,
      createdAt: now,
    });
    repo.incrementWindowAlert(windowRecord.id, { channel: 'local', alertedAt: now });
    eventsRecorded += 1;
  }

  let smsStatus = config.delivery?.smsDryRun === false ? 'pending' : 'dry_run';
  let smsSentAt = null;
  let smsError = null;
  if (config.delivery?.smsDryRun === false) {
    try {
      await sendTencentSms({
        sms: config.sms,
        templateParams: renderSmsTemplateParams(config.sms?.templateParams ?? [], payload),
        fetchImpl,
        timeoutMs: config.delivery?.requestTimeoutMs,
      });
      smsStatus = 'sent';
      smsSentAt = now;
    } catch (error) {
      smsStatus = 'failed';
      smsError = error.message;
    }
    realNotificationStatuses.push(smsStatus);
  }

  repo.recordSmsEvent({
    windowId: windowRecord.id,
    fingerprint,
    idempotencyKey: `${windowRecord.id}:sms:${now}`,
    status: smsStatus,
    templateId: config.sms?.templateId ?? null,
    phoneNumbers: config.sms?.phoneNumbers ?? [],
    payload: {
      productLabel: payload.productLabel,
      price: payload.price,
      productId: payload.productId,
      windowId: payload.windowId,
    },
    createdAt: now,
    sentAt: smsSentAt,
    error: smsError,
  });
  repo.incrementWindowAlert(windowRecord.id, { channel: 'sms', alertedAt: now });
  eventsRecorded += 1;

  if (telegramDeliveryEnabled && config.delivery?.telegramEnabled !== false) {
    let telegramStatus = 'dry_run';
    let telegramSentAt = null;
    let telegramError = null;
    const telegramAttempted = Boolean(config.telegram?.botToken && config.telegram?.chatId);
    if (telegramAttempted) {
      try {
        await sendTelegramMessage({
          telegram: config.telegram,
          text: alertTelegramText(payload),
          fetchImpl,
          parseMode: 'HTML',
          timeoutMs: config.delivery?.requestTimeoutMs,
        });
        telegramStatus = 'sent';
        telegramSentAt = now;
      } catch (error) {
        telegramStatus = 'failed';
        telegramError = error.message;
      }
      realNotificationStatuses.push(telegramStatus);
    }

    repo.recordTelegramEvent({
      windowId: windowRecord.id,
      fingerprint,
      idempotencyKey: `${windowRecord.id}:telegram:${now}`,
      status: telegramStatus,
      chatId: config.telegram?.chatId ?? null,
      payload,
      createdAt: now,
      sentAt: telegramSentAt,
      error: telegramError,
    });
    repo.incrementWindowAlert(windowRecord.id, { channel: 'telegram', alertedAt: now });
    eventsRecorded += 1;
  }

  return {
    eventsRecorded,
    notificationFailed:
      realNotificationStatuses.length > 0 && realNotificationStatuses.every((status) => status === 'failed'),
  };
}

function telegramSeparatorEnabled(config) {
  return config.delivery?.telegramEnabled !== false && config.telegram?.separatorEnabled !== false;
}

function telegramSeparatorIntervalSeconds(config) {
  return Math.max(1, Number(config.telegram?.separatorIntervalSeconds ?? 21600));
}

function secondsBetweenTimestamps(start, end) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }
  return (endMs - startMs) / 1000;
}

async function recordTelegramSeparator({ repo, config, now, fetchImpl, direction, reason, windowId = null, fingerprint = null }) {
  if (!telegramSeparatorEnabled(config)) {
    return 0;
  }

  const payload = {
    reason,
    direction,
    detectedAt: now,
  };
  let telegramStatus = 'dry_run';
  let telegramSentAt = null;
  let telegramError = null;
  if (config.telegram?.botToken && config.telegram?.chatId) {
    try {
      await sendTelegramMessage({
        telegram: config.telegram,
        text: telegramSeparatorText({ detectedAt: now, direction }),
        fetchImpl,
        parseMode: 'HTML',
        timeoutMs: config.delivery?.requestTimeoutMs,
      });
      telegramStatus = 'sent';
      telegramSentAt = now;
    } catch (error) {
      telegramStatus = 'failed';
      telegramError = error.message;
    }
  }

  repo.recordTelegramEvent({
    windowId,
    fingerprint,
    idempotencyKey: `telegram-separator:${direction}:${reason}:${now}`,
    status: telegramStatus,
    chatId: config.telegram?.chatId ?? null,
    payload,
    createdAt: now,
    sentAt: telegramSentAt,
    error: telegramError,
  });
  if (telegramStatus !== 'failed') {
    repo.setSetting?.('telegram_separator_last_at', now, now);
  }
  return 1;
}

async function recordPeriodicTelegramSeparator({ repo, config, now, fetchImpl }) {
  if (!telegramSeparatorEnabled(config)) {
    return 0;
  }
  const lastAt = repo.getSetting?.('telegram_separator_last_at');
  if (!lastAt) {
    return 0;
  }
  const elapsedSeconds = secondsBetweenTimestamps(lastAt, now);
  if (elapsedSeconds === null || elapsedSeconds < telegramSeparatorIntervalSeconds(config)) {
    return 0;
  }
  return recordTelegramSeparator({
    repo,
    config,
    now,
    fetchImpl,
    direction: 'down',
    reason: 'periodic_separator',
  });
}

async function recordManualTelegramSummary({ repo, config, manualOffers, alertResults, now, fetchImpl }) {
  if (config.delivery?.telegramEnabled === false || alertResults.length === 0 || manualOffers.length === 0) {
    return { eventsRecorded: 0, status: 'skipped' };
  }

  const payload = {
    reason: 'manual_monitor_summary',
    detectedAt: now,
    manualOffers: manualOffers.map(telegramOfferPayload),
  };
  let telegramStatus = 'dry_run';
  let telegramSentAt = null;
  let telegramError = null;
  if (config.telegram?.botToken && config.telegram?.chatId) {
    try {
      await sendTelegramMessage({
        telegram: config.telegram,
        text: alertTelegramText(payload),
        fetchImpl,
        parseMode: 'HTML',
        timeoutMs: config.delivery?.requestTimeoutMs,
      });
      telegramStatus = 'sent';
      telegramSentAt = now;
    } catch (error) {
      telegramStatus = 'failed';
      telegramError = error.message;
    }
  }

  const firstAlert = alertResults.find((result) => result.windowId) ?? alertResults[0];
  repo.recordTelegramEvent({
    windowId: firstAlert.windowId ?? null,
    fingerprint: firstAlert.fingerprint ?? null,
    idempotencyKey: `manual-monitor-summary:${firstAlert.windowId ?? firstAlert.fingerprint}:${now}`,
    status: telegramStatus,
    chatId: config.telegram?.chatId ?? null,
    payload,
    createdAt: now,
    sentAt: telegramSentAt,
    error: telegramError,
  });

  if (telegramStatus !== 'failed') {
    const windowIds = new Set();
    for (const result of alertResults) {
      if (!result.windowId || windowIds.has(result.windowId)) {
        continue;
      }
      repo.incrementWindowAlert(result.windowId, { channel: 'telegram', alertedAt: now });
      windowIds.add(result.windowId);
    }
  }

  const separatorEvents =
    telegramStatus === 'failed'
      ? 0
      : await recordTelegramSeparator({
          repo,
          config,
          now,
          fetchImpl,
          direction: 'up',
          reason: 'after_alert',
          windowId: firstAlert.windowId ?? null,
          fingerprint: firstAlert.fingerprint ?? null,
        });

  return { eventsRecorded: 1 + separatorEvents, status: telegramStatus };
}

function resetAlertForRetry({ repo, canonicalUrl, windowId, now, closeReason }) {
  const state = repo.getOfferState?.(canonicalUrl);
  if (state) {
    repo.saveOfferState(canonicalUrl, {
      ...state,
      windowOpen: false,
      lastAlertAt: null,
      lastSeenAt: now,
    });
  }
  if (windowId) {
    repo.closeAvailabilityWindow?.(windowId, { closedAt: now, closeReason });
  }
}

function closeOpenWindowIfNeeded({ repo, previous, offer, fingerprint, now }) {
  if (offer.availabilityStatus === 'available') {
    return null;
  }
  const openWindow = repo.findOpenAvailabilityWindow({
    canonicalUrl: offer.canonicalUrl,
    fingerprint: previous?.fingerprint ?? fingerprint,
  });
  if (!openWindow) {
    return null;
  }
  return repo.closeAvailabilityWindow(openWindow.id, {
    closedAt: now,
    closeReason: offer.availabilityStatus ?? 'unavailable',
  });
}

function selectMatchingRule(offer, rules) {
  return rules.find((rule) => matchesAlertRule(offer, rule)) ?? null;
}

async function processOffer({
  repo,
  config,
  offer,
  now,
  fetchImpl = fetch,
  telegramDeliveryEnabled = true,
  retryOnNotificationFailure = true,
}) {
  const fingerprint = buildOfferFingerprint(offer);
  repo.upsertOfferSnapshot(offer, { fingerprint, seenAt: now });

  const previous = repo.getOfferState(offer.canonicalUrl);
  const rules = config.alerts?.rules ?? [];
  const matchingRule = selectMatchingRule(offer, rules);
  const transition = decideAvailabilityWindow({
    previous,
    offer,
    now,
    repeatAlertAfterSeconds: matchingRule ? ruleRepeatThreshold(matchingRule) : null,
  });

  if (!matchingRule || !transition.shouldAlert) {
    repo.saveOfferState(offer.canonicalUrl, transition.nextState);
    closeOpenWindowIfNeeded({ repo, previous, offer, fingerprint, now });
    return {
      fingerprint,
      matched: Boolean(matchingRule),
      alerted: false,
      eventsRecorded: 0,
      reason: transition.reason,
    };
  }

  let windowRecord = repo.findOpenAvailabilityWindow({
    canonicalUrl: offer.canonicalUrl,
    fingerprint,
  });
  if (!windowRecord) {
    windowRecord = repo.openAvailabilityWindow({
      fingerprint,
      canonicalUrl: offer.canonicalUrl,
      productId: offer.productId,
      openedAt: now,
      openReason: transition.reason,
    });
  }

  const delivery = await recordDeliveries({
    repo,
    config,
    offer,
    rule: matchingRule,
    fingerprint,
    windowRecord,
    transition,
    now,
    fetchImpl,
    telegramDeliveryEnabled,
  });
  if (delivery.notificationFailed && retryOnNotificationFailure) {
    resetAlertForRetry({
      repo,
      canonicalUrl: offer.canonicalUrl,
      windowId: windowRecord.id,
      now,
      closeReason: 'notification_failed',
    });
  } else {
    repo.saveOfferState(offer.canonicalUrl, transition.nextState);
  }

  return {
    fingerprint,
    matched: true,
    alerted: true,
    eventsRecorded: delivery.eventsRecorded,
    reason: transition.reason,
    windowId: windowRecord.id,
    canonicalUrl: offer.canonicalUrl,
  };
}

async function scanListingUrl({ url, config, fetchImpl }) {
  const html = await fetchHtml(url, {
    fetchImpl,
    timeoutMs: config.apple?.requestTimeoutMs,
  });
  return parseRefurbListings(html, {
    baseUrl: 'https://www.apple.com.cn',
  });
}

async function scanManualUrl({ url, config, fetchImpl }) {
  const html = await fetchHtml(url, {
    fetchImpl,
    timeoutMs: config.apple?.requestTimeoutMs,
  });
  const detail = parseProductDetail(html, {
    url: canonicalizeAppleProductUrl(url, 'https://www.apple.com.cn'),
    baseUrl: 'https://www.apple.com.cn',
  });
  return [detail];
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);

  async function runWorker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, runWorker));
  return results;
}

function ensureCanonicalOfferUrl(offer) {
  if (!offer.canonicalUrl && offer.url) {
    offer.canonicalUrl = canonicalizeAppleProductUrl(offer.url, 'https://www.apple.com.cn');
  }
  return offer;
}

function scanItemKey(item) {
  const offer = ensureCanonicalOfferUrl(item.offer);
  return offer.canonicalUrl || offer.url || offer.productId || null;
}

function dedupeScanItemsPreferManual(scanItems) {
  const byKey = new Map();
  const passthrough = [];

  for (const item of scanItems) {
    const key = scanItemKey(item);
    if (!key) {
      passthrough.push(item);
      continue;
    }
    const existing = byKey.get(key);
    if (!existing || (item.isManual && !existing.isManual)) {
      byKey.set(key, item);
    }
  }

  return [...byKey.values(), ...passthrough];
}

async function collectScanItems({ urls, concurrency, scanner, isManual, summary }) {
  const results = await mapWithConcurrency(urls, concurrency, async (url) => {
    try {
      const offers = await scanner(url);
      return { offers, url };
    } catch (error) {
      return { error, url };
    }
  });

  const scanItems = [];
  for (const result of results) {
    if (result.error) {
      summary.errors.push({ url: result.url, message: result.error.message });
      continue;
    }
    scanItems.push(...result.offers.map((offer) => ({ offer, isManual })));
  }
  return scanItems;
}

async function scanOnce({ config, repo, fetchImpl = fetch, now = nowUtc8Iso(), source = 'manual' }) {
  const runId = repo.startScanRun?.({ startedAt: now, source });
  const summary = {
    startedAt: now,
    finishedAt: now,
    source,
    scannedOffers: 0,
    matchedOffers: 0,
    alertsCreated: 0,
    deliveryEvents: 0,
    errors: [],
  };

  try {
    const concurrency = Math.max(1, Number(config.apple?.scanConcurrency ?? 1));
    const listingUrls = config.apple?.listingEnabled === false ? [] : config.apple?.listingUrls ?? [];
    const listingItems = await collectScanItems({
      urls: listingUrls,
      concurrency,
      scanner: (url) => scanListingUrl({ url, config, fetchImpl }),
      isManual: false,
      summary,
    });
    const manualItems = await collectScanItems({
      urls: config.apple?.manualUrls ?? [],
      concurrency,
      scanner: (url) => scanManualUrl({ url, config, fetchImpl }),
      isManual: true,
      summary,
    });
    const scanItems = dedupeScanItemsPreferManual([...listingItems, ...manualItems]);
    const manualTelegramSummaryCanConfirm =
      config.delivery?.telegramEnabled !== false && Boolean(config.telegram?.botToken && config.telegram?.chatId);

    const manualOffers = [];
    const manualAlertResults = [];

    for (const item of scanItems) {
      const offer = ensureCanonicalOfferUrl(item.offer);
      if (!offer.canonicalUrl) {
        summary.errors.push({ productId: offer.productId, message: 'missing canonicalUrl' });
        continue;
      }
      if (item.isManual) {
        manualOffers.push(offer);
      }

      summary.scannedOffers += 1;
      const result = await processOffer({
        repo,
        config,
        offer,
        now,
        fetchImpl,
        telegramDeliveryEnabled: false,
        retryOnNotificationFailure: !(item.isManual && manualTelegramSummaryCanConfirm),
      });
      if (result.matched) {
        summary.matchedOffers += 1;
      }
      if (result.alerted) {
        summary.alertsCreated += 1;
        summary.deliveryEvents += result.eventsRecorded;
        if (item.isManual) {
          manualAlertResults.push(result);
        }
      }
    }

    const pendingManualRetry = pendingManualTelegramRetry(repo);
    const manualTelegramAlertResults = mergeAlertResults(pendingManualRetry.alertResults, manualAlertResults);
    const manualTelegramOffers = mergeManualOffers(pendingManualRetry.manualOffers, manualOffers);
    const manualTelegramSummary = await recordManualTelegramSummary({
      repo,
      config,
      manualOffers: manualTelegramOffers,
      alertResults: manualTelegramAlertResults,
      now,
      fetchImpl,
    });
    summary.deliveryEvents += manualTelegramSummary.eventsRecorded;
    if (manualTelegramSummary.status === 'failed') {
      saveManualTelegramRetry(repo, manualTelegramAlertResults, manualTelegramOffers, now);
    } else if (pendingManualRetry.alertResults.length > 0 && manualTelegramSummary.status !== 'skipped') {
      clearManualTelegramRetry(repo, now);
    }
    summary.deliveryEvents += await recordPeriodicTelegramSeparator({
      repo,
      config,
      now,
      fetchImpl,
    });

    repo.finishScanRun?.(runId, {
      finishedAt: now,
      status: summary.errors.length > 0 ? 'completed_with_errors' : 'completed',
      scannedCount: summary.scannedOffers,
      matchedCount: summary.matchedOffers,
      alertCount: summary.alertsCreated,
      error: summary.errors.length > 0 ? JSON.stringify(summary.errors) : null,
    });
    return summary;
  } catch (error) {
    repo.finishScanRun?.(runId, {
      finishedAt: now,
      status: 'failed',
      scannedCount: summary.scannedOffers,
      matchedCount: summary.matchedOffers,
      alertCount: summary.alertsCreated,
      error: error.stack || error.message,
    });
    throw error;
  }
}

async function main() {
  const config = loadConfig();
  const db = openDatabase(config.databasePath);
  const repo = createRepository(db);
  try {
    const summary = await scanOnce({
      config,
      repo,
      source: process.argv.includes('--once') ? 'manual_once' : 'manual',
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  fetchHtml,
  processOffer,
  scanOnce,
};
