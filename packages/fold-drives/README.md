# `@_89/fold-drives`

Incremental drive, wear, and intention state for Super Brain.

The package follows one boundary: fold discrete decisions and causal
discontinuities, but advance continuous drive state step by step. It provides:

- pure linear, exponential, and identified custom drift;
- clamped satiation with the requested and applied amounts retained;
- post-drift wear tracking with hysteresis and asymmetric recovery;
- structured pressure summaries without prose generation;
- explicit serializable drive samples for checkpoint restoration;
- canonical Fold records for samples, satiations, wear transitions, and the
  intention lifecycle;
- deterministic intention replay, urgency, decline cooldown, commitment caps,
  and surfacing eligibility.

`eligibleToSurface` is a signal. Hosts decide whether a satisfier is available,
whether the moment is quiet, what aim to author, and whether to commit or
decline. This package performs no model, process, filesystem, or network I/O.

Continuous state is not reconstructed by applying elapsed time in one closed
form step. Tick granularity changes floating-point threshold behavior and wear.
Restore from an explicit `DriveSystemSnapshot`, then continue with the host's
actual sequence of `advanceDriveSystem` calls.

See [`PROVENANCE.md`](./PROVENANCE.md) and
[`../../docs/inventory/DRIVES_SOURCES.md`](../../docs/inventory/DRIVES_SOURCES.md)
for the pinned Embers evidence and adaptation boundary.
