import { Router } from 'express';
import { randomBytes, createHash } from 'crypto';
import { getDb } from '../db.js';
import { uid }   from '../uid.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const genToken  = () => randomBytes(24).toString('hex');
const hashToken = (token) => createHash('sha256').update(token).digest('hex');
const linkUrl   = (token) => `${process.env.FRONTEND_URL ?? ''}/invitacion/${token}`;

// Busca un usuario por @username o email. Devuelve null si no existe.
async function findUser(sql, identifier) {
  const raw = (identifier ?? '').trim();
  if (!raw) return null;
  const isUsername = raw.startsWith('@');
  const lookup = isUsername ? raw.slice(1) : raw;
  const [user] = isUsername
    ? await sql`SELECT id, name, username FROM users WHERE username = ${lookup}`
    : await sql`SELECT id, name, username FROM users WHERE LOWER(email) = LOWER(${lookup})`;
  return user ?? null;
}

// Aplica la transferencia de propiedad: cambia el dueño, saca al nuevo dueño de
// co-organizadores y agrega al dueño anterior como co-organizador.
async function applyTransfer(sql, transfer) {
  await sql`UPDATE groups SET user_id = ${transfer.to_user_id} WHERE id = ${transfer.group_id}`;
  await sql`DELETE FROM group_collaborators
            WHERE group_id = ${transfer.group_id} AND user_id = ${transfer.to_user_id}`;
  await sql`INSERT INTO group_collaborators (group_id, user_id, added_by)
            VALUES (${transfer.group_id}, ${transfer.from_user_id}, ${transfer.to_user_id})
            ON CONFLICT DO NOTHING`;
  await sql`UPDATE ownership_transfers
            SET status = 'accepted', to_user_id = ${transfer.to_user_id}
            WHERE id = ${transfer.id}`;
  // Cancelar cualquier otra transferencia pendiente de esa categoría
  await sql`UPDATE ownership_transfers SET status = 'cancelled'
            WHERE group_id = ${transfer.group_id} AND status = 'pending' AND id != ${transfer.id}`;
}

// ─── CO-ORGANIZADORES ──────────────────────────────────────────────────────────

// POST /api/groups/:groupId/collaborators/invites — invitar co-organizador (solo dueño)
// Body: { identifier } (@username/email) | { link: true }
router.post('/groups/:groupId/collaborators/invites', requireAuth, async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { identifier, link } = req.body;
    const sql = getDb();

    const [group] = await sql`SELECT id, user_id, name FROM groups WHERE id = ${groupId}`;
    if (!group) return res.status(404).json({ error: 'Categoría no encontrada' });
    if (group.user_id !== req.user.id) return res.status(403).json({ error: 'Solo el dueño puede agregar co-organizadores' });

    // Invitación por link
    if (link) {
      const token = genToken();
      const [invitation] = await sql`
        INSERT INTO collaborator_invitations (id, group_id, invited_by, token_hash)
        VALUES (${uid()}, ${groupId}, ${req.user.id}, ${hashToken(token)})
        RETURNING id
      `;
      return res.status(201).json({ invitation, url: linkUrl(token) });
    }

    // Invitación por @username/email
    if (!identifier?.trim()) return res.status(400).json({ error: 'identifier requerido' });
    const invitedUser = await findUser(sql, identifier);
    if (!invitedUser) return res.status(404).json({ error: 'No se encontró un usuario con ese nombre o email' });
    if (invitedUser.id === group.user_id) return res.status(409).json({ error: 'Ya sos el dueño de esta categoría' });

    const [already] = await sql`
      SELECT 1 FROM group_collaborators WHERE group_id = ${groupId} AND user_id = ${invitedUser.id}
    `;
    if (already) return res.status(409).json({ error: 'Ese usuario ya es co-organizador' });

    const [pending] = await sql`
      SELECT 1 FROM collaborator_invitations
      WHERE group_id = ${groupId} AND invited_user_id = ${invitedUser.id} AND status = 'pending'
    `;
    if (pending) return res.status(409).json({ error: 'Ya hay una invitación pendiente para ese usuario' });

    const [invitation] = await sql`
      INSERT INTO collaborator_invitations
        (id, group_id, invited_by, invited_identifier, invited_user_id)
      VALUES (${uid()}, ${groupId}, ${req.user.id}, ${identifier.trim()}, ${invitedUser.id})
      RETURNING id
    `;
    await sql`
      INSERT INTO notifications (id, user_id, type, actor_id, entity_id)
      VALUES (${uid()}, ${invitedUser.id}, 'collab_invite', ${req.user.id}, ${invitation.id})
    `;

    res.status(201).json({ invitation, invited: { name: invitedUser.name, username: invitedUser.username } });
  } catch (err) { next(err); }
});

// PATCH /api/collaborator-invites/:id — aceptar/rechazar (el invitado)
// Body: { action: 'accept' | 'reject' }
router.patch('/collaborator-invites/:id', requireAuth, async (req, res, next) => {
  try {
    const { action } = req.body;
    if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'action debe ser accept o reject' });
    const sql = getDb();

    const [inv] = await sql`SELECT * FROM collaborator_invitations WHERE id = ${req.params.id}`;
    if (!inv) return res.status(404).json({ error: 'Invitación no encontrada' });
    if (inv.invited_user_id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });
    if (inv.status !== 'pending') return res.status(409).json({ error: 'La invitación ya fue procesada' });

    if (action === 'accept') {
      const [group] = await sql`SELECT user_id FROM groups WHERE id = ${inv.group_id}`;
      if (group && group.user_id !== req.user.id) {
        await sql`INSERT INTO group_collaborators (group_id, user_id, added_by)
                  VALUES (${inv.group_id}, ${req.user.id}, ${inv.invited_by})
                  ON CONFLICT DO NOTHING`;
      }
    }
    await sql`UPDATE collaborator_invitations
              SET status = ${action === 'accept' ? 'accepted' : 'rejected'}
              WHERE id = ${inv.id}`;

    res.json({ ok: true, status: action === 'accept' ? 'accepted' : 'rejected' });
  } catch (err) { next(err); }
});

// DELETE /api/groups/:groupId/collaborators/:userId — quitar co-organizador
// El dueño puede quitar a cualquiera; un co-organizador puede quitarse a sí mismo (userId='me').
router.delete('/groups/:groupId/collaborators/:userId', requireAuth, async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const targetId = req.params.userId === 'me' ? req.user.id : req.params.userId;
    const sql = getDb();

    const [group] = await sql`SELECT user_id FROM groups WHERE id = ${groupId}`;
    if (!group) return res.status(404).json({ error: 'Categoría no encontrada' });

    const isOwner = group.user_id === req.user.id;
    const isSelf  = targetId === req.user.id;
    if (!isOwner && !isSelf) return res.status(403).json({ error: 'No autorizado' });

    await sql`DELETE FROM group_collaborators WHERE group_id = ${groupId} AND user_id = ${targetId}`;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── TRANSFERENCIA DE PROPIEDAD ─────────────────────────────────────────────────

// POST /api/groups/:groupId/transfer — iniciar transferencia (solo dueño)
// Body: { identifier } | { link: true }
router.post('/groups/:groupId/transfer', requireAuth, async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const { identifier, link } = req.body;
    const sql = getDb();

    const [group] = await sql`SELECT id, user_id, name FROM groups WHERE id = ${groupId}`;
    if (!group) return res.status(404).json({ error: 'Categoría no encontrada' });
    if (group.user_id !== req.user.id) return res.status(403).json({ error: 'Solo el dueño puede transferir la propiedad' });

    const [existing] = await sql`
      SELECT 1 FROM ownership_transfers WHERE group_id = ${groupId} AND status = 'pending'
    `;
    if (existing) return res.status(409).json({ error: 'Ya hay una transferencia pendiente. Cancelala antes de crear otra.' });

    if (link) {
      const token = genToken();
      const [transfer] = await sql`
        INSERT INTO ownership_transfers (id, group_id, from_user_id, token_hash)
        VALUES (${uid()}, ${groupId}, ${req.user.id}, ${hashToken(token)})
        RETURNING id
      `;
      return res.status(201).json({ transfer, url: linkUrl(token) });
    }

    if (!identifier?.trim()) return res.status(400).json({ error: 'identifier requerido' });
    const target = await findUser(sql, identifier);
    if (!target) return res.status(404).json({ error: 'No se encontró un usuario con ese nombre o email' });
    if (target.id === req.user.id) return res.status(409).json({ error: 'No podés transferirte la categoría a vos mismo' });

    const [transfer] = await sql`
      INSERT INTO ownership_transfers (id, group_id, from_user_id, to_user_id)
      VALUES (${uid()}, ${groupId}, ${req.user.id}, ${target.id})
      RETURNING id
    `;
    await sql`
      INSERT INTO notifications (id, user_id, type, actor_id, entity_id)
      VALUES (${uid()}, ${target.id}, 'ownership_transfer', ${req.user.id}, ${transfer.id})
    `;

    res.status(201).json({ transfer, target: { name: target.name, username: target.username } });
  } catch (err) { next(err); }
});

// PATCH /api/ownership-transfers/:id — aceptar/rechazar (el destinatario)
// Body: { action: 'accept' | 'reject' }
router.patch('/ownership-transfers/:id', requireAuth, async (req, res, next) => {
  try {
    const { action } = req.body;
    if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'action debe ser accept o reject' });
    const sql = getDb();

    const [transfer] = await sql`SELECT * FROM ownership_transfers WHERE id = ${req.params.id}`;
    if (!transfer) return res.status(404).json({ error: 'Transferencia no encontrada' });
    if (transfer.to_user_id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });
    if (transfer.status !== 'pending') return res.status(409).json({ error: 'La transferencia ya fue procesada' });

    if (action === 'reject') {
      await sql`UPDATE ownership_transfers SET status = 'rejected' WHERE id = ${transfer.id}`;
      return res.json({ ok: true, status: 'rejected' });
    }

    // Verificar que quien la inició sigue siendo el dueño
    const [group] = await sql`SELECT user_id FROM groups WHERE id = ${transfer.group_id}`;
    if (!group || group.user_id !== transfer.from_user_id) {
      await sql`UPDATE ownership_transfers SET status = 'cancelled' WHERE id = ${transfer.id}`;
      return res.status(409).json({ error: 'La categoría ya cambió de dueño' });
    }

    await applyTransfer(sql, transfer);
    res.json({ ok: true, status: 'accepted', group_id: transfer.group_id });
  } catch (err) { next(err); }
});

// DELETE /api/groups/:groupId/transfer — cancelar transferencia pendiente (solo dueño)
router.delete('/groups/:groupId/transfer', requireAuth, async (req, res, next) => {
  try {
    const { groupId } = req.params;
    const sql = getDb();
    const [group] = await sql`SELECT user_id FROM groups WHERE id = ${groupId}`;
    if (!group) return res.status(404).json({ error: 'Categoría no encontrada' });
    if (group.user_id !== req.user.id) return res.status(403).json({ error: 'No autorizado' });

    await sql`UPDATE ownership_transfers SET status = 'cancelled'
              WHERE group_id = ${groupId} AND status = 'pending'`;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── ACEPTACIÓN POR LINK (unificada) ─────────────────────────────────────────────

// POST /api/invites/resolve — describe un token para pintar el landing. Body: { token }
router.post('/invites/resolve', requireAuth, async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token requerido' });
    const sql = getDb();

    const [ci] = await sql`
      SELECT ci.id, g.id AS group_id, g.name AS group_name,
             u.name AS from_name, u.username AS from_username
      FROM   collaborator_invitations ci
      JOIN   groups g ON g.id = ci.group_id
      JOIN   users  u ON u.id = ci.invited_by
      WHERE  ci.token_hash = ${hashToken(token)} AND ci.status = 'pending'
    `;
    if (ci) return res.json({ kind: 'collaborator', group: { id: ci.group_id, name: ci.group_name }, from: { name: ci.from_name, username: ci.from_username } });

    const [ot] = await sql`
      SELECT ot.id, g.id AS group_id, g.name AS group_name,
             u.name AS from_name, u.username AS from_username
      FROM   ownership_transfers ot
      JOIN   groups g ON g.id = ot.group_id
      JOIN   users  u ON u.id = ot.from_user_id
      WHERE  ot.token_hash = ${hashToken(token)} AND ot.status = 'pending'
    `;
    if (ot) return res.json({ kind: 'transfer', group: { id: ot.group_id, name: ot.group_name }, from: { name: ot.from_name, username: ot.from_username } });

    // Invitación a jugar (reclamar un slot de jugador), para quien no tenía
    // cuenta cuando lo invitaron.
    const [pi] = await sql`
      SELECT pi.id, g.id AS group_id, g.name AS group_name, p.name AS player_name,
             u.name AS from_name, u.username AS from_username
      FROM   player_invitations pi
      JOIN   groups  g ON g.id = pi.group_id
      JOIN   players p ON p.id = pi.player_id
      JOIN   users   u ON u.id = pi.invited_by
      WHERE  pi.token_hash = ${hashToken(token)} AND pi.status = 'pending'
    `;
    if (pi) return res.json({
      kind: 'player',
      group: { id: pi.group_id, name: pi.group_name },
      player: { name: pi.player_name },
      from: { name: pi.from_name, username: pi.from_username },
    });

    // Hasta acá el token no coincide con nada pendiente. Puede ser inventado, o
    // puede ser uno real que alguien ya usó — el caso corriente cuando el link se
    // comparte en un grupo. Distinguirlo no filtra nada (quien pregunta ya tiene
    // el token) y evita el callejón sin salida de "invitación inválida".
    const [usado] = await sql`
      SELECT g.name AS group_name
      FROM   player_invitations pi
      JOIN   groups g ON g.id = pi.group_id
      WHERE  pi.token_hash = ${hashToken(token)}
      UNION ALL
      SELECT g.name
      FROM   collaborator_invitations ci
      JOIN   groups g ON g.id = ci.group_id
      WHERE  ci.token_hash = ${hashToken(token)}
      UNION ALL
      SELECT g.name
      FROM   ownership_transfers ot
      JOIN   groups g ON g.id = ot.group_id
      WHERE  ot.token_hash = ${hashToken(token)}
      LIMIT  1
    `;
    if (usado) {
      return res.status(410).json({
        error: 'used',
        group_name: usado.group_name,
      });
    }

    res.status(404).json({ error: 'Invitación inválida o ya utilizada' });
  } catch (err) { next(err); }
});

// POST /api/invites/accept — acepta un token (co-organizador o transferencia). Body: { token }
router.post('/invites/accept', requireAuth, async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token requerido' });
    const sql = getDb();

    // Co-organizador
    const [ci] = await sql`SELECT * FROM collaborator_invitations WHERE token_hash = ${hashToken(token)} AND status = 'pending'`;
    if (ci) {
      const [group] = await sql`SELECT user_id FROM groups WHERE id = ${ci.group_id}`;
      if (group?.user_id === req.user.id) return res.status(409).json({ error: 'Ya sos el dueño de esta categoría' });
      await sql`INSERT INTO group_collaborators (group_id, user_id, added_by)
                VALUES (${ci.group_id}, ${req.user.id}, ${ci.invited_by})
                ON CONFLICT DO NOTHING`;
      await sql`UPDATE collaborator_invitations SET status = 'accepted' WHERE id = ${ci.id}`;
      return res.json({ kind: 'collaborator', group_id: ci.group_id });
    }

    // Transferencia
    const [ot] = await sql`SELECT * FROM ownership_transfers WHERE token_hash = ${hashToken(token)} AND status = 'pending'`;
    if (ot) {
      if (ot.from_user_id === req.user.id) return res.status(409).json({ error: 'No podés transferirte la categoría a vos mismo' });
      const [group] = await sql`SELECT user_id FROM groups WHERE id = ${ot.group_id}`;
      if (!group || group.user_id !== ot.from_user_id) {
        await sql`UPDATE ownership_transfers SET status = 'cancelled' WHERE id = ${ot.id}`;
        return res.status(409).json({ error: 'La categoría ya cambió de dueño' });
      }
      await applyTransfer(sql, { ...ot, to_user_id: req.user.id });
      return res.json({ kind: 'transfer', group_id: ot.group_id });
    }

    // Invitación a jugar
    const [pi] = await sql`SELECT * FROM player_invitations WHERE token_hash = ${hashToken(token)} AND status = 'pending'`;
    if (pi) {
      const [[player], [linked]] = await Promise.all([
        sql`SELECT id, user_id, name FROM players WHERE id = ${pi.player_id}`,
        // Una cuenta ocupa un solo slot por categoría: el trigger lo rechazaría
        // igual, pero acá el mensaje explica qué pasó.
        sql`
          SELECT p.name
          FROM   players p
          JOIN   group_players gp ON gp.player_id = p.id AND gp.group_id = ${pi.group_id}
          WHERE  p.user_id = ${req.user.id}
          LIMIT  1
        `,
      ]);
      if (!player) return res.status(404).json({ error: 'El jugador ya no existe' });
      if (player.user_id) return res.status(409).json({ error: 'Otra persona ya usó este link.' });
      if (linked) return res.status(409).json({ error: `Ya jugás en esta categoría como "${linked.name}"` });

      const [me] = await sql`SELECT name FROM users WHERE id = ${req.user.id}`;

      // El `user_id IS NULL` es la compuerta: si dos personas abren el mismo link
      // y aceptan a la vez, las dos pasan la comprobación de arriba (leen el slot
      // libre antes de que ninguna escriba) y la segunda pisaba a la primera.
      // Acá sólo un UPDATE puede encontrar la fila libre; el otro no toca nada.
      const claimed = await sql`
        UPDATE players SET user_id = ${req.user.id}, name = ${me.name},
               original_name = COALESCE(original_name, name)
        WHERE  id = ${pi.player_id} AND user_id IS NULL
        RETURNING id
      `;
      if (claimed.length === 0) {
        return res.status(409).json({ error: 'Otra persona ya usó este link.' });
      }

      await sql`
        UPDATE player_invitations
        SET    status = 'accepted', invited_user_id = ${req.user.id}
        WHERE  id = ${pi.id}
      `;
      return res.json({ kind: 'player', group_id: pi.group_id });
    }

    res.status(404).json({ error: 'Invitación inválida o ya utilizada' });
  } catch (err) { next(err); }
});

export default router;
