import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalScore, championCard } from '../src/lib/homeChampions.js';

test('finalScore: el marcador se lee desde la pareja campeona', () => {
  assert.equal(finalScore({ winner_id: 'a', pair1_id: 'a', pair2_id: 'b', score1: 6, score2: 4 }), '6-4');
  assert.equal(finalScore({ winner_id: 'b', pair1_id: 'a', pair2_id: 'b', score1: 5, score2: 6 }), '6-5');
});

test('finalScore: al mejor de tres muestra cada set', () => {
  const final = { winner_id: 'b', pair1_id: 'a', pair2_id: 'b', score1: 1, score2: 2, sets: [{ s1: 6, s2: 3 }, { s1: 4, s2: 6 }, { s1: 5, s2: 7 }] };
  assert.equal(finalScore(final), '3-6 6-4 7-5');
});

test('finalScore: sin ganador o con empate no hay marcador', () => {
  assert.equal(finalScore(null), null);
  assert.equal(finalScore({ pair1_id: 'a', score1: 6, score2: 4 }), null);
  assert.equal(finalScore({ winner_id: 'a', pair1_id: 'a', score1: 3, score2: 3 }), null);
});

test('championCard: arma la pareja, la portada y el organizador', () => {
  const card = championCard({
    id: 't1', name: 'Americano', format: 'americano', level: 'C7', played_on: new Date('2026-11-22T00:00:00Z'),
    group_id: 'g1', group_name: 'C7 Sábados', club_name: 'Genesis', cover_url: 'https://x/upload/c.jpg',
    owner_name: 'Diego F', owner_username: 'diego',
    p1_name: 'Lucas', p1_avatar: 'https://x/a.jpg', p1_username: 'lucas', p2_name: 'Tomás', p2_avatar: null, p2_username: null,
    final: { winner_id: 'p', pair1_id: 'p', score1: 6, score2: 4 },
  });
  assert.equal(card.date, '2026-11-22');
  assert.equal(card.score, '6-4');
  assert.deepEqual(card.organizer, { name: 'Diego F', username: 'diego' });
  assert.deepEqual(card.players[1], { name: 'Tomás', avatar_url: null, username: null });
});
