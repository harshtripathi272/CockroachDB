import { useState } from 'react';
import { api, type AgentResult } from './api';
import { Badge, Id, statusTone } from './components';

/**
 * The agent, with its working shown.
 *
 * A support bot that just returns an answer is not interesting. What is
 * interesting is that you can watch it recall, see exactly which beliefs it
 * cited, and see the decision land with its lineage attached — and then go
 * straight to Investigate and trace what that decision would contaminate if one
 * of those beliefs turned out to be false.
 *
 * The "let the agent generalise" toggle is the honest part. Turning it on lets
 * the agent write a new belief inferred from its own approval, which is how
 * real agents drift. It is off by default because it is a loaded gun, and
 * visible because hiding it would be the dishonest choice.
 */

const EXAMPLES = [
  'My father passed away and I could not fly on NW-221 in March. I want a refund of $3400 for the bereavement fare.',
  'What is the checked baggage allowance on an economy ticket?',
  'Please waive the change fee on my saver fare, I need to move to September 2nd.',
  'Please upgrade me to a private jet, free of charge.',
];

export function Agent({ onChanged }: { onChanged: () => Promise<void> }) {
  const [request, setRequest] = useState(EXAMPLES[0]);
  const [reflect, setReflect] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AgentResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.runAgent(request, reflect);
      setResult(r);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const total = result
    ? result.timings.recallMs + result.timings.reasonMs + result.timings.commitMs
    : 0;

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h3>Customer request</h3>
          <span className="hint">the agent may only act on beliefs it can cite</span>
        </div>
        <div className="card-body col" style={{ gap: 10 }}>
          <textarea
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            rows={3}
            style={{
              width: '100%', padding: '8px 10px', font: 'inherit', fontSize: 13,
              border: '1px solid var(--border-strong)', borderRadius: 'var(--radius)',
              background: 'var(--surface)', color: 'var(--text)', resize: 'vertical',
            }}
          />

          <div className="row wrap" style={{ gap: 6 }}>
            {EXAMPLES.map((ex, i) => (
              <button key={i} className="btn ghost" style={{ fontSize: 11.5 }}
                      onClick={() => setRequest(ex)}>
                {ex.length > 38 ? `${ex.slice(0, 37)}…` : ex}
              </button>
            ))}
          </div>

          <div className="row">
            <label className="row muted" style={{ gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
              <input type="checkbox" checked={reflect}
                     onChange={(e) => setReflect(e.target.checked)} />
              Let the agent generalise from its own decision
              <span className="faint">(this is how drift starts)</span>
            </label>
            <div className="spacer" />
            <button className="btn primary" onClick={run} disabled={busy || request.trim().length < 3}>
              {busy ? 'Thinking…' : 'Run agent'}
            </button>
          </div>

          {error && <div className="banner danger"><span className="dot" />{error}</div>}
        </div>
      </div>

      {result && (
        <>
          <div className="grid-3">
            <div className="stat">
              <div className="label">Recall</div>
              <div className="value" style={{ fontSize: 21 }}>{result.timings.recallMs}ms</div>
              <div className="foot">{result.recalled.length} beliefs considered</div>
            </div>
            <div className="stat">
              <div className="label">Reason</div>
              <div className="value" style={{ fontSize: 21 }}>{result.timings.reasonMs}ms</div>
              <div className="foot mono" style={{ fontSize: 10.5 }}>{result.verdict.reasoner}</div>
            </div>
            <div className="stat">
              <div className="label">Atomic commit</div>
              <div className="value" style={{ fontSize: 21 }}>{result.timings.commitMs}ms</div>
              <div className="foot">decision + lineage + effect · {total}ms total</div>
            </div>
          </div>

          {/* ------------------------------------------------------ verdict */}
          <div className="card">
            <div className="card-head">
              <h3>Verdict</h3>
              <Badge tone={result.verdict.approve ? 'ok' : 'danger'}>
                {result.verdict.action.replace(/_/g, ' ')}
              </Badge>
              <div className="spacer" />
              {result.decisionId ? (
                <span className="id">committed <Id value={result.decisionId} /></span>
              ) : (
                <Badge tone="neutral">nothing committed</Badge>
              )}
            </div>
            <div className="card-body">
              <div className={`claim${result.verdict.approve ? '' : ' tainted'}`}>
                {result.verdict.rationale}
              </div>
              {!result.decisionId && (
                <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
                  No belief supported this request, so the agent declined rather than
                  acting. An action with no recorded cause is the exact thing this
                  system refuses to create.
                </p>
              )}
            </div>
          </div>

          {/* ------------------------------------------------------ lineage */}
          <div className="card">
            <div className="card-head">
              <h3>Beliefs cited</h3>
              <span className="hint">
                written to <code className="mono">decision_input</code> in the same transaction as the decision
              </span>
            </div>
            <table>
              <thead>
                <tr><th>Weight</th><th>Subject</th><th>Claim</th><th>Kind</th><th>Status</th></tr>
              </thead>
              <tbody>
                {result.verdict.used.map((u) => {
                  const b = result.recalled.find((x) => x.id === u.beliefId);
                  return (
                    <tr key={u.beliefId}>
                      <td className="num">{u.weight.toFixed(2)}</td>
                      <td className="mono" style={{ whiteSpace: 'nowrap' }}>{b?.subject ?? '—'}</td>
                      <td className="muted truncate">{b?.claim ?? <Id value={u.beliefId} />}</td>
                      <td>{b && <Badge>{b.kind}</Badge>}</td>
                      <td>{b && <Badge tone={statusTone(b.status)}>{b.status}</Badge>}</td>
                    </tr>
                  );
                })}
                {result.verdict.used.length === 0 && (
                  <tr><td colSpan={5}><div className="empty">No beliefs cited.</div></td></tr>
                )}
              </tbody>
            </table>
          </div>

          {/* --------------------------------------------------- reflection */}
          {result.reflection && (
            <div className="card">
              <div className="card-head">
                <h3>The agent generalised</h3>
                <Badge tone="taint" dot pulse>new belief</Badge>
              </div>
              <div className="card-body">
                <div className="claim tainted">{result.reflection.claim}</div>
                <p className="faint" style={{ fontSize: 11.5, marginTop: 8 }}>
                  This belief is tagged <code className="mono">derived_from_decision</code>, pointing
                  at the decision that just ran. That edge is what makes contamination
                  transitive: if a belief behind that decision is later falsified, every
                  future decision built on this generalisation is traceable too.
                </p>
              </div>
            </div>
          )}

          {/* ------------------------------------------------ what it saw */}
          <div className="card">
            <div className="card-head">
              <h3>What the agent recalled</h3>
              <span className="hint">
                vector search over active beliefs only — quarantined ones are excluded by the index
              </span>
            </div>
            <table>
              <thead>
                <tr><th>Subject</th><th>Claim</th><th>Kind</th><th>Confidence</th><th>Cited</th></tr>
              </thead>
              <tbody>
                {result.recalled.map((b) => {
                  const cited = result.verdict.used.some((u) => u.beliefId === b.id);
                  return (
                    <tr key={b.id} style={{ opacity: cited ? 1 : 0.55 }}>
                      <td className="mono" style={{ whiteSpace: 'nowrap' }}>{b.subject}</td>
                      <td className="muted truncate">{b.claim}</td>
                      <td><Badge>{b.kind}</Badge></td>
                      <td className="num">{b.confidence.toFixed(2)}</td>
                      <td>{cited ? <Badge tone="accent">used</Badge> : <span className="faint">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
