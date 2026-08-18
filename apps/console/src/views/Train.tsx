import { useState } from 'react';
import { api } from '../lib/api.ts';
import type { Bootstrap, InterviewQ } from '../lib/api.ts';
import { Badge, Empty, useAsync } from '../lib/ui.tsx';

/**
 * Train — filling the gaps deliberately.
 *
 * Most memory products only learn passively, which means they stay ignorant
 * about anything that never came up in conversation. This is the active path:
 * Orbis works out what it does not know and asks.
 *
 * One question at a time, on purpose. A twenty-field form is a chore that
 * nobody finishes; a single question with a visible cost of one sentence gets
 * answered. The same questions are also offered to connected agents through the
 * interview_next tool, so they can be answered in the flow of ordinary work
 * rather than here.
 */
export function Train({
  boot,
  toast,
  reload,
}: {
  boot: Bootstrap;
  toast: (m: string, t?: 'ok' | 'danger') => void;
  reload: () => void;
}) {
  const questions = useAsync<InterviewQ[]>(() => api.interview(), []);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const [index, setIndex] = useState(0);

  const open = questions.data ?? [];
  const current = open[index];

  const submit = async () => {
    if (!current || answer.trim().length < 2) return;
    setBusy(true);
    try {
      await api.answer(current.id, answer.trim());
      toast('Recorded — it will reach every tool you connect', 'ok');
      setAnswer('');
      setIndex(0);
      questions.reload();
      reload();
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(false);
    }
  };

  const skip = async () => {
    if (!current) return;
    await api.skipQuestion(current.id);
    setAnswer('');
    setIndex(0);
    questions.reload();
    reload();
  };

  // Completeness is a rough signal rather than a real metric, and it is
  // presented as one. Pretending to a precise percentage would imply Orbis
  // knows the size of what it does not know.
  const answered = boot.counts.memories;
  const completeness = Math.min(100, Math.round((answered / (answered + open.length || 1)) * 100));

  return (
    <>
      <div className="grid-3">
        <div className="stat">
          <div className="label">Open questions</div>
          <div className="value">{open.length}</div>
          <div className="foot">things Orbis has not worked out yet</div>
        </div>
        <div className="stat">
          <div className="label">Known</div>
          <div className="value">{answered}</div>
          <div className="foot">memories on file</div>
        </div>
        <div className="stat">
          <div className="label">Coverage</div>
          <div className="value">{completeness}%</div>
          <div className="foot">rough — answered against outstanding</div>
        </div>
      </div>

      {!open.length ? (
        <div className="card">
          <Empty
            icon="◔"
            title="Nothing outstanding"
            hint="Orbis generates questions during consolidation. Run npm run dream, or connect a tool and let it work for a while."
          />
        </div>
      ) : (
        <>
          <div className="card">
            <div className="card-head">
              <h3>{current?.topic ?? 'Question'}</h3>
              <span className="hint">
                {index + 1} of {open.length}
              </span>
              <div className="spacer" />
              {current && current.priority >= 8 && <Badge tone="accent">high value</Badge>}
            </div>

            <div className="card-body col" style={{ gap: 12 }}>
              <div style={{ fontSize: 17, fontWeight: 550, lineHeight: 1.4 }}>
                {current?.question}
              </div>
              {current?.why && (
                <div className="faint" style={{ fontSize: 13.5, marginTop: -6 }}>
                  {current.why}
                </div>
              )}

              <textarea
                className="input"
                rows={3}
                autoFocus
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
                }}
                placeholder="A sentence is plenty."
              />

              <div className="row">
                <span className="faint" style={{ fontSize: 13 }}>
                  <span className="kbd">⌘</span> <span className="kbd">↵</span> to save
                </span>
                <div className="spacer" />
                <button className="btn ghost" onClick={skip} disabled={boot.readOnly}>Skip</button>
                {open.length > 1 && (
                  <button
                    className="btn ghost"
                    onClick={() => setIndex((i) => (i + 1) % open.length)}
                  >
                    Next question
                  </button>
                )}
                <button
                  className="btn primary"
                  onClick={submit}
                  disabled={boot.readOnly || busy || answer.trim().length < 2}
                  title={boot.readOnly ? 'Answering writes a memory, and the public demo is read-only.' : undefined}
                >
                  {busy ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h3>Also outstanding</h3>
              <span className="hint">your agents can ask these too, in context</span>
            </div>
            <table>
              <thead>
                <tr><th>Topic</th><th>Question</th><th style={{ width: 70 }} /></tr>
              </thead>
              <tbody>
                {open.map((q, i) => (
                  <tr
                    key={q.id}
                    className="clickable"
                    style={{ opacity: i === index ? 1 : 0.75 }}
                    onClick={() => { setIndex(i); setAnswer(''); }}
                  >
                    <td><Badge>{q.topic}</Badge></td>
                    <td>{q.question}</td>
                    <td style={{ textAlign: 'right' }}>
                      {i === index && <Badge tone="accent">current</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div className="banner info">
        <span className="dot" />
        <div className="body">
          <strong>These questions reach your agents too.</strong> Any connected tool can call{' '}
          <code className="mono">interview_next</code> and ask you in the middle of ordinary
          work, which is usually a better moment than a form.
        </div>
      </div>
    </>
  );
}
