#!/usr/bin/env node
/**
 * Apply db/migrations/*.sql in filename order.
 *
 * Statements are split and sent one at a time rather than as a single batch,
 * because CockroachDB rejects some DDL inside an implicit multi-statement
 * transaction and because a failure part-way through is far easier to diagnose
 * when the failing statement can be printed on its own.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadEnv, resolveConnectionString } from './env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

loadEnv();

const target = (process.argv.find((a) => a.startsWith('--target=')) ?? '--target=local').slice(9);
const verbose = process.argv.includes('--verbose');

/**
 * Split on semicolons that terminate a statement.
 *
 * Naive splitting breaks on semicolons inside string literals and inside
 * dollar-quoted bodies, so both are tracked. Line and block comments are
 * skipped so a `;` in prose cannot end a statement early.
 */
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let i = 0;
  let inSingle = false;
  let inDollar = null;

  while (i < sql.length) {
    const ch = sql[i];
    const rest = sql.slice(i);

    if (!inSingle && !inDollar && rest.startsWith('--')) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      continue;
    }
    if (!inSingle && !inDollar && rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (!inDollar && ch === "'") {
      // '' inside a string is an escaped quote, not a terminator.
      if (inSingle && sql[i + 1] === "'") { buf += "''"; i += 2; continue; }
      inSingle = !inSingle;
      buf += ch; i++; continue;
    }
    if (!inSingle) {
      const dollar = rest.match(/^\$[A-Za-z_]*\$/);
      if (dollar) {
        const tag = dollar[0];
        if (inDollar === tag) inDollar = null;
        else if (!inDollar) inDollar = tag;
        buf += tag; i += tag.length; continue;
      }
    }
    if (ch === ';' && !inSingle && !inDollar) {
      if (buf.trim()) out.push(buf.trim());
      buf = ''; i++; continue;
    }
    buf += ch; i++;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

const files = readdirSync(join(ROOT, 'db', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error('no migrations found in db/migrations');
  process.exit(1);
}

const connectionString = resolveConnectionString(target);
// The database may not exist yet, so connect to the cluster default first and
// let CREATE DATABASE inside the migration take care of it.
const client = new pg.Client({
  connectionString: connectionString.replace(/\/orbis(\?|$)/, '/defaultdb$1'),
  ssl: connectionString.includes('sslmode=disable') ? undefined : { rejectUnauthorized: true },
});

await client.connect();
console.log(`→ ${target}  (${redact(connectionString)})\n`);

let applied = 0;
let skipped = 0;

for (const file of files) {
  const sql = readFileSync(join(ROOT, 'db', 'migrations', file), 'utf8');
  const statements = splitStatements(sql);
  process.stdout.write(`${file}  ${statements.length} statements\n`);

  for (const stmt of statements) {
    const label = stmt.replace(/\s+/g, ' ').slice(0, 72);
    try {
      await client.query(stmt);
      applied++;
      if (verbose) console.log(`   ok   ${label}`);
    } catch (err) {
      // Migrations are written to be idempotent, but CockroachDB does not
      // support IF NOT EXISTS on every object (policies, for one), so an
      // already-exists error on a re-run is expected and not a failure.
      if (/already exists|duplicate/i.test(err.message)) {
        skipped++;
        if (verbose) console.log(`   skip ${label}`);
        continue;
      }
      console.error(`\n   FAILED  ${label}`);
      console.error(`   ${err.message}\n`);
      await client.end();
      process.exit(1);
    }
  }
}

console.log(`\n${applied} applied, ${skipped} already present.`);
await client.end();

function redact(url) {
  return url.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@').replace(/sslrootcert=[^&]+/, 'sslrootcert=…');
}
