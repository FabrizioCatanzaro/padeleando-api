// Copa: grupos (zonas) + playoffs, o cuadro directo. Lógica pura, sin base.
// En la API y la base el grupo se llama zona; `groups` ya es la categoría.
import { pairKey } from './fixture.js';
import { shuffle, generateFecha, validateFecha, crossesFromRows } from './ligaFechas.js';
import { isWithdrawn, applyBracketWalkovers } from './tournamentLogic.js';

export const COPA_MODES      = ['zonas', 'cuadro'];
export const COPA_MAX_PAIRS  = 32;
export const ZONAS_MIN       = 2;
export const ZONAS_MAX       = 8;
export const ZONA_MIN_PAIRS  = 3;
export const ZONA_MAX_PAIRS  = 6;
export const MAX_PRIZES      = 12;
export const MAX_PRIZE_PLACE = 4;
export const MAX_PRIZE_TITLE = 60;
export const MAX_PRIZE_TEXT  = 200;

const isBool = (v) => typeof v === 'boolean';
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** Opciones por defecto de cada variante. */
export function defaultCopaConfig(mode) {
  return mode === 'cuadro'
    ? { mode, tercer_puesto: false }
    : { mode: 'zonas', zonas: 2, ruedas: 1, clasifican: 2, mejores_extra: 0, plata: false, tercer_puesto: false };
}

/** Parejas que pasan a playoffs según la configuración. */
export const totalClasificados = (c) => c.zonas * c.clasifican + c.mejores_extra;

// Valida copa_config del alta o de una edición; `current` es lo guardado. Lanza Error con el mensaje.
export function parseCopaSettings(input, { current = null } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Las opciones de la copa no son válidas');
  }
  const mode = input.mode ?? current?.mode;
  if (!COPA_MODES.includes(mode)) throw new Error('Elegí si la copa se juega con grupos o es de cuadro');
  if (current && current.mode !== mode) throw new Error('El tipo de copa no se puede cambiar');

  const c = { ...defaultCopaConfig(mode), ...(current ?? {}) };
  const keys = Object.keys(defaultCopaConfig(mode)).filter((k) => k !== 'mode');
  for (const k of keys) if (input[k] !== undefined) c[k] = input[k];
  const out = { mode };
  for (const k of keys) out[k] = c[k];

  if (!isBool(out.tercer_puesto)) throw new Error('Indicá si se juega el tercer puesto');
  if (mode === 'cuadro') return out;

  if (!intIn(out.zonas, ZONAS_MIN, ZONAS_MAX)) throw new Error(`La copa tiene de ${ZONAS_MIN} a ${ZONAS_MAX} grupos`);
  if (out.ruedas !== 1 && out.ruedas !== 2) throw new Error('Los grupos se juegan a una o a dos ruedas');
  if (!intIn(out.clasifican, 1, ZONA_MAX_PAIRS - 1)) {
    throw new Error(`De cada grupo pasan de 1 a ${ZONA_MAX_PAIRS - 1} parejas`);
  }
  if (!intIn(out.mejores_extra, 0, out.zonas - 1)) {
    throw new Error('Los mejores siguientes tienen que ser menos que los grupos');
  }
  if (out.mejores_extra > 0 && out.clasifican >= ZONA_MAX_PAIRS - 1) {
    throw new Error('Con esa cantidad por grupo no quedan parejas para los mejores siguientes');
  }
  if (!isBool(out.plata)) throw new Error('Indicá si hay copa de plata');
  const total = totalClasificados(out);
  if (total < 2 || total > COPA_MAX_PAIRS) throw new Error(`A playoffs pasan de 2 a ${COPA_MAX_PAIRS} parejas`);
  return out;
}

// Valida la lista de premios. El primer puesto de la copa principal es obligatorio.
export function parsePrizes(input, { plata = false } = {}) {
  if (!Array.isArray(input)) throw new Error('Los premios no son válidos');
  if (input.length > MAX_PRIZES) throw new Error(`Hasta ${MAX_PRIZES} premios`);
  const seen = new Set();
  const out = input.map((p, i) => {
    const kind = p?.kind;
    const cup = p?.cup ?? 'oro';
    if (kind !== 'puesto' && kind !== 'especial') throw new Error('Cada premio es por puesto o especial');
    if (cup !== 'oro' && cup !== 'plata') throw new Error('El premio es de la copa principal o de la copa de plata');
    if (cup === 'plata' && !plata) throw new Error('Este torneo no tiene copa de plata');
    const description = String(p.description ?? '').trim();
    if (!description) throw new Error('Escribí en qué consiste el premio');
    if (description.length > MAX_PRIZE_TEXT) throw new Error(`El premio no puede superar los ${MAX_PRIZE_TEXT} caracteres`);
    if (kind === 'puesto') {
      if (!intIn(p.place, 1, MAX_PRIZE_PLACE)) throw new Error(`Los premios por puesto van del 1° al ${MAX_PRIZE_PLACE}°`);
      const k = `${cup}|${p.place}`;
      if (seen.has(k)) throw new Error('Hay dos premios para el mismo puesto');
      seen.add(k);
      return { kind, cup, place: p.place, title: null, description, position: i };
    }
    const title = String(p.title ?? '').trim();
    if (!title) throw new Error('Poné un nombre al premio especial');
    if (title.length > MAX_PRIZE_TITLE) throw new Error(`El nombre del premio no puede superar los ${MAX_PRIZE_TITLE} caracteres`);
    return { kind, cup, place: null, title, description, position: i };
  });
  if (!seen.has('oro|1')) throw new Error('El premio del primer puesto es obligatorio');
  return out;
}

export const esCopa      = (t) => t?.format === 'copa';
export const esCopaZonas = (t) => esCopa(t) && t?.copa_config?.mode === 'zonas';
/** Torneos con fixture por fechas: liga en varios días y copa con grupos. */
export const usaFechas   = (t) => (t?.format === 'liga' && t?.liga_mode === 'temporada') || esCopaZonas(t);
/** Formatos que se juegan siempre con parejas fijas. */
export const soloParejas = (t) => t?.format === 'americano' || esCopa(t) || (t?.format === 'liga' && t?.liga_mode === 'temporada');

export const zonaLetra = (n) => String.fromCharCode(64 + Number(n));
const activas = (pairs) => pairs.filter((p) => !isWithdrawn(p));
const edgeKey = (a, b) => (String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`);

// Error si las parejas no entran en esa cantidad de grupos; null si entran.
export function zonasSizeError(total, zonas) {
  if (total < zonas * ZONA_MIN_PAIRS) {
    return `Con ${total} parejas no se arman ${zonas} grupos de al menos ${ZONA_MIN_PAIRS}. Bajá la cantidad de grupos`;
  }
  if (total > zonas * ZONA_MAX_PAIRS) {
    return `Con ${total} parejas los grupos pasan de ${ZONA_MAX_PAIRS}. Subí la cantidad de grupos`;
  }
  return null;
}

// Sorteo: cabezas de serie en serpentina, el resto al azar al grupo con menos parejas.
export function sortearZonas({ pairs, zonas, rng = Math.random }) {
  const act = activas(pairs);
  const err = zonasSizeError(act.length, zonas);
  if (err) throw new Error(err);
  const cabezas = act.filter((p) => p.cabeza_serie != null).sort((a, b) => a.cabeza_serie - b.cabeza_serie);
  const resto = shuffle(act.filter((p) => p.cabeza_serie == null), rng);
  const count = Array(zonas).fill(0);
  const out = [];
  cabezas.forEach((p, i) => {
    const vuelta = Math.floor(i / zonas), pos = i % zonas;
    const z = vuelta % 2 === 0 ? pos : zonas - 1 - pos;
    count[z]++;
    out.push({ pair_id: p.id, zona: z + 1 });
  });
  for (const p of resto) {
    const z = count.indexOf(Math.min(...count));
    count[z]++;
    out.push({ pair_id: p.id, zona: z + 1 });
  }
  return out;
}

// Revisa una asignación editada a mano. `errors` impiden guardar; `warnings` no.
export function validateZonas({ pairs, zonas, assignment = [] }) {
  const errors = [];
  const warnings = [];
  const act = activas(pairs);
  const byId = new Map(pairs.map((p) => [String(p.id), p]));
  const zonaDe = new Map();
  for (const a of assignment) {
    const id = String(a.pair_id);
    if (!byId.has(id)) { errors.push('Una de las parejas no es de este torneo'); continue; }
    if (zonaDe.has(id)) errors.push('Una pareja está en dos grupos');
    if (!Number.isInteger(a.zona) || a.zona < 1 || a.zona > zonas) errors.push('Uno de los grupos no existe');
    zonaDe.set(id, a.zona);
  }
  if (act.some((p) => !zonaDe.has(String(p.id)))) errors.push('Todas las parejas tienen que estar en un grupo');
  const count = Array(zonas).fill(0);
  const cabezas = Array(zonas).fill(0);
  for (const p of act) {
    const z = zonaDe.get(String(p.id));
    if (!Number.isInteger(z) || z < 1 || z > zonas) continue;
    count[z - 1]++;
    if (p.cabeza_serie != null) cabezas[z - 1]++;
  }
  if (count.some((n) => n < ZONA_MIN_PAIRS)) errors.push(`Cada grupo necesita al menos ${ZONA_MIN_PAIRS} parejas`);
  if (count.some((n) => n > ZONA_MAX_PAIRS)) errors.push(`Un grupo no puede tener más de ${ZONA_MAX_PAIRS} parejas`);
  if (errors.length === 0) {
    if (Math.max(...count) - Math.min(...count) > 1) warnings.push('Los grupos quedan desparejos');
    if (cabezas.some((n) => n > 1) && cabezas.some((n) => n === 0)) {
      warnings.push('Hay dos cabezas de serie en un grupo y otro grupo sin ninguna');
    }
  }
  return { errors: [...new Set(errors)], warnings };
}

/** Parejas agrupadas por zona: Map zona → parejas. Las que no tienen zona quedan afuera. */
export function pairsByZona(pairs) {
  const out = new Map();
  for (const p of pairs) {
    if (p.zona == null) continue;
    if (!out.has(p.zona)) out.set(p.zona, []);
    out.get(p.zona).push(p);
  }
  return new Map([...out.entries()].sort((a, b) => a[0] - b[0]));
}

// Saca una aparición de cada cruce: lo que queda es la segunda rueda.
function sinPrimeraRueda(crosses) {
  const seen = new Set();
  return crosses.filter((c) => {
    const k = edgeKey(c.a, c.b);
    if (seen.has(k)) return true;
    seen.add(k);
    return false;
  });
}

function primeraRuedaCompleta(pairsZ, crossesZ) {
  const act = activas(pairsZ).map((p) => String(p.id));
  const faced = new Set(crossesZ.map((c) => edgeKey(c.a, c.b)));
  for (let i = 0; i < act.length; i++) {
    for (let j = i + 1; j < act.length; j++) if (!faced.has(edgeKey(act[i], act[j]))) return false;
  }
  return true;
}

// Arma la fecha siguiente de todos los grupos. `rows` son partidos jugados y programados.
export function generateCopaFecha({ pairs, rows = [], ruedas = 1, rng = Math.random }) {
  const all = crossesFromRows(pairs, rows);
  const round = all.reduce((max, c) => Math.max(max, c.round ?? 0), 0) + 1;
  const zonaDe = new Map(pairs.map((p) => [String(p.id), p.zona]));
  const out = { crosses: [], libres: [], round, completable: true, zonas: [] };
  for (const [zona, pairsZ] of pairsByZona(pairs)) {
    if (activas(pairsZ).length < 2) continue;
    let hist = all.filter((c) => zonaDe.get(c.a) === zona && zonaDe.get(c.b) === zona);
    if (ruedas === 2 && primeraRuedaCompleta(pairsZ, hist)) hist = sinPrimeraRueda(hist);
    let f;
    try { f = generateFecha({ pairs: pairsZ, crosses: hist, allowRematch: false, rng }); }
    catch { out.zonas.push({ zona, crosses: [], libres: [], terminada: true }); continue; }
    out.crosses.push(...f.crosses);
    out.libres.push(...f.libres);
    if (f.completable === false) out.completable = false;
    out.zonas.push({ zona, crosses: f.crosses, libres: f.libres, terminada: false });
  }
  if (out.crosses.length === 0) throw new Error('Ya se jugaron todos los cruces de los grupos');
  return out;
}

// Revisa una fecha armada a mano: cada cruce es de un mismo grupo y no supera las ruedas.
export function validateCopaFecha({ pairs, rows = [], proposed = [], ruedas = 1 }) {
  const all = crossesFromRows(pairs, rows);
  const zonaDe = new Map(pairs.map((p) => [String(p.id), p.zona]));
  const errors = [];
  const warnings = [];
  const libres = [];
  for (const [a, b] of proposed) {
    const za = zonaDe.get(String(a)), zb = zonaDe.get(String(b));
    if (za == null || zb == null) errors.push('Una de las parejas no tiene grupo');
    else if (za !== zb) errors.push('Las dos parejas tienen que ser del mismo grupo');
  }
  for (const [zona, pairsZ] of pairsByZona(pairs)) {
    let hist = all.filter((c) => zonaDe.get(c.a) === zona && zonaDe.get(c.b) === zona);
    if (ruedas === 2) hist = sinPrimeraRueda(hist);
    const prop = proposed.filter(([a, b]) => zonaDe.get(String(a)) === zona && zonaDe.get(String(b)) === zona);
    const v = validateFecha({ pairs: pairsZ, crosses: hist, proposed: prop, allowRematch: false });
    errors.push(...v.errors);
    const letra = zonaLetra(zona);
    warnings.push(...v.warnings
      .filter((w) => ruedas === 1 || !w.startsWith('Con estos cruces'))
      .map((w) => `Grupo ${letra}: ${w}`));
    libres.push(...v.libres);
  }
  return { errors: [...new Set(errors)], warnings, libres };
}

// Sets y games de un partido. Sin detalle de sets, cuenta como un set con ese marcador.
function setsYGames(m) {
  const s1 = Number(m.score1), s2 = Number(m.score2);
  const sets = Array.isArray(m.sets) ? m.sets.filter((s) => Number(s?.s1) !== Number(s?.s2)) : [];
  if (sets.length === 0) return { sets: s1 > s2 ? [1, 0] : [0, 1], games: [s1, s2] };
  const out = { sets: [0, 0], games: [0, 0] };
  for (const s of sets) {
    const a = Number(s.s1) || 0, b = Number(s.s2) || 0;
    out.sets[a > b ? 0 : 1]++;
    out.games[0] += a;
    out.games[1] += b;
  }
  return out;
}

// Orden de la Copa: puntos, victorias, diferencia de sets, diferencia de games, games a favor.
export function compareCopaRows(a, b) {
  return b.points - a.points
      || b.wins - a.wins
      || b.sd - a.sd
      || b.gd - a.gd
      || b.gf - a.gf
      || String(a.pair_id).localeCompare(String(b.pair_id));
}

// Entre grupos de distinto tamaño cada criterio se divide por partidos jugados.
export function compareCopaRowsPorPartido(a, b) {
  const per = (r, k) => (r.played > 0 ? r[k] / r.played : 0);
  return per(b, 'points') - per(a, 'points')
      || per(b, 'wins') - per(a, 'wins')
      || per(b, 'sd') - per(a, 'sd')
      || per(b, 'gd') - per(a, 'gd')
      || per(b, 'gf') - per(a, 'gf')
      || String(a.pair_id).localeCompare(String(b.pair_id));
}

// Tabla de un conjunto de parejas. El partido es de la pareja si el equipo son sus dos jugadores.
export function copaStandings(pairs, matches, { win = 3, loss = 0 } = {}) {
  const rows = new Map(pairs.map((p) => [pairKey([p.p1_id, p.p2_id]), {
    pair_id: p.id, pair_name: `${p.p1_name} & ${p.p2_name}`, zona: p.zona ?? null,
    played: 0, wins: 0, losses: 0, points: 0, sf: 0, sc: 0, gf: 0, gc: 0, sd: 0, gd: 0,
    withdrawn: isWithdrawn(p),
  }]));
  for (const m of matches) {
    const s1 = Number(m.score1), s2 = Number(m.score2);
    if (!Number.isFinite(s1) || !Number.isFinite(s2) || s1 === s2) continue;
    const r1 = rows.get(pairKey([m.team1_p1, m.team1_p2]));
    const r2 = rows.get(pairKey([m.team2_p1, m.team2_p2]));
    if (!r1 || !r2) continue;
    const { sets, games } = setsYGames(m);
    [[r1, 0, s1 > s2], [r2, 1, s2 > s1]].forEach(([r, i, won]) => {
      r.played++;
      if (won) { r.wins++; r.points += win; }
      else { r.losses++; if (!m.walkover) r.points += loss; }
      r.sf += sets[i]; r.sc += sets[1 - i];
      r.gf += games[i]; r.gc += games[1 - i];
    });
  }
  return [...rows.values()]
    .map((r) => ({ ...r, sd: r.sf - r.sc, gd: r.gf - r.gc }))
    .sort((a, b) => Number(a.withdrawn) - Number(b.withdrawn) || compareCopaRows(a, b))
    .map((r, i) => ({ ...r, pos: i + 1 }));
}

/** Tabla de cada grupo: [{ zona, rows }]. */
export function zonaStandings(pairs, matches, puntos) {
  return [...pairsByZona(pairs)].map(([zona, pairsZ]) => ({ zona, rows: copaStandings(pairsZ, matches, puntos) }));
}

// Clasificados en orden de siembra y el resto para la copa de plata. Las retiradas no cuentan.
export function rankClasificados(tablas, config) {
  const vivas = tablas.map((t) => t.rows.filter((r) => !r.withdrawn));
  const maxPos = Math.max(0, ...vivas.map((rows) => rows.length));
  const nivel = (pos) => vivas.map((rows) => rows[pos - 1]).filter(Boolean).sort(compareCopaRowsPorPartido);
  const clasificados = [];
  for (let pos = 1; pos <= config.clasifican; pos++) clasificados.push(...nivel(pos).map((r) => ({ ...r, via: 'directo' })));
  const siguientes = nivel(config.clasifican + 1);
  const extra = config.mejores_extra ?? 0;
  clasificados.push(...siguientes.slice(0, extra).map((r) => ({ ...r, via: 'extra' })));
  const resto = [...siguientes.slice(extra)];
  for (let pos = config.clasifican + 2; pos <= maxPos; pos++) resto.push(...nivel(pos));
  const numerar = (list) => list.map((r, i) => ({ ...r, seed: i + 1 }));
  return { clasificados: numerar(clasificados), resto: numerar(resto) };
}

const pow2 = (n) => { let s = 2; while (s < n) s *= 2; return s; };
// Orden clásico de siembra: [1,2] → [1,4,2,3] → [1,8,4,5,2,7,3,6]…
function seedPositions(size) {
  let pos = [1, 2];
  while (pos.length < size) pos = pos.flatMap((x) => [x, pos.length * 2 + 1 - x]);
  return pos;
}

/** Cruces que se juegan en la primera ronda de un cuadro de n parejas, por número de siembra. */
export function primeraRonda(n) {
  const pos = seedPositions(pow2(n));
  const out = [];
  for (let i = 0; i < pos.length; i += 2) if (pos[i] <= n && pos[i + 1] <= n) out.push([pos[i], pos[i + 1]]);
  return out;
}

// Si dos parejas del mismo grupo se cruzan en la primera ronda, cambia una con una siembra vecina.
export function seedCuadro(clasificados) {
  const order = [...clasificados];
  const n = order.length;
  const cruces = primeraRonda(n);
  const rival = new Map();
  cruces.forEach(([a, b]) => { rival.set(a, b); rival.set(b, a); });
  const choque = (a, b) => order[a - 1].zona != null && order[a - 1].zona === order[b - 1].zona;
  const bien = (s) => !rival.has(s) || !choque(s, rival.get(s));
  const swap = (x, y) => { [order[x - 1], order[y - 1]] = [order[y - 1], order[x - 1]]; };
  for (const [a, b] of cruces) {
    if (!choque(a, b)) continue;
    for (const k of [b + 1, b - 1, b + 2, b - 2]) {
      if (k < 1 || k > n || k === a || !rival.has(k)) continue;
      swap(b, k);
      if (bien(b) && bien(k)) break;
      swap(b, k);
    }
  }
  return order.map((r, i) => ({ ...r, seed: i + 1 }));
}

/** Siembra de la copa de cuadro: cabezas de serie en su orden y el resto al azar. */
export function seedCuadroDirecto({ pairs, rng = Math.random }) {
  const act = activas(pairs);
  const cabezas = act.filter((p) => p.cabeza_serie != null).sort((a, b) => a.cabeza_serie - b.cabeza_serie);
  const resto = shuffle(act.filter((p) => p.cabeza_serie == null), rng);
  return [...cabezas, ...resto].map((p, i) => ({
    pair_id: p.id, pair_name: `${p.p1_name} & ${p.p2_name}`, zona: null, seed: i + 1,
  }));
}

const RONDA_DE = { 32: 'dieciseisavos', 16: 'octavos', 8: 'cuartos', 4: 'semis', 2: 'final' };
const PREFIJO  = { dieciseisavos: 'd', octavos: 'o', cuartos: 'q', semis: 's', final: 'f' };
const vacio = () => ({ score1: null, score2: null, winner_id: null, winner_name: null });

// Cuadro de 2 a 32 parejas ya sembradas. Las mejores siembras pasan directo si n no es potencia de 2.
export function generateCupBracket(seeds, { tercerPuesto = false, kind = 'copa' } = {}) {
  const n = seeds.length;
  if (n < 2 || n > COPA_MAX_PAIRS) throw new Error(`El cuadro va de 2 a ${COPA_MAX_PAIRS} parejas`);
  const size = pow2(n);
  const b = { dieciseisavos: [], octavos: [], cuartos: [], semis: [], final: null };
  // Cada lugar es una pareja directa, el ganador de un partido o un hueco sin rival.
  let slots = seedPositions(size).map((s) => (s <= n
    ? { seed: s, pair_id: seeds[s - 1].pair_id, pair_name: seeds[s - 1].pair_name, source: null }
    : null));
  for (let r = size; r >= 2; r /= 2) {
    const key = RONDA_DE[r];
    const slotKeys = key === 'octavos' || key === 'cuartos' ? ['slot1_source', 'slot2_source'] : ['source1', 'source2'];
    const next = [];
    const ronda = [];
    for (let i = 0; i < slots.length; i += 2) {
      const [s1, s2] = [slots[i], slots[i + 1]];
      if (!s1 || !s2) { next.push(s1 ?? s2); continue; }
      const id = `${PREFIJO[key]}${ronda.length}`;
      ronda.push({
        id,
        [slotKeys[0]]: s1.source, [slotKeys[1]]: s2.source,
        slot1_seed: s1.seed, slot2_seed: s2.seed,
        pair1_id: s1.pair_id, pair1_name: s1.pair_name,
        pair2_id: s2.pair_id, pair2_name: s2.pair_name,
        ...vacio(),
        winner_seed: Math.min(s1.seed, s2.seed),
      });
      next.push({ seed: Math.min(s1.seed, s2.seed), pair_id: null, pair_name: null, source: id });
    }
    if (key === 'final') b.final = ronda[0];
    else b[key] = ronda;
    slots = next;
  }
  const out = {
    kind,
    generated_at: new Date().toISOString(),
    total_pairs: n,
    direct_count: size - n,
    standings: seeds.map((s, i) => ({ ...s, seed: i + 1 })),
    ...b,
    withdrawn_pair_ids: [],
  };
  if (tercerPuesto && b.semis.length === 2) {
    out.tercer = {
      id: 't0', source1: 's0', source2: 's1',
      pair1_id: null, pair1_name: null, pair2_id: null, pair2_name: null, ...vacio(),
    };
  }
  return applyBracketWalkovers(out);
}
