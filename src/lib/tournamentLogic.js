// Lógica pura de los formatos de torneo: calendario de la previa, tabla de
// parejas y cuadro eliminatorio. No toca la base: las rutas leen, llaman acá y
// guardan. Vive aparte de routes/tournaments.js para poder testearla
// (test/tournamentLogic.test.js).
import { MAX_PREVIA_MATCHES } from './fixture.js';

// W.O.: la pareja que se retira pierde 6-0 (decisión de Fabri, 2026-11-07).
export const WALKOVER_WIN  = 6;
export const WALKOVER_LOSS = 0;

/** Una pareja retirada sigue en el torneo (su historia cuenta) pero ya no juega. */
export const isWithdrawn = (pair) => pair?.status === 'withdrawn';

const teamKey = (a, b) => [String(a), String(b)].sort().join('&');
const SCHEDULE_ATTEMPTS  = 200;

/**
 * Genera un calendario de fase previa donde cada pareja llega a 2 partidos
 * contra rivales distintos, contando los que ya jugó.
 *
 * Los partidos ya registrados se devuelven como parte del calendario (el front
 * los muestra con su resultado) y consumen cupo: una pareja con 2 partidos
 * jugados no recibe nuevos cruces, y una con 1 recibe uno solo, contra un rival
 * al que todavía no enfrentó.
 *
 * @param {Array} pairs   - [{ id, p1_id, p2_id, p1_name, p2_name }]
 * @param {Array} matches - partidos de la fase previa del torneo, jugados Y
 *                          programados: los dos consumen cupo de la pareja y
 *                          bloquean la revancha.
 * @returns {Array} - [{ round, team1: { id, name }, team2: { id, name } }]
 */
export function generatePreviaSchedule(pairs, matches = []) {
  const key      = (p) => String(p.id);
  const pairName = (p) => `${p.p1_name} & ${p.p2_name}`;
  const findPair = (a, b) => pairs.find((pr) =>
    (String(pr.p1_id) === String(a) && String(pr.p2_id) === String(b)) ||
    (String(pr.p1_id) === String(b) && String(pr.p2_id) === String(a))
  );

  // Partidos ya jugados: cuentan para el cupo de 2 y bloquean la revancha.
  const playedFixtures = [];
  const played = new Map(pairs.map((p) => [key(p), 0]));
  const faced  = new Map(pairs.map((p) => [key(p), new Set()]));
  for (const m of matches) {
    const a = findPair(m.team1_p1, m.team1_p2);
    const b = findPair(m.team2_p1, m.team2_p2);
    if (!a || !b || key(a) === key(b)) continue;   // partido que no mapea a las parejas actuales
    played.set(key(a), played.get(key(a)) + 1);
    played.set(key(b), played.get(key(b)) + 1);
    faced.get(key(a)).add(key(b));
    faced.get(key(b)).add(key(a));
    playedFixtures.push([a, b]);
  }

  // Una pareja retirada no recibe cruces nuevos, pero sus partidos jugados sí
  // cuentan para el cupo de sus rivales: por eso está en `pairs`.
  const need = new Map(pairs.map((p) => [key(p),
    isWithdrawn(p) ? 0 : Math.max(0, MAX_PREVIA_MATCHES - played.get(key(p)))]));

  // Con 2 partidos por pareja el calendario es una unión de ciclos, y un ciclo de
  // largo impar obliga a una 3ª ronda. Encadenar todo en un único ciclo mantiene
  // el calendario en 2 rondas (3 sólo si el total de parejas es impar).
  let best = buildCycleFixtures(pairs, need, faced, playedFixtures);

  // Si la topología de los partidos ya jugados no permite un ciclo único (o no se
  // encontró encadenado válido), greedy aleatorio con reintentos: puede quedar una
  // pareja cuyos únicos rivales disponibles ya enfrentó, así que probamos varias
  // veces y nos quedamos con la que deja menos cupo libre.
  if (!best) {
    for (const allowRematch of [false, true]) {
      for (let i = 0; i < SCHEDULE_ATTEMPTS; i++) {
        const attempt = buildFixtures(pairs, need, faced, allowRematch);
        if (!best || attempt.leftover < best.leftover) best = attempt;
        if (best.leftover === 0) break;
      }
      if (best.leftover === 0) break;
    }
  }

  return assignRounds([...playedFixtures, ...best.fixtures], pairName);
}

/**
 * Arma los cruces faltantes encadenando todo en un único ciclo.
 *
 * Los partidos ya jugados forman cadenas (caminos) de parejas; las parejas sin
 * partidos son cadenas de una. Ordenando las cadenas al azar y uniendo el final
 * de cada una con el principio de la siguiente se cierra un ciclo único, donde
 * cada pareja queda con exactamente 2 partidos y el calendario entra en 2 rondas.
 *
 * @returns {{ fixtures: Array<[pair, pair]>, leftover: 0 } | null} null si la
 *   topología no lo permite (una pareja con 3+ partidos jugados, ramificaciones)
 *   o si no se encontró un encadenado sin revanchas.
 */
function buildCycleFixtures(pairs, need, faced, playedFixtures) {
  const byKey = new Map(pairs.map((p) => [String(p.id), p]));
  const adj   = new Map(pairs.map((p) => [String(p.id), new Set()]));
  for (const [a, b] of playedFixtures) {
    adj.get(String(a.id)).add(String(b.id));
    adj.get(String(b.id)).add(String(a.id));
  }

  // Cada componente conexo aporta una cadena con sus dos extremos libres.
  const visited = new Set();
  const chains  = [];
  for (const p of pairs) {
    const start = String(p.id);
    if (visited.has(start)) continue;
    const comp  = [];
    const stack = [start];
    visited.add(start);
    while (stack.length > 0) {
      const cur = stack.pop();
      comp.push(cur);
      for (const nb of adj.get(cur)) if (!visited.has(nb)) { visited.add(nb); stack.push(nb); }
    }
    const free = comp.filter((v) => need.get(v) > 0);
    if (free.length === 0) continue;                                  // ya completó sus 2 partidos
    if (comp.length === 1) { chains.push([start, start]); continue; } // pareja sin partidos: cadena de una
    if (free.length === 2 && free.every((v) => need.get(v) === 1)) { chains.push([free[0], free[1]]); continue; }
    return null;                                                      // topología inesperada
  }

  if (chains.length === 0) return { fixtures: [], leftover: 0 };

  for (let attempt = 0; attempt < SCHEDULE_ATTEMPTS; attempt++) {
    // Orden y orientación de las cadenas al azar → ciclo distinto en cada intento.
    const order = chains
      .map((c) => ({ c, r: Math.random() }))
      .sort((x, y) => x.r - y.r)
      .map(({ c }) => (Math.random() < 0.5 ? [c[1], c[0]] : c));

    const fixtures = [];
    const used = new Set();
    let ok = true;
    for (let i = 0; i < order.length && ok; i++) {
      const a = order[i][1];
      const b = order[(i + 1) % order.length][0];
      const edge = [a, b].sort().join('|');
      if (a === b || used.has(edge) || faced.get(a).has(b)) { ok = false; break; }
      used.add(edge);
      fixtures.push([byKey.get(a), byKey.get(b)]);
    }
    if (ok) return { fixtures, leftover: 0 };
  }

  return null;
}

/**
 * Arma cruces respetando el cupo restante de cada pareja (`need`) y, salvo que
 * `allowRematch` lo permita, sin repetir rivales ya enfrentados.
 * @returns {{ fixtures: Array<[pair, pair]>, leftover: number }} leftover = cupo que no se pudo cubrir
 */
function buildFixtures(pairs, need, faced, allowRematch) {
  const remaining = new Map(need);
  const scheduled = new Map(pairs.map((p) => [String(p.id), new Set()]));
  const fixtures  = [];
  let leftover    = 0;

  // De los candidatos con más cupo pendiente, uno al azar.
  const pickHungriest = (list) => {
    const max = Math.max(...list.map((p) => remaining.get(String(p.id))));
    const top = list.filter((p) => remaining.get(String(p.id)) === max);
    return top[Math.floor(Math.random() * top.length)];
  };

  for (;;) {
    const active = pairs.filter((p) => remaining.get(String(p.id)) > 0);
    if (active.length < 2) break;

    const a  = pickHungriest(active);
    const ka = String(a.id);
    const candidates = active.filter((p) => {
      const kp = String(p.id);
      if (kp === ka) return false;
      if (scheduled.get(ka).has(kp)) return false;
      return allowRematch || !faced.get(ka).has(kp);
    });

    if (candidates.length === 0) {
      leftover += remaining.get(ka);
      remaining.set(ka, 0);
      continue;
    }

    const b  = pickHungriest(candidates);
    const kb = String(b.id);
    remaining.set(ka, remaining.get(ka) - 1);
    remaining.set(kb, remaining.get(kb) - 1);
    scheduled.get(ka).add(kb);
    scheduled.get(kb).add(ka);
    fixtures.push([a, b]);
  }

  // Las parejas que quedaron solas (sin rival con cupo) también cuentan.
  for (const p of pairs) leftover += remaining.get(String(p.id));

  return { fixtures, leftover };
}

/**
 * Agrupa los cruces en rondas donde ninguna pareja juega dos veces — así toda una
 * ronda puede jugarse en paralelo.
 *
 * Los cruces se recorren siguiendo las cadenas del calendario (cada partido
 * arranca donde terminó el anterior) y a cada uno se le da la ronda más baja
 * libre: alternando así, un ciclo par entra en 2 rondas y uno impar en 3, que es
 * el mínimo posible. Ordenar por orden de aparición, en cambio, estira el
 * calendario con rondas de relleno.
 */
function assignRounds(fixtures, pairName) {
  const edges = fixtures.map(([a, b], i) => ({ i, a: String(a.id), b: String(b.id) }));
  const incident = new Map();
  for (const e of edges) {
    for (const v of [e.a, e.b]) {
      if (!incident.has(v)) incident.set(v, []);
      incident.get(v).push(e);
    }
  }

  // Arrancar por las parejas con un solo partido (extremos de cadena) para que el
  // recorrido siga caminos completos antes de entrar en los ciclos.
  const starts = [...incident.keys()].sort(
    (x, y) => incident.get(x).length - incident.get(y).length
  );

  const walked = new Set();
  const order  = [];
  for (const start of starts) {
    let v = start;
    for (;;) {
      const next = incident.get(v).find((e) => !walked.has(e.i));
      if (!next) break;
      walked.add(next.i);
      order.push(next);
      v = next.a === v ? next.b : next.a;
    }
  }

  const busy   = [];   // busy[r] = Set de parejas que ya juegan en la ronda r
  const rounds = new Array(edges.length);
  for (const e of order) {
    let r = 0;
    while (busy[r] && (busy[r].has(e.a) || busy[r].has(e.b))) r++;
    if (!busy[r]) busy[r] = new Set();
    busy[r].add(e.a);
    busy[r].add(e.b);
    rounds[e.i] = r + 1;
  }

  return fixtures
    .map(([a, b], i) => ({
      round: rounds[i],
      team1: { id: a.id, name: pairName(a) },
      team2: { id: b.id, name: pairName(b) },
    }))
    .sort((x, y) => x.round - y.round);
}

// Proporción de partidos ganados; 0 si no jugó. Separada para que el desempate
// del back y el del front (compareStandingRows) usen la misma cuenta.
export function winRate(wins, played) {
  return played > 0 ? wins / played : 0;
}

// Desempate de la tabla de parejas, decidido por Fabri el 2026-11-08:
// victorias, diferencia de games, % de victorias, games a favor y, si todo
// empata, el pair_id — sin ese último criterio el orden lo terminaba decidiendo
// el orden de filas que devolvía Postgres, que difiere entre queries.
// Debe coincidir con compareStandingRows del front (utils/helpers.js).
export function comparePairRows(a, b) {
  return (b.points ?? 0) - (a.points ?? 0)
      || b.wins - a.wins
      || b.diff - a.diff
      || winRate(b.wins, b.played) - winRate(a.wins, a.played)
      || b.gf - a.gf
      || String(a.pair_id).localeCompare(String(b.pair_id));
}

/**
 * Calcula la tabla de posiciones de la fase previa para cada pareja.
 * El orden debe ser idéntico al de la tabla que arma el front (Standings.jsx):
 * si divergen, el seed del cuadro no coincide con la posición de la tabla.
 * @param {Array} pairs  - [{ id, p1_id, p2_id, p1_name, p2_name }]
 * @param {Array} matches - registros de la tabla matches
 * @returns {Array} standings ordenados con comparePairRows
 */
export function computeStandings(pairs, matches, { win = 3, loss = 0 } = {}) {
  return pairs
    .map((pr) => {
      let wins = 0;
      let losses = 0;
      let played = 0;
      let gf = 0;
      let gc = 0;
      for (const m of matches) {
        const s1 = Number(m.score1), s2 = Number(m.score2);
        // Igual que calcStandings: un partido sin cargar o igualado no cuenta.
        if (!Number.isFinite(s1) || !Number.isFinite(s2) || s1 === s2) continue;
        const isTeam1 = m.team1_p1 === pr.p1_id || m.team1_p1 === pr.p2_id
                     || m.team1_p2 === pr.p1_id || m.team1_p2 === pr.p2_id;
        const isTeam2 = m.team2_p1 === pr.p1_id || m.team2_p1 === pr.p2_id
                     || m.team2_p2 === pr.p1_id || m.team2_p2 === pr.p2_id;
        if (isTeam1 || isTeam2) played++;
        const won = isTeam1 ? s1 > s2 : s2 > s1;
        if (isTeam1 || isTeam2) {
          if (won) wins++;
          // La derrota por W.O. no suma los puntos de derrota.
          else if (!m.walkover) losses++;
          gf += isTeam1 ? s1 : s2; gc += isTeam1 ? s2 : s1;
        }
      }
      return {
        pair_id:   pr.id,
        pair_name: `${pr.p1_name} & ${pr.p2_name}`,
        wins,
        points: wins * win + losses * loss,
        played,
        diff: gf - gc,
        gf,
        withdrawn: isWithdrawn(pr),
      };
    })
    // Las retiradas van al fondo: en el cuadro toman los últimos seeds.
    .sort((a, b) => Number(a.withdrawn) - Number(b.withdrawn) || comparePairRows(a, b))
    .map((s, i) => ({ ...s, seed: i + 1 }));
}

/**
 * Parejas que todavía no completaron la fase previa: menos de
 * MAX_PREVIA_MATCHES partidos jugados con esa misma dupla. Cuenta igual que
 * `pairMatchCounts` de Previa.jsx: el partido es de la pareja sólo si el equipo
 * son exactamente sus dos jugadores.
 * @returns {Array} parejas con cupo pendiente, cada una con `played`
 */
export function previaPendingPairs(pairs, matches) {
  const key = (a, b) => [String(a), String(b)].sort().join('|');
  const count = new Map(pairs.map((p) => [key(p.p1_id, p.p2_id), 0]));
  for (const m of matches) {
    for (const k of [key(m.team1_p1, m.team1_p2), key(m.team2_p1, m.team2_p2)]) {
      if (count.has(k)) count.set(k, count.get(k) + 1);
    }
  }
  return pairs
    .filter((p) => !isWithdrawn(p))
    .map((p) => ({ ...p, played: count.get(key(p.p1_id, p.p2_id)) }))
    .filter((p) => p.played < MAX_PREVIA_MATCHES);
}

/**
 * La previa terminó cuando quedan menos de 2 parejas con cupo: un partido
 * necesita dos. Misma regla que `previaComplete` en Previa.jsx.
 */
export function isPreviaComplete(pairs, matches) {
  return pairs.some((p) => !isWithdrawn(p)) && previaPendingPairs(pairs, matches).length < 2;
}

/**
 * Los partidos programados de una pareja que se retira, convertidos en W.O.:
 * la pareja pierde 6-0 y el rival gana. Los programados que no son de esa
 * pareja no se tocan.
 * @param {{p1_id, p2_id}} pair
 * @param {Array} scheduledRows - filas de scheduled_matches
 * @returns {Array<{scheduled_id, team1, team2, score1, score2, court}>}
 */
export function walkoverMatchesFor(pair, scheduledRows) {
  const k = teamKey(pair.p1_id, pair.p2_id);
  const out = [];
  for (const r of scheduledRows) {
    const k1 = teamKey(r.team1_p1, r.team1_p2);
    const k2 = teamKey(r.team2_p1, r.team2_p2);
    if (k1 !== k && k2 !== k) continue;
    const pairIsTeam1 = k1 === k;
    out.push({
      scheduled_id: r.id,
      team1: [r.team1_p1, r.team1_p2],
      team2: [r.team2_p1, r.team2_p2],
      score1: pairIsTeam1 ? WALKOVER_LOSS : WALKOVER_WIN,
      score2: pairIsTeam1 ? WALKOVER_WIN : WALKOVER_LOSS,
      court: r.court ?? null,
    });
  }
  return out;
}

/** Un partido del cuadro se puede jugar sólo con las dos parejas definidas. */
export function isBracketMatchReady(match) {
  return match?.pair1_id != null && match?.pair2_id != null;
}

/**
 * Separa el calendario generado en lo que hay que guardar. Los cruces que ya
 * existen (jugados o programados) vuelven en el calendario con su ronda: los
 * programados se actualizan con esa ronda y los jugados se ignoran.
 * @param {Array} schedule  - salida de generatePreviaSchedule
 * @param {Array} pairs     - [{ id, p1_id, p2_id }]
 * @param {Array} played    - filas de matches
 * @param {Array} scheduled - filas de scheduled_matches (con id)
 * @returns {{ toInsert: Array<{round, team1:[p1,p2], team2:[p1,p2]}>, toUpdate: Array<{id, round}> }}
 */
export function planScheduleRows(schedule, pairs, played, scheduled) {
  const teamKey  = (a, b) => [String(a), String(b)].sort().join('&');
  const matchKey = (t1, t2) => [t1, t2].sort().join('|');
  const pairById = new Map(pairs.map((p) => [String(p.id), p]));
  const rowKey   = (r) => matchKey(teamKey(r.team1_p1, r.team1_p2), teamKey(r.team2_p1, r.team2_p2));

  const playedKeys    = new Set(played.map(rowKey));
  const scheduledByKey = new Map(scheduled.map((r) => [rowKey(r), r]));

  const toInsert = [];
  const toUpdate = [];
  for (const entry of schedule) {
    const a = pairById.get(String(entry.team1.id));
    const b = pairById.get(String(entry.team2.id));
    if (!a || !b) continue;
    const k = matchKey(teamKey(a.p1_id, a.p2_id), teamKey(b.p1_id, b.p2_id));
    if (playedKeys.has(k)) continue;
    const existing = scheduledByKey.get(k);
    if (existing) {
      if (existing.round !== entry.round) toUpdate.push({ id: existing.id, round: entry.round });
      continue;
    }
    toInsert.push({ round: entry.round, team1: [a.p1_id, a.p2_id], team2: [b.p1_id, b.p2_id] });
  }
  return { toInsert, toUpdate };
}

/**
 * Construye la estructura completa del bracket americano a partir de los standings.
 * - N pares totales (8-16)
 * - D = 16 - N pasan directo a cuartos (seeds 1..D)
 * - N - D pares juegan octavos (N - 8 partidos)
 * - Cuartos: [[1,8],[4,5],[2,7],[3,6]] seeds
 * - Semis: winner(q0) vs winner(q1), winner(q2) vs winner(q3)
 * - Final: winner(s0) vs winner(s1)
 */
export function generateBracket(standings) {
  const N = standings.length;
  const D = 16 - N; // directos a cuartos (puede ser 0)

  // Octavos: seeds D+1..N en pares (primero vs último, segundo vs penúltimo, ...)
  const octavosTeams = standings.slice(D); // índices D..N-1 (seeds D+1..N)
  const octavos = [];
  for (let i = 0; i < octavosTeams.length / 2; i++) {
    const hi = octavosTeams[i];                              // seed D+1+i
    const lo = octavosTeams[octavosTeams.length - 1 - i];   // seed N-i
    octavos.push({
      id:          `o${i}`,
      pair1_id:    hi.pair_id,
      pair1_name:  hi.pair_name,
      pair2_id:    lo.pair_id,
      pair2_name:  lo.pair_name,
      score1:      null,
      score2:      null,
      winner_id:   null,
      winner_name: null,
      // el ganador ocupa el seed D+1+i en cuartos
      winner_seed: D + 1 + i,
    });
  }

  // Cuartos: siempre 4 partidos con seeds [1,8],[4,5],[2,7],[3,6]
  const qfPairings = [[1, 8], [4, 5], [2, 7], [3, 6]];
  const cuartos = qfPairings.map(([s1, s2], i) => {
    const slot1 = slotForSeed(s1, D, standings, octavos);
    const slot2 = slotForSeed(s2, D, standings, octavos);
    return {
      id:          `q${i}`,
      slot1_seed:  s1,
      slot2_seed:  s2,
      slot1_source: s1 > D ? `o${s1 - D - 1}` : null,
      slot2_source: s2 > D ? `o${s2 - D - 1}` : null,
      pair1_id:    slot1.pair_id,
      pair1_name:  slot1.pair_name,
      pair2_id:    slot2.pair_id,
      pair2_name:  slot2.pair_name,
      score1:      null,
      score2:      null,
      winner_id:   null,
      winner_name: null,
    };
  });

  const semis = [
    { id: 's0', source1: 'q0', source2: 'q1', pair1_id: null, pair1_name: null, pair2_id: null, pair2_name: null, score1: null, score2: null, winner_id: null, winner_name: null },
    { id: 's1', source1: 'q2', source2: 'q3', pair1_id: null, pair1_name: null, pair2_id: null, pair2_name: null, score1: null, score2: null, winner_id: null, winner_name: null },
  ];

  const final = {
    id: 'f0', source1: 's0', source2: 's1',
    pair1_id: null, pair1_name: null,
    pair2_id: null, pair2_name: null,
    score1: null, score2: null,
    winner_id: null, winner_name: null,
  };

  return applyBracketWalkovers({
    generated_at: new Date().toISOString(),
    total_pairs:  N,
    direct_count: D,
    standings,
    octavos,
    cuartos,
    semis,
    final,
    withdrawn_pair_ids: standings.filter((s) => s.withdrawn).map((s) => s.pair_id),
  });
}

/**
 * Resuelve por W.O. (6-0) cada partido del cuadro que ya tiene sus dos
 * parejas y en el que juega una retirada; el ganador avanza y, si en la ronda
 * siguiente lo espera otra retirada, también se resuelve. Si las dos están
 * retiradas avanza la pareja 1 (el seed más alto) y pierde en la próxima.
 * @returns {Object} bracket nuevo (no modifica el recibido)
 */
export function applyBracketWalkovers(bracket) {
  const withdrawn = new Set((bracket.withdrawn_pair_ids ?? []).map(String));
  if (withdrawn.size === 0) return bracket;
  let b = bracket;
  const order = () => [...(b.octavos ?? []), ...(b.cuartos ?? []), ...(b.semis ?? []), b.final];
  for (let changed = true; changed;) {
    changed = false;
    for (const m of order()) {
      if (m.winner_id != null || !isBracketMatchReady(m)) continue;
      const w1 = withdrawn.has(String(m.pair1_id));
      const w2 = withdrawn.has(String(m.pair2_id));
      if (!w1 && !w2) continue;
      const pair1Wins = !w1 || w2;
      b = applyBracketResult(b, m.id,
        pair1Wins ? WALKOVER_WIN : WALKOVER_LOSS,
        pair1Wins ? WALKOVER_LOSS : WALKOVER_WIN,
        null, null, { walkover: true });
      changed = true;
      break;
    }
  }
  return b;
}

/**
 * Retorna el par (o placeholder) que ocupa un seed slot en cuartos.
 * Si el seed es directo (s <= D), el par ya está disponible.
 * Si viene de octavos (s > D), el par es null hasta que se juegue ese octavo.
 */
function slotForSeed(seed, D, standings, octavos) {
  if (seed <= D) {
    const s = standings[seed - 1];
    return { pair_id: s.pair_id, pair_name: s.pair_name };
  }
  // El winner del octavo correspondiente aún no se conoce
  return { pair_id: null, pair_name: null };
}

/**
 * Aplica el resultado de un partido del bracket, determina el ganador
 * y lo propaga a la siguiente ronda.
 * @returns {Object|null} bracket actualizado, o null si no encontró el partido
 */
export function applyBracketResult(bracket, matchId, score1, score2, duration_seconds = null, court = null, setsData = {}) {
  const b = JSON.parse(JSON.stringify(bracket)); // clonar

  const match = findBracketMatch(b, matchId);
  if (!match) return null;

  const winner = score1 > score2 ? 'pair1' : 'pair2';
  const winnerId = match[`${winner}_id`];

  // Al editar un resultado ya cargado puede cambiar el ganador: las rondas
  // posteriores quedarían con la pareja eliminada, así que se deshacen antes.
  if (match.winner_id !== null && match.winner_id !== winnerId) clearDescendants(b, matchId);

  match.score1           = score1;
  match.score2           = score2;
  match.duration_seconds = duration_seconds;
  match.court            = court;
  match.sets_format      = setsData.sets_format ?? null;
  match.sets             = setsData.sets ?? [];
  match.walkover         = setsData.walkover === true;
  match.winner_id        = winnerId;
  match.winner_name      = match[`${winner}_name`];

  if (b.final.id !== matchId) propagateWinner(b, matchId, match.winner_id, match.winner_name);

  return b;
}

/**
 * Deshace el resultado de un partido del cuadro y, en cascada, el de todos los
 * partidos posteriores que se alimentaban de su ganador.
 * @returns {Object|null} bracket actualizado, o null si no encontró el partido
 */
export function clearBracketResult(bracket, matchId) {
  const b = JSON.parse(JSON.stringify(bracket));
  const match = findBracketMatch(b, matchId);
  if (!match) return null;

  clearDescendants(b, matchId);
  resetMatchResult(match);
  return b;
}

/** Limpia los slots y resultados de todo lo que cuelga de un partido. */
function clearDescendants(bracket, matchId) {
  const queue = [matchId];
  while (queue.length) {
    const child = findChildSlot(bracket, queue.shift());
    if (!child) continue;
    child.match[`pair${child.slot}_id`]   = null;
    child.match[`pair${child.slot}_name`] = null;
    if (child.match.winner_id !== null) {
      resetMatchResult(child.match);
      queue.push(child.match.id);
    }
  }
}

function resetMatchResult(match) {
  match.score1           = null;
  match.score2           = null;
  match.duration_seconds = null;
  match.court            = null;
  match.sets_format      = null;
  match.sets             = [];
  match.walkover         = false;
  match.winner_id        = null;
  match.winner_name      = null;
}

export function findBracketMatch(bracket, matchId) {
  if (bracket.final?.id === matchId) return bracket.final;
  for (const round of ['octavos', 'cuartos', 'semis']) {
    const found = (bracket[round] ?? []).find((m) => m.id === matchId);
    if (found) return found;
  }
  return null;
}

/**
 * Inverso de propagateWinner: qué partido y qué slot alimenta el ganador de matchId.
 * Los slots de cuartos sin source (parejas con bye) no dependen de ningún resultado.
 */
function findChildSlot(bracket, matchId) {
  for (const qm of bracket.cuartos) {
    if (qm.slot1_source === matchId) return { match: qm, slot: 1 };
    if (qm.slot2_source === matchId) return { match: qm, slot: 2 };
  }
  for (const sm of bracket.semis) {
    if (sm.source1 === matchId) return { match: sm, slot: 1 };
    if (sm.source2 === matchId) return { match: sm, slot: 2 };
  }
  if (bracket.final.source1 === matchId) return { match: bracket.final, slot: 1 };
  if (bracket.final.source2 === matchId) return { match: bracket.final, slot: 2 };
  return null;
}

/**
 * Busca qué partido tiene como fuente (source1/source2) el matchId completado
 * y rellena pair1 o pair2 con el ganador.
 */
function propagateWinner(bracket, completedId, winnerId, winnerName) {
  // octavos → cuartos
  for (const qm of bracket.cuartos) {
    if (qm.slot1_source === completedId) {
      qm.pair1_id   = winnerId;
      qm.pair1_name = winnerName;
      return;
    }
    if (qm.slot2_source === completedId) {
      qm.pair2_id   = winnerId;
      qm.pair2_name = winnerName;
      return;
    }
  }

  // cuartos → semis
  for (const sm of bracket.semis) {
    if (sm.source1 === completedId) {
      sm.pair1_id   = winnerId;
      sm.pair1_name = winnerName;
      return;
    }
    if (sm.source2 === completedId) {
      sm.pair2_id   = winnerId;
      sm.pair2_name = winnerName;
      return;
    }
  }

  // semis → final
  if (bracket.final.source1 === completedId) {
    bracket.final.pair1_id   = winnerId;
    bracket.final.pair1_name = winnerName;
  } else if (bracket.final.source2 === completedId) {
    bracket.final.pair2_id   = winnerId;
    bracket.final.pair2_name = winnerName;
  }
}

const emptyResult = () => ({ score1: null, score2: null, winner_id: null, winner_name: null });

/**
 * Cuadro de playoffs de una liga: las primeras parejas de la tabla, de 2 a 16.
 * Con 8 o más usa el cuadro del americano. Con menos, los primeros pasan
 * directo y el resto juega una ronda previa; el ganador toma el seed del mejor
 * ubicado de su cruce.
 * @param {Array} standings - ya ordenados y recortados al tamaño de los playoffs
 */
export function generatePlayoffBracket(standings) {
  const N = standings.length;
  if (N < 2 || N > 16) throw new Error('Los playoffs van de 2 a 16 parejas');
  if (N >= 8) return { ...generateBracket(standings), kind: 'playoffs' };

  const seed = (s) => ({ pair_id: standings[s - 1].pair_id, pair_name: standings[s - 1].pair_name });
  // Ronda principal: 2 o 4 lugares. Los que no entran directo juegan la previa.
  const M = N >= 4 ? 4 : 2;
  const D = 2 * M - N;
  const previaKey = M === 4 ? 'cuartos' : 'semis';
  const previa = [];
  for (let i = 0; i < N - M; i++) {
    const hi = D + 1 + i;
    const lo = N - i;
    previa.push({
      id: `${previaKey[0]}${i}`,
      ...Object.fromEntries(Object.entries(seed(hi)).map(([k, v]) => [k.replace('pair_', 'pair1_'), v])),
      ...Object.fromEntries(Object.entries(seed(lo)).map(([k, v]) => [k.replace('pair_', 'pair2_'), v])),
      ...emptyResult(),
      winner_seed: hi,
    });
  }
  // Un lugar de la ronda principal: la pareja directa o el ganador de un cruce previo.
  const slot = (s) => (s <= D
    ? { source: null, seedNum: s, ...seed(s) }
    : { source: previa[s - D - 1].id, seedNum: s, pair_id: null, pair_name: null });
  const cruce = (id, a, b, extra = {}) => {
    const s1 = slot(a), s2 = slot(b);
    return {
      id, source1: s1.source, source2: s2.source, seed1: s1.seedNum, seed2: s2.seedNum,
      pair1_id: s1.pair_id, pair1_name: s1.pair_name, pair2_id: s2.pair_id, pair2_name: s2.pair_name,
      ...emptyResult(), ...extra,
    };
  };

  let semis = [];
  let final;
  if (M === 4) {
    semis = [cruce('s0', 1, 4), cruce('s1', 2, 3)];
    final = { id: 'f0', source1: 's0', source2: 's1', pair1_id: null, pair1_name: null, pair2_id: null, pair2_name: null, ...emptyResult() };
  } else {
    semis = previa;
    final = cruce('f0', 1, 2);
  }

  return applyBracketWalkovers({
    kind: 'playoffs',
    generated_at: new Date().toISOString(),
    total_pairs: N,
    direct_count: D,
    standings,
    octavos: [],
    cuartos: M === 4 ? previa : [],
    semis,
    final,
    withdrawn_pair_ids: [],
  });
}
