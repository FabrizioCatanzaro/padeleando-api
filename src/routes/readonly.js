import { Router } from 'express';
import { getDb }  from '../db.js';
import { resolveSignup } from '../lib/signup.js';
 
const router = Router();
 
// GET /api/readonly/:tournamentId  — endpoint público sin autenticación
router.get('/:tournamentId', async (req, res, next) => {
  try {
    const sql = getDb();
    const { tournamentId } = req.params;
 
    const [tournament] = await sql`
      SELECT t.*, u.username AS owner_username,
             u.name          AS owner_name,
             u.avatar_url    AS owner_avatar_url,
             u.social_links  AS owner_social_links,
             g.name          AS group_name,
             -- La vista de espectador pedía esto en una segunda llamada a
             -- /groups/:id/meta que sólo podía salir cuando ya había respondido
             -- ésta. Al llegar tarde, la píldora de la categoría se insertaba
             -- sobre el título y empujaba la página 39 px (0,25 de CLS).
             g.emojis        AS group_emojis,
             g.is_public     AS group_is_public,
             (EXISTS (
               SELECT 1 FROM subscriptions s
               WHERE s.user_id = g.user_id AND s.plan = 'premium' AND s.status = 'active'
             )) AS group_owner_is_premium,
             c.name          AS club_name,
             c.photo_url     AS club_photo_url,
             c.location_name AS club_location_name,
             c.courts        AS club_courts,
             -- Inscripción: lo de la jornada pisa lo de la categoría, campo por campo.
             g.signup_open       AS group_signup_open,
             g.signup_price      AS group_signup_price,
             g.signup_price_unit AS group_signup_price_unit,
             g.signup_contacts   AS group_signup_contacts
      FROM   tournaments t
      JOIN   groups g ON g.id = t.group_id
      JOIN   users  u ON u.id = g.user_id
      LEFT   JOIN clubs c ON c.id = t.club_id
      WHERE  t.id = ${tournamentId}
    `;
    if (!tournament) return res.status(404).json({ error: 'Torneo no encontrado' });
 
    const pairs = await sql`SELECT * FROM pairs WHERE tournament_id = ${tournamentId} ORDER BY id`;
 
    const matches = await sql`
      SELECT * FROM matches
      WHERE tournament_id = ${tournamentId}
      ORDER BY created_at DESC
    `;

    // El fixture es lo que el espectador viene a mirar antes de que empiece:
    // contra quién juega y en qué cancha.
    const scheduled = await sql`
      SELECT * FROM scheduled_matches
      WHERE tournament_id = ${tournamentId}
      ORDER BY scheduled_at NULLS LAST, position, created_at
    `;
 
    // Canonical player list from tournament_players table
    const tpPlayers = await sql`
      SELECT p.id, p.name, u.name AS linked_name, u.username AS linked_username, u.avatar_url AS linked_avatar_url,
             (s.id IS NOT NULL) AS is_premium
      FROM   players p
      INNER JOIN tournament_players tp ON tp.player_id = p.id AND tp.tournament_id = ${tournamentId}
      LEFT  JOIN users u ON u.id = p.user_id
      LEFT  JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active' AND s.plan = 'premium'
    `;

    // Backward-compat: also include any players from matches/pairs not in tournament_players
    const tpIds = new Set(tpPlayers.map((p) => p.id));
    const extraIds = [
      ...new Set([
        ...pairs.flatMap((p) => [p.p1_id, p.p2_id]),
        ...matches.flatMap((m) => [m.team1_p1, m.team1_p2, m.team2_p1, m.team2_p2]),
        ...scheduled.flatMap((m) => [m.team1_p1, m.team1_p2, m.team2_p1, m.team2_p2]),
      ]),
    ].filter((id) => id && !tpIds.has(id));

    const extraPlayers = extraIds.length
      ? await sql`
          SELECT p.id, p.name, u.name AS linked_name, u.username AS linked_username, u.avatar_url AS linked_avatar_url,
                 (s.id IS NOT NULL) AS is_premium
          FROM   players p
          LEFT   JOIN users u ON u.id = p.user_id
          LEFT   JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active' AND s.plan = 'premium'
          WHERE  p.id = ANY(${extraIds})
        `
      : [];

    const players = [
      ...tpPlayers.map((p) => ({ ...p, removed: false })),
      ...extraPlayers.map((p) => ({ ...p, removed: true })),
    ];
 
    res.json({
      id:             tournament.id,
      name:           tournament.name,
      mode:           tournament.mode,
      format:         tournament.format,
      status:         tournament.status,
      live_match:     tournament.live_match ?? null,
      group_id:       tournament.group_id,
      group_name:     tournament.group_name ?? null,
      // Presentación de la categoría: antes venía de una segunda llamada a
      // /groups/:id/meta encadenada detrás de ésta.
      group_emojis:           tournament.group_emojis ?? [],
      group_is_public:        tournament.group_is_public ?? true,
      group_owner_is_premium: tournament.group_owner_is_premium ?? false,
      owner_username: tournament.owner_username,
      owner_name:     tournament.owner_name ?? null,
      owner_avatar_url: tournament.owner_avatar_url ?? null,
      created_at:     tournament.created_at,
      event_date:          tournament.event_date ?? null,
      event_time:          tournament.event_time ?? null,
      club_id:             tournament.club_id ?? null,
      club_name:           tournament.club_name ?? null,
      club_photo_url:      tournament.club_photo_url ?? null,
      club_location_name:  tournament.club_location_name ?? null,
      // Las canchas mandan sobre number_of_courts, que es una copia vieja del club.
      club_courts:         tournament.club_courts ?? null,
      bracket:        tournament.bracket ?? null,
      // Ya resuelto: al espectador no le sirve saber de dónde salió cada campo.
      signup: resolveSignup(tournament, {
        signup_open:       tournament.group_signup_open,
        signup_price:      tournament.group_signup_price,
        signup_price_unit: tournament.group_signup_price_unit,
        signup_contacts:   tournament.group_signup_contacts,
      }, tournament.owner_social_links),
      players,
      pairs,
      matches,
      scheduled_matches: scheduled,
    });
  } catch (err) { next(err); }
});
 
export default router;
