// Inscripción a torneos desde la app. Diseño: documento "Diseño: inscripción a
// torneos" (2026-11-09).
//   POST   /api/registrations                     el jugador se inscribe (solo o con pareja)
//   GET    /api/registrations/mine/:tournamentId  estado de la inscripción para quien mira
//   POST   /api/registrations/:id/cancel          el jugador cancela (hasta el cierre)
//   GET    /api/registrations/tournament/:tournamentId   panel del organizador
//   PATCH  /api/registrations/:id                 el organizador aprueba o rechaza
//   PATCH  /api/registrations/:id/paid            el organizador marca el pago
import { Router } from 'express';
import { sendDecisionMail } from '../lib/registrationMail.js';
import { getDb, withTransaction } from '../db.js';
import { uid } from '../uid.js';
import { requireAuth } from '../middleware/auth.js';
import { canManageGroup } from '../lib/access.js';
import { resolveSignup } from '../lib/signup.js';
import { parseAvailability, AvailabilityError } from '../lib/availability.js';
import { checkRegistrationLevel } from '../lib/category.js';
import {
  ACTIVE_STATUSES, capacityInPlayers, hasRoom, signupState, parseGuestPartner, summarize, publicSignup,
} from '../lib/registrations.js';

const router = Router();

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

// ── Lecturas compartidas ────────────────────────────────────────────────────

const TOURNAMENT_SQL = `
  SELECT t.id, t.group_id, t.name, t.format, t.mode, t.status, t.bracket, t.liga_mode,
         t.signup_open, t.signup_price, t.signup_price_unit, t.signup_contacts, t.level,
         t.signup_capacity, t.signup_capacity_unit, t.signup_closes_at, t.rules,
         g.user_id AS owner_id, g.signup_open AS g_signup_open, g.signup_price AS g_signup_price,
         g.signup_price_unit AS g_signup_price_unit, g.signup_contacts AS g_signup_contacts,
         g.level AS g_level, g.signup_capacity AS g_signup_capacity,
         g.signup_capacity_unit AS g_signup_capacity_unit, g.signup_closes_at AS g_signup_closes_at,
         g.rules AS g_rules,
         u.social_links AS owner_social_links, g.name AS group_name
  FROM tournaments t
  JOIN groups g ON g.id = t.group_id
  JOIN users  u ON u.id = g.user_id
  WHERE t.id = $1`;

/** Torneo + su inscripción ya resuelta entre jornada y categoría. */
async function loadTournament(q, tournamentId, { lock = false } = {}) {
  const { rows: [t] } = await q(TOURNAMENT_SQL + (lock ? ' FOR UPDATE OF t' : ''), [tournamentId]);
  if (!t) throw new HttpError(404, 'Torneo no encontrado');
  const signup = resolveSignup(t, {
    signup_open: t.g_signup_open, signup_price: t.g_signup_price, signup_price_unit: t.g_signup_price_unit,
    signup_contacts: t.g_signup_contacts, level: t.g_level, signup_capacity: t.g_signup_capacity,
    signup_capacity_unit: t.g_signup_capacity_unit, signup_closes_at: t.g_signup_closes_at,
    rules: t.g_rules,
  }, t.owner_social_links);
  return { t, signup };
}

/**
 * Jugadores que ya ocupan lugar en el torneo: los de tournament_players salvo
 * los que sólo figuran por una pareja retirada.
 */
async function usedPlayers(q, tournamentId) {
  const { rows: [{ n }] } = await q(`
    SELECT COUNT(*)::int AS n FROM tournament_players tp
    WHERE tp.tournament_id = $1
      AND (NOT EXISTS (SELECT 1 FROM pairs p WHERE p.tournament_id = $1 AND p.status = 'withdrawn'
                        AND tp.player_id IN (p.p1_id, p.p2_id))
           OR EXISTS  (SELECT 1 FROM pairs p WHERE p.tournament_id = $1 AND p.status = 'active'
                        AND tp.player_id IN (p.p1_id, p.p2_id)))`, [tournamentId]);
  return n;
}

/** ¿El usuario ya está en el torneo (cargado a mano o por otra inscripción)? */
async function userInTournament(q, tournamentId, userId) {
  const { rows } = await q(`
    SELECT 1 FROM players p
    JOIN tournament_players tp ON tp.player_id = p.id AND tp.tournament_id = $1
    WHERE p.user_id = $2 LIMIT 1`, [tournamentId, userId]);
  return rows.length > 0;
}

/** ¿El usuario tiene una inscripción activa en el torneo, como titular o compañero? */
async function userHasActiveRegistration(q, tournamentId, userId) {
  const { rows } = await q(`
    SELECT 1 FROM tournament_registrations
    WHERE tournament_id = $1 AND status = ANY($3::text[])
      AND (p1_user_id = $2 OR p2_user_id = $2) LIMIT 1`, [tournamentId, userId, ACTIVE_STATUSES]);
  return rows.length > 0;
}

async function groupManagers(q, groupId) {
  const { rows } = await q(`
    SELECT user_id FROM groups WHERE id = $1 AND user_id IS NOT NULL
    UNION SELECT user_id FROM group_collaborators WHERE group_id = $1`, [groupId]);
  return rows.map((r) => r.user_id);
}

// `title` guarda el estado decidido (approved, waitlist, rejected) en
// registration_decided: la inscripción puede cambiar después y el aviso
// tiene que seguir diciendo lo que pasó en ese momento.
async function notify(q, userIds, type, actorId, entityId, title = null) {
  const ids = [...new Set(userIds.filter((u) => u && u !== actorId))];
  if (!ids.length) return [];
  await q(`
    INSERT INTO notifications (id, user_id, type, actor_id, entity_id, title)
    SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])`,
    [ids.map(() => uid()), ids, ids.map(() => type), ids.map(() => actorId), ids.map(() => entityId), ids.map(() => title)]);
  return ids;
}

/** Adaptador: el driver HTTP con la misma firma que client.query. */
const httpQuery = (sql) => (text, params) => sql.query(text, params).then((rows) => ({ rows }));

function sendError(res, next, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err?.code === '23505' && String(err.constraint ?? err.message).includes('uq_registrations_active_p1')) {
    return res.status(409).json({ error: 'Ya tenés una inscripción en este torneo' });
  }
  return next(err);
}

// ── POST /api/registrations ─────────────────────────────────────────────────
// Body: { tournamentId, kind: 'solo'|'pair', partner?: { username } | { name, phone } }
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { tournamentId, kind, partner, accept_rules } = req.body;
    let availability = null;
    try { availability = parseAvailability(req.body.availability); }
    catch (e) { if (e instanceof AvailabilityError) throw new HttpError(400, e.message); throw e; }
    if (!tournamentId) throw new HttpError(400, 'tournamentId requerido');
    if (kind !== 'solo' && kind !== 'pair') throw new HttpError(400, 'kind debe ser "solo" o "pair"');

    const sql = getDb();
    const q = httpQuery(sql);
    const me = req.user.id;
    const { t, signup } = await loadTournament(q, tournamentId);

    const state = signupState(signup, t);
    if (!state.open) throw new HttpError(400, state.reason, 'signup_closed');
    if (await canManageGroup(sql, me, t.group_id)) {
      throw new HttpError(409, 'Organizás este torneo: cargate desde Gestión');
    }
    if (signup.rules && accept_rules !== true) {
      throw new HttpError(400, 'Tenés que aceptar el reglamento para inscribirte', 'rules_required');
    }

    const { rows: [meRow] } = await q('SELECT id, category FROM users WHERE id = $1', [me]);
    if (!meRow?.category) {
      throw new HttpError(400, 'Completá tu categoría en el perfil antes de inscribirte', 'category_required');
    }
    if (await userInTournament(q, tournamentId, me)) throw new HttpError(409, 'Ya estás en este torneo');
    if (await userHasActiveRegistration(q, tournamentId, me)) throw new HttpError(409, 'Ya tenés una inscripción en este torneo');

    let p2UserId = null, p2Name = null, p2Phone = null;
    if (kind === 'pair') {
      if (partner?.username) {
        const username = String(partner.username).replace(/^@/, '').trim().toLowerCase();
        const { rows: [p2] } = await q('SELECT id FROM users WHERE username = $1', [username]);
        if (!p2) throw new HttpError(404, `No existe el usuario @${username}`);
        if (p2.id === me) throw new HttpError(400, 'Tu compañero tiene que ser otra persona');
        if (await userInTournament(q, tournamentId, p2.id)) throw new HttpError(409, `@${username} ya está en este torneo`);
        if (await userHasActiveRegistration(q, tournamentId, p2.id)) {
          throw new HttpError(409, `@${username} ya tiene una inscripción en este torneo`);
        }
        p2UserId = p2.id;
      } else {
        try { ({ name: p2Name, phone: p2Phone } = parseGuestPartner(partner)); }
        catch (e) { throw new HttpError(400, e.message); }
      }
    }

    const id = uid();
    const { rows: [registration] } = await q(`
      INSERT INTO tournament_registrations
        (id, tournament_id, kind, created_by, p1_user_id, p2_user_id, p2_name, p2_phone, rules_accepted_at, availability)
      VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, $9::jsonb) RETURNING *`,
      [id, tournamentId, kind, me, p2UserId, p2Name, p2Phone, signup.rules ? new Date().toISOString() : null,
       // Solo las ligas en varios días piden disponibilidad.
       t.liga_mode === 'temporada' && availability ? JSON.stringify(availability) : null]);

    await notify(q, await groupManagers(q, t.group_id), 'registration_received', me, id);
    if (p2UserId) await notify(q, [p2UserId], 'registration_partner', me, id);

    res.status(201).json(registration);
  } catch (err) { sendError(res, next, err); }
});

// ── GET /api/registrations/mine ─────────────────────────────────────────────
// "Mis inscripciones": todas las del usuario, como titular o como compañero,
// con el torneo, la categoría y si todavía puede cancelar.
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const me = req.user.id;
    const rows = await sql.query(`
      SELECT r.id, r.tournament_id, r.kind, r.status, r.reject_reason, r.paid, r.created_at, r.decided_at,
             r.p1_user_id, r.p2_user_id, r.p2_name,
             u1.name AS p1_user_name, u1.username AS p1_username,
             u2.name AS p2_user_name, u2.username AS p2_username,
             t.name AS tournament_name, t.group_id, t.format, t.mode, t.status AS tournament_status, t.bracket,
             t.event_date, t.event_time,
             t.signup_open, t.signup_price, t.signup_price_unit, t.signup_contacts, t.level,
             t.signup_capacity, t.signup_capacity_unit, t.signup_closes_at,
             g.name AS group_name,
             g.signup_open AS g_signup_open, g.signup_price AS g_signup_price,
             g.signup_price_unit AS g_signup_price_unit, g.signup_contacts AS g_signup_contacts,
             g.level AS g_level, g.signup_capacity AS g_signup_capacity,
             g.signup_capacity_unit AS g_signup_capacity_unit, g.signup_closes_at AS g_signup_closes_at
      FROM   tournament_registrations r
      JOIN   tournaments t ON t.id = r.tournament_id
      JOIN   groups g ON g.id = t.group_id
      LEFT   JOIN users u1 ON u1.id = r.p1_user_id
      LEFT   JOIN users u2 ON u2.id = r.p2_user_id
      WHERE  r.p1_user_id = $1 OR r.p2_user_id = $1
      ORDER  BY r.created_at DESC
      LIMIT  100`, [me]);
    res.json(rows.map((r) => {
      const signup = resolveSignup(r, {
        signup_open: r.g_signup_open, signup_price: r.g_signup_price, signup_price_unit: r.g_signup_price_unit,
        signup_contacts: r.g_signup_contacts, level: r.g_level, signup_capacity: r.g_signup_capacity,
        signup_capacity_unit: r.g_signup_capacity_unit, signup_closes_at: r.g_signup_closes_at,
      });
      const state = signupState(signup, { status: r.tournament_status, bracket: r.bracket });
      // Visto desde el usuario: "vos" y tu compañero.
      const soyP1 = r.p1_user_id === me;
      const partner = r.kind === 'solo' ? null
        : soyP1 ? (r.p2_user_name ?? r.p2_name ?? null) : (r.p1_user_name ?? null);
      return {
        id: r.id, tournament_id: r.tournament_id, tournament_name: r.tournament_name,
        group_id: r.group_id, group_name: r.group_name,
        format: r.format, event_date: r.event_date, event_time: r.event_time,
        kind: r.kind, status: r.status, reject_reason: r.reject_reason, paid: r.paid,
        created_at: r.created_at, decided_at: r.decided_at,
        partner_name: partner, level: signup.level, closes_at: signup.closes_at,
        price: signup.price ?? null, price_unit: signup.unit ?? null,
        can_cancel: ACTIVE_STATUSES.includes(r.status) && state.open,
      };
    }));
  } catch (err) { sendError(res, next, err); }
});

// ── GET /api/registrations/mine/:tournamentId ───────────────────────────────
// Lo que necesita la página del torneo para el botón Inscribirme.
router.get('/mine/:tournamentId', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const q = httpQuery(sql);
    const { tournamentId } = req.params;
    const { t, signup } = await loadTournament(q, tournamentId);
    const [{ rows }, used, inTournament, canManage] = await Promise.all([
      q(`SELECT r.*, u2.name AS p2_user_name, u2.username AS p2_username
         FROM tournament_registrations r
         LEFT JOIN users u2 ON u2.id = r.p2_user_id
         WHERE r.tournament_id = $1 AND (r.p1_user_id = $2 OR r.p2_user_id = $2)
         ORDER BY r.created_at DESC LIMIT 1`, [tournamentId, req.user.id]),
      usedPlayers(q, tournamentId),
      userInTournament(q, tournamentId, req.user.id),
      canManageGroup(sql, req.user.id, t.group_id),
    ]);
    const state = signupState(signup, t);
    const mine = rows[0] ?? null;
    res.json({
      // Sin los números del cupo: sólo hay cupos / últimos / completo.
      signup: {
        ...state,
        availability: publicSignup(signup, { format: t.format, used }).availability,
        closes_at: signup.closes_at, level: signup.level,
        price: signup.price, price_unit: signup.unit,
        rules: signup.rules,
      },
      // El teléfono del invitado sólo lo ve quien lo cargó.
      registration: mine && {
        ...mine,
        p2_phone: mine.p1_user_id === req.user.id ? mine.p2_phone : null,
      },
      in_tournament: inTournament,
      can_manage: canManage === true,
    });
  } catch (err) { sendError(res, next, err); }
});

// ── PATCH /api/registrations/:id/availability ──────────────────────────────
// La edita cualquiera de los dos jugadores mientras el torneo no terminó.
router.patch('/:id/availability', requireAuth, async (req, res, next) => {
  try {
    let availability;
    try { availability = parseAvailability(req.body.availability); }
    catch (e) { if (e instanceof AvailabilityError) throw new HttpError(400, e.message); throw e; }
    const sql = getDb();
    const q = httpQuery(sql);
    const { rows: [r] } = await q(`
      SELECT r.id, r.status, r.p1_user_id, r.p2_user_id, t.status AS t_status, t.liga_mode
      FROM tournament_registrations r JOIN tournaments t ON t.id = r.tournament_id
      WHERE r.id = $1`, [req.params.id]);
    if (!r) throw new HttpError(404, 'Inscripción no encontrada');
    if (r.p1_user_id !== req.user.id && r.p2_user_id !== req.user.id) throw new HttpError(403, 'No autorizado');
    if (r.t_status === 'finished') throw new HttpError(400, 'El torneo ya terminó');
    if (r.liga_mode !== 'temporada') throw new HttpError(400, 'Este torneo se juega en un solo día');
    if (!['pending', 'approved', 'waitlist'].includes(r.status)) throw new HttpError(400, 'La inscripción no está activa');
    const { rows: [x] } = await q(
      'UPDATE tournament_registrations SET availability = $2::jsonb WHERE id = $1 RETURNING id, availability',
      [r.id, availability ? JSON.stringify(availability) : null]);
    res.json(x);
  } catch (err) { sendError(res, next, err); }
});

// ── POST /api/registrations/:id/cancel ──────────────────────────────────────
// El jugador (titular o compañero) cancela hasta el cierre de la inscripción.
// Si ya estaba aprobada, sale del torneo sólo si todavía no jugó.
router.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const result = await withTransaction(async (client) => {
      const q = (text, params) => client.query(text, params);
      const { rows: [r] } = await q('SELECT * FROM tournament_registrations WHERE id = $1', [req.params.id]);
      if (!r) throw new HttpError(404, 'Inscripción no encontrada');
      if (![r.p1_user_id, r.p2_user_id, r.created_by].includes(req.user.id)) throw new HttpError(403, 'No autorizado');
      if (!ACTIVE_STATUSES.includes(r.status)) throw new HttpError(409, 'La inscripción ya no está activa');

      const { t, signup } = await loadTournament(q, r.tournament_id, { lock: true });
      const state = signupState(signup, t);
      if (!state.open) throw new HttpError(400, 'La inscripción ya cerró: pedile la baja al organizador');

      if (r.status === 'approved') {
        const players = [r.p1_player_id, r.p2_player_id].filter(Boolean);
        const { rows: [{ n }] } = await q(`
          SELECT COUNT(*)::int AS n FROM matches
          WHERE tournament_id = $1
            AND (team1_p1 = ANY($2::text[]) OR team1_p2 = ANY($2::text[])
              OR team2_p1 = ANY($2::text[]) OR team2_p2 = ANY($2::text[]))`, [r.tournament_id, players]);
        if (n > 0) throw new HttpError(409, 'Ya jugaste en este torneo: pedile la baja al organizador');
        if (players.length) {
          await q(`DELETE FROM scheduled_matches WHERE tournament_id = $1
                   AND (team1_p1 = ANY($2::text[]) OR team1_p2 = ANY($2::text[])
                     OR team2_p1 = ANY($2::text[]) OR team2_p2 = ANY($2::text[]))`, [r.tournament_id, players]);
          await q(`DELETE FROM pairs WHERE tournament_id = $1
                   AND (p1_id = ANY($2::text[]) OR p2_id = ANY($2::text[]))`, [r.tournament_id, players]);
          await q('DELETE FROM tournament_players WHERE tournament_id = $1 AND player_id = ANY($2::text[])',
            [r.tournament_id, players]);
        }
      }

      const { rows: [updated] } = await q(
        `UPDATE tournament_registrations SET status = 'cancelled' WHERE id = $1 RETURNING *`, [r.id]);
      return updated;
    });
    res.json(result);
  } catch (err) { sendError(res, next, err); }
});

// ── GET /api/registrations/tournament/:tournamentId ─────────────────────────
// Panel del organizador: inscripciones con datos de nivel e historial.
router.get('/tournament/:tournamentId', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const q = httpQuery(sql);
    const { tournamentId } = req.params;
    const { t, signup } = await loadTournament(q, tournamentId);
    if (!(await canManageGroup(sql, req.user.id, t.group_id))) throw new HttpError(403, 'No autorizado');

    const [{ rows }, used] = await Promise.all([
      q(`SELECT r.*,
                u1.name AS p1_name, u1.username AS p1_username, u1.avatar_url AS p1_avatar_url,
                u1.category AS p1_category, u1.level_score AS p1_level_score,
                u2.name AS p2_user_name, u2.username AS p2_username, u2.avatar_url AS p2_avatar_url,
                u2.category AS p2_category, u2.level_score AS p2_level_score,
                (r.kind = 'solo' AND r.status = 'approved' AND r.p1_player_id IS NOT NULL AND NOT EXISTS (
                   SELECT 1 FROM pairs p WHERE p.tournament_id = r.tournament_id AND p.status = 'active'
                     AND r.p1_player_id IN (p.p1_id, p.p2_id))) AS solo_unpaired
         FROM tournament_registrations r
         JOIN users u1 ON u1.id = r.p1_user_id
         LEFT JOIN users u2 ON u2.id = r.p2_user_id
         WHERE r.tournament_id = $1
         ORDER BY r.created_at`, [tournamentId]),
      usedPlayers(q, tournamentId),
    ]);

    // Historial en la app de cada usuario: partidos jugados y ganados (sin W.O.).
    const userIds = [...new Set(rows.flatMap((r) => [r.p1_user_id, r.p2_user_id]).filter(Boolean))];
    const { rows: stats } = userIds.length ? await q(`
      SELECT pl.user_id, COUNT(m.id)::int AS pj,
             COALESCE(SUM(CASE
               WHEN (m.team1_p1 = pl.id OR m.team1_p2 = pl.id) AND m.score1 > m.score2 THEN 1
               WHEN (m.team2_p1 = pl.id OR m.team2_p2 = pl.id) AND m.score2 > m.score1 THEN 1
               ELSE 0 END), 0)::int AS pg
      FROM players pl
      JOIN matches m ON m.score1 <> m.score2 AND NOT m.walkover
        AND pl.id IN (m.team1_p1, m.team1_p2, m.team2_p1, m.team2_p2)
      WHERE pl.user_id = ANY($1::text[])
      GROUP BY pl.user_id`, [userIds]) : { rows: [] };
    const statsBy = new Map(stats.map((s) => [s.user_id, { pj: s.pj, pg: s.pg }]));

    const registrations = rows.map((r) => ({
      ...r,
      p1_stats: statsBy.get(r.p1_user_id) ?? { pj: 0, pg: 0 },
      p2_stats: r.p2_user_id ? (statsBy.get(r.p2_user_id) ?? { pj: 0, pg: 0 }) : null,
      // Faltas contra la categoría del torneo (fija, mixto o suma). No
      // bloquean: el organizador las ve y decide.
      level_check: checkRegistrationLevel(
        r.kind === 'pair' ? [r.p1_category, r.p2_category ?? null] : [r.p1_category],
        signup.level, { solo: r.kind === 'solo' }),
    }));

    res.json({
      registrations,
      summary: summarize(rows),
      signup: {
        ...signupState(signup, t),
        level: signup.level, capacity: signup.capacity, capacity_unit: signup.capacity_unit,
        capacity_players: capacityInPlayers({ capacity: signup.capacity, unit: signup.capacity_unit, format: t.format }),
        used_players: used, closes_at: signup.closes_at,
      },
    });
  } catch (err) { sendError(res, next, err); }
});

// ── Aprobar: crea o reutiliza los jugadores y arma la pareja ────────────────

/** Jugador de la categoría vinculado a la cuenta; si no hay, se crea. */
async function ensureUserPlayer(q, groupId, userId) {
  const { rows: [found] } = await q(`
    SELECT p.id FROM players p JOIN group_players gp ON gp.player_id = p.id AND gp.group_id = $1
    WHERE p.user_id = $2 LIMIT 1`, [groupId, userId]);
  if (found) return found.id;
  const id = uid();
  await q(`INSERT INTO players (id, name, user_id) SELECT $1, name, id FROM users WHERE id = $2`, [id, userId]);
  await q('INSERT INTO group_players (group_id, player_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [groupId, id]);
  return id;
}

async function createGuestPlayer(q, groupId, name) {
  const id = uid();
  await q('INSERT INTO players (id, name) VALUES ($1, $2)', [id, name]);
  await q('INSERT INTO group_players (group_id, player_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [groupId, id]);
  return id;
}

async function approve(q, r, t, signup, actorId) {
  const capPlayers = capacityInPlayers({ capacity: signup.capacity, unit: signup.capacity_unit, format: t.format });
  const used = await usedPlayers(q, t.id);
  if (!hasRoom(used, r.kind, capPlayers)) {
    if (r.status === 'waitlist') throw new HttpError(409, 'Todavía no hay cupo para esta inscripción', 'no_room');
    const { rows: [w] } = await q(`
      UPDATE tournament_registrations SET status = 'waitlist', decided_by = $2, decided_at = NOW()
      WHERE id = $1 RETURNING *`, [r.id, actorId]);
    return w;
  }

  const p1 = await ensureUserPlayer(q, t.group_id, r.p1_user_id);
  let p2 = null;
  if (r.kind === 'pair') {
    p2 = r.p2_user_id ? await ensureUserPlayer(q, t.group_id, r.p2_user_id) : await createGuestPlayer(q, t.group_id, r.p2_name);
  }
  const players = [p1, p2].filter(Boolean);

  const { rows: taken } = await q(`
    SELECT 1 FROM pairs WHERE tournament_id = $1 AND status = 'active'
      AND (p1_id = ANY($2::text[]) OR p2_id = ANY($2::text[])) LIMIT 1`, [t.id, players]);
  if (taken.length) throw new HttpError(409, 'Uno de los jugadores ya está en una pareja del torneo');

  await q(`INSERT INTO tournament_players (tournament_id, player_id)
           SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`, [t.id, players]);

  // En Liga en modo libre no hay parejas fijas: entran los dos jugadores.
  let pairId = null;
  if (r.kind === 'pair' && (t.format === 'americano' || t.mode === 'pairs')) {
    pairId = uid();
    await q('INSERT INTO pairs (id, tournament_id, p1_id, p2_id) VALUES ($1, $2, $3, $4)', [pairId, t.id, p1, p2]);
  }

  const { rows: [a] } = await q(`
    UPDATE tournament_registrations
    SET status = 'approved', p1_player_id = $2, p2_player_id = $3, pair_id = $4,
        decided_by = $5, decided_at = NOW(), reject_reason = NULL
    WHERE id = $1 RETURNING *`, [r.id, p1, p2, pairId, actorId]);
  return a;
}

// ── PATCH /api/registrations/:id ────────────────────────────────────────────
// Body: { action: 'approve' | 'reject', reason? }
// Aprobar sin cupo deja la inscripción en lista de espera. Todo va en una
// transacción con el torneo bloqueado: dos organizadores no superan el cupo.
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const { action, reason } = req.body;
    if (action !== 'approve' && action !== 'reject') throw new HttpError(400, 'action debe ser approve o reject');

    const result = await withTransaction(async (client) => {
      const q = (text, params) => client.query(text, params);
      const { rows: [r0] } = await q('SELECT tournament_id FROM tournament_registrations WHERE id = $1', [req.params.id]);
      if (!r0) throw new HttpError(404, 'Inscripción no encontrada');
      const { t, signup } = await loadTournament(q, r0.tournament_id, { lock: true });
      if (!(await canManageGroup(getDb(), req.user.id, t.group_id))) {
        throw new HttpError(403, 'No autorizado');
      }
      const { rows: [r] } = await q('SELECT * FROM tournament_registrations WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (r.status !== 'pending' && r.status !== 'waitlist') throw new HttpError(409, 'La inscripción ya fue resuelta');

      if (action === 'reject') {
        const { rows: [x] } = await q(`
          UPDATE tournament_registrations
          SET status = 'rejected', reject_reason = $2, decided_by = $3, decided_at = NOW()
          WHERE id = $1 RETURNING *`, [r.id, String(reason ?? '').trim().slice(0, 200) || null, req.user.id]);
        const to = await notify(q, [r.p1_user_id, r.p2_user_id], 'registration_decided', req.user.id, r.id, 'rejected');
        return { ...x, _mail: { to, status: 'rejected', reason: x.reject_reason, t } };
      }

      if (t.status === 'finished') throw new HttpError(400, 'El torneo ya terminó');
      if (t.bracket) throw new HttpError(400, 'El cuadro ya fue generado: no se pueden sumar jugadores');
      const updated = await approve(q, r, t, signup, req.user.id);
      if (updated.status !== r.status) {
        const to = await notify(q, [r.p1_user_id, r.p2_user_id], 'registration_decided', req.user.id, r.id, updated.status);
        return { ...updated, _mail: { to, status: updated.status, reason: null, t } };
      }
      return updated;
    });
    const { _mail, ...out } = result;
    // El mail sale después del commit y nunca hace fallar la respuesta.
    if (_mail?.to?.length) sendDecisionMail(getDb(), _mail).catch((e) => console.error('mail de inscripción:', e));
    res.json(out);
  } catch (err) { sendError(res, next, err); }
});

// ── PATCH /api/registrations/:id/paid ───────────────────────────────────────
router.patch('/:id/paid', requireAuth, async (req, res, next) => {
  try {
    const { paid } = req.body;
    if (typeof paid !== 'boolean') throw new HttpError(400, 'paid debe ser true o false');
    const sql = getDb();
    const [r] = await sql`
      SELECT r.id, t.group_id FROM tournament_registrations r
      JOIN tournaments t ON t.id = r.tournament_id WHERE r.id = ${req.params.id}`;
    if (!r) throw new HttpError(404, 'Inscripción no encontrada');
    if (!(await canManageGroup(sql, req.user.id, r.group_id))) throw new HttpError(403, 'No autorizado');
    const [updated] = await sql`
      UPDATE tournament_registrations SET paid = ${paid} WHERE id = ${r.id} RETURNING *`;
    res.json(updated);
  } catch (err) { sendError(res, next, err); }
});

export default router;
