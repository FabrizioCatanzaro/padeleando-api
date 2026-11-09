import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { Pool } from '@neondatabase/serverless';
 
const __dirname = dirname(fileURLToPath(import.meta.url));
// schema_base.sql crea todo en una base nueva (generado con
// scripts/dump-schema.mjs); schema.sql trae los cambios incrementales. Los dos
// son idempotentes: en producción, el primero no hace nada.
const schema    = ['schema_base.sql', 'schema.sql']
  .map((f) => readFileSync(join(__dirname, f), 'utf8'))
  .join('\n\n');
 
// Las migraciones necesitan permisos DDL: usar el rol owner (DATABASE_URL_ADMIN).
// DATABASE_URL apunta al rol de app de minimo privilegio (solo DML) en produccion.
const pool = new Pool({ connectionString: process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL });
 
try {
  await pool.query(schema);
  console.log('✅ Schema aplicado correctamente.');
} finally {
  await pool.end();
}