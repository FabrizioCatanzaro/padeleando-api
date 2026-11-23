import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeName, companionKey, bracketCompanions, mergeCompanions } from '../src/lib/padeleros.js';

test('normalizeName ignora tildes, mayúsculas y espacios', () => {
  assert.equal(normalizeName('  Martín   RUIZ '), 'martin ruiz');
});

test('companionKey prefiere la cuenta y si no usa el nombre', () => {
  assert.equal(companionKey('u1', 'Ana'), 'u:u1');
  assert.equal(companionKey(null, 'Ána '), 'n:ana');
  assert.equal(companionKey(null, '  '), null);
});

const pairs = [
  { id: 'a', mine: true,  members: [{ me: true, user_id: 'me', name: 'Yo' }, { user_id: null, name: 'Martín' }] },
  { id: 'b', mine: false, members: [{ user_id: 'u2', name: 'Lucas', username: 'lucas' }, { user_id: null, name: 'Nico' }] },
  { id: 'c', mine: false, members: [{ user_id: null, name: 'Tomi' }, { user_id: null, name: 'Juan' }] },
];

test('bracketCompanions: pareja y rivales de los partidos jugados, sin W.O. ni partidos ajenos', () => {
  const rows = [{
    pairs,
    bracket: {
      semis: [
        { id: 1, pair1_id: 'a', pair2_id: 'b', winner_id: 'a', score1: 3, score2: 1 },
        { id: 2, pair1_id: 'b', pair2_id: 'c', winner_id: 'c', score1: 1, score2: 3 },
      ],
      final: { id: 3, pair1_id: 'a', pair2_id: 'c', winner_id: 'c', walkover: true },
    },
    bracket_plata: { final: { id: 4, pair1_id: 'c', pair2_id: 'a', winner_id: null } },
  }];
  const out = bracketCompanions(rows);
  assert.deepEqual(out.map((r) => `${r.role}:${r.name}`), ['partner:Martín', 'rival:Lucas', 'rival:Nico']);
});

test('mergeCompanions suma por persona y ordena por total', () => {
  const rows = [
    { role: 'partner', user_id: null, name: 'Martín' },
    { role: 'partner', user_id: null, name: 'martin' },
    { role: 'rival', user_id: null, name: 'Martín ' },
    { role: 'rival', user_id: 'u2', name: 'Lucas', username: 'lucas', avatar_url: 'x' },
    { role: 'rival', user_id: 'u2', name: 'Lucas', username: 'lucas' },
    { role: 'partner', user_id: null, name: 'Nico' },
  ];
  const out = mergeCompanions(rows, 2);
  assert.deepEqual(out.map((r) => [r.key, r.juntos, r.rival, r.total]), [['n:martin', 2, 1, 3], ['u:u2', 0, 2, 2]]);
  assert.equal(out[1].username, 'lucas');
  assert.equal(out[1].avatar_url, 'x');
});
