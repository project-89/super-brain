# Sensing And Fleet Source Inventory

This inventory records the pinned source behavior used for the terminal sensing
and replay-built fleet slice. Referenced worktrees remained read-only, and dirty
report files were excluded.

## PTY State Capture

Reusable mechanics:

- replace cursor-forward controls with spaces before stripping ANSI;
- remove OSC, CSI, stray escape, fragmented color, box, block, and spinner noise;
- collapse matcher whitespace while retaining visible text;
- classify a bounded recent tail with source-scoped, data-driven rules;
- prefer recent matches and keep uncertain output explicitly `unknown`;
- stabilize Gemini composer/overlay transitions to prevent status flapping.

Excluded host concerns: VT frame state, file paths, JSONL writers, transcript
builders, session capture I/O, and regression comparison.

## Tmux Manager

The manager has one contiguous transition re-emission table. The local signal
contract retains these categories:

- lifecycle: session started, stopped, error, degraded, heartbeat;
- observations: ready/status, login/auth, blocking prompt, stall, tool running,
  task completion, and output;
- classifier assertions: waiting for input, still working, task complete, error.

The local packages do not copy tmux timers or process control. A producer can
feed the existing transition seam into `eventFromTerminalManagerSignal` and emit
a heartbeat from its existing stall timer.

## Haunt

The pinned design record establishes three separate record classes: lifecycle,
observation, and derived belief. It also establishes two constraints adopted
here:

- preprocessors may compress what was observed but cannot decide what it means;
- silence is uninterpretable without lifecycle coverage, so heartbeat expiry
  produces stale/unknown rather than offline.

This is contract evidence only. No Haunt runtime code is imported.

## Parallax

The runtime service keeps runtime registrations and agent/thread-to-runtime maps
only in process memory, forwards connect/spawn/status events, and periodically
checks provider health. At the pinned commit it does not rebuild those maps from
an event log and does not sweep stale sessions after restart.

`fold-fleet` supplies the missing pure read side:

- deterministic boot reconstruction from canonical events;
- immutable `{agent, task, repo, branch, session}` identity validation;
- current, degraded, unavailable, and unknown source availability;
- last-known session state retained separately from current trustworthy state;
- timeout-gated orphan candidates and deterministic reconciliation plans.

Actual runtime probes, process termination, and database writes remain adapter
responsibilities after the local contract is proven.
