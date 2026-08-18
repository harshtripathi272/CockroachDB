/**
 * Navigation icons.
 *
 * These replace a set of abstract geometric glyphs (◎ ◍ ◔ ◈ ◊) that were
 * decorative and told you nothing — a circle with a dot in it does not mean
 * "profile" to anyone who did not choose it. A drawn icon that looks like the
 * thing it stands for is doing actual work: it lets someone find "projects"
 * without reading, and it gives the label a second chance at being understood.
 *
 * Hand-written rather than pulled from an icon package, because ten icons is
 * not worth a dependency, and because these need to sit on a 16px grid with
 * one consistent stroke weight to look like a set rather than a collection.
 *
 * All of them inherit `currentColor`, so the active/hover states in the nav
 * need no icon-specific styling, and they are marked aria-hidden — the text
 * label beside them is the accessible name, and announcing both would just
 * make a screen reader say everything twice.
 */

const PATHS: Record<string, React.ReactNode> = {
  // connect — two links of a chain meeting
  plug: (
    <>
      <path d="M6.5 9.5 9.5 6.5" />
      <path d="M8.6 4.4l1-1a2.7 2.7 0 0 1 3.8 3.8l-1 1" />
      <path d="M7.4 11.6l-1 1a2.7 2.7 0 0 1-3.8-3.8l1-1" />
    </>
  ),
  // ask — a speech bubble
  chat: (
    <>
      <path d="M13.5 8.2c0 2.6-2.5 4.7-5.5 4.7a6.6 6.6 0 0 1-1.8-.24L3 13.8l1-2.4A4.4 4.4 0 0 1 2.5 8.2C2.5 5.6 5 3.5 8 3.5s5.5 2.1 5.5 4.7Z" />
    </>
  ),
  // about you — head and shoulders
  person: (
    <>
      <circle cx="8" cy="5.6" r="2.4" />
      <path d="M3.4 13.2a4.8 4.8 0 0 1 9.2 0" />
    </>
  ),
  // fill the gaps — a question
  question: (
    <>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M6.5 6.4a1.6 1.6 0 0 1 3.1.5c0 1.1-1.6 1.4-1.6 2.4" />
      <path d="M8 11.4h.01" />
    </>
  ),
  // memories — a list of entries
  list: (
    <>
      <path d="M6 4.6h7.2M6 8h7.2M6 11.4h7.2" />
      <path d="M3.2 4.6h.01M3.2 8h.01M3.2 11.4h.01" />
    </>
  ),
  // projects — stacked folders
  folders: (
    <>
      <path d="M2.6 6.2v6.2a1 1 0 0 0 1 1h8.8a1 1 0 0 0 1-1V6.2H2.6Z" />
      <path d="M2.6 6.2V4a1 1 0 0 1 1-1h2.3l1.3 1.6h4.2a1 1 0 0 1 1 1v.6" />
    </>
  ),
  // connections — nodes joined by edges
  nodes: (
    <>
      <circle cx="4" cy="4.4" r="1.8" />
      <circle cx="12" cy="6.4" r="1.8" />
      <circle cx="7" cy="12.2" r="1.8" />
      <path d="M5.6 5.5 10.4 5.9M11.2 8 8.1 10.7M5 6.1l1.4 4.4" />
    </>
  ),
  // activity — a heartbeat
  pulse: (
    <>
      <path d="M1.8 8h2.9l1.6-4 2.6 8 1.7-4h3.6" />
    </>
  ),
  // settings — sliders, not a cog; a cog reads as "system config" and this is
  // mostly "paste a key".
  sliders: (
    <>
      <path d="M2.4 5.2h5M10.6 5.2h3M2.4 10.8h3M8.6 10.8h5" />
      <circle cx="8.8" cy="5.2" r="1.7" />
      <circle cx="6.8" cy="10.8" r="1.7" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.6v1.5M8 12.9v1.5M14.4 8h-1.5M3.1 8H1.6M12.5 3.5l-1 1M4.5 11.5l-1 1M12.5 12.5l-1-1M4.5 4.5l-1-1" />
    </>
  ),
  moon: (
    <>
      <path d="M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8a5.6 5.6 0 1 0 6.8 6.8Z" />
    </>
  ),
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg
      className="ico"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {d}
    </svg>
  );
}
