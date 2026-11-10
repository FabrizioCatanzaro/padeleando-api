// Tests del armado de fechas de la liga por fechas (src/lib/ligaFechas.js).
// Correr con: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateFecha, validateFecha, crossesFromRows, fechaHistory,
  scheduledIdsToCancel, fechaDatesError,
} from '../src/lib/ligaFechas.js';

// N parejas: pareja i = jugadores a{i} y b{i}.
function makePairs(n) {
  return Array.from({ length: n }, (_, i) => ({ id: `pr${String(i).padStart(2, '0')}`, p1_id: `a${i}`, p2_id: `b${i}` }));
}
// Generador reproducible para que un test que falla falle siempre igual.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const key = (a, b) => [a, b].sort().join('|');

// Arma fechas una tras otra hasta que no quedan cruces. Devuelve la historia.
function playSeason(pairs, rng, { allowRematch = false, maxFechas = 40 } = {}) {
  const crosses = [];
  const fechas = [];
  for (let i = 0; i < maxFechas; i++) {
    let f;
    try { f = generateFecha({ pairs, crosses, allowRematch, rng }); } catch { break; }
    fechas.push(f);
    for (const [a, b] of f.crosses) crosses.push({ a, b, round: f.round });
  }
  return { crosses, fechas };
}

for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 16]) {
  test(`temporada sin repetir con ${n} parejas: todos contra todos, una vez por fecha`, () => {
    const pairs = makePairs(n);
    for (let seed = 1; seed <= 5; seed++) {
      const { crosses, fechas } = playSeason(pairs, seeded(seed * 97 + n));
      const expectedFechas = n % 2 === 0 ? n - 1 : n;
      assert.equal(fechas.length, expectedFechas, 'cantidad de fechas');
      assert.equal(crosses.length, (n * (n - 1)) / 2, 'cantidad de partidos');
      assert.equal(new Set(crosses.map((c) => key(c.a, c.b))).size, crosses.length, 'sin repetidos');
      const libres = new Map(pairs.map((p) => [p.id, 0]));
      fechas.forEach((f, i) => {
        assert.equal(f.round, i + 1);
        assert.equal(f.completable, true);
        assert.equal(f.libres.length, n % 2);
        const jugando = f.crosses.flat();
        assert.equal(new Set(jugando).size, jugando.length, 'una pareja juega una vez por fecha');
        f.libres.forEach((id) => libres.set(id, libres.get(id) + 1));
      });
      if (n % 2 === 1) assert.ok([...libres.values()].every((v) => v === 1), 'cada pareja libre una vez');
    }
  });
}

test('con cruces repetidos la libre rota y los cruces se reparten parejo', () => {
  const pairs = makePairs(7);
  const { fechas, crosses } = playSeason(pairs, seeded(3), { allowRematch: true, maxFechas: 14 });
  assert.equal(fechas.length, 14);
  const libres = new Map(pairs.map((p) => [p.id, 0]));
  fechas.forEach((f) => {
    assert.equal(f.completable, null);
    assert.equal(f.libres.length, 1);
    libres.set(f.libres[0], libres.get(f.libres[0]) + 1);
  });
  assert.ok([...libres.values()].every((v) => v === 2), 'cada pareja libre dos veces en 14 fechas');
  const veces = new Map();
  crosses.forEach((c) => veces.set(key(c.a, c.b), (veces.get(key(c.a, c.b)) ?? 0) + 1));
  assert.equal(veces.size, 21, 'todos los cruces aparecen');
  assert.ok([...veces.values()].every((v) => v === 2), 'cada cruce dos veces');
});

test('la pareja retirada no juega más y la temporada sigue sin repetir', () => {
  const pairs = makePairs(8);
  const rng = seeded(11);
  const crosses = [];
  for (let i = 0; i < 3; i++) {
    const f = generateFecha({ pairs, crosses, rng });
    f.crosses.forEach(([a, b]) => crosses.push({ a, b, round: f.round }));
  }
  pairs[0].status = 'withdrawn';
  const seen = new Set(crosses.map((c) => key(c.a, c.b)));
  for (let i = 0; i < 10; i++) {
    let f;
    try { f = generateFecha({ pairs, crosses, rng }); } catch { break; }
    for (const [a, b] of f.crosses) {
      assert.ok(a !== 'pr00' && b !== 'pr00', 'la retirada no juega');
      assert.ok(!seen.has(key(a, b)), 'sin repetidos');
      seen.add(key(a, b));
      crosses.push({ a, b, round: f.round });
    }
    assert.ok(!f.libres.includes('pr00'));
  }
  // Las 7 que siguen se cruzan todas entre sí.
  const activos = pairs.slice(1).map((p) => p.id);
  for (let i = 0; i < activos.length; i++) {
    for (let j = i + 1; j < activos.length; j++) assert.ok(seen.has(key(activos[i], activos[j])));
  }
});

test('sin cruces posibles avisa', () => {
  const pairs = makePairs(2);
  assert.throws(() => generateFecha({ pairs, crosses: [{ a: 'pr00', b: 'pr01', round: 1 }] }), /todos los cruces/);
  assert.throws(() => generateFecha({ pairs: makePairs(1) }), /al menos 2/);
});

test('validateFecha: errores de una fecha armada a mano', () => {
  const pairs = makePairs(4);
  pairs[3].status = 'withdrawn';
  const crosses = [{ a: 'pr00', b: 'pr01', round: 1 }];
  const { errors } = validateFecha({
    pairs, crosses,
    proposed: [['pr00', 'pr01'], ['pr00', 'pr02'], ['pr02', 'pr02'], ['pr03', 'pr01'], ['x', 'pr01']],
  });
  assert.ok(errors.includes('Ese cruce ya se jugó o ya está programado'));
  assert.ok(errors.includes('Una pareja está en dos cruces de la misma fecha'));
  assert.ok(errors.includes('Una pareja no puede jugar contra sí misma'));
  assert.ok(errors.includes('Una de las parejas se retiró del torneo'));
  assert.ok(errors.includes('Una de las parejas no es de este torneo'));
  const ok = validateFecha({ pairs, crosses, proposed: [['pr00', 'pr01']], allowRematch: true });
  assert.deepEqual(ok.errors, []);
});

test('validateFecha: avisa libres de más, libre repetida y temporada incompleta', () => {
  const pairs = makePairs(6);
  const libresDeMas = validateFecha({ pairs, proposed: [['pr00', 'pr01']] });
  assert.deepEqual(libresDeMas.errors, []);
  assert.ok(libresDeMas.warnings.includes('Quedan 4 parejas sin jugar esta fecha'));
  assert.equal(libresDeMas.completable, false);

  const bien = validateFecha({ pairs, proposed: [['pr00', 'pr01'], ['pr02', 'pr03'], ['pr04', 'pr05']] });
  assert.deepEqual(bien.warnings, []);
  assert.equal(bien.completable, true);

  // 5 parejas: pr04 ya quedó libre en la fecha 1 y vuelve a quedar libre.
  const cinco = makePairs(5);
  const f1 = [{ a: 'pr00', b: 'pr01', round: 1 }, { a: 'pr02', b: 'pr03', round: 1 }];
  const repite = validateFecha({ pairs: cinco, crosses: f1, proposed: [['pr00', 'pr02'], ['pr01', 'pr03']] });
  assert.ok(repite.warnings.includes('Una pareja queda libre otra vez antes que el resto'));
});

test('después de una fecha a mano que rompe el todos contra todos, el azar sigue sin repetir', () => {
  const pairs = makePairs(6);
  // Fecha 1 con solo 2 partidos: pr04 y pr05 quedan sin jugar.
  const crosses = [{ a: 'pr00', b: 'pr01', round: 1 }, { a: 'pr02', b: 'pr03', round: 1 }];
  const f = generateFecha({ pairs, crosses, rng: seeded(5) });
  assert.equal(f.round, 2);
  for (const [a, b] of f.crosses) assert.ok(![key('pr00', 'pr01'), key('pr02', 'pr03')].includes(key(a, b)));
  assert.equal(new Set(f.crosses.flat()).size, f.crosses.length * 2);
});

test('crossesFromRows pasa filas con jugadores a cruces entre parejas', () => {
  const pairs = makePairs(3);
  const rows = [
    { team1_p1: 'b0', team1_p2: 'a0', team2_p1: 'a1', team2_p2: 'b1', round: 2 },
    { team1_p1: 'a0', team1_p2: 'a1', team2_p1: 'b0', team2_p2: 'b1', round: 2 },
    { team1_p1: 'a2', team1_p2: 'b2', team2_p1: 'a0', team2_p2: 'b0' },
  ];
  assert.deepEqual(crossesFromRows(pairs, rows), [
    { a: 'pr00', b: 'pr01', round: 2 },
    { a: 'pr02', b: 'pr00', round: null },
  ]);
});

test('fechaHistory cuenta cruces y libres por fecha', () => {
  const pairs = makePairs(3);
  const h = fechaHistory(pairs, [
    { a: 'pr00', b: 'pr01', round: 1 },
    { a: 'pr00', b: 'pr02', round: 2 },
    { a: 'pr01', b: 'pr00', round: null },
  ]);
  assert.equal(h.faced.get('pr00|pr01'), 2);
  assert.equal(h.lastRound, 2);
  assert.deepEqual([...h.libreCount], [['pr00', 0], ['pr01', 1], ['pr02', 1]]);
});

test('scheduledIdsToCancel devuelve solo los programados de la pareja', () => {
  const rows = [
    { id: 's1', team1_p1: 'a0', team1_p2: 'b0', team2_p1: 'a1', team2_p2: 'b1' },
    { id: 's2', team1_p1: 'a1', team1_p2: 'b1', team2_p1: 'a2', team2_p2: 'b2' },
    { id: 's3', team1_p1: 'a2', team1_p2: 'b2', team2_p1: 'b0', team2_p2: 'a0' },
  ];
  assert.deepEqual(scheduledIdsToCancel({ p1_id: 'a0', p2_id: 'b0' }, rows), ['s1', 's3']);
});

test('fechaDatesError valida los días de la fecha', () => {
  assert.equal(fechaDatesError('2026-11-14', '2026-11-15'), null);
  assert.equal(fechaDatesError('2026-11-14', null), null);
  assert.equal(fechaDatesError('2026-11-14', ''), null);
  assert.match(fechaDatesError('', null), /primer día/);
  assert.match(fechaDatesError('2026-02-30', null), /primer día/);
  assert.match(fechaDatesError('2026-11-14', '2026-13-01'), /no es válido/);
  assert.match(fechaDatesError('2026-11-15', '2026-11-14'), /anterior/);
});
