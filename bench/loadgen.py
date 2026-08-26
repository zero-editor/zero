#!/usr/bin/env python3
"""Synthetic agent-output stream for the under-load benchmark (load.py).

Run inside a terminal of the editor being measured. It registers itself in
the bench directory, waits until the harness says go, then prints RATE
colored ~90-character lines per second for SECS seconds on a fixed schedule
(sleeping to the next slot rather than per line, so the rate doesn't drift
with print cost). The point is a reproducible stand-in for an agent talking:
real Claude output isn't a constant, this is.

Exits immediately if the bench directory does not exist — that is the arm
switch, so a shell-rc hook can call this unconditionally and cost nothing
outside a benchmark run.
"""
import os, sys, time

BENCH = os.path.join(os.environ.get("TMPDIR", "/tmp"), "zero-bench")
RATE, SECS = 25, 180

if not os.path.isdir(BENCH):
    sys.exit(0)

# The marker's name says which app this stream runs in: TERM_PROGRAM is
# "zero" in zero's terminals and "vscode" in Cursor's.
tag = os.environ.get("TERM_PROGRAM", "unknown")
marker = os.path.join(BENCH, f"{tag}.{os.getpid()}")
open(marker, "w").close()

try:
    while not os.path.exists(os.path.join(BENCH, "go")):
        if not os.path.isdir(BENCH):
            sys.exit(0)  # disarmed while waiting
        time.sleep(0.5)

    text = "the stream the editor must keep drawing while the agent talks"
    t0, i = time.time(), 0
    while time.time() - t0 < SECS:
        target = t0 + i / RATE
        now = time.time()
        if target > now:
            time.sleep(target - now)
        color = 31 + i % 6
        print(f"\x1b[{color}m{i:06d}\x1b[0m {text} {i % 97:02d}", flush=True)
        i += 1
finally:
    try:
        os.remove(marker)
    except OSError:
        pass
