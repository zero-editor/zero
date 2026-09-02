import { useEffect } from "react";
import { EDITOR_THEME_CHOICES } from "../lib/cmTheme";
import { updateSettings, useSettings } from "../lib/settings";
import type { Theme } from "../lib/settings";

/** The two themes, each with the four tones that make it what it is —
 *  field, panel, text, accent — so the row shows the theme before it is
 *  picked, the way the syntax rows show their palette. */
const THEME_CHOICES: { id: Theme; label: string; swatch: string[] }[] = [
  { id: "zero", label: "zero", swatch: ["#141414", "#181818", "#cccccc", "#e6e6e6"] },
  { id: "subzero", label: "subzero", swatch: ["#06070c", "#101219", "#e3e6ee", "#8ed0ff"] },
];

/**
 * App settings, ⌘, — one overlay for the whole app, not per project. The
 * shape is a labelled group per setting so the next one is an append, not a
 * redesign.
 *
 * Picking anything applies it on the spot: every open editor follows the
 * settings store live, and the window itself re-glasses under the overlay,
 * so the app behind the overlay is the preview.
 */
export function Settings({ onClose }: { onClose: () => void }) {
  const settings = useSettings();

  // capture phase: while the overlay is up it is the topmost layer, and ⎋
  // belongs to it — not to quick open under it, not to a memo recording
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onClose]);

  return (
    <div className="quick-backdrop" onMouseDown={onClose}>
      <div className="settings-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-title">preferences</div>
        <div className="settings-group">
          <div className="settings-label">theme</div>
          {/* a theme brings its terminal style with it: subzero is drawn for
              text straight on the field, zero for a card under it — and the
              terminal group below is still there to pick otherwise */}
          {THEME_CHOICES.map((c) => {
            const on = settings.theme === c.id;
            return (
              <button
                key={c.id}
                className={`settings-choice ${on ? "on" : ""}`}
                onClick={() =>
                  updateSettings({ theme: c.id, termStyle: c.id === "subzero" ? "plain" : "panel" })
                }
              >
                <span className="settings-dot" aria-hidden />
                <span className="settings-choice-name">{c.label}</span>
                <span className="settings-swatch" aria-hidden>
                  {c.swatch.map((color) => (
                    <i key={color} style={{ background: color }} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
        <div className="settings-group">
          <div className="settings-label">syntax theme</div>
          {EDITOR_THEME_CHOICES.map((c) => {
            const on = settings.editorTheme === c.id;
            return (
              <button
                key={c.id}
                className={`settings-choice ${on ? "on" : ""}`}
                onClick={() => updateSettings({ editorTheme: c.id })}
              >
                <span className="settings-dot" aria-hidden />
                <span className="settings-choice-name">{c.label}</span>
                <span className="settings-swatch" aria-hidden>
                  {c.swatch.map((color) => (
                    <i key={color} style={{ background: color }} />
                  ))}
                </span>
              </button>
            );
          })}
        </div>
        <div className="settings-group">
          <div className="settings-label">appearance</div>
          {(["light", "dark", "system"] as const).map((a) => {
            const on = settings.appearance === a;
            return (
              <button
                key={a}
                className={`settings-choice ${on ? "on" : ""}`}
                onClick={() => updateSettings({ appearance: a })}
              >
                <span className="settings-dot" aria-hidden />
                <span className="settings-choice-name">{a}</span>
              </button>
            );
          })}
        </div>
        <div className="settings-group">
          <div className="settings-label">window</div>
          {(
            [
              { id: true, label: "liquid glass" },
              { id: false, label: "solid" },
            ] as const
          ).map((c) => {
            const on = settings.glass === c.id;
            return (
              <button
                key={c.label}
                className={`settings-choice ${on ? "on" : ""}`}
                onClick={() => updateSettings({ glass: c.id })}
              >
                <span className="settings-dot" aria-hidden />
                <span className="settings-choice-name">{c.label}</span>
              </button>
            );
          })}
        </div>
        <div className="settings-group">
          <div className="settings-label">terminal</div>
          {/* the one panel that can take its chrome off — see settings.ts for
              why this isn't offered per panel */}
          {(
            [
              { id: "panel", label: "panel" },
              { id: "plain", label: "plain" },
            ] as const
          ).map((c) => {
            const on = settings.termStyle === c.id;
            return (
              <button
                key={c.id}
                className={`settings-choice ${on ? "on" : ""}`}
                onClick={() => updateSettings({ termStyle: c.id })}
              >
                <span className="settings-dot" aria-hidden />
                <span className="settings-choice-name">{c.label}</span>
              </button>
            );
          })}
        </div>
        <div className="settings-group">
          <div className="settings-label">developer</div>
          {/* what `on` shows today is one button — `claude call`, under every
              turn of a memo thread — and the word for the group is deliberately
              wider than that: it is where the next piece of machinery worth
              seeing goes too. settings.ts says what the flag is for. */}
          {(
            [
              { id: false, label: "off" },
              { id: true, label: "show claude calls" },
            ] as const
          ).map((c) => {
            const on = settings.developer === c.id;
            return (
              <button
                key={c.label}
                className={`settings-choice ${on ? "on" : ""}`}
                onClick={() => updateSettings({ developer: c.id })}
              >
                <span className="settings-dot" aria-hidden />
                <span className="settings-choice-name">{c.label}</span>
              </button>
            );
          })}
        </div>
        {/* the other half of where a version belongs: the launcher is where
            you see it, this is where you go to look it up */}
        <div className="settings-version">zero {__APP_VERSION__}</div>
      </div>
    </div>
  );
}
