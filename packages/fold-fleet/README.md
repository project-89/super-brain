# `@_89/fold-fleet`

Replay-built fleet state over canonical Fold activity and lifecycle events.

`rebuildFleet` is the boot reconstruction path. It sorts canonical events,
validates immutable source identity, and derives one snapshot per terminal
session. No in-memory map is authoritative; the same log rebuilds the same fleet
state after restart.

Only validated terminal activity node kinds enter this projection. Lifecycle
records from other Fold sensors are ignored rather than rejected or interpreted
as terminal sessions.

Freshness and operational state stay separate:

- current `online` or `heartbeat` coverage makes the last known session status
  usable;
- `degraded` remains distinct from `offline`;
- missing lifecycle coverage or an expired heartbeat surfaces `unknown`;
- silence never manufactures an `offline` lifecycle event;
- stale active sessions become orphan candidates only after `orphanAfterMs`.

`planOrphanRecovery` returns deterministic `reconcile_orphan` actions. Hosts own
the actual probe, stop, or persistence operation; this package does not perform
process or network I/O.

See [`PROVENANCE.md`](./PROVENANCE.md) for pinned sources and extraction limits.
