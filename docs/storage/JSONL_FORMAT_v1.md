# Fold JSONL Format v1

This is the persistence contract implemented by `@_89/fold-storage`.

## Physical Format

- Files are UTF-8 JSON Lines.
- Writers emit exactly one JSON object followed by `LF` per record.
- Readers accept `LF` and `CRLF` records.
- Blank records are invalid.
- The default maximum physical record size is 16 MiB.
- `FoldJournal` serializes operations within one process and journal instance.
  A deployment with multiple processes must assign one writer or provide an
  external lock.
- `sync: true` calls `fsync` after an append or temporary rewrite. It is opt-in
  because the appropriate durability/latency tradeoff belongs to the host.

## Event Record

```json
{
  "formatVersion": 1,
  "recordType": "event",
  "status": "canon",
  "event": { "specVersion": "0.7" }
}
```

`event` must be a complete valid v0.7 Change Record. `status` is `draft` or
`canon`. Event IDs may occur only once in a journal, and IDs authored at the
same `at.t` must increase lexicographically in physical record order.

Draft edits and canonization are whole-journal authoring operations for this
version: rewrite the affected entry atomically and regenerate checkpoints.
Appending a second record with the same event ID is corruption, not a status
update. Canon event substance is never changed by replay.

## Checkpoint Record

```json
{
  "formatVersion": 1,
  "recordType": "checkpoint",
  "checkpoint": {
    "include": "canon",
    "componentSet": "core-v0.7",
    "through": { "t": 42, "eventId": "event-0042" },
    "eventCount": 42,
    "stateDigest": "<sha256>",
    "state": {
      "values": [],
      "nodes": [],
      "edges": [],
      "redirects": [],
      "diagnostics": []
    }
  }
}
```

A checkpoint materializes the Fold state of all event records physically before
it, using its declared draft inclusion and component registry. Readers verify
the cursor, count, stored materialized state, and SHA-256 digest.

Checkpoints are integrity and equivalence anchors in v1. Replay still folds the
event records, so domain packs do not lose historical changes they need for
projection. A future resumable checkpoint format requires explicit per-pack
state codecs and is not implied here.

`core-v0.7` uses the standard Fold component registry. Any custom registry must
use a distinct `componentSet` name, and a verifying reader must supply the
matching registry. Missing registries and digest mismatches fail closed.

## Reopen Policies

`error` is the default and rejects all malformed input.

`recover-truncated-tail` may ignore one record only when all of these are true:

1. it is the final physical line;
2. it has no terminating newline; and
3. it is invalid JSON.

The reader returns a `truncated-tail-ignored` diagnostic. Schema-invalid JSON,
newline-terminated corruption, interior corruption, blank records, oversized
records, invalid event order, and invalid checkpoints always fail.

## Atomic Rewrite

`rewriteJournalAtomically` validates and encodes every record, writes a sibling
temporary file, optionally syncs it, and renames it over the destination. Hosts
use this operation for controlled draft edits, canonization, repair, or
compaction; checkpoint records affected by an edit must be regenerated.
