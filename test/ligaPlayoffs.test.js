// Tests del cuadro de playoffs de la liga (generatePlayoffBracket).
// Correr con: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePlayoffBracket, applyBracketResult, clearBracketResult } from '../src/lib/tournamentLogic.js';

const tabla = (n) => Array.from({ length: n }, (_, i) => ({ pair_id: `p${i + 1}`, pair_name: `P${i + 1}`, seed: i + 1 }));
const partidos = (b) => [...b.octavos, ...b.cuartos, ...b.semis, b.final];
const listos = (b) => partidos(b).filter((m) => m.winner_id == null && m.pair1_id && m.pair2_id);

// Juega todo el cuadro con un criterio de ganador; devuelve el cuadro final.
function jugar(b, ganaPareja2 = () => false) {
  for (let i = 0; i < 40 && !b.final.winner_id; i++) {
    const [m] = listos(b);
    assert.ok(m, 'el cuadro no se traba');
    b = ganaPareja2(m) ? applyBracketResult(b, m.id, 3, 6) : applyBracketResult(b, m.id, 6, 3);
  }
  return b;
}

for (let n = 2; n <= 16; n++) {
  test(`playoffs de ${n} parejas: n-1 partidos y gana el primero si ganan los favoritos`, () => {
    const b = jugar(generatePlayoffBracket(tabla(n)));
    assert.equal(b.kind, 'playoffs');
    assert.equal(partidos(b).filter((m) => m.winner_id).length, n - 1);
    assert.equal(b.final.winner_id, 'p1');
  });
}

test('con 6 parejas pasan directo 1 y 2, y se cruzan 3-6 y 4-5', () => {
  const b = generatePlayoffBracket(tabla(6));
  assert.deepEqual(b.cuartos.map((m) => [m.pair1_id, m.pair2_id]), [['p3', 'p6'], ['p4', 'p5']]);
  assert.deepEqual([b.semis[0].pair1_id, b.semis[0].source2], ['p1', 'c1']);
  assert.deepEqual([b.semis[1].pair1_id, b.semis[1].source2], ['p2', 'c0']);
});

test('con 3 parejas el primero espera en la final al ganador de 2 contra 3', () => {
  const b = generatePlayoffBracket(tabla(3));
  assert.deepEqual([b.semis[0].pair1_id, b.semis[0].pair2_id], ['p2', 'p3']);
  assert.deepEqual([b.final.pair1_id, b.final.source2], ['p1', 's0']);
});

test('una sorpresa avanza y deshacer el resultado vacía la ronda siguiente', () => {
  let b = generatePlayoffBracket(tabla(5));
  b = applyBracketResult(b, 'c0', 3, 6);
  assert.equal(b.semis[0].pair2_id, 'p5');
  b = applyBracketResult(b, 's0', 3, 6);
  assert.equal(b.final.pair1_id, 'p5');
  b = clearBracketResult(b, 'c0');
  assert.equal(b.semis[0].pair2_id, null);
  assert.equal(b.semis[0].winner_id, null);
  assert.equal(b.final.pair1_id, null);
  const campeon = jugar(b, (m) => m.pair2_id === 'p5').final.winner_id;
  assert.equal(campeon, 'p5');
});

test('fuera de 2 a 16 parejas, error', () => {
  assert.throws(() => generatePlayoffBracket(tabla(1)), /2 a 16/);
  assert.throws(() => generatePlayoffBracket(tabla(17)), /2 a 16/);
});
