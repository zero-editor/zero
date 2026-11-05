import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// Seeded lattice noise: smooth in space and time, with no per-frame random
// numbers. Fractal octaves add smaller folds inside the broad currents.
function lattice(x: number, y: number) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const sy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const a = lattice(ix, iy), b = lattice(ix + 1, iy);
  const c = lattice(ix, iy + 1), d = lattice(ix + 1, iy + 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

function fractal(x: number, y: number) {
  let value = 0, amplitude = 0.57;
  for (let octave = 0; octave < 4; octave++) {
    value += (noise(x, y) * 2 - 1) * amplitude;
    // Rotate between scales so fine branches don't follow the lattice.
    const nextX = x * 1.65 - y * 1.2 + 17.3;
    y = x * 1.2 + y * 1.65 - 9.2;
    x = nextX;
    amplitude *= 0.34;
  }
  return value;
}

const GLYPHS = [".", ":", "~", "(", ")"] as const;
const CELL_W = 12, CELL_H = 14;

// Contour's ice-blue / slate hue, with a small tonal variation as folds
// move. Keep the neutral field underneath it free of washes. A lamp's
// triplet ("240, 164, 94", as the panes' --lamp carries it) gives the same
// 24 tones in that agent's colour.
function palette(light: boolean, lamp?: string) {
  const base = lamp?.includes(",") ? lamp.split(",").map(Number) : light ? [31, 51, 79] : [184, 219, 255];
  return Array.from({ length: 24 }, (_, i) => {
    const mix = i / 23;
    const tone = light ? 0.9 + mix * 0.2 : 0.82 + mix * 0.08;
    return `rgb(${base.map((c) => Math.round(c * tone)).join(", ")})`;
  });
}

/** Where the machine is thinking. Each pane with an agent in it is a warm
 * spot in the field: the current curls round it, and the glyphs near it
 * take a breath of its lamp colour — amber for Claude, green for Codex —
 * strongest while it works, held at half once it is waiting on you. Nothing
 * switches: a spot warms over seconds and cools over more, so the field
 * never notices the moment an agent starts, only that it has. */
type Warm = { level: number; target: number; x: number; y: number; r: number; lamp: string };

function smooth(t: number) {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

/** Every glyph in every tone, rasterised once: a frame then blits ~4000
 * cells with drawImage instead of shaping text ~4000 times. One row per
 * tone, one column per glyph, each sprite a cell. */
function buildAtlas(colours: string[], ratio: number) {
  const atlas = document.createElement("canvas");
  atlas.width = Math.round(GLYPHS.length * CELL_W * ratio);
  atlas.height = Math.round(colours.length * CELL_H * ratio);
  const ctx = atlas.getContext("2d")!;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.font = '10px "Menlo", "Consolas", monospace';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  colours.forEach((colour, row) => {
    ctx.fillStyle = colour;
    GLYPHS.forEach((glyph, col) =>
      ctx.fillText(glyph, (col + 0.5) * CELL_W, (row + 0.5) * CELL_H));
  });
  return atlas;
}

type Rect = { left: number; top: number; right: number; bottom: number };

/** The opaque cards over the field, in the project on screen: a terminal's
 * card and the editor's page (whose fill starts a tab strip down). Nothing
 * drawn under one of these is ever seen, so the cells there are skipped —
 * compute and paint both. Read per frame: panes glide to new seats over
 * 160ms and a drag moves them as transforms, and a few rect reads cost
 * nothing next to a frame. Inset by a cell, because a glyph drifts up to
 * ~10px from its cell and a skipped cell at the edge would leave a gutter
 * one glyph thinner than it is. */
function occluders(): Rect[] {
  const rects: Rect[] = [];
  const inset = CELL_W;
  const live = ".workspace:not(.inactive) ";
  for (const el of document.querySelectorAll(live + ".term-abs:not(.plain) .term-pane")) {
    const r = el.getBoundingClientRect();
    rects.push({ left: r.left + inset, top: r.top + inset, right: r.right - inset, bottom: r.bottom - inset });
  }
  for (const el of document.querySelectorAll(live + ".editor-card")) {
    const r = el.getBoundingClientRect();
    rects.push({ left: r.left + inset, top: r.top + 32 + inset, right: r.right - inset, bottom: r.bottom - inset });
  }
  return rects.filter((r) => r.right > r.left && r.bottom > r.top);
}

/** A sampled flow field: glyphs drift around a grid while the current passes
 * through them. No React updates per frame, and no work in a hidden tab. */
export function DriftField({ light }: { light: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null);
  // The field runs on through a light/dark flip: only its colours change.
  // Restarting it there would jump to a different picture mid-thought.
  const lightRef = useRef(light);
  const redraw = useRef<() => void>(() => {});
  useEffect(() => { lightRef.current = light; redraw.current(); }, [light]);

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    // A different opening frame each launch; the same one every time read
    // as a loop restarting rather than a current you walked in on.
    let width = 0, height = 0, frame = 0, last = 0, time = (Date.now() / 1000) % 3600;
    let drift = time * 0.13;
    let running = false;
    let shade = lightRef.current;
    let colours = palette(shade);
    let atlas: HTMLCanvasElement | null = null;
    const lamps = new Map<string, HTMLCanvasElement>();
    let ratio = 1;
    const warmth = new Map<Element, Warm>();
    let vitality = 0;
    // Frame interval. Ambient motion needs only 20fps; when the project's
    // cards leave the field showing through gutters alone, 8fps.
    let interval = 50;
    // Randomness chooses an encounter once; its whole lifetime is smooth.
    // Use animation time so hiding the window doesn't queue up surprises.
    let nextEncounter = 5 + Math.random() * 4;
    let encounter: {
      start: number; duration: number; x: number; y: number;
      kind: number; direction: number; phase: number;
    } | null = null;
    const readWarmth = (dt: number, scale: number) => {
      for (const w of warmth.values()) w.target = 0;
      const live = ".workspace:not(.inactive) .term-abs";
      for (const el of document.querySelectorAll(`${live}.agent-working, ${live}.agent-done`)) {
        const rect = el.getBoundingClientRect();
        let w = warmth.get(el);
        if (!w) { w = { level: 0, target: 0, x: 0, y: 0, r: 0, lamp: "" }; warmth.set(el, w); }
        w.target = el.classList.contains("agent-working") ? 1 : 0.5;
        w.x = ((rect.left + rect.right) / 2 - width / 2) / scale;
        w.y = ((rect.top + rect.bottom) / 2 - height / 2) / scale;
        w.r = Math.max(rect.width, rect.height) / scale * 0.7;
        w.lamp = getComputedStyle(el).getPropertyValue("--lamp").trim();
      }
      vitality = 0;
      for (const [el, w] of warmth) {
        w.level += (w.target - w.level) * Math.min(1, dt / (w.target > w.level ? 4 : 8));
        if (w.target === 0 && w.level < 0.01) warmth.delete(el);
        else vitality += w.level;
      }
      vitality = Math.min(vitality, 3);
    };
    const draw = (dt = 0) => {
      ctx.clearRect(0, 0, width, height);
      if (lightRef.current !== shade) {
        shade = lightRef.current;
        colours = palette(shade);
        atlas = null;
        lamps.clear();
      }
      const light = shade;
      if (!atlas) atlas = buildAtlas(colours, ratio);
      const sprite = CELL_W * ratio, spriteH = CELL_H * ratio;
      const hidden = occluders();
      let covered = 0;
      for (const r of hidden) covered += (r.right - r.left) * (r.bottom - r.top);
      interval = covered > width * height * 0.7 ? 125 : 50;
      const scale = Math.max(Math.min(width, height), 1);
      readWarmth(dt, scale);
      const warm = Array.from(warmth.values());
      const breath = noise(time * 0.12 + 41, 7);
      // Soft vortices warp the sampling plane. Their influence fades with
      // distance, so membranes curl into each other without a polar seam.
      const heartX = -0.28 + (noise(drift * 0.7, 13) - 0.5) * 0.45;
      const heartY = 0.08 + (noise(29, drift * 0.6) - 0.5) * 0.4;
      const turn = 0.8 + breath * 0.18;
      const domain = (u: number, v: number) => {
        const dx = u - heartX, dy = v - heartY;
        const pull = Math.exp(-(dx * dx + dy * dy) * 3.2) * turn;
        const other = Math.exp(-((u - 0.42) ** 2 + (v + 0.24) ** 2) * 5);
        let a = u - dy * pull + (v + 0.24) * other * 0.65 + 0.13 * Math.sin(v * 5 + drift);
        let b = v + dx * pull - (u - 0.42) * other * 0.65 + 0.12 * Math.sin(u * 4 - drift * 0.8);
        // The current curls round a working agent, the way it curls round
        // the heart: a slower, pane-sized eddy that is there only while it is.
        for (const w of warm) {
          const wx = u - w.x, wy = v - w.y;
          const eddy = Math.exp(-(wx * wx + wy * wy) / (w.r * w.r)) * w.level * 0.4;
          a -= wy * eddy;
          b += wx * eddy;
        }
        return { a, b };
      };
      if (encounter && time >= encounter.start + encounter.duration) {
        encounter = null;
        nextEncounter = time + 12 + Math.random() * 20;
      }
      if (!motion.matches && !encounter && time >= nextEncounter) {
        encounter = {
          start: time, duration: 8 + Math.random() * 5,
          x: 0.18 + Math.random() * 0.64, y: 0.2 + Math.random() * 0.6,
          kind: Math.floor(Math.random() * 3), direction: Math.random() < 0.5 ? -1 : 1,
          phase: Math.random() * Math.PI * 2,
        };
      }
      const event = motion.matches ? null : encounter;
      const progress = event ? (time - event.start) / event.duration : 0;
      // Zero slope at arrival/departure: even the brightest moment dissolves.
      const envelope = Math.sin(progress * Math.PI) ** 2;
      const origin = event ? domain((event.x - 0.5) * width / scale,
        (event.y - 0.5) * height / scale) : null;
      for (let y = 7, row = 0; y < height; y += 14, row++) {
        for (let x = 6, col = 0; x < width; x += 12, col++) {
          let under = false;
          for (const r of hidden) {
            if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) { under = true; break; }
          }
          if (under) continue;
          const u = (x - width * 0.5) / scale;
          const v = (y - height * 0.5) / scale;
          const { a, b } = domain(u, v);
          const warpX = fractal(a * 2.4 + drift * 0.35, b * 2.4 + 19);
          const warpY = fractal(a * 2.4 - 31, b * 2.4 - drift * 0.3);
          // A broad shared current carries the smaller fractal folds, so
          // neighbouring marks belong to one surface rather than islands.
          const tissue = fractal(a * 1.8 + warpX * 0.8, b * 1.8 + warpY * 0.8 + drift * 0.22);
          const current = b * 12 + Math.sin(a * 3 + drift * 0.4) * 3;
          const fold = current + tissue * 9 + warpX * 2 + drift;
          const wave = 0.5 + 0.5 * Math.sin(fold);
          const ridge = Math.pow(wave, 10);
          const vein = Math.pow(0.5 + 0.5 * Math.sin(fold * 2 + tissue * 4), 20);
          const seed = ((col * 127 + row * 311) ^ (col * row * 17)) >>> 0;
          const grain = (seed % 101) / 100;
          const veil = noise(a * 2 + drift * 0.2 + 51, b * 2 + warpX);
          // Asynchronous local breathing and a slow travelling glow keep
          // this closer to a colony than a synchronised scanning display.
          const pulse = (0.5 + 0.5 * Math.sin(warpY * 2 + tissue * 2
            - time * 0.48 + noise(drift + 80, a + b) * 2)) ** 6;
          const strength = (ridge * (0.5 + veil * 0.4) + vein * wave * 0.13)
            * (0.85 + grain * 0.15) * (0.85 + breath * 0.15);
          let bloom = 0;
          if (event && origin) {
            // Express the encounter in the same warped plane as the field.
            // It bends with the current, rather than floating over it.
            const along = (a - origin.a) * event.direction;
            const across = b - origin.b + (Math.sin(a * 3 + drift * 0.4)
              - Math.sin(origin.a * 3 + drift * 0.4)) * 0.25;
            const reach = 0.1 + progress * 0.32;
            const gather = Math.exp(-(along * along) / (reach * reach));
            const bend = Math.sin(along * 10 + event.phase + progress * 2) * 0.035;
            const split = Math.max(0, along + 0.08) * Math.sin(progress * Math.PI) * 0.3;
            const filament = (offset: number) => Math.exp(-(((across - bend - offset) / 0.018) ** 2));
            if (event.kind === 0) {
              // Two filaments gently part and knit together again.
              bloom = (filament(split) + filament(-split)) * 0.5 * gather;
            } else if (event.kind === 1) {
              // A small shoal travels through a connected, curling ribbon.
              const head = (progress - 0.5) * 0.5;
              bloom = filament(0) * Math.exp(-(((along - head) / 0.14) ** 2))
                * (0.45 + 0.55 * Math.cos(along * 48 - progress * 8) ** 2);
            } else {
              // A lace-like frond unfolds into three related veins.
              bloom = (filament(0) + filament(split) * 0.65 + filament(-split) * 0.65)
                * 0.45 * gather;
            }
            bloom *= envelope;
          }
          if (strength < 0.035 && bloom < 0.025) continue;
          // Stable glyph identities fade through the current rather than
          // rapidly changing characters at an intensity threshold.
          const glyph = grain < 0.45 ? 0 : grain < 0.7 ? 1
            : grain < 0.94 ? 2 : (seed % 2 ? 4 : 3);
          // How near the nearest thinking pane is, 0..0.75: the share of
          // the glyph drawn in its lamp colour rather than ice.
          let heat = 0, hot: Warm | null = null;
          for (const w of warm) {
            const wx = u - w.x, wy = v - w.y;
            const h = Math.exp(-(wx * wx + wy * wy) / (w.r * w.r * 1.6)) * w.level;
            if (h > heat) { heat = h; hot = w; }
          }
          heat = Math.min(heat, 0.75);
          // The same vignette the other fields sit under, applied to the
          // glyphs too, so the current fades toward the window's edges.
          const ex = (x - width / 2) / (width / 2), ey = (y - height / 2) / (height / 2);
          const fade = 1 - 0.45 * smooth((Math.sqrt(ex * ex + ey * ey) - 0.6) / 0.55);
          const alpha = Math.min(light ? 0.25 : 0.38,
            Math.min(light ? 0.16 : 0.25,
              strength * (light ? 0.14 : 0.22) + pulse * ridge * 0.04)
            + bloom * (light ? 0.13 : 0.22)) * fade * (1 + heat * 0.35);
          const tone = Math.round(veil * 23);
          const px = x + warpX * 8 + Math.sin(b * 8 + drift) * 2;
          const py = y + warpY * 7 + Math.sin(a * 7 - drift) * 2;
          ctx.globalAlpha = alpha * (1 - heat);
          ctx.drawImage(atlas, glyph * sprite, tone * spriteH, sprite, spriteH,
            px - CELL_W / 2, py - CELL_H / 2, CELL_W, CELL_H);
          if (hot && heat > 0.02) {
            let lampAtlas = lamps.get(hot.lamp);
            if (!lampAtlas) { lampAtlas = buildAtlas(palette(light, hot.lamp), ratio); lamps.set(hot.lamp, lampAtlas); }
            ctx.globalAlpha = alpha * heat;
            ctx.drawImage(lampAtlas, glyph * sprite, tone * spriteH, sprite, spriteH,
              px - CELL_W / 2, py - CELL_H / 2, CELL_W, CELL_H);
          }
          ctx.globalAlpha = alpha;
          // Fine curved cilia grow from a few cells; no right angles. Their
          // length and bend breathe continuously with the surrounding field.
          if (grain > 0.96 || (bloom > 0.1 && grain > 0.84)) {
            const curl = Math.sin(warpX * 5 + warpY * 4 + drift);
            const length = 12 + pulse * 15 + bloom * 10;
            ctx.globalAlpha *= 0.45;
            ctx.strokeStyle = colours[tone];
            ctx.lineWidth = 0.65;
            ctx.beginPath();
            ctx.moveTo(px + 3, py + 2);
            ctx.bezierCurveTo(px + 8, py + curl * 12,
              px + length, py - curl * 14, px + length + 5, py - curl * 5);
            if (grain > 0.99) {
              ctx.moveTo(px + 3, py + 2);
              ctx.bezierCurveTo(px - 2, py - 7,
                px - length * 0.6, py + curl * 9, px - length, py - 11);
            }
            ctx.stroke();
          }
        }
      }
      ctx.globalAlpha = 1;
    };
    const tick = (now: number) => {
      if (!running) return;
      // Cap elapsed time on resume, so a pause doesn't arrive as a jump.
      if (now - last >= interval) {
        const dt = Math.min(now - last, 100) / 1000;
        time += dt;
        // The current runs a little faster for each agent at work — the
        // machine's pace, felt rather than shown — and eases, never steps.
        drift += dt * 0.13 * (1 + 0.12 * vitality);
        last = now;
        draw(dt);
      }
      frame = requestAnimationFrame(tick);
    };
    const sync = () => {
      cancelAnimationFrame(frame);
      const visible = !document.hidden && !document.documentElement.classList.contains("glass");
      // Behind another app the field holds still: a frame nobody is looking
      // at still bills the compositor for the whole window.
      running = visible && !motion.matches && document.hasFocus();
      if (visible) draw();
      if (running) { last = performance.now(); frame = requestAnimationFrame(tick); }
    };
    const resize = () => {
      const bounds = canvas.getBoundingClientRect();
      width = bounds.width;
      height = bounds.height;
      ratio = Math.min(devicePixelRatio || 1, 2);
      atlas = null;
      lamps.clear();
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      sync();
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const classes = new MutationObserver(sync);
    classes.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    motion.addEventListener("change", sync);
    redraw.current = sync;
    resize();
    return () => {
      redraw.current = () => {};
      running = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      classes.disconnect();
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      motion.removeEventListener("change", sync);
    };
  }, []);

  return createPortal(<canvas ref={ref} className="drift-field" aria-hidden="true" />, document.body);
}
