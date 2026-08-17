/**
 * Orbis core.
 *
 * `Orbis` owns the process-wide things — the connection pool and the embedding
 * provider — and hands out a `Session` per account. Everything account-scoped
 * goes through a Session, so no call site can accidentally read across accounts
 * by forgetting a filter: the account id is bound once, at the boundary.
 */
import { Db } from './db.ts';
import type { DbConfig } from './db.ts';
import { selectEmbedder } from './embeddings.ts';
import type { EmbedderChoice, EmbeddingProvider } from './embeddings.ts';
import { MemoryStore } from './memory.ts';
import { WorkspaceStore } from './workspace.ts';
import { ContextBuilder } from './context.ts';
import { TokenStore } from './tokens.ts';
import { GraphStore } from './graph.ts';
import { WikiStore } from './wiki.ts';

export * from './types.ts';
export { Db, GcWindowExceededError, GC_WINDOW_SECONDS } from './db.ts';
export {
  selectEmbedder,
  LocalEmbedder,
  BedrockEmbedder,
  LexicalEmbedder,
  VECTOR_DIMENSIONS,
  toVectorLiteral,
} from './embeddings.ts';
export type { EmbeddingProvider, EmbedderChoice } from './embeddings.ts';
export { MemoryStore, audit } from './memory.ts';
export { WorkspaceStore, slugify } from './workspace.ts';
export { ContextBuilder } from './context.ts';
export { TokenStore, generateToken, hashToken, recordConnection, logToolCall } from './tokens.ts';
export type { TokenIdentity } from './tokens.ts';
export { GraphStore } from './graph.ts';
export { WikiStore } from './wiki.ts';

export class Session {
  readonly accountId: string;
  readonly memories: MemoryStore;
  readonly workspaces: WorkspaceStore;
  readonly context: ContextBuilder;
  readonly graph: GraphStore;
  readonly wiki: WikiStore;
  readonly db: Db;

  constructor(db: Db, embedder: EmbeddingProvider, accountId: string) {
    this.db = db;
    this.accountId = accountId;
    this.memories = new MemoryStore(db, embedder, accountId);
    this.workspaces = new WorkspaceStore(db, accountId);
    this.graph = new GraphStore(db, embedder, accountId);
    this.wiki = new WikiStore(db, accountId);
    this.context = new ContextBuilder(db, this.memories, this.workspaces, accountId);
  }
}

export class Orbis {
  readonly db: Db;
  readonly tokens: TokenStore;
  #embedder: EmbeddingProvider | null = null;
  #choice: EmbedderChoice | null = null;
  #embedderOpts: Parameters<typeof selectEmbedder>[0];

  constructor(cfg: DbConfig & { embedder?: Parameters<typeof selectEmbedder>[0] }) {
    this.db = new Db(cfg);
    this.tokens = new TokenStore(this.db);
    this.#embedderOpts = cfg.embedder ?? {};
  }

  /**
   * Resolve the embedding provider once, at startup.
   *
   * Selection probes each candidate with a real call, so this is where an AWS
   * key that exists but cannot invoke Bedrock gets discovered — at boot, with a
   * clear log line, rather than on a user's first search.
   */
  async ready(): Promise<EmbedderChoice> {
    if (!this.#choice) {
      this.#choice = await selectEmbedder(this.#embedderOpts);
      this.#embedder = this.#choice.provider;
    }
    return this.#choice;
  }

  get embedder(): EmbeddingProvider {
    if (!this.#embedder) throw new Error('call ready() before using the embedder');
    return this.#embedder;
  }

  get embedderChoice(): EmbedderChoice | null {
    return this.#choice;
  }

  session(accountId: string): Session {
    return new Session(this.db, this.embedder, accountId);
  }

  /** Resolve a bearer token straight to a working session. */
  async sessionForToken(token: string): Promise<{ session: Session; identity: any } | null> {
    const identity = await this.tokens.resolve(token);
    if (!identity) return null;
    return { session: this.session(identity.accountId), identity };
  }

  async close(): Promise<void> {
    await this.db.close();
  }
}
