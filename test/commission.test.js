import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feePerPlayer, quote, onlinePriceError } from '../src/lib/commission.js';

test('comisión por jugador: 6 % con mínimo de $500 en Gratis, 3 % con mínimo de $300 en Organizador', () => {
  assert.equal(feePerPlayer(20000), 1200);
  assert.equal(feePerPlayer(5000), 500);
  assert.equal(feePerPlayer(20000, true), 600);
  assert.equal(feePerPlayer(8000, true), 300);
  assert.equal(feePerPlayer(12345), 741);
});

test('el jugador paga el cargo: el organizador recibe el precio entero', () => {
  assert.deepEqual(quote({ price: 20000 }), { players: 1, base: 20000, fee: 1200, total: 21200, net: 20000 });
  assert.deepEqual(quote({ price: 20000, kind: 'pair' }), { players: 2, base: 40000, fee: 2400, total: 42400, net: 40000 });
});

test('precio por pareja: la comisión se calcula por jugador', () => {
  assert.deepEqual(quote({ price: 40000, unit: 'pair', kind: 'pair', organizerPlan: true }),
    { players: 2, base: 40000, fee: 1200, total: 41200, net: 40000 });
  assert.deepEqual(quote({ price: 40000, unit: 'pair', kind: 'solo' }),
    { players: 1, base: 20000, fee: 1200, total: 21200, net: 20000 });
});

test('el organizador absorbe el cargo: el jugador ve el precio limpio', () => {
  assert.deepEqual(quote({ price: 20000, payer: 'organizer' }), { players: 1, base: 20000, fee: 1200, total: 20000, net: 18800 });
});

test('comisión cero durante el lanzamiento', () => {
  assert.deepEqual(quote({ price: 20000, waived: true }), { players: 1, base: 20000, fee: 0, total: 20000, net: 20000 });
});

test('precios que no se pueden cobrar online', () => {
  assert.match(onlinePriceError({ price: 0 }), /mayor a 0/);
  assert.match(onlinePriceError({ price: null }), /mayor a 0/);
  assert.match(onlinePriceError({ price: 400, payer: 'organizer' }), /supera/);
  assert.equal(onlinePriceError({ price: 400 }), null);
  assert.equal(onlinePriceError({ price: 20000, payer: 'organizer' }), null);
});

test('preferencia del cobro online', async () => {
  const { preferenceBody, externalRef } = await import('../src/lib/registrationPayment.js');
  const body = preferenceBody({
    registrationId: 'r1', groupId: 'g1', tournamentId: 't1', tournamentName: 'Liga', total: 21200, fee: 1200, kind: 'solo',
    expiresAt: '2026-11-27T12:30:00Z', apiUrl: 'https://api.test', frontendUrl: 'https://app.test',
  });
  assert.equal(body.items[0].unit_price, 21200);
  assert.equal(body.marketplace_fee, 1200);
  assert.equal(body.external_reference, externalRef('r1'));
  assert.equal(body.notification_url, 'https://api.test/api/registrations/mercadopago/webhook?reg=r1');
  assert.equal(body.auto_return, 'approved');
  assert.equal(body.back_urls.success, 'https://app.test/cat/g1/torneo/t1?pago=ok');
  assert.deepEqual(body.payment_methods.excluded_payment_types.map((t) => t.id), ['ticket', 'atm']);
  assert.equal(body.expiration_date_to, '2026-11-27T12:30:00.000Z');
  const local = preferenceBody({ registrationId: 'r1', tournamentId: 't1', tournamentName: 'L', total: 1, fee: 0, kind: 'pair',
    expiresAt: '2026-11-27T12:30:00Z', apiUrl: 'x', frontendUrl: 'http://localhost:5173' });
  assert.equal(local.auto_return, undefined);
  assert.match(local.items[0].title, /de pareja/);
});

test('lo que ve el público de un torneo con cobro online', async () => {
  const { publicSignup } = await import('../src/lib/registrations.js');
  const base = { open: true, price: 20000, unit: 'player', capacity: null, capacity_unit: 'pair', online: true, fee_payer: 'player' };
  assert.deepEqual(publicSignup(base, { format: 'liga', used: 0 }).online_quote,
    { solo: { total: 21200, fee: 1200 }, pair: { total: 42400, fee: 2400 } });
  assert.deepEqual(publicSignup({ ...base, fee_payer: 'organizer' }, { format: 'liga', used: 0 }).online_quote,
    { solo: { total: 20000, fee: 0 }, pair: { total: 40000, fee: 0 } });
  assert.equal(publicSignup({ ...base, online: false }, { format: 'liga', used: 0 }).online_quote, undefined);
});
