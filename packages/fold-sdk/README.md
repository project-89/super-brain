# `@_89/fold-sdk`

Scoped producer and consumer APIs over canonical Fold records.

`FoldSdk` accepts a small `FoldSdkStore` port. `@_89/fold-storage`'s
`FoldJournal` satisfies that port directly, while tests and services may provide
another implementation. The SDK owns these delivery rules:

- validate every event and stored entry at the boundary;
- enforce capture-time workspace, optional space, and optional creator scope on
  append and every read;
- preserve canonical/draft separation and explicit inclusive `(t, eventId)`
  cursors;
- reject duplicate IDs and nonmonotonic same-time producer IDs;
- project only the records currently visible to the caller;
- expose personal memory through record, revise, forget, lookup, and recall
  methods without returning its raw projection;
- reauthorize externally ranked memory candidates before returning them.
- record scoped shared decision trees and trajectories, then return task
  summaries and projection-gap-safe analysis without exposing an unfiltered
  trajectory projection.
- append validated terminal-manager signals and rebuild JSON-safe fleet sessions
  and orphan recovery plans from the caller's current canonical view.

Workspace roles do not override creator-scoped privacy. Space access is supplied
freshly on every call, so revocation removes scoped records from both raw event
reads and derived memory recall.

The SDK serializes all operations made through one instance, including the
read-check-append sequence. A service with multiple SDK instances or processes
must provide equivalent transactional single-writer behavior in its store; the
minimal store port does not pretend to implement distributed locking.

The package performs no network, model, process, or database I/O. HTTP
authentication, membership resolution, vector ranking, IDs, clocks, and service
transactions remain host responsibilities. See [`PROVENANCE.md`](./PROVENANCE.md)
for the ownership boundary.
