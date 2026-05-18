const test = require('node:test');
const assert = require('node:assert/strict');
const { formatUtc8DisplayTime, nowUtc8Iso, toUtc8Iso } = require('../src/time');

test('toUtc8Iso formats timestamps with explicit +08:00 offset', () => {
  assert.equal(toUtc8Iso(new Date('2026-05-18T10:00:00.123Z')), '2026-05-18T18:00:00.123+08:00');
});

test('nowUtc8Iso returns UTC+8 timestamp shape', () => {
  assert.match(nowUtc8Iso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/);
});

test('formatUtc8DisplayTime removes ISO separators and milliseconds', () => {
  assert.equal(formatUtc8DisplayTime('2026-05-18T23:20:00.886+08:00'), '2026-05-18 23:20:00 UTC+8');
  assert.equal(formatUtc8DisplayTime('2026-05-18T23:20:00+08:00'), '2026-05-18 23:20:00 UTC+8');
  assert.equal(formatUtc8DisplayTime('not-a-time'), 'not-a-time');
});
