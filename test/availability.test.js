import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAvailability, availabilityByPair } from '../src/lib/availability.js';

test('disponibilidad: normaliza y ordena', () => {
  const a = parseAvailability({ slots: [{ day: 6, from: '10:00', to: '13:00' }, { day: 1, from: '19:00', to: '23:30' }], note: '  sábados a la mañana ' });
  assert.deepEqual(a, { slots: [{ day: 1, from: '19:00', to: '23:30' }, { day: 6, from: '10:00', to: '13:00' }], note: 'sábados a la mañana' });
  assert.equal(parseAvailability({ slots: [], note: ' ' }), null);
  assert.equal(parseAvailability(null), null);
  assert.deepEqual(parseAvailability({ slots: [{ day: 0, from: '20:00', to: '24:00' }] }).slots[0].to, '24:00');
});

test('disponibilidad: rechaza lo inválido', () => {
  const bad = [
    { slots: [{ day: 7, from: '10:00', to: '11:00' }] },
    { slots: [{ day: 1, from: '10:15', to: '11:00' }] },
    { slots: [{ day: 1, from: '12:00', to: '11:00' }] },
    { slots: [{ day: 1, from: '10:00', to: '12:00' }, { day: 1, from: '11:00', to: '13:00' }] },
    { slots: [1, 2, 3].map((h) => ({ day: 2, from: `0${h}:00`, to: `0${h}:30` })) },
    { slots: [], note: 'x'.repeat(201) },
    [],
  ];
  for (const b of bad) assert.throws(() => parseAvailability(b), JSON.stringify(b));
});

test('disponibilidad por pareja: inscripción de pareja o dos solos', () => {
  const pairs = [{ id: 'p', p1_id: 'a', p2_id: 'b' }, { id: 'q', p1_id: 'c', p2_id: 'd' }, { id: 'r', p1_id: 'e', p2_id: 'f' }];
  const A = { slots: [{ day: 1, from: '19:00', to: '23:00' }], note: null };
  const C = { slots: [{ day: 2, from: '18:00', to: '20:00' }], note: null };
  const D = { slots: [{ day: 2, from: '19:00', to: '22:00' }], note: null };
  const regs = [
    { id: 'r1', p1_player_id: 'a', p2_player_id: 'b', availability: A },
    { id: 'r2', p1_player_id: 'c', p2_player_id: null, availability: C },
    { id: 'r3', p1_player_id: 'd', p2_player_id: null, availability: D },
  ];
  assert.deepEqual(availabilityByPair(pairs, regs), { p: [A], q: [C, D], r: [] });
});
