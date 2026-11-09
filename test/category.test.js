import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCategory, parseLevel, describeLevel, checkRegistrationLevel } from '../src/lib/category.js';
import { parseSignupFields, resolveSignup } from '../src/lib/signup.js';

test('parseCategory: C o D + 1..10', () => {
  assert.equal(parseCategory('c7'), 'C7');
  assert.equal(parseCategory('D10'), 'D10');
  assert.equal(parseCategory(''), null);
  for (const bad of ['C0', 'C11', 'M5', 'SC11', '7']) assert.throws(() => parseCategory(bad), bad);
});

test('parseLevel: fija, mixto y suma', () => {
  for (const ok of ['C7', 'D1', 'M6', 'SC11', 'sd8', 'SM15']) assert.ok(parseLevel(ok));
  for (const bad of ['C0', 'M11', 'SC7', 'SC16', 'SX9', 'S11']) assert.throws(() => parseLevel(bad), bad);
  assert.deepEqual(describeLevel('SM12'), { kind: 'sum', branch: 'M', value: 12 });
  assert.deepEqual(describeLevel('C7'), { kind: 'fixed', branch: 'C', value: 7 });
});

const issues = (cats, level, opts) => checkRegistrationLevel(cats, level, opts).issues;

test('categoría fija: número igual o mayor, misma rama', () => {
  assert.deepEqual(issues(['C7', 'C8'], 'C7'), []);
  assert.equal(issues(['C5', 'C7'], 'C7').length, 1);
  assert.equal(issues(['D7', 'C7'], 'C7').length, 1);
  assert.deepEqual(issues(['C6'], 'C7', { solo: true }), ['C6 es de un nivel más alto que el torneo']);
});

test('SUMA: la pareja suma el número o más (C6 + C5 en SUMA 11)', () => {
  assert.deepEqual(issues(['C6', 'C5'], 'SC11'), []);
  assert.deepEqual(issues(['C6', 'C6'], 'SC11'), []);
  assert.deepEqual(issues(['C5', 'C5'], 'SC11'), ['Suman 10: el torneo pide 11 o más']);
  assert.equal(issues(['D6', 'D5'], 'SC11').length, 1, 'rama equivocada');
  assert.deepEqual(issues(['C1'], 'SC12', { solo: true }), ['Con C1 ninguna pareja llega a sumar 12']);
  assert.deepEqual(issues(['C2'], 'SC12', { solo: true }), []);
});

test('MIXTO: un caballero y una dama, categoría o suma', () => {
  assert.deepEqual(issues(['C6', 'D6'], 'M6'), []);
  assert.equal(issues(['C6', 'C7'], 'M6').length, 1);
  assert.equal(issues(['C5', 'D6'], 'M6').length, 1);
  assert.deepEqual(issues(['C6', 'D7'], 'SM12'), []);
  assert.deepEqual(issues(['C5', 'D6'], 'SM12'), ['Suman 11: el torneo pide 12 o más']);
});

test('invitado sin categoría: no se puede controlar la suma', () => {
  const r = checkRegistrationLevel(['C5', null], 'SC11');
  assert.deepEqual(r, { issues: [], unknown: true });
});

test('level viaja con la inscripción y se hereda de la categoría', () => {
  assert.deepEqual(parseSignupFields({ level: 'sc11' }), { level: 'SC11' });
  assert.throws(() => parseSignupFields({ level: 'C12' }));
  assert.equal(resolveSignup({ level: null }, { level: 'D3' }).level, 'D3');
});
