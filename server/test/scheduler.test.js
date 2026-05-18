const assert = require('node:assert/strict');
const test = require('node:test');

const { createScheduler } = require('../src/scheduler');

test('scheduler runOnce skips overlapping scans', async () => {
  let releaseScan;
  let scanCalls = 0;
  const scheduler = createScheduler({
    config: { scheduler: { scanIntervalSeconds: 10 } },
    repo: {},
    scanOnceImpl: async () => {
      scanCalls += 1;
      await new Promise((resolve) => {
        releaseScan = resolve;
      });
      return { scannedOffers: 0 };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const first = scheduler.runOnce('first');
  const second = await scheduler.runOnce('second');
  releaseScan();
  const firstResult = await first;

  assert.equal(second.skipped, true);
  assert.equal(firstResult.skipped, false);
  assert.equal(scanCalls, 1);
});

test('scheduler resolves config for every run', async () => {
  const intervals = [];
  const scheduler = createScheduler({
    config: { scheduler: { scanIntervalSeconds: 10 } },
    repo: {},
    getConfig: () => ({
      scheduler: { scanIntervalSeconds: 10 },
      marker: `run-${intervals.length + 1}`,
    }),
    scanOnceImpl: async ({ config }) => {
      intervals.push(config.marker);
      return { scannedOffers: 0 };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await scheduler.runOnce('first');
  await scheduler.runOnce('second');

  assert.deepEqual(intervals, ['run-1', 'run-2']);
});
