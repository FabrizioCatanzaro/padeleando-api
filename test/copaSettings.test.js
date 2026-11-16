import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCopaSettings, parsePrizes, defaultCopaConfig, totalClasificados, copaConfigLockError, parseWhatsapp, datosVisibles,
} from '../src/lib/copa.js';
import { quotaMessage } from '../src/lib/plan.js';
import { capacityInPlayers } from '../src/lib/registrations.js';

const zonas = (extra = {}) => ({ mode: 'zonas', zonas: 4, ruedas: 1, clasifican: 2, mejores_extra: 0, plata: false, tercer_puesto: false, ...extra });

test('copa con grupos: completa los valores por defecto', () => {
  assert.deepEqual(parseCopaSettings({ mode: 'zonas' }), defaultCopaConfig('zonas'));
});

test('copa de cuadro: solo guarda el tercer puesto', () => {
  assert.deepEqual(parseCopaSettings({ mode: 'cuadro', zonas: 4, plata: true, tercer_puesto: true }), { mode: 'cuadro', tercer_puesto: true });
});

test('el tipo de copa es obligatorio y no cambia', () => {
  assert.throws(() => parseCopaSettings({}), /con grupos o es de cuadro/);
  assert.throws(() => parseCopaSettings({ mode: 'liga' }), /con grupos o es de cuadro/);
  assert.throws(() => parseCopaSettings({ mode: 'cuadro' }, { current: zonas() }), /no se puede cambiar/);
});

test('edición parcial: conserva lo guardado', () => {
  const out = parseCopaSettings({ plata: true }, { current: zonas({ mejores_extra: 2 }) });
  assert.deepEqual(out, zonas({ mejores_extra: 2, plata: true }));
});

test('límites de grupos, ruedas y clasificados', () => {
  assert.throws(() => parseCopaSettings(zonas({ zonas: 1 })), /de 2 a 8 grupos/);
  assert.throws(() => parseCopaSettings(zonas({ zonas: 9 })), /de 2 a 8 grupos/);
  assert.throws(() => parseCopaSettings(zonas({ ruedas: 3 })), /una o a dos ruedas/);
  assert.throws(() => parseCopaSettings(zonas({ clasifican: 0 })), /pasan de 1 a 5/);
  assert.throws(() => parseCopaSettings(zonas({ clasifican: 6 })), /pasan de 1 a 5/);
  assert.throws(() => parseCopaSettings(zonas({ clasifican: 2.5 })), /pasan de 1 a 5/);
});

test('mejores siguientes: menos que los grupos y con parejas disponibles', () => {
  assert.equal(totalClasificados(parseCopaSettings(zonas({ mejores_extra: 3 }))), 11);
  assert.throws(() => parseCopaSettings(zonas({ mejores_extra: 4 })), /menos que los grupos/);
  assert.throws(() => parseCopaSettings(zonas({ mejores_extra: -1 })), /menos que los grupos/);
  assert.throws(() => parseCopaSettings(zonas({ clasifican: 5, mejores_extra: 1 })), /no quedan parejas/);
});

test('a playoffs pasan de 2 a 32 parejas', () => {
  assert.equal(totalClasificados(parseCopaSettings(zonas({ zonas: 8, clasifican: 4 }))), 32);
  assert.throws(() => parseCopaSettings(zonas({ zonas: 8, clasifican: 5 })), /de 2 a 32 parejas/);
  assert.equal(totalClasificados(parseCopaSettings(zonas({ zonas: 2, clasifican: 1 }))), 2);
});

test('las opciones booleanas no aceptan otro tipo', () => {
  assert.throws(() => parseCopaSettings(zonas({ plata: 'si' })), /copa de plata/);
  assert.throws(() => parseCopaSettings(zonas({ tercer_puesto: 1 })), /tercer puesto/);
  assert.throws(() => parseCopaSettings(null), /no son válidas/);
  assert.throws(() => parseCopaSettings([]), /no son válidas/);
});

const primero = { kind: 'puesto', place: 1, description: ' Paletas ' };

test('premios: normaliza y numera la posición', () => {
  const out = parsePrizes([primero, { kind: 'especial', title: ' MVP ', description: 'Remera' }]);
  assert.deepEqual(out, [
    { kind: 'puesto', cup: 'oro', place: 1, title: null, description: 'Paletas', position: 0 },
    { kind: 'especial', cup: 'oro', place: null, title: 'MVP', description: 'Remera', position: 1 },
  ]);
});

test('premios: el primer puesto es obligatorio', () => {
  assert.throws(() => parsePrizes([]), /primer puesto es obligatorio/);
  assert.throws(() => parsePrizes([{ kind: 'puesto', place: 2, description: 'x' }]), /primer puesto es obligatorio/);
  assert.throws(() => parsePrizes([{ kind: 'puesto', cup: 'plata', place: 1, description: 'x' }], { plata: true }), /primer puesto es obligatorio/);
});

test('premios: rechaza datos inválidos', () => {
  assert.throws(() => parsePrizes('x'), /no son válidos/);
  assert.throws(() => parsePrizes([primero, primero]), /mismo puesto/);
  assert.throws(() => parsePrizes([primero, { kind: 'puesto', place: 5, description: 'x' }]), /del 1° al 4°/);
  assert.throws(() => parsePrizes([primero, { kind: 'especial', description: 'x' }]), /nombre al premio/);
  assert.throws(() => parsePrizes([primero, { kind: 'especial', title: 'MVP', description: '  ' }]), /en qué consiste/);
  assert.throws(() => parsePrizes([primero, { kind: 'otro', description: 'x' }]), /por puesto o especial/);
  assert.throws(() => parsePrizes([primero, { kind: 'puesto', cup: 'plata', place: 1, description: 'x' }]), /no tiene copa de plata/);
  assert.throws(() => parsePrizes(Array.from({ length: 13 }, () => primero)), /Hasta 12 premios/);
});

test('premios: la copa de plata tiene su propio primer puesto', () => {
  const out = parsePrizes([primero, { kind: 'puesto', cup: 'plata', place: 1, description: 'Grips' }], { plata: true });
  assert.equal(out[1].cup, 'plata');
});

test('edición: qué se bloquea con el sorteo, las fechas y el cuadro', () => {
  const cur = zonas();
  assert.equal(copaConfigLockError(cur, zonas({ zonas: 3 })), null);
  assert.match(copaConfigLockError(cur, zonas({ zonas: 3 }), { sorteado: true }), /deshacé el sorteo/);
  assert.equal(copaConfigLockError(cur, zonas({ plata: true }), { sorteado: true, hasFechas: true }), null);
  assert.match(copaConfigLockError(cur, zonas({ ruedas: 2 }), { sorteado: true, hasFechas: true }), /ruedas no se cambian/);
  assert.match(copaConfigLockError(cur, zonas({ plata: true }), { hasBracket: true }), /cuadro ya está armado/);
  assert.equal(copaConfigLockError(cur, zonas(), { hasBracket: true }), null);
});

test('cupo: una copa por mes en cada categoría en el plan Básico', () => {
  assert.equal(quotaMessage({ premium: false, count: 0, copas: 0, format: 'copa' }), null);
  assert.match(quotaMessage({ premium: false, count: 1, copas: 1, format: 'copa' }), /1 copa por mes/);
  assert.equal(quotaMessage({ premium: false, count: 1, copas: 1, format: 'liga' }), null);
  assert.match(quotaMessage({ premium: false, count: 2, copas: 0, format: 'copa' }), /2 torneos por mes/);
  assert.match(quotaMessage({ premium: false, count: 2, copas: 1, format: 'americano' }), /2 torneos por mes/);
  assert.equal(quotaMessage({ premium: true, count: 9, copas: 4, format: 'copa' }), null);
});

test('cupo de inscripción: la copa no pasa de 32 parejas', () => {
  assert.equal(capacityInPlayers({ capacity: null, unit: null, format: 'copa' }), 64);
  assert.equal(capacityInPlayers({ capacity: 40, unit: 'pair', format: 'copa' }), 64);
  assert.equal(capacityInPlayers({ capacity: 12, unit: 'pair', format: 'copa' }), 24);
  assert.equal(capacityInPlayers({ capacity: null, unit: null, format: 'liga' }), null);
});

test('WhatsApp: vacío es null y se valida el formato', () => {
  assert.equal(parseWhatsapp('  '), null);
  assert.equal(parseWhatsapp(' +54 11 5555-1234 '), '+54 11 5555-1234');
  assert.throws(() => parseWhatsapp('hola'), /no es válido/);
});

test('privacidad: cada rol ve lo que le corresponde', () => {
  const rows = [
    { player_id: 'a', availability: { slots: [] }, whatsapp: '+5411', whatsapp_visible: true },
    { player_id: 'b', availability: null, whatsapp: '+5422', whatsapp_visible: false },
    { player_id: 'c', availability: { slots: [] }, whatsapp: null, whatsapp_visible: true },
  ];
  assert.deepEqual(Object.keys(datosVisibles(rows, { canManage: true })), ['a', 'b', 'c']);
  assert.deepEqual(datosVisibles(rows, {}), {});
  const jugador = datosVisibles(rows, { ownPlayerIds: ['b'] });
  assert.deepEqual(jugador.a, { whatsapp: '+5411' });
  assert.deepEqual(jugador.b, { availability: null, whatsapp: '+5422', whatsapp_visible: false });
  assert.equal(jugador.c, undefined);
});
