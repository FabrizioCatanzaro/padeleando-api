import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  sortearZonas, validateZonas, zonasSizeError, generateCopaFecha, validateCopaFecha,
  copaStandings, zonaStandings, rankClasificados, compareCopaRows, compareCopaRowsPorPartido,
  primeraRonda, seedCuadro, seedCuadroDirecto, generateCupBracket, usaFechas, soloParejas,
} from '../src/lib/copa.js';
import { applyBracketResult, clearBracketResult, findBracketMatch, isBracketMatchReady } from '../src/lib/tournamentLogic.js';

// Generador con semilla: los sorteos de los tests son reproducibles.
const seeded = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
const pair = (id, extra = {}) => ({ id, p1_id: `${id}a`, p2_id: `${id}b`, p1_name: `${id}a`, p2_name: `${id}b`, status: 'active', ...extra });
const mk = (n, extra = () => ({})) => Array.from({ length: n }, (_, i) => pair(`p${String(i + 1).padStart(2, '0')}`, extra(i)));
const row = (a, b, round = null, extra = {}) => ({ team1_p1: `${a}a`, team1_p2: `${a}b`, team2_p1: `${b}a`, team2_p2: `${b}b`, round, ...extra });
const conZonas = (pairs, sorteo) => pairs.map((p) => ({ ...p, zona: sorteo.find((s) => s.pair_id === p.id)?.zona ?? null }));
const sizes = (sorteo, zonas) => Array.from({ length: zonas }, (_, z) => sorteo.filter((s) => s.zona === z + 1).length);

test('sorteo: reparte parejo y no repite parejas', () => {
  for (const [n, z] of [[6, 2], [13, 4], [32, 8], [17, 3], [9, 3]]) {
    const sorteo = sortearZonas({ pairs: mk(n), zonas: z, rng: seeded(n) });
    assert.equal(new Set(sorteo.map((s) => s.pair_id)).size, n);
    const t = sizes(sorteo, z);
    assert.ok(Math.max(...t) - Math.min(...t) <= 1, `${n} en ${z}: ${t}`);
  }
});

test('sorteo: las cabezas de serie van una por grupo, en serpentina', () => {
  const pairs = mk(16, (i) => (i < 6 ? { cabeza_serie: i + 1 } : {}));
  const sorteo = sortearZonas({ pairs, zonas: 4, rng: seeded(7) });
  const z = (id) => sorteo.find((s) => s.pair_id === id).zona;
  assert.deepEqual(['p01', 'p02', 'p03', 'p04', 'p05', 'p06'].map(z), [1, 2, 3, 4, 4, 3]);
  assert.deepEqual(sizes(sorteo, 4), [4, 4, 4, 4]);
});

test('sorteo: las retiradas no entran y el tamaño de grupo se valida', () => {
  const pairs = mk(7, (i) => (i === 0 ? { status: 'withdrawn' } : {}));
  const sorteo = sortearZonas({ pairs, zonas: 2, rng: seeded(1) });
  assert.equal(sorteo.length, 6);
  assert.match(zonasSizeError(5, 2), /Bajá la cantidad de grupos/);
  assert.match(zonasSizeError(13, 2), /Subí la cantidad de grupos/);
  assert.equal(zonasSizeError(12, 2), null);
  assert.throws(() => sortearZonas({ pairs: mk(5), zonas: 2 }), /Bajá/);
});

test('zonas a mano: errores y avisos', () => {
  const pairs = mk(8, (i) => (i < 2 ? { cabeza_serie: i + 1 } : {}));
  const ok = pairs.map((p, i) => ({ pair_id: p.id, zona: (i % 2) + 1 }));
  assert.deepEqual(validateZonas({ pairs, zonas: 2, assignment: ok }), { errors: [], warnings: [] });
  const falta = validateZonas({ pairs, zonas: 2, assignment: ok.slice(1) });
  assert.ok(falta.errors.includes('Todas las parejas tienen que estar en un grupo'));
  const chico = validateZonas({ pairs, zonas: 2, assignment: pairs.map((p, i) => ({ pair_id: p.id, zona: i < 6 ? 1 : 2 })) });
  assert.ok(chico.errors.some((e) => /al menos 3/.test(e)));
  const fuera = validateZonas({ pairs, zonas: 2, assignment: ok.map((a, i) => (i === 0 ? { ...a, zona: 3 } : a)) });
  assert.ok(fuera.errors.includes('Uno de los grupos no existe'));
  const juntas = pairs.map((p, i) => ({ pair_id: p.id, zona: [0, 1, 2, 3].includes(i) ? 1 : 2 }));
  assert.ok(validateZonas({ pairs, zonas: 2, assignment: juntas }).warnings.some((w) => /cabezas de serie/.test(w)));
  const despareja = mk(9).map((p, i) => ({ pair_id: p.id, zona: i < 6 ? 1 : 2 }));
  assert.ok(validateZonas({ pairs: mk(9), zonas: 2, assignment: despareja }).warnings.includes('Los grupos quedan desparejos'));
});

// Juega la fase de grupos entera y devuelve los cruces de cada fecha.
function jugarGrupos(pairs, ruedas, seed = 3) {
  const rows = [];
  const fechas = [];
  for (let i = 0; i < 40; i++) {
    let f;
    try { f = generateCopaFecha({ pairs, rows, ruedas, rng: seeded(seed + i) }); } catch { break; }
    fechas.push(f);
    for (const [a, b] of f.crosses) rows.push(row(a, b, f.round));
  }
  return { rows, fechas };
}
const zonaDe = (pairs, id) => pairs.find((p) => p.id === id).zona;
const cuenta = (rows) => rows.reduce((m, r) => { const k = [r.team1_p1, r.team2_p1].sort().join('|'); m.set(k, (m.get(k) ?? 0) + 1); return m; }, new Map());

test('fechas: dos grupos de 4 a una rueda se completan en 3 fechas sin cruzar grupos', () => {
  const pairs = conZonas(mk(8), sortearZonas({ pairs: mk(8), zonas: 2, rng: seeded(5) }));
  const { rows, fechas } = jugarGrupos(pairs, 1);
  assert.equal(fechas.length, 3);
  assert.deepEqual(fechas.map((f) => [f.round, f.crosses.length]), [[1, 4], [2, 4], [3, 4]]);
  for (const f of fechas) for (const [a, b] of f.crosses) assert.equal(zonaDe(pairs, a), zonaDe(pairs, b));
  assert.equal(rows.length, 12);
  assert.ok([...cuenta(rows).values()].every((n) => n === 1));
});

test('fechas: a dos ruedas cada cruce se juega dos veces', () => {
  const pairs = conZonas(mk(8), sortearZonas({ pairs: mk(8), zonas: 2, rng: seeded(5) }));
  const { rows, fechas } = jugarGrupos(pairs, 2);
  assert.equal(fechas.length, 6);
  assert.equal(rows.length, 24);
  assert.ok([...cuenta(rows).values()].every((n) => n === 2));
});

test('fechas: en un grupo impar queda una pareja libre y rota', () => {
  const pairs = conZonas(mk(7), sortearZonas({ pairs: mk(7), zonas: 2, rng: seeded(2) }));
  const { rows, fechas } = jugarGrupos(pairs, 1);
  assert.equal(rows.length, 6 + 3);
  assert.ok(fechas.every((f) => f.completable));
  const libres = fechas.flatMap((f) => f.libres);
  assert.equal(new Set(libres).size, libres.length);
});

test('fechas: una baja saca a la pareja del armado y el grupo terminado no suma cruces', () => {
  const base = conZonas(mk(8), sortearZonas({ pairs: mk(8), zonas: 2, rng: seeded(5) }));
  const baja = base.find((p) => p.zona === 1).id;
  const pairs = base.map((p) => (p.id === baja ? { ...p, status: 'withdrawn' } : p));
  const { rows, fechas } = jugarGrupos(pairs, 1);
  assert.ok(rows.every((r) => !r.team1_p1.startsWith(baja) && !r.team2_p1.startsWith(baja)));
  assert.equal(rows.length, 3 + 6);
  assert.throws(() => generateCopaFecha({ pairs, rows, ruedas: 1 }), /Ya se jugaron todos los cruces/);
  assert.ok(fechas.length >= 3);
});

test('fecha a mano: mismo grupo y tope de ruedas', () => {
  const pairs = mk(8).map((p, i) => ({ ...p, zona: i < 4 ? 1 : 2 }));
  const cruzado = validateCopaFecha({ pairs, proposed: [['p01', 'p05']] });
  assert.ok(cruzado.errors.includes('Las dos parejas tienen que ser del mismo grupo'));
  const rows = [row('p01', 'p02', 1)];
  assert.ok(validateCopaFecha({ pairs, rows, proposed: [['p01', 'p02']], ruedas: 1 }).errors.some((e) => /ya se jugó/.test(e)));
  assert.deepEqual(validateCopaFecha({ pairs, rows, proposed: [['p01', 'p02']], ruedas: 2 }).errors, []);
  const dos = [...rows, row('p02', 'p01', 2)];
  assert.ok(validateCopaFecha({ pairs, rows: dos, proposed: [['p01', 'p02']], ruedas: 2 }).errors.some((e) => /ya se jugó/.test(e)));
  const ok = validateCopaFecha({ pairs, proposed: [['p01', 'p02'], ['p03', 'p04'], ['p05', 'p06'], ['p07', 'p08']] });
  assert.deepEqual([ok.errors, ok.libres], [[], []]);
});

const res = (a, b, s1, s2, extra = {}) => ({ ...row(a, b), score1: s1, score2: s2, ...extra });

test('tabla: puntos, victorias, sets y games', () => {
  const pairs = mk(3).map((p) => ({ ...p, zona: 1 }));
  const matches = [
    res('p01', 'p02', 2, 1, { sets_format: 3, sets: [{ s1: 6, s2: 4 }, { s1: 3, s2: 6 }, { s1: 6, s2: 2 }] }),
    res('p02', 'p03', 6, 3),
    res('p03', 'p01', 6, 0, { walkover: true }),
  ];
  const t = copaStandings(pairs, matches, { win: 3, loss: 1 });
  const by = Object.fromEntries(t.map((r) => [r.pair_id, r]));
  assert.deepEqual([by.p01.sf, by.p01.sc, by.p01.gf, by.p01.gc], [2, 2, 15, 18]);
  assert.deepEqual([by.p01.points, by.p02.points, by.p03.points], [3, 4, 4]);
  assert.deepEqual([by.p02.sd, by.p02.gd], [0, 0]);
  assert.deepEqual([by.p03.sd, by.p03.gd], [0, 3]);
  assert.deepEqual(t.map((r) => [r.pair_id, r.pos]), [['p03', 1], ['p02', 2], ['p01', 3]]);
});

test('tabla: empate en puntos y victorias se define por sets y después por games', () => {
  const a = { pair_id: 'a', points: 6, wins: 2, sd: 2, gd: 1, gf: 20 };
  const b = { pair_id: 'b', points: 6, wins: 2, sd: 1, gd: 9, gf: 30 };
  const c = { pair_id: 'c', points: 6, wins: 2, sd: 2, gd: 5, gf: 10 };
  assert.deepEqual([b, a, c].sort(compareCopaRows).map((r) => r.pair_id), ['c', 'a', 'b']);
});

test('tabla: entre grupos de distinto tamaño se compara por partido', () => {
  const chico = { pair_id: 'a', played: 2, points: 6, wins: 2, sd: 2, gd: 6, gf: 12 };
  const grande = { pair_id: 'b', played: 3, points: 6, wins: 2, sd: 1, gd: 8, gf: 20 };
  assert.ok(compareCopaRows(chico, grande) < 0);
  assert.ok(compareCopaRowsPorPartido(chico, grande) < 0);
  const mejor = { ...grande, points: 9, wins: 3, sd: 6 };
  assert.ok(compareCopaRowsPorPartido(chico, mejor) > 0);
  assert.ok(compareCopaRowsPorPartido(chico, { ...mejor, sd: 2 }) < 0);
});

// Tres grupos de 3: gana la pareja de menor número y cada grupo suma más games que el anterior.
function tresGrupos() {
  const pairs = mk(9).map((p, i) => ({ ...p, zona: Math.floor(i / 3) + 1 }));
  const matches = [];
  for (let z = 0; z < 3; z++) {
    const [a, b, c] = [0, 1, 2].map((k) => pairs[z * 3 + k].id);
    matches.push(res(a, b, 6, z), res(a, c, 6, z), res(b, c, 6, z + 1));
  }
  return { pairs, matches };
}

test('clasificación: primeros, segundos, mejores siguientes y resto', () => {
  const { pairs, matches } = tresGrupos();
  const tablas = zonaStandings(pairs, matches);
  assert.deepEqual(tablas.map((t) => t.rows.map((r) => r.pair_id)), [['p01', 'p02', 'p03'], ['p04', 'p05', 'p06'], ['p07', 'p08', 'p09']]);
  const { clasificados, resto } = rankClasificados(tablas, { clasifican: 1, mejores_extra: 2 });
  assert.deepEqual(clasificados.map((r) => [r.pair_id, r.via, r.seed]), [
    ['p01', 'directo', 1], ['p04', 'directo', 2], ['p07', 'directo', 3], ['p08', 'extra', 4], ['p05', 'extra', 5],
  ]);
  assert.deepEqual(resto.map((r) => r.pair_id), ['p02', 'p09', 'p06', 'p03']);
});

test('clasificación: una pareja retirada no clasifica', () => {
  const { pairs, matches } = tresGrupos();
  const conBaja = pairs.map((p) => (p.id === 'p01' ? { ...p, status: 'withdrawn' } : p));
  const { clasificados } = rankClasificados(zonaStandings(conBaja, matches), { clasifican: 1, mejores_extra: 0 });
  assert.deepEqual(clasificados.map((r) => r.pair_id), ['p04', 'p07', 'p02']);
});

test('siembra: evita cruces del mismo grupo en la primera ronda', () => {
  const dos = [1, 2, 1, 2].map((zona, i) => ({ pair_id: `c${i + 1}`, zona }));
  const s = seedCuadro(dos);
  for (const [a, b] of primeraRonda(4)) assert.notEqual(s[a - 1].zona, s[b - 1].zona);
  assert.deepEqual(s.map((r) => r.seed), [1, 2, 3, 4]);
  const ocho = [1, 2, 3, 4, 4, 3, 2, 1].map((zona, i) => ({ pair_id: `c${i + 1}`, zona }));
  const s8 = seedCuadro(ocho);
  assert.equal(new Set(s8.map((r) => r.pair_id)).size, 8);
  for (const [a, b] of primeraRonda(8)) assert.notEqual(s8[a - 1].zona, s8[b - 1].zona);
  assert.deepEqual(s8.slice(0, 4).map((r) => r.pair_id), ['c1', 'c2', 'c3', 'c4']);
});

test('siembra de la copa de cuadro: cabezas primero', () => {
  const pairs = mk(6, (i) => (i === 4 ? { cabeza_serie: 1 } : i === 2 ? { cabeza_serie: 2 } : {}));
  const s = seedCuadroDirecto({ pairs, rng: seeded(9) });
  assert.deepEqual(s.slice(0, 2).map((r) => r.pair_id), ['p05', 'p03']);
  assert.equal(new Set(s.map((r) => r.pair_id)).size, 6);
});

const seeds = (n) => Array.from({ length: n }, (_, i) => ({ pair_id: `s${i + 1}`, pair_name: `S${i + 1}` }));
const todos = (b) => [...b.dieciseisavos, ...b.octavos, ...b.cuartos, ...b.semis, b.final, ...(b.tercer ? [b.tercer] : [])];
// Juega el cuadro entero; gana siempre la mejor siembra.
function jugar(b) {
  const num = (id) => Number(String(id).slice(1));
  for (let i = 0; i < 80; i++) {
    const m = todos(b).find((x) => x.winner_id == null && isBracketMatchReady(x));
    if (!m) break;
    const gana1 = num(m.pair1_id) < num(m.pair2_id);
    b = applyBracketResult(b, m.id, gana1 ? 6 : 2, gana1 ? 2 : 6);
  }
  return b;
}

test('cuadro: de 2 a 32 parejas, cada una entra una vez y se juegan n-1 partidos', () => {
  for (let n = 2; n <= 32; n++) {
    const b = generateCupBracket(seeds(n));
    const ids = todos(b).flatMap((m) => [m.pair1_id, m.pair2_id]).filter(Boolean);
    assert.equal(new Set(ids).size, n, `n=${n}`);
    assert.equal(ids.length, n, `n=${n}`);
    assert.equal(todos(b).length, n - 1, `n=${n}`);
    const fin = jugar(b);
    assert.equal(fin.final.winner_id, 's1', `n=${n}`);
    assert.ok(todos(fin).every((m) => m.winner_id != null), `n=${n}`);
    assert.deepEqual([fin.final.pair1_id, fin.final.pair2_id].sort(), ['s1', 's2'], `n=${n}`);
  }
});

test('cuadro: rondas según la cantidad de parejas', () => {
  const r = (n) => { const b = generateCupBracket(seeds(n)); return [b.dieciseisavos.length, b.octavos.length, b.cuartos.length, b.semis.length]; };
  assert.deepEqual(r(32), [16, 8, 4, 2]);
  assert.deepEqual(r(20), [4, 8, 4, 2]);
  assert.deepEqual(r(16), [0, 8, 4, 2]);
  assert.deepEqual(r(12), [0, 4, 4, 2]);
  assert.deepEqual(r(8), [0, 0, 4, 2]);
  assert.deepEqual(r(5), [0, 0, 1, 2]);
  assert.deepEqual(r(3), [0, 0, 0, 1]);
  assert.deepEqual(r(2), [0, 0, 0, 0]);
  assert.throws(() => generateCupBracket(seeds(33)), /de 2 a 32/);
  const b = generateCupBracket(seeds(20));
  assert.deepEqual(b.dieciseisavos.map((m) => [m.slot1_seed, m.slot2_seed]), [[16, 17], [13, 20], [15, 18], [14, 19]]);
  assert.equal(b.kind, 'copa');
});

test('tercer puesto: lo juegan los perdedores de las semifinales', () => {
  assert.equal(generateCupBracket(seeds(3), { tercerPuesto: true }).tercer, undefined);
  assert.equal(generateCupBracket(seeds(8)).tercer, undefined);
  let b = jugar(generateCupBracket(seeds(8), { tercerPuesto: true }));
  assert.deepEqual([b.tercer.pair1_id, b.tercer.pair2_id].sort(), ['s3', 's4']);
  assert.equal(b.tercer.winner_id, 's3');
  assert.equal(todos(b).length, 8);
  // Cambia el ganador de una semifinal: se deshacen la final y el tercer puesto.
  b = applyBracketResult(b, 's0', 2, 6);
  assert.equal(b.final.winner_id, null);
  assert.equal(b.tercer.winner_id, null);
  assert.equal(b.final.pair1_id, 's4');
  assert.equal(b.tercer.pair1_id, 's1');
  assert.equal(b.tercer.pair2_id, 's3');
  // Se borra un cuarto: la semifinal que alimentaba y sus dos salidas quedan vacías.
  b = jugar(b);
  b = clearBracketResult(b, 'q0');
  assert.equal(findBracketMatch(b, 's0').winner_id, null);
  assert.equal(b.final.pair1_id, null);
  assert.equal(b.tercer.pair1_id, null);
  assert.equal(b.tercer.winner_id, null);
  assert.equal(b.tercer.pair2_id, 's3');
});

test('cuadro de 32: el resultado de 16vos llega a octavos y se puede deshacer', () => {
  let b = generateCupBracket(seeds(32));
  b = applyBracketResult(b, 'd0', 6, 1);
  assert.equal(b.octavos[0].pair1_id, 's1');
  b = applyBracketResult(b, 'd1', 1, 6);
  assert.equal(b.octavos[0].pair2_id, 's17');
  b = applyBracketResult(b, 'o0', 6, 3);
  assert.equal(b.cuartos[0].pair1_id, 's1');
  b = clearBracketResult(b, 'd0');
  assert.equal(b.octavos[0].pair1_id, null);
  assert.equal(b.octavos[0].winner_id, null);
  assert.equal(b.cuartos[0].pair1_id, null);
});

test('formatos: quién usa fechas y quién juega solo con parejas', () => {
  const zonas = { format: 'copa', copa_config: { mode: 'zonas' } };
  const cuadro = { format: 'copa', copa_config: { mode: 'cuadro' } };
  assert.deepEqual([zonas, cuadro, { format: 'liga', liga_mode: 'temporada' }, { format: 'liga', liga_mode: 'jornada' }, { format: 'americano' }].map(usaFechas), [true, false, true, false, false]);
  assert.deepEqual([zonas, cuadro, { format: 'liga', liga_mode: 'temporada' }, { format: 'liga', liga_mode: 'jornada' }, { format: 'americano' }].map(soloParejas), [true, true, true, false, true]);
});
