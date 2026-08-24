import { useEffect, useRef } from "react";
import { usePrompt } from "../lib/prompt";
import { selectStem } from "../lib/contextMenu";

/**
 * The overlay half of `lib/prompt` — mounted once, empty until something asks.
 *
 * Same backdrop as quick open and preferences, and a narrower box: it holds one
 * field and one button, and a box the width of the file list would be a lot of
 * furniture around a filename.
 */
export function Prompt() {
  const pending = usePrompt();
  const inputRef = useRef<HTMLInputElement>(null);

  // Selecting the stem is the whole reason this can't just be `autoFocus`:
  // renaming `api.ts` should leave `.ts` alone, and that is a selection range
  // rather than a property.
  const id = pending?.id;
  useEffect(() => {
    const el = inputRef.current;
    if (!el || !pending) return;
    el.focus();
    selectStem(el, pending.value, pending.stem);
    // on the question's id rather than the object, which is rebuilt on every
    // render of the host
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (!pending) return null;

  return (
    <div className="quick-backdrop" onMouseDown={() => pending.done(null)}>
      <div className="prompt-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="prompt-title">{pending.title}</div>
        <input
          key={pending.id}
          ref={inputRef}
          className="prompt-input"
          defaultValue={pending.value}
          spellCheck={false}
          // every key in here is this field's. Without the stop, ⌘W closes the
          // tab behind the overlay while you are naming a file on top of it —
          // the workspace listens on the window, and React's root sits under it
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") pending.done(e.currentTarget.value);
            else if (e.key === "Escape") pending.done(null);
          }}
        />
        <button
          className="prompt-ok"
          onClick={() => pending.done(inputRef.current?.value ?? null)}
        >
          {pending.ok}
        </button>
      </div>
    </div>
  );
}
