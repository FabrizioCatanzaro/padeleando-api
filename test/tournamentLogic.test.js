// Tests de la lógica pura de torneos (src/lib/tournamentLogic.js).
// Correr con: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generatePreviaSchedule, comparePairRows, computeStandings, generateBracket,
  applyBracketResult, clearBracketResult, findBracketMatch,
  previaPendingPairs, isPreviaComplete, isBracketMatchReady, planScheduleRows,
  walkoverMatchesFor, applyBracketWalkovers,
} from '../src/lib/tournamentLogic.js';

// N parejas: pareja i = jugadores a{i} y b{i}.
function makePairs(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `pr${String(i).padStart(2, '0')}`, p1_id: `a${i}`, p2_id: `b${i}`, p1_name: `A${i}`, p2_name: `B${i}`,
  }));
}
const pairOf = (pairs, id) => pairs.find((p) => p.id === id);
function matchRow(pa, pb, s1, s2) {
  return { team1_p1: pa.p1_id, team1_p2: pa.p2_id, team2_p1: pb.p1_id, team2_p2: pb.p2_id, score1: s1, score2: s2 };
}

test('desempate: victorias, diferencia, % de victorias, games a favor', () => {
  const base = { wins: 3, diff: 5, played: 4, gf: 20, pair_id: 'x' };
  const rows = [
    { ...base, pair_id: 'gf',   gf: 25 },
    { ...base, pair_id: 'rate', played: 3 },
    { ...base, pair_id: 'diff', diff: 6 },
    { ...base, pair_id: 'wins', wins: 4, diff: -10, played: 10 },
    { ...base, pair_id: 'base' },
  ];
  rows.sort(comparePairRows);
  assert.deepEqual(rows.map((r) => r.pair_id), ['wins', 'diff', 'rate', 'gf', 'base']);
});

test('más victorias gana aunque haya jugado más partidos', () => {
  const a = { wins: 3, diff: 9, played: 3, gf: 18, pair_id: 'a' };
  const b = { wins: 5, diff: 4, played: 7, gf: 30, pair_id: 'b' };
  assert.ok(comparePairRows(b, a) < 0);
});

test('computeStandings cuenta partidos jugados y asigna seeds', () => {
  const pairs = makePairs(3);
  const [p0, p1, p2] = pairs;
  const st = computeStandings(pairs, [matchRow(p0, p1, 6, 2), matchRow(p0, p2, 6, 4), matchRow(p1, p2, 3, 6)]);
  assert.deepEqual(st.map((s) => [s.pair_id, s.wins, s.played, s.seed]),
    [['pr00', 2, 2, 1], ['pr02', 1, 2, 2], ['pr01', 0, 2, 3]]);
});

for (let n = 8; n <= 16; n++) {
  test(`calendario de la previa con ${n} parejas: 2 partidos por pareja, sin revanchas`, () => {
    const pairs = makePairs(n);
    for (let run = 0; run < 20; run++) {
      const schedule = generatePreviaSchedule(pairs, []);
      const count = new Map(pairs.map((p) => [p.id, 0]));
      const seen = new Set();
      for (const f of schedule) {
        assert.notEqual(f.team1.id, f.team2.id);
        const k = [f.team1.id, f.team2.id].sort().join('|');
        assert.ok(!seen.has(k), `revancha ${k}`);
        seen.add(k);
        count.set(f.team1.id, count.get(f.team1.id) + 1);
        count.set(f.team2.id, count.get(f.team2.id) + 1);
      }
      for (const [id, c] of count) assert.equal(c, 2, `${id} juega ${c}`);
      assert.ok(Math.max(...schedule.map((f) => f.round)) <= (n % 2 ? 3 : 2));
    }
  });
}

test('calendario respeta los partidos ya jugados', () => {
  const pairs = makePairs(8);
  const played = [matchRow(pairs[0], pairs[1], 6, 3), matchRow(pairs[1], pairs[2], 6, 3)];
  const schedule = generatePreviaSchedule(pairs, played);
  const count = new Map(pairs.map((p) => [p.id, 0]));
  for (const f of schedule) {
    count.set(f.team1.id, count.get(f.team1.id) + 1);
    count.set(f.team2.id, count.get(f.team2.id) + 1);
  }
  for (const [, c] of count) assert.equal(c, 2);
  const keys = schedule.map((f) => [f.team1.id, f.team2.id].sort().join('|'));
  assert.equal(keys.filter((k) => k === 'pr00|pr01').length, 1);
});

test('previa completa sólo con 2 partidos por pareja', () => {
  const pairs = makePairs(8);
  assert.equal(isPreviaComplete(pairs, []), false);
  const one = [matchRow(pairs[0], pairs[1], 6, 2)];
  assert.equal(isPreviaComplete(pairs, one), false);
  assert.equal(previaPendingPairs(pairs, one).length, 8);
  const full = [];
  for (let i = 0; i < 8; i++) full.push(matchRow(pairs[i], pairs[(i + 1) % 8], 6, 2));
  assert.equal(isPreviaComplete(pairs, full), true);
});

test('previa impar: completa con una pareja a la que le falta uno', () => {
  const pairs = makePairs(9);
  const ms = [];
  for (let i = 0; i < 8; i++) ms.push(matchRow(pairs[i], pairs[i + 1], 6, 2));
  // 8 cruces en cadena: extremos pr00 y pr08 con 1 partido cada uno.
  assert.equal(isPreviaComplete(pairs, ms), false);
  ms.push(matchRow(pairs[0], pairs[8], 6, 2));
  assert.equal(isPreviaComplete(pairs, ms), true);
});

for (let n = 8; n <= 16; n++) {
  test(`cuadro con ${n} parejas: cada pareja entra una vez y se llega a un campeón`, () => {
    const pairs = makePairs(n);
    const standings = pairs.map((p, i) => ({ pair_id: p.id, pair_name: p.id, wins: n - i, played: 2, diff: 0, gf: 0, seed: i + 1 }));
    let b = generateBracket(standings);
    assert.equal(b.octavos.length, n - 8);
    const entrants = [
      ...b.octavos.flatMap((m) => [m.pair1_id, m.pair2_id]),
      ...b.cuartos.flatMap((m) => [m.pair1_id, m.pair2_id]).filter(Boolean),
    ];
    assert.equal(entrants.length, n);
    assert.equal(new Set(entrants).size, n);

    for (const round of ['octavos', 'cuartos', 'semis', 'final']) {
      const ms = round === 'final' ? [b.final] : b[round];
      for (const m of ms) {
        assert.ok(isBracketMatchReady(findBracketMatch(b, m.id)), `${m.id} sin parejas`);
        b = applyBracketResult(b, m.id, 6, 3);
      }
    }
    assert.equal(b.final.winner_id, 'pr00');
  });
}

test('partido del cuadro sin las dos parejas no está listo', () => {
  const pairs = makePairs(8);
  const b = generateBracket(pairs.map((p, i) => ({ pair_id: p.id, pair_name: p.id, seed: i + 1 })));
  assert.equal(isBracketMatchReady(findBracketMatch(b, 's0')), false);
  assert.equal(isBracketMatchReady(findBracketMatch(b, 'q0')), true);
});

test('cambiar el ganador de un cuarto limpia la semi y la final', () => {
  const pairs = makePairs(8);
  let b = generateBracket(pairs.map((p, i) => ({ pair_id: p.id, pair_name: p.id, seed: i + 1 })));
  for (const id of ['q0', 'q1', 'q2', 'q3', 's0', 's1', 'f0']) b = applyBracketResult(b, id, 6, 3);
  assert.ok(b.final.winner_id);
  b = applyBracketResult(b, 'q0', 3, 6);
  const s0 = findBracketMatch(b, 's0');
  assert.equal(s0.winner_id, null);
  assert.equal(s0.pair1_id, findBracketMatch(b, 'q0').pair2_id);
  assert.equal(b.final.winner_id, null);
  assert.equal(b.final.pair1_id, null);
});

test('borrar un resultado limpia los partidos que dependían de él', () => {
  const pairs = makePairs(8);
  let b = generateBracket(pairs.map((p, i) => ({ pair_id: p.id, pair_name: p.id, seed: i + 1 })));
  for (const id of ['q0', 'q1', 's0']) b = applyBracketResult(b, id, 6, 3);
  b = clearBracketResult(b, 'q1');
  assert.equal(findBracketMatch(b, 'q1').winner_id, null);
  assert.equal(findBracketMatch(b, 's0').pair2_id, null);
  assert.equal(findBracketMatch(b, 's0').winner_id, null);
});

test('planScheduleRows guarda sólo lo que falta y respeta jugados y programados', () => {
  const pairs = makePairs(8);
  const played = [matchRow(pairs[0], pairs[1], 6, 3)];
  // Programado a mano, con los equipos invertidos y los jugadores al revés.
  const scheduled = [{ id: 's1', round: null, team1_p1: 'b3', team1_p2: 'a3', team2_p1: 'a2', team2_p2: 'b2' }];
  const schedule = generatePreviaSchedule(pairs, [...played, ...scheduled]);
  const { toInsert, toUpdate } = planScheduleRows(schedule, pairs, played, scheduled);

  // 8 parejas x 2 partidos = 8 cruces: 1 jugado + 1 programado + 6 nuevos.
  assert.equal(schedule.length, 8);
  assert.equal(toInsert.length, 6);
  assert.deepEqual(toUpdate.map((u) => u.id), ['s1']);
  assert.ok(Number.isInteger(toUpdate[0].round));

  const count = new Map(pairs.map((p) => [p.p1_id, 0]));
  const add = (t) => count.set(t[0], count.get(t[0]) + 1);
  for (const r of toInsert) { add(r.team1); add(r.team2); assert.ok(Number.isInteger(r.round)); }
  for (const p of [...played, ...scheduled]) {
    for (const id of [p.team1_p1, p.team2_p1, p.team1_p2, p.team2_p2]) if (count.has(id)) count.set(id, count.get(id) + 1);
  }
  for (const [, c] of count) assert.equal(c, 2);
});

test('planScheduleRows no vuelve a insertar un calendario ya guardado', () => {
  const pairs = makePairs(10);
  const first = planScheduleRows(generatePreviaSchedule(pairs, []), pairs, [], []);
  const saved = first.toInsert.map((r, i) => ({
    id: `s${i}`, round: r.round, team1_p1: r.team1[0], team1_p2: r.team1[1], team2_p1: r.team2[0], team2_p2: r.team2[1],
  }));
  const again = planScheduleRows(generatePreviaSchedule(pairs, saved), pairs, [], saved);
  assert.equal(again.toInsert.length, 0);
});

// ── Bajas y W.O. ──────────────────────────────────────────────────────────────

test('W.O.: los programados de la pareja retirada pasan a 6-0 para el rival', () => {
  const pairs = makePairs(4);
  const scheduled = [
    { id: 's1', court: 2, team1_p1: 'b0', team1_p2: 'a0', team2_p1: 'a1', team2_p2: 'b1' },
    { id: 's2', court: null, team1_p1: 'a2', team1_p2: 'b2', team2_p1: 'a0', team2_p2: 'b0' },
    { id: 's3', court: null, team1_p1: 'a2', team1_p2: 'b2', team2_p1: 'a3', team2_p2: 'b3' },
  ];
  const wo = walkoverMatchesFor(pairs[0], scheduled);
  assert.deepEqual(wo.map((w) => [w.scheduled_id, w.score1, w.score2, w.court]), [['s1', 0, 6, 2], ['s2', 6, 0, null]]);
});

test('previa: una pareja retirada no queda pendiente ni recibe cruces nuevos', () => {
  const pairs = makePairs(9);
  pairs[8].status = 'withdrawn';
  // pr08 jugó 1 partido (perdió contra pr00) y se retiró.
  const played = [matchRow(pairs[0], pairs[8], 6, 0)];
  const schedule = generatePreviaSchedule(pairs, played);
  const count = new Map(pairs.map((p) => [p.id, 0]));
  for (const f of schedule) {
    count.set(f.team1.id, count.get(f.team1.id) + 1);
    count.set(f.team2.id, count.get(f.team2.id) + 1);
  }
  assert.equal(count.get('pr08'), 1, 'la retirada sólo tiene el partido ya jugado');
  // Cupo pendiente impar (1 + 7 x 2): a lo sumo una pareja se queda con 1.
  const activos = [...count].filter(([id]) => id !== 'pr08').map(([, c]) => c);
  assert.ok(activos.every((c) => c === 1 || c === 2));
  assert.ok(activos.filter((c) => c === 1).length <= 1);
  assert.equal(previaPendingPairs(pairs, played).some((p) => p.id === 'pr08'), false);
});

test('cuadro: la retirada toma el último seed y su rival avanza por W.O.', () => {
  const pairs = makePairs(8);
  pairs[0].status = 'withdrawn';
  const matches = [];
  for (let i = 0; i < 8; i++) matches.push(matchRow(pairs[i], pairs[(i + 1) % 8], 6, 2));
  const standings = computeStandings(pairs, matches);
  assert.equal(standings[7].pair_id, 'pr00');
  const b = generateBracket(standings);
  assert.deepEqual(b.withdrawn_pair_ids, ['pr00']);
  const q0 = findBracketMatch(b, 'q0');           // seed 1 vs seed 8 (la retirada)
  assert.equal(q0.walkover, true);
  assert.equal(q0.winner_id, standings[0].pair_id);
  assert.deepEqual([q0.score1, q0.score2], [6, 0]);
  assert.equal(findBracketMatch(b, 's0').pair1_id, standings[0].pair_id);
});

test('cuadro: retirarse con el cuadro en juego da W.O. en el cruce siguiente', () => {
  const pairs = makePairs(8);
  let b = generateBracket(pairs.map((p, i) => ({ pair_id: p.id, pair_name: p.id, seed: i + 1 })));
  b = applyBracketResult(b, 'q0', 6, 3);   // gana pr00
  b = { ...b, withdrawn_pair_ids: ['pr00'] };
  b = applyBracketWalkovers(b);
  assert.equal(findBracketMatch(b, 's0').winner_id, null, 'falta el rival de la semi');
  b = applyBracketWalkovers(applyBracketResult(b, 'q1', 6, 3));
  const s0 = findBracketMatch(b, 's0');
  assert.equal(s0.walkover, true);
  assert.equal(s0.winner_id, findBracketMatch(b, 'q1').winner_id);
  // Borrar ese W.O. no tiene efecto: se vuelve a resolver.
  b = applyBracketWalkovers(clearBracketResult(b, 's0'));
  assert.equal(findBracketMatch(b, 's0').walkover, true);
});
