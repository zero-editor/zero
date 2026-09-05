# CLAUDE.md

For agents working in this repository. The README says what zero is and why;
this is the part you'd otherwise have to rediscover.

## Releasing — nothing on `main` reaches anyone

The only trigger is a tag. `.github/workflows/release.yml` runs on
`push: tags: v*`, builds the dmg on a macOS arm64 runner in about two minutes,
and attaches it as `zero_aarch64.dmg`. The public download —

```
https://github.com/zero-editor/zero/releases/latest/download/zero_aarch64.dmg
```

— resolves to the newest **release**, which is the newest tag, not the newest
commit. Merging to main changes nothing anyone can download.

**So: after shipping something a user would notice, ask whether it's worth a
release.** Not every commit is, but a change nobody can install is a change
nobody has.

To cut one, from a clean tree on `main`:

```sh
npm version 0.2.0 -m "zero %s

- What changed, for someone deciding whether to update."
git push origin main --follow-tags
```

That is the release, but not the end of it — the cask block below has to run
too, or brew users stay on whatever the last bumped version was.

**The release notes are the tag message. Write them there, not afterwards.**
GitHub's generated notes list *merged pull requests only*, so a release tagged
from a direct push to `main` — which is how most work lands here — would
publish a page saying nothing about what changed. The workflow reads the body
of the annotated tag (everything after the first line of that `-m`) and
publishes it under "What's Changed", between the signing line and the
generated changelog. `gh release edit` after the fact is too late: an
installed copy polls within seconds of publish, fetches the notes then, and
its "what's new" dialog says "no notes for this one". 0.44.0 shipped that way.

**Do not use the word "sha256" in the notes** — the cask block below reads
the body with `awk '/sha256/{print $2}'`, which prints one line per match, so
a second mention silently pins the tap to a mangled hash. Keep it to a couple
of tight bullets: what changed for them, and what still doesn't work.

`package.json` is the only copy of the version. `tauri.conf.json` names it as a
path rather than repeating the number, and `Cargo.toml` sits at `0.0.0` because
nothing reads it. The workflow checks the tag against `package.json` — and
checks that `tauri.conf.json` still points at it, since a literal number put
back there would go stale with nothing to notice.

The Homebrew cask lives in its own repository, `zero-editor/homebrew-tap`, and
pins both the version and the dmg's sha256. **It does not follow releases** —
a new tag means bumping `version` and `sha256` in `Casks/zero.rb` and pushing
that repository too, or `brew install --cask` goes on handing people the old
dmg. The sha256 is printed in the release notes so you don't have to download
the file to get it, and `brew fetch --cask zero-editor/tap/zero` checks the two
agree without installing anything.

**The tag is half a release. Run this before calling one done** — it waits for
the build, reads the sha256 out of the release notes, and bumps the cask. It is
idempotent, so run it whenever the two might have drifted:

```sh
V=$(node -p "require('./package.json').version")
gh run watch --exit-status \
  "$(gh run list --workflow=release.yml --limit 1 --json databaseId -q '.[0].databaseId')"
SHA=$(gh release view "v$V" --repo zero-editor/zero --json body -q .body | awk '/sha256/{print $2}')
TAP=$(brew --repository zero-editor/tap)   # or clone zero-editor/homebrew-tap
git -C "$TAP" pull --ff-only
sed -i '' -e "s/^  version \".*\"/  version \"$V\"/" \
          -e "s/^  sha256 \".*\"/  sha256 \"$SHA\"/" "$TAP/Casks/zero.rb"
git -C "$TAP" commit -am "zero $V" && git -C "$TAP" push
brew fetch --cask zero-editor/tap/zero     # ✔︎ only if the dmg matches the sha256
```

Nothing enforces this — no CI watches the tap — so it is only ever as reliable
as running it. 0.4.0 shipped without it and brew went on installing 0.3.1, with
every check green, because none of them look. The `brew fetch` line is the one
that would have caught it: it is the only step that compares the cask against
the file people actually download.

The same question goes to anything else pinning a version or a checksum. Today
that is the cask and nothing else, so this is the whole list — but the way it
gets missed is assuming it still is.

## Updating in place — the release has a second audience

An installed copy checks
`/releases/latest/download/latest.json` on launch, every half hour, and on
coming back to the window after five minutes away — and if there's a newer
version it downloads and stages it silently. What appears in the titlebar is a
restart, not a download — the waiting is already over by the time anyone sees
it. `src/lib/update.ts` is the whole of the frontend half.

Those intervals are about *lag*, not cost: a check is one unauthenticated GET
of a few hundred bytes off GitHub's CDN, so shortening them is free and the
only thing they buy is how long a release sits unseen. There is nothing to push
with — everything zero ships is a static file on GitHub — so a server would
have to exist before "notify on publish" could, and the poll would stay as its
fallback anyway.

The restart is never automatic, and that is the point rather than an
omission. Restarting zero closes every terminal in it, and a terminal here may
be holding a Claude or Codex session mid-task, so the button arms on the first
click and says what it costs — the live session count comes from the
`agent_status` poll the tab strip already runs — and only the second click
relaunches. The same rule as the one further down about the installed app: it
is not ours to quit.

Three artifacts go up per release, not one. The dmg is for a new user; the
updater reads `zero.app.tar.gz` (the same bundle, signed and notarized and
stapled — the workflow extracts and re-checks it with `stapler validate` and
`spctl` before publishing, because tauri treats missing notarization as a
warning) and `latest.json`, which names the *tagged* tarball URL and carries
its minisign signature. Nothing outside GitHub serves any of it.

A self-updated copy drifts from the Homebrew cask, which pins a version: brew
will still believe whatever `Casks/zero.rb` says until it is bumped, and
`brew upgrade` will reinstall over a newer app. Not harmful, and another reason
the cask block above is not optional.

Always write the install command fully qualified. Homebrew refuses casks from
non-official taps unless you name the tap on the command line — naming it *is*
the consent signal (`Homebrew::Trust.explicitly_allowed?`). A shortened
`brew tap` + `brew install --cask zero` makes users run `brew trust` first.

The only real shortening is homebrew/cask itself, and the gate is a number,
not a judgment: `brew audit --cask --new --online zero-editor/tap/zero` is the
audit their CI runs on submissions, and run against the real cask it fails on
exactly one problem — "GitHub repository not notable enough (<30 forks, <30
watchers and <75 stars)". Any one of the three clears it. Everything else
already passes, so at 75 stars the submission is one PR whose CI outcome is
known.

Submit it as `zero-editor`, not `zero`: a homebrew/core formula already owns
`zero` — another coding agent, actively installed — and bare `brew install`
resolves formulae first, so that token would need `--cask` forever even if
granted. `zero-editor` is free on both sides (measured: formulae.brew.sh 404s
for it as cask and formula), and with no formula sharing the name, bare
`brew install zero-editor` resolves to the cask, no flag needed.

## Signing — it happens in CI and nowhere else

Released dmgs are signed with a Developer ID Application certificate and
notarized, which is what keeps macOS from calling the download damaged. Six
repository secrets drive it, and the release fails on the first missing one
rather than shipping a dmg that only the downloader discovers is unsigned:

| secret | what it is |
|---|---|
| `APPLE_CERTIFICATE` | the Developer ID `.p12`, base64 |
| `APPLE_CERTIFICATE_PASSWORD` | the password given when exporting it |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: … (TEAMID)`, exactly as `security find-identity -v -p codesigning` prints it |
| `APPLE_API_KEY` | App Store Connect key ID |
| `APPLE_API_ISSUER` | App Store Connect issuer ID |
| `APPLE_API_KEY_P8` | the `.p8` key file, base64 |
| `TAURI_SIGNING_PRIVATE_KEY` | the updater's minisign private key (see below) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | the password it was generated with |

The last two are **not** Apple's, and not interchangeable with them. The
updater verifies its downloads with a minisign keypair of its own, generated by
`tauri signer generate`; the public half sits in `tauri.conf.json` and the
private half is those two secrets. Local copies are `~/.tauri/zero.key` and
`~/.tauri/zero.key.password` on Vid's Mac.

**That key has no recovery path, and it is the only credential here that
doesn't.** A lost certificate is re-issued from Xcode in a few minutes. A lost
updater key can't be re-issued at all: every installed copy has the matching
public key compiled into it, so a new keypair means every existing install
rejects every future update and has to be replaced by hand. Back it up
somewhere that isn't this machine.

**Keychain Access is gone in macOS 26**, and with it every set of instructions
on the internet that starts "Certificate Assistant → Request a Certificate".
The certificate is made in Xcode instead: Settings → Accounts → the team →
Manage Certificates → `+` → Developer ID Application, then right-click it →
Export Certificate for the `.p12`. Apple allows five per team, so they aren't
free to make and throw away.

**The certificate expires 1 February 2027.** Not the five years these are
usually described as having — Apple issued this one short, so check rather than
assume. The notarization key doesn't expire at all, which makes the certificate
the thing that breaks first, and it breaks as a failed release rather than as a
bad dmg. To re-read the date from the Mac that holds it:

```sh
security find-certificate -c "Developer ID Application" -p |
  openssl x509 -noout -enddate
```

Local builds stay unsigned, deliberately: tauri only signs when it finds these
in the environment, so `npm run tauri build` costs nothing extra and needs no
keychain. The one visible consequence is that macOS re-asks for the microphone
after every local rebuild — TCC remembers permission per signature, and an
ad-hoc one is new each time.

Two things about this are not obvious from tauri's documentation, and both are
load-bearing:

- **Notarization requires the hardened runtime, and the hardened runtime
  requires an entitlement for the microphone.** `src-tauri/Entitlements.plist`
  is that file, and it exists for `zero-voice` more than for zero — the sidecar
  is the process that opens the mic. The bundler signs every Mach-O in the
  bundle with it, sidecars first and the app last, so one file covers both.
- **tauri notarizes the `.app` and never the `.dmg` around it.** macOS checks
  the disk image too, so the workflow signs, notarizes and staples the dmg
  itself after the build. The `spctl` step that follows is the check that this
  really happened: tauri downgrades missing notarization credentials to a
  warning and signs anyway, and a signed-but-unnotarized dmg looks perfectly
  fine until someone downloads it.

## The terminals outlive the app — there is a second process

Shells are not children of zero. They belong to `zero-ptyd`, a daemon that is
**this same binary re-executed** as `zero --ptyd <socket>` (intercepted in
`run()` before Tauri is touched, so it has no window, no menu, no
NSApplication). A separate crate would have meant a second build, an
`externalBin` entry, a CI step and another Mach-O to sign — for code already
sitting in this one.

The promise is one sentence: **quitting zero takes its terminals with it,
restarting zero does not.** Losing a client starts a clock (`GRACE_MS`, two
minutes); an app that reconnects inside it is handed each shell exactly where
it left off. That is why the window covers a `tauri dev` rebuild — the slowest
restart anyone actually performs, and you will be doing it.

**The socket name carries two things, and both matter.** It is keyed to the
*executable path*, so `/Applications/zero.app` and `target/debug/zero` never
share a daemon — the two-zeros hazard above, in a form that bites silently. And
it carries `proto::VERSION`, because the failure to survive is an *older*
daemon still holding shells across an update, and an old daemon cannot be asked
what it speaks. Bumping that constant is how you say "old daemons must not be
joined"; the cost is that sessions do not survive that one update.

**Reattaching replays a screen, not bytes.** A `vt100::Parser` per session is
fed everything the shell prints, and an attach sends `state_formatted()` —
contents, attributes, cursor, keypad, bracketed paste, mouse mode. vt100 tracks
the alternate screen but never emits it, so the replay prefixes `?1049h`
itself; without that line a Claude session comes back as a *picture* of itself
that corrupts the scrollback when it exits.

**Two rules the daemon breaks nothing else by following, learned the hard
way:**

- **Never `eprintln!`, and never hold a lock across a log call.** The daemon
  inherits stdio, and a parent that piped stderr can exit and leave that pipe
  with no reader — on which `eprintln!` *panics*. A panic under the session map
  poisons it, and the daemon then accepts connections and answers none of them,
  shells all still running, every pane saying the daemon did not answer. It now
  logs through `log()` (errors ignored) into a file of its own beside the
  socket, and `lock()` recovers from poisoning rather than propagating it.
- **`Out::send` queues; it does not write.** A blocking socket write under a
  lock lets one slow client stall every other terminal.

**The escape hatch is not optional.** Persistence removes restart-as-a-fix, so
`zero --sessions` and `zero --kill-sessions` talk to the daemon directly,
without starting a window. They report what is actually left rather than
asserting success.

**They find daemons in the process table, not the socket directory**, filtered
to `TMPDIR` and to a `zero --ptyd <socket>` argv. Every narrowing of that list
has cost something: keying it to the running binary's own path hid the `tauri
dev` daemon, which is the build most likely to be wedged; filtering on
`proto::VERSION` hid the orphan the version *exists* to create, an old daemon
still holding shells after an update; and listing the directory hid one whose
socket had been unlinked while it ran, holding two shells and named nowhere on
disk. A daemon it cannot speak to — wrong protocol, or no socket left to
connect to — is reported with the reason and ended by signal, since killing the
daemon closes the pty masters and the kernel hangs the shells up. Whether they
actually died is then checked, not assumed.

**`--kill-sessions` is machine-wide, and that includes the terminal you are
typing in.** There is no per-project or per-daemon form yet. Scoping `TMPDIR`
used to sandbox it, which is how test scripts ran it safely; reading the
process table ended that, and the way it announced itself was six live
terminals in the installed app dying during a test run. To exercise a kill
path, signal a fixture daemon by pid.

**A change to how sessions are held does not reach anyone until the daemon is
replaced, and shipping the app does not replace it.** The update swaps the
binary; the new app then finds the old daemon still listening on a socket named
the same and joins it, so the change goes on not happening for as long as that
process lives — with a dozen shells open, indefinitely. 0.23.1 shipped the
scrollback replay and changed nothing for anyone for exactly this reason.
Bumping `proto::VERSION` is the only lever that moves the sessions to a new
daemon, and it costs them once, so it is the release note's job to say so.

**Reattaching replays history too, and it is printed rather than restored.**
There is no escape sequence for "here is what scrolled off", so `replay` prints
the daemon's scrollback as ordinary lines and lets the receiving terminal
scroll them off into its own buffer — then `rows - 1` newlines, because
whatever those lines left on the visible screen is about to be painted over by
the screen state rather than scrolled, and without them the newest screenful of
history is the one part lost. `SCROLLBACK` is what bounds it: 2000 rows, about
7 MB for a session that fills it at 120 columns and a 160 KB replay, allocated
only as lines actually scroll off.

**What is not built yet:** a cross-project sessions overlay and live-session
dots on the Launcher — the visibility half.

## Building and installing locally

- **Never quit or relaunch the installed app.** Still the rule, but the reason
  has changed: from the version that added `zero-ptyd`, a relaunch no longer
  costs the Claude sessions in its terminals — the daemon holds them and the
  new instance reattaches. What it costs is Vid's place in whatever he was
  doing, which was never ours to take. Install, say it's installed, and let him
  relaunch it himself.
- **Install atomically** — copy beside, then swap. A `rm -rf` followed by a
  `cp` leaves no app at all if the copy fails:
  ```sh
  rm -rf /Applications/zero.app.new
  cp -R src-tauri/target/release/bundle/macos/zero.app /Applications/zero.app.new
  rm -rf /Applications/zero.app
  mv /Applications/zero.app.new /Applications/zero.app
  ```
- **Never chain `&&` after a piped build.** `npm run tauri build | tail && …`
  reports the pipe's status, not the build's, so a failed build runs the next
  command anyway. Use `set -o pipefail`.
- **Show it in `npm run tauri dev` first**, and wait for an explicit go-ahead
  before building, installing or pushing. Praise for the plan isn't it.

## Two zeros run at once — verify which one you're looking at

While `npm run tauri dev` is up there are two running copies: the installed
`/Applications/zero.app` (the last release) and `target/debug/zero` (the work).
Same bundle id, same window size, pixel-identical chrome, and they share the
session file, so both show the same project and tabs. A screenshot of one is
indistinguishable from the other, and agents have now verified "the dev build"
against the installed app more than once — including driving the installed
app's UI by mistake.

So: **never screenshot, click or type at a zero window without first proving
the dev copy owns it.** The z-order is checkable without accessibility access
— `CGWindowListCopyWindowInfo([.optionOnScreenOnly], …)` returns windows front
to back, so the first zero-owned entry is the window a click would land on:

```sh
DEV=$(pgrep -f target/debug/zero)
TOP=$(swift - <<'EOF'
import CoreGraphics
let wins = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in wins where (w["kCGWindowOwnerName"] as? String) == "zero"
    && (w["kCGWindowLayer"] as? Int) == 0 {
    print(w["kCGWindowOwnerPID"] as? Int ?? 0); break
}
EOF
)
[ "$TOP" = "$DEV" ] && echo "dev window on top" || echo "STOP: installed app on top"
```

If the installed app is on top, stop. `osascript`/System Events can't front the
dev window (no assistive access), so ask Vid to click the dev window forward —
never drive whatever happens to be on top, and never quit the installed app to
get it out of the way. A feature visible in one copy and not the other is
another usable tell (the settings overlay is the easy place to look), but the
pid check is the one that can't be fooled.

The check alone is not enough when the two windows overlap: a click at
coordinates read off an earlier screenshot can land in the installed window's
titlebar and raise it — the layout moves between check and click, and a passed
check says nothing about where you're about to click. So take the dev window's
`kCGWindowBounds` from the same `CGWindowListCopyWindowInfo` call and click
only inside a region the dev window owns and the installed window doesn't
cover; when the installed window is on top, its bounds tell you which strip of
the dev window is still exposed and clickable.

## Numbers in the docs are measured, not estimated

README and BENCHMARKS quote bundle sizes, file counts and timings. If a change
could move one, re-measure it and update both — a stale number in a document
that exists to be precise costs more than no number.

## The icon

`src-tauri/icons/zero-icon.py` draws every icon the app ships and is the only
place any of them is edited. `Assets.car` is the compiled macOS 26 icon and is
committed deliberately, so a build never invokes `actool` — Apple's is
intermittently broken and takes every build with it. The README's "The icon"
section has the whole story.
