// Subconjunto de Markdown para los mensajes de admin (broadcasts):
//   **negrita**   *itálica*  _itálica_   [texto](url)   y saltos de línea.
// Pensado para renderizar de forma idéntica en la app (campana de notificaciones)
// y en los emails. El mismo texto plano se guarda en la base, así que los mensajes
// viejos sin formato siguen funcionando tal cual.

// Escapa entidades HTML para evitar inyección al construir el HTML del email.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Solo permitimos enlaces http(s) y mailto (nada de javascript:, data:, etc.).
export function safeHref(url) {
  return /^(https?:\/\/|mailto:)/i.test(url) ? url : null;
}

// Reemplaza el placeholder {nombre} por el nombre del destinatario. Se aplica por
// usuario, antes de renderizar/guardar, para que cada uno reciba su propio nombre.
export function personalize(text, user = {}) {
  const name = (user?.name || '').trim() || 'jugador';
  return String(text ?? '').replace(/\{nombre\}/gi, name);
}

// Un solo pase reconoce los cuatro patrones. El orden importa: **negrita** antes
// que *itálica* para que `**` no se coma como dos itálicas.
const INLINE_RE =
  /(\*\*([^*]+?)\*\*)|(\*([^*]+?)\*)|(_([^_]+?)_)|(\[([^\]]+?)\]\(([^)\s]+?)\))/g;

// Tokeniza una línea en nodos inline planos (sin anidar). Devuelve
// { type: 'text' | 'bold' | 'italic' | 'link', value, href? }.
export function parseInline(text) {
  const tokens = [];
  let last = 0;
  let m;
  INLINE_RE.lastIndex = 0;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', value: text.slice(last, m.index) });
    if (m[2] != null)      tokens.push({ type: 'bold',   value: m[2] });
    else if (m[4] != null) tokens.push({ type: 'italic', value: m[4] });
    else if (m[6] != null) tokens.push({ type: 'italic', value: m[6] });
    else if (m[8] != null) {
      const href = safeHref(m[9]);
      tokens.push(href ? { type: 'link', value: m[8], href } : { type: 'text', value: m[0] });
    }
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) tokens.push({ type: 'text', value: text.slice(last) });
  return tokens;
}

// Renderiza el markdown a HTML con estilos inline, apto para emails.
export function mdToHtml(md, { linkColor = '#0f766e' } = {}) {
  return String(md ?? '')
    .split('\n')
    .map((line) =>
      parseInline(line)
        .map((tok) => {
          switch (tok.type) {
            case 'bold':
              return `<strong>${escapeHtml(tok.value)}</strong>`;
            case 'italic':
              return `<em>${escapeHtml(tok.value)}</em>`;
            case 'link':
              return `<a href="${escapeHtml(tok.href)}" style="color:${linkColor};text-decoration:underline" target="_blank" rel="noopener noreferrer">${escapeHtml(tok.value)}</a>`;
            default:
              return escapeHtml(tok.value);
          }
        })
        .join(''),
    )
    .join('<br />');
}
