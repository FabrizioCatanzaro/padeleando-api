import { bracketNodes } from './profileStats.js';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const AGENDA_DEFAULT_DAYS = 14;
export const AGENDA_MAX_DAYS = 62;

export function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Rango pedido por query, recortado a AGENDA_MAX_DAYS; sin `from` arranca hoy (hora argentina).
export function parseAgendaRange(query, today) {
  const from = DAY_RE.test(query?.from ?? '') ? query.from : today;
  const maxTo = addDays(from, AGENDA_MAX_DAYS - 1);
  let to = DAY_RE.test(query?.to ?? '') ? query.to : addDays(from, AGENDA_DEFAULT_DAYS - 1);
  if (to < from) to = from;
  if (to > maxTo) to = maxTo;
  return { from, to };
}

const tournamentOf = (r) => ({ id: r.tournament_id ?? r.id, name: r.tournament_name ?? r.name, format: r.format, group_id: r.group_id, group_name: r.group_name });
const tournamentHref = (t) => `/cat/${t.group_id}/torneo/${t.id}`;

function fromScheduled(r) {
  const tournament = tournamentOf(r);
  const rivals = r.mine_is_team1 ? [r.n3, r.n4] : [r.n1, r.n2];
  return {
    kind: 'partido_torneo', id: `sm:${r.id}`, date: r.day, time: r.time ?? null,
    tournament, club_name: r.club_name ?? null, court: r.court ?? null,
    rivals: rivals.filter(Boolean).join(' / '), status: 'programado', href: tournamentHref(tournament),
  };
}

function fromBrackets(rows, from, to) {
  const out = [];
  for (const r of rows) {
    const tournament = tournamentOf(r);
    const pairs = Object.fromEntries((r.pairs ?? []).map((p) => [String(p.id), p]));
    const nodes = [...bracketNodes(r.bracket), ...bracketNodes(r.bracket_plata).map((n) => ({ ...n, plata: true }))];
    for (const n of nodes) {
      const day = n.programado?.date;
      if (!day || day < from || day > to || n.winner_id) continue;
      const p1 = pairs[String(n.pair1_id)];
      const p2 = pairs[String(n.pair2_id)];
      if (!p1?.mine && !p2?.mine) continue;
      const rival = p1?.mine ? p2 : p1;
      out.push({
        kind: 'partido_torneo', id: `br:${r.id}:${n.plata ? 'plata:' : ''}${n.id}`, date: day, time: n.programado.time ?? null,
        tournament, club_name: r.club_name ?? null, court: n.programado.court ?? null,
        rivals: rival?.name ?? null, round: n.round, status: 'programado', href: tournamentHref(tournament),
      });
    }
  }
  return out;
}

function fromFriendly(r) {
  return {
    kind: 'amistoso', id: `fm:${r.id}`, date: r.day, time: r.time, tournament: null,
    club_name: r.club_name ?? null, court: null, rivals: null,
    status: r.filled >= 4 ? 'completo' : 'abierto', missing: Math.max(0, 4 - r.filled), href: `/amistoso/${r.id}`,
  };
}

function fromTournament(r) {
  const tournament = tournamentOf(r);
  return {
    kind: 'torneo', id: `t:${r.id}`, date: r.day, time: r.time ?? null, tournament,
    club_name: r.club_name ?? null, court: null, rivals: null, status: 'inscripto', href: tournamentHref(tournament),
  };
}

// Une las cuatro fuentes en una lista ordenada. Un torneo con partidos propios ese día no se repite como "inscripto".
export function buildAgenda({ scheduled = [], brackets = [], friendlies = [], tournaments = [], from, to }) {
  const matches = [...scheduled.map(fromScheduled), ...fromBrackets(brackets, from, to)];
  const busy = new Set(matches.map((m) => `${m.tournament.id}|${m.date}`));
  const items = [
    ...matches,
    ...friendlies.map(fromFriendly),
    ...tournaments.filter((t) => !busy.has(`${t.id}|${t.day}`)).map(fromTournament),
  ];
  return items.sort((a, b) =>
    a.date.localeCompare(b.date) || (a.time ?? '99:99').localeCompare(b.time ?? '99:99') || a.id.localeCompare(b.id));
}
