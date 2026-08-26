# zero

A minimal macOS code editor built around running coding agents.

Twenty-nine thousand lines, a 19 MB app. It exists because Cursor was an 860 MB
window around a terminal running Claude Code, and almost none of the rest of it
was getting used. So this is the rest of it, removed: projects as tabs, a
terminal that takes the full width, git worktrees down the side, and an editor
for when you actually need to read a file.

Never capitalised. It's `zero`, not Zero.

```
29,465 lines of source   (25,281 code, 4,184 CSS)
    19 MB app bundle            Cursor: 845 MB
  0.4 s to a window from cold   Cursor: 8.2 s
   594 MB with 4 projects open  Cursor: 1,709 MB
```

## Benchmarks

Same machine, same project, both editors, three launches each, median
reported. M3 Max · 36 GB · macOS 26.5.1 · zero 0.25.0 · Cursor 3.17.19
(the cold-launch row is the original 0.1.0-vs-3.15.6 run — it needs a fresh
boot to reproduce).

| | zero | Cursor | |
|---|---:|---:|---|
| App bundle | **19 MB** | 845 MB | 44× |
| Files in the bundle | **7** | 17,021 | |
| Shipped JS | **1.5 MB** at startup, 2.8 MB in all | 265 MB in 11,995 files | 180× |
| Bundled runtime | 0, system WebKit | 257 MB of Electron | |
| Bundled extensions | 0 | 116 | |
| Cold launch, first of the session | **0.38 s** | 8.16 s | 21× |
| Warm: window / ready to use | **0.53 s** / 2.23 s | 1.08 s / 9.52 s | |
| Memory, one project | **409 MB** | 872 MB | 2.1× |
| Idle CPU, one project | **4.69%** of a core | 5.99% | |
| Rendering 4 terminals × 25 lines/s | **+35.8%** of a core | +54.9% | |

The last row is the workload this editor exists for — agents talking in every
project — measured with a synthetic stream because real Claude output isn't
reproducible. The 189 KB compiled Swift helper is in the bundle numbers; two
of the seven files are the code signature a notarized app carries.

Memory is `phys_footprint` — what Activity Monitor shows. Summed RSS would
have said 278 MB against 2,136 MB, but it counts a shared framework page once
per process and so punishes Cursor for having eleven of them. The 2× is the
honest number.

### It gets wider the more projects you open

Cursor opens a **window** per folder — a renderer and an extension host each.
zero opens a **tab**: one process set, one WebKit, every project a subtree of
the same page.

| Projects open | zero | procs | Cursor | procs |
|---|---:|---:|---:|---:|
| 1 | 410 MB | 5 | 866 MB | 8 |
| 2 | 470 MB | 5 | 1,520 MB | 11 |
| 3 | 538 MB | 5 | 1,393 MB | 14 |
| **4, steady** | **594 MB** | **5** | **1,709 MB** | **17** |

Cursor costs about **330 MB and three processes per extra project**, linearly.
zero costs about **60 MB and no processes at all** — the price of keeping a
terminal with 2,000 rows of scrollback and a painted layer tree per project.
Earlier versions claimed the per-project cost was below zero's own noise
floor; the persistence features since have made it real and the noise has
gone (five steady samples: 605, 594, 595, 588, 588 MB), so the claim now is
the smaller, truer one: 2.1× lighter at one project, 2.9× at four.

**~2× at one project, ~7× at four.**

### Frame rate

Not a Cursor comparison — Chromium already drives this display at 120 Hz. It's
zero against a WebKit default that would otherwise ship the app at half its
screen's rate, over 376 scroll frames in the terminal:

| | fps | median frame |
|---|---:|---:|
| Stock WKWebView | 59 | 16.7 ms |
| After the unlock | **125** | **8.0 ms** |
| Safari, same machine, same page | 125 | 8.3 ms |

Safari is the control: it proves the machine was never the limit, only the
default. [How it's done.](#120-fps-in-a-webview)

And the caveat that matters: **Cursor does enormously more** — language
servers, extensions, debugging, an actual AI product. Most of the gap above is
that difference priced in bytes and milliseconds, not better engineering. zero
also carries a live shell in every one of those numbers, which Cursor doesn't
open at all.

[BENCHMARKS.md](BENCHMARKS.md) has the method and the full caveats. The
scripts in [`bench/`](bench/) reproduce the launch, memory and CPU numbers; the
disk and frame-rate ones were measured by hand and say how.

## What's in it

**Projects are tabs.** Each one keeps its own terminals, sidebar and open files,
and switching between them is a compositor swap — every project stays laid out
and painted, so nothing re-fits or re-rasterises when you come back to it.

**A ring per tab tells you what Claude is doing.** A sweeping arc while a
session is working, a closed green circle once it has gone quiet and is waiting
on you. The arc runs on every tab, the one you're on included — switching to a
project isn't the same as its work being over. The green circle is an unread
mark, so that one clears once you've been there. It works by walking each
shell's process tree once a second looking for a live `claude`, then reading
how long that pty has been silent — no integration, no cooperation from the
agent.

**The terminal is the point.** Full window width by default, splits in any
direction with draggable dividers, and no furniture: no title, no bar. The
split and close buttons appear only when the pointer is in the top fifth of a
pane, and `terminal: plain` in preferences strips even the card.

**Git worktrees, not branches.** The sidebar lists every worktree with its
changes, staging, and commit box — which is the shape of the work when several
agents are going at once.

**It shows you what you changed, wherever you are.** Bars in the editor gutter
against every line that differs from the committed file — green for added, blue
for edited, and a red wedge at the seam where lines were deleted — and the same
marks again in a lane beside the scrollbar, so a change you've scrolled past is
still findable. In the file tree, changed files take git's colour and its
letter, and every folder above them takes the colour too: something edited three
levels down is visible without opening anything.

The diff is against HEAD rather than the index, so staging a file doesn't make
its bars vanish — the changes panel goes on listing a staged file, and the two
shouldn't disagree about what changed. A brand-new file gets no bars at all:
every line being "added" is noise, and the tree is where new gets said.

None of it is on a three-second timer. Saving refreshes it, and so does coming
back to the window; between those it polls, but the interval is measured rather
than picked — a sweep is timed and allowed about 7% of the clock, which on this
repository is 14 ms of git and a poll just under a second, and on a monorepo
where `git status` costs half a second is a back-off instead of a stutter. The
tree and the changes panel read one sweep between them.

**Voice memos, per project.** Press record, ramble, press stop. The
transcription is the one built into macOS, so it happens on this Mac, and then
a single `claude -p` pass turns it into the concise version you would
otherwise have pasted into a chat and asked for by hand. A memo that came back
takes follow-ups: the button at the foot of its thread records on top of it,
and the new words are merged into the same document, the follow-up winning
wherever the two disagree.

The mic is not the only way in. A recording made somewhere else — a phone
memo, a call, anything Core Audio reads — imports from a file picker as a memo
of its own, or as a follow-up onto one, and from there it is a recording like
any other: same transcription, same distillation, same merge. It is converted
to the format a recording ends in on the way, so nothing downstream knows the
difference, and the file you picked is only ever read.

Clicking a memo opens it as its thread — what you said, what came back, take
by take, oldest at the top, with the button that records the next take at the
bottom of it. It is still files all the way down, all of them in
`<project>/.zero/memos/`: the audio, the raw transcript of every take, the
document, a copy of the document as each take left it, and the exact `claude`
call that produced each one — a shell script that runs it again, every
argument and the whole of stdin, verbatim. The thread reads those files rather
than standing in for them — ⌥-clicking the row still opens the transcript as an
ordinary tab, and `edit` in the thread's header drops you into the document
itself, where saving it is what it has always been. `developer: show claude
calls` in preferences puts a `claude call` button under every turn that opens
its script, which is the whole of what zero sends.

Speech recognition mangles precisely the words that carry the meaning: TRMNL
comes back as "terminal", Anthropic as "entropic", zero as the digit. So each
project keeps a `ZERO.md` at its root — zero's one setup file per project, the
way a CLAUDE.md is, holding a plain list of that project's proper nouns —
which goes to the recogniser as bias and to the cleanup as context. The second
of those is the one that earns its keep — TRMNL *is* pronounced "terminal",
and in a code editor "terminal" is also a real and frequent word, so only
meaning can tell the two apart.

The list writes itself. The first version is derived from the project's own
README — the one document where a person has already explained the thing in
prose and named everything odd in it — and after that each cleanup pass
suggests the proper nouns it had to correct, marked `(suggested)` so a bad one
is pruned by deleting its line.

The transcriber is new in macOS 26 and there is no second one to fall back to,
so **memos need macOS 26**. Nothing else in zero does.

**⌘P goes to a file.** Fuzzy, over everything git will admit to — tracked files
plus anything new that isn't ignored — so `wsp` finds `components/Workspace.tsx`
and `node_modules` never appears.

**⌘⇧F searches the project**, with case and whole-word toggles, replace, and
comma-separated globs for the files to include and exclude. The matching is
done in Rust rather than shelled out: ripgrep isn't installed on most machines
— and `which rg` can report one that isn't, since Claude Code defines a shell
function by that name — but more than that, drawing a match inside its line
means knowing where in the line it sat, and finding it a second time in the
frontend is how the highlight and the replace end up disagreeing. Both go
through the same matcher.

It's about as quick as the thing it isn't calling. On a 6,777-file, 232 MB
repository, warm: **53 ms**, against ripgrep's 83 ms for the same query. Most
of that is reading the bytes — the per-file work is one in-place case fold and
one question, *is this string anywhere in this file*, and the ~96% that say no
are never split into lines at all.

Literal, though. There's no regex toggle, because there's no regex engine.

**It highlights 143 languages.** Ruby, Go, Java, C and C++, C#, PHP, Swift,
Kotlin, shell, SQL, YAML, TOML, Erlang, Haskell, Clojure — the whole CodeMirror
language set, plus the extensions it doesn't know but everyone writes (`.zsh`,
`.mdx`, `.jsonc`, `.gemspec`, and `.m`, which the upstream list insists is
Mathematica). The seven zero is itself written in are compiled in and applied
the instant a tab opens; the rest are fetched the first time you
open a file of that kind, so a project with no Ruby in it never pays for the
Ruby mode. That's 32 KB on the startup bundle and about a megabyte sitting in
the binary unread.

Still missing, for want of a mode to load: Zig, Nix, Terraform, GraphQL,
Elixir, Makefiles.

Two themes to draw them in: Dark Modern, the VS Code default, and the one from
TRMNL's plugin editor. `⌘,` — or the gear in the title bar — opens settings;
picking a theme lands on every open tab as you click it.

**⌘-click a name in the editor** and it opens where that name is defined,
including through `@/…` tsconfig path aliases. It reads the file's own imports
rather than running a language server, which is a real limit and a deliberate
one: a name re-exported through a barrel lands on the barrel. The alternative
is a long-running process and tens of megabytes.

**⌘-click a path in the terminal.** Files in the project open in the editor
beside it, anything else is revealed in Finder, and `file.ts:42` lands on the
line. Bare URLs open in your browser, as do OSC 8 hyperlinks — the ones where a
program hides a URL behind text like `PR #9422`. Paths are checked against the
disk before they light up, because any pattern loose enough to catch
`src/lib/api.ts` also catches `e.g.`.

**It opens how you left it.** Which projects were open and in what order, the
whole pane layout — every split and its share — the sidebar, the open tabs.
Not the shells — they're children of this process and die with it, so a
restored pane is a *new* shell in the same directory. `claude --continue`
picks the conversation back up, which is usually the part you actually wanted.

**Panels move.** Every panel is the same card — hairline, soft shadow, rounded
corners — and every card is a leaf of one split tree: each terminal, the
editor, the sidebar, all equals, with no layout rules between them. The pill
at the top of a card picks it up, and the drop shows itself as what it is:
aim a re-seat and the layout rearranges under your hand, live and animated,
the gap that opens being the seat; aim a true split and a single accent line
stands on the edge it would cut. The gaps between cards are the resize
handles. A lock in the titlebar fixes the arrangement once you like it —
pills stop arming and nothing can be picked up, while splits and the resize
handles keep working. And for terminals with no chrome at all — no card,
text straight on the window — set `terminal: plain` in preferences.

**Documents come in panes too.** A tab's right-click menu moves it — into a
fresh pane split right or below, or over to the next pane along — and each
pane keeps its own tabs. Whichever pane you last touched is where the next
open lands: the accent under an active tab is that promise, and it stands in
one pane at a time. A document is only ever open once across the window —
opening it again goes to it, wherever it is — and a pane follows its last
tab out. `⌘⇧[` and `⌘⇧]` walk the active pane's tabs, wrapping.

Plus the ordinary things: file tree, diffs, tab reordering by drag, and
`⌘+` / `⌘-` / `⌘0` zoom.

### Keys

| | |
|---|---|
| `⌘T` / `⌃⇧\`` | new terminal |
| `⌘\` / `⌘⇧\` | split terminal right / down |
| `⌘J` / `⌃\`` | show or hide the terminal |
| `⌘B` | sidebar |
| `⌘P` | go to file |
| `⌘⇧F` / `⌘⇧H` | search / search and replace |
| `⌘E` / `⌃⇧G` / `⌘⇧M` | files — walks the tree to the file you're on / worktrees / memos |
| `⌘N` / `⌘W` | new file / close file |
| `⌘⇧[` / `⌘⇧]` | previous / next tab in the pane |
| `⌘\`` | cycle projects |
| `⌘⇧O` | open a project |
| `⌘,` | settings |

## Install

Running zero needs macOS on Apple Silicon and `git`, which the worktree panel
and ⌘P both use. Nothing else.

```sh
brew install --cask zero-editor/tap/zero
```

Or [download the dmg](https://github.com/zero-editor/zero/releases/latest/download/zero_aarch64.dmg)
and drag zero to Applications.

Both are signed with an Apple Developer ID and notarized, so macOS opens them
without a warning and without anything to clear first.

### Or build it

About a minute. Building needs three things beyond running it, and your Mac may
have none of them:

| | is it there? | if not |
|---|---|---|
| Rust | `cargo -V` | [rustup.rs](https://rustup.rs), then open a new shell |
| Node 20.19+ | `node -v` | `brew install node`, or [nodejs.org](https://nodejs.org) |
| Apple's command line tools | `xcode-select -p` | `xcode-select --install` |

The one that isn't obvious from the error it gives: `failed to run 'cargo
metadata' … No such file or directory` means Rust isn't installed.

The build compiles one more thing than it used to: a small Swift helper
(`helper/zero-voice.swift`) that does the recording and the transcription for
voice memos. It wants `swiftc` — already in the command line tools above — and
the macOS 26 SDK, which came with them if that install is recent enough. Memos
need macOS 26 to run, not only to build: the transcriber is the system's.

```sh
npm install
npm run tauri build
cp -R src-tauri/target/release/bundle/macos/zero.app /Applications/
```

This one is unsigned — the certificate lives in the release workflow, not in
the repository — but nothing quarantines an app you built yourself, so it opens
all the same. The one difference you may notice is that macOS asks again for
the microphone after a rebuild: permission is remembered per signature, and an
unsigned build gets a new one every time.

Xcode isn't needed. The macOS 26 icon is a compiled asset catalog, and the
compiled file is committed rather than built here — see below for why.

### Working on it

```sh
npm install
npm run tauri dev
```

The frontend hot-reloads; touching Rust rebuilds and relaunches. `npm run build`
typechecks and bundles the frontend on its own, which is also what
`tauri build` runs first, so a type error fails the release before it compiles
anything.

The Rust side has tests — 11 of them, in about a tenth of a second:

```sh
cd src-tauri && cargo test
```

Two are the hardening described below, and they come as a pair: one proves
`git status` doesn't run a repository's own configured commands, and the other
proves the same repository *does* run them without the guard, so the first can't
quietly stop testing anything.

### Releases

**Nothing on `main` reaches anyone.** The only trigger is a tag, and the
download link resolves to the newest release, not the newest commit.

```sh
npm version 0.2.0 -m "zero %s"   # bumps package.json, commits, tags v0.2.0
git push origin main --follow-tags
```

`.github/workflows/release.yml` then builds the dmg on a macOS arm64 runner —
about two minutes — and attaches it, so the file on the releases page is always
the one that tag builds.

`package.json` is the only copy of the version: `tauri.conf.json` names it as a
path instead of repeating the number, and `Cargo.toml` sits at `0.0.0` because
nothing reads it. The workflow checks the tag against `package.json`, and checks
that `tauri.conf.json` still points at it — a literal number put back there
would go stale with nothing to notice.

The asset is named `zero_aarch64.dmg`, with no version in it, which is what
makes `/releases/latest/download/zero_aarch64.dmg` a link that keeps working;
the tagged URL carries the version instead.

**The Homebrew cask doesn't follow releases.** It lives in
[zero-editor/homebrew-tap](https://github.com/zero-editor/homebrew-tap) and pins
both the version and the dmg's sha256, so a new tag means bumping `version` and
`sha256` in its `Casks/zero.rb` and pushing that repository too — otherwise
`brew install --cask` goes on handing people the old dmg. The sha256 is printed
in the release notes, so you don't need to download the file to get it, and

```sh
brew fetch --cask zero-editor/tap/zero
```

checks the cask and the release agree without installing anything.

One thing that isn't obvious: a dmg built on a runner has no arranged icons in
its window. Tauri's `bundle_dmg.sh` sets that up with an AppleScript that drives
Finder, and it exits 64 when it can't reach one — on a machine with no GUI
session that's not a cosmetic difference, it's a failed build. The bundler
passes `--skip-jenkins` when `CI` is set, which Actions sets, so the layout is
what gets dropped instead.

### The icon

`src-tauri/icons/zero-icon.py` draws every icon the app ships, and is the only
place any of them are edited. It emits two, because macOS is mid-change about
what an app icon is: an `AppIcon.icon` bundle for macOS 26, which hands the
system a transparent zero and a background colour and lets it supply the
rounded rectangle, the material, the shadow and the dark, tinted and clear
variants; and a fully drawn `.icns` for every macOS before that, on Apple's
older grid — an 824px square inside a 1024px canvas, shadow included, because
nothing on those systems will add one. The silhouette in that one isn't a
formula: Apple ships the shape as a template, so it was measured off icons
already drawn to it, and matches the system's own mask to within 750 pixels of
a million.

The layered one ships as `Assets.car`, the compiled form, committed beside its
source. Tauri is perfectly happy to compile it during a build, but that would
put an Apple bug in the way of everyone who clones this: `actool`'s Icon
Composer support intermittently starts crashing — `attempt to insert nil object
from objects[0]` — and once it starts it fails on *every* icon, including
Tauri's own example, until something out of reach resets. Restarting `ibtoold`
doesn't clear it; nor does deleting its pipes or the asset-runtime cache. And a
*missing* `actool` the bundler skips politely, while a *crashing* one fails the
build outright. Committing the compiled file means a build never calls it, and
regenerating the icon does — `zero-icon.py` recompiles when it can and leaves
the committed file alone when Apple is in one of its moods.

### The `zero` command

zero installs a `zero` command into `~/.local/bin` every time it launches, so
putting the app in `/Applications` is the whole installation.

```sh
zero          # launch or focus
zero .        # open this directory as a project
```

It hands the directory over through a file the app watches rather than through
arguments: `open -a` doesn't pass argv to a running app, and launching the
binary directly would start a second instance with its own set of shells.

## Things it does to your machine

All six are the kind of thing you'd want told to you plainly rather than
discovered:

- **It writes `~/.local/bin/zero`** on every launch (overwriting it, if you've
  edited it). Delete `cli.rs`'s `install_command` call in `lib.rs` if you'd
  rather it didn't.
- **It points `ZDOTDIR` at its own directory** for the shells it spawns, so it
  can shorten the prompt from `user@host dir %` to `dir %`. Its startup files
  source yours first and hand `ZDOTDIR` straight back, and the prompt is
  replaced *only* if it's still macOS's stock one — set `PROMPT` yourself and
  zero won't touch it. Same technique VS Code and Warp use.
- **It names itself `TERM_PROGRAM=zero`** in those shells, and drops the
  `TERM_SESSION_ID` it inherited from whatever launched it — otherwise macOS's
  shell-session integration greets every new terminal with "Restored session:"
  and saves history into `~/.zsh_sessions` on behalf of someone else's window.
- **It writes `<project>/.zero/`** the first time you record or import a voice
  memo in that project — the audio and both transcripts — **and a
  `<project>/ZERO.md`** beside it, the vocabulary that project is transcribed
  against, which is meant to be committed the way a CLAUDE.md is. They are the
  first things zero has ever put inside a project of its own accord, and they
  appear only if you press record, import a recording, or open that file from
  the panel.
- **It appends `.zero/memos/` to that project's `.gitignore`** at the same
  moment, once, under a comment saying which program added it. The recordings
  stay on your machine; `ZERO.md` is outside that line, so the project's words
  are the part that travels with the repository. It skips the append if the
  path is already ignored or the directory isn't a repository, and it never
  writes the line a second time — delete it and it stays deleted.
- **It asks for the microphone** the first time you press record — macOS's own
  prompt, at the press rather than at launch, so merely opening the tab asks
  for nothing.

There is still no network code in this app, which used to be the whole story
and isn't quite any more. Transcription runs on this Mac, though the OS may
download Apple's speech model once if system dictation never has. And the
cleanup pass pipes the transcript through the `claude` CLI you were already
running, which sends it to Anthropic — the same trip as anything else you type
into it. Skip that step or let it fail, and nothing has left the machine.

### Opening a repository doesn't run its code

A repository can name programs for git to run in its own `.git/config`, and
some of them fire on plain reads: `core.fsmonitor`, and a `filter.<n>.clean`
selected by the repo's own `.gitattributes`, both execute during `git status`.
The worktree panel is the default sidebar tab and polls status about once a
second, so opening a repository that arrived with a `.git` directory already
in it would otherwise be enough to run a stranger's command.

So the commands that run on their own — `worktree list`, `status`, `rev-list`,
`show` — blank every config key that names a program, but only where the
*repository* set it, never your own global config. Staging, committing and
pushing are left alone: a blanked clean filter would stage the wrong bytes, and
hooks are rather the point of committing. Those you asked for; the others run
whether you asked or not.

One consequence worth knowing: if you configured git-lfs into a repository's
local config rather than globally, its files may show as modified in the panel.
`git lfs install` writes to your global config by default, where zero won't
touch it.

## 120 fps in a WebView

The most interesting thing in here is 60 lines of Objective-C messaging in
[`src-tauri/src/high_refresh.rs`](src-tauri/src/high_refresh.rs).

**WKWebView clamps rendering to 60 fps**, even on a 120 Hz ProMotion display.
You will find it widely claimed that macOS 26 removed this. That claim is
false — measured on 26.5.1, a Tauri window renders at 59 fps while Safari on
the same machine, on the same page, does 125.

Safari isn't special. It just turns the clamp off, through a WebKit feature
flag named `PreferPageRenderingUpdatesNear60FPSEnabled`. The flag is reachable
from the app side, but only through private API: `+[WKPreferences _features]`
returns every feature object WebKit knows about, and
`-[WKPreferences _setEnabled:forFeature:]` toggles one. So zero walks the
feature list at startup, finds that key, and switches it off.

```
before   59 fps   median frame 16.7 ms
after   125 fps   median frame  8.0 ms   (p90 9.0 ms over 376 scroll frames)
```

Everything is guarded — `respondsToSelector` on both selectors, and the whole
thing degrades to a printed line and a 60 fps app if a future WebKit drops
either. The cost is that **this rules out the Mac App Store forever**, which is
why it's opt-out-able by deleting one call in `lib.rs`.

## Smooth scrolling a terminal

The other piece worth reading is
[`src/lib/smoothTermScroll.ts`](src/lib/smoothTermScroll.ts).

xterm.js quantises scrolling to whole rows: its viewport rounds `scrollTop` to
a row index and only emits a scroll when that index changes. This happens
*above* the renderer, so switching to canvas or WebGL doesn't help — DOM,
canvas and WebGL all step identically. Terminal scrolling feels worse than a
web page because it genuinely is.

zero takes the wheel events itself, hands xterm the whole rows, and applies the
sub-row remainder as a GPU transform on `.xterm-screen`. Text selection stays
aligned for free, because xterm derives mouse coordinates from
`getBoundingClientRect`, which already includes the transform. The transform is
never cleared to `""` — always `translate3d(0, 0, 0)` — since dropping it
destroys the composited layer and the next gesture pays 150 ms to rasterise a
new one.

## Built with

[Tauri 2](https://tauri.app) · [React 19](https://react.dev) ·
[CodeMirror 6](https://codemirror.net) · [xterm.js 6](https://xtermjs.org) ·
[portable-pty](https://github.com/wez/wezterm/tree/main/pty)

The DOM renderer is used for the terminal on purpose: WebGL contexts get
dropped by WKWebView, which shows up as frozen panes and webview crashes, and
the only published canvas addon is compiled against xterm 5 internals and
renders nothing on 6.

## License

MIT. See [LICENSE](LICENSE).
