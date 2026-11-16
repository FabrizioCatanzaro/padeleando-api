import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStandings, comparePairRows } from '../src/lib/tournamentLogic.js';
import { countLeagueTitles } from '../src/lib/profileStats.js';
import { parseLigaSettings } from '../src/lib/ligaFechas.js';

const pair = (id) => ({ id, p1_id: `${id}1`, p2_id: `${id}2`, p1_name: id, p2_name: id, status: 'active' });
const m = (a, b, s1, s2, walkover = false) => ({
  team1_p1: `${a}1`, team1_p2: `${a}2`, team2_p1: `${b}1`, team2_p2: `${b}2`, score1: s1, score2: s2, walkover,
});
// A gana 1 de 1. B gana 1 y pierde 2. C gana 1 y pierde 1. D pierde 1 por W.O.
const pairs = ['A', 'B', 'C', 'D'].map(pair);
const matches = [m('A', 'B', 6, 4), m('B', 'C', 6, 2), m('C', 'B', 6, 3), m('D', 'C', 0, 6, true)];

test('puntos 3/0: el orden es el de siempre, por victorias', () => {
  const t = computeStandings(pairs, matches);
  assert.deepEqual(t.map((s) => [s.pair_id, s.points]), [['C', 6], ['A', 3], ['B', 3], ['D', 0]]);
});

test('puntos 3/1: la derrota suma y cambia el orden', () => {
  const t = computeStandings(pairs, matches, { win: 3, loss: 1 });
  assert.deepEqual(t.map((s) => [s.pair_id, s.points]), [['C', 7], ['B', 5], ['A', 3], ['D', 0]]);
});

test('la derrota por W.O. no suma los puntos de derrota', () => {
  const d = computeStandings(pairs, matches, { win: 2, loss: 1 }).find((s) => s.pair_id === 'D');
  assert.equal(d.played, 1);
  assert.equal(d.points, 0);
});

test('a igualdad de puntos desempata por victorias', () => {
  const a = { points: 6, wins: 2, diff: 0, played: 2, gf: 10, pair_id: 'a' };
  const b = { points: 6, wins: 1, diff: 9, played: 4, gf: 20, pair_id: 'b' };
  assert.ok(comparePairRows(a, b) < 0);
});

test('títulos del perfil: el campeón sale de los puntos', () => {
  const rows = [
    { tournament_id: 't', mine: true,  pj: 4, pg: 2, diff: 2, gf: 20, pts: 8 },
    { tournament_id: 't', mine: false, pj: 2, pg: 2, diff: 6, gf: 12, pts: 6 },
  ];
  assert.equal(countLeagueTitles(rows), 1);
  assert.equal(countLeagueTitles(rows.map((r) => ({ ...r, pts: undefined }))), 0);
});

test('parseLigaSettings valida los puntos', () => {
  assert.deepEqual(parseLigaSettings({ points_win: 3, points_loss: 1 }), { points_win: 3, points_loss: 1 });
  assert.throws(() => parseLigaSettings({ points_win: 11 }), /de 0 a 10/);
  assert.throws(() => parseLigaSettings({ points_win: 1.5 }), /de 0 a 10/);
  assert.throws(() => parseLigaSettings({ points_win: 1, points_loss: 2 }), /no puede sumar más/);
  assert.throws(() => parseLigaSettings({ points_loss: 4 }, { current: { points_win: 3 } }), /no puede sumar más/);
  assert.throws(() => parseLigaSettings({ points_win: 3 }, { format: 'americano' }), /solo para torneos Liga/);
});
