import { Router } from 'express';
import { getDb, withTransaction } from '../db.js';
import { uid }    from '../uid.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { requireGroupManage, requireTournamentManage } from '../middleware/access.js';
import { canManageGroup } from '../lib/access.js';
import { parseSignupFields, resolveSignup } from '../lib/signup.js';
import { tournamentQuotaError } from '../lib/plan.js';
import {
  generatePreviaSchedule, computeStandings, generateBracket,
  applyBracketResult, clearBracketResult, findBracketMatch,
  isPreviaComplete, isBracketMatchReady, planScheduleRows, applyBracketWalkovers,
  generatePlayoffBracket,
} from '../lib/tournamentLogic.js';
import { hasStarted, publicSignup, countUsedPlayers } from '../lib/registrations.js';
import {
  parseLigaSettings, LIGA_KEYS, generateFecha, validateFecha, crossesFromRows, fechaDatesError,
} from '../lib/ligaFechas.js';

const router = Router();

// GET /api/tournaments/search?q= — busca jornadas de categorías públicas por nombre.
// Va antes de '/:id' o esa ruta se come la palabra "search".
router.get('/search', async (req, res, next) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return res.json([]);
    const sql = getDb();
    // Los nombres de jornada se repiten entre categorías ("Fecha 3"), así que el
    // resultado viaja con la categoría y el club: sin eso no se distinguen.
    const tournaments = await sql`
      SELECT t.id, t.name, t.status, t.format,
             COALESCE(t.event_date, t.created_at::date) AS day,
             g.id AS group_id, g.name AS group_name, g.emojis AS group_emojis,
             u.username AS owner_username,
             c.name AS club_name
      FROM   tournaments t
      JOIN   groups g ON g.id = t.group_id
      JOIN   users  u ON u.id = g.user_id
      LEFT   JOIN clubs c ON c.id = t.club_id
      WHERE  g.is_public = true
        AND  t.name ILIKE ${'%' + q + '%'}
      ORDER  BY COALESCE(t.event_date, t.created_at::date) DESC
      LIMIT  10
    `;
    res.json(tournaments);
  } catch (err) { next(err); }
});

// GET /api/tournaments/:id
router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const { id } = req.params;

    const [tournament] = await sql`
      SELECT t.*,
             g.user_id       AS group_owner_id,
             g.name          AS group_name,
             g.emojis        AS group_emojis,
             g.is_public     AS group_is_public,
             ow.username     AS owner_username,
             ow.name         AS owner_name,
             ow.avatar_url   AS owner_avatar_url,
             g.signup_open       AS group_signup_open,
             g.signup_price      AS group_signup_price,
             g.signup_price_unit AS group_signup_price_unit,
             g.signup_contacts   AS group_signup_contacts,
             g.level             AS group_level,
             g.signup_capacity      AS group_signup_capacity,
             g.signup_capacity_unit AS group_signup_capacity_unit,
             g.signup_closes_at     AS group_signup_closes_at,
             g.rules                AS group_rules,
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

    // El fixture: partidos con equipos, cancha y hora, todavía sin resultado.
    // Van en su propia lista para que nada de lo que ya cuenta partidos jugados
    // los tome por jugados.
    const scheduled = await sql`
      SELECT *, scheduled_date::text AS scheduled_date
      FROM scheduled_matches WHERE tournament_id = ${id}
      ORDER BY scheduled_at NULLS LAST, round NULLS LAST, position, created_at
    `;

    // Las fechas de una liga en varios días: número y días de juego.
    const fechas = await sql`
      SELECT id, tournament_id, number, start_date::text AS start_date, end_date::text AS end_date, created_at
      FROM tournament_fechas WHERE tournament_id = ${id} ORDER BY number
    `;

    // Incluir info de vinculación: usuario registrado + invitación pendiente si aplica
    // Solo jugadores explícitamente agregados a esta jornada (tournament_players)
    const activePlayers = await sql`
      SELECT
        p.*,
        u.username   AS linked_username,
        u.name       AS linked_name,
        u.avatar_url AS linked_avatar_url,
        u.category   AS linked_category,
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
        ...scheduled.flatMap((m) => [m.team1_p1, m.team1_p2, m.team2_p1, m.team2_p2]),
      ]),
    ].filter((pid) => pid && !activeIds.has(pid));

    const removedPlayers = orphanIds.length
      ? await sql`
          SELECT p.*, u.name AS linked_name, u.avatar_url AS linked_avatar_url, u.category AS linked_category,
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

    // La inscripción, ya resuelta entre jornada, categoría y perfil: es la misma
    // cuenta que hacía la vista de sólo lectura, y ahora la página es una sola.
    const signup = resolveSignup(tournament, {
      signup_open:       tournament.group_signup_open,
      signup_price:      tournament.group_signup_price,
      signup_price_unit: tournament.group_signup_price_unit,
      signup_contacts:   tournament.group_signup_contacts,
      level:             tournament.group_level,
      signup_capacity:      tournament.group_signup_capacity,
      signup_capacity_unit: tournament.group_signup_capacity_unit,
      signup_closes_at:     tournament.group_signup_closes_at,
      rules:                tournament.group_rules,
    }, tournament.owner_social_links);

    // Para el que no organiza: el cupo sin números y, antes de que empiece
    // el torneo, el plantel oculto (Fabri, 2026-11-09).
    if (!can_manage) {
      // En la liga por fechas, armar una fecha publica el fixture.
      const rosterHidden = !hasStarted(tournament, matches.length) && fechas.length === 0;
      const used = signup.capacity != null ? await countUsedPlayers(sql, id) : 0;
      const {
        signup_capacity, signup_capacity_unit, group_signup_capacity, group_signup_capacity_unit, ...visible
      } = tournament;
      return res.json({
        ...visible,
        group_owner_is_premium: tournament.owner_is_premium,
        signup: publicSignup(signup, { format: tournament.format, used }),
        players: rosterHidden ? [] : players,
        pairs: rosterHidden ? [] : pairs,
        matches,
        scheduled_matches: rosterHidden ? [] : scheduled,
        fechas,
        roster_hidden: rosterHidden,
        is_owner, can_manage,
      });
    }

    res.json({
      ...tournament,
      // Mismo nombre que en /api/readonly/:id: el frontend lee uno solo.
      group_owner_is_premium: tournament.owner_is_premium,
      signup,
      players, pairs, matches, scheduled_matches: scheduled, fechas, is_owner, can_manage,
    });
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
    let signup, liga;
    try {
      signup = parseSignupFields(req.body);
      liga = parseLigaSettings(req.body, { format });
    } catch (e) { return res.status(400).json({ error: e.message }); }
    // Una liga nueva copia los puntos de la última liga de la categoría.
    if (format === 'liga' && liga.points_win === undefined && liga.points_loss === undefined) {
      const [prev] = await getDb()`
        SELECT points_win, points_loss FROM tournaments
        WHERE group_id = ${groupId} AND format = 'liga' ORDER BY created_at DESC LIMIT 1`;
      if (prev) { liga.points_win = prev.points_win; liga.points_loss = prev.points_loss; }
    }
    if (liga.liga_mode === 'temporada' && mode !== 'pairs') {
      return res.status(400).json({ error: 'La liga en varios días se juega con parejas fijas' });
    }

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
            signup_open, signup_price, signup_price_unit, signup_contacts, level,
            signup_capacity, signup_capacity_unit, signup_closes_at,
            liga_mode, allow_rematch, winner_format, playoff_size, rules, points_win, points_loss)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18,
                 $19, $20, $21, $22, $23, $24, $25) RETURNING *`,
        [tId, groupId, name.trim(), mode, format, number_of_courts ?? 1,
         club_id ?? null, event_date || null, event_time || null, pending_club_request_id ?? null,
         signup.signup_open ?? null, signup.signup_price ?? null, signup.signup_price_unit ?? null,
         signup.signup_contacts ? JSON.stringify(signup.signup_contacts) : null,
         signup.level ?? null,
         signup.signup_capacity ?? null, signup.signup_capacity_unit ?? null, signup.signup_closes_at ?? null,
         liga.liga_mode ?? 'jornada', liga.allow_rematch ?? false,
         liga.winner_format ?? 'tabla', liga.playoff_size ?? null, signup.rules ?? null,
         liga.points_win ?? 3, liga.points_loss ?? 0]
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

    // Opciones de la liga por fechas: se validan contra lo guardado, porque
    // la edición puede traer solo una.
    let liga = {};
    const tocaLiga = LIGA_KEYS.some((k) => req.body[k] !== undefined);
    if (tocaLiga || mode !== undefined) {
      const [cur] = await sql`
        SELECT t.format, t.mode, t.liga_mode, t.winner_format, t.playoff_size, t.points_win, t.points_loss,
               EXISTS (SELECT 1 FROM tournament_fechas f WHERE f.tournament_id = t.id) AS has_fechas
        FROM tournaments t WHERE t.id = ${id}
      `;
      if (!cur) return res.status(404).json({ error: 'Torneo no encontrado' });
      try { liga = parseLigaSettings(req.body, { format: cur.format, current: cur }); }
      catch (e) { return res.status(400).json({ error: e.message }); }
      if ((liga.liga_mode ?? cur.liga_mode) === 'temporada' && (mode ?? cur.mode) !== 'pairs') {
        return res.status(400).json({ error: 'La liga en varios días se juega con parejas fijas' });
      }
      if (liga.liga_mode && liga.liga_mode !== cur.liga_mode && cur.has_fechas) {
        return res.status(409).json({ error: 'La liga ya tiene fechas armadas: no se puede cambiar a un solo día' });
      }
    }

    // live_match se limpia al finalizar: nadie lo hacía y la jornada terminada
    // conservaba el último payload de partidos en curso, así que seguía
    // figurando "en vivo" en la portada y en la categoría. La condición usa el
    // mismo COALESCE que el status —no el status del body— para que también
    // limpie si el PATCH toca cualquier otra cosa de una jornada ya finalizada.
    const [updated] = await sql`
      UPDATE tournaments
      SET name             = COALESCE(${name   ?? null}, name),
          status           = COALESCE(${status ?? null}, status),
          live_match       = CASE WHEN COALESCE(${status ?? null}, status) = 'finished' THEN NULL ELSE live_match END,
          mode             = COALESCE(${mode   ?? null}, mode),
          number_of_courts = COALESCE(${number_of_courts ?? null}, number_of_courts),
          liga_mode        = COALESCE(${liga.liga_mode ?? null}, liga_mode),
          allow_rematch    = COALESCE(${liga.allow_rematch ?? null}::boolean, allow_rematch),
          winner_format    = COALESCE(${liga.winner_format ?? null}, winner_format),
          playoff_size     = CASE WHEN ${'playoff_size' in liga}::boolean THEN ${liga.playoff_size ?? null}::int ELSE playoff_size END,
          points_win       = COALESCE(${liga.points_win ?? null}::int, points_win),
          points_loss      = COALESCE(${liga.points_loss ?? null}::int, points_loss),
          club_id          = CASE WHEN ${club_id !== undefined}::boolean    THEN ${club_id || null}    ELSE club_id    END,
          pending_club_request_id = CASE WHEN ${pending_club_request_id !== undefined}::boolean THEN ${pending_club_request_id || null} ELSE pending_club_request_id END,
          event_date       = CASE WHEN ${event_date !== undefined}::boolean THEN ${event_date || null}::date ELSE event_date END,
          event_time       = CASE WHEN ${event_time !== undefined}::boolean THEN ${event_time || null}::time ELSE event_time END,
          signup_open       = CASE WHEN ${'signup_open'       in signup}::boolean THEN ${signup.signup_open       ?? null} ELSE signup_open END,
          signup_price      = CASE WHEN ${'signup_price'      in signup}::boolean THEN ${signup.signup_price      ?? null} ELSE signup_price END,
          signup_price_unit = CASE WHEN ${'signup_price_unit' in signup}::boolean THEN ${signup.signup_price_unit ?? null} ELSE signup_price_unit END,
          signup_contacts   = CASE WHEN ${'signup_contacts'   in signup}::boolean THEN ${signup.signup_contacts ? JSON.stringify(signup.signup_contacts) : null}::jsonb ELSE signup_contacts END,
          level             = CASE WHEN ${'level'             in signup}::boolean THEN ${signup.level             ?? null} ELSE level END,
          signup_capacity      = CASE WHEN ${'signup_capacity'      in signup}::boolean THEN ${signup.signup_capacity      ?? null}::int ELSE signup_capacity END,
          signup_capacity_unit = CASE WHEN ${'signup_capacity_unit' in signup}::boolean THEN ${signup.signup_capacity_unit ?? null} ELSE signup_capacity_unit END,
          signup_closes_at     = CASE WHEN ${'signup_closes_at'     in signup}::boolean THEN ${signup.signup_closes_at     ?? null}::timestamptz ELSE signup_closes_at END,
          rules                = CASE WHEN ${'rules'                in signup}::boolean THEN ${signup.rules                ?? null} ELSE rules END
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

// ─── LIGA POR FECHAS ──────────────────────────────────────────────────────────
// Una liga en varios días (liga_mode = 'temporada') se arma de a una fecha,
// al azar o a mano. Los cruces se guardan como partidos programados con
// round = número de fecha. La lógica vive en lib/ligaFechas.js.

const NO_COMPLETA = 'Con estos cruces ya no se completa el todos contra todos';
// Los días salen como texto YYYY-MM-DD: como DATE, el driver los convierte en
// Date con la zona horaria del servidor y el día se puede correr.
const FECHA_COLS = 'id, tournament_id, number, start_date::text AS start_date, end_date::text AS end_date, created_at';

// Lee el torneo bloqueado y todo lo que el armado necesita, en una transacción.
async function loadFechaContext(client, id) {
  const { rows: [tournament] } = await client.query(
    `SELECT id, format, status, liga_mode, allow_rematch FROM tournaments WHERE id = $1 FOR UPDATE`, [id]
  );
  if (!tournament) return { tournament: null };
  const [{ rows: pairs }, { rows: matches }, { rows: scheduled }, { rows: fechas }] = await Promise.all([
    client.query('SELECT id, p1_id, p2_id, status FROM pairs WHERE tournament_id = $1 ORDER BY id', [id]),
    client.query('SELECT team1_p1, team1_p2, team2_p1, team2_p2, round FROM matches WHERE tournament_id = $1', [id]),
    client.query('SELECT * FROM scheduled_matches WHERE tournament_id = $1', [id]),
    client.query(`SELECT ${FECHA_COLS} FROM tournament_fechas WHERE tournament_id = $1 ORDER BY number`, [id]),
  ]);
  return { tournament, pairs, matches, scheduled, fechas };
}

function temporadaError(tournament) {
  if (!tournament) return { status: 404, error: 'Torneo no encontrado' };
  if (tournament.format !== 'liga' || tournament.liga_mode !== 'temporada') {
    return { status: 400, error: 'Solo disponible en ligas que se juegan en varios días' };
  }
  if (tournament.status === 'finished') return { status: 400, error: 'El torneo está finalizado' };
  return null;
}

// Guarda cruces de pareja contra pareja como programados de una fecha.
async function insertFechaCrosses(client, tournamentId, number, crosses, pairs, firstPosition = 0) {
  if (!crosses.length) return;
  const byId = new Map(pairs.map((p) => [String(p.id), p]));
  const rows = crosses.map(([a, b]) => [byId.get(String(a)), byId.get(String(b))]);
  await client.query(
    `INSERT INTO scheduled_matches
       (id, tournament_id, team1_p1, team1_p2, team2_p1, team2_p2, round, position)
     SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[])`,
    [
      rows.map(() => uid()), rows.map(() => tournamentId),
      rows.map(([a]) => a.p1_id), rows.map(([a]) => a.p2_id),
      rows.map(([, b]) => b.p1_id), rows.map(([, b]) => b.p2_id),
      rows.map(() => number), rows.map((_, i) => firstPosition + i),
    ]
  );
}

const fechaScheduled = async (client, id, number) => (await client.query(
  `SELECT *, scheduled_date::text AS scheduled_date
   FROM scheduled_matches WHERE tournament_id = $1 AND round = $2
   ORDER BY scheduled_matches.scheduled_date NULLS LAST, scheduled_at NULLS LAST, position, created_at`, [id, number]
)).rows;

// POST /api/tournaments/:id/fechas — arma la fecha siguiente.
// Body: { start_date, end_date?, mode: 'random' | 'manual', crosses?: [[pairId, pairId]], preview? }
// Al azar, la app elige los cruces; a mano, vienen en `crosses`. Con
// preview: true devuelve la fecha propuesta sin guardarla, para que el
// organizador la revise y la guarde a mano. Responde con los cruces, las
// parejas libres y los avisos (`warnings`).
router.post('/:id/fechas', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const id = req.params.id;
    const { start_date, end_date = null, mode = 'random', crosses: proposed, preview = false } = req.body;
    if (!['random', 'manual'].includes(mode)) return res.status(400).json({ error: 'mode debe ser "random" o "manual"' });
    if (!preview) {
      const dateErr = fechaDatesError(start_date, end_date);
      if (dateErr) return res.status(400).json({ error: dateErr });
    }
    if (mode === 'manual' && (!Array.isArray(proposed) || proposed.length === 0)) {
      return res.status(400).json({ error: 'Elegí al menos un cruce' });
    }
    if (mode === 'manual' && !proposed.every((c) => Array.isArray(c) && c.length === 2)) {
      return res.status(400).json({ error: 'Cada cruce son dos parejas' });
    }

    const result = await withTransaction(async (client) => {
      const ctx = await loadFechaContext(client, id);
      const err = temporadaError(ctx.tournament);
      if (err) return err;

      const history = crossesFromRows(ctx.pairs, [...ctx.matches, ...ctx.scheduled]);
      const number = ctx.fechas.length ? ctx.fechas[ctx.fechas.length - 1].number + 1 : 1;
      const allowRematch = ctx.tournament.allow_rematch;

      let plan;
      if (mode === 'random') {
        try {
          const f = generateFecha({ pairs: ctx.pairs, crosses: history, allowRematch });
          plan = {
            crosses: f.crosses, libres: f.libres, completable: f.completable,
            warnings: f.completable === false ? [NO_COMPLETA] : [],
          };
        } catch (e) { return { status: 409, error: e.message }; }
      } else {
        const v = validateFecha({ pairs: ctx.pairs, crosses: history, proposed, allowRematch });
        if (v.errors.length) return { status: 400, error: v.errors[0], errors: v.errors };
        plan = { crosses: proposed.map(([a, b]) => [String(a), String(b)]), libres: v.libres, completable: v.completable, warnings: v.warnings };
      }
      if (preview) return { preview: true, number, ...plan };

      const { rows: [fecha] } = await client.query(
        `INSERT INTO tournament_fechas (id, tournament_id, number, start_date, end_date)
         VALUES ($1, $2, $3, $4, $5) RETURNING ${FECHA_COLS}`,
        [uid(), id, number, start_date, end_date || null]
      );
      await insertFechaCrosses(client, id, number, plan.crosses, ctx.pairs);
      // La fecha 1 le da día al torneo si no lo tenía: lo usan las tarjetas y el inicio.
      if (number === 1) {
        await client.query('UPDATE tournaments SET event_date = COALESCE(event_date, $2::date) WHERE id = $1', [id, start_date]);
      }
      return { fecha, scheduled_matches: await fechaScheduled(client, id, number), ...plan };
    });

    if (result.error) return res.status(result.status).json({ error: result.error, errors: result.errors });
    res.status(result.preview ? 200 : 201).json(result);
  } catch (err) { next(err); }
});

// PUT /api/tournaments/:id/fechas/:number — cambia los días o los cruces.
// Body: { start_date?, end_date?, crosses?: [[pairId, pairId]] }
// Los cruces solo se cambian si la fecha no tiene partidos jugados. Los que
// quedan igual conservan su cancha, día y horario.
router.put('/:id/fechas/:number', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const id = req.params.id;
    const number = Number(req.params.number);
    if (!Number.isInteger(number) || number < 1) return res.status(400).json({ error: 'Fecha inválida' });
    const { crosses: proposed } = req.body;
    if (proposed !== undefined && (!Array.isArray(proposed) || proposed.length === 0
        || !proposed.every((c) => Array.isArray(c) && c.length === 2))) {
      return res.status(400).json({ error: 'Elegí al menos un cruce' });
    }

    const result = await withTransaction(async (client) => {
      const ctx = await loadFechaContext(client, id);
      const err = temporadaError(ctx.tournament);
      if (err) return err;
      const fecha = ctx.fechas.find((f) => f.number === number);
      if (!fecha) return { status: 404, error: 'Fecha no encontrada' };

      const start = req.body.start_date !== undefined ? req.body.start_date : fecha.start_date;
      const end   = req.body.end_date   !== undefined ? req.body.end_date   : fecha.end_date;
      const dateErr = fechaDatesError(start, end);
      if (dateErr) return { status: 400, error: dateErr };

      let plan = {};
      if (proposed !== undefined) {
        if (ctx.matches.some((m) => m.round === number)) {
          return { status: 409, error: 'Esta fecha ya tiene partidos jugados: sus cruces no se cambian' };
        }
        const own = ctx.scheduled.filter((r) => r.round === number);
        const others = ctx.scheduled.filter((r) => r.round !== number);
        const history = crossesFromRows(ctx.pairs, [...ctx.matches, ...others]);
        const v = validateFecha({ pairs: ctx.pairs, crosses: history, proposed, allowRematch: ctx.tournament.allow_rematch });
        if (v.errors.length) return { status: 400, error: v.errors[0], errors: v.errors };

        // Diferencia contra lo guardado: se borra lo que sale y se agrega lo nuevo.
        const k = (a, b) => [String(a), String(b)].sort().join('|');
        const wanted = new Set(proposed.map(([a, b]) => k(a, b)));
        const keepKeys = new Set();
        const toDelete = [];
        for (const row of own) {
          const [c] = crossesFromRows(ctx.pairs, [row]);
          const key = c && k(c.a, c.b);
          if (key && wanted.has(key) && !keepKeys.has(key)) keepKeys.add(key);
          else toDelete.push(row.id);
        }
        if (toDelete.length) {
          await client.query('DELETE FROM scheduled_matches WHERE id = ANY($1::text[])', [toDelete]);
        }
        const toInsert = proposed.filter(([a, b]) => !keepKeys.has(k(a, b)));
        await insertFechaCrosses(client, id, number, toInsert, ctx.pairs, own.length);
        plan = { libres: v.libres, completable: v.completable, warnings: v.warnings };
      }

      const { rows: [updated] } = await client.query(
        `UPDATE tournament_fechas SET start_date = $1, end_date = $2 WHERE id = $3 RETURNING ${FECHA_COLS}`,
        [start, end || null, fecha.id]
      );
      return { fecha: updated, scheduled_matches: await fechaScheduled(client, id, number), ...plan };
    });

    if (result.error) return res.status(result.status).json({ error: result.error, errors: result.errors });
    res.json(result);
  } catch (err) { next(err); }
});

// DELETE /api/tournaments/:id/fechas/:number — deshace la última fecha.
// Solo la última y solo sin partidos jugados: borra la fecha y sus programados.
router.delete('/:id/fechas/:number', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const id = req.params.id;
    const number = Number(req.params.number);
    const result = await withTransaction(async (client) => {
      const ctx = await loadFechaContext(client, id);
      const err = temporadaError(ctx.tournament);
      if (err) return err;
      const last = ctx.fechas[ctx.fechas.length - 1];
      if (!last || last.number !== number) return { status: 400, error: 'Solo se puede borrar la última fecha' };
      if (ctx.matches.some((m) => m.round === number)) {
        return { status: 409, error: 'Esta fecha ya tiene partidos jugados' };
      }
      await client.query('DELETE FROM scheduled_matches WHERE tournament_id = $1 AND round = $2', [id, number]);
      await client.query('DELETE FROM tournament_fechas WHERE id = $1', [last.id]);
      return { ok: true };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result);
  } catch (err) { next(err); }
});

// ─── AMERICANO ────────────────────────────────────────────────────────────────

// POST /api/tournaments/:id/schedule
// Genera el calendario aleatorio de la fase previa del Americano y lo GUARDA
// como partidos programados (scheduled_matches), con su ronda: así lo ven los
// jugadores y los co-organizadores. Antes sólo se devolvía y el front lo
// guardaba en el localStorage del organizador.
// Cada pareja llega a 2 partidos contra rivales distintos, contando los ya
// jugados y los ya programados: esos se conservan y sólo se agregan los que
// faltan. Para rehacer el calendario, primero se borran los programados.
// Devuelve { schedule, created, scheduled_matches } con el fixture completo.
router.post('/:id/schedule', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const id = req.params.id;
    const result = await withTransaction(async (client) => {
      // El lock serializa dos generaciones simultáneas: sin él, dos clics
      // programaban el calendario dos veces.
      const { rows: [tournament] } = await client.query(
        'SELECT id, format, status, bracket FROM tournaments WHERE id = $1 FOR UPDATE', [id]
      );
      if (!tournament) return { status: 404, error: 'Torneo no encontrado' };
      if (tournament.format !== 'americano') return { status: 400, error: 'Solo disponible en formato Americano' };
      if (tournament.status === 'finished') return { status: 400, error: 'El torneo está finalizado' };
      if (tournament.bracket) return { status: 400, error: 'El cuadro ya fue generado: la fase previa terminó' };

      const [{ rows: pairsRaw }, { rows: matches }, { rows: scheduledPrevia }] = await Promise.all([
        client.query(
          `SELECT pr.id, pr.p1_id, pr.p2_id, pr.status, p1.name AS p1_name, p2.name AS p2_name
           FROM pairs pr
           JOIN players p1 ON p1.id = pr.p1_id
           JOIN players p2 ON p2.id = pr.p2_id
           WHERE pr.tournament_id = $1`, [id]),
        client.query(
          `SELECT team1_p1, team1_p2, team2_p1, team2_p2, created_at
           FROM matches WHERE tournament_id = $1 ORDER BY created_at`, [id]),
        client.query(
          `SELECT id, team1_p1, team1_p2, team2_p1, team2_p2, round, created_at
           FROM scheduled_matches WHERE tournament_id = $1 ORDER BY created_at`, [id]),
      ]);

      if (pairsRaw.length < 8 || pairsRaw.length > 16) {
        return { status: 400, error: 'Se necesitan entre 8 y 16 parejas para generar el calendario' };
      }

      const schedule = generatePreviaSchedule(pairsRaw, [...matches, ...scheduledPrevia]);
      const { toInsert, toUpdate } = planScheduleRows(schedule, pairsRaw, matches, scheduledPrevia);

      if (toInsert.length) {
        // position ordena dentro de la ronda; la ronda ya ordena el fixture.
        await client.query(
          `INSERT INTO scheduled_matches
             (id, tournament_id, team1_p1, team1_p2, team2_p1, team2_p2, round, position)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[], $8::int[])`,
          [
            toInsert.map(() => uid()), toInsert.map(() => id),
            toInsert.map((r) => r.team1[0]), toInsert.map((r) => r.team1[1]),
            toInsert.map((r) => r.team2[0]), toInsert.map((r) => r.team2[1]),
            toInsert.map((r) => r.round), toInsert.map((_, i) => i),
          ]
        );
      }
      if (toUpdate.length) {
        await client.query(
          `UPDATE scheduled_matches s SET round = v.round
           FROM (SELECT * FROM UNNEST($1::text[], $2::int[]) AS t(id, round)) v
           WHERE s.id = v.id`,
          [toUpdate.map((r) => r.id), toUpdate.map((r) => r.round)]
        );
      }

      const { rows: scheduled } = await client.query(
        `SELECT * FROM scheduled_matches WHERE tournament_id = $1
         ORDER BY scheduled_at NULLS LAST, round NULLS LAST, position, created_at`, [id]
      );
      return { schedule, created: toInsert.length, scheduled };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ schedule: result.schedule, created: result.created, scheduled_matches: result.scheduled });
  } catch (err) { next(err); }
});

// POST /api/tournaments/:id/bracket
// Genera el cuadro eliminatorio a partir de la tabla de la fase previa.
// Guarda el bracket en tournaments.bracket y lo retorna.
// Exige la previa completa y que no haya un cuadro: antes un doble toque o un
// co-organizador en otro dispositivo pisaba un cuadro con resultados, y el
// botón aparecía tras un solo partido si el calendario no estaba en ese
// navegador. Para rehacerlo hay que borrarlo antes (DELETE /:id/bracket).
router.post('/:id/bracket', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const sql = getDb();
    const [tournament] = await sql`SELECT * FROM tournaments WHERE id = ${req.params.id}`;
    if (!tournament) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (tournament.format !== 'americano') return res.status(400).json({ error: 'Solo disponible en formato Americano' });
    if (tournament.bracket) {
      return res.status(409).json({ error: 'El cuadro ya fue generado. Borralo antes de generarlo de nuevo.', code: 'bracket_exists' });
    }

    // Traer parejas con nombres de jugadores
    const pairsRaw = await sql`
      SELECT pr.id, pr.p1_id, pr.p2_id, pr.status, p1.name AS p1_name, p2.name AS p2_name
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

    if (!isPreviaComplete(pairsRaw, matches)) {
      return res.status(400).json({
        error: 'La fase previa no terminó: todas las parejas tienen que jugar sus 2 partidos antes de armar el cuadro.',
        code: 'previa_incomplete',
      });
    }

    // Calcular standings por pareja
    const standings = computeStandings(pairsRaw, matches);

    // Generar bracket
    const bracket = generateBracket(standings);

    // Persistir. El `bracket IS NULL` cierra la carrera entre dos pedidos
    // simultáneos: sólo el primero escribe.
    const [updated] = await sql`
      UPDATE tournaments SET bracket = ${JSON.stringify(bracket)}::jsonb
      WHERE id = ${req.params.id} AND bracket IS NULL RETURNING *
    `;
    if (!updated) {
      return res.status(409).json({ error: 'El cuadro ya fue generado. Borralo antes de generarlo de nuevo.', code: 'bracket_exists' });
    }

    res.json({ ...updated, bracket });
  } catch (err) { next(err); }
});

// POST /api/tournaments/:id/playoffs — cierra la tabla de una liga con playoffs
// y arma el cuadro con las primeras `playoff_size` parejas activas. Los partidos
// del cuadro se cargan y se deshacen igual que en el americano.
router.post('/:id/playoffs', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const id = req.params.id;
    const result = await withTransaction(async (client) => {
      const { rows: [t] } = await client.query(
        'SELECT id, format, mode, status, bracket, winner_format, playoff_size, points_win, points_loss FROM tournaments WHERE id = $1 FOR UPDATE', [id]
      );
      if (!t) return { status: 404, error: 'Torneo no encontrado' };
      if (t.format !== 'liga' || t.winner_format !== 'playoffs') {
        return { status: 400, error: 'Esta liga no se define por playoffs' };
      }
      if (t.mode !== 'pairs') return { status: 400, error: 'Los playoffs se juegan con parejas fijas' };
      if (t.status === 'finished') return { status: 400, error: 'El torneo está finalizado' };
      if (t.bracket) return { status: 409, error: 'Los playoffs ya están armados', code: 'bracket_exists' };

      const [{ rows: pairsRaw }, { rows: matches }] = await Promise.all([
        client.query(
          `SELECT pr.id, pr.p1_id, pr.p2_id, pr.status, p1.name AS p1_name, p2.name AS p2_name
           FROM pairs pr
           JOIN players p1 ON p1.id = pr.p1_id
           JOIN players p2 ON p2.id = pr.p2_id
           WHERE pr.tournament_id = $1 ORDER BY pr.id`, [id]),
        client.query('SELECT * FROM matches WHERE tournament_id = $1', [id]),
      ]);
      const tabla = computeStandings(pairsRaw, matches, { win: t.points_win ?? 3, loss: t.points_loss ?? 0 })
        .filter((s) => !s.withdrawn);
      if (tabla.length < t.playoff_size) {
        return { status: 400, error: `Hay ${tabla.length} parejas activas y a playoffs pasan ${t.playoff_size}` };
      }
      const clasificadas = tabla.slice(0, t.playoff_size).map((s, i) => ({ ...s, seed: i + 1 }));
      const bracket = generatePlayoffBracket(clasificadas);
      const { rows: [saved] } = await client.query(
        'UPDATE tournaments SET bracket = $1::jsonb WHERE id = $2 RETURNING *', [JSON.stringify(bracket), id]
      );
      return { saved, bracket };
    });
    if (result.error) return res.status(result.status).json({ error: result.error, code: result.code });
    res.json({ ...result.saved, bracket: result.bracket });
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
// Lee y escribe el JSONB dentro de una transacción con FOR UPDATE: con dos
// organizadores cargando a la vez, el segundo pisaba el resultado del primero.
router.patch('/:id/bracket/:matchId', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const { score1, score2, duration_seconds, court, sets_format, sets } = req.body;
    if (score1 == null || score2 == null) return res.status(400).json({ error: 'score1 y score2 requeridos' });
    if (!Number.isInteger(score1) || !Number.isInteger(score2)) return res.status(400).json({ error: 'Los scores deben ser números enteros' });
    if (score1 < 0 || score2 < 0) return res.status(400).json({ error: 'Los scores no pueden ser negativos' });
    if (score1 === score2) return res.status(400).json({ error: 'No puede haber empate en la fase eliminatoria' });
    if (sets_format != null && sets_format !== 1 && sets_format !== 3) {
      return res.status(400).json({ error: 'sets_format debe ser 1 o 3' });
    }
    if (sets != null && !Array.isArray(sets)) return res.status(400).json({ error: 'sets debe ser una lista' });

    const { matchId } = req.params;
    const result = await withTransaction(async (client) => {
      const { rows: [tournament] } = await client.query(
        'SELECT * FROM tournaments WHERE id = $1 FOR UPDATE', [req.params.id]
      );
      if (!tournament) return { status: 404, error: 'Torneo no encontrado' };
      if (!tournament.bracket) return { status: 400, error: 'El bracket aún no fue generado' };

      const match = findBracketMatch(tournament.bracket, matchId);
      if (!match) return { status: 404, error: 'Partido de bracket no encontrado' };
      if (!isBracketMatchReady(match)) {
        return { status: 400, error: 'Este partido todavía no tiene las dos parejas definidas' };
      }

      // Si en la ronda siguiente espera una pareja retirada, ese cruce se
      // resuelve solo por W.O.
      const updated = applyBracketWalkovers(applyBracketResult(tournament.bracket, matchId, score1, score2, duration_seconds ?? null, court ?? null, {
        sets_format: sets_format ?? null,
        sets: Array.isArray(sets) ? sets : [],
      }));

      const { rows: [saved] } = await client.query(
        'UPDATE tournaments SET bracket = $1::jsonb WHERE id = $2 RETURNING *',
        [JSON.stringify(updated), req.params.id]
      );
      return { saved, bracket: updated };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ...result.saved, bracket: result.bracket });
  } catch (err) { next(err); }
});

// DELETE /api/tournaments/:id/bracket/:matchId
// Deshace el resultado de un partido del cuadro. El nodo no se elimina (el árbol es
// fijo): se limpian los scores y, en cascada, los partidos posteriores que dependían
// de ese ganador. Misma transacción con FOR UPDATE que el PATCH.
router.delete('/:id/bracket/:matchId', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const result = await withTransaction(async (client) => {
      const { rows: [tournament] } = await client.query(
        'SELECT * FROM tournaments WHERE id = $1 FOR UPDATE', [req.params.id]
      );
      if (!tournament) return { status: 404, error: 'Torneo no encontrado' };
      if (!tournament.bracket) return { status: 400, error: 'El bracket aún no fue generado' };

      const cleared = clearBracketResult(tournament.bracket, req.params.matchId);
      if (!cleared) return { status: 404, error: 'Partido de bracket no encontrado' };
      // Un W.O. contra una pareja retirada vuelve a resolverse: no se puede borrar.
      const updated = applyBracketWalkovers(cleared);

      const { rows: [saved] } = await client.query(
        'UPDATE tournaments SET bracket = $1::jsonb WHERE id = $2 RETURNING *',
        [JSON.stringify(updated), req.params.id]
      );
      return { saved, bracket: updated };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ...result.saved, bracket: result.bracket });
  } catch (err) { next(err); }
});

export default router;
