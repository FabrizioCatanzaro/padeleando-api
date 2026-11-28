export const CLUB_AMENITIES = [
  'estacionamiento', 'bano_adaptado', 'duchas', 'vestuarios', 'lockers', 'wifi', 'buffet', 'tienda',
  'alquiler_paletas', 'clases', 'grabacion', 'parrilla', 'pileta', 'gimnasio', 'seguridad', 'espacio_chicos',
];
export const COURT_WALL_TYPES = ['cemento', 'cristal', 'cristal_panoramico'];

const MAX_AMENITIES_OTHER = 160;
const MAX_EMAIL = 120;
const MAX_COURT_DESCRIPTION = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

const has = (body, key) => Object.prototype.hasOwnProperty.call(body ?? {}, key);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

// Solo devuelve las claves presentes en el body: una ausente no se toca
export function parseClubExtras(body = {}) {
  const out = {};
  if (has(body, 'amenities')) {
    if (!Array.isArray(body.amenities)) return { error: 'Servicios inválidos' };
    out.amenities = CLUB_AMENITIES.filter((k) => body.amenities.includes(k));
  }
  if (has(body, 'amenities_other')) {
    const v = text(body.amenities_other);
    if (v && v.length > MAX_AMENITIES_OTHER) return { error: `Otros servicios admite hasta ${MAX_AMENITIES_OTHER} caracteres` };
    out.amenities_other = v;
  }
  if (has(body, 'contact_email')) {
    const v = text(body.contact_email)?.toLowerCase() ?? null;
    if (v && (v.length > MAX_EMAIL || !EMAIL_RE.test(v))) return { error: 'El email no es válido' };
    out.contact_email = v;
  }
  return { fields: out };
}

export function parseCourtExtras(body = {}) {
  const color = text(body.floor_color);
  if (color && !COLOR_RE.test(color)) return { error: 'El color del piso no es válido' };
  const description = text(body.description);
  if (description && description.length > MAX_COURT_DESCRIPTION) {
    return { error: `La descripción admite hasta ${MAX_COURT_DESCRIPTION} caracteres` };
  }
  return { fields: { floor_color: color ? color.toLowerCase() : null, description } };
}
