# Provenance

`@_89/fold-sdk` is authored entirely in Super Brain over repository-owned
contracts from `@_89/fold` and `@_89/fold-epistemic`.

No external repository code or fixture was copied or adapted for this package.
Its capture-scope rules implement the platform invariants already recorded in
the unified reference and local Change Record specification. Its personal-memory
methods delegate domain validation, replay, and recall authorization to the
local epistemic package rather than duplicating Raven behavior.

The `FoldJournal` integration test uses the local `@_89/fold-storage` package as
a development dependency. Production source depends only on the store port and
does not import filesystem storage.
