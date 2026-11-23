import { bracketNodes } from './profileStats.js';

export const COMPANIONS_LIMIT = 4;
export const SUGGESTED_LIMIT = 6;

export function normalizeName(name) {
  return String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Un jugador sin cuenta tiene un players.id por categoría: se lo reconoce por el nombre.
export function companionKey(userId, name) {
  if (userId) return `u:${userId}`;
  const n = normalizeName(name);
  return n ? `n:${n}` : null;
}

/** Compañeros y rivales del usuario en los cuadros (bracket y bracket_plata). */
export function bracketCompanions(rows) {
  const out = [];
  for (const row of rows) {
    const pairById = Object.fromEntries((row.pairs ?? []).map((p) => [String(p.id), p]));
    const nodes = [row.bracket, row.bracket_plata].filter(Boolean).flatMap(bracketNodes);
    for (const m of nodes) {
      if (m.winner_id == null || m.pair1_id == null || m.pair2_id == null || m.walkover) continue;
      const p1 = pairById[String(m.pair1_id)];
      const p2 = pairById[String(m.pair2_id)];
      if (!p1 || !p2 || p1.mine === p2.mine) continue;
      const [mine, other] = p1.mine ? [p1, p2] : [p2, p1];
      for (const member of mine.members ?? []) if (!member.me) out.push({ ...member, role: 'partner' });
      for (const member of other.members ?? []) out.push({ ...member, role: 'rival' });
    }
  }
  return out;
}

/**
 * Suma partidos como pareja y como rival por persona y devuelve los que más
 * jugaron con el usuario. Cada fila es { role, user_id, name, username, avatar_url }.
 */
export function mergeCompanions(rows, limit = COMPANIONS_LIMIT) {
  const byKey = new Map();
  for (const r of rows) {
    const key = companionKey(r.user_id, r.name);
    if (!key) continue;
    const row = byKey.get(key) ?? { key, name: r.name, username: null, avatar_url: null, juntos: 0, rival: 0 };
    if (r.username) { row.username = r.username; row.name = r.name; }
    if (r.avatar_url) row.avatar_url = r.avatar_url;
    if (r.role === 'partner') row.juntos++;
    else row.rival++;
    byKey.set(key, row);
  }
  return [...byKey.values()]
    .map((r) => ({ ...r, total: r.juntos + r.rival }))
    .sort((a, b) => b.total - a.total || b.juntos - a.juntos || a.name.localeCompare(b.name))
    .slice(0, limit);
}
