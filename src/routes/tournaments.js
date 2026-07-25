import { Router } from 'express';
import { getDb }  from '../db.js';
import { uid }    from '../uid.js';
import { optionalAuth, requireAuth } from '../middleware/auth.js';
import { requireGroupManage, requireTournamentManage } from '../middleware/access.js';
import { canManageGroup } from '../lib/access.js';

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
             c.name          AS club_name,
             c.photo_url     AS club_photo_url,
             c.location_name AS club_location_name,
             (EXISTS (
               SELECT 1 FROM subscriptions s
               JOIN   groups g ON g.user_id = s.user_id
               WHERE  g.id = t.group_id AND s.plan = 'premium' AND s.status = 'active'
             )) AS owner_is_premium
      FROM tournaments t
      JOIN groups g ON g.id = t.group_id
      LEFT JOIN clubs c ON c.id = t.club_id
      WHERE t.id = ${id}
    `;
    if (!tournament) return res.status(404).json({ error: 'Torneo no encontrado' });

    const pairs = await sql`SELECT * FROM pairs WHERE tournament_id = ${id}`;

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
      number_of_courts = 1, club_id = null, event_date = null,
      pending_club_request_id = null,
    } = req.body;

    if (!groupId)      return res.status(400).json({ error: 'groupId requerido' });
    if (!name?.trim()) return res.status(400).json({ error: 'nombre requerido' });
    if (name.trim().length < 2) return res.status(400).json({ error: 'El nombre la jornada tiene que tener mas de 2 caracteres' });
    if (name.trim().length > 30) return res.status(400).json({ error: 'El nombre la jornada no puede superar los 30 caracteres' });
    if (!['liga', 'americano'].includes(format)) return res.status(400).json({ error: 'format debe ser "liga" o "americano"' });

    // El americano se puede crear como "borrador" con menos de 8 parejas: recién al
    // llegar al mínimo se habilitan el calendario, los partidos y el cuadro
    // (validado en /schedule y /bracket). Acá sólo se controla el tope.
    if (format === 'americano' && pairsInput.length > 16) {
      return res.status(400).json({ error: 'El modo Americano admite hasta 16 parejas' });
    }

    const sql  = getDb();
    const tId  = uid();

    if (club_id) {
      const [club] = await sql`SELECT id FROM clubs WHERE id = ${club_id}`;
      if (!club) return res.status(404).json({ error: 'Club no encontrado' });
    }

    const players = [];
    const nameMap = {};           // rawName.toLowerCase() → player (para matching de parejas)
    const pendingInvitations = []; // { player, inviteUserId, inviteUsername }

    for (const rawName of playerNames.filter(Boolean)) {
      const trimmed = rawName.trim();
      let resolvedName = trimmed;
      let inviteUserId   = null;
      let inviteUsername = null;

      // Resolver @username → nombre real del usuario
      if (trimmed.startsWith('@')) {
        const username = trimmed.slice(1);
        if (!username) continue;
        const [foundUser] = await sql`SELECT id, name, username FROM users WHERE username = ${username}`;
        if (!foundUser) return res.status(404).json({ error: `No existe el usuario @${username}` });
        resolvedName   = foundUser.name;
        inviteUserId   = foundUser.id;
        inviteUsername = foundUser.username;
      }

      let [player] = await sql`
        SELECT p.* FROM players p
        JOIN group_players gp ON gp.player_id = p.id
        WHERE gp.group_id = ${groupId} AND LOWER(p.name) = LOWER(${resolvedName})
      `;
      if (!player) {
        [player] = await sql`
          INSERT INTO players (id, name) VALUES (${uid()}, ${resolvedName}) RETURNING *
        `;
      }
      await sql`INSERT INTO group_players (group_id, player_id)
        VALUES (${groupId}, ${player.id}) ON CONFLICT DO NOTHING
      `;
      players.push(player);
      nameMap[trimmed.toLowerCase()] = player;

      if (inviteUserId && req.user && inviteUserId === req.user.id) {
        // El creador se suma a sí mismo → vincular automáticamente, sin invitación
        if (!player.user_id) {
          await sql`UPDATE players SET user_id = ${req.user.id} WHERE id = ${player.id}`;
          player.user_id = req.user.id;
        }
      } else if (inviteUserId && !player.user_id && req.user) {
        pendingInvitations.push({ player, inviteUserId, inviteUsername });
      }
    }

    const [tournament] = await sql`
        INSERT INTO tournaments (id, group_id, name, mode, format, number_of_courts, club_id, event_date, pending_club_request_id)
        VALUES (${tId}, ${groupId}, ${name.trim()}, ${mode}, ${format}, ${number_of_courts ?? 1}, ${club_id ?? null}, ${event_date || null}, ${pending_club_request_id ?? null})
      RETURNING *`;

    for (const player of players) {
      await sql`
        INSERT INTO tournament_players (tournament_id, player_id)
        VALUES (${tId}, ${player.id}) ON CONFLICT DO NOTHING
      `;
    }

    // Crear parejas — el nameMap permite que @username matchee con el jugador resuelto
    const pairs = [];
    for (const { p1Name, p2Name } of pairsInput) {
      const p1 = nameMap[p1Name.toLowerCase()] ?? players.find((p) => p.name.toLowerCase() === p1Name.toLowerCase());
      const p2 = nameMap[p2Name.toLowerCase()] ?? players.find((p) => p.name.toLowerCase() === p2Name.toLowerCase());
      if (!p1 || !p2) continue;
      const [pair] = await sql`
        INSERT INTO pairs (id, tournament_id, p1_id, p2_id)
        VALUES (${uid()}, ${tId}, ${p1.id}, ${p2.id}) RETURNING *
      `;
      pairs.push(pair);
    }

    // Crear invitaciones para jugadores agregados por @username (+ notificación).
    // Auto-aceptar si el usuario ya aceptó antes una invitación en esta misma categoría.
    for (const { player, inviteUserId, inviteUsername } of pendingInvitations) {
      const [existing] = await sql`
        SELECT id FROM player_invitations WHERE player_id = ${player.id} AND status = 'pending'
      `;
      if (existing) continue;

      const [prior] = await sql`
        SELECT 1 FROM player_invitations
        WHERE group_id = ${groupId} AND invited_user_id = ${inviteUserId} AND status = 'accepted'
        LIMIT 1
      `;
      const autoAccept = !!prior;

      const [invitation] = await sql`
        INSERT INTO player_invitations
          (id, player_id, group_id, invited_by, invited_identifier, invited_user_id, status)
        VALUES
          (${uid()}, ${player.id}, ${groupId}, ${req.user.id}, ${'@' + inviteUsername}, ${inviteUserId},
           ${autoAccept ? 'accepted' : 'pending'})
        RETURNING id
      `;

      // Si se auto-acepta, vincular el slot de jugador a la cuenta al instante
      if (autoAccept) {
        await sql`UPDATE players SET user_id = ${inviteUserId} WHERE id = ${player.id}`;
      }

      await sql`
        INSERT INTO notifications (id, user_id, type, actor_id, entity_id)
        VALUES (${uid()}, ${inviteUserId}, 'invitation', ${req.user.id}, ${invitation.id})
      `;
    }

    res.status(201).json({ ...tournament, players, pairs, matches: [] });
  } catch (err) { next(err); }
});

// PATCH /api/tournaments/:id
router.patch('/:id', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const { id }           = req.params;
    const { name, status, mode, number_of_courts, club_id, event_date } = req.body;
    if (name !== undefined && name.trim().length > 30) return res.status(400).json({ error: 'El nombre la jornada no puede superar los 30 caracteres' });
    if (name !== undefined && name.trim().length < 2) return res.status(400).json({ error: 'El nombre la jornada debe superar los 2 caracteres' });
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
          event_date       = CASE WHEN ${event_date !== undefined}::boolean THEN ${event_date || null}::date ELSE event_date END
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
// Cada pareja juega exactamente 2 partidos contra rivales distintos.
// No crea partidos en BD — devuelve el calendario propuesto.
router.post('/:id/schedule', requireAuth, requireTournamentManage, async (req, res, next) => {
  try {
    const sql = getDb();
    const [tournament] = await sql`SELECT * FROM tournaments WHERE id = ${req.params.id}`;
    if (!tournament) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (tournament.format !== 'americano') return res.status(400).json({ error: 'Solo disponible en formato Americano' });

    const pairsRaw = await sql`
      SELECT pr.id, p1.name AS p1_name, p2.name AS p2_name
      FROM pairs pr
      JOIN players p1 ON p1.id = pr.p1_id
      JOIN players p2 ON p2.id = pr.p2_id
      WHERE pr.tournament_id = ${req.params.id}
    `;

    if (pairsRaw.length < 8 || pairsRaw.length > 16) {
      return res.status(400).json({ error: 'Se necesitan entre 8 y 16 parejas para generar el calendario' });
    }

    const schedule = generatePreviaSchedule(pairsRaw);
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
    const { score1, score2, duration_seconds, court } = req.body;
    if (score1 == null || score2 == null) return res.status(400).json({ error: 'score1 y score2 requeridos' });
    if (typeof score1 !== 'number' || typeof score2 !== 'number') return res.status(400).json({ error: 'Los scores deben ser números' });
    if (score1 === score2) return res.status(400).json({ error: 'No puede haber empate en la fase eliminatoria' });

    const sql = getDb();
    const [tournament] = await sql`SELECT * FROM tournaments WHERE id = ${req.params.id}`;
    if (!tournament) return res.status(404).json({ error: 'Torneo no encontrado' });
    if (!tournament.bracket) return res.status(400).json({ error: 'El bracket aún no fue generado' });

    const bracket = tournament.bracket;
    const { matchId } = req.params;

    const updated = applyBracketResult(bracket, matchId, score1, score2, duration_seconds ?? null, court ?? null);
    if (!updated) return res.status(404).json({ error: 'Partido de bracket no encontrado' });

    const [saved] = await sql`
      UPDATE tournaments SET bracket = ${JSON.stringify(updated)}::jsonb
      WHERE id = ${req.params.id} RETURNING *
    `;

    res.json({ ...saved, bracket: updated });
  } catch (err) { next(err); }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Genera un calendario de fase previa donde cada pareja juega exactamente 2 partidos
 * contra rivales distintos.
 * @param {Array} pairs - [{ id, p1_name, p2_name }]
 * @returns {Array} - [{ round, team1: { id, name }, team2: { id, name } }]
 */
function generatePreviaSchedule(pairs) {
  const shuffled = [...pairs].sort(() => Math.random() - 0.5);
  const rounds = buildRoundRobin(shuffled);
  const schedule = [];
  const byePairs = [];

  for (let r = 0; r < Math.min(2, rounds.length); r++) {
    for (const [a, b] of rounds[r].matches) {
      schedule.push({
        round: r + 1,
        team1: { id: a.id, name: `${a.p1_name} & ${a.p2_name}` },
        team2: { id: b.id, name: `${b.p1_name} & ${b.p2_name}` },
      });
    }
    if (rounds[r].bye) byePairs.push(rounds[r].bye);
  }

  // N impar: las 2 parejas con bye se enfrentan entre sí
  if (byePairs.length === 2) {
    const [a, b] = byePairs;
    schedule.push({
      round: 3,
      team1: { id: a.id, name: `${a.p1_name} & ${a.p2_name}` },
      team2: { id: b.id, name: `${b.p1_name} & ${b.p2_name}` },
    });
  }

  return schedule;
}

/**
 * Genera rondas de round-robin. Cada ronda retorna { matches, bye }.
 * Si N es impar, agrega un null temporario; la pareja que cae con null queda como bye.
 */
function buildRoundRobin(teams) {
  const list = [...teams];
  if (list.length % 2 !== 0) list.push(null);
  const n = list.length;
  const rounds = [];

  for (let r = 0; r < n - 1; r++) {
    const round = { matches: [], bye: null };
    for (let i = 0; i < n / 2; i++) {
      const a = list[i];
      const b = list[n - 1 - i];
      if (a === null) round.bye = b;
      else if (b === null) round.bye = a;
      else round.matches.push([a, b]);
    }
    rounds.push(round);
    list.splice(1, 0, list.pop());
  }
  return rounds;
}

/**
 * Calcula la tabla de posiciones de la fase previa para cada pareja.
 * @param {Array} pairs  - [{ id, p1_id, p2_id, p1_name, p2_name }]
 * @param {Array} matches - registros de la tabla matches
 * @returns {Array} standings ordenados por wins DESC, diff DESC
 */
function computeStandings(pairs, matches) {
  return pairs
    .map((pr) => {
      let wins = 0;
      let diff = 0;
      for (const m of matches) {
        const isTeam1 = m.team1_p1 === pr.p1_id || m.team1_p1 === pr.p2_id
                     || m.team1_p2 === pr.p1_id || m.team1_p2 === pr.p2_id;
        const isTeam2 = m.team2_p1 === pr.p1_id || m.team2_p1 === pr.p2_id
                     || m.team2_p2 === pr.p1_id || m.team2_p2 === pr.p2_id;
        if (isTeam1) {
          if (m.score1 > m.score2) wins++;
          diff += m.score1 - m.score2;
        } else if (isTeam2) {
          if (m.score2 > m.score1) wins++;
          diff += m.score2 - m.score1;
        }
      }
      return {
        pair_id:   pr.id,
        pair_name: `${pr.p1_name} & ${pr.p2_name}`,
        wins,
        diff,
      };
    })
    .sort((a, b) => b.wins - a.wins || b.diff - a.diff)
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
function applyBracketResult(bracket, matchId, score1, score2, duration_seconds = null, court = null) {
  const b = JSON.parse(JSON.stringify(bracket)); // clonar

  const winner = score1 > score2 ? 'pair1' : 'pair2';

  // Buscar el match en todas las rondas
  let found = false;

  for (const round of ['octavos', 'cuartos', 'semis']) {
    const arr = b[round];
    const idx = arr.findIndex((m) => m.id === matchId);
    if (idx === -1) continue;

    const match = arr[idx];
    match.score1            = score1;
    match.score2            = score2;
    match.duration_seconds  = duration_seconds;
    match.court             = court;
    match.winner_id         = match[`${winner}_id`];
    match.winner_name       = match[`${winner}_name`];
    found = true;

    propagateWinner(b, matchId, match.winner_id, match.winner_name);
    break;
  }

  // Final
  if (!found && b.final.id === matchId) {
    const match = b.final;
    match.score1           = score1;
    match.score2           = score2;
    match.duration_seconds = duration_seconds;
    match.court            = court;
    match.winner_id        = match[`${winner}_id`];
    match.winner_name      = match[`${winner}_name`];
    found = true;
  }

  return found ? b : null;
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
