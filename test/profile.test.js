import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNamePart, splitLegacyName, parseHandle, parseWebsite, parseWhatsapp, parseDocument,
  parseBirthDate, ageFrom, parseAddress, parseEmergencyContacts, parseProfileUpdate,
  usernameChangeStatus, publicProfileFields, profileContacts, googleNames, ProfileError,
} from '../src/lib/profile.js';

const NOW = new Date('2026-11-26T12:00:00Z');

test('nombre y apellido: 1 a 40, letras, espacios y guion', () => {
  assert.equal(parseNamePart('  María   Fernanda ', 'El nombre'), 'María Fernanda');
  assert.equal(parseNamePart('Pérez-Ríos', 'El apellido'), 'Pérez-Ríos');
  assert.equal(parseNamePart("D'Alessandro", 'El apellido'), "D'Alessandro");
  for (const bad of ['', '   ', 'Juan2', 'a'.repeat(41), '-Ana', 'Ana!']) {
    assert.throws(() => parseNamePart(bad, 'El nombre'), ProfileError, JSON.stringify(bad));
  }
});

test('splitLegacyName: primera palabra y resto', () => {
  assert.deepEqual(splitLegacyName('Fabrizio Catanzaro'), { first_name: 'Fabrizio', last_name: 'Catanzaro' });
  assert.deepEqual(splitLegacyName('María Fernanda  López'), { first_name: 'María', last_name: 'Fernanda López' });
  assert.deepEqual(splitLegacyName('Fabri'), { first_name: 'Fabri', last_name: '' });
});

test('redes: acepta @usuario, usuario o la URL del perfil', () => {
  assert.equal(parseHandle('instagram', '@martirios'), 'martirios');
  assert.equal(parseHandle('instagram', 'https://www.instagram.com/martirios/?hl=es'), 'martirios');
  assert.equal(parseHandle('twitter', 'https://x.com/marti_r'), 'marti_r');
  assert.equal(parseHandle('twitter', 'twitter.com/marti_r'), 'marti_r');
  assert.equal(parseHandle('facebook', 'https://m.facebook.com/martina.rios'), 'martina.rios');
  assert.equal(parseHandle('instagram', ''), null);
  assert.throws(() => parseHandle('twitter', '@un_usuario_demasiado_largo'), ProfileError);
  assert.throws(() => parseHandle('instagram', 'con espacio'), ProfileError);
});

test('sitio web: agrega https y rechaza lo que no es dirección', () => {
  assert.equal(parseWebsite('martinarios.com.ar'), 'https://martinarios.com.ar');
  assert.equal(parseWebsite('http://padel.ar/club'), 'http://padel.ar/club');
  assert.equal(parseWebsite(''), null);
  for (const bad of ['no es una web', 'localhost', 'ftp://x.com']) assert.throws(() => parseWebsite(bad), ProfileError, bad);
});

test('WhatsApp: solo dígitos con +, entre 8 y 15', () => {
  assert.equal(parseWhatsapp('+54 9 11 5555-0192'), '+5491155550192');
  assert.equal(parseWhatsapp('(011) 5555 0192'), '+01155550192');
  assert.equal(parseWhatsapp(''), null);
  for (const bad of ['1234567', 'abc', '+54 11 5555 0192 12345']) assert.throws(() => parseWhatsapp(bad), ProfileError, bad);
});

test('documento: DNI de 7 u 8 números, sin puntos', () => {
  assert.deepEqual(parseDocument('dni', '40.123.456'), { doc_type: 'dni', doc_number: '40123456' });
  assert.deepEqual(parseDocument('pasaporte', 'aab123456'), { doc_type: 'pasaporte', doc_number: 'AAB123456' });
  assert.deepEqual(parseDocument('', ''), { doc_type: null, doc_number: null });
  assert.deepEqual(parseDocument('dni', ''), { doc_type: null, doc_number: null });
  assert.throws(() => parseDocument('dni', '123456'), ProfileError);
  assert.throws(() => parseDocument('cedula', '123'), ProfileError);
  assert.throws(() => parseDocument('', '40123456'), ProfileError);
});

test('fecha de nacimiento y edad', () => {
  assert.equal(parseBirthDate('1997-03-14', NOW), '1997-03-14');
  assert.equal(parseBirthDate('', NOW), null);
  for (const bad of ['1997-02-30', '14/03/1997', '2024-01-01', '1900-01-01']) {
    assert.throws(() => parseBirthDate(bad, NOW), ProfileError, bad);
  }
  assert.equal(ageFrom('2000-07-11', NOW), 26);
  assert.equal(ageFrom('2000-11-26', NOW), 26);
  assert.equal(ageFrom('2000-11-27', NOW), 25);
  assert.equal(ageFrom(null, NOW), null);
});

test('domicilio: CP argentino de 4 números o CPA', () => {
  assert.deepEqual(parseAddress({ country: 'ar', postal_code: '1708' }), { country: 'AR', postal_code: '1708' });
  assert.deepEqual(parseAddress({ postal_code: 'c1708abc' }, { country: 'AR' }), { postal_code: 'C1708ABC' });
  assert.deepEqual(parseAddress({ postal_code: '75001' }, { country: 'FR' }), { postal_code: '75001' });
  assert.throws(() => parseAddress({ postal_code: '170' }, { country: 'AR' }), ProfileError);
  assert.throws(() => parseAddress({ country: 'Argentina' }), ProfileError);
  assert.deepEqual(parseAddress({ locality: '  Morón ' }), { locality: 'Morón' });
});

test('contactos de emergencia: hasta 2 y completos', () => {
  const c = { name: 'Laura Ríos', relation: 'Madre', phone: '11 4444-0187' };
  assert.deepEqual(parseEmergencyContacts([c, { name: '', relation: '', phone: '' }]), [c]);
  assert.deepEqual(parseEmergencyContacts(null), []);
  assert.throws(() => parseEmergencyContacts([c, c, c]), ProfileError);
  assert.throws(() => parseEmergencyContacts([{ name: 'Laura', relation: '', phone: '1144440187' }]), ProfileError);
  assert.throws(() => parseEmergencyContacts([{ ...c, phone: '123' }]), ProfileError);
  assert.throws(() => parseEmergencyContacts('Laura'), ProfileError);
});

test('género: se fija al primer guardado', () => {
  assert.deepEqual(parseProfileUpdate({ gender: 'femenino' }, { gender: null }), { gender: 'femenino' });
  assert.deepEqual(parseProfileUpdate({ gender: 'femenino' }, { gender: 'femenino' }), {});
  assert.throws(() => parseProfileUpdate({ gender: 'masculino' }, { gender: 'femenino' }), (e) => e.status === 409);
  assert.throws(() => parseProfileUpdate({ gender: '' }, { gender: 'femenino' }), (e) => e.status === 409);
  assert.throws(() => parseProfileUpdate({ gender: 'otro' }, {}), ProfileError);
});

test('parseProfileUpdate: solo las claves presentes', () => {
  assert.deepEqual(parseProfileUpdate({}, {}), {});
  assert.deepEqual(
    parseProfileUpdate({ first_name: 'Martina', instagram: '@martirios', hand: 'ambidiestro', whatsapp_public: true }),
    { first_name: 'Martina', instagram: 'martirios', hand: 'ambidiestro', whatsapp_public: true },
  );
  assert.deepEqual(parseProfileUpdate({ doc_number: '40.123.456' }, { doc_type: 'dni' }), { doc_type: 'dni', doc_number: '40123456' });
  assert.deepEqual(parseProfileUpdate({ side: '' }), { side: null });
  assert.throws(() => parseProfileUpdate({ whatsapp_public: 'si' }), ProfileError);
  assert.throws(() => parseProfileUpdate({ last_name: '' }), ProfileError);
});

test('username: el primer cambio es libre y después cada 90 días', () => {
  assert.deepEqual(usernameChangeStatus(null, NOW), { allowed: true, next_at: null });
  const st = usernameChangeStatus('2026-10-01T12:00:00Z', NOW);
  assert.equal(st.allowed, false);
  assert.equal(st.next_at, '2026-12-30T12:00:00.000Z');
  assert.equal(usernameChangeStatus('2026-08-28T12:00:00Z', NOW).allowed, true);
});

test('perfil público: edad sí, fecha no; WhatsApp público solo con sesión', () => {
  const row = {
    first_name: 'Martina', last_name: 'Ríos', nationality: 'AR', birth_date: '1997-03-14',
    hand: 'diestro', side: 'reves', instagram: 'martirios', twitter: null, facebook: null, website: null,
    whatsapp: '+5491155550192', whatsapp_public: true,
  };
  const anon = publicProfileFields(row, { viewerId: null, now: NOW });
  assert.equal(anon.age, 29);
  assert.equal(anon.whatsapp, null);
  assert.equal('birth_date' in anon, false);
  assert.equal(anon.whatsapp_public, undefined);
  assert.equal(publicProfileFields(row, { viewerId: 'u2', now: NOW }).whatsapp, '+5491155550192');
  assert.equal(publicProfileFields({ ...row, whatsapp_public: false }, { viewerId: 'u2', now: NOW }).whatsapp, null);
  const own = publicProfileFields({ ...row, whatsapp_public: false }, { viewerId: 'u1', isOwner: true, now: NOW });
  assert.equal(own.whatsapp, '+5491155550192');
  assert.equal(own.whatsapp_public, false);
});

test('contactos del organizador: WhatsApp público e Instagram', () => {
  assert.deepEqual(profileContacts({ whatsapp: '+5491155551234', instagram: 'fabri' }), [
    { type: 'whatsapp', value: '+5491155551234', from_profile: true },
    { type: 'instagram', value: '@fabri', from_profile: true },
  ]);
  assert.deepEqual(profileContacts({ whatsapp: '+5491155551234', whatsapp_public: false }), []);
  assert.deepEqual(profileContacts(null), []);
});

test('Google: given_name y family_name, o el nombre partido', () => {
  assert.deepEqual(googleNames({ given_name: 'Fabrizio', family_name: 'Catanzaro', name: 'x' }), { first_name: 'Fabrizio', last_name: 'Catanzaro' });
  assert.deepEqual(googleNames({ name: 'Ana María Paz' }), { first_name: 'Ana', last_name: 'María Paz' });
  assert.deepEqual(googleNames({}), { first_name: 'Jugador', last_name: '' });
});
