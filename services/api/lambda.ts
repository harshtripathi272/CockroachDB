/**
 * Lambda entry point for Orbis.
 *
 * AWS Lambda Function URLs invoke the handler with an API Gateway-style event.
 * The Orbis HTTP layer (services/api/server.ts) speaks node:http — plain
 * IncomingMessage/ServerResponse — so this file is a thin bridge that
 * translates a Lambda event into those shapes and calls the exact same
 * `handleHttp` used by the local server. One routing code path, two hosts.
 *
 * Design notes:
 *  - The MCP handler was deliberately built stateless and SSE-free precisely so
 *    this bridge could exist: there is no long-lived connection to manage, so
 *    a Function URL call is just a request/response round trip.
 *  - Cold starts pay the cost of `orbis.ready()` (embedding provider probe +
 *    pool setup) on first invocation; subsequent invocations reuse the warm
 *    module state. The embedder falls back to on-device MiniLM if Bedrock is
 *    unreachable, so a cold start never hard-fails.
 *  - The Cloud connection string is NOT baked into the function's env. It lives
 *    in Secrets Manager, and this handler fetches it once on the first
 *    invocation before importing the server module (whose module-level `orbis`
 *    construction reads CLOUD_DATABASE_URL). Because ESM imports are hoisted,
 *    the server module is imported dynamically, after the secret is in place.
 */

import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// Minimal structural types. The Lambda bridge only needs the subset of
// IncomingMessage/ServerResponse that handleHttp actually touches, so we
// declare exactly that rather than importing @types/aws-lambda and forcing a
// full dependency tree into the deployment package.
// ---------------------------------------------------------------------------

interface LambdaEvent {
  version?: string;
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string>;
  requestContext?: {
    http?: { method?: string };
  };
  body?: string | null;
  isBase64Encoded?: boolean;
}

interface LambdaResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
}

/** The subset of IncomingMessage we actually use: method, url, headers, body stream. */
interface ReqLike extends PassThrough {
  method?: string;
  url?: string;
  headers: Record<string, string>;
}

/** The subset of ServerResponse we actually use. */
interface ResLike {
  statusCode: number;
  statusMessage: string;
  headersSent: boolean;
  writeHead(statusCode: number, headers?: Record<string, string | string[]>): ResLike;
  writeHead(
    statusCode: number,
    reasonPhrase: string,
    headers?: Record<string, string | string[]>,
  ): ResLike;
  end(chunk?: unknown): ResLike;
  write(chunk?: unknown): boolean;
  setHeader(name: string, value: string | number | readonly string[]): void;
  getHeader(name: string): string | undefined;
  getHeaders(): Record<string, string>;
  hasHeader(name: string): boolean;
  removeHeader(name: string): void;
}

// ---------------------------------------------------------------------------
// Secrets Manager bootstrap
// ---------------------------------------------------------------------------

/**
 * Fetch the Cloud connection string from Secrets Manager and put it in env.
 *
 * The secret name is `orbis/cloud-db` (created by deploy.ps1) and holds
 * `{ CLOUD_DATABASE_URL, ROOT_CRT_B64 }`. On Lambda there is no `.env`, so this
 * is the single source of truth for the connection. The cert bytes are written
 * to `certs/root.crt` inside the bundle so `resolveConnectionString('cloud')`
 * finds it exactly as it does locally.
 *
 * Idempotent and cached: once env is populated it never runs again, so warm
 * invocations pay nothing.
 */
let bootstrapPromise: Promise<void> | null = null;

async function bootstrapEnv(): Promise<void> {
  if (process.env.CLOUD_DATABASE_URL) return;

  // Only run on Lambda. Locally, server.ts's loadEnv() picks up .env and
  // ORBIS_TARGET=local, so there is no secret to fetch and none exists.
  if (!process.env.AWS_LAMBDA_FUNCTION_NAME) return;

  const secretName = process.env.ORBIS_SECRET_NAME ?? 'orbis/cloud-db';
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? 'ap-south-1' });
  const res = await client.send(
    new GetSecretValueCommand({ SecretId: secretName }),
  );
  if (!res.SecretString) throw new Error(`secret ${secretName} has no SecretString`);

  const parsed = JSON.parse(res.SecretString) as {
    CLOUD_DATABASE_URL?: string;
    ROOT_CRT_B64?: string;
    CRDB_CLOUD_API_KEY?: string;
    CRDB_CLUSTER_ID?: string;
  };
  if (!parsed.CLOUD_DATABASE_URL) throw new Error(`secret ${secretName} missing CLOUD_DATABASE_URL`);

  process.env.CLOUD_DATABASE_URL = parsed.CLOUD_DATABASE_URL;

  // The CockroachDB Cloud service-account key, for the managed MCP server.
  // Optional — without it the Cloud MCP panel says so rather than failing — and
  // in the secret rather than the function's environment for the same reason
  // the connection string is: env vars on a function are visible to anyone who
  // can describe it.
  if (parsed.CRDB_CLOUD_API_KEY) process.env.CRDB_CLOUD_API_KEY = parsed.CRDB_CLOUD_API_KEY;
  if (parsed.CRDB_CLUSTER_ID) process.env.CRDB_CLUSTER_ID = parsed.CRDB_CLUSTER_ID;

  if (parsed.ROOT_CRT_B64) {
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    // /var/task is read-only on Lambda; write the cert to /tmp instead.
    const certPath = join('/tmp', 'certs', 'root.crt');
    mkdirSync(join('/tmp', 'certs'), { recursive: true });
    writeFileSync(certPath, Buffer.from(parsed.ROOT_CRT_B64, 'base64'));
    process.env.ORBIS_CERT_PATH = certPath;
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

let handleHttp: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | null = null;

/**
 * The Lambda handler. AWS calls this with a Function URL (or API Gateway) event.
 */
export async function handler(event: LambdaEvent): Promise<LambdaResult> {
  // First invocation: fetch the DB secret, then load the server module.
  // If bootstrap fails (e.g. the secret was momentarily wrong), reset so the
  // next invocation retries instead of caching the rejection forever.
  if (!handleHttp) {
    if (!bootstrapPromise) {
      bootstrapPromise = bootstrapEnv().catch((err) => {
        bootstrapPromise = null;
        throw err;
      });
    }
    await bootstrapPromise;
    const server = await import('./server.ts');
    handleHttp = server.handleHttp;
  }

  // Build a minimal IncomingMessage-shaped object. Only the fields handleHttp
  // actually touches are needed: method, url, headers, and the body as a
  // readable stream (readBody consumes req as an async iterable).
  const req = new PassThrough() as unknown as ReqLike;
  req.method = event.requestContext?.http?.method ?? 'GET';
  req.url = (event.rawPath ?? '/') + (event.rawQueryString ? `?${event.rawQueryString}` : '');
  req.headers = normalizeHeaders(event.headers ?? {});

  // Function URLs base64-encode the body when the content-type is binary or
  // when isBase64Encoded is true. Decode it back before handing it to the
  // handler so readBody sees the raw bytes.
  if (event.body) {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body, 'utf8');
    req.end(raw);
  } else {
    req.end();
  }

  // Capture the ServerResponse output into an object.
  const captured: {
    statusCode: number;
    headers: Record<string, string>;
    body: Buffer;
  } = {
    statusCode: 200,
    headers: {},
    body: Buffer.alloc(0),
  };

  const res = {
    statusCode: 200,
    statusMessage: 'OK',
    headersSent: false,
    writeHead(statusCode: number, reasonOrHeaders?: string | Record<string, string | string[]>, maybeHeaders?: Record<string, string | string[]>) {
      captured.statusCode = statusCode;
      const headers = typeof reasonOrHeaders === 'object' ? reasonOrHeaders : maybeHeaders;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          // Lowercase the key. HTTP header names are case-insensitive and
          // node:http treats them as such, but this object is a plain JS map
          // where 'Content-Type' and 'content-type' are two different entries.
          // serveStatic writes the capitalised form; the result assembly reads
          // the lowercase one. Storing both meant every response carried a
          // correct Content-Type *and* a text/plain default, and the wrong one
          // won — so the console was served as source text and its JavaScript
          // never executed.
          captured.headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
        }
      }
      return this;
    },
    end(chunk?: unknown) {
      if (chunk) {
        captured.body = Buffer.concat([
          captured.body,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'),
        ]);
      }
      return this;
    },
    write(chunk?: unknown) {
      if (chunk) {
        captured.body = Buffer.concat([
          captured.body,
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'),
        ]);
      }
      return true;
    },
    // The whole header map is keyed lowercase, so every accessor has to
    // normalise or they disagree with each other.
    setHeader(name: string, value: string | number | readonly string[]) {
      captured.headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
    },
    getHeader(name: string) {
      return captured.headers[name.toLowerCase()];
    },
    getHeaders() {
      return { ...captured.headers };
    },
    hasHeader(name: string) {
      return name.toLowerCase() in captured.headers;
    },
    removeHeader(name: string) {
      delete captured.headers[name.toLowerCase()];
    },
  } as ResLike;

  await handleHttp(req as unknown as IncomingMessage, res as unknown as ServerResponse);

  const contentType = captured.headers['content-type'] ?? 'text/plain; charset=utf-8';

  /**
   * Binary responses must be base64-encoded, or API Gateway mangles them.
   *
   * This used to return `body.toString('utf8')` unconditionally, on the
   * reasoning that everything Orbis serves is text. That was true until the
   * console started shipping its own webfonts: a .woff2 run through
   * `toString('utf8')` has every byte that is not valid UTF-8 replaced with
   * U+FFFD, so the file arrives the right length and completely corrupt, and
   * the browser silently falls back to a system font.
   *
   * It fails only in production — locally the same handler writes the Buffer
   * straight to a socket and never round-trips through a string — which is the
   * worst shape a bug can have. The check is on content type rather than on
   * "does this Buffer survive a round trip", because the answer has to be
   * decided before the damage is done.
   */
  const isText =
    /^(text\/|application\/(json|javascript|xml)|image\/svg)/.test(contentType);

  return {
    statusCode: captured.statusCode,
    headers: { ...captured.headers, 'content-type': contentType },
    body: isText ? captured.body.toString('utf8') : captured.body.toString('base64'),
    isBase64Encoded: !isText,
  };
}

/** AWS passes headers lowercased already, but normalize to be safe. */
function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}
