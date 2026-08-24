import { useEffect, useState } from "react";

/**
 * One line of typed text, asked for and waited on.
 *
 * "New file" and "Rename" both need a name, and there is nowhere to type one:
 * the dialog plugin offers messages and file pickers and nothing that takes a
 * string, and the menu that asks is a native menu with no surface of its own.
 * So this is the app's own prompt, held here rather than in a component because
 * the thing that asks is a menu action — a callback with no place in the tree.
 *
 * The file tree renames in the row itself, the way Finder and VS Code do —
 * that is worth having, and it is worth having *there*, where a row is already
 * the name at the right indent. Nowhere else has one to reuse: a changes row, a
 * tab, a memo would each need their own. So the field in the tree, and this
 * overlay for the rest, including every "new file" — there is no row yet to
 * type a name into when the thing doesn't exist.
 */

export interface Ask {
  /** what is being asked, in the app's lowercase voice: "new file in src" */
  title: string;
  value: string;
  /** the button, so it says the verb rather than "OK" */
  ok: string;
  /** select the name up to the extension, the way macOS does when you rename
   *  something in Finder — the dot and what follows is rarely what changes */
  stem?: boolean;
}

interface Pending extends Ask {
  /** counts up per question. The field is uncontrolled — typing in a
   *  controlled one re-renders the whole app per keystroke — so the id is what
   *  the overlay keys it on, and a fresh element is what makes a second
   *  question show its own value rather than whatever was typed into the last */
  id: number;
  done: (value: string | null) => void;
}

let asked = 0;
let current: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

/** Resolves with what was typed, or null if it was dismissed. Trimmed, and
 *  unchanged-or-empty counts as dismissed — neither is a thing to go and do. */
export function ask(a: Ask): Promise<string | null> {
  // A second question while one is up answers the first with nothing. It
  // shouldn't happen — the menu is modal while it's open — but a dropped
  // promise is a caller waiting forever, and this is one line.
  current?.done(null);
  return new Promise((resolve) => {
    current = {
      ...a,
      id: ++asked,
      done: (value) => {
        current = null;
        emit();
        const out = value?.trim();
        resolve(out && out !== a.value ? out : null);
      },
    };
    emit();
  });
}

export function usePrompt(): Pending | null {
  const [, bump] = useState(0);
  useEffect(() => {
    const onChange = () => bump((n) => n + 1);
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);
  return current;
}
