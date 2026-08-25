/**
 * The smallest change that turns `old` into `next`: trim what the two share at
 * each end and replace the rest.
 *
 * Handing CodeMirror the whole document instead — which is what the live
 * refreshes did — says every character changed, and everything downstream
 * believes it. The editor re-diffs the file end to end, the parser drops the
 * syntax tree and reparses, the highlighter repaints, and the cursor and
 * scroll position have nothing to be mapped through. All of it every two
 * seconds, because an agent touched one line.
 */
export function minimalChange(old: string, next: string) {
  const max = Math.min(old.length, next.length);
  let head = 0;
  while (head < max && old.charCodeAt(head) === next.charCodeAt(head)) head++;
  let tail = 0;
  while (
    tail < max - head &&
    old.charCodeAt(old.length - tail - 1) === next.charCodeAt(next.length - tail - 1)
  )
    tail++;
  // a surrogate pair is one character in two units; cutting between them would
  // leave a lone half in the document
  if (head > 0 && (old.charCodeAt(head - 1) & 0xfc00) === 0xd800) head--;
  if (tail > 0 && (old.charCodeAt(old.length - tail) & 0xfc00) === 0xdc00) tail--;
  return { from: head, to: old.length - tail, insert: next.slice(head, next.length - tail) };
}
