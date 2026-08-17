/** Shared shapes. Kept close to the schema so the mapping stays obvious. */

export type MemoryKind =
  | 'fact'
  | 'preference'
  | 'decision'
  | 'event'
  | 'insight'
  | 'doc'
  | 'task'
  | 'question';

export type MemoryStatus = 'active' | 'superseded' | 'retracted';

export type MemorySource =
  | 'mcp'
  | 'chat'
  | 'interview'
  | 'import'
  | 'api'
  | 'dream'
  | 'telegram';

export type EntityKind =
  | 'person'
  | 'org'
  | 'project'
  | 'tool'
  | 'repo'
  | 'place'
  | 'concept'
  | 'event';

export type WikiKind = 'profile' | 'project' | 'topic' | 'entity' | 'workspace';

export interface Memory {
  id: string;
  accountId: string;
  workspaceId: string | null;
  workspaceName?: string;
  nodeId: string | null;
  nodePath?: string;
  kind: MemoryKind;
  title: string;
  body: string;
  source: MemorySource;
  client: string;
  sourceRef: string | null;
  confidence: number;
  evidenceCount: number;
  status: MemoryStatus;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  validFrom: string;
  validTo: string | null;
  supersededBy: string | null;
  /** Present only on search results: cosine distance, lower is closer. */
  distance?: number;
  /** Present only on search results: 1 - distance, for display. */
  score?: number;
}

export interface Workspace {
  id: string;
  slug: string;
  name: string;
  description: string;
  color: string;
  icon: string;
  isDefault: boolean;
  memoryCount?: number;
  createdAt: string;
}

export interface TreeNode {
  id: string;
  workspaceId: string;
  parentId: string | null;
  kind: 'folder' | 'project' | 'collection';
  name: string;
  slug: string;
  path: string;
  summary: string;
  memoryCount?: number;
  children?: TreeNode[];
}

export interface Entity {
  id: string;
  kind: EntityKind;
  name: string;
  canonical: string;
  summary: string;
  mentionCount: number;
  firstSeen: string;
  lastSeen: string;
}

export interface GraphEdge {
  srcKind: 'memory' | 'entity' | 'node';
  srcId: string;
  dstKind: 'memory' | 'entity' | 'node';
  dstId: string;
  rel: string;
  weight: number;
}

export interface WikiPage {
  id: string;
  workspaceId: string | null;
  slug: string;
  title: string;
  kind: WikiKind;
  bodyMd: string;
  summary: string;
  generator: string;
  sourceCount: number;
  stale: boolean;
  generatedAt: string;
  citations?: WikiCitation[];
}

export interface WikiCitation {
  memoryId: string;
  claim: string;
  memoryTitle?: string;
  memoryStatus?: MemoryStatus;
}

export interface InterviewQuestion {
  id: string;
  workspaceId: string | null;
  topic: string;
  question: string;
  why: string;
  priority: number;
  status: 'open' | 'answered' | 'skipped';
  createdAt: string;
}

export interface ClientConnection {
  clientName: string;
  clientVersion: string;
  protocol: string;
  transport: string;
  firstSeen: string;
  lastSeen: string;
  callCount: number;
}

export interface ToolCall {
  id: string;
  client: string;
  surface: 'mcp' | 'rest' | 'console' | 'telegram' | 'dream';
  tool: string;
  ok: boolean;
  latencyMs: number;
  error: string | null;
  resultCount: number;
  at: string;
}

/** What an agent gets when it asks Orbis "who is this and what are we doing". */
export interface Context {
  account: { displayName: string; email: string; traits: Record<string, unknown> };
  profile: string;
  workspace: Workspace | null;
  workspaceSummary: string;
  preferences: Memory[];
  recent: Memory[];
  openQuestions: InterviewQuestion[];
  generatedAt: string;
}

export interface SearchOptions {
  query: string;
  workspaceId?: string | null;
  kind?: MemoryKind;
  limit?: number;
  /** Cosine distance ceiling. Results further than this are dropped. */
  maxDistance?: number;
  includeInactive?: boolean;
  tags?: string[];
}

export interface RememberInput {
  title: string;
  body: string;
  kind?: MemoryKind;
  workspaceId?: string | null;
  nodeId?: string | null;
  tags?: string[];
  confidence?: number;
  source?: MemorySource;
  client?: string;
  sourceRef?: string;
  /** Memories this one was derived from. Populates the lineage edge. */
  derivedFrom?: string[];
}

/** One decision's worth of correction fallout. */
export interface Fallout {
  memories: Array<Memory & { hops: number }>;
  pages: Array<{ id: string; slug: string; title: string; via: string }>;
  entities: Array<{ id: string; name: string; kind: EntityKind }>;
  tookMs: number;
}
