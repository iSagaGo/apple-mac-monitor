const crypto = require('node:crypto');

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\u200d/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeComparable(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeList(value) {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function matchesOneOf(actual, expected) {
  const expectedValues = normalizeList(expected);
  if (expectedValues.length === 0) {
    return true;
  }
  const normalizedActual = normalizeComparable(actual);
  return expectedValues.some((value) => normalizeComparable(value) === normalizedActual);
}

function numericPrice(offer) {
  const rawAmount = offer?.price?.rawAmount ?? offer?.price?.raw_amount;
  if (rawAmount === undefined || rawAmount === null || rawAmount === '') {
    return null;
  }
  const parsed = Number(rawAmount);
  return Number.isFinite(parsed) ? parsed : null;
}

function matchesAlertRule(offer, rule = {}) {
  if (rule.enabled === false) {
    return false;
  }

  if (!matchesOneOf(offer.productId, rule.productIds)) {
    return false;
  }
  if (!matchesOneOf(offer.model, rule.model)) {
    return false;
  }
  if (!matchesOneOf(offer.chip, rule.chip)) {
    return false;
  }
  if (!matchesOneOf(offer.memory, rule.memory)) {
    return false;
  }
  if (!matchesOneOf(offer.storage, rule.storage)) {
    return false;
  }
  if (!matchesOneOf(offer.availabilityStatus, rule.availabilityStatus)) {
    return false;
  }

  const price = numericPrice(offer);
  if (rule.minPrice !== undefined && (price === null || price < Number(rule.minPrice))) {
    return false;
  }
  if (rule.maxPrice !== undefined && (price === null || price > Number(rule.maxPrice))) {
    return false;
  }

  const haystack = normalizeComparable(
    [
      offer.productId,
      offer.title,
      offer.model,
      offer.chip,
      offer.memoryText,
      offer.storageText,
      offer.configText,
    ].join(' '),
  );
  return normalizeList(rule.keywords).every((keyword) => haystack.includes(normalizeComparable(keyword)));
}

function fingerprintPayload(offer) {
  return {
    productId: normalizeText(offer.productId).toUpperCase(),
    model: normalizeComparable(offer.model),
    chip: normalizeComparable(offer.chip),
    cpuCores: offer.cpuCores ?? null,
    gpuCores: offer.gpuCores ?? null,
    memory: normalizeComparable(offer.memory),
    storage: normalizeComparable(offer.storage),
    configText: normalizeComparable(offer.configText),
  };
}

function buildOfferFingerprint(offer) {
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify(fingerprintPayload(offer)))
    .digest('hex')
    .slice(0, 32);
  return `ofp_${hash}`;
}

function secondsBetween(start, end) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return null;
  }
  return (endMs - startMs) / 1000;
}

function baseNextState({ previous, offer, fingerprint, now, status }) {
  return {
    fingerprint,
    productId: offer.productId ?? previous?.productId ?? null,
    canonicalUrl: offer.canonicalUrl ?? previous?.canonicalUrl ?? null,
    status,
    windowOpen: previous?.windowOpen === true,
    availableSince: previous?.availableSince ?? null,
    lastSeenAt: now,
    lastAlertAt: previous?.lastAlertAt ?? null,
    lastUnavailableAt: previous?.lastUnavailableAt ?? null,
  };
}

function decideAvailabilityWindow({ previous = null, offer, now, repeatAlertAfterSeconds = null }) {
  const status = offer.availabilityStatus ?? 'unknown';
  const fingerprint = buildOfferFingerprint(offer);
  const sameFingerprint = previous?.fingerprint === fingerprint;

  if (status === 'unknown') {
    return {
      shouldAlert: false,
      reason: 'unknown',
      fingerprint,
      nextState: {
        ...baseNextState({ previous, offer, fingerprint, now, status: 'unknown' }),
        windowOpen: false,
      },
    };
  }

  if (status !== 'available') {
    return {
      shouldAlert: false,
      reason: 'unavailable',
      fingerprint,
      nextState: {
        ...baseNextState({ previous, offer, fingerprint, now, status: 'unavailable' }),
        windowOpen: false,
        availableSince: sameFingerprint ? previous?.availableSince ?? null : null,
        lastUnavailableAt: now,
      },
    };
  }

  let shouldAlert = false;
  let reason = 'still_available';

  if (!previous) {
    shouldAlert = true;
    reason = 'first_available';
  } else if (!sameFingerprint) {
    shouldAlert = true;
    reason = 'new_fingerprint';
  } else if (previous.status === 'unavailable' || previous.windowOpen === false) {
    shouldAlert = true;
    reason = 'restocked';
  } else if (repeatAlertAfterSeconds !== null && previous.lastAlertAt) {
    const elapsedSeconds = secondsBetween(previous.lastAlertAt, now);
    if (elapsedSeconds !== null && elapsedSeconds >= Number(repeatAlertAfterSeconds)) {
      shouldAlert = true;
      reason = 'repeat_threshold_elapsed';
    }
  }

  const availableSince =
    sameFingerprint && previous?.windowOpen === true && previous.availableSince
      ? previous.availableSince
      : now;

  return {
    shouldAlert,
    reason,
    fingerprint,
    nextState: {
      ...baseNextState({ previous, offer, fingerprint, now, status: 'available' }),
      windowOpen: true,
      availableSince,
      lastAlertAt: shouldAlert ? now : previous?.lastAlertAt ?? null,
    },
  };
}

module.exports = {
  buildOfferFingerprint,
  decideAvailabilityWindow,
  matchesAlertRule,
};
