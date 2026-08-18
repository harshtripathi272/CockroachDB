import { useState } from 'react';
import { api } from '../lib/api.ts';
import type { ApiToken, Bootstrap } from '../lib/api.ts';
import { Badge, CodeBlock, Empty, relTime, useAsync } from '../lib/ui.tsx';

/**
 * Setup.
 *
 * The whole proposition is "one endpoint, every tool", so this page has one
 * job: get a token into the user's hands and give them a config they can paste
 * without thinking. Everything else is secondary.
 *
 * The connection indicator is driven by real MCP handshakes recorded in
 * client_connection — it turns green because a client actually connected, not
 * because someone ticked a box. That distinction is the difference between a
 * setup page that helps and one that lies to you.
 */

interface Client {
  id: string;
  name: string;
  /** Substring matched against the clientInfo.name a client reports. */
  match: string[];
  where: string;
  lang: string;
  config: (url: string, token: string) => string;
  note?: string;
}

const CLIENTS: Client[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    match: ['claude-code', 'claude code'],
    where: 'Run this in your terminal',
    lang: 'bash',
    config: (url, token) =>
      `claude mcp add --transport http orbis ${url} \\\n  --header "Authorization: Bearer ${token}"`,
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    match: ['codex'],
    where: '~/.codex/config.toml',
    lang: 'toml',
    config: (url, token) =>
      `[mcp_servers.orbis]\nurl = "${url}"\n\n[mcp_servers.orbis.http_headers]\nAuthorization = "Bearer ${token}"`,
    note: 'Codex also exposes this under MCP Settings → Add server → Streamable HTTP.',
  },
  {
    id: 'opencode',
    name: 'opencode',
    match: ['opencode'],
    where: '~/.config/opencode/opencode.json',
    lang: 'json',
    config: (url, token) =>
      JSON.stringify(
        {
          $schema: 'https://opencode.ai/config.json',
          mcp: {
            orbis: {
              type: 'remote',
              url,
              enabled: true,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      ),
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    match: ['antigravity', 'gemini'],
    where: '~/.gemini/config/mcp_config.json',
    lang: 'json',
    config: (url, token) =>
      JSON.stringify(
        { mcpServers: { orbis: { httpUrl: url, headers: { Authorization: `Bearer ${token}` } } } },
        null,
        2,
      ),
  },
  {
    id: 'cursor',
    name: 'Cursor',
    match: ['cursor'],
    where: '~/.cursor/mcp.json  ·  or Settings → MCP → Add',
    lang: 'json',
    config: (url, token) =>
      JSON.stringify(
        { mcpServers: { orbis: { url, headers: { Authorization: `Bearer ${token}` } } } },
        null,
        2,
      ),
  },
  {
    id: 'claude-desktop',
    name: 'Claude Desktop',
    match: ['claude-desktop', 'claude-ai'],
    where: '%APPDATA%\\Claude\\claude_desktop_config.json  ·  macOS: ~/Library/Application Support/Claude/',
    lang: 'json',
    config: (url, token) =>
      JSON.stringify(
        {
          mcpServers: {
            orbis: {
              command: 'npx',
              args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${token}`],
            },
          },
        },
        null,
        2,
      ),
    note:
      'Claude Desktop speaks stdio, so mcp-remote bridges it to the HTTP endpoint. Note this is mcp-remote — the package named @modelcontextprotocol/server-http-sse that circulates in setup guides does not exist on npm.',
  },
  {
    id: 'zed',
    name: 'Zed',
    match: ['zed'],
    where: 'settings.json',
    lang: 'json',
    config: (url, token) =>
      JSON.stringify(
        {
          context_servers: {
            orbis: {
              source: 'custom',
              command: 'npx',
              args: ['-y', 'mcp-remote', url, '--header', `Authorization: Bearer ${token}`],
            },
          },
        },
        null,
        2,
      ),
  },
  {
    id: 'cline',
    name: 'Cline / Roo',
    match: ['cline', 'roo'],
    where: 'cline_mcp_settings.json',
    lang: 'json',
    config: (url, token) =>
      JSON.stringify(
        {
          mcpServers: {
            orbis: {
              type: 'streamableHttp',
              url,
              headers: { Authorization: `Bearer ${token}` },
              disabled: false,
            },
          },
        },
        null,
        2,
      ),
  },
  {
    id: 'hermes',
    name: 'Hermes Agent',
    match: ['hermes'],
    where: 'Hermes MCP configuration',
    lang: 'json',
    config: (url, token) =>
      JSON.stringify(
        { mcpServers: { orbis: { url, transport: 'http', headers: { Authorization: `Bearer ${token}` } } } },
        null,
        2,
      ),
    note:
      'Hermes already bridges Telegram, Discord, Slack, WhatsApp and email. Connecting it here puts your Orbis memory on every one of those surfaces without any extra work.',
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    match: ['chatgpt', 'openai'],
    where: 'Settings → Connectors → Advanced → Developer mode → Add custom connector',
    lang: 'text',
    config: (url, token) => `URL          ${url}\nAuth         Bearer\nToken        ${token}`,
    note:
      'ChatGPT’s deep-research path only ever calls two tools named search and fetch, so Orbis exposes those alongside its own. Developer mode is beta, and write-capable connectors need a Business, Enterprise or Edu plan.',
  },
  {
    id: 'custom',
    name: 'Anything else',
    match: [],
    where: 'Any MCP client that speaks Streamable HTTP',
    lang: 'bash',
    config: (url, token) =>
      `curl -X POST ${url} \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -H "MCP-Protocol-Version: 2025-06-18" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`,
    note: 'If the tool speaks MCP over HTTP, this endpoint works. There is nothing client-specific about it.',
  },
];

export function Setup({
  boot,
  reload,
  toast,
}: {
  boot: Bootstrap;
  reload: () => void;
  toast: (m: string, t?: 'ok' | 'danger') => void;
}) {
  const [client, setClient] = useState<Client>(CLIENTS[0]);
  const [revealed, setRevealed] = useState<{ token: string; name: string } | null>(null);
  const tokens = useAsync<ApiToken[]>(() => api.tokens(), []);

  const endpoint = `${window.location.origin}/api/mcp`;
  const live = tokens.data?.find((t) => !t.revoked_at);
  // The plaintext exists only in this tab, only until reload. After that the
  // hash is all the server has, so a placeholder makes the shape obvious
  // without pretending the real value is recoverable.
  const tokenForConfig = revealed?.token ?? (live ? `${live.prefix}…` : 'orb_live_…');

  const connected = boot.connections;
  const connectionFor = (c: Client) =>
    connected.find((conn) =>
      c.match.some((m) => conn.client_name.toLowerCase().includes(m)),
    );

  const createToken = async () => {
    try {
      const t = await api.createToken(`${client.name} · ${new Date().toLocaleDateString()}`);
      setRevealed({ token: t.token, name: t.name });
      tokens.reload();
      toast('Token created — copy it now, it is not shown again', 'ok');
    } catch (e) {
      toast((e as Error).message, 'danger');
    }
  };

  return (
    <>
      {/* --------------------------------------------------------- endpoint */}
      <div className="card">
        <div className="card-head">
          <h3>1 &middot; Your address</h3>
          <span className="hint">one link, the same for every tool</span>
          <div className="spacer" />
          <Badge tone={boot.target === 'cloud' ? 'accent' : undefined}>{boot.target}</Badge>
        </div>
        <div className="card-body col" style={{ gap: 12 }}>
          <CodeBlock code={endpoint} />

          <div className="row" style={{ gap: 8 }}>
            <button className="btn primary" onClick={createToken}>
              Create a token
            </button>
            <span className="faint" style={{ fontSize: 12.5 }}>
              {tokens.data?.filter((t) => !t.revoked_at).length ?? 0} active
            </span>
          </div>

          {revealed && (
            <div className="banner ok">
              <span className="dot" />
              <div className="body">
                <strong>Copy this now.</strong> Only the hash is stored, so it cannot be
                shown again.
                <div style={{ marginTop: 7 }}>
                  <CodeBlock code={revealed.token} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ----------------------------------------------------------- client */}
      <div className="card">
        <div className="card-head">
          <h3>2 &middot; Paste it into your tool</h3>
          <span className="hint">pick yours — copy the block exactly as it is</span>
        </div>

        <div className="card-body col" style={{ gap: 12 }}>
          <div className="row wrap" style={{ gap: 6 }}>
            {CLIENTS.map((c) => {
              const conn = connectionFor(c);
              return (
                <button
                  key={c.id}
                  className={`btn${client.id === c.id ? ' primary' : ''}`}
                  onClick={() => setClient(c)}
                  style={{ fontSize: 12.5 }}
                >
                  {conn && <span className="dot" style={{ color: 'var(--ok)' }} />}
                  {c.name}
                </button>
              );
            })}
          </div>

          <div className="col" style={{ gap: 6 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className="faint" style={{ fontSize: 12 }}>{client.where}</span>
            </div>
            <CodeBlock code={client.config(endpoint, tokenForConfig)} lang={client.lang} />
            {!revealed && live && (
              <div className="faint" style={{ fontSize: 11.5 }}>
                The token above is truncated. Create a new one to get a pasteable value.
              </div>
            )}
            {client.note && (
              <div className="banner info" style={{ marginTop: 2 }}>
                <span className="dot" />
                <div className="body" style={{ fontSize: 12.5 }}>{client.note}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------ connections */}
      <div className="card">
        <div className="card-head">
          <h3>3 &middot; Check it worked</h3>
          <span className="hint">
            {connected.length === 0
              ? 'nothing has connected yet — this updates on its own'
              : 'these tools really did connect; nothing here is typed in by hand'}
          </span>
          <div className="spacer" />
          {connected.length === 0 ? (
            <Badge dot pulse>listening</Badge>
          ) : (
            <Badge tone="ok" dot>{connected.length} live</Badge>
          )}
          <button className="btn sm ghost" onClick={reload}>refresh</button>
        </div>

        {connected.length === 0 ? (
          <Empty
            icon="◎"
            title="Nothing has connected yet"
            hint="Paste the config above into a tool and it will appear here within a few seconds."
          />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Client</th>
                <th>Protocol</th>
                <th className="num">Calls</th>
                <th>First seen</th>
                <th>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {connected.map((c) => (
                <tr key={c.client_name}>
                  <td>
                    <span className="row" style={{ gap: 6 }}>
                      <span className="dot" style={{ color: 'var(--ok)' }} />
                      <strong>{c.client_name}</strong>
                      {c.client_version && <span className="faint">{c.client_version}</span>}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{c.protocol || '—'}</td>
                  <td className="num">{c.call_count}</td>
                  <td className="faint">{relTime(c.first_seen)}</td>
                  <td>{relTime(c.last_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ----------------------------------------------------------- tokens */}
      <div className="card">
        <div className="card-head">
          <h3>Your keys</h3>
          <span className="hint">a key is how a tool proves it&rsquo;s yours &mdash; revoke one and that tool loses access immediately</span>
        </div>
        {!tokens.data?.length ? (
          <Empty title="No tokens yet" hint="Create one above to connect your first tool." />
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Prefix</th><th>Scopes</th>
                <th>Created</th><th>Last used</th><th />
              </tr>
            </thead>
            <tbody>
              {tokens.data.map((t) => (
                <tr key={t.id} style={{ opacity: t.revoked_at ? 0.45 : 1 }}>
                  <td>{t.name}</td>
                  <td className="mono" style={{ fontSize: 11.5 }}>{t.prefix}…</td>
                  <td>
                    {t.scopes.map((s) => (
                      <Badge key={s}>{s}</Badge>
                    ))}
                  </td>
                  <td className="faint">{relTime(t.created_at)}</td>
                  <td className="faint">{t.last_used_at ? relTime(t.last_used_at) : 'never'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {t.revoked_at ? (
                      <Badge tone="danger">revoked</Badge>
                    ) : (
                      <button
                        className="btn sm danger"
                        onClick={async () => {
                          await api.revokeToken(t.id);
                          tokens.reload();
                          toast('Token revoked');
                        }}
                      >
                        revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ---------------------------------------------------------- runtime */}
      <div className="card">
        <div className="card-head">
          <h3>What&rsquo;s running</h3>
          <span className="hint">measured right now, not read from a config file</span>
        </div>
        <div className="card-body">
          <div className="grid-3">
            <div>
              <div className="faint" style={{ fontSize: 12.5 }}>Understanding meaning</div>
              <div style={{ fontWeight: 550, marginTop: 2 }}>{boot.embedder.label}</div>
              <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                {boot.embedder.semantic ? (
                  <Badge tone="ok">genuinely semantic</Badge>
                ) : (
                  <Badge tone="warn">keyword overlap only</Badge>
                )}
              </div>
            </div>
            <div>
              <div className="faint" style={{ fontSize: 12.5 }}>Where it&rsquo;s stored</div>
              <div style={{ fontWeight: 550, marginTop: 2 }}>CockroachDB · {boot.target}</div>
              <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                {boot.counts.memories} memories · {boot.counts.entities} entities
              </div>
            </div>
            <div>
              <div className="faint" style={{ fontSize: 12.5 }}>Used so far</div>
              <div style={{ fontWeight: 550, marginTop: 2 }}>{boot.counts.calls} tool calls</div>
              <div className="faint" style={{ fontSize: 11.5, marginTop: 2 }}>
                across {connected.length} client{connected.length === 1 ? '' : 's'}
              </div>
            </div>
          </div>

          {boot.embedder.rejected.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="faint" style={{ fontSize: 11, marginBottom: 4 }}>
                Also tried, and not available here
              </div>
              {boot.embedder.rejected.map((r) => (
                <div key={r.id} className="faint" style={{ fontSize: 11.5 }}>
                  <code className="mono">{r.id}</code> — {r.error}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
