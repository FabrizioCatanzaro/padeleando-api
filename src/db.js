import { neon, neonConfig, Pool, types } from '@neondatabase/serverless';
import ws from 'ws';
import "dotenv/config";

// Un DATE es un día del calendario: sin esto el driver lo movía según la zona del proceso.
const DATE_OID = 1082;
types.setTypeParser(DATE_OID, (v) => v);

let _sql  = null;
let _pool = null;

// El driver HTTP: cada sql`…` es una petición HTTPS independiente. Es lo que usa
// casi toda la API, y va bien para consultas sueltas.
export function getDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL no está configurado. Revisá tu .env');
  }
  if (!_sql) _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

// El driver HTTP no soporta transacciones multi-sentencia: para eso hace falta
// el Pool sobre WebSocket. Se usa sólo donde la atomicidad importa (crear una
// jornada escribe en cinco tablas), no como reemplazo general de getDb().
export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL no está configurado. Revisá tu .env');
  }
  if (!_pool) {
    // Node 22 trae WebSocket global; en versiones anteriores hay que
    // proveerlo. Render no fija la versión de Node en este proyecto, así que
    // no se da por supuesta.
    if (typeof globalThis.WebSocket === 'undefined') {
      neonConfig.webSocketConstructor = ws;
    }
    _pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  }
  return _pool;
}

// Ejecuta fn dentro de una transacción y libera siempre la conexión.
// fn recibe un cliente con la misma forma de uso que `sql`: client.query(text, params).
export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* la conexión ya no sirve */ }
    throw err;
  } finally {
    client.release();
  }
}
