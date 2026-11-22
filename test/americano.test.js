// Tests del cuadro del americano según la cantidad de parejas (src/lib/americano.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateAmericanoBracket, americanoPairsError, AMERICANO_MIN_PAIRS, AMERICANO_MAX_PAIRS } from '../src/lib/americano.js';
import { generateBracket, generatePreviaSchedule, applyBracketResult, findBracketMatch, isBracketMatchReady } from '../src/lib/tournamentLogic.js';

const RONDAS = ['dieciseisavos', 'octavos', 'cuartos', 'semis'];
const standingsDe = (n) => Array.from({ length: n }, (_, i) => ({
  pair_id: `pr${String(i).padStart(2, '0')}`, pair_name: `P${i + 1}`, wins: n - i, played: 2, diff: 0, gf: 0,
}));
const makePairs = (n) => Array.from({ length: n }, (_, i) => ({
  id: `pr${i}`, p1_id: `a${i}`, p2_id: `b${i}`, p1_name: `A${i}`, p2_name: `B${i}`,
}));

test('límites de parejas: 4 a 32', () => {
  assert.equal(AMERICANO_MIN_PAIRS, 4);
  assert.equal(AMERICANO_MAX_PAIRS, 32);
  assert.ok(americanoPairsError(3));
  assert.equal(americanoPairsError(4), null);
  assert.equal(americanoPairsError(32), null);
  assert.ok(americanoPairsError(33));
  assert.throws(() => generateAmericanoBracket(standingsDe(3)));
  assert.throws(() => generateAmericanoBracket(standingsDe(33)));
});

for (let n = AMERICANO_MIN_PAIRS; n <= AMERICANO_MAX_PAIRS; n++) {
  test(`americano de ${n} parejas: entran todas una vez y gana la primera`, () => {
    const standings = standingsDe(n);
    let b = generateAmericanoBracket(standings);
    const entrantes = [...RONDAS.flatMap((r) => (b[r] ?? []).flatMap((m) => [m.pair1_id, m.pair2_id])), b.final.pair1_id, b.final.pair2_id]
      .filter(Boolean);
    assert.equal(entrantes.length, n);
    assert.equal(new Set(entrantes).size, n);
    assert.equal(b.total_pairs, n);
    assert.ok(b.kind === undefined);

    for (const r of [...RONDAS, 'final']) {
      for (const m of r === 'final' ? [b.final] : (b[r] ?? [])) {
        const actual = findBracketMatch(b, m.id);
        assert.ok(isBracketMatchReady(actual), `${m.id} sin parejas`);
        const gana1 = Number(actual.pair1_id.slice(2)) < Number(actual.pair2_id.slice(2));
        b = applyBracketResult(b, m.id, gana1 ? 6 : 3, gana1 ? 3 : 6);
      }
    }
    assert.equal(b.final.winner_id, 'pr00');
  });
}

test('de 8 a 16 parejas el cuadro es el mismo de siempre', () => {
  for (let n = 8; n <= 16; n++) {
    const s = standingsDe(n);
    const { generated_at: _a, ...nuevo } = generateAmericanoBracket(s);
    const { generated_at: _b, ...viejo } = generateBracket(s);
    assert.deepEqual(nuevo, viejo);
  }
});

test('con 6 parejas las 2 primeras pasan directo a semifinales', () => {
  const b = generateAmericanoBracket(standingsDe(6));
  assert.equal(b.cuartos.length, 2);
  assert.equal(b.direct_count, 2);
  const directas = b.semis.flatMap((m) => [m.pair1_id, m.pair2_id]).filter(Boolean);
  assert.deepEqual(directas.sort(), ['pr00', 'pr01']);
});

test('con 20 parejas se juegan 16avos y las 12 primeras pasan directo a octavos', () => {
  const b = generateAmericanoBracket(standingsDe(20));
  assert.equal(b.dieciseisavos.length, 4);
  assert.equal(b.octavos.length, 8);
  assert.equal(b.direct_count, 12);
  const directas = b.octavos.flatMap((m) => [m.pair1_id, m.pair2_id]).filter(Boolean);
  assert.equal(directas.length, 12);
});

test('una pareja retirada pierde por W.O. en el cuadro nuevo', () => {
  const s = standingsDe(6);
  s[5] = { ...s[5], withdrawn: true };
  const b = generateAmericanoBracket(s);
  const cruce = b.cuartos.find((m) => m.pair2_id === 'pr05');
  assert.equal(cruce.winner_id, cruce.pair1_id);
  assert.equal(cruce.walkover, true);
});

for (const n of [4, 5, 7, 17, 32]) {
  test(`previa con ${n} parejas: cada una juega 2 partidos`, () => {
    const pairs = makePairs(n);
    const schedule = generatePreviaSchedule(pairs, []);
    const cuenta = new Map(pairs.map((p) => [p.id, 0]));
    for (const m of schedule) { cuenta.set(m.team1.id, cuenta.get(m.team1.id) + 1); cuenta.set(m.team2.id, cuenta.get(m.team2.id) + 1); }
    assert.ok([...cuenta.values()].every((c) => c === 2));
  });
}
