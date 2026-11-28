import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityFrom, buildActivity } from '../src/lib/clubActivity.js';

test('activityFrom: primer día de hace 11 meses', () => {
  assert.equal(activityFrom('2026-11-28'), '2025-12-01');
  assert.equal(activityFrom('2026-01-05'), '2025-02-01');
});

test('buildActivity completa los meses vacíos y ordena los años', () => {
  const a = buildActivity([
    { serie: 'torneos', kind: 'm', key: '2026-03', n: 4 },
    { serie: 'jugadores', kind: 'm', key: '2026-03', n: 9 },
    { serie: 'torneos', kind: 'm', key: '2024-01', n: 9 },
    { serie: 'torneos', kind: 'y', key: '2026', n: 21 },
    { serie: 'torneos', kind: 'y', key: '2025', n: 1 },
    { serie: 'jugadores', kind: 'y', key: '2026', n: 12 },
    { serie: 'jugadores', kind: 'total', key: 'total', n: 12 },
  ], '2026-11-28');
  assert.equal(a.months.length, 12);
  assert.equal(a.months[0].key, '2025-12');
  assert.equal(a.months[11].key, '2026-11');
  assert.deepEqual(a.months[3], { key: '2026-03', torneos: 4, jugadores: 9 });
  assert.deepEqual(a.years, [{ key: '2025', torneos: 1, jugadores: 0 }, { key: '2026', torneos: 21, jugadores: 12 }]);
  assert.equal(a.jugadores_total, 12);
});
