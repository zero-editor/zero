# Benchmarks

zero against Cursor, both opening the same project on the same machine, in the
same session. The launch, memory, idle-CPU and multi-project numbers are
reproducible with the scripts in [`bench/`](bench/) — run them yourself rather
than taking them on trust. The disk, frame-rate and line-count tables have no
script; they were measured by hand, and the commands are given beside them.

Read the [caveats](#what-this-is-not) before quoting any of it. Cursor does
enormously more than zero does, and most of the gap below is that difference
showing up as a cost, not Cursor being badly built.

```
Machine   Apple M3 Max · 36 GB · macOS 26.5.1
Cursor    3.17.19, with the extensions I actually have installed
          (3.15.6 for the cold-launch row only)
zero      0.25.0 (0.1.0 for the cold-launch row only)
Project   the zero repo itself — 29.5k lines, a git worktree, node_modules
          present
Method    3 launches each, median reported, apps quit between runs;
          measured 2026-08-26 on an idle machine, from a clean session so
          zero opens exactly the projects the benchmark names
```

## Disk

| | zero | Cursor | |
|---|---:|---:|---|
| App bundle | **20 MB** | 845 MB | 42× |
| Installer | **8.1 MB** dmg | — | |
| Files in the bundle | **7** | 17,021 | |
| Shipped JS | **1.5 MB** loaded, 2.8 MB in all | 265 MB across 11,995 files | 180× |
| Electron/WebKit runtime | 0 (system WebKit) | 257 MB bundled | |
| Bundled extensions | 0 | 116 | |

zero's bundle is seven files — five of substance, plus the two-file code
signature notarized releases carry — because Tauri compiles the frontend into
the binary and uses the WebKit that ships with macOS. Electron carries its own
Chromium.

The fifth arrived with voice memos in 0.2.0: `zero-voice`, a 175 KB Swift
binary (189 KB today) that records and transcribes, spawned per request rather
than held open. It was only a sixth of the megabyte the bundle grew — the
icons didn't change, so the rest was the memo pipeline compiled into the main
binary, which is 16.7 MB of the 19 today.

The bundle gained a megabyte in 0.20.0 and no files at all: the terminal
daemon is the same binary re-executed, so `vt100` and the daemon's own code
landed inside the main binary rather than beside it.

Two of those five are the icon, and they're most of the 2 MB the bundle grew
in August 2026: a 428 KB `.icns` for macOS 25 and earlier, and a 1.6 MB
`Assets.car` holding the layered macOS 26 icon, which the system renders in
seven appearances — light, dark, clear light and dark, tinted light and dark,
and the mono one. That's the price of letting the system compose the icon
instead of drawing it ourselves, and it is a real 11% of the app.

Two JS numbers, because the syntax highlighting split them apart: 1.5 MB is
what loads to draw the window, and the other 1.3 MB is 115 lazy chunks — most
of them language modes — fetched only when a file of that kind is opened. Both
live inside the binary; neither adds a file to the bundle.

The JS figure was wrong here until it was rechecked: it read 12 MB, which was
a measuring mistake — `find … | xargs du -ch | tail -1` splits into several
xargs batches on a tree this size and `tail -1` reports only the last one. The
sum of every `.js` file in the bundle is 265 MB, and one file alone
(`workbench.glass.main.js`) is 46.9 MB. The error was in Cursor's favour, and
the corrected ratio is the 180× in the table.

```sh
du -sh /Applications/Cursor.app                     # bundle
find /Applications/Cursor.app -type f | wc -l       # files
find /Applications/Cursor.app -name '*.js' -type f -exec stat -f %z {} + \
  | awk '{s+=$1} END {print s/1048576 " MB"}'       # shipped JS
```

For reference, the same machine's Visual Studio Code is 820 MB across 6,577
files — Cursor's extra bulk over it is Cursor's own, not Electron's.

## Launch

Time from `open` to the app's first window on screen, via the Accessibility
API, then to *ready* — the first moment after the window appears when CPU drops
below 10% of a core and stays there. The second number matters because
Electron puts an empty window up early and fills it afterwards; measuring only
"a window exists" would flatter it.

| | zero | Cursor |
|---|---:|---:|
| Window on screen | **0.53 s** | 1.08 s |
| Ready to use | **2.23 s** | 9.52 s |
| First launch of the session (cold) | **0.38 s** | 8.16 s |

The cold row is the one measurement not re-run on 2026-08-26 — it needs a
fresh boot, so it is still 0.1.0 against 3.15.6 and says so rather than being
adjusted on paper. It is also the honest one for how it feels in practice: the
first time you open an editor after booting, Cursor took **8.2 seconds** and
zero took **0.4**. zero has essentially no cold penalty because there is
almost nothing to page in.

## Memory

Two accountings, because they disagree and only one of them is fair.

| | zero | Cursor | |
|---|---:|---:|---|
| **phys_footprint** (Activity Monitor's "Memory") | **409 MB** | 872 MB | 2.1× |
| Summed RSS across processes | 278 MB | 1,805–2,136 MB | |
| Processes | **5** | 8–11 | |

**Use the first row.** Summed RSS counts a shared framework page once per
process, so it punishes Cursor for having eleven of them and produces a
headline like "7× less memory" that isn't true. By macOS's own accounting the
real answer is that zero uses **a bit under half**. That's a good result, not a
spectacular one, and the spectacular version would have been wrong.

Worth noting for anyone reading zero's code: its single largest consumer isn't
the app at all, it's `WebKit.GPU` at 226 MB — more than half the total, and
seven times the 32 MB the zero process itself uses.

In the 0.1.0 measurements this table and the first row of the next one
disagreed by 200 MB, because WebKit's GPU process grows and is reclaimed on a
schedule of its own. Re-measured, the two runs land at 409 and 410 MB —
either the GPU process has calmed down since, or that run got lucky. The
sampling spread under the next table is what says how much a single figure
can be trusted.

## Multiple projects

This is the one that actually matters if you keep several agents going at
once, and it's where the two architectures diverge. Cursor opens a **window**
per folder — a renderer and an extension host each. zero opens a **tab**: one
process set, one WebKit, each project a subtree of the same page that stays
laid out and painted so switching is a compositor swap.

Opening four real repos one after another, measuring after each:

| Projects open | zero | | Cursor | |
|---|---:|---:|---:|---:|
| | memory | procs | memory | procs |
| 1 | 410 MB | 5 | 866 MB | 8 |
| 2 | 470 MB | 5 | 1,520 MB | 11 |
| 3 | 538 MB | 5 | 1,393 MB | 14 |
| 4 | 594 MB | 5 | 1,851 MB | 17 |
| **4, steady state** | **594 MB** | **5** | **1,709 MB** | **17** |

The process counts exclude the terminal daemon, which pre-exists the launch
the diff is taken around — one more process regardless of how many projects
are open, 2.1 MB of `phys_footprint` empty and a few tens of MB holding live
sessions with full scrollback.

**Cursor costs about 330 MB and three processes per extra project.** That's
linear and it doesn't flatten out.

**zero costs about 60 MB per extra project, and no processes at all.** The
0.1.0 measurements claimed the per-project cost was below zero's own noise
floor, and it was — that run gave steady-state samples of 243, 243, 243, 243,
506 MB. Both halves of that have changed. The cost is real now: +60, +68,
+56 MB across the three added projects, which is what keeping a terminal with
2,000 rows of scrollback and a painted layer tree per project actually
weighs. And the noise is gone: five steady-state samples now read 605, 594,
595, 588, 588 MB. zero's memory grew since 0.1.0 — that's the terminal
persistence and scrollback features, priced in megabytes — and the honest
table says so rather than keeping the flattering old rows.

The gap still widens with use — **2.1× at one project, 2.9× at four** — but
less dramatically than the ~7× the 0.1.0 run showed. If you work the way this
editor was built for — several repos open, an agent in each — that's the
number to look at, not the single-project one.

The trade zero makes for this is deliberate: every project stays painted, so
none of them re-render when you switch. That's a bet that GPU layers are
cheaper than re-rasterising, and at four projects it's clearly paying. I
haven't measured twenty.

## Idle CPU

CPU time consumed over 30 seconds of sitting there untouched, as a percentage
of one core.

| | zero | Cursor |
|---|---:|---:|
| Idle, one project | **4.69%** | 5.99% |
| Idle, four projects | **3.42%** | 11.35% |

Cursor's is file watchers, the extension host, and a git worker, and it
roughly doubles when four windows each carry their own set. zero's is its
once-a-second poll for what Claude is doing in each terminal, and it does not
grow with projects. Neither is as low as the 0.1.0-era measurement (1.10%
against 2.66%) — zero's idle cost has grown with its features, and saying so
beats quoting the old number.

## Under load

The workload zero actually exists for, and the one none of the tables above
touch: what the editor costs while agents are talking. Real Claude output
isn't reproducible, so `bench/loadgen.py` stands in for it — four projects
open, a stream in each terminal printing 25 colored lines a second, editor
CPU and memory measured over a minute of that and attributed the same way as
everywhere else. The streams' own processes are excluded; they cost both
editors the same. What's left is what each editor spends parsing and drawing
100 lines a second.

| | zero | Cursor |
|---|---:|---:|
| 4 projects, terminals idle | 3.42% of a core | 11.35% |
| 4 streams × 25 lines/s | **39.25%** | 66.22% |
| **Cost of the streams** | **+35.8%** of a core | +54.9% |
| Memory while streaming | +103 MB | ~0 |

zero renders the same firehose for two thirds of Cursor's CPU, on top of an
idle floor a third the size. The +103 MB is the scrollback buffers doing
their job — 2,000 rows per terminal filling up — and it stops growing when
they do. Cursor's memory doesn't move because its terminal keeps less.

One caveat: the Cursor half of this table was measured earlier in the day
than the quiet-machine window the rest of the tables come from, because its
integrated terminals have to be opened by hand. CPU is attributed per
process, so the difference is noise, not headroom.

## Frame rate

Not a comparison with Cursor — Chromium already drives ProMotion displays at
120 Hz. This is zero against *itself*, because WKWebView caps rendering at 60
fps by default and the app would otherwise ship at half its display's rate.
Measured over a sustained scroll in the terminal:

| | fps | median frame | p90 |
|---|---:|---:|---:|
| Stock WKWebView | 59 | 16.7 ms | |
| After the unlock | **125** | **8.0 ms** | 9.0 ms |
| Safari, same machine, same page | 125 | 8.3 ms | |

376 scroll frames. Safari is in the table because it's the control: it proves
the display and the machine were never the limit, only the default. How the
flag is flipped is in the [README](README.md#120-fps-in-a-webview).

You will see it claimed that macOS 26 removed this clamp. Measured on 26.5.1,
that is false.

## Code

| | zero | Cursor |
|---|---:|---|
| Source | **38,097 lines** (18,408 TS/TSX · 12,638 Rust · 6,243 CSS · 808 Swift) | closed, VS Code fork |
| npm dependencies | **30** direct, 77 in the production tree | — |
| Rust crates | 492 | — |

Voice memos roughly doubled it: 4,009 of the Rust lines and 808 of the Swift
are the memo pipeline and its helper.

```sh
find src -name '*.ts' -o -name '*.tsx' | xargs wc -l | tail -1   # TS/TSX
find src-tauri/src -name '*.rs'        | xargs wc -l | tail -1   # Rust
find src -name '*.css'                 | xargs wc -l | tail -1   # CSS
wc -l helper/zero-voice.swift                                    # Swift
```

## What this is not

The comparison is only honest with all of this attached:

- **Cursor does vastly more.** Language servers, autocomplete, an extension
  ecosystem, debugging, remote development, notebooks, settings sync,
  multi-platform, and an actual AI product. zero has none of that. It opens
  files, runs terminals, and shows you git worktrees. **Most of the gap above
  is that difference, priced in bytes and milliseconds.** A fair one-line
  summary is "doing less costs less", not "zero is better engineered".
- **zero's numbers include a live shell.** It always has a terminal open;
  Cursor opens none by default. That handicap is real and I've left it in.
- **Cursor was measured with my extensions installed**, which is how I actually
  ran it — not a clean profile. A stock install would use less.
- **Neither had an agent running.** Put Claude Code in both and that process
  dwarfs the editor either way. The Under load table is the nearest thing —
  a synthetic stand-in for agent output at a fixed rate — and it measures the
  editor's share only, not the agent's.
- **Nothing here measures the things you feel most**: typing latency, scroll
  smoothness, search speed on a big repo, or how either behaves on a 50 MB
  file. Those need instrumentation I don't have, and I'd rather report nothing
  than guess.
- **Single machine, single session, n=3.** Launch timings in particular move
  with disk cache state.

- **The frame-rate table is not a win over Cursor.** Chromium already renders
  at 120 Hz on this display. That measurement is zero against a WebKit default,
  and it's included because it's the one number the app was explicitly built to
  move.

## Reproducing

```sh
python3 bench/drive.py [project-path]      # launch, memory, idle CPU, 3 reps
python3 bench/mem.py   [project-path]      # phys_footprint per process
python3 bench/multi.py [project ...]       # memory as projects are added
python3 bench/multi_steady.py [project ...]  # steady state, sampled 5×
python3 bench/load.py zero|cursor [project ...]  # editor cost under terminal load
```

`load.py` needs a `bench/loadgen.py` stream running in each terminal; its
docstring explains the shell-rc hook that starts them automatically, and for
Cursor the terminals themselves have to be opened by hand.

A warning before running any of these from a terminal that lives inside zero:
they quit and relaunch the editor, and `multi.py`/`multi_steady.py` fall back
to `pkill -x zero` — which also matches the pty daemon, the process holding
every terminal session on the machine. Run them from Terminal.app.

Both diff the process table around launch, so an app's helpers are attributed
to it whether they live inside the bundle (Electron) or in `/System` (WebKit's
XPC services). Anything already running is excluded. CPU is measured as the
delta of cumulative CPU time over a wall interval — `ps %CPU` reports an
average over the process's whole lifetime and is useless for this.

`drive.py` needs Accessibility permission for the terminal it runs in, to count
windows.
