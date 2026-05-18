const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildOfferFingerprint,
  decideAvailabilityWindow,
  matchesAlertRule,
} = require('../src/rules');

function macStudioOffer(overrides = {}) {
  return {
    productId: 'G1CEPCH/A',
    canonicalUrl: 'https://www.apple.com.cn/shop/product/g1cepch/a',
    title: 'Refurbished Mac Studio Apple M3 Ultra chip with 32-Core CPU and 80-Core GPU',
    model: 'Mac Studio',
    chip: 'M3 Ultra',
    cpuCores: 32,
    gpuCores: 80,
    memory: '512gb',
    storage: '16tb',
    price: { amount: 'RMB 92,399', rawAmount: 92399 },
    availabilityStatus: 'available',
    ...overrides,
  };
}

test('matchesAlertRule filters Mac Studio offers by memory and storage', () => {
  const rule = {
    model: 'Mac Studio',
    memory: ['512gb'],
    storage: ['16tb', '8tb'],
    maxPrice: 100000,
  };

  assert.equal(matchesAlertRule(macStudioOffer(), rule), true);
  assert.equal(matchesAlertRule(macStudioOffer({ memory: '256gb' }), rule), false);
  assert.equal(matchesAlertRule(macStudioOffer({ storage: '4tb' }), rule), false);
  assert.equal(matchesAlertRule(macStudioOffer({ price: { rawAmount: 120000 } }), rule), false);
});

test('buildOfferFingerprint is stable across price changes and URL query changes', () => {
  const first = buildOfferFingerprint(macStudioOffer());
  const second = buildOfferFingerprint(
    macStudioOffer({
      url: 'https://www.apple.com.cn/shop/product/g1cepch/a?fnode=session',
      price: { amount: 'RMB 88,888', rawAmount: 88888 },
    }),
  );

  assert.equal(first, second);
});

test('buildOfferFingerprint changes when the same URL points at a different configuration', () => {
  const first = buildOfferFingerprint(macStudioOffer());
  const second = buildOfferFingerprint(
    macStudioOffer({
      productId: 'G1CENCH/A',
      memory: '256gb',
    }),
  );

  assert.notEqual(first, second);
});

test('decideAvailabilityWindow alerts on first available scan', () => {
  const result = decideAvailabilityWindow({
    previous: null,
    offer: macStudioOffer(),
    now: '2026-05-18T20:00:00+08:00',
  });

  assert.equal(result.shouldAlert, true);
  assert.equal(result.reason, 'first_available');
  assert.equal(result.nextState.status, 'available');
  assert.equal(result.nextState.windowOpen, true);
});

test('decideAvailabilityWindow suppresses repeated alerts inside the same window', () => {
  const previous = decideAvailabilityWindow({
    previous: null,
    offer: macStudioOffer(),
    now: '2026-05-18T20:00:00+08:00',
  }).nextState;

  const result = decideAvailabilityWindow({
    previous,
    offer: macStudioOffer(),
    now: '2026-05-18T20:00:10+08:00',
  });

  assert.equal(result.shouldAlert, false);
  assert.equal(result.reason, 'still_available');
});

test('decideAvailabilityWindow alerts when the same URL appears with a new fingerprint', () => {
  const previous = decideAvailabilityWindow({
    previous: null,
    offer: macStudioOffer(),
    now: '2026-05-18T20:00:00+08:00',
  }).nextState;

  const result = decideAvailabilityWindow({
    previous,
    offer: macStudioOffer({
      productId: 'G1CENCH/A',
      memory: '256gb',
    }),
    now: '2026-05-18T20:00:10+08:00',
  });

  assert.equal(result.shouldAlert, true);
  assert.equal(result.reason, 'new_fingerprint');
});

test('decideAvailabilityWindow alerts when an offer returns after being unavailable', () => {
  const unavailable = decideAvailabilityWindow({
    previous: {
      fingerprint: buildOfferFingerprint(macStudioOffer()),
      status: 'available',
      windowOpen: true,
      availableSince: '2026-05-18T20:00:00+08:00',
      lastAlertAt: '2026-05-18T20:00:00+08:00',
    },
    offer: macStudioOffer({ availabilityStatus: 'unavailable' }),
    now: '2026-05-18T20:00:10+08:00',
  }).nextState;

  const result = decideAvailabilityWindow({
    previous: unavailable,
    offer: macStudioOffer({ availabilityStatus: 'available' }),
    now: '2026-05-18T20:00:20+08:00',
  });

  assert.equal(result.shouldAlert, true);
  assert.equal(result.reason, 'restocked');
});

test('decideAvailabilityWindow can re-alert after an explicit threshold', () => {
  const previous = decideAvailabilityWindow({
    previous: null,
    offer: macStudioOffer(),
    now: '2026-05-18T20:00:00+08:00',
  }).nextState;

  const result = decideAvailabilityWindow({
    previous,
    offer: macStudioOffer(),
    now: '2026-05-18T20:31:00+08:00',
    repeatAlertAfterSeconds: 1800,
  });

  assert.equal(result.shouldAlert, true);
  assert.equal(result.reason, 'repeat_threshold_elapsed');
});
