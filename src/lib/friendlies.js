import { LEVEL_RE } from './category.js';

export const EXPIRY_DAYS = 30;
export const VISIBILITIES = ['publico', 'link'];
export const SLOTS = [[1, 1], [1, 2], [2, 1], [2, 2]];
export const SIDES = ['drive', 'reves', 'cualquiera'];
export const HANDS = ['diestro', 'zurdo'];
export const STYLES = ['caballeros', 'damas', 'mixto'];
const MAX_PRICE = 10_000_000;
const MAX_GUEST_NAME = 40;
const MAX_COURT_LABEL = 40;
const MAX_GAMES = 99;
const TZ = 'America/Argentina/Buenos_Aires';
const RANGE_RE = /^([CDM])([1-9]|10)-\1([1-9]|10)$/;

const fail = (message) => { throw new Error(message); };

export function arNow(date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

export function toMinutes(date, time) {
  const [y, m, d] = String(date).slice(0, 10).split('-').map(Number);
  const [h, mi] = String(time).split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mi) / 60000;
}

export const startMinutes = (match) => toMinutes(match.date, match.start_time);
export const endMinutes = (match) => startMinutes(match) + Number(match.duration_minutes);
export const nowMinutes = (now) => toMinutes(now.date, now.time);
export const hasStarted = (match, now) => startMinutes(match) <= nowMinutes(now);

export function isExpired(match, now) {
  if (match.status === 'confirmado' || match.status === 'cancelado') return false;
  return toMinutes(match.date, '00:00') + EXPIRY_DAYS * 1440 < toMinutes(now.date, '00:00');
}

export const isFilled = (slot) => Boolean(slot.user_id || slot.guest_name);

export function deriveStatus(match, players, now) {
  if (match.status === 'confirmado' || match.status === 'cancelado') return match.status;
  if (isExpired(match, now)) return 'vencido';
  if (match.status === 'por_confirmar') return 'por_confirmar';
  if (endMinutes(match) <= nowMinutes(now)) return 'falta_resultado';
  return players.filter(isFilled).length === 4 ? 'completo' : 'abierto';
}

export function parseLevel(value) {
  if (value === null || value === undefined || value === '') return null;
  const v = String(value).trim().toUpperCase();
  if (LEVEL_RE.test(v)) return v;
  const range = RANGE_RE.exec(v);
  if (range && Number(range[2]) < Number(range[3])) return v;
  return fail('La categoría sugerida debe ser una categoría (C6) o un rango de la misma rama (C5-C7)');
}

const isIsoDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));

function parseTime(value) {
  const m = /^(\d{2}):(\d{2})(:\d{2})?$/.exec(String(value ?? ''));
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return fail('La hora debe tener el formato HH:MM');
  return `${m[1]}:${m[2]}`;
}

function parseDuration(value) {
  const n = Number(value ?? 90);
  if (!Number.isInteger(n) || n < 30 || n > 300 || n % 30 !== 0) return fail('La duración debe ser de 30 a 300 minutos, en pasos de 30');
  return n;
}

function parseSetsFormat(value) {
  const n = Number(value ?? 1);
  if (n !== 1 && n !== 3) return fail('El formato debe ser set único (1) o mejor de 3 (3)');
  return n;
}

function parseCourtLabel(value) {
  if (value === null || value === undefined) return null;
  const v = String(value).trim();
  if (v.length > MAX_COURT_LABEL) return fail(`La cancha admite hasta ${MAX_COURT_LABEL} caracteres`);
  return v || null;
}

export function parseGuestName(value) {
  const v = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!v) return fail('Falta el nombre del jugador');
  if (v.length > MAX_GUEST_NAME) return fail(`El nombre admite hasta ${MAX_GUEST_NAME} caracteres`);
  return v;
}

function parseEnum(value, options, message) {
  if (value === null || value === undefined || value === '') return null;
  const v = String(value).trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return options.includes(v) ? v : fail(message);
}

export const parseStyle = (value) => parseEnum(value, STYLES, 'El estilo debe ser caballeros, damas o mixto');

export function parsePrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > MAX_PRICE) return fail('El alquiler debe ser un monto válido');
  return Math.round(n * 100) / 100;
}

export function parseWhatsapp(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const v = String(value).trim().replace(/\s+/g, ' ');
  const digits = v.replace(/\D/g, '');
  if (!/^\+?[\d\s()-]+$/.test(v) || digits.length < 8 || digits.length > 15) return fail('El WhatsApp debe tener entre 8 y 15 números');
  return v;
}

export function parseGameData(input = {}, { withWhatsapp = false } = {}) {
  const out = {
    side: parseEnum(input?.side, SIDES, 'El lado debe ser drive, revés o cualquiera'),
    hand: parseEnum(input?.hand, HANDS, 'La mano hábil debe ser diestro o zurdo'),
  };
  if (withWhatsapp) out.whatsapp = parseWhatsapp(input?.whatsapp);
  return out;
}

export const pricePerPerson = (total) => (total === null || total === undefined ? null : Math.round(Number(total) / 4));

export function parseSlotRef(team, position) {
  const t = Number(team), p = Number(position);
  if (![1, 2].includes(t) || ![1, 2].includes(p)) return fail('El lugar debe ser equipo 1 o 2, posición 1 o 2');
  return { team: t, position: p };
}

export function parseSlotFill(input) {
  if (!input || (input.username == null && input.guest_name == null)) return null;
  if (input.username != null && input.guest_name != null) return fail('Un lugar lleva una cuenta o un nombre, no los dos');
  if (input.username != null) {
    const u = String(input.username).trim().replace(/^@/, '').toLowerCase();
    if (!u) return fail('Falta el usuario');
    return { username: u };
  }
  return { guest_name: parseGuestName(input.guest_name), ...parseGameData(input) };
}

function parseSlots(input = []) {
  if (!Array.isArray(input)) return fail('Los jugadores deben ser una lista');
  const slots = new Map();
  for (const raw of input) {
    const { team, position } = parseSlotRef(raw?.team, raw?.position);
    if (team === 1 && position === 1) return fail('El lugar 1 del equipo 1 es del creador');
    const key = `${team}-${position}`;
    if (slots.has(key)) return fail('Hay un lugar repetido');
    const fill = parseSlotFill(raw);
    if (fill) slots.set(key, { team, position, ...fill });
  }
  const usernames = [...slots.values()].map((s) => s.username).filter(Boolean);
  if (new Set(usernames).size !== usernames.length) return fail('Un usuario no puede ocupar dos lugares');
  return [...slots.values()];
}

export function parseFriendlyInput(body, now) {
  const mode = body?.mode;
  if (mode !== 'abierto' && mode !== 'jugado') return fail('El modo debe ser "abierto" o "jugado"');
  if (!body.club_id || typeof body.club_id !== 'string') return fail('Elegí un club');
  if (!isIsoDate(body.date)) return fail('La fecha debe tener el formato AAAA-MM-DD');
  const visibility = body.visibility ?? 'publico';
  if (!VISIBILITIES.includes(visibility)) return fail('La visibilidad debe ser "publico" o "link"');

  const match = {
    club_id: body.club_id,
    court_label: parseCourtLabel(body.court_label),
    date: body.date,
    start_time: parseTime(body.start_time),
    duration_minutes: parseDuration(body.duration_minutes),
    visibility,
    level: parseLevel(body.level),
    sets_format: parseSetsFormat(body.sets_format),
    court_price: parsePrice(body.court_price),
    style: parseStyle(body.style),
  };
  const me = parseGameData(body.me, { withWhatsapp: true });
  const slots = parseSlots(body.players);
  const started = hasStarted(match, now);

  if (mode === 'abierto') {
    if (started) return fail('Un partido abierto tiene que empezar más adelante');
    if (slots.length === 3) return fail('Un partido abierto necesita al menos un lugar libre');
    return { mode, match, me, slots, result: null };
  }
  if (!started) return fail('Un partido jugado no puede tener fecha futura');
  if (isExpired({ ...match, status: 'programado' }, now)) return fail(`Solo se cargan partidos de los últimos ${EXPIRY_DAYS} días`);
  if (slots.length !== 3) return fail('Cargá los 4 jugadores del partido');
  return { mode, match, me, slots, result: parseResult(match.sets_format, body.sets) };
}

export const editMode = (status) =>
  status === 'abierto' || status === 'completo' ? 'abierto'
    : status === 'falta_resultado' || status === 'por_confirmar' ? 'jugado' : null;

export function parseFriendlyPatch(body, current, now, mode = 'abierto') {
  const out = {};
  if (body.court_label !== undefined) out.court_label = parseCourtLabel(body.court_label);
  if (body.date !== undefined) {
    if (!isIsoDate(body.date)) return fail('La fecha debe tener el formato AAAA-MM-DD');
    out.date = body.date;
  }
  if (body.start_time !== undefined) out.start_time = parseTime(body.start_time);
  if (body.duration_minutes !== undefined) out.duration_minutes = parseDuration(body.duration_minutes);
  if (body.visibility !== undefined) {
    if (!VISIBILITIES.includes(body.visibility)) return fail('La visibilidad debe ser "publico" o "link"');
    out.visibility = body.visibility;
  }
  if (body.level !== undefined) out.level = parseLevel(body.level);
  if (body.sets_format !== undefined) out.sets_format = parseSetsFormat(body.sets_format);
  if (body.court_price !== undefined) out.court_price = parsePrice(body.court_price);
  if (body.style !== undefined) out.style = parseStyle(body.style);
  if (body.club_id !== undefined) {
    if (!body.club_id || typeof body.club_id !== 'string') return fail('Elegí un club');
    out.club_id = body.club_id;
  }
  if (mode === 'jugado' && out.sets_format !== undefined && out.sets_format !== current.sets_format) {
    return fail('El formato no cambia en un partido ya jugado');
  }
  if (out.date || out.start_time) {
    const started = hasStarted({ ...current, ...out }, now);
    if (mode === 'abierto' && started) return fail('La nueva fecha y hora tienen que ser futuras');
    if (mode === 'jugado' && !started) return fail('Un partido ya jugado no puede tener fecha futura');
  }
  return out;
}

const setWinner = (s) => (s.s1 === s.s2 ? null : s.s1 > s.s2 ? 1 : 2);

function parseSet(raw) {
  const s1 = Number(raw?.s1), s2 = Number(raw?.s2);
  if (![s1, s2].every((n) => Number.isInteger(n) && n >= 0 && n <= MAX_GAMES)) return fail('Los games de cada set deben ser números enteros');
  if (s1 === s2) return fail('Un set no puede terminar empatado');
  return { s1, s2 };
}

export function parseResult(setsFormat, input) {
  if (!Array.isArray(input) || input.length === 0) return fail('Cargá el resultado');
  const sets = input.map(parseSet);
  if (setsFormat === 1) {
    if (sets.length !== 1) return fail('Un partido a set único lleva un solo set');
    return { sets, score1: sets[0].s1, score2: sets[0].s2 };
  }
  const won = [0, 0];
  for (const [i, s] of sets.entries()) {
    if (won[0] === 2 || won[1] === 2) return fail(`El partido ya estaba definido antes del set ${i + 1}`);
    won[setWinner(s) - 1]++;
  }
  if (won[0] < 2 && won[1] < 2) return fail('Al mejor de 3, un equipo tiene que ganar 2 sets');
  return { sets, score1: won[0], score2: won[1] };
}

export const slotOf = (players, userId) => (userId ? players.find((p) => p.user_id === userId) ?? null : null);
export const otherTeam = (team) => (team === 1 ? 2 : 1);
export const teamUserIds = (players, team) => players.filter((p) => p.team === team && p.user_id).map((p) => p.user_id);

export function proposalError({ match, players, pending, viewerId, now }) {
  const slot = slotOf(players, viewerId);
  if (!slot) return 'Solo los jugadores del partido cargan el resultado';
  const status = deriveStatus(match, players, now);
  if (status === 'confirmado') return 'El resultado ya está confirmado';
  if (status === 'cancelado') return 'El partido está cancelado';
  if (status === 'vencido') return `Pasaron más de ${EXPIRY_DAYS} días: el partido venció sin resultado`;
  if (!hasStarted(match, now)) return 'El partido todavía no empezó';
  if (players.filter(isFilled).length < 4) return 'Faltan jugadores: completá los 4 lugares antes de cargar el resultado';
  if (pending && pending.team === slot.team) return 'Tu equipo ya propuso un resultado: espera la respuesta del rival';
  if (teamUserIds(players, otherTeam(slot.team)).length === 0) return 'El equipo rival no tiene jugadores con cuenta: el partido no se puede confirmar';
  return null;
}

export function acceptError({ match, players, proposal, viewerId, now }) {
  const slot = slotOf(players, viewerId);
  if (!slot) return 'Solo los jugadores del partido aprueban el resultado';
  if (!proposal || proposal.status !== 'pendiente') return 'La propuesta ya no está vigente';
  if (deriveStatus(match, players, now) === 'vencido') return `Pasaron más de ${EXPIRY_DAYS} días: el partido venció sin resultado`;
  if (slot.team === proposal.team) return 'El resultado lo aprueba el equipo rival';
  return null;
}

export function joinError({ match, players, slotRef, viewerId, now }) {
  if (match.status !== 'programado') return 'El partido ya no acepta jugadores';
  if (hasStarted(match, now)) return 'El partido ya empezó';
  if (slotOf(players, viewerId)) return 'Ya estás en este partido';
  const slot = players.find((p) => p.team === slotRef.team && p.position === slotRef.position);
  if (!slot || isFilled(slot)) return 'Ese lugar ya está ocupado';
  return null;
}

export function leaveError({ match, players, viewerId, now }) {
  const slot = slotOf(players, viewerId);
  if (!slot) return 'No estás en este partido';
  if (match.created_by === viewerId) return 'El creador no puede salir: cancelá el partido';
  const status = deriveStatus(match, players, now);
  if (status === 'confirmado' || status === 'cancelado' || status === 'vencido') return 'El partido ya está cerrado';
  return null;
}

export function lineupChangeError({ match, players, slotRef, now, creatorSlot = false }) {
  if (slotRef.team === 1 && slotRef.position === 1 && !creatorSlot) return 'El lugar del creador no cambia';
  const status = deriveStatus(match, players, now);
  if (status === 'confirmado' || status === 'cancelado' || status === 'vencido') return 'El partido ya está cerrado';
  return null;
}

export function viewerActions({ match, players, pending, viewerId, now }) {
  const slot = slotOf(players, viewerId);
  const status = deriveStatus(match, players, now);
  const isCreator = Boolean(viewerId) && match.created_by === viewerId;
  return {
    team: slot?.team ?? null,
    is_creator: isCreator,
    can_join: Boolean(viewerId) && !slot && status === 'abierto',
    can_propose: Boolean(viewerId) && !proposalError({ match, players, pending, viewerId, now }),
    can_accept: Boolean(pending) && !acceptError({ match, players, proposal: pending, viewerId, now }),
    can_leave: Boolean(viewerId) && !leaveError({ match, players, viewerId, now }),
    can_edit: isCreator && editMode(status) !== null,
    can_cancel: isCreator && (status === 'abierto' || status === 'completo' || status === 'falta_resultado'),
    needs_action: needsAction({ status, slot, pending }),
  };
}

export function needsAction({ status, slot, pending }) {
  if (!slot) return false;
  if (status === 'falta_resultado') return true;
  return status === 'por_confirmar' && Boolean(pending) && pending.team !== slot.team;
}
