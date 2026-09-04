import { useSyncExternalStore } from "react";

/**
 * App-wide settings, as opposed to per-project layout (that's session.ts).
 *
 * Same storage decision as the session for the same reason: localStorage reads
 * synchronously, so the very first editor an opened project mounts can be in
 * the right theme instead of flashing the default and correcting itself.
 */

const KEY = "zero-settings";

export const EDITOR_THEMES = ["dark-modern", "trmnl"] as const;
export type EditorTheme = (typeof EDITOR_THEMES)[number];

/** The theme of the app itself — tokens, layout, type — as one choice.
 *  `zero` is the Dark Modern port the app has always worn; `subzero` is the
 *  other one, styles/subzero.css. Kept apart from the syntax theme because
 *  they answer different questions: what the window is vs. what the code
 *  is, and the code's palette is the one people have habits about. */
export const THEMES = ["zero", "subzero"] as const;
export type Theme = (typeof THEMES)[number];

/** What subzero draws on the field between the panes — see the field
 *  section of styles/subzero.css. Only that theme reads it; zero's field
 *  is a colour. */
export const FIELDS = ["aurora", "contour", "bare"] as const;
export type Field = (typeof FIELDS)[number];

export const APPEARANCES = ["light", "dark", "system"] as const;
export type Appearance = (typeof APPEARANCES)[number];

export const TERM_STYLES = ["panel", "plain"] as const;
export type TermStyle = (typeof TERM_STYLES)[number];

export interface Settings {
  theme: Theme;
  field: Field;
  editorTheme: EditorTheme;
  /** Liquid Glass behind every surface (macOS 26+). Off means solid — the
   *  app exactly as it looks where glass doesn't exist. */
  glass: boolean;
  /** light / dark, or system to follow macOS. What most consumers want is
   *  not this but `resolvedAppearance()` — the two-value answer. */
  appearance: Appearance;
  /** Whether terminal panes wear the same card every other panel does, or go
   *  without — no fill, no border, no shadow, text straight on the window.
   *  Scoped to the terminal rather than offered per panel because it is the
   *  one panel that is nothing but text: the sidebar and the editor hold
   *  controls and fills that need a surface under them, and "plain" for those
   *  would be a panel that kept every part of the card except the card. */
  termStyle: TermStyle;
  /** the user's language choices: extension (or whole filename when there is
   *  no extension) → registry language name. lang.ts owns what the keys and
   *  values mean; this is only where they sleep. */
  langOverrides: Record<string, string>;
  /** Show the machinery. Today that is one thing: a `claude call` button under
   *  every turn of a memo thread, opening the exact `claude` command — every
   *  argument, the whole of stdin — that produced it, as the file Rust keeps
   *  beside the document. Off by default because it is a reading aid for
   *  someone working on zero, not on their memo; the files are written either
   *  way, so turning it on later shows the past too. */
  developer: boolean;
  /** Whether the Issues tab is in the activity rail at all.
   *
   *  A per-app switch rather than per-project, because what it turns off is a
   *  tab in the rail, and the rail is the same in every project. A project
   *  that doesn't use Linear already shows nothing but its connect screen —
   *  this is for someone who doesn't use Linear anywhere and would rather not
   *  carry the icon. Connecting and disconnecting stay per project, in the
   *  panel, because a token is a project's own. */
  linear: boolean;
}

const DEFAULTS: Settings = {
  theme: "zero",
  field: "aurora",
  editorTheme: "dark-modern",
  glass: true,
  appearance: "system",
  termStyle: "panel",
  langOverrides: {},
  developer: false,
  linear: true,
};

// The stored blob survives across versions of zero, so anything unrecognised
// falls back to the default rather than being trusted.
function parse(raw: string | null): Settings {
  if (!raw) return { ...DEFAULTS };
  let blob: Partial<Settings>;
  try {
    blob = JSON.parse(raw) as Partial<Settings>;
  } catch {
    return { ...DEFAULTS };
  }
  return {
    theme: THEMES.includes(blob.theme as Theme) ? (blob.theme as Theme) : DEFAULTS.theme,
    field: FIELDS.includes(blob.field as Field) ? (blob.field as Field) : DEFAULTS.field,
    editorTheme: EDITOR_THEMES.includes(blob.editorTheme as EditorTheme)
      ? (blob.editorTheme as EditorTheme)
      : DEFAULTS.editorTheme,
    glass: typeof blob.glass === "boolean" ? blob.glass : DEFAULTS.glass,
    appearance: APPEARANCES.includes(blob.appearance as Appearance)
      ? (blob.appearance as Appearance)
      : DEFAULTS.appearance,
    termStyle: TERM_STYLES.includes(blob.termStyle as TermStyle)
      ? (blob.termStyle as TermStyle)
      : DEFAULTS.termStyle,
    langOverrides: sanitizeOverrides(blob.langOverrides),
    developer: typeof blob.developer === "boolean" ? blob.developer : DEFAULTS.developer,
    linear: typeof blob.linear === "boolean" ? blob.linear : DEFAULTS.linear,
  };
}

function sanitizeOverrides(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(v)) {
    if (typeof val === "string") out[key] = val;
  }
  return out;
}

let current: Settings = parse(localStorage.getItem(KEY));

const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // a full or disabled store costs you persistence, not the change itself
  }
  for (const fn of listeners) fn();
}

/** Subscribe to changes; returns the unsubscribe. Used by non-React consumers
 *  (live editor views) as well as the hook below. */
export function onSettingsChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSettings(): Settings {
  return useSyncExternalStore(onSettingsChange, getSettings);
}

/** The two-value answer every renderer wants: `system` resolved against what
 *  macOS currently says. Subscribers to the store hear OS flips too — the
 *  media-query listener below refires them, and it rebuilds `current` so the
 *  React snapshot changes identity even though no stored value moved. */
export function resolvedAppearance(): "light" | "dark" {
  const a = current.appearance;
  if (a !== "system") return a;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (current.appearance !== "system") return;
  current = { ...current };
  for (const fn of listeners) fn();
});
