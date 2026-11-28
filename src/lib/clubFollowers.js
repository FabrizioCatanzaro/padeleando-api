import { getDb } from '../db.js';
import { uid } from '../uid.js';

// Avisa a quienes siguen el club que un torneo público abrió la inscripción; una vez por torneo y persona
export async function notifyClubFollowersSignup(tournamentId, actorId) {
  const sql = getDb();
  const targets = await sql`
    SELECT f.user_id, c.name AS club_name
    FROM tournaments t
    JOIN groups g ON g.id = t.group_id AND g.is_public = true
    JOIN clubs c ON c.id = t.club_id
    JOIN club_follows f ON f.club_id = t.club_id
    WHERE t.id = ${tournamentId} AND t.status <> 'finished'
      AND COALESCE(t.signup_open, g.signup_open, false) = true
      AND f.user_id <> ${actorId} AND f.user_id <> g.user_id
      AND NOT EXISTS (SELECT 1 FROM notifications n
                      WHERE n.user_id = f.user_id AND n.type = 'club_tournament_signup' AND n.entity_id = t.id)
  `;
  if (!targets.length) return;
  await sql`
    INSERT INTO notifications (id, user_id, type, actor_id, entity_id, body)
    SELECT * FROM UNNEST(
      ${targets.map(() => uid())}::text[],
      ${targets.map((t) => t.user_id)}::text[],
      ${targets.map(() => 'club_tournament_signup')}::text[],
      ${targets.map(() => actorId)}::text[],
      ${targets.map(() => tournamentId)}::text[],
      ${targets.map((t) => t.club_name)}::text[]
    )
  `;
}
