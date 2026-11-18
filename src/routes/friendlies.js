import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { getDb } from '../db.js';
import { uid } from '../uid.js';
import { requireAuth, optionalAuth } from '../middleware/auth.js';
import {
  EXPIRY_DAYS, SLOTS, arNow, deriveStatus, isFilled, hasStarted, slotOf, otherTeam, teamUserIds,
  parseFriendlyInput, parseFriendlyPatch, parseResult, parseSlotRef, parseSlotFill,
  proposalError, acceptError, joinError, leaveError, lineupChangeError, viewerActions,
} from '../lib/friendlies.js';

const router = Router();
const LIST_LIMIT = 50;
const MINE_LIMIT = 100;

// Fragmentos componibles para sql.query: un valor es parámetro; un fragmento q`` se inserta como SQL.
const isFragment = (v) => v && typeof v === 'object' && Array.isArray(v.parts);
function q(strings, ...values) {
  const parts = [];
  strings.forEach((s, i) => {
    parts.push(s);
    if (i < values.length) parts.push(isFragment(values[i]) ? values[i] : { value: values[i] });
  });
  return { parts };
}
function compile(fragment, params = []) {
  let text = '';
  for (const part of fragment.parts) {
    if (typeof part === 'string') text += part;
    else if (isFragment(part)) text += compile(part, params).text;
    else { params.push(part.value); text += `$${params.length}`; }
  }
  return { text, params };
}
const run = (sql, fragment) => { const { text, params } = compile(fragment); return sql.query(text, params); };

const newToken = () => randomBytes(16).toString('base64url');
const badRequest = (res, err) => res.status(400).json({ error: err.message });

const PLAYERS_JSON = q`
  COALESCE((
    SELECT json_agg(json_build_object(
             'team', p.team, 'position', p.position, 'user_id', p.user_id, 'guest_name', p.guest_name,
             'username', u.username, 'name', u.name, 'avatar_url', u.avatar_url, 'category', u.category
           ) ORDER BY p.team, p.position)
    FROM friendly_match_players p
    LEFT JOIN users u ON u.id = p.user_id
    WHERE p.match_id = fm.id
  ), '[]'::json)`;

const PROPOSAL_JSON = q`json_build_object(
  'id', pr.id, 'team', pr.team, 'score1', pr.score1, 'score2', pr.score2, 'sets', pr.sets,
  'status', pr.status, 'created_at', pr.created_at, 'decided_at', pr.decided_at,
  'proposed_by_username', pu.username, 'proposed_by_name', pu.name)`;

const PENDING_JSON = q`
  (SELECT ${PROPOSAL_JSON}
   FROM friendly_match_proposals pr
   LEFT JOIN users pu ON pu.id = pr.proposed_by
   WHERE pr.match_id = fm.id AND pr.status = 'pendiente')`;

const HISTORY_JSON = q`
  COALESCE((
    SELECT json_agg(${PROPOSAL_JSON} ORDER BY pr.created_at)
    FROM friendly_match_proposals pr
    LEFT JOIN users pu ON pu.id = pr.proposed_by
    WHERE pr.match_id = fm.id
  ), '[]'::json)`;

const SELECT_MATCH = q`
  SELECT fm.id, fm.created_by, fm.status, fm.visibility, fm.share_token, fm.club_id, fm.court_label,
         fm.date, fm.start_time, fm.duration_minutes, fm.level, fm.sets_format,
         fm.score1, fm.score2, fm.sets, fm.confirmed_at, fm.created_at,
         c.name AS club_name, c.location_name AS club_location,
         cu.username AS creator_username, cu.name AS creator_name,
         ${PLAYERS_JSON} AS players`;

const FROM_MATCH = q`
  FROM friendly_matches fm
  JOIN clubs c ON c.id = fm.club_id
  LEFT JOIN users cu ON cu.id = fm.created_by`;

async function loadMatch(sql, id, { withHistory = false } = {}) {
  const [row] = await run(sql, q`
    ${SELECT_MATCH}, ${PENDING_JSON} AS pending, ${withHistory ? HISTORY_JSON : q`'[]'::json`} AS proposals
    ${FROM_MATCH}
    WHERE fm.id = ${id}`);
  return row ?? null;
}

const expiresOn = (date) => {
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + EXPIRY_DAYS);
  return d.toISOString().slice(0, 10);
};

function present(row, viewerId, now, { withHistory = false } = {}) {
  const players = row.players;
  const pending = row.pending ?? null;
  const viewer = viewerActions({ match: row, players, pending, viewerId, now });
  const insider = viewer.is_creator || viewer.team !== null;
  return {
    id: row.id,
    status: deriveStatus(row, players, now),
    visibility: row.visibility,
    club: { id: row.club_id, name: row.club_name, location_name: row.club_location },
    court_label: row.court_label,
    date: String(row.date).slice(0, 10),
    start_time: String(row.start_time).slice(0, 5),
    duration_minutes: row.duration_minutes,
    level: row.level,
    sets_format: row.sets_format,
    result: row.status === 'confirmado' ? { score1: row.score1, score2: row.score2, sets: row.sets } : null,
    confirmed_at: row.confirmed_at,
    expires_on: expiresOn(row.date),
    creator: row.creator_username ? { username: row.creator_username, name: row.creator_name } : null,
    players: players.map((p) => ({
      team: p.team,
      position: p.position,
      user: p.user_id ? { id: p.user_id, username: p.username, name: p.name, avatar_url: p.avatar_url, category: p.category } : null,
      guest_name: p.guest_name,
      is_creator: Boolean(p.user_id) && p.user_id === row.created_by,
    })),
    pending,
    ...(withHistory ? { proposals: row.proposals } : {}),
    share_token: insider ? row.share_token : undefined,
    viewer,
  };
}

const canSee = (row, viewerId, token) =>
  row.visibility === 'publico'
  || row.created_by === viewerId
  || Boolean(slotOf(row.players, viewerId))
  || (Boolean(token) && token === row.share_token);

async function loadOr404(sql, req, res, opts) {
  const row = await loadMatch(sql, req.params.id, opts);
  if (!row || !canSee(row, req.user?.id, req.query.t ?? req.body?.t)) {
    res.status(404).json({ error: 'Amistoso no encontrado' });
    return null;
  }
  return row;
}

const accountsOf = (players, type) => players.filter((p) => p.user_id).map((p) => ({ user_id: p.user_id, type }));

function notifyCte(matchId, actorId, entries, guard = q``) {
  const seen = new Set();
  const rows = entries.filter((e) => {
    const key = `${e.user_id}:${e.type}`;
    if (!e.user_id || e.user_id === actorId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return q`
    INSERT INTO notifications (id, user_id, type, actor_id, entity_id)
    SELECT x.id, x.user_id, x.type, ${actorId}, ${matchId}
    FROM unnest(${rows.map(() => uid())}::text[], ${rows.map((e) => e.user_id)}::text[], ${rows.map((e) => e.type)}::text[])
         AS x(id, user_id, type)
    ${guard}`;
}

router.get('/', optionalAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const now = arNow();
    const clubId = typeof req.query.club_id === 'string' ? req.query.club_id : null;
    const day = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : null;
    const rows = await run(sql, q`
      ${SELECT_MATCH}, NULL::json AS pending
      ${FROM_MATCH}
      WHERE fm.status = 'programado' AND fm.visibility = 'publico'
        AND (fm.date > ${now.date}::date OR (fm.date = ${now.date}::date AND fm.start_time > ${now.time}::time))
        AND (${clubId}::text IS NULL OR fm.club_id = ${clubId}::text)
        AND (${day}::date IS NULL OR fm.date = ${day}::date)
        AND EXISTS (
          SELECT 1 FROM friendly_match_players p
          WHERE p.match_id = fm.id AND p.user_id IS NULL AND p.guest_name IS NULL
        )
      ORDER BY fm.date, fm.start_time
      LIMIT ${LIST_LIMIT}`);
    res.json(rows.map((r) => present(r, req.user?.id, now)));
  } catch (err) { next(err); }
});

router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const now = arNow();
    const rows = await run(sql, q`
      ${SELECT_MATCH}, ${PENDING_JSON} AS pending
      ${FROM_MATCH}
      WHERE fm.created_by = ${req.user.id}
         OR EXISTS (SELECT 1 FROM friendly_match_players p WHERE p.match_id = fm.id AND p.user_id = ${req.user.id})
      ORDER BY fm.date DESC, fm.start_time DESC
      LIMIT ${MINE_LIMIT}`);
    res.json(rows.map((r) => present(r, req.user.id, now)));
  } catch (err) { next(err); }
});

router.get('/:id', optionalAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const row = await loadOr404(sql, req, res, { withHistory: true });
    if (!row) return;
    res.json(present(row, req.user?.id, arNow(), { withHistory: true }));
  } catch (err) { next(err); }
});

router.post('/', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const now = arNow();
    let input;
    try { input = parseFriendlyInput(req.body, now); } catch (err) { return badRequest(res, err); }

    const usernames = input.slots.map((s) => s.username).filter(Boolean);
    const [[club], users] = await Promise.all([
      sql`SELECT id FROM clubs WHERE id = ${input.match.club_id}`,
      usernames.length ? sql`SELECT id, username FROM users WHERE LOWER(username) = ANY(${usernames}::text[])` : [],
    ]);
    if (!club) return res.status(400).json({ error: 'El club no existe' });
    const byUsername = new Map(users.map((u) => [u.username.toLowerCase(), u.id]));
    const missing = usernames.filter((u) => !byUsername.has(u));
    if (missing.length) return res.status(400).json({ error: `No existe el usuario @${missing[0]}` });
    if (usernames.some((u) => byUsername.get(u) === req.user.id)) {
      return res.status(400).json({ error: 'Ya ocupás el lugar del creador' });
    }

    const filled = new Map(input.slots.map((s) => [`${s.team}-${s.position}`, s]));
    const lineup = SLOTS.map(([team, position]) => {
      if (team === 1 && position === 1) return { team, position, user_id: req.user.id, guest_name: null };
      const s = filled.get(`${team}-${position}`);
      return { team, position, user_id: s?.username ? byUsername.get(s.username) : null, guest_name: s?.guest_name ?? null };
    });

    const id = uid();
    const played = input.mode === 'jugado';
    const m = input.match;
    const r = input.result;
    const notify = notifyCte(id, req.user.id, lineup.map((p) => ({
      user_id: p.user_id,
      type: played && p.team === 2 ? 'friendly_proposal' : 'friendly_added',
    })));

    await run(sql, q`
      WITH m AS (
        INSERT INTO friendly_matches
          (id, created_by, status, visibility, share_token, club_id, court_label, date, start_time,
           duration_minutes, level, sets_format)
        VALUES
          (${id}, ${req.user.id}, ${played ? 'por_confirmar' : 'programado'}, ${m.visibility}, ${newToken()},
           ${m.club_id}, ${m.court_label}, ${m.date}::date, ${m.start_time}::time, ${m.duration_minutes}, ${m.level}, ${m.sets_format})
        RETURNING id
      ),
      p AS (
        INSERT INTO friendly_match_players (match_id, team, position, user_id, guest_name, joined_at)
        SELECT m.id, x.team, x.position, NULLIF(x.user_id, ''), NULLIF(x.guest_name, ''),
               CASE WHEN x.user_id <> '' OR x.guest_name <> '' THEN NOW() END
        FROM m, unnest(${lineup.map((p) => p.team)}::smallint[], ${lineup.map((p) => p.position)}::smallint[],
                       ${lineup.map((p) => p.user_id ?? '')}::text[], ${lineup.map((p) => p.guest_name ?? '')}::text[])
             AS x(team, position, user_id, guest_name)
      ),
      pr AS (
        INSERT INTO friendly_match_proposals (id, match_id, proposed_by, team, score1, score2, sets)
        SELECT ${uid()}, m.id, ${req.user.id}, 1, ${r?.score1 ?? 0}, ${r?.score2 ?? 1}, ${JSON.stringify(r?.sets ?? [])}::jsonb
        FROM m WHERE ${played}::boolean
      ),
      n AS (${notify})
      SELECT id FROM m`);

    const row = await loadMatch(sql, id, { withHistory: true });
    const warning = played && teamUserIds(lineup, 2).length === 0
      ? 'El equipo rival no tiene jugadores con cuenta: el partido no suma hasta que uno reclame su lugar'
      : null;
    res.status(201).json({ ...present(row, req.user.id, now, { withHistory: true }), warning });
  } catch (err) { next(err); }
});

router.patch('/:id', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const now = arNow();
    const row = await loadOr404(sql, req, res);
    if (!row) return;
    if (row.created_by !== req.user.id) return res.status(403).json({ error: 'Solo el creador edita el partido' });
    if (row.status !== 'programado' || hasStarted(row, now)) return res.status(409).json({ error: 'El partido ya empezó: no se puede editar' });

    let patch;
    try { patch = parseFriendlyPatch(req.body ?? {}, row, now); } catch (err) { return badRequest(res, err); }
    if (Object.keys(patch).length === 0) return res.json(present(row, req.user.id, now));
    if (patch.club_id) {
      const [club] = await sql`SELECT id FROM clubs WHERE id = ${patch.club_id}`;
      if (!club) return res.status(400).json({ error: 'El club no existe' });
    }

    const has = (k) => Object.hasOwn(patch, k);
    const scheduleChanged = ['club_id', 'court_label', 'date', 'start_time', 'duration_minutes'].some(has);
    const notify = notifyCte(row.id, req.user.id, scheduleChanged ? accountsOf(row.players, 'friendly_updated') : [], q`WHERE EXISTS (SELECT 1 FROM u)`);
    await run(sql, q`
      WITH u AS (
        UPDATE friendly_matches SET
          club_id          = CASE WHEN ${has('club_id')}::boolean          THEN ${patch.club_id ?? null}::text         ELSE club_id END,
          court_label      = CASE WHEN ${has('court_label')}::boolean      THEN ${patch.court_label ?? null}::text     ELSE court_label END,
          date             = CASE WHEN ${has('date')}::boolean             THEN ${patch.date ?? null}::date            ELSE date END,
          start_time       = CASE WHEN ${has('start_time')}::boolean       THEN ${patch.start_time ?? null}::time      ELSE start_time END,
          duration_minutes = CASE WHEN ${has('duration_minutes')}::boolean THEN ${patch.duration_minutes ?? null}::int ELSE duration_minutes END,
          visibility       = CASE WHEN ${has('visibility')}::boolean       THEN ${patch.visibility ?? null}::text      ELSE visibility END,
          level            = CASE WHEN ${has('level')}::boolean            THEN ${patch.level ?? null}::text           ELSE level END,
          sets_format      = CASE WHEN ${has('sets_format')}::boolean      THEN ${patch.sets_format ?? null}::smallint ELSE sets_format END
        WHERE id = ${row.id} AND status = 'programado'
        RETURNING id
      ),
      n AS (${notify})
      SELECT id FROM u`);
    res.json(present(await loadMatch(sql, row.id), req.user.id, now));
  } catch (err) { next(err); }
});

router.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const now = arNow();
    const row = await loadOr404(sql, req, res);
    if (!row) return;
    const viewer = viewerActions({ match: row, players: row.players, pending: row.pending, viewerId: req.user.id, now });
    if (!viewer.is_creator) return res.status(403).json({ error: 'Solo el creador cancela el partido' });
    if (!viewer.can_cancel) return res.status(409).json({ error: 'El partido ya no se puede cancelar' });

    const notify = notifyCte(row.id, req.user.id, accountsOf(row.players, 'friendly_cancelled'), q`WHERE EXISTS (SELECT 1 FROM u)`);
    const [done] = await run(sql, q`
      WITH u AS (
        UPDATE friendly_matches SET status = 'cancelado'
        WHERE id = ${row.id} AND status = 'programado'
        RETURNING id
      ),
      n AS (${notify})
      SELECT id FROM u`);
    if (!done) return res.status(409).json({ error: 'El partido cambió: recargá' });
    res.json(present(await loadMatch(sql, row.id), req.user.id, now));
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const now = arNow();
    const row = await loadOr404(sql, req, res, { withHistory: true });
    if (!row) return;
    if (row.created_by !== req.user.id) return res.status(403).json({ error: 'Solo el creador borra el partido' });
    const status = deriveStatus(row, row.players, now);
    const deletable = status === 'vencido' || (status !== 'confirmado' && row.proposals.length === 0);
    if (!deletable) return res.status(409).json({ error: 'Solo se borra un partido vencido o sin resultados propuestos' });

    await sql`
      WITH d AS (DELETE FROM friendly_matches WHERE id = ${row.id} AND status <> 'confirmado' RETURNING id)
      DELETE FROM notifications WHERE type LIKE 'friendly\_%' AND entity_id IN (SELECT id FROM d)
    `;
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:id/join', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const now = arNow();
    let slotRef;
    try { slotRef = parseSlotRef(req.body?.team, req.body?.position); } catch (err) { return badRequest(res, err); }
    const row = await loadOr404(sql, req, res);
    if (!row) return;
    const error = joinError({ match: row, players: row.players, slotRef, viewerId: req.user.id, now });
    if (error) return res.status(409).json({ error });

    const becomesFull = row.players.filter(isFilled).length === 3;
    const notify = notifyCte(row.id, req.user.id, [
      { user_id: row.created_by, type: 'friendly_joined' },
      ...(becomesFull ? accountsOf(row.players, 'friendly_full') : []),
    ], q`WHERE EXISTS (SELECT 1 FROM u)`);
    const [done] = await run(sql, q`
      WITH u AS (
        UPDATE friendly_match_players SET user_id = ${req.user.id}, joined_at = NOW()
        WHERE match_id = ${row.id} AND team = ${slotRef.team} AND position = ${slotRef.position}
          AND user_id IS NULL AND guest_name IS NULL
          AND EXISTS (SELECT 1 FROM friendly_matches WHERE id = ${row.id} AND status = 'programado')
        RETURNING match_id
      ),
      n AS (${notify})
      SELECT match_id FROM u`);
    if (!done) return res.status(409).json({ error: 'Ese lugar ya está ocupado' });
    res.json(present(await loadMatch(sql, row.id), req.user.id, now));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ya estás en este partido' });
    next(err);
  }
});

const clearSlot = (sql, matchId, slotRef, notify) => run(sql, q`
  WITH s AS (
    UPDATE friendly_match_players SET user_id = NULL, guest_name = NULL, joined_at = NULL
    WHERE match_id = ${matchId} AND team = ${slotRef.team} AND position = ${slotRef.position}
      AND (user_id IS NOT NULL OR guest_name IS NOT NULL)
    RETURNING match_id
  ),
  r AS (
    UPDATE friendly_match_proposals SET status = 'rechazada', decided_at = NOW()
    WHERE match_id = ${matchId} AND status = 'pendiente' AND EXISTS (SELECT 1 FROM s)
    RETURNING match_id
  ),
  m AS (
    UPDATE friendly_matches SET status = 'programado'
    WHERE id = ${matchId} AND status = 'por_confirmar' AND EXISTS (SELECT 1 FROM s)
    RETURNING id
  ),
  n AS (${notify})
  SELECT match_id FROM s`);

router.post('/:id/leave', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const now = arNow();
    const row = await loadOr404(sql, req, res);
    if (!row) return;
    const error = leaveError({ match: row, players: row.players, viewerId: req.user.id, now });
    if (error) return res.status(409).json({ error });

    const slot = slotOf(row.players, req.user.id);
    const notify = notifyCte(row.id, req.user.id, [{ user_id: row.created_by, type: 'friendly_left' }], q`WHERE EXISTS (SELECT 1 FROM s)`);
    const [done] = await clearSlot(sql, row.id, slot, notify);
    if (!done) return res.status(409).json({ error: 'El partido cambió: recargá' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:id/players/:team/:position', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const now = arNow();
    let slotRef, fill;
    try {
      slotRef = parseSlotRef(req.params.team, req.params.position);
      fill = parseSlotFill(req.body);
      if (!fill) throw new Error('Indicá un usuario o un nombre');
    } catch (err) { return badRequest(res, err); }
    const row = await loadOr404(sql, req, res);
    if (!row) return;
    if (row.created_by !== req.user.id) return res.status(403).json({ error: 'Solo el creador completa lugares' });
    const error = lineupChangeError({ match: row, players: row.players, slotRef, now });
    if (error) return res.status(409).json({ error });
    const slot = row.players.find((p) => p.team === slotRef.team && p.position === slotRef.position);
    if (isFilled(slot)) return res.status(409).json({ error: 'Ese lugar ya está ocupado' });

    let userId = null;
    if (fill.username) {
      const [user] = await sql`SELECT id FROM users WHERE LOWER(username) = ${fill.username}`;
      if (!user) return res.status(400).json({ error: `No existe el usuario @${fill.username}` });
      if (slotOf(row.players, user.id)) return res.status(409).json({ error: 'Ese usuario ya está en el partido' });
      userId = user.id;
    }
    const notify = notifyCte(row.id, req.user.id, [{ user_id: userId, type: 'friendly_added' }], q`WHERE EXISTS (SELECT 1 FROM u)`);
    const [done] = await run(sql, q`
      WITH u AS (
        UPDATE friendly_match_players SET user_id = ${userId}, guest_name = ${fill.guest_name ?? null}, joined_at = NOW()
        WHERE match_id = ${row.id} AND team = ${slotRef.team} AND position = ${slotRef.position}
          AND user_id IS NULL AND guest_name IS NULL
        RETURNING match_id
      ),
      n AS (${notify})
      SELECT match_id FROM u`);
    if (!done) return res.status(409).json({ error: 'Ese lugar ya está ocupado' });
    res.json(present(await loadMatch(sql, row.id), req.user.id, now));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Ese usuario ya está en el partido' });
    next(err);
  }
});

router.delete('/:id/players/:team/:position', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const now = arNow();
    let slotRef;
    try { slotRef = parseSlotRef(req.params.team, req.params.position); } catch (err) { return badRequest(res, err); }
    const row = await loadOr404(sql, req, res);
    if (!row) return;
    if (row.created_by !== req.user.id) return res.status(403).json({ error: 'Solo el creador quita jugadores' });
    const error = lineupChangeError({ match: row, players: row.players, slotRef, now });
    if (error) return res.status(409).json({ error });

    const slot = row.players.find((p) => p.team === slotRef.team && p.position === slotRef.position);
    if (!isFilled(slot)) return res.status(409).json({ error: 'Ese lugar ya está libre' });
    const notify = notifyCte(row.id, req.user.id, [{ user_id: slot.user_id, type: 'friendly_removed' }], q`WHERE EXISTS (SELECT 1 FROM s)`);
    const [done] = await clearSlot(sql, row.id, slotRef, notify);
    if (!done) return res.status(409).json({ error: 'El partido cambió: recargá' });
    res.json(present(await loadMatch(sql, row.id), req.user.id, now));
  } catch (err) { next(err); }
});

router.post('/:id/proposals', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const now = arNow();
    const row = await loadOr404(sql, req, res);
    if (!row) return;
    const error = proposalError({ match: row, players: row.players, pending: row.pending, viewerId: req.user.id, now });
    if (error) return res.status(409).json({ error });
    let result;
    try { result = parseResult(row.sets_format, req.body?.sets); } catch (err) { return badRequest(res, err); }

    const team = slotOf(row.players, req.user.id).team;
    const rivals = row.players.filter((p) => p.team === otherTeam(team));
    const pendingId = row.pending?.id ?? '';
    const notify = notifyCte(row.id, req.user.id, accountsOf(rivals, 'friendly_proposal'), q`WHERE EXISTS (SELECT 1 FROM ins)`);
    const [done] = await run(sql, q`
      WITH old AS (
        UPDATE friendly_match_proposals SET status = 'rechazada', decided_at = NOW()
        WHERE match_id = ${row.id} AND status = 'pendiente' AND id = ${pendingId}
        RETURNING id
      ),
      seen AS (SELECT COALESCE((SELECT id FROM old), '') AS id),
      ins AS (
        INSERT INTO friendly_match_proposals (id, match_id, proposed_by, team, score1, score2, sets)
        SELECT ${uid()}, ${row.id}, ${req.user.id}, ${team}, ${result.score1}, ${result.score2}, ${JSON.stringify(result.sets)}::jsonb
        FROM seen
        WHERE seen.id = ${pendingId}
          AND EXISTS (SELECT 1 FROM friendly_matches WHERE id = ${row.id} AND status IN ('programado', 'por_confirmar'))
        RETURNING id
      ),
      m AS (
        UPDATE friendly_matches SET status = 'por_confirmar'
        WHERE id = ${row.id} AND EXISTS (SELECT 1 FROM ins)
        RETURNING id
      ),
      n AS (${notify})
      SELECT id FROM ins`);
    if (!done) return res.status(409).json({ error: 'El resultado cambió mientras cargabas: recargá' });
    res.status(201).json(present(await loadMatch(sql, row.id, { withHistory: true }), req.user.id, now, { withHistory: true }));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'El resultado cambió mientras cargabas: recargá' });
    next(err);
  }
});

router.post('/:id/proposals/:pid/accept', requireAuth, async (req, res, next) => {
  try {
    const sql = getDb();
    const now = arNow();
    const row = await loadOr404(sql, req, res);
    if (!row) return;
    const proposal = row.pending?.id === req.params.pid ? row.pending : null;
    const error = acceptError({ match: row, players: row.players, proposal, viewerId: req.user.id, now });
    if (error) return res.status(409).json({ error });

    const notify = notifyCte(row.id, req.user.id, accountsOf(row.players, 'friendly_confirmed'), q`WHERE EXISTS (SELECT 1 FROM a)`);
    const [done] = await run(sql, q`
      WITH a AS (
        UPDATE friendly_match_proposals SET status = 'aceptada', decided_at = NOW()
        WHERE id = ${proposal.id} AND match_id = ${row.id} AND status = 'pendiente'
        RETURNING score1, score2, sets
      ),
      m AS (
        UPDATE friendly_matches fm SET status = 'confirmado', score1 = a.score1, score2 = a.score2, sets = a.sets, confirmed_at = NOW()
        FROM a
        WHERE fm.id = ${row.id} AND fm.status = 'por_confirmar'
        RETURNING fm.id
      ),
      n AS (${notify})
      SELECT id FROM m`);
    if (!done) return res.status(409).json({ error: 'La propuesta ya no está vigente' });
    res.json(present(await loadMatch(sql, row.id, { withHistory: true }), req.user.id, now, { withHistory: true }));
  } catch (err) { next(err); }
});

export default router;
