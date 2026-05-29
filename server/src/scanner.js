const crypto = require('node:crypto');

const { canonicalizeAppleProductUrl, parseProductDetail, parseRefurbListings } = require('./apple');
const { loadConfig } = require('./config');
const { createRepository, openDatabase } = require('./db');
const {
  alertNtfyText,
  alertTelegramText,
  renderSmsTemplateParams,
  sendNtfyMessage,
  sendTelegramMessage,
  sendTencentSms,
  telegramSeparatorText,
} = require('./delivery');
const { buildOfferFingerprint, decideAvailabilityWindow, matchesAlertRule } = require('./rules');
const { nowUtc8Iso, toUtc8Iso } = require('./time');

const USER_AGENT =
  'Mozilla/5.0 AppleMacMonitor/0.1 (+https://www.apple.com.cn/shop/refurbished/mac/mac-studio)';
const MANUAL_TELEGRAM_RETRY_SETTING = 'manual_telegram_retry';
const MONITOR_HEALTH_FAILURE_SETTING = 'monitor_health_consecutive_failures';
const MONITOR_HEALTH_LAST_ALERT_SETTING = 'monitor_health_last_alert_at';
const NTFY_SEPARATOR_LAST_AT_SETTING = 'ntfy_separator_last_at';

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

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

function telegramDeliveryConfigured(config) {
  return config.delivery?.telegramEnabled !== false && Boolean(config.telegram?.botToken && config.telegram?.chatId);
}

function ntfyDeliveryEnabled(config) {
  return config.delivery?.ntfyEnabled === true;
}

function ntfyDeliveryConfigured(config) {
  return ntfyDeliveryEnabled(config) && Boolean(config.ntfy?.baseUrl && config.ntfy?.topic);
}

function manualNotificationCanConfirm(config) {
  return telegramDeliveryConfigured(config) || ntfyDeliveryConfigured(config);
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
  ntfyDeliveryEnabled: ntfyDirectDeliveryEnabled = true,
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

  if (ntfyDirectDeliveryEnabled && ntfyDeliveryEnabled(config)) {
    let ntfyStatus = 'dry_run';
    let ntfySentAt = null;
    let ntfyError = null;
    const ntfyAttempted = ntfyDeliveryConfigured(config);
    if (ntfyAttempted) {
      try {
        await sendNtfyMessage({
          ntfy: config.ntfy,
          title: 'Apple monitor',
          message: alertNtfyText(payload),
          fetchImpl,
          timeoutMs: config.delivery?.requestTimeoutMs,
        });
        ntfyStatus = 'sent';
        ntfySentAt = now;
      } catch (error) {
        ntfyStatus = 'failed';
        ntfyError = error.message;
      }
      realNotificationStatuses.push(ntfyStatus);
    }

    repo.recordNtfyEvent({
      windowId: windowRecord.id,
      fingerprint,
      idempotencyKey: `${windowRecord.id}:ntfy:${now}`,
      status: ntfyStatus,
      topic: config.ntfy?.topic ?? null,
      payload,
      createdAt: now,
      sentAt: ntfySentAt,
      error: ntfyError,
    });
    repo.incrementWindowAlert(windowRecord.id, { channel: 'ntfy', alertedAt: now });
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

function ntfySeparatorText({ detectedAt, direction }) {
  const arrow = direction === 'up' ? 'UP' : 'DOWN';
  return [
    'Apple monitor scheduled check-in',
    `Time: ${detectedAt}`,
    `Direction: ${arrow}`,
  ].join('\n');
}

async function recordNtfySeparator({ repo, config, now, fetchImpl, direction, reason }) {
  if (!ntfyDeliveryEnabled(config)) {
    return 0;
  }

  const payload = {
    reason,
    direction,
    detectedAt: now,
  };
  let ntfyStatus = 'dry_run';
  let ntfySentAt = null;
  let ntfyError = null;
  if (ntfyDeliveryConfigured(config)) {
    try {
      await sendNtfyMessage({
        ntfy: config.ntfy,
        title: 'Apple monitor check-in',
        message: ntfySeparatorText({ detectedAt: now, direction }),
        fetchImpl,
        timeoutMs: config.delivery?.requestTimeoutMs,
      });
      ntfyStatus = 'sent';
      ntfySentAt = now;
    } catch (error) {
      ntfyStatus = 'failed';
      ntfyError = error.message;
    }
  }

  repo.recordNtfyEvent({
    windowId: null,
    fingerprint: 'ntfy-separator',
    idempotencyKey: `ntfy-separator:${direction}:${reason}:${now}`,
    status: ntfyStatus,
    topic: config.ntfy?.topic ?? null,
    payload,
    createdAt: now,
    sentAt: ntfySentAt,
    error: ntfyError,
  });
  if (ntfyStatus !== 'failed') {
    repo.setSetting?.(NTFY_SEPARATOR_LAST_AT_SETTING, now, now);
  }
  return 1;
}

async function recordPeriodicNtfySeparator({ repo, config, now, fetchImpl }) {
  if (!ntfyDeliveryEnabled(config) || config.telegram?.separatorEnabled === false) {
    return 0;
  }
  const lastAt = repo.getSetting?.(NTFY_SEPARATOR_LAST_AT_SETTING);
  if (lastAt) {
    const elapsedSeconds = secondsBetweenTimestamps(lastAt, now);
    if (elapsedSeconds !== null && elapsedSeconds < telegramSeparatorIntervalSeconds(config)) {
      return 0;
    }
  }
  return recordNtfySeparator({
    repo,
    config,
    now,
    fetchImpl,
    direction: 'down',
    reason: 'periodic_separator',
  });
}

function healthAlertsEnabled(config) {
  return config.observability?.healthAlertsEnabled === true;
}

function scanHealthReasons(summary, config) {
  const reasons = [];
  const minScannedOffers = Math.max(0, Number(config.observability?.healthAlertMinScannedOffers ?? 1));
  if (summary.errors.length > 0) {
    reasons.push(`errors:${summary.errors.length}`);
  }
  if (summary.scannedOffers < minScannedOffers) {
    reasons.push(`scanned_offers_below_minimum:${summary.scannedOffers}<${minScannedOffers}`);
  }
  return reasons;
}

function monitorHealthAlertText({ summary, reasons, consecutiveFailures, now }) {
  const lines = [
    'Apple monitor health warning',
    `detected at: ${now}`,
    `consecutive unhealthy scans: ${consecutiveFailures}`,
    `scanned offers: ${summary.scannedOffers}`,
    `matched offers: ${summary.matchedOffers}`,
    `alerts created: ${summary.alertsCreated}`,
    '',
    'reasons:',
    ...reasons.map((reason) => `- ${reason}`),
  ];

  if (summary.errors.length > 0) {
    lines.push('', 'errors:');
    for (const error of summary.errors.slice(0, 5)) {
      lines.push(`- ${error.url || error.productId || 'scan'}: ${error.message}`);
    }
  }

  return lines.join('\n');
}

function healthAlertCooldownActive({ repo, config, now }) {
  const lastAlertAt = repo.getSetting?.(MONITOR_HEALTH_LAST_ALERT_SETTING);
  if (!lastAlertAt) {
    return false;
  }
  const elapsedSeconds = secondsBetweenTimestamps(lastAlertAt, now);
  if (elapsedSeconds === null) {
    return false;
  }
  return elapsedSeconds < Math.max(1, Number(config.observability?.healthAlertCooldownSeconds ?? 1800));
}

async function recordMonitorHealthAlert({ repo, config, summary, reasons, consecutiveFailures, now, fetchImpl }) {
  const payload = {
    reason: 'monitor_health_warning',
    detectedAt: now,
    consecutiveFailures,
    scannedOffers: summary.scannedOffers,
    matchedOffers: summary.matchedOffers,
    alertsCreated: summary.alertsCreated,
    reasons,
    errors: summary.errors,
  };
  const text = monitorHealthAlertText({ summary, reasons, consecutiveFailures, now });
  let eventsRecorded = 0;
  const realNotificationStatuses = [];

  if (config.delivery?.telegramEnabled !== false) {
    let telegramStatus = 'dry_run';
    let telegramSentAt = null;
    let telegramError = null;
    if (telegramDeliveryConfigured(config)) {
      try {
        await sendTelegramMessage({
          telegram: config.telegram,
          text,
          fetchImpl,
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
      windowId: null,
      fingerprint: 'monitor-health',
      idempotencyKey: `monitor-health:telegram:${now}`,
      status: telegramStatus,
      chatId: config.telegram?.chatId ?? null,
      payload,
      createdAt: now,
      sentAt: telegramSentAt,
      error: telegramError,
    });
    eventsRecorded += 1;
  }

  if (ntfyDeliveryEnabled(config)) {
    let ntfyStatus = 'dry_run';
    let ntfySentAt = null;
    let ntfyError = null;
    if (ntfyDeliveryConfigured(config)) {
      try {
        await sendNtfyMessage({
          ntfy: config.ntfy,
          title: 'Apple monitor health',
          message: text,
          fetchImpl,
          timeoutMs: config.delivery?.requestTimeoutMs,
        });
        ntfyStatus = 'sent';
        ntfySentAt = now;
      } catch (error) {
        ntfyStatus = 'failed';
        ntfyError = error.message;
      }
      realNotificationStatuses.push(ntfyStatus);
    }

    repo.recordNtfyEvent({
      windowId: null,
      fingerprint: 'monitor-health',
      idempotencyKey: `monitor-health:ntfy:${now}`,
      status: ntfyStatus,
      topic: config.ntfy?.topic ?? null,
      payload,
      createdAt: now,
      sentAt: ntfySentAt,
      error: ntfyError,
    });
    eventsRecorded += 1;
  }

  const anyRealNotificationSent = realNotificationStatuses.some((status) => status === 'sent');
  const noRealNotificationAttempted = realNotificationStatuses.length === 0;
  if (anyRealNotificationSent || (noRealNotificationAttempted && eventsRecorded > 0)) {
    repo.setSetting?.(MONITOR_HEALTH_LAST_ALERT_SETTING, now, now);
  }
  return eventsRecorded;
}

async function recordScanHealth({ repo, config, summary, now, fetchImpl }) {
  if (!healthAlertsEnabled(config)) {
    return 0;
  }

  const reasons = scanHealthReasons(summary, config);
  if (reasons.length === 0) {
    repo.setSetting?.(
      MONITOR_HEALTH_FAILURE_SETTING,
      { count: 0, lastHealthyAt: now, reasons: [] },
      now,
    );
    return 0;
  }

  const previous = repo.getSetting?.(MONITOR_HEALTH_FAILURE_SETTING);
  const consecutiveFailures = Number(previous?.count ?? 0) + 1;
  repo.setSetting?.(
    MONITOR_HEALTH_FAILURE_SETTING,
    {
      count: consecutiveFailures,
      lastFailedAt: now,
      reasons,
    },
    now,
  );

  const threshold = Math.max(1, Number(config.observability?.healthAlertConsecutiveFailures ?? 3));
  if (consecutiveFailures < threshold || healthAlertCooldownActive({ repo, config, now })) {
    return 0;
  }

  return recordMonitorHealthAlert({
    repo,
    config,
    summary,
    reasons,
    consecutiveFailures,
    now,
    fetchImpl,
  });
}

async function recordManualTelegramSummary({ repo, config, manualOffers, alertResults, now, fetchImpl }) {
  if (alertResults.length === 0 || manualOffers.length === 0) {
    return { eventsRecorded: 0, status: 'skipped' };
  }

  const payload = {
    reason: 'manual_monitor_summary',
    detectedAt: now,
    manualOffers: manualOffers.map(telegramOfferPayload),
  };
  const firstAlert = alertResults.find((result) => result.windowId) ?? alertResults[0];
  const baseIdempotencyKey = `manual-monitor-summary:${firstAlert.windowId ?? firstAlert.fingerprint}:${now}`;
  let eventsRecorded = 0;
  let telegramStatus = null;
  const realNotificationStatuses = [];

  if (config.delivery?.telegramEnabled !== false) {
    telegramStatus = 'dry_run';
    let telegramSentAt = null;
    let telegramError = null;
    const telegramAttempted = telegramDeliveryConfigured(config);
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
      windowId: firstAlert.windowId ?? null,
      fingerprint: firstAlert.fingerprint ?? null,
      idempotencyKey: baseIdempotencyKey,
      status: telegramStatus,
      chatId: config.telegram?.chatId ?? null,
      payload,
      createdAt: now,
      sentAt: telegramSentAt,
      error: telegramError,
    });
    eventsRecorded += 1;

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
  }

  if (ntfyDeliveryEnabled(config)) {
    let ntfyStatus = 'dry_run';
    let ntfySentAt = null;
    let ntfyError = null;
    const ntfyAttempted = ntfyDeliveryConfigured(config);
    if (ntfyAttempted) {
      try {
        await sendNtfyMessage({
          ntfy: config.ntfy,
          title: 'Apple monitor',
          message: alertNtfyText(payload),
          fetchImpl,
          timeoutMs: config.delivery?.requestTimeoutMs,
        });
        ntfyStatus = 'sent';
        ntfySentAt = now;
      } catch (error) {
        ntfyStatus = 'failed';
        ntfyError = error.message;
      }
      realNotificationStatuses.push(ntfyStatus);
    }

    repo.recordNtfyEvent({
      windowId: firstAlert.windowId ?? null,
      fingerprint: firstAlert.fingerprint ?? null,
      idempotencyKey: `${baseIdempotencyKey}:ntfy`,
      status: ntfyStatus,
      topic: config.ntfy?.topic ?? null,
      payload,
      createdAt: now,
      sentAt: ntfySentAt,
      error: ntfyError,
    });
    eventsRecorded += 1;

    if (ntfyStatus !== 'failed') {
      const windowIds = new Set();
      for (const result of alertResults) {
        if (!result.windowId || windowIds.has(result.windowId)) {
          continue;
        }
        repo.incrementWindowAlert(result.windowId, { channel: 'ntfy', alertedAt: now });
        windowIds.add(result.windowId);
      }
    }
  }

  if (eventsRecorded === 0) {
    return { eventsRecorded: 0, status: 'skipped' };
  }

  const separatorEvents =
    telegramStatus === null || telegramStatus === 'failed'
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

  const allRealNotificationsFailed =
    realNotificationStatuses.length > 0 && realNotificationStatuses.every((status) => status === 'failed');
  const anyRealNotificationSent = realNotificationStatuses.some((status) => status !== 'failed');
  const status = allRealNotificationsFailed ? 'failed' : anyRealNotificationSent ? 'sent' : 'dry_run';
  return { eventsRecorded: eventsRecorded + separatorEvents, status };
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

function unmatchedOfferState(transition) {
  return {
    ...transition.nextState,
    windowOpen: false,
    lastAlertAt: null,
  };
}

function promoteExistingAvailableWithoutWindow({ repo, offer, fingerprint, previous, transition, now }) {
  if (
    transition.shouldAlert ||
    offer.availabilityStatus !== 'available' ||
    previous?.windowOpen !== true ||
    repo.findOpenAvailabilityWindow({
      canonicalUrl: offer.canonicalUrl,
      fingerprint,
    })
  ) {
    return transition;
  }

  return {
    ...transition,
    shouldAlert: true,
    reason: 'existing_available_without_alert_window',
    nextState: {
      ...transition.nextState,
      windowOpen: true,
      lastAlertAt: now,
    },
  };
}

async function processOffer({
  repo,
  config,
  offer,
  now,
  fetchImpl = fetch,
  telegramDeliveryEnabled = true,
  ntfyDeliveryEnabled: ntfyDirectDeliveryEnabled = true,
  retryOnNotificationFailure = true,
  bypassAlertRules = false,
}) {
  const fingerprint = buildOfferFingerprint(offer);
  repo.upsertOfferSnapshot(offer, { fingerprint, seenAt: now });

  const previous = repo.getOfferState(offer.canonicalUrl);
  const rules = config.alerts?.rules ?? [];
  const matchingRule = selectMatchingRule(offer, rules);
  const effectiveRule = matchingRule || (bypassAlertRules ? { id: 'manual-monitor-priority' } : null);
  const transition = decideAvailabilityWindow({
    previous,
    offer,
    now,
    repeatAlertAfterSeconds: effectiveRule ? ruleRepeatThreshold(effectiveRule) : null,
  });
  const effectiveTransition = effectiveRule
    ? promoteExistingAvailableWithoutWindow({ repo, offer, fingerprint, previous, transition, now })
    : transition;

  if (!effectiveRule || !effectiveTransition.shouldAlert) {
    repo.saveOfferState(
      offer.canonicalUrl,
      effectiveRule ? effectiveTransition.nextState : unmatchedOfferState(effectiveTransition),
    );
    closeOpenWindowIfNeeded({ repo, previous, offer, fingerprint, now });
    return {
      fingerprint,
      matched: Boolean(effectiveRule),
      alerted: false,
      eventsRecorded: 0,
      reason: effectiveTransition.reason,
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
      openReason: effectiveTransition.reason,
    });
  }

  const delivery = await recordDeliveries({
    repo,
    config,
    offer,
    rule: effectiveRule,
    fingerprint,
    windowRecord,
    transition: effectiveTransition,
    now,
    fetchImpl,
    telegramDeliveryEnabled,
    ntfyDeliveryEnabled: ntfyDirectDeliveryEnabled,
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
    repo.saveOfferState(offer.canonicalUrl, effectiveTransition.nextState);
  }

  return {
    fingerprint,
    matched: true,
    alerted: true,
    eventsRecorded: delivery.eventsRecorded,
    reason: effectiveTransition.reason,
    windowId: windowRecord.id,
    canonicalUrl: offer.canonicalUrl,
  };
}

async function scanListingUrl({ url, config, fetchImpl }) {
  const html = await fetchHtml(url, {
    fetchImpl,
    timeoutMs: config.apple?.requestTimeoutMs,
  });
  const htmlSha256 = sha256Hex(html);
  return parseRefurbListings(html, {
    baseUrl: 'https://www.apple.com.cn',
  }).map((offer) => ({
    ...offer,
    scanEvidence: {
      sourceType: 'listing',
      sourceUrl: url,
      htmlSha256,
      listingTilePresent: true,
    },
  }));
}

async function scanManualUrl({ url, config, fetchImpl }) {
  const html = await fetchHtml(url, {
    fetchImpl,
    timeoutMs: config.apple?.requestTimeoutMs,
  });
  return [detailOfferFromHtml({ html, url, sourceType: 'detail' })];
}

function detailOfferFromHtml({ html, url, sourceType, discoveredFrom = null }) {
  const detail = parseProductDetail(html, {
    url: canonicalizeAppleProductUrl(url, 'https://www.apple.com.cn'),
    baseUrl: 'https://www.apple.com.cn',
  });

  return {
    ...detail,
    scanEvidence: {
      sourceType,
      sourceUrl: url,
      htmlSha256: sha256Hex(html),
      listingTilePresent: false,
      discoveredFrom,
    },
  };
}

async function scanDynamicVariantUrl({ url, config, fetchImpl, discoveredFrom }) {
  const html = await fetchHtml(url, {
    fetchImpl,
    timeoutMs: config.apple?.requestTimeoutMs,
  });
  return [detailOfferFromHtml({ html, url, sourceType: 'dynamic_variant', discoveredFrom })];
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

function dynamicVariantsEnabled(config) {
  return config.apple?.dynamicVariantsEnabled === true;
}

function dynamicVariantMode(config) {
  return config.apple?.dynamicVariantMode === 'alert' ? 'alert' : 'shadow';
}

function dynamicVariantCandidatesFromManualItems(manualItems, existingKeys = new Set()) {
  const candidatesByUrl = new Map();

  for (const item of manualItems) {
    const offer = ensureCanonicalOfferUrl(item.offer);
    for (const variation of offer.variations || []) {
      const url = variation.canonicalUrl || variation.url;
      if (!url) {
        continue;
      }
      const canonicalUrl = canonicalizeAppleProductUrl(url, 'https://www.apple.com.cn');
      if (candidatesByUrl.has(canonicalUrl)) {
        continue;
      }
      candidatesByUrl.set(canonicalUrl, {
        url: canonicalUrl,
        discoveredFrom: offer.canonicalUrl || offer.url || null,
      });
    }
  }

  const discovered = [...candidatesByUrl.values()];
  const toScan = discovered.filter((candidate) => !existingKeys.has(candidate.url));
  return { discovered, toScan };
}

function scanEvidenceEnabled(config, repo) {
  return (
    config.observability?.scanEvidenceEnabled === true &&
    typeof repo.recordScanEvidence === 'function'
  );
}

function compactScanEvidence(offer, item) {
  return {
    title: offer.title ?? null,
    model: offer.model ?? null,
    chip: offer.chip ?? null,
    memory: offer.memory ?? null,
    memoryText: offer.memoryText ?? null,
    storage: offer.storage ?? null,
    storageText: offer.storageText ?? null,
    price: offer.price ?? null,
    source: offer.source ?? null,
    sourceType: offer.scanEvidence?.sourceType ?? (item.isManual ? 'detail' : 'listing'),
    listingTilePresent: offer.scanEvidence?.listingTilePresent === true,
    dynamicVariantShadow: item.shadowOnly === true,
    discoveredFrom: offer.scanEvidence?.discoveredFrom ?? null,
    availabilityEvidence: offer.availabilityEvidence ?? null,
  };
}

function recordPassiveScanEvidence({ repo, config, runId, item, offer, result, now, summary }) {
  if (!scanEvidenceEnabled(config, repo)) {
    return;
  }

  try {
    repo.recordScanEvidence({
      runId,
      sourceType: offer.scanEvidence?.sourceType ?? (item.isManual ? 'detail' : 'listing'),
      sourceUrl: offer.scanEvidence?.sourceUrl ?? offer.url ?? offer.canonicalUrl,
      canonicalUrl: offer.canonicalUrl ?? null,
      productId: offer.productId ?? null,
      fingerprint: result.fingerprint ?? null,
      availabilityStatus: offer.availabilityStatus ?? 'unknown',
      matchedRule: result.matched === true,
      evidence: compactScanEvidence(offer, item),
      htmlSha256: offer.scanEvidence?.htmlSha256 ?? null,
      createdAt: now,
    });
  } catch (error) {
    summary.errors.push({
      productId: offer.productId,
      message: `scan evidence record failed: ${error.message}`,
    });
  }
}

function prunePassiveScanEvidence({ repo, config, now, summary }) {
  if (!scanEvidenceEnabled(config, repo) || typeof repo.pruneScanEvidence !== 'function') {
    return;
  }
  const retentionHours = Math.max(1, Number(config.observability?.scanEvidenceRetentionHours ?? 24));
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) {
    return;
  }

  try {
    repo.pruneScanEvidence({
      before: toUtc8Iso(new Date(nowMs - retentionHours * 60 * 60 * 1000)),
    });
  } catch (error) {
    summary.errors.push({ message: `scan evidence prune failed: ${error.message}` });
  }
}

async function collectScanItems({
  urls,
  concurrency,
  scanner,
  isManual,
  summary,
  itemDefaults = {},
  errorTarget = summary.errors,
}) {
  const results = await mapWithConcurrency(urls, concurrency, async (source) => {
    const url = typeof source === 'string' ? source : source.url;
    try {
      const offers = await scanner(source);
      return { offers, url };
    } catch (error) {
      return { error, url };
    }
  });

  const scanItems = [];
  for (const result of results) {
    if (result.error) {
      errorTarget.push({ url: result.url, message: result.error.message });
      continue;
    }
    scanItems.push(...result.offers.map((offer) => ({ offer, isManual, ...itemDefaults })));
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
    dynamicVariantsDiscovered: 0,
    dynamicVariantsScanned: 0,
    dynamicVariantErrors: [],
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
    let dynamicItems = [];
    if (dynamicVariantsEnabled(config)) {
      const existingKeys = new Set([...listingItems, ...manualItems].map(scanItemKey).filter(Boolean));
      const dynamicCandidates = dynamicVariantCandidatesFromManualItems(manualItems, existingKeys);
      summary.dynamicVariantsDiscovered = dynamicCandidates.discovered.length;
      const shadowOnly = dynamicVariantMode(config) === 'shadow';
      dynamicItems = await collectScanItems({
        urls: dynamicCandidates.toScan,
        concurrency,
        scanner: (candidate) =>
          scanDynamicVariantUrl({
            url: candidate.url,
            config,
            fetchImpl,
            discoveredFrom: candidate.discoveredFrom,
          }),
        isManual: false,
        summary,
        itemDefaults: {
          isDynamicVariant: true,
          shadowOnly,
        },
        errorTarget: shadowOnly ? summary.dynamicVariantErrors : summary.errors,
      });
      summary.dynamicVariantsScanned = dynamicItems.length;
    }
    const scanItems = dedupeScanItemsPreferManual([...listingItems, ...dynamicItems, ...manualItems]);
    const manualSummaryCanConfirm = manualNotificationCanConfirm(config);

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
      const processConfig = item.shadowOnly
        ? { ...config, alerts: { ...(config.alerts ?? {}), rules: [] } }
        : config;
      const result = await processOffer({
        repo,
        config: processConfig,
        offer,
        now,
        fetchImpl,
        telegramDeliveryEnabled: false,
        ntfyDeliveryEnabled: false,
        retryOnNotificationFailure: !(item.isManual && manualSummaryCanConfirm),
        bypassAlertRules: item.isManual && !item.shadowOnly,
      });
      recordPassiveScanEvidence({ repo, config, runId, item, offer, result, now, summary });
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
    prunePassiveScanEvidence({ repo, config, now, summary });

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
    if (summary.errors.length === 0 && summary.scannedOffers > 0) {
      summary.deliveryEvents += await recordPeriodicNtfySeparator({
        repo,
        config,
        now,
        fetchImpl,
      });
    }
    try {
      summary.deliveryEvents += await recordScanHealth({
        repo,
        config,
        summary,
        now,
        fetchImpl,
      });
    } catch (error) {
      summary.errors.push({ message: `monitor health alert failed: ${error.message}` });
    }

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
