// Reglas puras del perfil de usuario: validación de cada campo, visibilidad y cambio de username.

export const NAME_PART_MAX = 40;
export const USERNAME_COOLDOWN_DAYS = 90;
export const GENDERS = ['masculino', 'femenino', 'no_decir'];
export const DOC_TYPES = ['dni', 'pasaporte', 'otro'];
export const HANDS = ['diestro', 'zurdo', 'ambidiestro'];
export const SIDES = ['drive', 'reves', 'cualquiera'];
export const SOCIAL_NETWORKS = ['instagram', 'twitter', 'facebook'];
export const MAX_EMERGENCY_CONTACTS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;
const NAME_RE = /^[\p{L}][\p{L}\p{M}' -]*$/u;
const HANDLE_RE = {
  instagram: /^[A-Za-z0-9._]{1,30}$/,
  twitter: /^[A-Za-z0-9_]{1,15}$/,
  facebook: /^[A-Za-z0-9.]{5,50}$/,
};
const HANDLE_HOSTS = {
  instagram: /^(https?:\/\/)?(www\.|m\.)?instagram\.com\//i,
  twitter: /^(https?:\/\/)?(www\.|mobile\.)?(x|twitter)\.com\//i,
  facebook: /^(https?:\/\/)?(www\.|m\.|web\.)?(facebook|fb)\.com\//i,
};

export class ProfileError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const text = (v) => (v === null || v === undefined ? '' : String(v)).replace(/\s+/g, ' ').trim();
const blankToNull = (v) => (text(v) === '' ? null : text(v));

/** Nombre/s o apellido/s: obligatorio, 1 a 40, solo letras, espacios y guion. */
export function parseNamePart(value, label) {
  const v = text(value);
  if (!v) throw new ProfileError(`${label} no puede estar vacío`);
  if (v.length > NAME_PART_MAX) throw new ProfileError(`${label} tiene un límite de ${NAME_PART_MAX} caracteres`);
  if (!NAME_RE.test(v)) throw new ProfileError(`${label} solo puede tener letras, espacios y guiones`);
  return v;
}

/** "María Fernanda López" → primera palabra como nombre, el resto como apellido. */
export function splitLegacyName(full) {
  const v = text(full);
  const i = v.indexOf(' ');
  return i === -1 ? { first_name: v, last_name: '' } : { first_name: v.slice(0, i), last_name: v.slice(i + 1) };
}

/** Nombre y apellido que manda Google; sin given_name se parte el nombre completo. */
export function googleNames({ given_name, family_name, name } = {}) {
  const clip = (v) => text(v).slice(0, NAME_PART_MAX).trim();
  if (clip(given_name)) return { first_name: clip(given_name), last_name: clip(family_name) };
  const legacy = splitLegacyName(name);
  return { first_name: clip(legacy.first_name) || 'Jugador', last_name: clip(legacy.last_name) };
}

/** Acepta @usuario, usuario o la URL del perfil; devuelve el usuario sin @. */
export function parseHandle(network, value) {
  let v = text(value);
  if (!v) return null;
  v = v.replace(HANDLE_HOSTS[network], '').replace(/^@+/, '').replace(/[/?#].*$/, '');
  if (!HANDLE_RE[network].test(v)) throw new ProfileError(`El usuario de ${networkLabel(network)} no es válido`);
  return v;
}

function networkLabel(network) {
  return { instagram: 'Instagram', twitter: 'X', facebook: 'Facebook' }[network];
}

/** Sitio web: dominio o URL http(s); se guarda con https:// cuando no trae esquema. */
export function parseWebsite(value) {
  const v = text(value);
  if (!v) return null;
  const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  let url;
  try { url = new URL(withScheme); } catch { throw new ProfileError('El sitio web no es una dirección válida'); }
  if (!/\.[a-z]{2,}$/i.test(url.hostname) || withScheme.length > 200) throw new ProfileError('El sitio web no es una dirección válida');
  return withScheme;
}

/** WhatsApp con código de país: "+54 9 11 5555-0192" → "+5491155550192". */
export function parseWhatsapp(value) {
  const v = text(value);
  if (!v) return null;
  if (!/^\+?[\d\s().-]+$/.test(v)) throw new ProfileError('El WhatsApp solo puede tener números');
  const digits = v.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) throw new ProfileError('El WhatsApp debe tener entre 8 y 15 dígitos, con el código de país');
  return `+${digits}`;
}

/** Tipo y número de documento. El DNI se guarda sin puntos. */
export function parseDocument(type, number) {
  const t = blankToNull(type);
  const n = text(number).replace(/[.\s]/g, '');
  if (!t && !n) return { doc_type: null, doc_number: null };
  if (!t || !DOC_TYPES.includes(t)) throw new ProfileError('Elegí el tipo de documento: DNI, pasaporte u otro');
  if (!n) throw new ProfileError('Ingresá el número de documento');
  if (t === 'dni' && !/^\d{7,8}$/.test(n)) throw new ProfileError('El DNI debe tener 7 u 8 números');
  if (t !== 'dni' && !/^[A-Za-z0-9-]{3,20}$/.test(n)) throw new ProfileError('El número de documento no es válido');
  return { doc_type: t, doc_number: t === 'dni' ? n : n.toUpperCase() };
}

/** Fecha AAAA-MM-DD entre 5 y 100 años atrás. */
export function parseBirthDate(value, now = new Date()) {
  const v = text(value);
  if (!v) return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) throw new ProfileError('La fecha de nacimiento no es válida');
  const age = ageFrom(v, now);
  if (age < 5 || age > 100) throw new ProfileError('Revisá la fecha de nacimiento');
  return v;
}

/** Edad cumplida a la fecha `now`, con la fecha guardada como AAAA-MM-DD. */
export function ageFrom(birthDate, now = new Date()) {
  if (!birthDate) return null;
  const [y, mo, d] = String(birthDate).slice(0, 10).split('-').map(Number);
  let age = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < mo || (now.getUTCMonth() + 1 === mo && now.getUTCDate() < d)) age -= 1;
  return age;
}

/** Código de país ISO de dos letras. */
export function parseCountry(value, label = 'El país') {
  const v = text(value).toUpperCase();
  if (!v) return null;
  if (!/^[A-Z]{2}$/.test(v)) throw new ProfileError(`${label} no es válido`);
  return v;
}

function parseShort(value, max, label) {
  const v = text(value);
  if (!v) return null;
  if (v.length > max) throw new ProfileError(`${label} tiene un límite de ${max} caracteres`);
  return v;
}

/** Domicilio: cada campo es opcional; el CP argentino es de 4 dígitos o CPA. */
export function parseAddress(body, current = {}) {
  const out = {};
  const pick = (k) => (k in body ? body[k] : current[k]);
  if ('country' in body) out.country = parseCountry(body.country);
  if ('province' in body) out.province = parseShort(body.province, 80, 'La provincia');
  if ('locality' in body) out.locality = parseShort(body.locality, 80, 'La localidad');
  if ('street' in body) out.street = parseShort(body.street, 100, 'La calle');
  if ('street_number' in body) out.street_number = parseShort(body.street_number, 10, 'El número');
  if ('postal_code' in body) {
    const cp = parseShort(body.postal_code, 10, 'El código postal');
    const country = 'country' in out ? out.country : pick('country');
    const v = cp && cp.toUpperCase().replace(/\s/g, '');
    if (v && country === 'AR' && !/^(\d{4}|[A-Z]\d{4}[A-Z]{3})$/.test(v)) {
      throw new ProfileError('El código postal debe tener 4 números o el formato CPA (C1708ABC)');
    }
    out.postal_code = v;
  }
  return out;
}

/** Hasta dos contactos con nombre, vínculo y teléfono. */
export function parseEmergencyContacts(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) throw new ProfileError('Los contactos de emergencia deben ser una lista');
  const rows = value.filter((c) => text(c?.name) || text(c?.relation) || text(c?.phone));
  if (rows.length > MAX_EMERGENCY_CONTACTS) throw new ProfileError(`Podés cargar hasta ${MAX_EMERGENCY_CONTACTS} contactos de emergencia`);
  return rows.map((c, i) => {
    const n = i + 1;
    const name = parseShort(c.name, 60, `El nombre del contacto ${n}`);
    const relation = parseShort(c.relation, 30, `El vínculo del contacto ${n}`);
    const phoneText = text(c.phone);
    if (!name || !relation || !phoneText) throw new ProfileError(`Completá nombre, vínculo y teléfono del contacto ${n}`);
    const digits = phoneText.replace(/\D/g, '');
    if (!/^\+?[\d\s().-]+$/.test(phoneText) || digits.length < 6 || digits.length > 15) {
      throw new ProfileError(`El teléfono del contacto ${n} no es válido`);
    }
    return { name, relation, phone: phoneText };
  });
}

function parseEnum(value, allowed, message) {
  const v = blankToNull(value);
  if (v === null) return null;
  if (!allowed.includes(v)) throw new ProfileError(message);
  return v;
}

/** Campos del PATCH del perfil; solo toca las claves presentes (username, categoría y contraseña van en la ruta). */
export function parseProfileUpdate(body, current = {}, now = new Date()) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (has('first_name')) out.first_name = parseNamePart(body.first_name, 'El nombre');
  if (has('last_name')) out.last_name = parseNamePart(body.last_name, 'El apellido');
  if (has('nationality')) out.nationality = parseCountry(body.nationality, 'La nacionalidad');
  if (has('birth_date')) out.birth_date = parseBirthDate(body.birth_date, now);

  if (has('gender')) {
    const g = parseEnum(body.gender, GENDERS, 'Elegí un género de la lista');
    if (current.gender && g !== current.gender) {
      throw new ProfileError('El género no se puede cambiar. Para corregirlo, escribí a soporte', 409);
    }
    if (!current.gender) out.gender = g;
  }

  if (has('doc_type') || has('doc_number')) {
    Object.assign(out, parseDocument(
      has('doc_type') ? body.doc_type : current.doc_type,
      has('doc_number') ? body.doc_number : current.doc_number,
    ));
  }

  if (has('whatsapp')) out.whatsapp = parseWhatsapp(body.whatsapp);
  if (has('whatsapp_public')) {
    if (typeof body.whatsapp_public !== 'boolean') throw new ProfileError('whatsapp_public debe ser booleano');
    out.whatsapp_public = body.whatsapp_public;
  }

  for (const net of SOCIAL_NETWORKS) if (has(net)) out[net] = parseHandle(net, body[net]);
  if (has('website')) out.website = parseWebsite(body.website);

  if (has('hand')) out.hand = parseEnum(body.hand, HANDS, 'La mano hábil debe ser derecha, izquierda o ambidiestro');
  if (has('side')) out.side = parseEnum(body.side, SIDES, 'El lado debe ser drive, revés o cualquiera');

  Object.assign(out, parseAddress(body, current));
  if (has('emergency_contacts')) out.emergency_contacts = parseEmergencyContacts(body.emergency_contacts);

  return out;
}

/** ¿Puede cambiar el username ahora? El primer cambio está libre. */
export function usernameChangeStatus(changedAt, now = new Date()) {
  if (!changedAt) return { allowed: true, next_at: null };
  const next = new Date(new Date(changedAt).getTime() + USERNAME_COOLDOWN_DAYS * DAY_MS);
  return next <= now ? { allowed: true, next_at: null } : { allowed: false, next_at: next.toISOString() };
}

/** Datos del perfil que ve cualquiera. El WhatsApp público solo con sesión; nunca la fecha completa. */
export function publicProfileFields(row, { viewerId = null, isOwner = false, now = new Date() } = {}) {
  const showWhatsapp = Boolean(row.whatsapp) && (isOwner || (row.whatsapp_public === true && viewerId !== null));
  return {
    first_name: row.first_name,
    last_name: row.last_name,
    nationality: row.nationality ?? null,
    age: ageFrom(row.birth_date, now),
    hand: row.hand ?? null,
    side: row.side ?? null,
    socials: {
      instagram: row.instagram ?? null,
      twitter: row.twitter ?? null,
      facebook: row.facebook ?? null,
      website: row.website ?? null,
    },
    whatsapp: showWhatsapp ? row.whatsapp : null,
    whatsapp_public: isOwner ? row.whatsapp_public === true : undefined,
  };
}

/** Contactos de inscripción que salen del perfil del organizador: WhatsApp público e Instagram. */
export function profileContacts(owner) {
  const out = [];
  const wa = owner?.whatsapp ? String(owner.whatsapp).replace(/\D/g, '') : '';
  if (wa && owner.whatsapp_public !== false) out.push({ type: 'whatsapp', value: `+${wa}`, from_profile: true });
  const ig = owner?.instagram ? String(owner.instagram).trim().replace(/^@/, '') : '';
  if (ig) out.push({ type: 'instagram', value: `@${ig}`, from_profile: true });
  return out;
}
