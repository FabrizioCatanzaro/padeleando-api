import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rolesOf, hasRole, PLAYER_PLANS, ORGANIZER_PLANS, isPurchasable, mpPlanEnvKey, mpPlanIndex, clubMonthlyPrice,
  CLUB_MIN_PRICE,
} from '../src/lib/planCatalog.js';

test('cada plan da sus roles; premium vale como combo', () => {
  assert.deepEqual(rolesOf('jugador_plus'), ['jugador']);
  assert.deepEqual(rolesOf('organizador'), ['organizador']);
  assert.deepEqual(rolesOf('combo'), rolesOf('premium'));
  assert.ok(hasRole('club', 'club') && hasRole('club', 'jugador') && hasRole('club', 'organizador'));
  assert.deepEqual(rolesOf('free'), []);
  assert.equal(hasRole(undefined, 'jugador'), false);
});

test('listas para SQL por rol', () => {
  assert.deepEqual(PLAYER_PLANS.sort(), ['club', 'combo', 'jugador_plus', 'premium']);
  assert.deepEqual(ORGANIZER_PLANS.sort(), ['club', 'combo', 'organizador', 'premium']);
});

test('club no se vende mientras el plan está apagado; premium tampoco', () => {
  assert.equal(isPurchasable('jugador_plus'), true);
  assert.equal(isPurchasable('combo'), true);
  assert.equal(isPurchasable('club'), false);
  assert.equal(isPurchasable('premium'), false);
  assert.equal(isPurchasable('x'), false);
});

test('variables de los planes de Mercado Pago', () => {
  assert.equal(mpPlanEnvKey('organizador', 'annual'), 'MP_PLAN_ID_ORGANIZADOR_ANNUAL');
  assert.equal(mpPlanEnvKey('premium', 'monthly'), 'MP_PLAN_ID_MONTHLY');
  assert.equal(mpPlanEnvKey('organizador', 'trial'), null);
  const idx = mpPlanIndex({ MP_PLAN_ID_MONTHLY: 'a', MP_PLAN_ID_COMBO_ANNUAL: 'b' });
  assert.deepEqual(idx, { a: { plan: 'premium', billing: 'monthly' }, b: { plan: 'combo', billing: 'annual' } });
});

test('abono del club: canchas activas por el promedio del turno de 1 h', () => {
  const c = (price_60, active = true) => ({ price_60, active });
  assert.equal(clubMonthlyPrice([c(30000), c(30000), c(30000)]), 90000);
  assert.equal(clubMonthlyPrice([c(30000), c(40000)]), 70000);
  assert.equal(clubMonthlyPrice([c(50000), c(null), c(50000, false)]), 100000);
  assert.equal(clubMonthlyPrice([c(10000)]), CLUB_MIN_PRICE);
  assert.equal(clubMonthlyPrice([c(null)]), CLUB_MIN_PRICE);
  assert.equal(clubMonthlyPrice([]), CLUB_MIN_PRICE);
});
