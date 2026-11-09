// Reglas puras de la inscripción a torneos. Las rutas (routes/registrations.js)
// leen la base, llaman acá y escriben. Tests: test/registrations.test.js.

/** Estados que ocupan al usuario: no puede tener otra inscripción en el torneo. */
export const ACTIVE_STATUSES = ['pending', 'approved', 'waitlist'];

/** Tope del americano: 16 parejas. */
export const AMERICANO_MAX_PLAYERS = 32;

/** Lugares que ocupa una inscripción, contados en jugadores. */
export const slotsFor = (kind) => (kind === 'pair' ? 2 : 1);

/**
 * Cupo en jugadores. El organizador lo carga en parejas o en jugadores; en
 * americano nunca pasa de 16 parejas. null = sin cupo.
 */
export function capacityInPlayers({ capacity, unit, format }) {
  let cap = capacity == null ? null : capacity * (unit === 'player' ? 1 : 2);
  if (format === 'americano') cap = cap == null ? AMERICANO_MAX_PLAYERS : Math.min(cap, AMERICANO_MAX_PLAYERS);
  return cap;
}

/** ¿Entra una inscripción más? `used` = jugadores que ya están en el torneo. */
export function hasRoom(used, kind, capPlayers) {
  return capPlayers == null || used + slotsFor(kind) <= capPlayers;
}

/**
 * ¿Se aceptan inscripciones nuevas? Cierra con el interruptor apagado, con la
 * fecha de cierre vencida, con el torneo finalizado o con el cuadro generado.
 * @returns {{ open: boolean, reason: string|null }}
 */
export function signupState(signup, tournament, now = new Date()) {
  if (tournament.status === 'finished') return { open: false, reason: 'El torneo ya terminó' };
  if (tournament.bracket) return { open: false, reason: 'El cuadro ya fue generado' };
  if (!signup.open) return { open: false, reason: 'La inscripción está cerrada' };
  if (signup.closes_at && now >= new Date(signup.closes_at)) {
    return { open: false, reason: 'La inscripción ya cerró' };
  }
  return { open: true, reason: null };
}

/**
 * Datos del compañero sin cuenta: nombre y teléfono, los dos obligatorios.
 * @returns {{ name: string, phone: string }}
 * @throws {Error} con el mensaje para el usuario
 */
export function parseGuestPartner({ name, phone } = {}) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  const p = String(phone ?? '').trim();
  if (n.length < 2 || n.length > 40) throw new Error('El nombre del compañero debe tener entre 2 y 40 caracteres');
  if (!/^[+\d][\d\s()-]{5,24}$/.test(p)) throw new Error('El teléfono del compañero no es válido');
  return { name: n, phone: p };
}

/**
 * Contadores del panel del organizador.
 * @param {Array<{status, kind, paid, solo_unpaired?}>} rows
 */
export function summarize(rows) {
  const out = { pending: 0, approved: 0, waitlist: 0, rejected: 0, cancelled: 0, paid: 0, solo_unpaired: 0 };
  for (const r of rows) {
    out[r.status] = (out[r.status] ?? 0) + 1;
    if (r.paid && r.status === 'approved') out.paid++;
    if (r.solo_unpaired) out.solo_unpaired++;
  }
  return out;
}

// ── Lo que ve el público (Fabri, 2026-11-09) ─────────────────────────────────
// El cupo no se muestra en números: sólo "hay cupos", "últimos cupos" o
// "cupo completo". Y el plantel (jugadores, parejas y fixture) queda oculto
// para los que no organizan hasta que empieza el torneo.

/**
 * 'open' | 'few' | 'full', o null sin cupo. "Últimos" = queda un 20 % del cupo
 * o menos (como mínimo, el lugar de una pareja).
 */
export function availability(capPlayers, used) {
  if (capPlayers == null) return null;
  const left = capPlayers - used;
  if (left <= 0) return 'full';
  if (left <= Math.max(2, Math.ceil(capPlayers * 0.2))) return 'few';
  return 'open';
}

/** La inscripción sin los números del cupo, con su disponibilidad. */
export function publicSignup(signup, { format, used }) {
  const { capacity, capacity_unit, ...rest } = signup;
  const cap = capacityInPlayers({ capacity, unit: capacity_unit, format });
  return { ...rest, availability: availability(cap, used) };
}

/**
 * ¿Empezó el torneo? Con un partido cargado o en juego, con el cuadro armado,
 * finalizado, o cuando llega la fecha y hora del evento (hora de Argentina).
 */
export function hasStarted(t, matchCount = 0, now = new Date()) {
  if (t.status === 'finished' || t.bracket || matchCount > 0) return true;
  if (Array.isArray(t.live_match) && t.live_match.length > 0) return true;
  if (t.event_date) {
    const day = String(t.event_date).slice(0, 10);
    const time = String(t.event_time ?? '00:00').slice(0, 5);
    return now >= new Date(`${day}T${time}:00-03:00`);
  }
  return false;
}

/** Jugadores que ocupan lugar: los del torneo salvo los de parejas retiradas. */
export async function countUsedPlayers(sql, tournamentId) {
  const [{ n }] = await sql.query(`
    SELECT COUNT(*)::int AS n FROM tournament_players tp
    WHERE tp.tournament_id = $1
      AND (NOT EXISTS (SELECT 1 FROM pairs p WHERE p.tournament_id = $1 AND p.status = 'withdrawn'
                        AND tp.player_id IN (p.p1_id, p.p2_id))
           OR EXISTS  (SELECT 1 FROM pairs p WHERE p.tournament_id = $1 AND p.status = 'active'
                        AND tp.player_id IN (p.p1_id, p.p2_id)))`, [tournamentId]);
  return n;
}
