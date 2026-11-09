import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInstagramUrl, instagramEmbedUrl } from '../src/lib/instagram.js';

test('instagram: acepta posts, reels y links con parámetros', () => {
  assert.deepEqual(parseInstagramUrl('https://www.instagram.com/p/C9xYz12AbCd/'), { kind: 'p', shortcode: 'C9xYz12AbCd', url: 'https://www.instagram.com/p/C9xYz12AbCd/' });
  assert.equal(parseInstagramUrl('instagram.com/p/ABCDE'.replace(/^/, 'https://')).shortcode, 'ABCDE');
  assert.equal(parseInstagramUrl('https://instagram.com/reel/DAbc_-12/?igsh=xyz').kind, 'reel');
  assert.equal(parseInstagramUrl('https://www.instagram.com/reels/DAbc_-12').kind, 'reel');
  assert.equal(parseInstagramUrl('https://www.instagram.com/padeleando/p/XYZ123ab/').shortcode, 'XYZ123ab');
  assert.equal(parseInstagramUrl('  https://www.instagram.com/tv/QWERTY1/  ').kind, 'tv');
});

test('instagram: rechaza lo que no es un post', () => {
  for (const bad of ['', 'hola', 'https://www.instagram.com/padeleando/', 'https://www.instagram.com/stories/x/123/',
    'https://evil.com/p/ABCDE/', 'https://www.instagram.com.evil.com/p/ABCDE/', 'javascript:alert(1)']) {
    assert.throws(() => parseInstagramUrl(bad), /link de un post/);
  }
});

test('instagram: url del iframe', () => {
  assert.equal(instagramEmbedUrl({ kind: 'p', shortcode: 'ABCDE' }), 'https://www.instagram.com/p/ABCDE/embed');
});
