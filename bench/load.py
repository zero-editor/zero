#!/usr/bin/env python3
"""Editor cost while terminals are busy — the workload zero actually exists
for, and the one none of the other benchmarks touch.

Opens N projects in one editor, waits until a loadgen.py stream is running in
a terminal of each (see below for how they get there), measures the editor's
idle baseline, then flips the go switch and measures CPU and memory again
while every terminal draws 25 lines/second for a minute. The streams' own
python processes are excluded from the totals — they cost both editors the
same; what's measured is what the editor spends parsing and rendering them.

    python3 bench/load.py zero   [project ...]
    python3 bench/load.py cursor [project ...]

Getting a stream into each terminal: either paste
`python3 bench/loadgen.py` into every terminal yourself, or arm a shell-rc
hook first so freshly opened terminals start one on their own:

    [[ -o interactive ]] && [ -d "${TMPDIR:-/tmp/}zero-bench" ] \
      && python3 <repo>/bench/loadgen.py

loadgen is a no-op unless this script's bench directory exists, so the hook
is inert outside a run. zero opens a terminal per project by itself; Cursor
needs a terminal opened by hand in each window (no scriptable path to that
without accessibility access).

Never quits zero with pkill: the pty daemon is the same binary name, and
killing it takes every held terminal session on the machine with it.
"""
import os, re, signal, statistics, subprocess, sys, time

BENCH = os.path.join(os.environ.get("TMPDIR", "/tmp"), "zero-bench")
ZERO_CLI = os.path.expanduser("~/.local/bin/zero")
ZERO_BIN = "/Applications/zero.app/Contents/MacOS/zero"

SETTLE, BASELINE, RAMP, WINDOW = 25, 45, 10, 60

EDITORS = {
    "zero": {
        "open": lambda p: f'"{ZERO_CLI}" "{p}"',
        "match": r"zero\.app|WebKit\.(GPU|Networking|WebContent)|audio\.SandboxHelper",
        "tag": "zero",
    },
    "cursor": {
        "open": lambda p: f'open -a Cursor "{p}"',
        "match": r"Cursor\.app",
        "tag": "vscode",
    },
}

DEFAULT_PROJECTS = [
    "/Users/vidtopolovec/Projects/zero",
    "/Users/vidtopolovec/Projects/metamorfoza",
    "/Users/vidtopolovec/Projects/hyperbot",
    "/Users/vidtopolovec/Projects/racunko",
]


def pids():
    out = subprocess.run(["ps", "-axo", "pid=,command="], capture_output=True, text=True).stdout
    d = {}
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(.*)", line)
        if m:
            d[int(m.group(1))] = m.group(2)
    return d


def cputimes():
    out = subprocess.run(["ps", "-axo", "pid=,time=,command="], capture_output=True, text=True).stdout
    d = {}
    for line in out.splitlines():
        m = re.match(r"\s*(\d+)\s+(\S+)\s+(.*)", line)
        if not m:
            continue
        secs = 0.0
        for p in m.group(2).split(":"):
            secs = secs * 60 + float(p)
        d[int(m.group(1))] = (secs, m.group(3))
    return d


def footprint_mb(pid):
    out = subprocess.run(["footprint", "-p", str(pid)], capture_output=True, text=True).stdout
    m = re.search(r"phys_footprint.*?([\d.]+)\s*([KMG])B", out, re.S | re.I)
    if not m:
        return 0.0
    n, u = float(m.group(1)), m.group(2).upper()
    return n / 1024 if u == "K" else n * 1024 if u == "G" else n


def mine(before, pattern):
    pat = re.compile(pattern, re.I)
    return [pid for pid, cmd in pids().items() if pid not in before and pat.search(cmd)]


def total_mb(before, pattern):
    return round(sum(footprint_mb(p) for p in mine(before, pattern)))


def cpu_window(before, pattern, secs):
    """CPU consumed by the editor's processes over `secs`, in % of one core."""
    t = cputimes()
    ids = set(mine(before, pattern))
    c0, w0 = sum(t[p][0] for p in ids if p in t), time.time()
    time.sleep(secs)
    t = cputimes()
    ids |= set(mine(before, pattern))  # a helper spawned mid-window still counts
    c1, w1 = sum(t[p][0] for p in ids if p in t), time.time()
    return round((c1 - c0) / (w1 - w0) * 100, 2)


def zero_app_pid():
    for pid, cmd in pids().items():
        if cmd.startswith(ZERO_BIN) and "--ptyd" not in cmd:
            return pid
    return None


def ensure_quit(editor):
    app = "zero" if editor == "zero" else "Cursor"
    try:
        subprocess.run(["osascript", "-e", f'quit app "{app}"'], capture_output=True, timeout=15)
    except subprocess.TimeoutExpired:
        pass
    for _ in range(20):
        gone = (zero_app_pid() is None) if editor == "zero" else (
            subprocess.run(["pgrep", "-x", "Cursor"], capture_output=True).returncode != 0)
        if gone:
            return
        time.sleep(0.5)
    if editor == "zero":
        p = zero_app_pid()
        if p:
            os.kill(p, signal.SIGTERM)  # the app only — never pkill, the daemon shares the name
    else:
        subprocess.run(["pkill", "-x", "Cursor"], capture_output=True)
    time.sleep(3)


def markers(tag):
    try:
        return [f for f in os.listdir(BENCH) if f.startswith(tag + ".")]
    except FileNotFoundError:
        return []


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in EDITORS:
        sys.exit(__doc__)
    editor = sys.argv[1]
    cfg = EDITORS[editor]
    projects = sys.argv[2:] or DEFAULT_PROJECTS
    n = len(projects)

    os.makedirs(BENCH, exist_ok=True)
    for f in os.listdir(BENCH):
        os.remove(os.path.join(BENCH, f))  # stale markers or a stale go

    ensure_quit(editor)
    before = set(pids())
    for p in projects:
        subprocess.run(cfg["open"](p), shell=True)
        time.sleep(8)
    time.sleep(SETTLE)

    if editor == "cursor":
        print(f"→ open a terminal in each of the {n} Cursor windows now "
              f"(⌃` — the rc hook starts the stream, or paste: python3 bench/loadgen.py)",
              flush=True)
    print(f"waiting for {n} streams tagged '{cfg['tag']}' …", flush=True)
    t0 = time.time()
    while len(markers(cfg["tag"])) < n:
        if time.time() - t0 > 300:
            sys.exit(f"gave up: {len(markers(cfg['tag']))}/{n} streams after 300s")
        time.sleep(1)
    print(f"{n} streams registered", flush=True)

    mem_idle = total_mb(before, cfg["match"])
    cpu_idle = cpu_window(before, cfg["match"], BASELINE)
    print(f"{editor} baseline, {n} projects, terminals idle: "
          f"{cpu_idle}% of a core, {mem_idle} MB", flush=True)

    open(os.path.join(BENCH, "go"), "w").close()
    time.sleep(RAMP)
    mems = [total_mb(before, cfg["match"])]
    cpu_load = cpu_window(before, cfg["match"], WINDOW)
    mems.append(total_mb(before, cfg["match"]))
    procs = len(mine(before, cfg["match"]))
    print(f"{editor} under load, {n} streams × 25 lines/s: "
          f"{cpu_load}% of a core, {round(statistics.median(mems))} MB "
          f"({procs} processes)   mem samples={mems}", flush=True)
    print(f"{editor} rendering cost of the streams: "
          f"+{round(cpu_load - cpu_idle, 2)}% of a core, "
          f"+{round(statistics.median(mems)) - mem_idle} MB", flush=True)

    for f in os.listdir(BENCH):
        os.remove(os.path.join(BENCH, f))
    os.rmdir(BENCH)
    print("done — editor left running, bench dir disarmed", flush=True)
