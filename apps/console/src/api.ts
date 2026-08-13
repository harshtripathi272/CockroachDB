const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
  return r.json() as Promise<T>;
}

export type BeliefStatus = 'active' | 'quarantined' | 'retracted' | 'superseded';

export interface Belief {
  id: string;
  kind: string;
  subject: string;
  claim: string;
  confidence: number;
  status: BeliefStatus;
  sourceKind: string;
  sourceRef?: string | null;
  derivedFromDecision?: string | null;
  validFrom: string;
  validTo?: string | null;
  distance?: number;
}

export interface Decision {
  id: string;
  action: string;
  payload: Record<string, unknown>;
  rationale?: string | null;
  status: string;
  actor: string;
  committedAt: string;
  revertedAt?: string | null;
  generation?: number | string;
}

export interface Health {
  ok: boolean;
  error?: string;
  latencyMs: number;
  target: string;
  topologyAvailable: boolean;
  nodes: Array<{ id: number; live: boolean; address: string }>;
  liveNodes: number;
  totalNodes: number;
  beliefCount: number;
  at: string;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  operation: string;
  targetKind: string;
  targetId: string;
  detail: Record<string, unknown> | null;
}

export const api = {
  health: () => get<Health>('/api/health'),

  beliefs: (opts: { q?: string; status?: string; kind?: string } = {}) => {
    const p = new URLSearchParams();
    if (opts.q) p.set('q', opts.q);
    if (opts.status) p.set('status', opts.status);
    if (opts.kind) p.set('kind', opts.kind);
    const qs = p.toString();
    return get<{ mode: string; beliefs: Belief[] }>(`/api/beliefs${qs ? `?${qs}` : ''}`);
  },

  belief: (id: string) =>
    get<{ belief: Belief; usedBy: Decision[] }>(`/api/beliefs/${id}`),

  decisions: (limit = 60) => get<{ decisions: Decision[] }>(`/api/decisions?limit=${limit}`),

  lineage: (decisionId: string) =>
    get<{ inputs: Array<Belief & { weight: number | null }> }>(
      `/api/decisions/${decisionId}/lineage`,
    ),

  blastRadius: (beliefId: string) =>
    get<{ beliefId: string; decisions: Decision[]; generations: number; tookMs: number }>(
      `/api/blast-radius/${beliefId}`,
    ),

  retract: (id: string, reason: string) =>
    post<{ ok: boolean }>(`/api/beliefs/${id}/retract`, { reason }),

  revert: (decisionIds: string[], reason: string) =>
    post<{ reverted: number; compensations: number }>('/api/revert', { decisionIds, reason }),

  timeline: (at: Date) =>
    get<{ at: string; mechanism: string; beliefs: Belief[] }>(
      `/api/timeline?at=${encodeURIComponent(at.toISOString())}`,
    ),

  audit: (limit = 50) => get<{ entries: AuditEntry[] }>(`/api/audit?limit=${limit}`),
};
