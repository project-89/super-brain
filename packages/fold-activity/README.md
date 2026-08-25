# `@_89/fold-activity`

Terminal capture primitives for producing canonical Fold sensor records.

## Contracts

- ANSI and terminal drawing controls are removed without joining visible words.
- Consecutive normalized output lines may be run-length encoded; the encoder
  records what appeared and never assigns semantic meaning.
- Terminal state rules are data-driven and source-scoped. `TerminalStateTracker`
  adds bounded history and Gemini transition stability without I/O.
- Lifecycle, observations, and classifier assertions are separate Fold events.
- `validateActivityEventEnvelope` requires matching event kinds, terminal node
  kinds, sensor authorship, payload identity, and capture identity. Unrelated
  Fold sensor lifecycles remain outside the terminal activity domain.
- Terminal emitters require capture identity for `agent`, `task`, `repo`,
  `branch`, and `session` before an event can be created.
- Event IDs and logical `t` values are caller supplied. Wall-clock timestamps
  are never converted into canonical ordering.

`eventFromTerminalManagerSignal` maps the tmux-manager transition vocabulary to
the local canonical API. It is a pure conversion function and does not depend on
tmux-manager at runtime.

```ts
const event = eventFromTerminalManagerSignal(context, stamp, {
  type: "tool_running",
  toolName: "vitest",
});
```

Classifier results use `basis: "observed"` with
`method.kind: "classifier"`. They remain observations, not stored beliefs.

See [`PROVENANCE.md`](./PROVENANCE.md) for pinned sources and extraction limits.
