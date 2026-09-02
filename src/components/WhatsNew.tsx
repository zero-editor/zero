import { useEffect, useState } from "react";
import { miniMarkdown } from "../lib/miniMarkdown";
import { releaseNotesBetween, type ReleaseNote } from "../lib/releaseNotes";

/**
 * What the staged update is carrying, asked for by clicking the titlebar
 * pill: the release notes of every version between the one running and the
 * one on disk, so a jump over three releases reads as all three. The restart
 * lives in the footer — the pill used to restart on the spot, and this is
 * that same single decision with the reasons above it.
 *
 * The notes were fetched when the update staged (update.ts asks for them
 * the moment the bundle is on disk), so this normally opens on them; the
 * "fetching" line is for a dialog that beat the fetch or a fetch that
 * failed and is being retried. GitHub not answering is worth one quiet
 * line, not a broken dialog — the update itself is already here, and the
 * restart works the same with nothing above it.
 */
export function WhatsNew({
  from,
  to,
  onClose,
  onRestart,
}: {
  /** the running version */
  from: string;
  /** the staged one */
  to: string;
  onClose: () => void;
  onRestart: () => void;
}) {
  // null while loading, [] and up once answered, false when GitHub didn't
  const [notes, setNotes] = useState<ReleaseNote[] | false | null>(null);

  useEffect(() => {
    let live = true;
    void releaseNotesBetween(from, to).then((got) => {
      if (live) setNotes(got ?? false);
    });
    return () => {
      live = false;
    };
  }, [from, to]);

  // capture phase, same as the settings overlay: while this is the topmost
  // layer, ⎋ belongs to it
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
      <div className="whats-new-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="whats-new-title">
          <span>what's new</span>
          <span className="whats-new-jump">
            {from} → {to}
          </span>
        </div>
        <div className="whats-new-scroll">
          {notes === null && <div className="whats-new-quiet">fetching release notes…</div>}
          {notes === false && (
            <div className="whats-new-quiet">
              couldn't fetch the release notes — they're at
              github.com/zero-editor/zero/releases
            </div>
          )}
          {notes &&
            notes.map((n) => (
              <section className="whats-new-release" key={n.version}>
                <div className="whats-new-version">
                  <span>{n.version}</span>
                  <span className="whats-new-date">{n.date}</span>
                </div>
                {n.body ? (
                  <div className="whats-new-notes">{miniMarkdown(n.body)}</div>
                ) : (
                  <div className="whats-new-quiet">no notes for this one</div>
                )}
              </section>
            ))}
          {notes && notes.length === 0 && (
            <div className="whats-new-quiet">no release notes between these versions</div>
          )}
        </div>
        <div className="whats-new-foot">
          <button className="whats-new-restart" onClick={onRestart}>
            restart into zero {to}
          </button>
        </div>
      </div>
    </div>
  );
}
