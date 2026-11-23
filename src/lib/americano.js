// Americano: límites de parejas y cuadro final según cuántas parejas hay.
import { generateBracket, applyBracketWalkovers } from './tournamentLogic.js';
import { generateCupBracket } from './copa.js';

export const AMERICANO_MIN_PAIRS = 4;
export const AMERICANO_MAX_PAIRS = 32;

export const americanoPairsError = (n) => (n < AMERICANO_MIN_PAIRS || n > AMERICANO_MAX_PAIRS
  ? `El americano se juega con ${AMERICANO_MIN_PAIRS} a ${AMERICANO_MAX_PAIRS} parejas`
  : null);

/** Cuadro del americano: todas las parejas entran; las mejores de la previa pasan directo a la segunda ronda. */
export function generateAmericanoBracket(standings) {
  const n = standings.length;
  if (americanoPairsError(n)) throw new Error(americanoPairsError(n));
  if (n >= 8 && n <= 16) return generateBracket(standings);
  const { kind, ...cuadro } = generateCupBracket(standings);
  return applyBracketWalkovers({
    ...cuadro,
    standings,
    withdrawn_pair_ids: standings.filter((s) => s.withdrawn).map((s) => s.pair_id),
  });
}
