import { Router } from 'express';
import { getDb }  from '../db.js';
import { uid }    from '../uid.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { requireGroupManage, requireTournamentManage } from '../middleware/access.js';
import { canManageGroup } from '../lib/access.js';

const router = Router();

// GET /api/players?q=nombre[&groupId=xxx][&mine=true]
// - groupId: filtra jugadores de ese grupo específico.
// - mine=true: filtra jugadores de los grupos que el usuario gestiona (propios y co-organizados).
// - Sin parámetros: resultados globales (compatibilidad).
router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const sql     = getDb();
    const rawQ    = (req.query.q ?? '').trim();
    const groupId = req.query.groupId;
    const mine    = req.query.mine === 'true' && !!req.user;

    let players;
    if (groupId) {
      players = await sql`
        SELECT p.*
        FROM   players p
        JOIN   group_players gp ON gp.player_id = p.id
        WHERE  gp.group_id = ${groupId}
          AND  unaccent(p.name) ILIKE '%' || unaccent(${rawQ}) || '%'
        ORDER  BY p.name ASC
        LIMIT  30`;
    } else if (mine) {
      players = await sql`
        SELECT DISTINCT ON (lower(unaccent(p.name))) p.*
        FROM   players p
        JOIN   group_players gp ON gp.player_id = p.id
        JOIN   groups g         ON g.id = gp.group_id
        WHERE  (g.user_id = ${req.user.id} OR EXISTS (
                 SELECT 1 FROM group_collaborators gc
                 WHERE  gc.group_id = g.id AND gc.user_id = ${req.user.id}
               ))
          AND  unaccent(p.name) ILIKE '%' || unaccent(${rawQ}) || '%'
        ORDER  BY lower(unaccent(p.name)) ASC
        LIMIT  30`;
    } else {
      players = await sql`
        SELECT * FROM players
        WHERE unaccent(name) ILIKE '%' || unaccent(${rawQ}) || '%'
        ORDER BY name ASC LIMIT 30`;
    }

    res.json(players);
  } catch (err) { next(err); }
});

// GET /api/players/group/:groupId
// Plantel de la categoría, para la pestaña Jugadores. Trae lo mismo que la vista
// de un torneo (cuenta vinculada, invitación pendiente) más en cuántos torneos
// jugó cada uno — que es el dato que sólo tiene sentido a nivel categoría.
router.get('/group/:groupId', async (req, res, next) => {
  try {
    const sql = getDb();
    const { groupId } = req.params;
    const players = await sql`
      SELECT
        p.*,
        u.username   AS linked_username,
        u.name       AS linked_name,
        u.avatar_url AS linked_avatar_url,
        (s.id IS NOT NULL) AS is_premium,
        pi.id        AS invitation_id,
        pi.status    AS invitation_status,
        pi.invited_identifier,
        COALESCE(tc.tournament_count, 0) AS tournament_count
      FROM   players p
      JOIN   group_players gp ON gp.player_id = p.id AND gp.group_id = ${groupId}
      -- Agregado en una pasada en vez de una subconsulta correlacionada por
      -- jugador: con un plantel grande, la correlacionada se ejecuta N veces.
      LEFT   JOIN (
        SELECT tp.player_id, COUNT(*)::int AS tournament_count
        FROM   tournament_players tp
        JOIN   tournaments t ON t.id = tp.tournament_id AND t.group_id = ${groupId}
        GROUP  BY tp.player_id
      ) tc ON tc.player_id = p.id
      LEFT   JOIN users u ON u.id = p.user_id
      LEFT   JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active' AND s.plan = 'premium'
      LEFT   JOIN player_invitations pi
        ON   pi.player_id = p.id AND pi.group_id = ${groupId} AND pi.status = 'pending'
      ORDER  BY p.name ASC
    `;
    res.json(players);
  } catch (err) { next(err); }
});

// POST /api/players/resolve
// Body: { name, groupId, tournamentId? }
// Acepta @username para vincular al usuario registrado y generar una invitación automática.
router.post('/resolve', requireAuth, requireGroupManage, async (req, res, next) => {
  try {
    const { name, groupId, tournamentId } = req.body;
    if (!name?.trim())  return res.status(400).json({ error: 'name requerido' });
    if (!groupId)       return res.status(400).json({ error: 'groupId requerido' });

    const sql = getDb();

    const trimmed = name.trim();
    let resolvedName   = trimmed;
    let inviteUserId   = null;
    let inviteUsername = null;

    if (trimmed.startsWith('@')) {
      const username = trimmed.slice(1);
      if (!username) return res.status(400).json({ error: 'Nombre de usuario inválido' });
      const [foundUser] = await sql`SELECT id, name, username FROM users WHERE username = ${username}`;
      if (!foundUser) return res.status(404).json({ error: `No existe el usuario @${username}` });
      resolvedName   = foundUser.name;
      inviteUserId   = foundUser.id;
      inviteUsername = foundUser.username;
    }

    // Una cuenta tiene un único slot por categoría, así que si ya está vinculada
    // se reusa ese slot. Buscar sólo por nombre creaba un segundo slot cuando el
    // nombre de la cuenta no coincidía con el del slot ya vinculado.
    let player = null;
    if (inviteUserId) {
      [player] = await sql`
        SELECT p.*
        FROM   players p
        JOIN   group_players gp ON gp.player_id = p.id
        WHERE  gp.group_id = ${groupId} AND p.user_id = ${inviteUserId}
        LIMIT  1
      `;
    }

    if (!player) {
      [player] = await sql`
        SELECT p.*
        FROM   players p
        JOIN   group_players gp ON gp.player_id = p.id
        WHERE  gp.group_id = ${groupId}
          AND  LOWER(p.name) = LOWER(${resolvedName})
      `;
    }

    // El slot que matcheó por nombre puede pertenecer a otra cuenta: en ese caso
    // no se puede reclamar, hay que crear uno nuevo con un nombre distinto.
    if (player && inviteUserId && player.user_id && player.user_id !== inviteUserId) {
      return res.status(409).json({
        error: `El jugador "${player.name}" ya está vinculado a otra cuenta. Usá un nombre distinto.`,
      });
    }

    if (!player) {
      [player] = await sql`
        INSERT INTO players (id, name) VALUES (${uid()}, ${resolvedName}) RETURNING *
      `;
    }

    await sql`
      INSERT INTO group_players (group_id, player_id)
      VALUES (${groupId}, ${player.id}) ON CONFLICT DO NOTHING
    `;

    if (tournamentId) {
      await sql`
        INSERT INTO tournament_players (tournament_id, player_id)
        VALUES (${tournamentId}, ${player.id}) ON CONFLICT DO NOTHING
      `;
    }

    let invitationCreated = false;
    if (inviteUserId && !player.user_id && req.user) {
      const [existing] = await sql`
        SELECT id FROM player_invitations WHERE player_id = ${player.id} AND status = 'pending'
      `;
      if (!existing) {
        await sql`
          INSERT INTO player_invitations
            (id, player_id, group_id, invited_by, invited_identifier, invited_user_id)
          VALUES
            (${uid()}, ${player.id}, ${groupId}, ${req.user.id}, ${'@' + inviteUsername}, ${inviteUserId})
        `;
        invitationCreated = true;
      }
    }

    res.status(201).json({ player, invitationCreated });
  } catch (err) { next(err); }
});

// DELETE /api/players/:playerId/tournament/:tournamentId
// Elimina al jugador de una jornada específica (no del grupo completo)
router.delete('/:playerId/tournament/:tournamentId', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const { playerId, tournamentId } = req.params;
    const sql = getDb();
    await sql`
      DELETE FROM tournament_players
      WHERE tournament_id = ${tournamentId} AND player_id = ${playerId}
    `;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/players/:playerId/group/:groupId
router.delete('/:playerId/group/:groupId', requireAuth, requireGroupManage, async (req, res, next) => {
  try {
    const { playerId, groupId } = req.params;
    const sql = getDb();

    // Sólo se puede sacar del plantel a quien no jugó nada. Con torneos encima,
    // borrar la fila de group_players lo saca de los listados pero deja sus
    // partidos apuntando a un jugador que ya no figura en la categoría: se
    // rompen los nombres de la tabla y del cuadro. Para ese caso está sacarlo
    // del torneo, que no toca el historial.
    const [{ count }] = await sql`
      SELECT COUNT(*)::int AS count
      FROM   tournament_players tp
      JOIN   tournaments t ON t.id = tp.tournament_id AND t.group_id = ${groupId}
      WHERE  tp.player_id = ${playerId}
    `;
    if (count > 0) {
      return res.status(409).json({
        error: `Este jugador participó en ${count} ${count === 1 ? 'torneo' : 'torneos'}. Sacalo de cada torneo si querés, pero no se puede quitar de la categoría sin perder el historial.`,
      });
    }

    await sql`
      DELETE FROM group_players
      WHERE group_id = ${groupId} AND player_id = ${playerId}
    `;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/players/:playerId/group/:groupId/link
// Desvincula la cuenta del slot de jugador, sin tocar el slot ni sus partidos:
// el historial queda en la categoría y sólo deja de contar en el perfil de esa
// cuenta. Lo puede hacer el propio jugador o quien gestione la categoría.
router.delete('/:playerId/group/:groupId/link', requireAuth, async (req, res, next) => {
  try {
    const { playerId, groupId } = req.params;
    const sql = getDb();

    const [[player], canManage] = await Promise.all([
      sql`
        SELECT p.id, p.name, p.user_id
        FROM   players p
        JOIN   group_players gp ON gp.player_id = p.id AND gp.group_id = ${groupId}
        WHERE  p.id = ${playerId}
      `,
      canManageGroup(sql, req.user.id, groupId),
    ]);

    if (!player)         return res.status(404).json({ error: 'Jugador no encontrado en esta categoría' });
    if (!player.user_id) return res.status(409).json({ error: 'Este jugador no está vinculado a ninguna cuenta' });

    const isSelf = player.user_id === req.user.id;
    if (!isSelf && !canManage) return res.status(403).json({ error: 'No autorizado' });

    const unlinkedUserId = player.user_id;

    // Vuelve al nombre con el que lo había anotado el organizador. Si se queda
    // el de la cuenta, el slot pasa a estar rotulado con el nombre real de
    // alguien que ya no está vinculado, que es lo que menos se quiere.
    await sql`
      UPDATE players
      SET    user_id = NULL,
             name    = COALESCE(original_name, name),
             original_name = NULL
      WHERE  id = ${playerId}
    `;

    // Sin esto la desvinculación sería reversible por el organizador solo: una
    // invitación ya aceptada en esta categoría hace que las siguientes se
    // auto-acepten (ver routes/invitations.js), así que volvería a vincularse
    // sin que el usuario pueda decidir. Se borran las aceptadas que ya no
    // corresponden a ningún slot suyo — si tiene otro slot en el grupo, la suya
    // sobrevive.
    await sql`
      DELETE FROM player_invitations pi
      WHERE pi.group_id = ${groupId}
        AND pi.invited_user_id = ${unlinkedUserId}
        AND pi.status = 'accepted'
        AND NOT EXISTS (
          SELECT 1 FROM players p
          WHERE p.id = pi.player_id AND p.user_id = pi.invited_user_id
        )
    `;

    // Notificar al otro lado: al jugador si lo desvinculó el organizador, al
    // dueño de la categoría si el jugador se fue por su cuenta.
    const [group] = await sql`SELECT name, user_id AS owner_id FROM groups WHERE id = ${groupId}`;
    const notifyUserId = isSelf ? group?.owner_id : unlinkedUserId;
    if (notifyUserId && notifyUserId !== req.user.id) {
      const body = isSelf
        ? `${req.user.name} se desvinculó del jugador ${player.name} en ${group.name}. El historial se mantiene en la categoría.`
        : `Ya no estás vinculado al jugador ${player.name} en ${group.name}. El historial se mantiene en la categoría.`;
      await sql`
        INSERT INTO notifications (id, user_id, type, actor_id, entity_id, title, body)
        VALUES (${uid()}, ${notifyUserId}, 'player_unlinked', ${req.user.id}, ${groupId},
                ${'Jugador desvinculado'}, ${body})
      `;
    }

    res.json({ ok: true, player_id: playerId });
  } catch (err) { next(err); }
});

// PATCH /api/players/:playerId
// Renombrar un jugador. La colisión ahora se verifica solo dentro del mismo grupo.
// Body: { name, groupId }
router.patch('/:playerId', requireAuth, requireGroupManage, async (req, res, next) => {
  try {
    const { playerId } = req.params;
    const { name, groupId } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'name requerido' });

    const sql = getDb();

    if (groupId) {
      // Verifica colisión solo dentro del grupo
      const [collision] = await sql`
        SELECT p.id FROM players p
        JOIN group_players gp ON gp.player_id = p.id
        WHERE gp.group_id = ${groupId}
          AND LOWER(p.name) = LOWER(${name.trim()})
          AND p.id != ${playerId}
      `;
      if (collision) {
        return res.status(409).json({ error: `Ya hay un jugador llamado '${name.trim()}' en este grupo` });
      }
    }

    const [updated] = await sql`
      UPDATE players SET name = ${name.trim()} WHERE id = ${playerId} RETURNING *
    `;
    res.json(updated);
  } catch (err) { next(err); }
});

export default router;
