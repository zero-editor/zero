import type { ReactNode } from "react";

/**
 * A prompt open for editing — a state group's, or the one every issue row runs.
 *
 * In the panel rather than in Preferences, under the thing it belongs to. What
 * you are editing is a sentence about issues you are looking at, and `note` is
 * load-bearing: it says what the placeholder is about to become. For a group
 * that is a count, and it is the *filtered* count, which is how the filter
 * became half the feature. In a settings dialog neither could be shown.
 *
 * The note comes from the caller because the two subjects differ in a way no
 * flag would capture: a group's box is that group's, while a row's box is one
 * template shared by every row, opened under whichever one asked. Saying so is
 * the note's job, and getting it wrong would read as editing one issue.
 *
 * Empty means default. A prompt you have blanked is one you have no opinion
 * about any more, and the alternative — a saved empty string that quietly
 * neuters the button — has no use worth the confusion.
 */
export function PromptEditor({
  value,
  note,
  onChange,
  onCancel,
  onSave,
  onRun,
}: {
  value: string;
  /** what the placeholder becomes, in the caller's own words */
  note: ReactNode;
  onChange: (v: string) => void;
  onCancel: () => void;
  onSave: (body: string) => void;
  onRun: (body: string) => void;
}) {
  return (
    <div className="li-prompt">
      <textarea
        className="li-prompt-box"
        value={value}
        autoFocus
        spellCheck={false}
        rows={9}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onRun(value);
          }
        }}
      />
      {/* Stacked, not a footer row. This is a sidebar: at its default width
          there is room for a line of small text or for three buttons, never
          for both, and side by side the note wrapped to five lines while the
          buttons ran off the edge. */}
      <p className="li-prompt-note">{note}</p>
      <div className="li-prompt-acts">
        <button className="li-btn flat" onClick={onCancel}>
          Cancel
        </button>
        <button className="li-btn" onClick={() => onSave(value)}>
          Save
        </button>
        <button className="li-btn go" onClick={() => onRun(value)} title="save and run · ⌘⏎">
          Run
        </button>
      </div>
    </div>
  );
}

