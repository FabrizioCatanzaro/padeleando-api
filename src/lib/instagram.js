// Posts de Instagram en la galería de un torneo (2026-11-09).
// El organizador pega el link de un post público; la app lo muestra embebido
// con el iframe /embed de Instagram. No se guardan ni se copian las fotos.

export const MAX_INSTAGRAM_POSTS = 6;

const RE = /^https?:\/\/(?:www\.)?instagram\.com\/(?:[A-Za-z0-9._]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,40})\/?(?:[?#].*)?$/i;

/**
 * Valida y normaliza el link de un post de Instagram.
 * Acepta /p/, /reel/, /reels/ y /tv/, con o sin www, con o sin el usuario
 * delante y con parámetros (?igsh=…), que se descartan.
 * @returns {{ kind: 'p'|'reel'|'tv', shortcode: string, url: string }}
 * @throws {Error} con el mensaje para el usuario
 */
export function parseInstagramUrl(raw) {
  const s = String(raw ?? '').trim();
  const m = RE.exec(s);
  if (!m) throw new Error('Pegá el link de un post de Instagram, por ejemplo https://www.instagram.com/p/ABC123/');
  const kind = m[1].toLowerCase() === 'reels' ? 'reel' : m[1].toLowerCase();
  const shortcode = m[2];
  return { kind, shortcode, url: `https://www.instagram.com/${kind}/${shortcode}/` };
}

/** URL del iframe que muestra el post (sin la leyenda, más compacto). */
export const instagramEmbedUrl = ({ kind, shortcode }) =>
  `https://www.instagram.com/${kind}/${shortcode}/embed`;
