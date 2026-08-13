/**
 * Environment loading shared by scripts and the API.
 *
 * Two targets exist on purpose:
 *   local - the 3-node Docker cluster. Where the chaos demo happens, because
 *           CockroachDB Cloud Basic is serverless and has no nodes to kill.
 *   cloud - CockroachDB Cloud Basic. Satisfies the Managed MCP Server
 *           requirement and hosts the judged demo.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env reader -- avoids a dependency and keeps parsing predictable. */
export function loadEnv(): void {
  const path = join(ROOT, '.env');
  if (!existsSync(path)) return;

  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export type Target = 'local' | 'cloud';

export function resolveConnectionString(target: string = 'local'): string {
  if (target === 'cloud') {
    const url = process.env.CLOUD_DATABASE_URL;
    if (!url) throw new Error('CLOUD_DATABASE_URL is not set in .env');
    // CockroachDB Cloud presents a cluster-specific CA. scripts/fetch-cert.sh
    // downloads it; without sslrootcert the system trust store rejects it.
    const cert = join(ROOT, 'certs', 'root.crt');
    if (existsSync(cert) && !url.includes('sslrootcert')) {
      return `${url}${url.includes('?') ? '&' : '?'}sslrootcert=${cert.replace(/\\/g, '/')}`;
    }
    return url;
  }
  return (
    process.env.LOCAL_DATABASE_URL ??
    'postgresql://root@localhost:26257/recall?sslmode=disable'
  );
}

export const TENANT_ID =
  process.env.RECALL_TENANT_ID ?? '11111111-1111-1111-1111-111111111111';
