import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAgendaRange, buildAgenda, addDays } from '../src/lib/agenda.js';

test('addDays cruza meses y años', () => {
  assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('parseAgendaRange: por defecto 14 días desde hoy', () => {
  assert.deepEqual(parseAgendaRange({}, '2026-11-23'), { from: '2026-11-23', to: '2026-12-06' });
});

test('parseAgendaRange: recorta a 62 días y corrige un to anterior', () => {
  assert.deepEqual(parseAgendaRange({ from: '2026-11-01', to: '2027-06-01' }, '2026-11-23'), { from: '2026-11-01', to: '2027-01-01' });
  assert.deepEqual(parseAgendaRange({ from: '2026-11-10', to: '2026-11-01' }, '2026-11-23'), { from: '2026-11-10', to: '2026-11-10' });
  assert.deepEqual(parseAgendaRange({ from: 'mañana' }, '2026-11-23').from, '2026-11-23');
});

const T = { tournament_id: 't1', tournament_name: 'Liga Martes', format: 'liga', group_id: 'g1', group_name: 'Martes C6', club_name: 'Club Norte' };

test('buildAgenda: rivales del programado según el equipo propio', () => {
  const [a, b] = buildAgenda({
    scheduled: [
      { ...T, id: 's1', day: '2026-11-24', time: '20:00', court: 3, mine_is_team1: true, n1: 'Yo', n2: 'Vos', n3: 'Sosa', n4: 'Ríos' },
      { ...T, id: 's2', day: '2026-11-25', time: null, court: null, mine_is_team1: false, n1: 'Gil', n2: 'Paz', n3: 'Yo', n4: 'Vos' },
    ], from: '2026-11-23', to: '2026-12-06',
  });
  assert.equal(a.rivals, 'Sosa / Ríos');
  assert.equal(a.href, '/cat/g1/torneo/t1');
  assert.equal(b.rivals, 'Gil / Paz');
});

test('buildAgenda: cuadro con programado, sin ganador y con pareja propia', () => {
  const bracket = {
    semis: [
      { id: 's0', pair1_id: 'pA', pair2_id: 'pB', programado: { date: '2026-11-28', time: '10:00', court: 1 } },
      { id: 's1', pair1_id: 'pC', pair2_id: 'pD', programado: { date: '2026-11-28', time: '11:00' } },
    ],
    final: { id: 'f0', pair1_id: 'pA', pair2_id: 'pC', winner_id: 'pA', programado: { date: '2026-11-28' } },
  };
  const items = buildAgenda({
    brackets: [{ id: 't2', name: 'Americano', format: 'americano', group_id: 'g2', group_name: 'Sábados', bracket,
      pairs: [{ id: 'pA', mine: true, name: 'Yo / Vos' }, { id: 'pB', mine: false, name: 'Gil / Paz' }, { id: 'pC', mine: false }, { id: 'pD', mine: false }] }],
    from: '2026-11-23', to: '2026-12-06',
  });
  assert.equal(items.length, 1);
  assert.equal(items[0].rivals, 'Gil / Paz');
  assert.equal(items[0].round, 'semis');
});

test('buildAgenda: el torneo inscripto no se repite si ya hay partido ese día, y ordena por fecha y hora', () => {
  const items = buildAgenda({
    scheduled: [{ ...T, id: 's1', day: '2026-11-24', time: '20:00', mine_is_team1: true, n3: 'A', n4: 'B' }],
    tournaments: [
      { id: 't1', name: 'Liga Martes', format: 'liga', group_id: 'g1', day: '2026-11-24', time: '19:00' },
      { id: 't3', name: 'Copa', format: 'copa', group_id: 'g3', day: '2026-11-23', time: null },
    ],
    friendlies: [{ id: 'f1', day: '2026-11-24', time: '18:00', club_name: 'Sur', filled: 3 }],
    from: '2026-11-23', to: '2026-12-06',
  });
  assert.deepEqual(items.map((i) => i.id), ['t:t3', 'fm:f1', 'sm:s1']);
  assert.equal(items[1].status, 'abierto');
  assert.equal(items[1].missing, 1);
});
