import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandBookingSlots, withinHorizon, addDaysStr } from '../src/lib/bookingSlots.js';

test('turnos del mismo día mantienen la fecha', () => {
  const { items } = expandBookingSlots('2026-11-28', ['19:00', '19:30', '20:00'], 30, 8);
  assert.deepEqual(items.map((i) => i.date), ['2026-11-28', '2026-11-28', '2026-11-28']);
});

test('un turno que cruza la medianoche pasa al día siguiente', () => {
  const { items } = expandBookingSlots('2026-11-28', ['23:30', '00:00', '00:30'], 30, 8);
  assert.deepEqual(items, [
    { date: '2026-11-28', start_time: '23:30' },
    { date: '2026-11-29', start_time: '00:00' },
    { date: '2026-11-29', start_time: '00:30' },
  ]);
});

test('cruza el fin de mes y de año', () => {
  const { items } = expandBookingSlots('2026-12-31', ['23:30', '00:00'], 30, 8);
  assert.equal(items[1].date, '2027-01-01');
});

test('rechaza turnos que no son consecutivos', () => {
  assert.equal(expandBookingSlots('2026-11-28', ['19:00', '20:00'], 30, 8).error, 'Los turnos elegidos tienen que ser consecutivos');
  assert.equal(expandBookingSlots('2026-11-28', ['00:00', '23:30'], 30, 8).error, 'Los turnos elegidos tienen que ser consecutivos');
});

test('rechaza formatos y cantidades inválidas', () => {
  assert.ok(expandBookingSlots('2026-11-28', [], 30, 8).error);
  assert.ok(expandBookingSlots('2026-11-28', ['24:00'], 30, 8).error);
  assert.ok(expandBookingSlots('2026-11-28', ['9:00'], 30, 8).error);
  assert.ok(expandBookingSlots('2026-11-28', Array.from({ length: 9 }, (_, i) => `1${i}:00`), 30, 8).error);
});

test('horizonte de 7 días más la madrugada del día siguiente al último', () => {
  const today = '2026-11-28';
  assert.equal(withinHorizon('2026-11-27', '23:00', today, 7), false);
  assert.equal(withinHorizon(today, '09:00', today, 7), true);
  assert.equal(withinHorizon('2026-12-04', '22:00', today, 7), true);
  assert.equal(withinHorizon('2026-12-05', '01:00', today, 7), true);
  assert.equal(withinHorizon('2026-12-05', '15:00', today, 7), false);
  assert.equal(addDaysStr('2026-11-30', 1), '2026-12-01');
});
