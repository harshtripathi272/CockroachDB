/**
 * Probe CockroachDB Cloud's managed MCP server with whatever key is in .env.
 *
 * Kept as a script rather than a test because it needs a real service account
 * and the network: a test that fails when a key is absent is a test that gets
 * ignored. Prints what the server advertises so the allowlist in
 * services/cloud/cockroach.ts can be checked against reality rather than docs.
 */
import { loadEnv } from './env.mjs';
import { cloudStatus, cloudCall, ALLOWED_TOOLS } from '../services/cloud/cockroach.ts';

loadEnv();

const st = await cloudStatus(true);
console.log('configured :', st.configured, st.keyHint ?? '');
console.log('cluster    :', st.clusterId);
console.log('reachable  :', st.reachable);
console.log('server     :', JSON.stringify(st.server));
console.log('protocol   :', st.protocolVersion);
console.log('error      :', st.error ?? '—');
console.log('hint       :', st.hint ?? '—');
console.log(`\nadvertised (${st.tools.length}):`);
for (const t of st.tools) {
  const mark = (ALLOWED_TOOLS as readonly string[]).includes(t.name) ? '+' : ' ';
  console.log(`  ${mark} ${t.name.padEnd(26)} ${t.readOnly ? 'read-only' : 'MUTATES  '}  ${(t.description ?? '').slice(0, 70)}`);
}
console.log(`\nallowed here: ${st.allowed.join(', ') || '—'}`);

if (st.reachable && st.allowed.includes('get_cluster')) {
  const r = await cloudCall('get_cluster', {});
  console.log(`\nget_cluster -> ok=${r.ok} ${r.latencyMs}ms`);
  console.log(r.text.slice(0, 900));
}
process.exit(0);
