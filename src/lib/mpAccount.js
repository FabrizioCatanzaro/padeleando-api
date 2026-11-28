// Cuenta de Mercado Pago del organizador, vinculada por OAuth con la misma aplicación que los clubes.
import jwt from 'jsonwebtoken';

const STATE_SECRET = () => process.env.JWT_SECRET;
// El token de OAuth dura ~180 días: se renueva antes.
const REFRESH_AFTER_DAYS = 150;

export const connectState = (userId) => jwt.sign({ userId }, STATE_SECRET(), { expiresIn: '10m' });

export function authorizeUrl(state) {
  return `https://auth.mercadopago.com/authorization?client_id=${process.env.MP_CLIENT_ID}`
    + `&response_type=code&platform_id=mp&state=${encodeURIComponent(state)}`
    + `&redirect_uri=${encodeURIComponent(process.env.MP_CONNECT_REDIRECT_URI)}`;
}

async function oauthToken(body) {
  const res = await fetch('https://api.mercadopago.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.MP_CLIENT_ID, client_secret: process.env.MP_CLIENT_SECRET, ...body }),
  });
  if (!res.ok) throw new Error(`OAuth de Mercado Pago respondió ${res.status}`);
  return res.json();
}

export const exchangeCode = (code) =>
  oauthToken({ grant_type: 'authorization_code', code, redirect_uri: process.env.MP_CONNECT_REDIRECT_URI });

export async function saveUserMp(sql, userId, data) {
  await sql`
    UPDATE users
    SET mp_user_id = ${data.user_id != null ? String(data.user_id) : null}, mp_access_token = ${data.access_token},
        mp_refresh_token = ${data.refresh_token ?? null}, mp_public_key = ${data.public_key ?? null},
        mp_connected_at = NOW()
    WHERE id = ${userId}
  `;
}

/** Token vigente del organizador, renovado si hace falta; null si no vinculó. */
export async function userMpToken(sql, userId) {
  const [u] = await sql`
    SELECT mp_access_token, mp_refresh_token, mp_connected_at FROM users WHERE id = ${userId}`;
  if (!u?.mp_access_token) return null;
  const ageDays = (Date.now() - new Date(u.mp_connected_at).getTime()) / 86_400_000;
  if (ageDays < REFRESH_AFTER_DAYS || !u.mp_refresh_token) return u.mp_access_token;
  try {
    const data = await oauthToken({ grant_type: 'refresh_token', refresh_token: u.mp_refresh_token });
    await saveUserMp(sql, userId, data);
    return data.access_token;
  } catch (e) {
    console.error('No se pudo renovar el token de Mercado Pago:', e.message);
    return u.mp_access_token;
  }
}
