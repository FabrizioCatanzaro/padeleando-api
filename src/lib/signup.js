// Precio y contactos de inscripción. Los mismos cuatro campos viven en groups y
// en tournaments: la jornada hereda de la categoría el que tenga en NULL.

export const CONTACT_TYPES = ['whatsapp', 'phone', 'email', 'instagram'];

const MAX_CONTACTS = 4;
const MAX_VALUE    = 80;
const MAX_PRICE    = 100_000_000;

class SignupError extends Error {}

// Devuelve sólo las claves presentes en el body, para no pisar con NULL lo que
// el cliente no mandó. `undefined` = no tocar; `null` = volver a heredar.
export function parseSignupFields(body) {
  const out = {};

  if ('signup_open' in body) {
    const v = body.signup_open;
    if (v !== null && typeof v !== 'boolean') throw new SignupError('signup_open debe ser booleano o null');
    out.signup_open = v;
  }

  if ('signup_price' in body) {
    const v = body.signup_price;
    if (v === null || v === '') out.signup_price = null;
    else {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw new SignupError('El precio debe ser un número entero mayor o igual a 0');
      if (n > MAX_PRICE) throw new SignupError('El precio es demasiado alto');
      out.signup_price = n;
    }
  }

  if ('signup_price_unit' in body) {
    const v = body.signup_price_unit;
    if (v === null || v === '') out.signup_price_unit = null;
    else if (v !== 'player' && v !== 'pair') throw new SignupError('signup_price_unit debe ser "player" o "pair"');
    else out.signup_price_unit = v;
  }

  if ('signup_contacts' in body) {
    const v = body.signup_contacts;
    if (v === null) out.signup_contacts = null;
    else {
      if (!Array.isArray(v)) throw new SignupError('signup_contacts debe ser una lista');
      if (v.length > MAX_CONTACTS) throw new SignupError(`No se pueden cargar más de ${MAX_CONTACTS} contactos`);
      const clean = v.map((c) => {
        const type  = String(c?.type ?? '').trim();
        const value = String(c?.value ?? '').trim();
        if (!CONTACT_TYPES.includes(type)) throw new SignupError(`Tipo de contacto inválido: ${type}`);
        if (!value) throw new SignupError('Un contacto no puede quedar vacío');
        if (value.length > MAX_VALUE) throw new SignupError('El contacto es demasiado largo');
        if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new SignupError('El mail no es válido');
        if ((type === 'whatsapp' || type === 'phone') && !/^[+\d][\d\s()-]{5,}$/.test(value)) {
          throw new SignupError('El teléfono no es válido');
        }
        return { type, value };
      });
      // Un solo contacto por canal: dos WhatsApp distintos no aportan nada.
      const seen = new Set();
      for (const c of clean) {
        if (seen.has(c.type)) throw new SignupError('Hay dos contactos del mismo tipo');
        seen.add(c.type);
      }
      out.signup_contacts = clean.length ? clean : null;
    }
  }

  return out;
}

// Valor efectivo de la jornada: lo suyo, o lo de la categoría.
export function resolveSignup(tournament, group) {
  const pick = (k) => (tournament?.[k] ?? group?.[k] ?? null);
  return {
    open:     pick('signup_open') ?? false,
    price:    pick('signup_price'),
    unit:     pick('signup_price_unit') ?? 'player',
    contacts: pick('signup_contacts') ?? [],
  };
}

export { SignupError };
