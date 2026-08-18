import { useCallback, useEffect, useRef, useState } from 'react';

/** Small shared pieces. Anything used by more than one view lives here. */

export function Badge({
  children,
  tone,
  dot,
  pulse,
  title,
}: {
  children: React.ReactNode;
  tone?: 'ok' | 'warn' | 'danger' | 'info' | 'accent';
  dot?: boolean;
  pulse?: boolean;
  /** Tooltip — useful when the badge is a summary of something longer. */
  title?: string;
}) {
  return (
    <span className={`badge${tone ? ` ${tone}` : ''}`} title={title}>
      {dot && <span className={`dot${pulse ? ' pulse' : ''}`} />}
      {children}
    </span>
  );
}

export function statusTone(status: string) {
  if (status === 'active') return 'ok' as const;
  if (status === 'retracted') return 'danger' as const;
  return undefined;
}

export function kindTone(kind: string) {
  if (kind === 'preference') return 'accent' as const;
  if (kind === 'insight') return 'info' as const;
  if (kind === 'decision') return 'warn' as const;
  return undefined;
}

/**
 * Confidence as five bars.
 *
 * A bar chart is legible in peripheral vision in a way "0.68" is not, and the
 * exact number is rarely what matters — "barely known" versus "well
 * established" is the actual question.
 */
export function Confidence({ value, evidence }: { value: number; evidence?: number }) {
  const filled = Math.round(value * 5);
  return (
    <span
      className="conf"
      title={`confidence ${value.toFixed(2)}${evidence ? ` · observed ${evidence}×` : ''}`}
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <i key={i} className={i < filled ? 'on' : ''} />
      ))}
    </span>
  );
}

/** A short id that copies itself when clicked. */
export function Id({ value, len = 8 }: { value: string; len?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <span
      className="id"
      title={copied ? 'copied' : `${value} — click to copy`}
      onClick={(e) => {
        e.stopPropagation();
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {copied ? 'copied' : value.slice(0, len)}
    </span>
  );
}

export function Empty({ icon, title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="empty">
      {icon && <div className="big">{icon}</div>}
      <div style={{ fontWeight: 550, color: 'var(--text-2)' }}>{title}</div>
      {hint && <div style={{ marginTop: 4, fontSize: 13.5 }}>{hint}</div>}
    </div>
  );
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="codeblock">
      <button
        className="btn sm ghost copy-btn"
        onClick={() => {
          void navigator.clipboard.writeText(code);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? '✓ copied' : 'copy'}
      </button>
      {lang && (
        <div style={{ color: 'var(--text-3)', fontSize: 13, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.06em' }}>
          {lang}
        </div>
      )}
      {code}
    </div>
  );
}

export function Drawer({
  title,
  onClose,
  children,
  actions,
}: {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  // Escape closes. Registered on the document so it works regardless of
  // where focus currently sits inside the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="drawer" role="dialog" aria-modal="true">
        <div className="drawer-head">
          <h2 style={{ flex: 1, minWidth: 0 }}>{title}</h2>
          {actions}
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </>
  );
}

/** Toasts. Deliberately transient and non-blocking. */
export interface Toast {
  id: number;
  message: string;
  tone?: 'ok' | 'danger';
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const push = useCallback((message: string, tone?: 'ok' | 'danger') => {
    const id = next.current++;
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
  }, []);

  const view = (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast${t.tone ? ` ${t.tone}` : ''}`}>
          {t.message}
        </div>
      ))}
    </div>
  );

  return { push, view };
}

/**
 * Data loading with the three states a UI actually needs.
 *
 * `reload` is stable so it can be passed to children without re-triggering
 * their effects, and a stale response from a superseded request is discarded
 * rather than overwriting fresher data.
 */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);

  const run = useCallback(() => {
    const mine = ++seq.current;
    setLoading(true);
    fn()
      .then((d) => {
        if (mine === seq.current) {
          setData(d);
          setError(null);
        }
      })
      .catch((e) => {
        if (mine === seq.current) setError((e as Error).message);
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(run, [run]);

  return { data, error, loading, reload: run };
}

/** Poll while the tab is visible. Background tabs should not burn queries. */
export function usePoll(fn: () => void, ms: number, enabled = true) {
  const saved = useRef(fn);
  saved.current = fn;

  useEffect(() => {
    if (!enabled) return;
    const tick = () => {
      if (document.visibilityState === 'visible') saved.current();
    };
    const t = setInterval(tick, ms);
    return () => clearInterval(t);
  }, [ms, enabled]);
}

export function relTime(iso: string): string {
  const d = new Date(iso).getTime();
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 45) return 'just now';
  if (s < 90) return 'a minute ago';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The smallest markdown renderer that covers what the dream pass emits.
 *
 * A full markdown library is 40KB for headings, bold, lists, code and rules.
 * Generated pages are the only markdown here and their shape is known, so this
 * handles exactly that and escapes everything else.
 */
export function Markdown({ text }: { text: string }) {
  const esc = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\W)_([^_]+)_(?=\W|$)/g, '$1<em>$2</em>');

  const html: string[] = [];
  let list: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (list) {
      html.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }

    // Headings carry a slug id so a table of contents can link straight to
    // them. Derived from the text, so the two cannot drift out of sync.
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const level = h[1].length;
      const id = h[2].trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      html.push(`<h${level} id="${id}">${inline(h[2])}</h${level}>`);
      continue;
    }

    if (/^(---|___|\*\*\*)$/.test(line.trim())) { closeList(); html.push('<hr/>'); continue; }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) { closeList(); html.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    if (ul) {
      if (list !== 'ul') { closeList(); html.push('<ul>'); list = 'ul'; }
      html.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }

    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      if (list !== 'ol') { closeList(); html.push('<ol>'); list = 'ol'; }
      html.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${inline(line)}</p>`);
  }
  closeList();

  return <div className="prose" dangerouslySetInnerHTML={{ __html: html.join('') }} />;
}

/** Bar chart with no dependency. Values are normalised to the tallest bar. */
export function Bars({
  data,
  height = 68,
  alt,
}: {
  data: Array<{ label: string; value: number }>;
  height?: number;
  alt?: boolean;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="bars" style={{ height }}>
      {data.map((d, i) => (
        <div
          key={i}
          className={`bar${alt ? ' alt' : ''}`}
          style={{ height: `${Math.max(2, (d.value / max) * 100)}%` }}
          title={`${d.label}: ${d.value}`}
        />
      ))}
    </div>
  );
}
