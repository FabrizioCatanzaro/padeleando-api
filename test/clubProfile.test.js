import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClubExtras, parseCourtExtras, CLUB_AMENITIES } from '../src/lib/clubProfile.js';

test('servicios: filtra claves desconocidas y respeta el orden del catálogo', () => {
  const { fields } = parseClubExtras({ amenities: ['wifi', 'jacuzzi', 'estacionamiento', 'wifi'] });
  assert.deepEqual(fields.amenities, ['estacionamiento', 'wifi']);
  assert.equal(CLUB_AMENITIES.length, 16);
});

test('una clave ausente no se toca y una vacía se limpia', () => {
  assert.deepEqual(parseClubExtras({ name: 'x' }).fields, {});
  assert.deepEqual(parseClubExtras({ amenities_other: '  ', contact_email: '' }).fields, { amenities_other: null, contact_email: null });
});

test('valida tipos, largo y email', () => {
  assert.ok(parseClubExtras({ amenities: 'wifi' }).error);
  assert.ok(parseClubExtras({ amenities_other: 'x'.repeat(161) }).error);
  assert.ok(parseClubExtras({ contact_email: 'reservas@club' }).error);
  assert.equal(parseClubExtras({ contact_email: ' Reservas@Club.com ' }).fields.contact_email, 'reservas@club.com');
});

test('cancha: color hexadecimal y descripción', () => {
  assert.deepEqual(parseCourtExtras({ floor_color: '#1F5FA8', description: ' Césped 2025 ' }).fields,
    { floor_color: '#1f5fa8', description: 'Césped 2025' });
  assert.deepEqual(parseCourtExtras({}).fields, { floor_color: null, description: null });
  assert.ok(parseCourtExtras({ floor_color: 'azul' }).error);
  assert.ok(parseCourtExtras({ floor_color: '#fff' }).error);
  assert.ok(parseCourtExtras({ description: 'x'.repeat(201) }).error);
});
