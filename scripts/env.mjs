/**
 * Environment loading shared by every entry point.
 *
 * Two targets exist deliberately:
 *   local — the 3-node Docker cluster. Everything is developed and tested here
 *           first, and it is the only place a node can actually be killed.
 *   cloud — CockroachDB Cloud. Hosts the judged demo.
 *
 * Plain .mjs rather than .ts so that scripts run under `node` with no build
 * step and no type-stripping caveats.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env reader — no dependency, predictable parsing, no surprises. */
export function loadEnv() {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return;

  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Tolerate quoted values; connection strings often get pasted with them.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function resolveConnectionString(target = process.env.ORBIS_TARGET ?? 'local') {
  if (target === 'cloud') {
    const url = process.env.CLOUD_DATABASE_URL;
    if (!url) throw new Error('CLOUD_DATABASE_URL is not set in .env');
    // CockroachDB Cloud presents a cluster-specific CA that the system trust
    // store does not carry. Without sslrootcert the handshake fails outright.
    // On Lambda the cert is written to /tmp by lambda.ts (ORBIS_CERT_PATH);
    // locally it lives at certs/root.crt in the repo.
    let cert = process.env.ORBIS_CERT_PATH;
    if (!cert) {
      const p = join(ROOT, 'certs', 'root.crt');
      if (existsSync(p)) cert = p;
    }
    if (cert && !url.includes('sslrootcert')) {
      const sep = url.includes('?') ? '&' : '?';
      return `${url}${sep}sslrootcert=${cert.replace(/\\/g, '/')}`;
    }
    return url;
  }
  return (
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://root@localhost:26257/orbis?sslmode=disable'
  );
}

export { ROOT };
