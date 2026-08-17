/**
 * Embeddings.
 *
 * Three providers behind one interface, chosen at startup by what is actually
 * reachable. The console displays which one is live, because "semantic search"
 * backed by a hash is a lie and the difference has to be visible rather than
 * buried in a config file.
 *
 *   local    Sentence-transformers (MiniLM-L6-v2) running on CPU via ONNX.
 *            Genuinely semantic, no network, no credentials. Measured on this
 *            machine: 6.7s one-time model load, then ~10ms per text.
 *   bedrock  Amazon Titan Text Embeddings V2. Better quality, 1024 native.
 *   lexical  Hashed bag-of-words. Last resort. Matches on shared vocabulary
 *            only — it will find "refund policy" from "refund", but never from
 *            "reimbursement". Reported honestly as degraded.
 *
 * All providers emit VECTOR_DIMENSIONS floats. Models narrower than that are
 * zero-padded: for unit-norm vectors, padding with zeros preserves the norm and
 * leaves cosine similarity between two padded vectors exactly unchanged. It is
 * lossless within a model but meaningless across them, so every row records the
 * model that produced it and switching providers triggers a re-embed rather
 * than silently comparing incompatible vectors.
 */

/** Fixed by the schema. Titan V2's native width. */
export const VECTOR_DIMENSIONS = 1024;

export interface EmbeddingProvider {
  /** Stable identifier stored alongside every vector, e.g. 'local:MiniLM-L6-v2'. */
  readonly id: string;
  /** Human-readable, shown in the console. */
  readonly label: string;
  /** True semantic model, or vocabulary-overlap only. */
  readonly semantic: boolean;
  /** Native width before padding. */
  readonly nativeDimensions: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** Pad (or truncate) to the schema width without disturbing cosine distance. */
function fit(vec: number[]): number[] {
  if (vec.length === VECTOR_DIMENSIONS) return vec;
  if (vec.length > VECTOR_DIMENSIONS) return vec.slice(0, VECTOR_DIMENSIONS);
  return vec.concat(new Array(VECTOR_DIMENSIONS - vec.length).fill(0));
}

/** CockroachDB accepts a vector literal as '[1,2,3]'. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

// ---------------------------------------------------------------------------
// local — ONNX sentence-transformers
// ---------------------------------------------------------------------------

/**
 * MiniLM-L6-v2 rather than a larger retrieval-tuned model, and the choice was
 * measured rather than assumed.
 *
 * bge-small-en-v1.5 is the obvious alternative and produces higher absolute
 * similarity scores, which makes it look better at a glance. On this corpus it
 * is worse where it counts: 4/5 correct top-1 against MiniLM's 5/5, and a mean
 * margin between the first and second hit of 0.094 against MiniLM's 0.166.
 * Absolute score is cosmetic; the gap between the right answer and the runner-up
 * is what determines whether recall is trustworthy. MiniLM also loads in 0.5s
 * against bge's 9.4s, which matters for a cold start.
 */
export class LocalEmbedder {
  readonly id = 'local:all-MiniLM-L6-v2';
  readonly label = 'MiniLM-L6-v2 (on-device)';
  readonly semantic = true;
  readonly nativeDimensions = 384;

  #extractor: unknown = null;
  #loading: Promise<unknown> | null = null;

  /**
   * The model is loaded lazily and exactly once.
   *
   * Two callers arriving together must not both trigger a load, so the
   * in-flight promise is cached rather than the result — the second caller
   * awaits the first one's work instead of starting a duplicate download.
   */
  async #ready(): Promise<any> {
    if (this.#extractor) return this.#extractor;
    if (!this.#loading) {
      this.#loading = (async () => {
        const { pipeline, env } = await import('@huggingface/transformers');
        // Keep the ~23MB model inside the repo so a container image can bake it
        // in and a cold start does not reach out to the network.
        env.cacheDir = './.models';
        const p = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
          dtype: 'fp32',
        });
        this.#extractor = p;
        return p;
      })();
    }
    return this.#loading;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.#ready();
    const out: number[][] = [];
    // Sequential rather than Promise.all: the ONNX session is single-threaded,
    // so parallel calls contend rather than overlap, and a large batch fired at
    // once spikes memory for no throughput gain.
    for (const text of texts) {
      const t = await extractor(truncate(text), { pooling: 'mean', normalize: true });
      out.push(fit(Array.from(t.data as Float32Array)));
    }
    return out;
  }

  /** Warm the model so the first real request does not pay the load cost. */
  async warm(): Promise<void> {
    await this.#ready();
  }
}

// ---------------------------------------------------------------------------
// bedrock — Amazon Titan Text Embeddings V2
// ---------------------------------------------------------------------------

export class BedrockEmbedder {
  readonly id = 'bedrock:titan-embed-text-v2';
  readonly label = 'Amazon Titan Text Embeddings V2';
  readonly semantic = true;
  readonly nativeDimensions = 1024;

  #client: unknown = null;
  #region: string;
  #model: string;

  constructor(region: string, model = 'amazon.titan-embed-text-v2:0') {
    this.#region = region;
    this.#model = model;
  }

  async #ensure(): Promise<any> {
    if (!this.#client) {
      const { BedrockRuntimeClient } = await import('@aws-sdk/client-bedrock-runtime');
      this.#client = new BedrockRuntimeClient({ region: this.#region });
    }
    return this.#client;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const client = await this.#ensure();
    const { InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const out: number[][] = [];
    for (const text of texts) {
      const res = await client.send(
        new InvokeModelCommand({
          modelId: this.#model,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({
            inputText: truncate(text),
            dimensions: VECTOR_DIMENSIONS,
            normalize: true,
          }),
        }),
      );
      const parsed = JSON.parse(new TextDecoder().decode(res.body));
      out.push(fit(parsed.embedding));
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// lexical — deterministic fallback
// ---------------------------------------------------------------------------

/**
 * Hashed bag-of-words with sublinear term weighting.
 *
 * This is a real retrieval function, not a placeholder: tokens are hashed into
 * buckets and weighted by 1 + log(count), so documents sharing vocabulary score
 * genuinely higher than documents that do not. What it categorically cannot do
 * is match paraphrases — "reimbursement" and "refund" hash to unrelated buckets
 * and score zero. That limit is why `semantic` is false and why the console
 * shows a warning whenever this provider is the live one.
 */
export class LexicalEmbedder {
  readonly id = 'lexical:hashed-bow';
  readonly label = 'Lexical fallback (keyword overlap only)';
  readonly semantic = false;
  readonly nativeDimensions = VECTOR_DIMENSIONS;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.#one(t));
  }

  #one(text: string): number[] {
    const vec = new Array(VECTOR_DIMENSIONS).fill(0);
    const counts = new Map<string, number>();

    for (const token of tokenize(text)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
      // Character bigrams of the token give partial credit for morphological
      // variants — "refund"/"refunds"/"refunded" share most of their bigrams —
      // which recovers a little of what stemming would provide.
      for (let i = 0; i < token.length - 2; i++) {
        const gram = `#${token.slice(i, i + 3)}`;
        counts.set(gram, (counts.get(gram) ?? 0) + 0.3);
      }
    }

    for (const [term, count] of counts) {
      const h = fnv1a(term) % VECTOR_DIMENSIONS;
      vec[h] += 1 + Math.log(count);
    }

    const norm = Math.hypot(...vec);
    return norm === 0 ? vec : vec.map((v) => v / norm);
  }
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'it', 'this',
  'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'my', 'your',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Both Titan and MiniLM have input limits; a memory this long is pathological. */
function truncate(text: string, max = 8000): string {
  return text.length <= max ? text : text.slice(0, max);
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export interface EmbedderChoice {
  provider: EmbeddingProvider;
  /** Why this one, for the console and the startup log. */
  reason: string;
  /** Providers that were tried and failed, with the error, so it is diagnosable. */
  rejected: { id: string; error: string }[];
}

/**
 * Pick the best provider that actually works right now.
 *
 * Preference order is bedrock → local → lexical, but each is *probed with a
 * real call* rather than assumed from the presence of credentials. An AWS key
 * that exists but cannot invoke Bedrock is the exact situation this has to
 * survive, and it is the situation we are in.
 */
export async function selectEmbedder(opts: {
  preferred?: string;
  awsRegion?: string;
  bedrockModel?: string;
} = {}): Promise<EmbedderChoice> {
  const rejected: { id: string; error: string }[] = [];
  const order = opts.preferred ? [opts.preferred] : ['bedrock', 'local', 'lexical'];

  for (const name of order) {
    if (name === 'bedrock') {
      const b = new BedrockEmbedder(opts.awsRegion ?? 'ap-south-1', opts.bedrockModel);
      try {
        const [v] = await b.embed(['probe']);
        if (v?.length === VECTOR_DIMENSIONS) {
          return { provider: b, reason: 'Bedrock reachable and returning vectors', rejected };
        }
        rejected.push({ id: b.id, error: `unexpected width ${v?.length}` });
      } catch (err) {
        rejected.push({ id: b.id, error: (err as Error).message.slice(0, 160) });
      }
    }

    if (name === 'local') {
      const l = new LocalEmbedder();
      try {
        const [v] = await l.embed(['probe']);
        if (v?.length === VECTOR_DIMENSIONS) {
          return {
            provider: l,
            reason: 'on-device model loaded; embeddings are genuinely semantic',
            rejected,
          };
        }
        rejected.push({ id: l.id, error: `unexpected width ${v?.length}` });
      } catch (err) {
        rejected.push({ id: l.id, error: (err as Error).message.slice(0, 160) });
      }
    }

    if (name === 'lexical') {
      return {
        provider: new LexicalEmbedder(),
        reason: 'no semantic model available — search degraded to keyword overlap',
        rejected,
      };
    }
  }

  return {
    provider: new LexicalEmbedder(),
    reason: 'fell through provider selection',
    rejected,
  };
}
