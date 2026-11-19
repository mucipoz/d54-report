import assert from 'node:assert/strict';
import test from 'node:test';
import { formatClock } from './app.js';

test('yerel saati saniye ve ön sıfırlarla gösterir', () => {
  assert.equal(formatClock(new Date(2026, 0, 2, 7, 8, 9)), '07:08:09');
  assert.equal(formatClock(new Date(2026, 0, 2, 0, 0, 0)), '00:00:00');
});
