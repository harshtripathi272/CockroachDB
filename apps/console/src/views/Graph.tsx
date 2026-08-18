import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import type { GraphSnapshot } from '../lib/api.ts';
import { Badge, Empty, useAsync } from '../lib/ui.tsx';

/**
 * The memory graph.
 *
 * A hand-written force simulation on a canvas rather than d3-force plus an SVG
 * layer. The reasons are practical: canvas draws a few hundred nodes at 60fps
 * where SVG starts dropping frames, the simulation is about forty lines, and it
 * avoids a dependency whose API surface is far larger than the part being used.
 *
 * Layout is Fruchterman-Reingold in spirit — repulsion between every pair,
 * attraction along every edge, a cooling factor so it settles instead of
 * jittering forever.
 */

interface Node {
  id: string;
  label: string;
  kind: string;
  type: 'entity' | 'memory';
  weight: number;
  status?: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const ENTITY_COLORS: Record<string, string> = {
  person: '#b45309', org: '#1e5f74', project: '#3f6212', tool: '#7c3aed',
  repo: '#0e7490', place: '#a16207', concept: '#9f1239', event: '#c2410c',
};

export function Graph({ workspace }: { workspace: string | null }) {
  const snap = useAsync<GraphSnapshot>(() => api.graph({ workspace, limit: 140 }), [workspace]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const nodesRef = useRef<Node[]>([]);
  const frameRef = useRef(0);
  const [hover, setHover] = useState<Node | null>(null);
  const [selected, setSelected] = useState<Node | null>(null);
  const [showMemories, setShowMemories] = useState(true);

  const edges = useMemo(() => snap.data?.edges ?? [], [snap.data]);

  // Build the node set whenever the data or the filter changes.
  useEffect(() => {
    if (!snap.data) return;
    const nodes: Node[] = [];
    const w = 900;
    const h = 560;

    for (const e of snap.data.entities) {
      nodes.push({
        id: e.id, label: e.name, kind: e.kind, type: 'entity',
        weight: e.mentionCount,
        // Seeded from a hash of the id rather than Math.random, so the layout
        // is stable across reloads. A graph that rearranges itself every time
        // is much harder to recognise.
        x: w / 2 + (hash(e.id) % 400) - 200,
        y: h / 2 + (hash(e.id + 'y') % 300) - 150,
        vx: 0, vy: 0,
      });
    }
    if (showMemories) {
      for (const m of snap.data.memories) {
        nodes.push({
          id: m.id, label: m.title, kind: m.kind, type: 'memory',
          weight: 1, status: m.status,
          x: w / 2 + (hash(m.id) % 500) - 250,
          y: h / 2 + (hash(m.id + 'y') % 380) - 190,
          vx: 0, vy: 0,
        });
      }
    }
    nodesRef.current = nodes;
  }, [snap.data, showMemories]);

  // The simulation and the draw loop.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !snap.data) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);

    let alpha = 1;
    const byId = new Map<string, Node>();

    const step = () => {
      const nodes = nodesRef.current;
      byId.clear();
      for (const n of nodes) byId.set(n.id, n);

      const rect = canvas.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;

      if (alpha > 0.005) {
        // Repulsion. O(n²), which is fine at the few hundred nodes the server
        // caps this at and much simpler than a quadtree.
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let d2 = dx * dx + dy * dy;
            if (d2 < 1) { dx = (hash(a.id + b.id) % 10) - 5; dy = 3; d2 = 34; }
            if (d2 > 62500) continue; // ignore distant pairs
            const force = 900 / d2;
            const d = Math.sqrt(d2);
            const fx = (dx / d) * force;
            const fy = (dy / d) * force;
            a.vx -= fx; a.vy -= fy;
            b.vx += fx; b.vy += fy;
          }
        }

        // Attraction along edges.
        for (const e of edges) {
          const a = byId.get(e.srcId);
          const b = byId.get(e.dstId);
          if (!a || !b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d = Math.hypot(dx, dy) || 1;
          const force = (d - 70) * 0.012 * (e.rel === 'derives' ? 1.5 : 1);
          const fx = (dx / d) * force;
          const fy = (dy / d) * force;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }

        for (const n of nodes) {
          // Weak pull to centre stops disconnected components drifting away.
          n.vx += (cx - n.x) * 0.0016;
          n.vy += (cy - n.y) * 0.0016;
          n.vx *= 0.82; n.vy *= 0.82;
          n.x += n.vx * alpha;
          n.y += n.vy * alpha;
        }
        alpha *= 0.994;
      }

      // ---- draw
      const css = getComputedStyle(document.documentElement);
      const border = css.getPropertyValue('--border-strong').trim() || '#ccc';
      const text = css.getPropertyValue('--text').trim() || '#111';
      const faint = css.getPropertyValue('--text-3').trim() || '#999';

      ctx.clearRect(0, 0, rect.width, rect.height);

      for (const e of edges) {
        const a = byId.get(e.srcId);
        const b = byId.get(e.dstId);
        if (!a || !b) continue;
        const isLineage = e.rel === 'derives';
        ctx.strokeStyle = isLineage ? '#b45309' : border;
        ctx.globalAlpha = isLineage ? 0.5 : 0.28;
        ctx.lineWidth = isLineage ? 1.4 : 0.8;
        if (isLineage) ctx.setLineDash([3, 3]); else ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      for (const n of nodes) {
        const isEntity = n.type === 'entity';
        const r = isEntity ? Math.min(4 + Math.sqrt(n.weight) * 2.2, 15) : 3.2;
        const active = hover?.id === n.id || selected?.id === n.id;

        ctx.beginPath();
        ctx.arc(n.x, n.y, active ? r + 2.5 : r, 0, Math.PI * 2);
        if (isEntity) {
          ctx.fillStyle = ENTITY_COLORS[n.kind] ?? '#6b6558';
        } else {
          ctx.fillStyle = n.status === 'retracted' ? '#9f1239' : faint;
        }
        ctx.globalAlpha = isEntity ? 0.9 : 0.55;
        ctx.fill();
        ctx.globalAlpha = 1;

        if (active) {
          ctx.strokeStyle = text;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // Labels only where they will not turn the picture into noise.
        if (isEntity && (n.weight > 2 || active || nodes.length < 45)) {
          ctx.fillStyle = active ? text : faint;
          ctx.font = `${active ? '600 ' : ''}11px ui-sans-serif, system-ui, sans-serif`;
          ctx.textAlign = 'center';
          const label = n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label;
          ctx.fillText(label, n.x, n.y - r - 5);
        }
      }

      frameRef.current = requestAnimationFrame(step);
    };

    frameRef.current = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frameRef.current);
      window.removeEventListener('resize', resize);
    };
  }, [snap.data, edges, hover, selected]);

  const pick = (evt: React.MouseEvent): Node | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left;
    const y = evt.clientY - rect.top;
    let best: Node | null = null;
    let bestD = 16;
    for (const n of nodesRef.current) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  };

  const kinds = useMemo(() => {
    const set = new Map<string, number>();
    for (const e of snap.data?.entities ?? []) set.set(e.kind, (set.get(e.kind) ?? 0) + 1);
    return [...set.entries()].sort((a, b) => b[1] - a[1]);
  }, [snap.data]);

  return (
    <>
      <div className="row wrap">
        <div className="legend">
          {kinds.map(([k, n]) => (
            <span className="key" key={k}>
              <span className="swatch" style={{ background: ENTITY_COLORS[k] ?? '#6b6558' }} />
              {k} ({n})
            </span>
          ))}
          <span className="key">
            <span
              className="swatch"
              style={{ background: 'transparent', borderTop: '2px dashed #b45309', borderRadius: 0, height: 0 }}
            />
            derived from
          </span>
        </div>
        <div className="spacer" />
        <label className="row faint" style={{ gap: 5, fontSize: 13.5, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showMemories}
            onChange={(e) => setShowMemories(e.target.checked)}
          />
          show memories
        </label>
        <button className="btn sm ghost" onClick={snap.reload}>relayout</button>
      </div>

      <div className="card" style={{ position: 'relative' }}>
        {!snap.data?.entities.length && !snap.loading ? (
          <Empty
            icon="◈"
            title="No graph yet"
            hint="Entities are extracted as memories arrive. Store a few and they will appear here."
          />
        ) : (
          <>
            <canvas
              ref={canvasRef}
              style={{ width: '100%', height: 560, display: 'block', cursor: hover ? 'pointer' : 'default' }}
              onMouseMove={(e) => setHover(pick(e))}
              onMouseLeave={() => setHover(null)}
              onClick={(e) => setSelected(pick(e))}
            />
            {hover && (
              <div
                style={{
                  position: 'absolute', top: 10, left: 10,
                  background: 'var(--surface)', border: '1px solid var(--border-strong)',
                  borderRadius: 'var(--radius)', padding: '7px 10px',
                  boxShadow: 'var(--shadow)', pointerEvents: 'none', maxWidth: 320,
                }}
              >
                <div style={{ fontWeight: 600, fontSize: 13 }}>{hover.label}</div>
                <div className="faint" style={{ fontSize: 13 }}>
                  {hover.type === 'entity'
                    ? `${hover.kind} · mentioned ${hover.weight}×`
                    : `memory · ${hover.kind}`}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {selected?.type === 'entity' && (
        <EntityPanel id={selected.id} name={selected.label} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

function EntityPanel({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const d = useAsync(() => api.entity(id), [id]);

  return (
    <div className="card">
      <div className="card-head">
        <h3>{name}</h3>
        <span className="hint">everything connected to this</span>
        <div className="spacer" />
        <button className="btn sm ghost" onClick={onClose}>close</button>
      </div>
      <div className="grid-2" style={{ padding: 14 }}>
        <div>
          <div className="faint" style={{ fontSize: 13, marginBottom: 6 }}>MENTIONED IN</div>
          {!d.data?.memories.length ? (
            <div className="faint" style={{ fontSize: 13.5 }}>nothing yet</div>
          ) : (
            d.data.memories.slice(0, 10).map((m: any) => (
              <div key={m.id} style={{ padding: '4px 0', fontSize: 13 }}>
                {m.title}
                <span className="faint" style={{ fontSize: 13, marginLeft: 6 }}>{m.kind}</span>
              </div>
            ))
          )}
        </div>
        <div>
          <div className="faint" style={{ fontSize: 13, marginBottom: 6 }}>APPEARS ALONGSIDE</div>
          {!d.data?.related.length ? (
            <div className="faint" style={{ fontSize: 13.5 }}>nothing yet</div>
          ) : (
            <div className="row wrap" style={{ gap: 5 }}>
              {d.data.related.map((r: any) => (
                <Badge key={r.id}>{r.name} · {r.shared}</Badge>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Deterministic hash, so layouts are reproducible across reloads. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
