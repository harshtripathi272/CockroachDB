import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

/**
 * Embeddings via Amazon Bedrock (Titan Text Embeddings V2).
 *
 * Two details that matter downstream:
 *
 *  - Dimension is pinned to 1024 to match VECTOR(1024) in the schema. Titan V2
 *    can emit 256/512/1024; changing it here without a migration produces a
 *    runtime type error on insert, so it is not configurable by accident.
 *  - `normalize: true` yields unit vectors. Our index declares
 *    vector_cosine_ops and every read uses `<=>`, which is only meaningful for
 *    consistently-scaled vectors.
 */

export const EMBEDDING_DIMENSION = 1024;

export interface EmbedderConfig {
  region: string;
  modelId?: string;
}

export interface Embedder {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export class BedrockEmbedder implements Embedder {
  private client: BedrockRuntimeClient;
  private modelId: string;

  constructor(cfg: EmbedderConfig) {
    this.client = new BedrockRuntimeClient({ region: cfg.region });
    this.modelId = cfg.modelId ?? 'amazon.titan-embed-text-v2:0';
  }

  async embed(text: string): Promise<number[]> {
    const command = new InvokeModelCommand({
      modelId: this.modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        inputText: text,
        dimensions: EMBEDDING_DIMENSION,
        normalize: true,
      }),
    });

    const response = await this.client.send(command);
    const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
      embedding: number[];
    };

    if (parsed.embedding?.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `Expected ${EMBEDDING_DIMENSION}-dim embedding, got ${parsed.embedding?.length}`,
      );
    }
    return parsed.embedding;
  }

  /**
   * Sequential on purpose. Titan has no batch endpoint, and CockroachDB's docs
   * warn that large batch inserts of VECTOR types degrade performance -- so
   * there is nothing to gain by racing them and a real risk in doing so.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (const t of texts) out.push(await this.embed(t));
    return out;
  }
}

/**
 * Deterministic offline embedder for tests and for seeding demo data without
 * burning Bedrock calls. Produces stable, well-separated vectors from a hash of
 * the text, so semantically identical strings collide and different ones do not.
 * Never use in the app path -- it has no semantic understanding whatsoever.
 */
export class FakeEmbedder implements Embedder {
  async embed(text: string): Promise<number[]> {
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const vec = new Array<number>(EMBEDDING_DIMENSION);
    let state = h >>> 0;
    for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      vec[i] = state / 0xffffffff - 0.5;
    }
    const norm = Math.hypot(...vec);
    return vec.map((v) => v / norm);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

/** pgvector wire format: '[0.1,0.2,...]'. */
export function toVectorLiteral(v: number[]): string {
  return `[${v.join(',')}]`;
}
