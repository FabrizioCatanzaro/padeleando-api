import { Router } from 'express';
import { getDb, withTransaction } from '../db.js';
import { uid }    from '../uid.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { requireGroupManage, requireTournamentManage } from '../middleware/access.js';
import { canManageGroup } from '../lib/access.js';
import { parseSignupFields } from '../lib/signup.js';
import { tournamentQuotaError } from '../lib/plan.js';

const router = Router();

// GET /api/tournaments/:id
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const { id } = req.params;

    const [tournament] = await sql`
      SELECT t.*,
             g.user_id       AS group_owner_id,
             g.name          AS group_name,
             g.signup_open       AS group_signup_open,
             g.signup_price      AS group_signup_price,
             g.signup_price_unit AS group_signup_price_unit,
             g.signup_contacts   AS group_signup_contacts,
             ow.social_links     AS owner_social_links,
             c.name          AS club_name,
             c.photo_url     AS club_photo_url,
             c.location_name AS club_location_name,
             c.courts        AS club_courts,
             cr.name         AS pending_club_name,
             (EXISTS (
               SELECT 1 FROM subscriptions s
               JOIN   groups g ON g.user_id = s.user_id
               WHERE  g.id = t.group_id AND s.plan = 'premium' AND s.status = 'active'
             )) AS owner_is_premium
      FROM tournaments t
      JOIN groups g ON g.id = t.group_id
      JOIN users ow ON ow.id = g.user_id
      LEFT JOIN clubs c ON c.id = t.club_id
      LEFT JOIN club_requests cr ON cr.id = t.pending_club_request_id
      WHERE t.id = ${id}
    `;
    if (!tournament) return res.status(404).json({ error: 'Torneo no encontrado' });

    const pairs = await sql`SELECT * FROM pairs WHERE tournament_id = ${id} ORDER BY id`;

    const matches = await sql`
      SELECT * FROM matches WHERE tournament_id = ${id} ORDER BY created_at DESC
    `;

    // Incluir info de vinculación: usuario registrado + invitación pendiente si aplica
    // Solo jugadores explícitamente agregados a esta jornada (tournament_players)
    const activePlayers = await sql`
      SELECT
        p.*,
        u.username   AS linked_username,
        u.name       AS linked_name,
        u.avatar_url AS linked_avatar_url,
        (s.id IS NOT NULL) AS is_premium,
        pi.id        AS invitation_id,
        pi.status    AS invitation_status,
        pi.invited_identifier
      FROM players p
      INNER JOIN tournament_players tp ON tp.player_id = p.id AND tp.tournament_id = ${id}
      LEFT JOIN users u ON u.id = p.user_id
      LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active' AND s.plan = 'premium'
      LEFT JOIN player_invitations pi
        ON pi.player_id = p.id AND pi.group_id = ${tournament.group_id} AND pi.status = 'pending'
    `;

    // Jugadores removidos de la jornada pero aún referenciados por matches/pairs.
    // Se incluyen para que tabla, estadísticas y partidos muestren sus datos,
    // con flag `removed: true` para que el frontend los trate como solo-lectura.
    const activeIds = new Set(activePlayers.map((p) => p.id));
    const orphanIds = [
      ...new Set([
        ...pairs.flatMap((p) => [p.p1_id, p.p2_id]),
        ...matches.flatMap((m) => [m.team1_p1, m.team1_p2, m.team2_p1, m.team2_p2]),
      ]),
    ].filter((pid) => pid && !activeIds.has(pid));

    const removedPlayers = orphanIds.length
      ? await sql`
          SELECT p.*, u.name AS linked_name, u.avatar_url AS linked_avatar_url,
                 (s.id IS NOT NULL) AS is_premium
          FROM   players p
          LEFT   JOIN users u ON u.id = p.user_id
          LEFT   JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active' AND s.plan = 'premium'
          WHERE  p.id = ANY(${orphanIds})
        `
      : [];

    const players = [
      ...activePlayers.map((p) => ({ ...p, removed: false })),
      ...removedPlayers.map((p) => ({ ...p, removed: true })),
    ];

    // Permisos del solicitante (dueño de la categoría o co-organizador)
    const viewerId = req.user?.id ?? null;
    const is_owner = !!viewerId && tournament.group_owner_id === viewerId;
    const can_manage = is_owner
      ? true
      : (viewerId ? (await canManageGroup(sql, viewerId, tournament.group_id)) === true : false);

    res.json({ ...tournament, players, pairs, matches, is_owner, can_manage });
  } catch (err) { next(err); }
});

// POST /api/tournaments
// Body: { groupId, name, mode, format, playerNames[], pairs?: [{p1Name,p2Name}] }
// playerNames puede incluir entradas @username para vincular a usuarios registrados.
router.post('/', requireAuth, requireGroupManage, async (req, res, next) => {
  try {
    const {
      groupId, name, mode = 'free', format = 'liga',
      playerNames = [], pairs: pairsInput = [],
      number_of_courts = 1, club_id = null, event_date = null, event_time = null,
      pending_club_request_id = null,
    } = req.body;

    if (!groupId)      return res.status(400).json({ error: 'groupId requerido' });
    if (!name?.trim()) return res.status(400).json({ error: 'nombre requerido' });
    if (name.trim().length < 2) return res.status(400).json({ error: 'El nombre del torneo tiene que tener más de 2 caracteres' });
    if (name.trim().length > 30) return res.status(400).json({ error: 'El nombre del torneo no puede superar los 30 caracteres' });
    if (!['liga', 'americano'].includes(format)) return res.status(400).json({ error: 'format debe ser "liga" o "americano"' });

    // Lo que no venga queda en NULL: la jornada hereda ese campo de la categoría.
    let signup;
    try { signup = parseSignupFields(req.body); }
    catch (e) { return res.status(400).json({ error: e.message }); }

    // El americano se puede crear como "borrador" con menos de 8 parejas: recién al
    // llegar al mínimo se habilitan el calendario, los partidos y el cuadro
    // (validado en /schedule y /bracket). Acá sólo se controla el tope.
    if (format === 'americano' && pairsInput.length > 16) {
      return res.status(400).json({ error: 'El modo Americano admite hasta 16 parejas' });
    }

    const sql  = getDb();
    const tId  = uid();

    // ── Fase 1: resolución (sólo lectura, en lote) ──────────────────────────
    // Antes esto era un bucle por jugador con 3-5 consultas cada uno: crear un
    // americano de 16 parejas disparaba del orden de 150 peticiones HTTPS en
    // serie contra Neon.
    const rawNames = playerNames.filter(Boolean).map((n) => n.trim()).filter(Boolean);
    const usernames = rawNames.filter((n) => n.startsWith('@')).map((n) => n.slice(1)).filter(Boolean);

    const [quotaError, clubRows, userRows] = await Promise.all([
      tournamentQuotaError(sql, groupId, req.accessCtx.owner_id),
      club_id ? sql`SELECT id FROM clubs WHERE id = ${club_id}` : Promise.resolve([]),
      usernames.length
        ? sql`SELECT id, name, username FROM users WHERE username = ANY(${usernames})`
        : Promise.resolve([]),
    ]);

    if (quotaError) return res.status(403).json({ error: quotaError, code: 'plan_limit' });
    if (club_id && clubRows.length === 0) return res.status(404).json({ error: 'Club no encontrado' });

    const userByUsername = new Map(userRows.map((u) => [u.username, u]));
    for (const username of usernames) {
      if (!userByUsername.has(username)) {
        return res.status(404).json({ error: `No existe el usuario @${username}` });
      }
    }

    // rawName → { resolvedName, inviteUserId, inviteUsername }, preservando el
    // orden de entrada y descartando duplicados por nombre resuelto.
    const requested = [];
    const seenNames = new Set();
    for (const raw of rawNames) {
      const found = raw.startsWith('@') ? userByUsername.get(raw.slice(1)) : null;
      if (raw.startsWith('@') && !found) continue;
      const resolvedName = found ? found.name : raw;
      const key = resolvedName.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);
      requested.push({
        raw,
        resolvedName,
        inviteUserId:   found?.id ?? null,
        inviteUsername: found?.username ?? null,
      });
    }

    // Jugadores que ya existen en la categoría, en una sola consulta. Se traen
    // también los slots ya vinculados a las cuentas pedidas: una cuenta tiene un
    // único slot por categoría y buscar sólo por nombre creaba un segundo cuando
    // el nombre de la cuenta no coincidía con el del slot vinculado.
    const lowerNames   = requested.map((r) => r.resolvedName.toLowerCase());
    const inviteUserIds = requested.map((r) => r.inviteUserId).filter(Boolean);
    const existing = lowerNames.length
      ? await sql`
          SELECT p.* FROM players p
          JOIN group_players gp ON gp.player_id = p.id
          WHERE gp.group_id = ${groupId}
            AND (LOWER(p.name) = ANY(${lowerNames})
                 OR p.user_id = ANY(${inviteUserIds.length ? inviteUserIds : ['']}))
        `
      : [];
    const existingByName   = new Map(existing.map((p) => [p.name.toLowerCase(), p]));
    const existingByUserId = new Map(existing.filter((p) => p.user_id).map((p) => [p.user_id, p]));

    // Invitaciones ya pendientes y aceptaciones previas del usuario en la categoría:
    // determinan si se omite la invitación o si se auto-acepta.
    const existingPlayerIds = existing.map((p) => p.id);
    const [pendingRows, priorRows] = await Promise.all([
      existingPlayerIds.length
        ? sql`SELECT player_id FROM player_invitations
              WHERE player_id = ANY(${existingPlayerIds}) AND status = 'pending'`
        : Promise.resolve([]),
      inviteUserIds.length
        ? sql`SELECT DISTINCT invited_user_id FROM player_invitations
              WHERE group_id = ${groupId} AND invited_user_id = ANY(${inviteUserIds})
                AND status = 'accepted'`
        : Promise.resolve([]),
    ]);
    const hasPendingInvite = new Set(pendingRows.map((r) => r.player_id));
    const hasPriorAccept   = new Set(priorRows.map((r) => r.invited_user_id));

    // ── Fase 2: plan de escritura (en memoria, sin tocar la base) ───────────
    const players = [];
    const nameMap = {};             // rawName.toLowerCase() → player (matching de parejas)
    const newPlayers = [];          // filas a insertar en players
    const autoLink = [];            // player_id que se vincula al creador
    const invitations = [];         // { player, inviteUserId, inviteUsername, autoAccept }

    for (const { raw, resolvedName, inviteUserId, inviteUsername } of requested) {
      let player = (inviteUserId ? existingByUserId.get(inviteUserId) : null)
                ?? existingByName.get(resolvedName.toLowerCase());

      // El slot que matcheó por nombre puede pertenecer a otra cuenta.
      if (player && inviteUserId && player.user_id && player.user_id !== inviteUserId) {
        return res.status(409).json({
          error: `El jugador "${player.name}" ya está vinculado a otra cuenta. Usá un nombre distinto.`,
        });
      }

      if (!player) {
        player = { id: uid(), name: resolvedName, user_id: null };
        newPlayers.push(player);
      }
      players.push(player);
      nameMap[raw.toLowerCase()] = player;

      if (inviteUserId && inviteUserId === req.user?.id) {
        // El creador se suma a sí mismo → vincular directo, sin invitación.
        if (!player.user_id) {
          autoLink.push(player.id);
          player.user_id = req.user.id;
        }
      } else if (inviteUserId && !player.user_id && req.user) {
        if (hasPendingInvite.has(player.id)) continue;
        const autoAccept = hasPriorAccept.has(inviteUserId);
        invitations.push({ player, inviteUserId, inviteUsername, autoAccept });
        if (autoAccept) player.user_id = inviteUserId;
      }
    }

    const pairsToInsert = [];
    for (const { p1Name, p2Name } of pairsInput) {
      const p1 = nameMap[p1Name.toLowerCase()] ?? players.find((p) => p.name.toLowerCase() === p1Name.toLowerCase());
      const p2 = nameMap[p2Name.toLowerCase()] ?? players.find((p) => p.name.toLowerCase() === p2Name.toLowerCase());
      if (!p1 || !p2) continue;
      pairsToInsert.push({ id: uid(), tournament_id: tId, p1_id: p1.id, p2_id: p2.id });
    }

    // ── Fase 3: escritura atómica ───────────────────────────────────────────
    // Sin transacción, un fallo a mitad dejaba la jornada creada con los
    // jugadores a medias y sin parejas, sin forma de deshacerlo.
    const { tournament, pairs } = await withTransaction(async (client) => {
      if (newPlayers.length) {
        await client.query(
          `INSERT INTO players (id, name) SELECT * FROM UNNEST($1::text[], $2::text[])`,
          [newPlayers.map((p) => p.id), newPlayers.map((p) => p.name)]
        );
      }

      if (players.length) {
        await client.query(
          `INSERT INTO group_players (group_id, player_id)
           SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
          [groupId, players.map((p) => p.id)]
        );
      }

      const { rows: [tournamentRow] } = await client.query(
        `INSERT INTO tournaments
           (id, group_id, name, mode, format, number_of_courts, club_id, event_date, event_time, pending_club_request_id,
            signup_open, signup_price, signup_price_unit, signup_contacts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb) RETURNING *`,
        [tId, groupId, name.trim(), mode, format, number_of_courts ?? 1,
         club_id ?? null, event_date || null, event_time || null, pending_club_request_id ?? null,
         signup.signup_open ?? null, signup.signup_price ?? null, signup.signup_price_unit ?? null,
         signup.signup_contacts ? JSON.stringify(signup.signup_contacts) : null]
      );

      if (players.length) {
        await client.query(
          `INSERT INTO tournament_players (tournament_id, player_id)
           SELECT $1, unnest($2::text[]) ON CONFLICT DO NOTHING`,
          [tId, players.map((p) => p.id)]
        );
      }

      let pairRows = [];
      if (pairsToInsert.length) {
        const res = await client.query(
          `INSERT INTO pairs (id, tournament_id, p1_id, p2_id)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[]) RETURNING *`,
          [pairsToInsert.map((p) => p.id), pairsToInsert.map(() => tId),
           pairsToInsert.map((p) => p.p1_id), pairsToInsert.map((p) => p.p2_id)]
        );
        pairRows = res.rows;
      }

      // Vinculación directa del creador + auto-aceptadas, en una sentencia.
      const linkToCreator = autoLink;
      if (linkToCreator.length) {
        await client.query(
          `UPDATE players SET user_id = $1 WHERE id = ANY($2::text[])`,
          [req.user.id, linkToCreator]
        );
      }

      if (invitations.length) {
        const invIds = invitations.map(() => uid());
        await client.query(
          `INSERT INTO player_invitations
             (id, player_id, group_id, invited_by, invited_identifier, invited_user_id, status)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[])`,
          [
            invIds,
            invitations.map((i) => i.player.id),
            invitations.map(() => groupId),
            invitations.map(() => req.user.id),
            invitations.map((i) => '@' + i.inviteUsername),
            invitations.map((i) => i.inviteUserId),
            invitations.map((i) => (i.autoAccept ? 'accepted' : 'pending')),
          ]
        );

        const accepted = invitations.filter((i) => i.autoAccept);
        if (accepted.length) {
          // Cada slot se vincula a su propia cuenta, así que va con UNNEST y no
          // con un UPDATE de valor único.
          await client.query(
            `UPDATE players p SET user_id = v.user_id
             FROM (SELECT * FROM UNNEST($1::text[], $2::text[]) AS t(player_id, user_id)) v
             WHERE p.id = v.player_id`,
            [accepted.map((i) => i.player.id), accepted.map((i) => i.inviteUserId)]
          );
        }

        await client.query(
          `INSERT INTO notifications (id, user_id, type, actor_id, entity_id)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])`,
          [
            invitations.map(() => uid()),
            invitations.map((i) => i.inviteUserId),
            invitations.map(() => 'invitation'),
            invitations.map(() => req.user.id),
            invIds,
          ]
        );
      }

      return { tournament: tournamentRow, pairs: pairRows };
    });

    res.status(201).json({ ...tournament, players, pairs, matches: [] });

    // Después de responder: crear una jornada ya es la petición más pesada.
    notifyFavorites(groupId, tId, req.user.id).catch((err) =>
      console.error('No se pudo avisar a quienes la tienen en favoritas:', err)
    );
  } catch (err) { next(err); }
});

async function notifyFavorites(groupId, tournamentId, actorId) {
  const sql = getDb();
  const targets = await sql`
    SELECT gf.user_id
    FROM   group_favorites gf
    JOIN   groups g ON g.id = gf.group_id AND g.is_public = true
    WHERE  gf.group_id = ${groupId} AND gf.user_id <> ${actorId}
  `;
  if (!targets.length) return;

  await sql`
    INSERT INTO notifications (id, user_id, type, actor_id, entity_id)
    SELECT * FROM UNNEST(
      ${targets.map(() => uid())}::text[],
      ${targets.map((t) => t.user_id)}::text[],
      ${targets.map(() => 'new_tournament')}::text[],
      ${targets.map(() => actorId)}::text[],
      ${targets.map(() => tournamentId)}::text[]
    )
  `;
}

// PATCH /api/tournaments/:id
router.patch('/:id', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const { id }           = req.params;
    const { name, status, mode, number_of_courts, club_id, event_date, event_time, pending_club_request_id } = req.body;
    let signup;
    try { signup = parseSignupFields(req.body); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    if (name !== undefined && name.trim().length > 30) return res.status(400).json({ error: 'El nombre del torneo no puede superar los 30 caracteres' });
    if (name !== undefined && name.trim().length < 2) return res.status(400).json({ error: 'El nombre del torneo debe superar los 2 caracteres' });
    const sql = getDb();

    if (club_id) {
      const [club] = await sql`SELECT id FROM clubs WHERE id = ${club_id}`;
      if (!club) return res.status(404).json({ error: 'Club no encontrado' });
    }

    const [updated] = await sql`
      UPDATE tournaments
      SET name             = COALESCE(${name   ?? null}, name),
          status           = COALESCE(${status ?? null}, status),
          mode             = COALESCE(${mode   ?? null}, mode),
          number_of_courts = COALESCE(${number_of_courts ?? null}, number_of_courts),
          club_id          = CASE WHEN ${club_id !== undefined}::boolean    THEN ${club_id || null}    ELSE club_id    END,
          pending_club_request_id = CASE WHEN ${pending_club_request_id !== undefined}::boolean THEN ${pending_club_request_id || null} ELSE pending_club_request_id END,
          event_date       = CASE WHEN ${event_date !== undefined}::boolean THEN ${event_date || null}::date ELSE event_date END,
          event_time       = CASE WHEN ${event_time !== undefined}::boolean THEN ${event_time || null}::time ELSE event_time END,
          signup_open       = CASE WHEN ${'signup_open'       in signup}::boolean THEN ${signup.signup_open       ?? null} ELSE signup_open END,
          signup_price      = CASE WHEN ${'signup_price'      in signup}::boolean THEN ${signup.signup_price      ?? null} ELSE signup_price END,
          signup_price_unit = CASE WHEN ${'signup_price_unit' in signup}::boolean THEN ${signup.signup_price_unit ?? null} ELSE signup_price_unit END,
          signup_contacts   = CASE WHEN ${'signup_contacts'   in signup}::boolean THEN ${signup.signup_contacts ? JSON.stringify(signup.signup_contacts) : null}::jsonb ELSE signup_contacts END
      WHERE id = ${id} RETURNING *
    `;
    if (!updated) return res.status(404).json({ error: 'Torneo no encontrado' });
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/tournaments/:id
router.delete('/:id', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const sql = getDb();
    await sql`DELETE FROM tournaments WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// DELETE /api/tournaments/:id/matches  — reiniciar scores
router.delete('/:id/matches', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const sql = getDb();
    await sql`DELETE FROM matches WHERE tournament_id = ${req.params.id}`;
    // Reiniciar también deja el torneo en estado pre-juego: limpiar el cuadro
    // de eliminatorias (americano) y el indicador de partido en vivo.
    await sql`UPDATE tournaments SET bracket = NULL, live_match = NULL WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PATCH /api/tournaments/:id/live
router.patch('/:id/live', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const { live_match } = req.body;
    const sql = getDb();
    const val = live_match != null ? JSON.stringify(live_match) : null;
    await sql`UPDATE tournaments SET live_match = ${val}::jsonb WHERE id = ${req.params.id}`;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── AMERICANO ────────────────────────────────────────────────────────────────

// POST /api/tournaments/:id/schedule
// Genera un calendario aleatorio para la fase previa del Americano.
// Cada pareja juega 2 partidos contra rivales distintos, contando los partidos
// que ya estaban registrados: una pareja que ya jugó 2 no vuelve a aparecer y
// no se repiten cruces ya jugados.
// No crea partidos en BD — devuelve el calendario propuesto.
router.post('/:id/schedule', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const sql = getDb();
    const [[tournament], pairsRaw, matches] = await Promise.all([
      sql`SELECT * FROM tournaments WHERE id = ${req.params.id}`,
      sql`
        SELECT pr.id, pr.p1_id, pr.p2_id, p1.name AS p1_name, p2.name AS p2_name
        FROM pairs pr
        JOIN players p1 ON p1.id = pr.p1_id
        JOIN players p2 ON p2.id = pr.p2_id
        WHERE pr.tournament_id = ${req.params.id}
      `,
      sql`
        SELECT team1_p1, team1_p2, team2_p1, team2_p2, created_at
        FROM matches WHERE tournament_id = ${req.params.id}
        ORDER BY created_at
      `,
    ]);
    if (!tournament) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (tournament.format !== 'americano') return res.status(400).json({ error: 'Solo disponible en formato Americano' });

    if (pairsRaw.length < 8 || pairsRaw.length > 16) {
      return res.status(400).json({ error: 'Se necesitan entre 8 y 16 parejas para generar el calendario' });
    }

    const schedule = generatePreviaSchedule(pairsRaw, matches);
    res.json({ schedule });
  } catch (err) { next(err); }
});

// POST /api/tournaments/:id/bracket
// Genera el cuadro eliminatorio a partir de la tabla de la fase previa.
// Guarda el bracket en tournaments.bracket y lo retorna.
router.post('/:id/bracket', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const sql = getDb();
    const [tournament] = await sql`SELECT * FROM tournaments WHERE id = ${req.params.id}`;
    if (!tournament) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (tournament.format !== 'americano') return res.status(400).json({ error: 'Solo disponible en formato Americano' });

    // Traer parejas con nombres de jugadores
    const pairsRaw = await sql`
      SELECT pr.id, pr.p1_id, pr.p2_id, p1.name AS p1_name, p2.name AS p2_name
      FROM pairs pr
      JOIN players p1 ON p1.id = pr.p1_id
      JOIN players p2 ON p2.id = pr.p2_id
      WHERE pr.tournament_id = ${req.params.id}
      ORDER BY pr.id
    `;

    if (pairsRaw.length < 8 || pairsRaw.length > 16) {
      return res.status(400).json({ error: 'Se necesitan entre 8 y 16 parejas para generar el bracket' });
    }

    // Traer partidos de la fase previa
    const matches = await sql`SELECT * FROM matches WHERE tournament_id = ${req.params.id}`;

    // Calcular standings por pareja
    const standings = computeStandings(pairsRaw, matches);

    // Generar bracket
    const bracket = generateBracket(standings);

    // Persistir
    const [updated] = await sql`
      UPDATE tournaments SET bracket = ${JSON.stringify(bracket)}::jsonb
      WHERE id = ${req.params.id} RETURNING *
    `;

    res.json({ ...updated, bracket });
  } catch (err) { next(err); }
});

// PATCH /api/tournaments/:id/bracket  — reemplaza el bracket completo (reorganizar cruces)
// Body: { bracket }
router.patch('/:id/bracket', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const { bracket } = req.body;
    if (!bracket) return res.status(400).json({ error: 'bracket requerido' });
    const sql = getDb();
    const [updated] = await sql`
      UPDATE tournaments SET bracket = ${JSON.stringify(bracket)}::jsonb
      WHERE id = ${req.params.id} RETURNING *
    `;
    if (!updated) return res.status(404).json({ error: 'Torneo no encontrado' });
    res.json({ ...updated, bracket });
  } catch (err) { next(err); }
});

// DELETE /api/tournaments/:id/bracket  — borra el cuadro eliminatorio completo
// (por si se generó por error). También limpia el indicador de partido en vivo del
// cuadro. No toca la fase previa ni sus resultados.
router.delete('/:id/bracket', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const sql = getDb();
    const [updated] = await sql`
      UPDATE tournaments SET bracket = NULL, live_match = NULL
      WHERE id = ${req.params.id} RETURNING *
    `;
    if (!updated) return res.status(404).json({ error: 'Torneo no encontrado' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PATCH /api/tournaments/:id/bracket/:matchId
// Registra el resultado de un partido del bracket y propaga el ganador al siguiente round.
// Body: { score1, score2, duration_seconds, court }
router.patch('/:id/bracket/:matchId', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const { score1, score2, duration_seconds, court, sets_format, sets } = req.body;
    if (score1 == null || score2 == null) return res.status(400).json({ error: 'score1 y score2 requeridos' });
    if (typeof score1 !== 'number' || typeof score2 !== 'number') return res.status(400).json({ error: 'Los scores deben ser números' });
    if (score1 === score2) return res.status(400).json({ error: 'No puede haber empate en la fase eliminatoria' });
    if (sets_format != null && sets_format !== 1 && sets_format !== 3) {
      return res.status(400).json({ error: 'sets_format debe ser 1 o 3' });
    }
    if (sets != null && !Array.isArray(sets)) return res.status(400).json({ error: 'sets debe ser una lista' });

    const sql = getDb();
    const [tournament] = await sql`SELECT * FROM tournaments WHERE id = ${req.params.id}`;
    if (!tournament) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!tournament.bracket) return res.status(400).json({ error: 'El bracket aún no fue generado' });

    const bracket = tournament.bracket;
    const { matchId } = req.params;

    const updated = applyBracketResult(bracket, matchId, score1, score2, duration_seconds ?? null, court ?? null, {
      sets_format: sets_format ?? null,
      sets: Array.isArray(sets) ? sets : [],
    });
    if (!updated) return res.status(404).json({ error: 'Partido de bracket no encontrado' });

    const [saved] = await sql`
      UPDATE tournaments SET bracket = ${JSON.stringify(updated)}::jsonb
      WHERE id = ${req.params.id} RETURNING *
    `;

    res.json({ ...saved, bracket: updated });
  } catch (err) { next(err); }
});

// DELETE /api/tournaments/:id/bracket/:matchId
// Deshace el resultado de un partido del cuadro. El nodo no se elimina (el árbol es
// fijo): se limpian los scores y, en cascada, los partidos posteriores que dependían
// de ese ganador.
router.delete('/:id/bracket/:matchId', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const sql = getDb();
    const [tournament] = await sql`SELECT * FROM tournaments WHERE id = ${req.params.id}`;
    if (!tournament) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!tournament.bracket) return res.status(400).json({ error: 'El bracket aún no fue generado' });

    const updated = clearBracketResult(tournament.bracket, req.params.matchId);
    if (!updated) return res.status(404).json({ error: 'Partido de bracket no encontrado' });

    const [saved] = await sql`
      UPDATE tournaments SET bracket = ${JSON.stringify(updated)}::jsonb
      WHERE id = ${req.params.id} RETURNING *
    `;

    res.json({ ...saved, bracket: updated });
  } catch (err) { next(err); }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

const MAX_PREVIA_MATCHES = 2;
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
 * @param {Array} matches - registros de matches (fase previa) del torneo
 * @returns {Array} - [{ round, team1: { id, name }, team2: { id, name } }]
 */
function generatePreviaSchedule(pairs, matches = []) {
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

  const need = new Map(pairs.map((p) => [key(p), Math.max(0, MAX_PREVIA_MATCHES - played.get(key(p)))]));

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

// Desempate de la tabla de parejas: victorias, diferencia, games a favor y,
// si todo empata, el pair_id — sin ese último criterio el orden lo terminaba
// decidiendo el orden de filas que devolvía Postgres, que difiere entre queries.
function comparePairRows(a, b) {
  return b.wins - a.wins
      || b.diff - a.diff
      || b.gf - a.gf
      || String(a.pair_id).localeCompare(String(b.pair_id));
}

/**
 * Calcula la tabla de posiciones de la fase previa para cada pareja.
 * El orden debe ser idéntico al de la tabla que arma el front (Standings.jsx):
 * si divergen, el seed del cuadro no coincide con la posición de la tabla.
 * @param {Array} pairs  - [{ id, p1_id, p2_id, p1_name, p2_name }]
 * @param {Array} matches - registros de la tabla matches
 * @returns {Array} standings ordenados por wins DESC, diff DESC, gf DESC, pair_id
 */
function computeStandings(pairs, matches) {
  return pairs
    .map((pr) => {
      let wins = 0;
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
        if (isTeam1) {
          if (s1 > s2) wins++;
          gf += s1; gc += s2;
        } else if (isTeam2) {
          if (s2 > s1) wins++;
          gf += s2; gc += s1;
        }
      }
      return {
        pair_id:   pr.id,
        pair_name: `${pr.p1_name} & ${pr.p2_name}`,
        wins,
        diff: gf - gc,
        gf,
      };
    })
    .sort(comparePairRows)
    .map((s, i) => ({ ...s, seed: i + 1 }));
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
function generateBracket(standings) {
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

  return {
    generated_at: new Date().toISOString(),
    total_pairs:  N,
    direct_count: D,
    standings,
    octavos,
    cuartos,
    semis,
    final,
  };
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
function applyBracketResult(bracket, matchId, score1, score2, duration_seconds = null, court = null, setsData = {}) {
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
function clearBracketResult(bracket, matchId) {
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
  match.winner_id        = null;
  match.winner_name      = null;
}

function findBracketMatch(bracket, matchId) {
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

export default router;
