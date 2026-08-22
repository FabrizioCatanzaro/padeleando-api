// Reglas del fixture compartidas entre el alta de partidos programados y el
// generador de cruces de la fase previa. Estaban implementadas dos veces —una
// en tournaments.js y otra en Previa.jsx— y ninguna de las dos contaba los
// partidos programados, que es lo que ahora hay que sumar.

/** En la fase previa de un americano, cada pareja juega como mucho dos partidos. */
export const MAX_PREVIA_MATCHES = 2;

/**
 * Clave estable de una pareja a partir de sus dos jugadores. El orden en que
 * vienen no importa: [a,b] y [b,a] son la misma pareja.
 */
export function pairKey(players) {
  return [...players].filter(Boolean).map(String).sort().join('|');
}

/**
 * Cuántas veces aparece cada pareja en un conjunto de filas de partido
 * (jugados, programados, o los dos mezclados).
 * @param {Array<{team1_p1,team1_p2,team2_p1,team2_p2}>} rows
 * @returns {Map<string, number>} clave de pareja → cantidad de partidos
 */
export function countPairAppearances(rows = []) {
  const out = new Map();
  for (const r of rows) {
    for (const equipo of [[r.team1_p1, r.team1_p2], [r.team2_p1, r.team2_p2]]) {
      const k = pairKey(equipo);
      if (!k) continue;
      out.set(k, (out.get(k) ?? 0) + 1);
    }
  }
  return out;
}

/**
 * Qué cruces ya existen, para no repetir una revancha en la fase previa.
 * @returns {Map<string, Set<string>>} pareja → parejas contra las que ya juega
 */
export function buildFacedMap(rows = []) {
  const out = new Map();
  const add = (a, b) => {
    if (!a || !b) return;
    if (!out.has(a)) out.set(a, new Set());
    out.get(a).add(b);
  };
  for (const r of rows) {
    const k1 = pairKey([r.team1_p1, r.team1_p2]);
    const k2 = pairKey([r.team2_p1, r.team2_p2]);
    add(k1, k2);
    add(k2, k1);
  }
  return out;
}
