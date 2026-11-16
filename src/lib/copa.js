// Copa: grupos (zonas) + playoffs, o cuadro directo. Lógica pura, sin base.
// En la API y la base el grupo se llama zona; `groups` ya es la categoría.

export const COPA_MODES      = ['zonas', 'cuadro'];
export const COPA_MAX_PAIRS  = 32;
export const ZONAS_MIN       = 2;
export const ZONAS_MAX       = 8;
export const ZONA_MIN_PAIRS  = 3;
export const ZONA_MAX_PAIRS  = 6;
export const MAX_PRIZES      = 12;
export const MAX_PRIZE_PLACE = 4;
export const MAX_PRIZE_TITLE = 60;
export const MAX_PRIZE_TEXT  = 200;

const isBool = (v) => typeof v === 'boolean';
const intIn = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

/** Opciones por defecto de cada variante. */
export function defaultCopaConfig(mode) {
  return mode === 'cuadro'
    ? { mode, tercer_puesto: false }
    : { mode: 'zonas', zonas: 2, ruedas: 1, clasifican: 2, mejores_extra: 0, plata: false, tercer_puesto: false };
}

/** Parejas que pasan a playoffs según la configuración. */
export const totalClasificados = (c) => c.zonas * c.clasifican + c.mejores_extra;

// Valida copa_config del alta o de una edición; `current` es lo guardado. Lanza Error con el mensaje.
export function parseCopaSettings(input, { current = null } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Las opciones de la copa no son válidas');
  }
  const mode = input.mode ?? current?.mode;
  if (!COPA_MODES.includes(mode)) throw new Error('Elegí si la copa se juega con grupos o es de cuadro');
  if (current && current.mode !== mode) throw new Error('El tipo de copa no se puede cambiar');

  const c = { ...defaultCopaConfig(mode), ...(current ?? {}) };
  const keys = Object.keys(defaultCopaConfig(mode)).filter((k) => k !== 'mode');
  for (const k of keys) if (input[k] !== undefined) c[k] = input[k];
  const out = { mode };
  for (const k of keys) out[k] = c[k];

  if (!isBool(out.tercer_puesto)) throw new Error('Indicá si se juega el tercer puesto');
  if (mode === 'cuadro') return out;

  if (!intIn(out.zonas, ZONAS_MIN, ZONAS_MAX)) throw new Error(`La copa tiene de ${ZONAS_MIN} a ${ZONAS_MAX} grupos`);
  if (out.ruedas !== 1 && out.ruedas !== 2) throw new Error('Los grupos se juegan a una o a dos ruedas');
  if (!intIn(out.clasifican, 1, ZONA_MAX_PAIRS - 1)) {
    throw new Error(`De cada grupo pasan de 1 a ${ZONA_MAX_PAIRS - 1} parejas`);
  }
  if (!intIn(out.mejores_extra, 0, out.zonas - 1)) {
    throw new Error('Los mejores siguientes tienen que ser menos que los grupos');
  }
  if (out.mejores_extra > 0 && out.clasifican >= ZONA_MAX_PAIRS - 1) {
    throw new Error('Con esa cantidad por grupo no quedan parejas para los mejores siguientes');
  }
  if (!isBool(out.plata)) throw new Error('Indicá si hay copa de plata');
  const total = totalClasificados(out);
  if (total < 2 || total > COPA_MAX_PAIRS) throw new Error(`A playoffs pasan de 2 a ${COPA_MAX_PAIRS} parejas`);
  return out;
}

// Valida la lista de premios. El primer puesto de la copa principal es obligatorio.
export function parsePrizes(input, { plata = false } = {}) {
  if (!Array.isArray(input)) throw new Error('Los premios no son válidos');
  if (input.length > MAX_PRIZES) throw new Error(`Hasta ${MAX_PRIZES} premios`);
  const seen = new Set();
  const out = input.map((p, i) => {
    const kind = p?.kind;
    const cup = p?.cup ?? 'oro';
    if (kind !== 'puesto' && kind !== 'especial') throw new Error('Cada premio es por puesto o especial');
    if (cup !== 'oro' && cup !== 'plata') throw new Error('El premio es de la copa principal o de la copa de plata');
    if (cup === 'plata' && !plata) throw new Error('Este torneo no tiene copa de plata');
    const description = String(p.description ?? '').trim();
    if (!description) throw new Error('Escribí en qué consiste el premio');
    if (description.length > MAX_PRIZE_TEXT) throw new Error(`El premio no puede superar los ${MAX_PRIZE_TEXT} caracteres`);
    if (kind === 'puesto') {
      if (!intIn(p.place, 1, MAX_PRIZE_PLACE)) throw new Error(`Los premios por puesto van del 1° al ${MAX_PRIZE_PLACE}°`);
      const k = `${cup}|${p.place}`;
      if (seen.has(k)) throw new Error('Hay dos premios para el mismo puesto');
      seen.add(k);
      return { kind, cup, place: p.place, title: null, description, position: i };
    }
    const title = String(p.title ?? '').trim();
    if (!title) throw new Error('Poné un nombre al premio especial');
    if (title.length > MAX_PRIZE_TITLE) throw new Error(`El nombre del premio no puede superar los ${MAX_PRIZE_TITLE} caracteres`);
    return { kind, cup, place: null, title, description, position: i };
  });
  if (!seen.has('oro|1')) throw new Error('El premio del primer puesto es obligatorio');
  return out;
}
