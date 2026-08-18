import { useState } from 'react';
import { Icon } from '../lib/icons.tsx';

/**
 * First-run onboarding.
 *
 * Someone arriving here cold sees eight tabs and no idea what any of them are
 * for. The tabs each explain themselves now, but that only helps once you are
 * already on one — it does not answer "what is this thing and why would I
 * want it".
 *
 * So: three cards on what the product does, then a plain map of every tab, and
 * one button. It shows once, is dismissible, and can be reopened from the
 * sidebar. No modal, no forced tour, nothing to click through — a person who
 * already knows what they are doing can ignore all of it and start working.
 */

const STEPS = [
  {
    n: '1',
    title: 'Connect your tools once',
    body: 'Paste one address into Claude, Cursor, ChatGPT — any tool that speaks MCP. You do this a single time, per tool.',
  },
  {
    n: '2',
    title: 'They start sharing a memory',
    body: 'Anything one tool learns about you, the others can read. Tell Cursor your deploy process and Claude knows it too.',
  },
  {
    n: '3',
    title: 'You stop repeating yourself',
    body: 'No more explaining your stack at the start of every chat. The context is already there when the conversation opens.',
  },
];

const MAP: Array<{ icon: string; name: string; what: string }> = [
  { icon: 'plug',     name: 'Connect',       what: 'Get your address and key, and paste them into a tool. Start here.' },
  { icon: 'chat',     name: 'Ask',           what: 'Ask your memory a question and see which saved notes the answer came from.' },
  { icon: 'person',   name: 'About you',     what: 'The profile your tools read. Built from what you have saved, not guessed.' },
  { icon: 'question', name: 'Fill the gaps', what: 'Questions nothing has answered yet. Each answer improves every tool at once.' },
  { icon: 'list',     name: 'Memories',      what: 'Everything saved, searchable by meaning rather than exact words.' },
  { icon: 'folders',  name: 'Projects',      what: 'Keep work and personal separate, so a tool only sees what is relevant.' },
  { icon: 'nodes',    name: 'Connections',   what: 'The people, tools and projects that keep coming up, and how they link.' },
  { icon: 'pulse',    name: 'Activity',      what: 'What your tools have been reading and writing. Handy for checking a setup works.' },
];

export function Welcome({ onDone }: { onDone: () => void }) {
  return (
    <div className="welcome">
      <div className="welcome-hero">
        <h2>One memory, shared by every AI tool you use.</h2>
        <p className="prose" style={{ fontSize: 17 }}>
          Your tools each keep their own notes and none of them can see the others.
          Orbis is one place they all read and write, so what you tell one, the rest know.
        </p>
      </div>

      <div className="grid-3">
        {STEPS.map((s) => (
          <div className="step-card" key={s.n}>
            <span className="step-n">{s.n}</span>
            <h4>{s.title}</h4>
            <p>{s.body}</p>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <h3>What each tab is for</h3>
          <span className="hint">you can come back to this any time</span>
        </div>
        <div className="tab-map">
          {MAP.map((m) => (
            <div className="tab-map-row" key={m.name}>
              <span className="tab-map-ico"><Icon name={m.icon} /></span>
              <div>
                <strong>{m.name}</strong>
                <div className="faint">{m.what}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="row" style={{ justifyContent: 'center', paddingTop: 4 }}>
        <button className="btn primary" onClick={onDone}>Got it — take me to Connect</button>
      </div>
    </div>
  );
}

/** The "show me that again" entry point, parked at the bottom of the sidebar. */
export function useWelcome() {
  const [seen, setSeen] = useState(() => localStorage.getItem('orbis-welcomed') === '1');

  return {
    seen,
    dismiss: () => { localStorage.setItem('orbis-welcomed', '1'); setSeen(true); },
    reopen: () => { localStorage.removeItem('orbis-welcomed'); setSeen(false); },
  };
}
