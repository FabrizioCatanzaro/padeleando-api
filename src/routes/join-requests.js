import { Router } from 'express';
import { getDb, withTransaction } from '../db.js';
import { uid } from '../uid.js';
import { requireAuth } from '../middleware/auth.js';
import { canManageGroup } from '../lib/access.js';

// Las solicitudes las resuelve cualquiera que gestione la categoría: el dueño o
// un co-organizador. Antes sólo el dueño, y si no estaba en el club el
// ayudante no podía aceptar a nadie.

/** Dueño y co-organizadores de una categoría: los que reciben el aviso. */
async function groupManagers(sql, groupId) {
  const rows = await sql`
    SELECT user_id FROM groups WHERE id = ${groupId}
    UNION
    SELECT user_id FROM group_collaborators WHERE group_id = ${groupId}
  `;
  return rows.map((r) => r.user_id);
}

const router = Router();

// POST /api/join-requests — usuario solicita unirse a un torneo
router.post('/', requireAuth, async (req, res, next) => {
  try {
    const { tournamentId, playerId } = req.body;
    if (!tournamentId) return res.status(400).json({ error: 'tournamentId requerido' });

    const sql = getDb();

    const [tournament] = await sql`
      SELECT t.id, t.name, t.status, t.group_id, g.user_id AS owner_id
      FROM tournaments t
      JOIN groups g ON g.id = t.group_id
      WHERE t.id = ${tournamentId}
    `;
    if (!tournament) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (await canManageGroup(sql, req.user.id, tournament.group_id)) {
      return res.status(409).json({ error: 'Sos organizador de este torneo' });
    }
    if (tournament.status === 'finished') {
      return res.status(400).json({ error: 'El torneo ya terminó' });
    }

    const [alreadyPlayer] = await sql`
      SELECT p.id FROM players p
      INNER JOIN tournament_players tp ON tp.player_id = p.id AND tp.tournament_id = ${tournamentId}
      WHERE p.user_id = ${req.user.id}
    `;
    if (alreadyPlayer) return res.status(409).json({ error: 'Ya estás en este torneo' });

    // Jugador específico que el solicitante quiere reclamar (opcional). Debe estar
    // en el torneo y no tener cuenta vinculada todavía.
    if (playerId) {
      const [target] = await sql`
        SELECT p.id, p.user_id FROM players p
        INNER JOIN tournament_players tp ON tp.player_id = p.id AND tp.tournament_id = ${tournamentId}
        WHERE p.id = ${playerId}
      `;
      if (!target) return res.status(404).json({ error: 'Jugador no encontrado en el torneo' });
      if (target.user_id) return res.status(409).json({ error: 'Ese jugador ya está vinculado a una cuenta' });
    }

    const [existing] = await sql`
      SELECT id, status FROM tournament_join_requests
      WHERE tournament_id = ${tournamentId} AND user_id = ${req.user.id}
    `;
    if (existing) {
      if (existing.status === 'pending') {
        return res.status(409).json({ error: 'Ya tenés una solicitud pendiente para este torneo' });
      }
      if (existing.status === 'accepted') {
        return res.status(409).json({ error: 'Tu solicitud ya fue aceptada' });
      }
      // rejected → permitir nueva solicitud
      await sql`DELETE FROM tournament_join_requests WHERE id = ${existing.id}`;
    }

    const [joinRequest] = await sql`
      INSERT INTO tournament_join_requests (id, tournament_id, user_id, requested_player_id)
      VALUES (${uid()}, ${tournamentId}, ${req.user.id}, ${playerId ?? null})
      RETURNING *
    `;

    // El aviso le llega a cada uno de los que pueden resolverla.
    const managers = await groupManagers(sql, tournament.group_id);
    await sql`
      INSERT INTO notifications (id, user_id, type, actor_id, entity_id)
      SELECT * FROM UNNEST(
        ${managers.map(() => uid())}::text[],
        ${managers}::text[],
        ${managers.map(() => 'join_request')}::text[],
        ${managers.map(() => req.user.id)}::text[],
        ${managers.map(() => joinRequest.id)}::text[]
      )
    `;

    res.status(201).json(joinRequest);
  } catch (err) { next(err); }
});

// GET /api/join-requests/my-status/:tournamentId — estado de la solicitud del usuario actual
// IMPORTANTE: debe estar antes de /:id para que Express no lo trate como un ID
router.get('/my-status/:tournamentId', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const { tournamentId } = req.params;

    // Ninguna de las cuatro depende del resultado de otra: un solo round-trip.
    const [[tournament], [alreadyPlayer], [request], [invitation]] = await Promise.all([
      sql`
        SELECT g.user_id AS owner_id,
               EXISTS (SELECT 1 FROM group_collaborators gc
                       WHERE gc.group_id = g.id AND gc.user_id = ${req.user.id}) AS is_collab
        FROM tournaments t
        JOIN groups g ON g.id = t.group_id
        WHERE t.id = ${tournamentId}
      `,

      sql`
        SELECT p.id FROM players p
        INNER JOIN tournament_players tp ON tp.player_id = p.id AND tp.tournament_id = ${tournamentId}
        WHERE p.user_id = ${req.user.id}
      `,

      sql`
        SELECT tjr.id, tjr.status, tjr.created_at, tjr.requested_player_id,
               rp.name AS requested_player_name
        FROM tournament_join_requests tjr
        LEFT JOIN players rp ON rp.id = tjr.requested_player_id
        WHERE tjr.tournament_id = ${tournamentId} AND tjr.user_id = ${req.user.id}
      `,

      // Invitación pendiente a un jugador de este torneo. Sin esto la vista
      // ofrecía "solicitar unirse" a alguien que ya estaba invitado.
      sql`
        SELECT pi.id, pi.player_id, pi.created_at,
               p.name AS player_name,
               u.name AS invited_by_name, u.username AS invited_by_username
        FROM player_invitations pi
        JOIN players p ON p.id = pi.player_id
        JOIN tournament_players tp ON tp.player_id = pi.player_id AND tp.tournament_id = ${tournamentId}
        JOIN users u ON u.id = pi.invited_by
        WHERE pi.invited_user_id = ${req.user.id} AND pi.status = 'pending'
        ORDER BY pi.created_at DESC
        LIMIT 1
      `,
    ]);

    res.json({
      is_player: !!alreadyPlayer,
      is_owner: tournament?.owner_id === req.user.id,
      // Dueño o co-organizador: a ninguno de los dos se le ofrece "unirse".
      can_manage: tournament?.owner_id === req.user.id || !!tournament?.is_collab,
      request: request ?? null,
      invitation: invitation ?? null
    });
  } catch (err) { next(err); }
});

// GET /api/join-requests/:id — detalles para que el organizador resuelva la solicitud
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();

    const [request] = await sql`
      SELECT tjr.*,
        u.name AS requester_name, u.username AS requester_username,
        rp.name AS requested_player_name,
        t.name AS tournament_name, t.id AS tournament_id, t.group_id, g.user_id AS owner_id
      FROM tournament_join_requests tjr
      JOIN users u ON u.id = tjr.user_id
      LEFT JOIN players rp ON rp.id = tjr.requested_player_id
      JOIN tournaments t ON t.id = tjr.tournament_id
      JOIN groups g ON g.id = t.group_id
      WHERE tjr.id = ${req.params.id}
    `;
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (!(await canManageGroup(sql, req.user.id, request.group_id))) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    const unlinkedPlayers = await sql`
      SELECT p.id, p.name
      FROM players p
      INNER JOIN tournament_players tp ON tp.player_id = p.id AND tp.tournament_id = ${request.tournament_id}
      WHERE p.user_id IS NULL
      ORDER BY p.name
    `;

    res.json({ ...request, unlinked_players: unlinkedPlayers });
  } catch (err) { next(err); }
});

// PATCH /api/join-requests/:id — el dueño o un co-organizador acepta o rechaza
// Body: { action: 'accept' | 'reject', playerId? }
// Va en una transacción que toma la solicitud con un UPDATE condicional: con
// varios organizadores, dos que la resuelven a la vez no la procesan dos veces.
router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const { action } = req.body;
    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'action debe ser accept o reject' });
    }

    const sql = getDb();
    const [request] = await sql`
      SELECT tjr.*, t.group_id
      FROM tournament_join_requests tjr
      JOIN tournaments t ON t.id = tjr.tournament_id
      WHERE tjr.id = ${req.params.id}
    `;
    if (!request) return res.status(404).json({ error: 'Solicitud no encontrada' });
    if (!(await canManageGroup(sql, req.user.id, request.group_id))) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    // El jugador a vincular: el que el organizador elija, o el que pidió el solicitante.
    const playerId = req.body.playerId ?? request.requested_player_id;
    if (action === 'accept' && !playerId) {
      return res.status(400).json({ error: 'playerId requerido para aceptar' });
    }

    const result = await withTransaction(async (client) => {
      const { rows: [claimed] } = await client.query(
        `UPDATE tournament_join_requests
         SET status = $2, player_id = $3
         WHERE id = $1 AND status = 'pending'
         RETURNING *`,
        [req.params.id, action === 'accept' ? 'accepted' : 'rejected', action === 'accept' ? playerId : null]
      );
      if (!claimed) return { status: 409, error: 'La solicitud ya fue procesada' };
      if (action === 'reject') return { updated: claimed };

      const { rows: [player] } = await client.query(
        `SELECT p.id, p.user_id FROM players p
         JOIN tournament_players tp ON tp.player_id = p.id AND tp.tournament_id = $1
         WHERE p.id = $2 FOR UPDATE OF p`,
        [request.tournament_id, playerId]
      );
      if (!player) throw httpError(404, 'Jugador no encontrado en el torneo');
      if (player.user_id) throw httpError(409, 'El jugador ya está vinculado a una cuenta');

      // Una cuenta no puede tener dos slots en la misma categoría.
      const { rows: [linked] } = await client.query(
        `SELECT p.name FROM players p
         JOIN group_players gp ON gp.player_id = p.id AND gp.group_id = $1
         WHERE p.user_id = $2 AND p.id <> $3
         LIMIT 1`,
        [request.group_id, request.user_id, playerId]
      );
      if (linked) throw httpError(409, `Este usuario ya juega en la categoría como "${linked.name}"`);

      await client.query(
        `UPDATE players SET user_id = $1,
                name = (SELECT name FROM users WHERE id = $1),
                original_name = COALESCE(original_name, name)
         WHERE id = $2`,
        [request.user_id, playerId]
      );
      return { updated: claimed };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.updated);
  } catch (err) {
    // Los rechazos dentro de la transacción la deshacen: la solicitud vuelve a pendiente.
    if (err.httpStatus) return res.status(err.httpStatus).json({ error: err.message });
    next(err);
  }
});

function httpError(status, message) {
  const err = new Error(message);
  err.httpStatus = status;
  return err;
}

export default router;
