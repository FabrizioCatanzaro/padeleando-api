// Regenera src/schema_base.sql desde el esquema real de la base (tablas,
// columnas, constraints, claves foráneas e índices) leyendo el catálogo de
// Postgres. Sólo lee la base: no modifica nada.
// Uso, desde la raíz del repo:  node scripts/dump-schema.mjs
// Escribe el archivo directo en UTF-8 (redirigir con > en PowerShell lo
// guardaba en UTF-16).
import { createRequire } from 'module';
import { writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const root    = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const { neon } = require('@neondatabase/serverless');
require('dotenv').config({ path: join(root, '.env'), quiet: true });
const sql = neon(process.env.DATABASE_URL_ADMIN || process.env.DATABASE_URL);

const today = new Date().toISOString().slice(0, 10);
const ext = await sql`SELECT extname FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY extname`;
const tables = await sql`
  SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname`;

const out = [`-- Esquema base completo de PADELEANDO, generado del esquema real de producción
-- (node scripts/dump-schema.mjs, ${today}). db:init lo aplica ANTES de
-- schema.sql: en una base nueva crea todo; en una existente cada sentencia es
-- un no-op. Para cambios nuevos seguí usando schema.sql; regenerá este archivo
-- con el script cuando quieras volver a sincronizarlo.
--
-- Las claves foráneas van al final, en bloques que no fallan si ya existen:
-- hay referencias cruzadas entre tablas y no existe un orden de creación válido.
`, ...ext.map((e) => `CREATE EXTENSION IF NOT EXISTS ${e.extname};`), ''];

const fks = [];
for (const t of tables) {
  const cols = await sql`
    SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull,
           pg_get_expr(d.adbin, d.adrelid) AS def
    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = ${t.oid} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`;
  const cons = await sql`
    SELECT conname, pg_get_constraintdef(oid) AS def, contype
    FROM pg_constraint WHERE conrelid = ${t.oid} ORDER BY contype DESC, conname`;
  const lines = cols.map((c) => `  ${c.attname} ${c.type}${c.def ? ' DEFAULT ' + c.def : ''}${c.attnotnull ? ' NOT NULL' : ''}`);
  for (const k of cons) {
    if (k.contype === 'f') fks.push({ table: t.relname, name: k.conname, def: k.def });
    else lines.push(`  CONSTRAINT ${k.conname} ${k.def}`);
  }
  out.push(`CREATE TABLE IF NOT EXISTS ${t.relname} (\n${lines.join(',\n')}\n);\n`);
}

out.push('-- Claves foráneas');
for (const f of fks) {
  out.push(`DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${f.name}') THEN
    ALTER TABLE ${f.table} ADD CONSTRAINT ${f.name} ${f.def};
  END IF;
END $$;`);
}

const idx = await sql`
  SELECT indexdef FROM pg_indexes i
  WHERE schemaname = 'public'
    AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = i.indexname)
  ORDER BY tablename, indexname`;
out.push('\n-- Índices');
out.push(...idx.map((i) => i.indexdef
  .replace('CREATE UNIQUE INDEX', 'CREATE UNIQUE INDEX IF NOT EXISTS')
  .replace(/^CREATE INDEX/, 'CREATE INDEX IF NOT EXISTS') + ';'));

const target = join(root, 'src', 'schema_base.sql');
writeFileSync(target, out.join('\n') + '\n', 'utf8');
console.log(`✅ ${target}: ${tables.length} tablas, ${fks.length} claves foráneas, ${idx.length} índices.`);
