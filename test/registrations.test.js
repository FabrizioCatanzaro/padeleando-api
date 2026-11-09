import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capacityInPlayers, hasRoom, signupState, parseGuestPartner, summarize, slotsFor } from '../src/lib/registrations.js';

test('cupo en jugadores: parejas, jugadores y tope del americano', () => {
  assert.equal(capacityInPlayers({ capacity: 8, unit: 'pair', format: 'liga' }), 16);
  assert.equal(capacityInPlayers({ capacity: 10, unit: 'player', format: 'liga' }), 10);
  assert.equal(capacityInPlayers({ capacity: null, unit: 'pair', format: 'liga' }), null);
  assert.equal(capacityInPlayers({ capacity: null, unit: 'pair', format: 'americano' }), 32);
  assert.equal(capacityInPlayers({ capacity: 20, unit: 'pair', format: 'americano' }), 32);
  assert.equal(capacityInPlayers({ capacity: 12, unit: 'pair', format: 'americano' }), 24);
});

test('hay lugar: una pareja ocupa 2 y un individual 1', () => {
  assert.equal(slotsFor('pair'), 2);
  assert.equal(hasRoom(14, 'pair', 16), true);
  assert.equal(hasRoom(15, 'pair', 16), false);
  assert.equal(hasRoom(15, 'solo', 16), true);
  assert.equal(hasRoom(500, 'pair', null), true);
});

test('estado de la inscripción', () => {
  const open = { open: true, closes_at: null };
  const t = { status: 'active', bracket: null };
  assert.equal(signupState(open, t).open, true);
  assert.equal(signupState({ open: false }, t).open, false);
  assert.equal(signupState(open, { status: 'finished' }).open, false);
  assert.equal(signupState(open, { status: 'active', bracket: {} }).open, false);
  const now = new Date('2026-11-10T12:00:00Z');
  assert.equal(signupState({ open: true, closes_at: '2026-11-10T11:59:00Z' }, t, now).open, false);
  assert.equal(signupState({ open: true, closes_at: '2026-11-10T12:01:00Z' }, t, now).open, true);
});

test('compañero sin cuenta: nombre y teléfono obligatorios', () => {
  assert.deepEqual(parseGuestPartner({ name: '  Juan   Pérez ', phone: '+54 9 11 5555-1234' }), { name: 'Juan Pérez', phone: '+54 9 11 5555-1234' });
  assert.throws(() => parseGuestPartner({ name: 'Juan', phone: '' }));
  assert.throws(() => parseGuestPartner({ name: 'J', phone: '1155551234' }));
  assert.throws(() => parseGuestPartner({ name: 'Juan', phone: 'abc' }));
});

test('contadores del panel', () => {
  const s = summarize([
    { status: 'pending' }, { status: 'approved', paid: true }, { status: 'approved', solo_unpaired: true },
    { status: 'waitlist' }, { status: 'rejected', paid: true },
  ]);
  assert.deepEqual(s, { pending: 1, approved: 2, waitlist: 1, rejected: 1, cancelled: 0, paid: 1, solo_unpaired: 1 });
});

// ── Disponibilidad y plantel oculto (2026-11-09) ────────────────────────────
import { availability, publicSignup, hasStarted } from '../src/lib/registrations.js';

test('availability: sin cupo, abierto, últimos y completo', () => {
  assert.equal(availability(null, 5), null);
  assert.equal(availability(24, 4), 'open');
  assert.equal(availability(24, 19), 'few');   // quedan 5 = 20 % de 24
  assert.equal(availability(24, 24), 'full');
  assert.equal(availability(24, 30), 'full');
  assert.equal(availability(8, 6), 'few');     // quedan 2: mínimo 2
});

test('publicSignup: oculta los números del cupo', () => {
  const out = publicSignup({ open: true, capacity: 12, capacity_unit: 'pair', price: 15000 }, { format: 'liga', used: 20 });
  assert.equal(out.capacity, undefined);
  assert.equal(out.capacity_unit, undefined);
  assert.equal(out.price, 15000);
  assert.equal(out.availability, 'few');
});

test('hasStarted: fecha, partidos, cuadro y final', () => {
  const now = new Date('2026-11-15T20:00:00Z'); // 17:00 en Argentina
  assert.equal(hasStarted({ status: 'active', event_date: '2026-11-15', event_time: '18:00' }, 0, now), false);
  assert.equal(hasStarted({ status: 'active', event_date: '2026-11-15', event_time: '16:30' }, 0, now), true);
  assert.equal(hasStarted({ status: 'active' }, 0, now), false);
  assert.equal(hasStarted({ status: 'active' }, 1, now), true);
  assert.equal(hasStarted({ status: 'active', bracket: { rounds: [] } }, 0, now), true);
  assert.equal(hasStarted({ status: 'finished' }, 0, now), true);
  assert.equal(hasStarted({ status: 'active', live_match: [{ id: 'x' }] }, 0, now), true);
});

// ── Mail de la decisión (2026-11-09) ────────────────────────────────────────
import { decisionMailContent } from '../src/lib/registrationMail.js';

test('mail de la decisión: texto por estado y motivo real', () => {
  const base = { tournamentName: 'Fecha 3', url: 'x' };
  assert.equal(decisionMailContent({ ...base, status: 'approved' }).line, 'Ya tenés un lugar en el torneo.');
  assert.match(decisionMailContent({ ...base, status: 'waitlist' }).subject, /espera: Fecha 3$/);
  assert.equal(decisionMailContent({ ...base, status: 'rejected', reason: 'Excedido de nivel' }).line, 'Excedido de nivel');
  assert.equal(decisionMailContent({ ...base, status: 'rejected', reason: '  ' }).line, 'Por motivos que definió el organizador.');
  assert.equal(decisionMailContent({ ...base, status: 'pending' }), null);
});
