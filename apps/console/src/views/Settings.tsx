import { useState } from 'react';
import { api } from '../lib/api.ts';
import type { SettingsPayload } from '../lib/api.ts';
import { Badge, useAsync } from '../lib/ui.tsx';

/**
 * Settings — the one place a key gets pasted.
 *
 * Every feature that needs an outside service used to say "set this
 * environment variable and restart", which is fine for whoever deployed it and
 * useless for anyone else. A key entered here is stored against the account and
 * pushed into the environment, so the feature it unlocks starts working on the
 * next request with no redeploy.
 *
 * Keys are never sent back to the browser. Once saved you get a yes/no and the
 * last four characters — enough to confirm which key is in place, without this
 * page becoming somewhere secrets can be read out of.
 */

interface KeyFieldSpec {
  id: 'anthropicKey' | 'openaiKey' | 'crdbCloudKey';
  label: string;
  unlocks: string;
  where: string;
  placeholder: string;
}

const KEYS: KeyFieldSpec[] = [
  {
    id: 'anthropicKey',
    label: 'Anthropic',
    unlocks: 'Lets Ask write real answers instead of only quoting what it found.',
    where: 'console.anthropic.com → API keys',
    placeholder: 'sk-ant-…',
  },
  {
    id: 'openaiKey',
    label: 'OpenAI',
    unlocks: 'Same thing, if you would rather use GPT. Either key is enough.',
    where: 'platform.openai.com → API keys',
    placeholder: 'sk-…',
  },
  {
    id: 'crdbCloudKey',
    label: 'CockroachDB Cloud',
    unlocks: 'Lets Orbis ask your database about itself — nodes, schemas, query plans.',
    where: 'CockroachDB Cloud → Access Management → Service Accounts → API key',
    placeholder: 'service account secret',
  },
];

export function Settings({
  toast,
  readOnly = false,
}: {
  toast: (m: string, t?: 'ok' | 'danger') => void;
  readOnly?: boolean;
}) {
  const state = useAsync<SettingsPayload>(() => api.settings(), []);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const s = state.data;

  async function save(id: string, value: string | null) {
    setBusy(id);
    try {
      await api.saveSettings({ [id]: value ?? '' });
      setDrafts((d) => ({ ...d, [id]: '' }));
      state.reload();
      toast(value ? 'Saved — it is live now' : 'Removed');
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(null);
    }
  }

  async function toggleDecay(next: boolean) {
    setBusy('decay');
    try {
      await api.saveSettings({ decayEnabled: next });
      state.reload();
      toast(next ? 'Fading turned on' : 'Fading turned off');
    } catch (e) {
      toast((e as Error).message, 'danger');
    } finally {
      setBusy(null);
    }
  }

  if (!s) return <div className="skeleton" style={{ height: 300 }} />;

  return (
    <>
      {readOnly && (
        <div className="banner">
          <span className="dot" />
          <div className="body">
            <strong>Settings are locked on the public demo.</strong> You can see how the
            page works, but saving needs an API token — otherwise any visitor could
            change keys for everyone.
          </div>
        </div>
      )}
      <div className="card">
        <div className="card-head">
          <h3>Keys</h3>
          <span className="hint">optional — everything else works without them</span>
          <div className="spacer" />
          <Badge tone={s.chat.generative ? 'ok' : undefined}>
            {s.chat.generative ? 'Ask can write answers' : 'Ask quotes only'}
          </Badge>
        </div>

        <div className="set-list">
          {KEYS.map((k) => {
            const cur = s.settings[k.id];
            return (
              <div className="set-row" key={k.id}>
                <div className="set-info">
                  <div className="row" style={{ gap: 9 }}>
                    <strong>{k.label}</strong>
                    {cur.set ? (
                      <Badge tone="ok">set · {cur.hint}</Badge>
                    ) : (
                      <Badge>not set</Badge>
                    )}
                  </div>
                  <div className="faint" style={{ marginTop: 4 }}>{k.unlocks}</div>
                  <div className="faint" style={{ marginTop: 3, fontSize: 13.5 }}>
                    Get one from {k.where}
                  </div>
                </div>

                <div className="set-action">
                  <input
                    className="input"
                    type="password"
                    autoComplete="off"
                    placeholder={cur.set ? 'Replace with a new key' : k.placeholder}
                    value={drafts[k.id] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [k.id]: e.target.value }))}
                  />
                  <div className="row" style={{ gap: 8 }}>
                    <button
                      className="btn primary"
                      disabled={readOnly || busy !== null || !(drafts[k.id] ?? '').trim()}
                      onClick={() => save(k.id, (drafts[k.id] ?? '').trim())}
                    >
                      {busy === k.id ? 'Saving…' : 'Save'}
                    </button>
                    {cur.set && (
                      <button
                        className="btn danger"
                        disabled={readOnly || busy !== null}
                        onClick={() => save(k.id, null)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Fading</h3>
          <span className="hint">off by default</span>
        </div>
        <div className="set-list">
          <div className="set-row">
            <div className="set-info">
              <div className="row" style={{ gap: 9 }}>
                <strong>Let unused memories fade</strong>
                {s.settings.decayEnabled ? <Badge tone="warn">on</Badge> : <Badge>off</Badge>}
              </div>
              <div className="faint" style={{ marginTop: 4 }}>
                Memories you never mention again slowly lose confidence, and eventually stop
                showing up in ordinary recall. Nothing is deleted — you can always find a faded
                memory by searching for it.
              </div>
              <div className="faint" style={{ marginTop: 3, fontSize: 13.5 }}>
                Leave this off unless you want your memory to behave more like a person's.
              </div>
            </div>
            <div className="set-action">
              <button
                className="btn"
                disabled={readOnly || busy !== null}
                onClick={() => toggleDecay(!s.settings.decayEnabled)}
              >
                {busy === 'decay'
                  ? 'Saving…'
                  : s.settings.decayEnabled ? 'Turn fading off' : 'Turn fading on'}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-head"><h3>How Ask is answering right now</h3></div>
        <div className="card-body">
          <p className="prose" style={{ marginBottom: 14 }}>{s.chat.reason}</p>
          {s.chat.models.length > 0 && (
            <table>
              <thead><tr><th>Model</th><th>From</th><th>Notes</th></tr></thead>
              <tbody>
                {s.chat.models.map((m) => (
                  <tr key={m.id}>
                    <td><strong>{m.label}</strong></td>
                    <td className="faint">{m.provider}</td>
                    <td className="faint">{m.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
