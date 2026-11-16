// Liga por fechas (temporada en varios días): armado de cada fecha del
// fixture. El fixture se arma de a una fecha, al azar o a mano, y esta lógica
// decide los cruces, la pareja libre y si la temporada todavía se puede
// completar. Pura: las rutas leen, llaman acá y guardan.
// Diseño: doc "Diseño: liga por fechas" (decisiones de Fabri, 2026-11-09).
import { pairKey } from './fixture.js';
import { isWithdrawn } from './tournamentLogic.js';

/** Nodo ficticio del armado: la pareja que cruza con LIBRE no juega esa fecha. */
export const LIBRE = '__libre__';

// Tope de pasos por intento de búsqueda, y cantidad de intentos con otro orden
// al azar. Con 20 parejas alcanza de sobra; si se agotan, el armado sigue con
// la mejor fecha encontrada.
const SEARCH_BUDGET = 40000;
const SEARCH_TRIES  = 6;

const edgeKey = (a, b) => (String(a) < String(b) ? `${a}|${b}` : `${b}|${a}`);

/** Copia mezclada (Fisher-Yates). `rng` se inyecta para tests reproducibles. */
export function shuffle(list, rng = Math.random) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Pasa filas de partido (jugados o programados, con jugadores) a cruces entre
 * parejas. Ignora las filas que no son de dos parejas del torneo.
 * @param {Array<{id,p1_id,p2_id}>} pairs
 * @param {Array<{team1_p1,team1_p2,team2_p1,team2_p2,round?}>} rows
 * @returns {Array<{a:string, b:string, round:number|null}>}
 */
export function crossesFromRows(pairs, rows = []) {
  const byKey = new Map(pairs.map((p) => [pairKey([p.p1_id, p.p2_id]), String(p.id)]));
  const out = [];
  for (const r of rows) {
    const a = byKey.get(pairKey([r.team1_p1, r.team1_p2]));
    const b = byKey.get(pairKey([r.team2_p1, r.team2_p2]));
    if (!a || !b || a === b) continue;
    out.push({ a, b, round: r.round ?? null });
  }
  return out;
}

/**
 * Historia de la temporada: cuántas veces se cruzó cada par de parejas y
 * cuántas fechas quedó libre cada pareja. Una pareja queda libre en una fecha
 * cuando esa fecha tiene cruces y ninguno es suyo.
 * @param {Array<{id}>} pairs
 * @param {Array<{a,b,round}>} crosses - de crossesFromRows
 * @returns {{ faced: Map<string,number>, libreCount: Map<string,number>, lastRound: number }}
 */
export function fechaHistory(pairs, crosses = []) {
  const faced = new Map();
  const rounds = new Map();
  for (const c of crosses) {
    const k = edgeKey(c.a, c.b);
    faced.set(k, (faced.get(k) ?? 0) + 1);
    if (c.round == null) continue;
    if (!rounds.has(c.round)) rounds.set(c.round, new Set());
    rounds.get(c.round).add(c.a).add(c.b);
  }
  const libreCount = new Map(pairs.map((p) => [String(p.id), 0]));
  for (const playing of rounds.values()) {
    for (const id of libreCount.keys()) {
      if (!playing.has(id)) libreCount.set(id, libreCount.get(id) + 1);
    }
  }
  const lastRound = rounds.size ? Math.max(...rounds.keys()) : 0;
  return { faced, libreCount, lastRound };
}

// Grafo de lo que falta jugar sin repetir: cruces sin jugar entre parejas
// activas y, con número impar, LIBRE para las parejas que menos veces
// quedaron libres.
function remainingGraph(active, faced, libreCount) {
  const adj = new Map(active.map((id) => [id, new Set()]));
  let realEdges = 0;
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i], b = active[j];
      if (faced.has(edgeKey(a, b))) continue;
      adj.get(a).add(b);
      adj.get(b).add(a);
      realEdges++;
    }
  }
  if (active.length % 2 === 1) {
    const min = Math.min(...active.map((id) => libreCount.get(id) ?? 0));
    adj.set(LIBRE, new Set());
    for (const id of active) {
      if ((libreCount.get(id) ?? 0) !== min) continue;
      adj.get(id).add(LIBRE);
      adj.get(LIBRE).add(id);
    }
  }
  return { adj, realEdges };
}

// Todos los repartos completos de una fecha (cada nodo con exactamente un
// rival), de a uno. Elige primero el nodo con menos rivales posibles.
function* perfectMatchings(nodes, adj, rng, budget) {
  if (nodes.length === 0) { yield []; return; }
  if (budget.left-- <= 0) return;
  const free = new Set(nodes);
  let pick = null, fewest = Infinity;
  for (const x of nodes) {
    let d = 0;
    for (const y of adj.get(x)) if (free.has(y)) d++;
    if (d < fewest) { fewest = d; pick = x; }
  }
  if (fewest === 0) return;
  const rivals = shuffle([...adj.get(pick)].filter((y) => free.has(y)), rng);
  for (const y of rivals) {
    const rest = nodes.filter((z) => z !== pick && z !== y);
    for (const m of perfectMatchings(rest, adj, rng, budget)) yield [[pick, y], ...m];
    if (budget.left <= 0) return;
  }
}

const removeEdges = (adj, m) => m.forEach(([a, b]) => { adj.get(a).delete(b); adj.get(b).delete(a); });
const addEdges    = (adj, m) => m.forEach(([a, b]) => { adj.get(a).add(b); adj.get(b).add(a); });
const isReal = ([a, b]) => a !== LIBRE && b !== LIBRE;

// Reparte lo que falta en fechas completas. Solo es posible si a todos les
// falta la misma cantidad de partidos (grafo regular). Devuelve las fechas o
// null si no hay forma, o si se agotó la búsqueda.
function factorize(adj, realEdges, rng, budget) {
  if (realEdges === 0) return [];
  const nodes = [...adj.keys()];
  const degree = adj.get(nodes[0]).size;
  if (nodes.some((x) => adj.get(x).size !== degree)) return null;
  for (const m of perfectMatchings(nodes, adj, rng, budget)) {
    const real = m.filter(isReal).length;
    if (real === 0) continue;
    removeEdges(adj, m);
    const rest = factorize(adj, realEdges - real, rng, budget);
    addEdges(adj, m);
    if (rest) return [m, ...rest];
    if (budget.left <= 0) return null;
  }
  return null;
}

// factorize con varios intentos: un orden al azar malo agota la búsqueda,
// otro la resuelve enseguida.
function planRest(adj, realEdges, rng) {
  for (let i = 0; i < SEARCH_TRIES; i++) {
    const plan = factorize(adj, realEdges, rng, { left: SEARCH_BUDGET });
    if (plan) return plan;
  }
  return null;
}

// Mejor fecha posible con ramificación y poda: primero la que deja menos
// parejas sin jugar, después la que deja libres a las que menos lo fueron,
// después la que menos repite cruces. `canPair` descarta cruces prohibidos.
function bestMatching(active, { faced, libreCount, canPair, rng, budget }) {
  const minLibre = active.length ? Math.min(...active.map((id) => libreCount.get(id) ?? 0)) : 0;
  const libreCost = (id) => 1e6 + ((libreCount.get(id) ?? 0) - minLibre) * 1e3;
  const edgeCost  = (a, b) => (faced.get(edgeKey(a, b)) ?? 0) * 10;
  const order = shuffle(active, rng);
  let best = { cost: Infinity, crosses: [], libres: [] };

  function dfs(i, used, cost, crosses, libres) {
    if (cost >= best.cost || budget.left-- <= 0) return;
    while (i < order.length && used.has(order[i])) i++;
    if (i === order.length) {
      best = { cost, crosses: [...crosses], libres: [...libres] };
      return;
    }
    const x = order[i];
    used.add(x);
    const rivals = order.slice(i + 1).filter((y) => !used.has(y) && canPair(x, y))
      .sort((p, q) => edgeCost(x, p) - edgeCost(x, q));
    for (const y of rivals) {
      used.add(y);
      crosses.push([x, y]);
      dfs(i + 1, used, cost + edgeCost(x, y), crosses, libres);
      crosses.pop();
      used.delete(y);
    }
    libres.push(x);
    dfs(i + 1, used, cost + libreCost(x), crosses, libres);
    libres.pop();
    used.delete(x);
  }
  dfs(0, new Set(), 0, [], []);
  return best;
}

/**
 * Arma la fecha siguiente al azar.
 *
 * Sin cruces repetidos: busca una fecha que deje completar el todos contra
 * todos con las fechas restantes. Si no existe (por cruces armados a mano o
 * por una baja), arma la mejor fecha posible y avisa con `completable: false`.
 * Con cruces repetidos: prioriza los cruces menos jugados.
 * En los dos casos, con número impar queda libre una de las parejas que menos
 * veces quedaron libres.
 *
 * @param {object} args
 * @param {Array<{id,status?}>} args.pairs - parejas del torneo (las retiradas no juegan)
 * @param {Array<{a,b,round}>} args.crosses - historia: cruces jugados y programados
 * @param {boolean} args.allowRematch
 * @param {() => number} [args.rng]
 * @returns {{ crosses: Array<[string,string]>, libres: string[], completable: boolean|null, round: number }}
 *   `completable` es null con cruces repetidos (no aplica).
 * @throws {Error} si no queda ningún cruce posible
 */
export function generateFecha({ pairs, crosses = [], allowRematch = false, rng = Math.random }) {
  const active = pairs.filter((p) => !isWithdrawn(p)).map((p) => String(p.id));
  if (active.length < 2) throw new Error('Hacen falta al menos 2 parejas activas');
  const { faced, libreCount, lastRound } = fechaHistory(pairs, crosses);
  const round = lastRound + 1;
  const budget = { left: SEARCH_BUDGET };

  if (allowRematch) {
    const best = bestMatching(active, { faced, libreCount, canPair: () => true, rng, budget });
    return { crosses: best.crosses, libres: best.libres, completable: null, round };
  }

  const { adj, realEdges } = remainingGraph(active, faced, libreCount);
  if (realEdges === 0) throw new Error('Ya se jugaron todos los cruces');
  const plan = planRest(adj, realEdges, rng);
  if (plan) {
    const first = plan[0];
    return {
      crosses: first.filter(isReal),
      libres: first.filter((e) => !isReal(e)).map(([a, b]) => (a === LIBRE ? b : a)),
      completable: true,
      round,
    };
  }
  const best = bestMatching(active, {
    faced, libreCount, rng, budget: { left: SEARCH_BUDGET },
    canPair: (a, b) => !faced.has(edgeKey(a, b)),
  });
  if (best.crosses.length === 0) throw new Error('Ya se jugaron todos los cruces');
  return { crosses: best.crosses, libres: best.libres, completable: false, round };
}

/**
 * Revisa una fecha armada a mano.
 * - `errors` impiden guardarla: pareja inexistente o retirada, pareja en dos
 *   cruces, pareja contra sí misma, cruce repetido sin permiso.
 * - `warnings` se muestran pero dejan guardar: más parejas sin jugar que las
 *   necesarias, libre que se repite antes que el resto, temporada que ya no
 *   se completa.
 * @param {object} args
 * @param {Array<{id,status?}>} args.pairs
 * @param {Array<{a,b,round}>} args.crosses - historia, sin la fecha que se revisa
 * @param {Array<[string,string]>} args.proposed - cruces de la fecha
 * @param {boolean} args.allowRematch
 * @returns {{ errors: string[], warnings: string[], libres: string[], completable: boolean|null }}
 */
export function validateFecha({ pairs, crosses = [], proposed = [], allowRematch = false, rng = Math.random }) {
  const errors = [];
  const warnings = [];
  const byId = new Map(pairs.map((p) => [String(p.id), p]));
  const active = pairs.filter((p) => !isWithdrawn(p)).map((p) => String(p.id));
  const { faced, libreCount } = fechaHistory(pairs, crosses);
  const seen = new Set();

  for (const [rawA, rawB] of proposed) {
    const a = String(rawA), b = String(rawB);
    const pa = byId.get(a), pb = byId.get(b);
    if (!pa || !pb) { errors.push('Una de las parejas no es de este torneo'); continue; }
    if (a === b) { errors.push('Una pareja no puede jugar contra sí misma'); continue; }
    if (isWithdrawn(pa) || isWithdrawn(pb)) errors.push('Una de las parejas se retiró del torneo');
    for (const id of [a, b]) {
      if (seen.has(id)) errors.push('Una pareja está en dos cruces de la misma fecha');
      seen.add(id);
    }
    if (!allowRematch && faced.has(edgeKey(a, b))) errors.push('Ese cruce ya se jugó o ya está programado');
  }

  const libres = active.filter((id) => !seen.has(id));
  const expected = active.length % 2;
  if (libres.length > expected) {
    warnings.push(`Quedan ${libres.length} parejas sin jugar esta fecha`);
  }
  if (libres.length > 0) {
    const min = Math.min(...active.map((id) => libreCount.get(id) ?? 0));
    if (libres.some((id) => (libreCount.get(id) ?? 0) > min)) {
      warnings.push('Una pareja queda libre otra vez antes que el resto');
    }
  }

  let completable = null;
  if (!allowRematch && errors.length === 0) {
    const after = [...crosses, ...proposed.map(([a, b]) => ({ a: String(a), b: String(b), round: null }))];
    const h = fechaHistory(pairs, after);
    // Las libres de esta fecha cuentan como libres para lo que sigue.
    for (const id of libres) h.libreCount.set(id, (h.libreCount.get(id) ?? 0) + 1);
    const { adj, realEdges } = remainingGraph(active, h.faced, h.libreCount);
    completable = planRest(adj, realEdges, rng) !== null;
    if (!completable) warnings.push('Con estos cruces ya no se completa el todos contra todos');
  }
  return { errors: [...new Set(errors)], warnings, libres, completable };
}

/**
 * Programados de una pareja que se da de baja en una liga por fechas: se
 * cancelan (no son W.O.). Los partidos ya jugados no se tocan.
 * @param {{p1_id,p2_id}} pair
 * @param {Array<{id,team1_p1,team1_p2,team2_p1,team2_p2}>} scheduledRows
 * @returns {string[]} ids de scheduled_matches a borrar
 */
export function scheduledIdsToCancel(pair, scheduledRows = []) {
  const k = pairKey([pair.p1_id, pair.p2_id]);
  return scheduledRows
    .filter((r) => pairKey([r.team1_p1, r.team1_p2]) === k || pairKey([r.team2_p1, r.team2_p2]) === k)
    .map((r) => r.id);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Fecha de calendario real en formato YYYY-MM-DD (rechaza 2026-02-30). */
export const isIsoDate = (s) => typeof s === 'string' && ISO_DATE.test(s)
  && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const validDate = isIsoDate;

/**
 * Días de una fecha: desde y hasta (YYYY-MM-DD). Hasta es opcional (un solo
 * día) y no puede ser anterior a desde.
 * @returns {string|null} error o null
 */
export function fechaDatesError(start_date, end_date) {
  if (!validDate(start_date)) return 'Elegí el primer día de la fecha';
  if (end_date == null || end_date === '') return null;
  if (!validDate(end_date)) return 'El último día de la fecha no es válido';
  if (end_date < start_date) return 'El último día no puede ser anterior al primero';
  return null;
}

export const LIGA_MODES     = ['jornada', 'temporada'];
export const WINNER_FORMATS = ['tabla', 'playoffs'];
export const MAX_PLAYOFF_SIZE = 16;
export const MAX_POINTS = 10;
export const LIGA_KEYS = ['liga_mode', 'allow_rematch', 'winner_format', 'playoff_size', 'points_win', 'points_loss'];

/**
 * Lee las opciones de liga del body de un alta o una edición de torneo.
 * Devuelve solo las que vinieron. Con ganador por tabla, playoff_size queda
 * en null; con playoffs es obligatorio.
 * @param {object} body
 * @param {{ format?: string, current?: {winner_format?, playoff_size?} }} [ctx]
 *   `current` son los valores guardados, para una edición parcial.
 * @returns {{liga_mode?, allow_rematch?, winner_format?, playoff_size?}}
 * @throws {Error} con el mensaje para el organizador
 */
export function parseLigaSettings(body = {}, { format = 'liga', current = {} } = {}) {
  const has = (k) => body[k] !== undefined;
  const out = {};
  if (!LIGA_KEYS.some(has)) return out;
  if (format !== 'liga') throw new Error('Estas opciones son solo para torneos Liga');

  if (has('liga_mode')) {
    if (!LIGA_MODES.includes(body.liga_mode)) throw new Error('Elegí si la liga se juega en un solo día o en varios días');
    out.liga_mode = body.liga_mode;
  }
  if (has('allow_rematch')) {
    if (typeof body.allow_rematch !== 'boolean') throw new Error('Indicá si se permiten cruces repetidos');
    out.allow_rematch = body.allow_rematch;
  }
  if (has('winner_format')) {
    if (!WINNER_FORMATS.includes(body.winner_format)) throw new Error('Elegí cómo se define el campeón');
    out.winner_format = body.winner_format;
  }
  if (has('playoff_size')) {
    const v = body.playoff_size;
    if (v !== null && (!Number.isInteger(v) || v < 2 || v > MAX_PLAYOFF_SIZE)) {
      throw new Error(`A playoffs pasan entre 2 y ${MAX_PLAYOFF_SIZE} parejas`);
    }
    out.playoff_size = v;
  }

  for (const k of ['points_win', 'points_loss']) {
    if (!has(k)) continue;
    const v = body[k];
    if (!Number.isInteger(v) || v < 0 || v > MAX_POINTS) throw new Error(`Los puntos van de 0 a ${MAX_POINTS}`);
    out[k] = v;
  }
  const win  = out.points_win  ?? current.points_win  ?? 3;
  const loss = out.points_loss ?? current.points_loss ?? 0;
  if (loss > win) throw new Error('La derrota no puede sumar más que la victoria');

  const winner = out.winner_format ?? current.winner_format ?? 'tabla';
  const size = 'playoff_size' in out ? out.playoff_size : (current.playoff_size ?? null);
  if (winner === 'playoffs' && size == null) throw new Error('Indicá cuántas parejas pasan a playoffs');
  if (winner === 'tabla' && size != null) out.playoff_size = null;
  return out;
}
