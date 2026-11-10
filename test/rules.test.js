import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSignupFields, resolveSignup, MAX_RULES } from '../src/lib/signup.js';

test('reglamento: recorta, normaliza saltos y deja null si queda vacío', () => {
  assert.equal(parseSignupFields({ rules: '  Se juega a 1 set.\r\nW.O. a los 15 min.  ' }).rules, 'Se juega a 1 set.\nW.O. a los 15 min.');
  assert.equal(parseSignupFields({ rules: '   ' }).rules, null);
  assert.equal(parseSignupFields({ rules: null }).rules, null);
  assert.equal('rules' in parseSignupFields({}), false);
});

test('reglamento: rechaza lo que no es texto y lo demasiado largo', () => {
  assert.throws(() => parseSignupFields({ rules: 42 }), /texto/);
  assert.throws(() => parseSignupFields({ rules: 'x'.repeat(MAX_RULES + 1) }), /no puede superar/);
  assert.equal(parseSignupFields({ rules: 'x'.repeat(MAX_RULES) }).rules.length, MAX_RULES);
});

test('reglamento: el del torneo pisa al de la categoría, y si no hay hereda', () => {
  assert.equal(resolveSignup({ rules: 'Torneo' }, { rules: 'Categoría' }).rules, 'Torneo');
  assert.equal(resolveSignup({ rules: null }, { rules: 'Categoría' }).rules, 'Categoría');
  assert.equal(resolveSignup({}, {}).rules, null);
});
