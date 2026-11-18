import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  arNow, deriveStatus, isExpired, parseLevel, parseResult, parseFriendlyInput, parseFriendlyPatch,
  proposalError, acceptError, joinError, leaveError, viewerActions, needsAction,
} from '../src/lib/friendlies.js';

const NOW = { date: '2026-11-17', time: '20:00' };
const base = { status: 'programado', created_by: 'u1', date: '2026-11-20', start_time: '18:00:00', duration_minutes: 90 };
const lineup = (fill = 4) => [
  { team: 1, position: 1, user_id: 'u1' },
  { team: 1, position: 2, user_id: fill >= 2 ? 'u2' : null },
  { team: 2, position: 1, user_id: fill >= 3 ? 'u3' : null },
  { team: 2, position: 2, user_id: null, guest_name: fill >= 4 ? 'Pedro' : null },
];
const played = { ...base, date: '2026-11-16', start_time: '18:00' };

test('arNow: hora de Buenos Aires', () => {
  assert.deepEqual(arNow(new Date('2026-11-18T02:30:00Z')), { date: '2026-11-17', time: '23:30' });
});

test('deriveStatus: abierto, completo, falta_resultado, vencido', () => {
  assert.equal(deriveStatus(base, lineup(2), NOW), 'abierto');
  assert.equal(deriveStatus(base, lineup(4), NOW), 'completo');
  assert.equal(deriveStatus(played, lineup(4), NOW), 'falta_resultado');
  assert.equal(deriveStatus({ ...played, status: 'por_confirmar' }, lineup(4), NOW), 'por_confirmar');
  assert.equal(deriveStatus({ ...played, status: 'confirmado' }, lineup(4), { date: '2027-03-01', time: '10:00' }), 'confirmado');
  assert.equal(deriveStatus(played, lineup(4), { date: '2026-12-17', time: '10:00' }), 'vencido');
});

test('isExpired: vence pasados 30 días de la fecha', () => {
  assert.equal(isExpired(played, { date: '2026-12-16', time: '23:59' }), false);
  assert.equal(isExpired(played, { date: '2026-12-17', time: '00:00' }), true);
  assert.equal(isExpired({ ...played, status: 'cancelado' }, { date: '2027-01-01', time: '00:00' }), false);
});

test('parseLevel: categoría o rango de la misma rama', () => {
  assert.equal(parseLevel('c6'), 'C6');
  assert.equal(parseLevel('C5-C7'), 'C5-C7');
  assert.equal(parseLevel(''), null);
  for (const bad of ['C7-C5', 'C5-D7', 'C0', 'X5']) assert.throws(() => parseLevel(bad), bad);
});

test('parseResult: set único y mejor de 3', () => {
  assert.deepEqual(parseResult(1, [{ s1: 6, s2: 4 }]), { sets: [{ s1: 6, s2: 4 }], score1: 6, score2: 4 });
  assert.deepEqual(parseResult(3, [{ s1: 6, s2: 4 }, { s1: 3, s2: 6 }, { s1: 7, s2: 6 }]).score1, 2);
  assert.deepEqual(parseResult(3, [{ s1: 2, s2: 6 }, { s1: 3, s2: 6 }]), { sets: [{ s1: 2, s2: 6 }, { s1: 3, s2: 6 }], score1: 0, score2: 2 });
  assert.throws(() => parseResult(1, [{ s1: 6, s2: 6 }]), /empatado/);
  assert.throws(() => parseResult(1, [{ s1: 6, s2: 4 }, { s1: 6, s2: 4 }]), /un solo set/);
  assert.throws(() => parseResult(3, [{ s1: 6, s2: 4 }]), /2 sets/);
  assert.throws(() => parseResult(3, [{ s1: 6, s2: 4 }, { s1: 6, s2: 4 }, { s1: 6, s2: 4 }]), /definido/);
  assert.throws(() => parseResult(1, []), /resultado/);
  assert.throws(() => parseResult(1, [{ s1: -1, s2: 4 }]), /enteros/);
});

test('parseFriendlyInput: partido abierto', () => {
  const out = parseFriendlyInput({
    mode: 'abierto', club_id: 'c1', date: '2026-11-20', start_time: '18:30', visibility: 'link', level: 'c6',
    players: [{ team: 1, position: 2, username: '@Ana' }],
  }, NOW);
  assert.equal(out.match.start_time, '18:30');
  assert.equal(out.match.duration_minutes, 90);
  assert.equal(out.match.sets_format, 1);
  assert.deepEqual(out.slots, [{ team: 1, position: 2, username: 'ana' }]);
  assert.throws(() => parseFriendlyInput({ mode: 'abierto', club_id: 'c1', date: '2026-11-17', start_time: '19:00' }, NOW), /más adelante/);
  const full = [{ team: 1, position: 2, guest_name: 'A' }, { team: 2, position: 1, guest_name: 'B' }, { team: 2, position: 2, guest_name: 'C' }];
  assert.throws(() => parseFriendlyInput({ mode: 'abierto', club_id: 'c1', date: '2026-11-20', start_time: '19:00', players: full }, NOW), /lugar libre/);
});

test('parseFriendlyInput: partido jugado', () => {
  const players = [{ team: 1, position: 2, guest_name: ' Juan  Pérez ' }, { team: 2, position: 1, username: 'luz' }, { team: 2, position: 2, username: 'tomi' }];
  const out = parseFriendlyInput({ mode: 'jugado', club_id: 'c1', date: '2026-11-16', start_time: '18:00', sets_format: 3, players, sets: [{ s1: 6, s2: 3 }, { s1: 6, s2: 2 }] }, NOW);
  assert.equal(out.slots[0].guest_name, 'Juan Pérez');
  assert.deepEqual([out.result.score1, out.result.score2], [2, 0]);
  assert.throws(() => parseFriendlyInput({ mode: 'jugado', club_id: 'c1', date: '2026-11-20', start_time: '18:00', players }, NOW), /futura/);
  assert.throws(() => parseFriendlyInput({ mode: 'jugado', club_id: 'c1', date: '2026-10-01', start_time: '18:00', players, sets: [{ s1: 6, s2: 3 }] }, NOW), /30 días/);
  assert.throws(() => parseFriendlyInput({ mode: 'jugado', club_id: 'c1', date: '2026-11-16', start_time: '18:00', players: players.slice(1), sets: [{ s1: 6, s2: 3 }] }, NOW), /4 jugadores/);
});

test('parseFriendlyInput: lugares inválidos', () => {
  const body = (players) => ({ mode: 'abierto', club_id: 'c1', date: '2026-11-20', start_time: '18:00', players });
  assert.throws(() => parseFriendlyInput(body([{ team: 1, position: 1, username: 'x' }]), NOW), /creador/);
  assert.throws(() => parseFriendlyInput(body([{ team: 3, position: 1, username: 'x' }]), NOW), /equipo 1 o 2/);
  assert.throws(() => parseFriendlyInput(body([{ team: 2, position: 1, username: 'x' }, { team: 2, position: 2, username: 'X' }]), NOW), /dos lugares/);
  assert.throws(() => parseFriendlyInput(body([{ team: 2, position: 1, username: 'x', guest_name: 'y' }]), NOW), /no los dos/);
  assert.throws(() => parseFriendlyInput({ ...body([]), mode: 'otro' }, NOW), /modo/);
  assert.throws(() => parseFriendlyInput({ ...body([]), duration_minutes: 45 }, NOW), /pasos de 30/);
});

test('parseFriendlyPatch: solo campos presentes y fecha futura', () => {
  assert.deepEqual(parseFriendlyPatch({ court_label: ' Cancha 2 ' }, base, NOW), { court_label: 'Cancha 2' });
  assert.throws(() => parseFriendlyPatch({ date: '2026-11-17', start_time: '10:00' }, base, NOW), /futuras/);
});

test('proposalError: quién propone y cuándo', () => {
  const args = { match: played, players: lineup(4), pending: null, now: NOW };
  assert.equal(proposalError({ ...args, viewerId: 'u1' }), null);
  assert.match(proposalError({ ...args, viewerId: 'zz' }), /jugadores del partido/);
  assert.match(proposalError({ ...args, match: base, viewerId: 'u1' }), /no empezó/);
  assert.match(proposalError({ ...args, players: lineup(3), viewerId: 'u1' }), /Faltan jugadores/);
  const pending = { team: 1, status: 'pendiente' };
  assert.match(proposalError({ ...args, match: { ...played, status: 'por_confirmar' }, pending, viewerId: 'u2' }), /espera la respuesta/);
  assert.equal(proposalError({ ...args, match: { ...played, status: 'por_confirmar' }, pending, viewerId: 'u3' }), null);
  const sinCuentas = lineup(4).map((p) => (p.team === 2 ? { ...p, user_id: null, guest_name: 'X' } : p));
  assert.match(proposalError({ ...args, players: sinCuentas, viewerId: 'u1' }), /no tiene jugadores con cuenta/);
  assert.match(proposalError({ ...args, now: { date: '2026-12-20', time: '10:00' }, viewerId: 'u1' }), /venció/);
});

test('acceptError: solo el equipo rival aprueba', () => {
  const proposal = { team: 1, status: 'pendiente' };
  const args = { match: { ...played, status: 'por_confirmar' }, players: lineup(4), proposal, now: NOW };
  assert.equal(acceptError({ ...args, viewerId: 'u3' }), null);
  assert.match(acceptError({ ...args, viewerId: 'u2' }), /equipo rival/);
  assert.match(acceptError({ ...args, proposal: { ...proposal, status: 'rechazada' }, viewerId: 'u3' }), /vigente/);
});

test('joinError y leaveError', () => {
  const args = { match: base, players: lineup(2), now: NOW };
  assert.equal(joinError({ ...args, slotRef: { team: 2, position: 1 }, viewerId: 'u9' }), null);
  assert.match(joinError({ ...args, slotRef: { team: 1, position: 2 }, viewerId: 'u9' }), /ocupado/);
  assert.match(joinError({ ...args, slotRef: { team: 2, position: 1 }, viewerId: 'u2' }), /Ya estás/);
  assert.match(joinError({ ...args, match: played, slotRef: { team: 2, position: 1 }, viewerId: 'u9' }), /empezó/);
  assert.equal(leaveError({ ...args, viewerId: 'u2' }), null);
  assert.match(leaveError({ ...args, viewerId: 'u1' }), /creador/);
  assert.match(leaveError({ ...args, match: { ...played, status: 'confirmado' }, viewerId: 'u2' }), /cerrado/);
});

test('viewerActions y needsAction', () => {
  const pending = { team: 1, status: 'pendiente' };
  const match = { ...played, status: 'por_confirmar' };
  const rival = viewerActions({ match, players: lineup(4), pending, viewerId: 'u3', now: NOW });
  assert.equal(rival.can_accept, true);
  assert.equal(rival.can_propose, true);
  assert.equal(rival.needs_action, true);
  const own = viewerActions({ match, players: lineup(4), pending, viewerId: 'u1', now: NOW });
  assert.equal(own.can_accept, false);
  assert.equal(own.needs_action, false);
  assert.equal(own.is_creator, true);
  const stranger = viewerActions({ match: base, players: lineup(2), pending: null, viewerId: 'u9', now: NOW });
  assert.equal(stranger.can_join, true);
  assert.equal(needsAction({ status: 'falta_resultado', slot: { team: 2 }, pending: null }), true);
  assert.equal(needsAction({ status: 'falta_resultado', slot: null, pending: null }), false);
});
