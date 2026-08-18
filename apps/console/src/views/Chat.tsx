import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api.ts';
import type { AgentStep, Bootstrap, ChatMessage, ChatSummary } from '../lib/api.ts';
import { Badge, Empty, Markdown, useAsync } from '../lib/ui.tsx';

/**
 * Chat.
 *
 * The agent here is not special — it holds the same nine tools every connected
 * client gets, so the interesting part of the screen is not the reply, it is the
 * trace underneath it: which tools ran, how long each took, what came back. That
 * is the product's actual claim (one memory, every agent) made visible in the
 * one place where the user can watch it happen.
 *
 * When no model key is configured the tab does not hide or fake anything. It
 * runs the retrieval half for real and says so in a banner, because a chat box
 * that silently invents answers is worse than one that admits its limits.
 */
export function Chat({
  boot,
  workspace,
  onWrote,
}: {
  boot: Bootstrap;
  workspace: string | null;
  onWrote?: () => void;
}) {
  const chats = useAsync<ChatSummary[]>(() => api.chats(), []);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState(boot.chat.defaultModel);
  const [openTrace, setOpenTrace] = useState<Record<string, boolean>>({});

  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  const generative = boot.chat.generative;
  const models = boot.chat.models;

  // Select the most recent chat on first load, so the tab is never an empty
  // room when there is history to show.
  useEffect(() => {
    if (!active && chats.data?.length) setActive(chats.data[0].id);
  }, [chats.data, active]);

  useEffect(() => {
    if (!active) return void setMessages([]);
    let cancelled = false;
    api.chat(active).then((r) => {
      if (cancelled) return;
      setMessages(r.messages);
      if (r.chat.model) setModel(r.chat.model);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, busy]);

  const newChat = useCallback(async () => {
    const c = await api.createChat({ model, workspaceId: workspace });
    await chats.reload();
    setActive(c.id);
    setMessages([]);
    box.current?.focus();
  }, [model, workspace, chats]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;

    let chatId = active;
    if (!chatId) {
      const c = await api.createChat({ model, workspaceId: workspace });
      chatId = c.id;
      setActive(c.id);
    }

    setDraft('');
    setError(null);
    setBusy(true);
    // Show the user's line immediately — waiting for the round trip to echo it
    // back makes a two-second tool call feel like a hang.
    setMessages((m) => [
      ...m,
      {
        id: `pending-${Date.now()}`,
        role: 'user',
        content: text,
        tool_calls: null,
        created_at: new Date().toISOString(),
      },
    ]);

    try {
      const r = await api.send(chatId, text, model);
      setMessages((m) => [...m, r.message]);
      if (r.wrote.length) onWrote?.();
      void chats.reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  }, [draft, busy, active, model, workspace, chats, onWrote]);

  const remove = useCallback(
    async (id: string) => {
      await api.deleteChat(id);
      if (active === id) {
        setActive(null);
        setMessages([]);
      }
      void chats.reload();
    },
    [active, chats],
  );

  const grouped = useMemo(() => models, [models]);

  return (
    <div className="chat-layout">
      <aside className="chat-rail">
        <button className="btn primary block" onClick={newChat}>
          + New chat
        </button>

        <div className="chat-list">
          {chats.loading && <div className="muted small pad">Loading…</div>}
          {chats.data?.length === 0 && (
            <div className="muted small pad">No conversations yet.</div>
          )}
          {chats.data?.map((c) => (
            <div
              key={c.id}
              className={`chat-item${active === c.id ? ' active' : ''}`}
              onClick={() => setActive(c.id)}
            >
              <div className="chat-item-title">{c.title}</div>
              <div className="chat-item-meta">
                {c.messages} message{c.messages === 1 ? '' : 's'}
              </div>
              <button
                className="chat-item-x"
                title="Delete conversation"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(c.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      </aside>

      <section className="chat-main">
        <header className="chat-head">
          <div className="chat-model">
            <label htmlFor="chat-model">Model</label>
            <select
              id="chat-model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {grouped.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label} — {m.provider}
                </option>
              ))}
            </select>
          </div>
          <Badge tone={generative ? 'ok' : 'warn'} dot>
            {generative ? 'Full agent · 9 tools' : 'Retrieval only'}
          </Badge>
        </header>

        {!generative && (
          <div className="notice warn chat-notice">
            <strong>No language model is configured.</strong> {boot.chat.reason} Every
            answer below is your own stored memory, quoted verbatim and cited — the
            search is genuinely semantic, but nothing here is written by a model. Set{' '}
            <code>ANTHROPIC_API_KEY</code> or <code>OPENAI_API_KEY</code> and restart to
            turn on the full agent.
          </div>
        )}

        <div className="chat-scroll">
          {messages.length === 0 && !busy && (
            <Empty
              icon="◇"
              title="Ask your memory something"
              hint={
                generative
                  ? 'This agent holds the same nine tools your other clients do. It can search what you know, write new memories, and correct old ones — and every call it makes is traced below the reply.'
                  : 'Ask a question and Orbis will search your memories semantically and quote what it finds. Try phrasing it in words that do not appear in the memory itself — that is the part worth testing.'
              }
            />
          )}

          {messages.map((m) => (
            <Message
              key={m.id}
              message={m}
              open={!!openTrace[m.id]}
              onToggle={() =>
                setOpenTrace((o) => ({ ...o, [m.id]: !o[m.id] }))
              }
            />
          ))}

          {busy && (
            <div className="msg assistant">
              <div className="msg-role">Orbis</div>
              <div className="msg-body thinking">
                <span className="dots"><i /><i /><i /></span>
                <span className="muted">searching memory…</span>
              </div>
            </div>
          )}

          {error && <div className="notice danger">{error}</div>}
          <div ref={bottom} />
        </div>

        <footer className="chat-compose">
          <textarea
            ref={box}
            value={draft}
            rows={2}
            placeholder="Ask about anything you have told your agents…"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn primary" disabled={busy || !draft.trim()} onClick={send}>
            Send
          </button>
        </footer>
      </section>
    </div>
  );
}

/**
 * One message, with its trace folded away.
 *
 * The trace is collapsed by default but the summary line is always visible —
 * "3 tools · 412ms" tells you the agent actually did something without making
 * you read the steps, and one click shows exactly what it asked and got back.
 */
function Message({
  message,
  open,
  onToggle,
}: {
  message: ChatMessage;
  open: boolean;
  onToggle: () => void;
}) {
  const steps = (message.tool_calls ?? []).filter((s) => s.kind === 'tool');
  const total = steps.reduce((n, s) => n + (s.latencyMs ?? 0), 0);

  return (
    <div className={`msg ${message.role}`}>
      <div className="msg-role">{message.role === 'user' ? 'You' : 'Orbis'}</div>
      <div className="msg-body">
        <Markdown text={message.content} />

        {steps.length > 0 && (
          <div className="trace">
            <button className="trace-head" onClick={onToggle}>
              <span className={`caret${open ? ' open' : ''}`}>▸</span>
              {steps.length} tool{steps.length === 1 ? '' : 's'} · {total}ms
              {steps.some((s) => !s.ok) && <Badge tone="danger">error</Badge>}
            </button>
            {open && (
              <div className="trace-body">
                {steps.map((s, i) => (
                  <TraceStep key={i} step={s} />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TraceStep({ step }: { step: AgentStep }) {
  return (
    <div className={`trace-step${step.ok === false ? ' failed' : ''}`}>
      <div className="trace-step-head">
        <code>{step.tool}</code>
        <span className="muted small">{step.latencyMs}ms</span>
      </div>
      <pre className="trace-io">{JSON.stringify(step.input, null, 1)}</pre>
      {step.output && <pre className="trace-io out">{step.output}</pre>}
    </div>
  );
}
