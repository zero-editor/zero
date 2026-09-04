import { useCallback, useEffect, useState } from "react";
import { api, type LinearConnection } from "../lib/api";
import { EDITOR_THEME_CHOICES } from "../lib/cmTheme";
import { updateSettings, useSettings } from "../lib/settings";
import { FIELDS } from "../lib/settings";
import type { Theme } from "../lib/settings";

/** The two themes, each with the four tones that make it what it is —
 *  field, panel, text, accent — so the row shows the theme before it is
 *  picked, the way the syntax rows show their palette. */
const THEME_CHOICES: { id: Theme; label: string; swatch: string[] }[] = [
  { id: "zero", label: "zero", swatch: ["#141414", "#181818", "#cccccc", "#e6e6e6"] },
  { id: "subzero", label: "subzero", swatch: ["#06070c", "#101219", "#e3e6ee", "#8ed0ff"] },
];

/**
 * One extension, on or off.
 *
 * A switch rather than the two-button `settings-choice` rows the appearance
 * pane is made of, and the difference is what the control is being asked: a
 * theme is a choice between things that all exist, and this is whether a thing
 * exists at all. `hint` is what the tooltip says while it is on — the sentence
 * that names what you would lose by pressing it.
 */
function Switch({
  name,
  hint,
  on,
  set,
}: {
  name: string;
  hint: string;
  on: boolean;
  set: (on: boolean) => void;
}) {
  return (
    <div className="settings-row">
      <span className="settings-row-name">{name}</span>
      <button
        role="switch"
        aria-checked={on}
        aria-label={name}
        className={`settings-toggle ${on ? "on" : ""}`}
        title={on ? hint : "off"}
        onClick={() => set(!on)}
      >
        <span className="settings-knob" />
      </button>
    </div>
  );
}

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
  const [pane, setPane] = useState<"appearance" | "extensions">("appearance");
  // Which projects hold a Linear token. Read here rather than passed in: this
  // overlay belongs to the app, not to a project, so "what is connected" is a
  // list rather than a single yes or no.
  const [connections, setConnections] = useState<LinearConnection[]>([]);
  const refreshConnections = useCallback(
    () => void api.linearConnections().then(setConnections).catch(() => setConnections([])),
    [],
  );
  useEffect(refreshConnections, [refreshConnections]);
  // The Linear group below is a switch and nothing more. A key is scoped to
  // one workspace and this overlay is one for the whole app, so a token in
  // here could only ever connect every project to the same company — which is
  // why the token lives in the Issues panel, per project, and only the "is
  // this integration on at all" question lives here.

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
        {/* Two panes, because the second one isn't about how the app looks.
            Grouping these under "appearance" would have been the kind of tidy
            that makes a thing harder to find.
            "extensions" rather than "integrations": two of the three switches
            here are zero's own — the mic and the note — and calling those an
            integration would say they talk to something. What the three have
            in common is that the app is whole without them. */}
        <div className="settings-tabs">
          {(["appearance", "extensions"] as const).map((t) => (
            <button
              key={t}
              className={`settings-tab ${pane === t ? "on" : ""}`}
              onClick={() => setPane(t)}
            >
              {t}
            </button>
          ))}
        </div>

        <div className="settings-panes">
        {pane === "appearance" && (
          <>
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
        {settings.theme === "subzero" && (
          <div className="settings-group">
            <div className="settings-label">field</div>
            {/* only while subzero is on: it is the one theme that draws
                anything on the field, so the row would be inert under zero */}
            {FIELDS.map((f) => {
              const on = settings.field === f;
              return (
                <button
                  key={f}
                  className={`settings-choice ${on ? "on" : ""}`}
                  onClick={() => updateSettings({ field: f })}
                >
                  <span className="settings-dot" aria-hidden />
                  <span className="settings-choice-name">{f}</span>
                </button>
              );
            })}
          </div>
        )}
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
          </>
        )}

        {pane === "extensions" && (
          <div className="settings-group">
            {/* zero's own two first and the outside one last, which is also
                the only one with anything underneath it */}
            <Switch
              name="Voice memos"
              on={settings.memos}
              hint="on — the mic is in the sidebar"
              set={(memos) => updateSettings({ memos })}
            />
            <Switch
              name="Notes"
              on={settings.notes}
              hint="on — ⌘⌥N opens this project's note"
              set={(notes) => updateSettings({ notes })}
            />
            <Switch
              name="Linear"
              on={settings.linear}
              hint="on — the Issues tab is in the sidebar"
              set={(linear) => updateSettings({ linear })}
            />
            {(!settings.memos || !settings.notes) && (
              <div className="settings-note">
                Nothing was deleted. Recordings, transcripts and notes stay in the project;
                switching one back on shows every one of them again.
              </div>
            )}

            {settings.linear && connections.length > 0 && (
              <div className="settings-conns">
                {connections.map((c) => (
                  <div className="settings-conn" key={c.root}>
                    <span className="settings-conn-name" title={c.root}>
                      {c.root.split("/").pop()}
                    </span>
                    {/* which workspace that project's key belongs to — the
                        other half of "connected", and the thing you would
                        otherwise have to disconnect to find out */}
                    {c.org && <span className="settings-conn-org">{c.org}</span>}
                    <button
                      className="settings-conn-x"
                      title={`disconnect ${c.root}`}
                      onClick={() => {
                        void api.linearDisconnect(c.root).then(refreshConnections);
                      }}
                    >
                      Disconnect
                    </button>
                  </div>
                ))}
              </div>
            )}
            {settings.linear && !connections.length && (
              <div className="settings-note">
                No project connected yet. Open the Issues tab in one and paste a key.
              </div>
            )}
          </div>
        )}
        </div>
        {/* the other half of where a version belongs: the launcher is where
            you see it, this is where you go to look it up */}
        <div className="settings-version">zero {__APP_VERSION__}</div>
      </div>
    </div>
  );
}
