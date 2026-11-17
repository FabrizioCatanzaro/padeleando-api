import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gruposPendientes, ordenarSemillas, generateCupBracket } from '../src/lib/copa.js';
import { applyBracketResult } from '../src/lib/tournamentLogic.js';
import { bracketNodes, countBracketPlayed, expandBracketMatches, bracketStatsByUser } from '../src/lib/profileStats.js';

const pair = (id, zona, extra = {}) => ({ id, p1_id: `${id}a`, p2_id: `${id}b`, status: 'active', zona, ...extra });
const jugado = (a, b, extra = {}) => ({ team1_p1: `${a}a`, team1_p2: `${a}b`, team2_p1: `${b}a`, team2_p2: `${b}b`, score1: 6, score2: 3, ...extra });

test('grupos pendientes: cuenta cruces que faltan por grupo y rueda', () => {
  const pairs = [pair('a', 1), pair('b', 1), pair('c', 1), pair('d', 2), pair('e', 2), pair('f', 2)];
  assert.equal(gruposPendientes(pairs, []), 6);
  assert.equal(gruposPendientes(pairs, [], 2), 12);
  const matches = [jugado('a', 'b'), jugado('c', 'a'), jugado('b', 'c'), jugado('d', 'e')];
  assert.equal(gruposPendientes(pairs, matches), 2);
  assert.equal(gruposPendientes(pairs, matches, 2), 8);
});

test('grupos pendientes: una pareja retirada o un partido sin resultado no cuentan', () => {
  const pairs = [pair('a', 1), pair('b', 1), pair('c', 1, { status: 'withdrawn' }), pair('x', null)];
  assert.equal(gruposPendientes(pairs, [jugado('a', 'b', { score1: null, score2: null })]), 1);
  assert.equal(gruposPendientes(pairs, [jugado('b', 'a')]), 0);
});

test('ordenar semillas: respeta el orden pedido y rechaza otras parejas', () => {
  const propuesta = [{ pair_id: 'a', seed: 1, zona: 1 }, { pair_id: 'b', seed: 2, zona: 2 }, { pair_id: 'c', seed: 3, zona: 1 }];
  assert.equal(ordenarSemillas(propuesta, undefined), propuesta);
  assert.deepEqual(ordenarSemillas(propuesta, ['c', 'a', 'b']).map((r) => [r.pair_id, r.seed, r.zona]), [['c', 1, 1], ['a', 2, 1], ['b', 3, 2]]);
  assert.equal(ordenarSemillas(propuesta, ['a', 'b']), null);
  assert.equal(ordenarSemillas(propuesta, ['a', 'a', 'b']), null);
  assert.equal(ordenarSemillas(propuesta, ['a', 'b', 'z']), null);
  assert.equal(ordenarSemillas(propuesta, 'a,b,c'), null);
});

const seeds = (n) => Array.from({ length: n }, (_, i) => ({ seed: i + 1, pair_id: `p${i + 1}`, pair_name: `P${i + 1}` }));

test('estadísticas: los nodos del cuadro incluyen dieciseisavos y tercer puesto', () => {
  let b = generateCupBracket(seeds(32), { tercerPuesto: true });
  const rondas = new Set(bracketNodes(b).map((m) => m.round));
  assert.deepEqual([...rondas], ['dieciseisavos', 'octavos', 'cuartos', 'semis', 'final', 'tercer']);
  assert.equal(bracketNodes(b).length, 16 + 8 + 4 + 2 + 1 + 1);
  b = applyBracketResult(b, b.dieciseisavos[0].id, 6, 2);
  assert.equal(countBracketPlayed(b), 1);
  assert.equal(countBracketPlayed(null), 0);
});

test('estadísticas: el cuadro de plata suma partidos al perfil sin pisar ids del de oro', () => {
  let oro = generateCupBracket(seeds(4));
  let plata = generateCupBracket(seeds(4).map((s) => ({ ...s, pair_id: `q${s.seed}` })), { kind: 'plata' });
  oro = applyBracketResult(oro, 's0', 6, 1);
  plata = applyBracketResult(plata, 's0', 2, 6);
  const pairs = [
    { id: 'p1', mine: true, my_index: 0, names: ['Yo', 'Compa'], keys: ['u1', 'u2'] },
    { id: 'p4', mine: false, names: ['X', 'Y'], keys: ['x', 'y'] },
    { id: 'q1', mine: true, my_index: 0, names: ['Yo', 'Otro'], keys: ['u1', 'u3'] },
    { id: 'q4', mine: false, names: ['Z', 'W'], keys: ['z', 'w'] },
  ];
  const out = expandBracketMatches([{ tournament_id: 't', bracket: oro, bracket_plata: plata, pairs }]);
  assert.equal(out.length, 2);
  assert.notEqual(out[0].id, out[1].id);
  assert.deepEqual(out.map((m) => m.result).sort(), ['loss', 'win']);
  const porUsuario = bracketStatsByUser([{ bracket: oro, bracket_plata: plata, pairs: pairs.map((p) => ({ id: p.id, user_ids: p.keys })) }]);
  assert.deepEqual(porUsuario.get('u1'), { partidos: 2, victorias: 1 });
});
