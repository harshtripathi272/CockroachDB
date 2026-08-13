/**
 * Writes ~/.aws/credentials and ~/.aws/config from an IAM access-key CSV.
 *
 * Why this exists rather than `aws configure`: the AWS SDK reads the shared
 * credentials file directly, so the CLI is not actually required. More
 * importantly, this reads the secret from disk and writes it to disk without
 * ever printing it, so the key never passes through a terminal transcript.
 *
 * Nothing here echoes a secret. The only thing reported is the first four
 * characters of the access key id, which is an identifier, not a credential.
 *
 *   node scripts/aws-configure.mjs "<path-to-csv>" [region] [profile]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [, , csvPath, region = 'ap-south-1', profile = 'default'] = process.argv;

if (!csvPath) {
  console.error('usage: node scripts/aws-configure.mjs <csv> [region] [profile]');
  process.exit(1);
}
if (!existsSync(csvPath)) {
  console.error(`not found: ${csvPath}`);
  process.exit(1);
}

/** Minimal RFC4180-ish split: handles quoted fields containing commas. */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const lines = readFileSync(csvPath, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim().length > 0);

if (lines.length < 2) {
  console.error('csv has no data row');
  process.exit(1);
}

const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
const row = splitCsvLine(lines[1]);

// IAM has shipped a few different column layouts over the years; match on
// meaning rather than position.
const idIdx = header.findIndex((h) => h.includes('access key id') || h === 'awsaccesskeyid' || h === 'access_key_id');
const secretIdx = header.findIndex((h) => h.includes('secret access key') || h === 'awssecretkey' || h === 'secret_access_key');

if (idIdx === -1 || secretIdx === -1) {
  console.error(`could not find key columns. headers seen: ${header.join(' | ')}`);
  process.exit(1);
}

const keyId = row[idIdx];
const secret = row[secretIdx];

if (!keyId || !secret) {
  console.error('csv row is missing the key id or secret');
  process.exit(1);
}
if (!/^AKIA|^ASIA/.test(keyId)) {
  console.error('that does not look like an AWS access key id; refusing to write');
  process.exit(1);
}

const awsDir = join(homedir(), '.aws');
mkdirSync(awsDir, { recursive: true });

const credPath = join(awsDir, 'credentials');
const cfgPath = join(awsDir, 'config');

/** Replace the profile block if present, otherwise append. Never clobbers other profiles. */
function upsert(path, sectionHeader, body) {
  let existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const re = new RegExp(`\\[${sectionHeader.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\][^\\[]*`, 'g');
  existing = existing.replace(re, '');
  const next = `${existing.trim()}\n\n[${sectionHeader}]\n${body}\n`.trimStart();
  writeFileSync(path, next, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* no-op on Windows */ }
}

upsert(credPath, profile, `aws_access_key_id = ${keyId}\naws_secret_access_key = ${secret}`);
upsert(cfgPath, profile === 'default' ? 'default' : `profile ${profile}`, `region = ${region}\noutput = json`);

console.log(`wrote ${credPath}`);
console.log(`wrote ${cfgPath}`);
console.log(`  profile : ${profile}`);
console.log(`  region  : ${region}`);
console.log(`  key id  : ${keyId.slice(0, 4)}${'*'.repeat(Math.max(0, keyId.length - 4))}`);
console.log('\nsecret was never printed. delete the csv from Downloads when you are done.');
