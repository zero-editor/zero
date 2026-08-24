import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { onFilesChanged } from "../lib/fileEvents";
import { humanSize, imageType } from "../lib/imageFile";

/**
 * A changed picture, as two pictures.
 *
 * The text diff was showing PNG bytes as characters — a page of replacement
 * marks with a scrollbar, which is not a diff of anything. Nothing about an
 * image is legible that way, so this is the same two sides the merge view puts
 * side by side, drawn as what they are.
 *
 * The sides are the ones `DiffView` explains: a working-tree diff measures
 * against the *index*, a staged diff measures HEAD against the index. Either
 * side can be nothing — a new file has no HEAD, a deleted one has no working
 * copy — which is an addition or a deletion rather than a failure, and is
 * drawn as an empty frame beside a full one.
 */

/** one side, as far as it got */
interface Side {
  /** an object URL, or null when this side of the diff has no file */
  url: string | null;
  bytes: number;
  size: { w: number; h: number } | null;
  /** the extension says image, the decoder disagrees */
  broken: boolean;
}

const EMPTY: Side = { url: null, bytes: 0, size: null, broken: false };

export function ImageDiffView({
  worktree,
  relPath,
  staged = false,
  from,
  visible,
}: {
  worktree: string;
  relPath: string;
  staged?: boolean;
  /** where this file was before it moved — the path HEAD knows it by */
  from?: string;
  visible: boolean;
}) {
  const [a, setA] = useState<Side>(EMPTY);
  const [b, setB] = useState<Side>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [actual, setActual] = useState(false);

  // the object URLs currently on screen. They pin their bytes in memory until
  // revoked, so a reload has to let the old pair go — and so does unmounting,
  // which is a diff tab closing on two decoded images
  const urls = useRef<string[]>([]);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const load = useCallback(async () => {
    const type = imageType(relPath) ?? "application/octet-stream";
    const blobUrl = (buf: ArrayBuffer) =>
      buf.byteLength ? URL.createObjectURL(new Blob([buf], { type })) : null;

    /**
     * The HEAD side of a moved file, which HEAD files under the path it moved
     * from. The same fallback `DiffView` makes, for the same stale `from`: an
     * empty answer is indistinguishable from a file that isn't there, so this
     * asks the second question rather than believing the first.
     */
    const headSide = async () => {
      if (from) {
        const origin = await api.showBinary(worktree, "HEAD", from);
        if (origin.byteLength) return origin;
      }
      return api.showBinary(worktree, "HEAD", relPath);
    };

    const [bufA, bufB] = await Promise.all([
      staged ? headSide() : api.showBinary(worktree, "", relPath),
      staged
        ? api.showBinary(worktree, "", relPath)
        : // a deleted file is one side of a diff, not a broken read
          api.readBinary(`${worktree}/${relPath}`).catch(() => new ArrayBuffer(0)),
    ]);

    return { bufA, bufB, blobUrl };
  }, [worktree, relPath, staged, from]);

  useEffect(() => {
    let disposed = false;

    const refresh = () => {
      load()
        .then(({ bufA, bufB, blobUrl }) => {
          const made = [blobUrl(bufA), blobUrl(bufB)];
          if (disposed) {
            made.forEach((u) => u && URL.revokeObjectURL(u));
            return;
          }
          urls.current.forEach((u) => URL.revokeObjectURL(u));
          urls.current = made.filter((u): u is string => u !== null);
          // the natural sizes arrive from the <img>, so they start over with
          // the bytes they describe
          setA({ ...EMPTY, url: made[0], bytes: bufA.byteLength });
          setB({ ...EMPTY, url: made[1], bytes: bufB.byteLength });
          setError(null);
        })
        .catch((e) => {
          if (!disposed) setError(String(e));
        });
    };

    refresh();

    // No two-second poll, unlike the text diff: a tick there is two file reads
    // of a few kilobytes, and here it is two images decoded again, for a file
    // that changes when something exports over it rather than as you type. The
    // two moments it can have changed without us are a write the app itself
    // made, and time spent in another app — which is where `pokeGit` already
    // looks for the same reason.
    const off = onFilesChanged(() => refresh());
    const onFocus = () => {
      if (visibleRef.current) refresh();
    };
    window.addEventListener("focus", onFocus);

    return () => {
      disposed = true;
      off();
      window.removeEventListener("focus", onFocus);
      urls.current.forEach((u) => URL.revokeObjectURL(u));
      urls.current = [];
    };
  }, [load]);

  if (error) return <div className="panel-error">{error}</div>;

  const verb = !a.url ? "added" : !b.url ? "deleted" : null;
  const dims = (s: Side) => (s.size ? `${s.size.w} × ${s.size.h}` : null);
  const grew = a.bytes && b.bytes ? b.bytes - a.bytes : 0;

  /** the line under the pair: what changed about the file, in the terms a
   *  picture changes in — how big it is, and how big it is */
  const summary = verb
    ? [verb, dims(verb === "added" ? b : a), humanSize((verb === "added" ? b : a).bytes)]
        .filter(Boolean)
        .join("  ·  ")
    : [
        dims(a) === dims(b) ? dims(a) : [dims(a), dims(b)].filter(Boolean).join(" → "),
        `${humanSize(a.bytes)} → ${humanSize(b.bytes)}`,
        grew ? `${grew > 0 ? "+" : "−"}${humanSize(Math.abs(grew))}` : null,
      ]
        .filter(Boolean)
        .join("  ·  ");

  const pane = (
    side: Side,
    mark: "before" | "after",
    label: string,
    set: (s: Side) => void
  ) => (
    <div className={`imgdiff-pane ${mark}`}>
      <div className="imgdiff-label">{label}</div>
      <div className={`image-stage ${actual ? "actual" : ""}`}>
        {side.broken ? (
          <div className="image-broken">nothing here can decode this side</div>
        ) : side.url ? (
          <img
            src={side.url}
            alt=""
            className="image-canvas"
            onLoad={(e) =>
              set({ ...side, size: { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight } })
            }
            onError={() => set({ ...side, broken: true })}
            onClick={() => setActual((v) => !v)}
            title={actual ? "click to fit" : "click for actual size"}
          />
        ) : (
          // an empty stage on its own reads as a failure to load; this says
          // which side is missing, in the same words its label uses
          <div className="imgdiff-absent">
            {mark === "before" ? `not in ${label} yet` : `gone from ${label}`}
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="imgdiff">
      <div className="imgdiff-panes">
        {pane(a, "before", staged ? "HEAD" : "the index", setA)}
        {pane(b, "after", staged ? "the index" : "the working tree", setB)}
      </div>
      <div className="image-meta">{summary}</div>
    </div>
  );
}
