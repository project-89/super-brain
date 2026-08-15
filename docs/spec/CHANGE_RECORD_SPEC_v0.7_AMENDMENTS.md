# Change Record Specification v0.7 Amendments

**Status:** draft implementation contract, 2026-08-14.  
**Base:** Change Record design v0.6, SHA-256
`eb2f8c03a8839bf05ce28af8178b88f66b47a0b5429526aeffa619932b48f5c0`.  
**Normative language:** MUST, MUST NOT, SHOULD, and MAY are interpreted per RFC
2119.

This document is normative. It replaces or extends the named v0.6 clauses. All
unmentioned v0.6 clauses remain in force.

## A1. Replay And Clamping (F1)

### Replacement for v0.6 section 6.2

`adjust` is commutative only when its component is declared `numeric`.
`adjust` on a `clampedNumeric[min,max]` component is not commutative because
clamping is part of every application. `set` remains last-write-wins by canonical
sort key.

### Extension to v0.6 sections 8.1-8.3

One canonical **Change application** is one replay step.

1. Events MUST be ordered lexicographically by `(at.t, id)`.
2. Changes inside one Event MUST be applied in serialized array order.
3. A fold MUST clamp immediately after every Change application that writes a
   `clampedNumeric` component.
4. A fold MUST NOT algebraically coalesce clamped adjustments before applying
   or clamping them.
5. Floating-point values MUST be serialized unrounded.

The `1e-9` tolerance for `before` diagnostics does not license approximate state
serialization or closed-form replay. The required Embers fixture starts at
`0.8` and applies `-0.02` in 30 separate Change applications. Incremental replay
produces `0.19999999999999959`, while the closed form `0.8 - (0.02 * 30)`
produces `0.20000000000000007`; implementations MUST preserve the incremental
result because the two values fall on opposite sides of a `0.2` threshold.

## A2. Event Order And Fork Cursors (F2)

### Extension to v0.6 section 8.1

Within one `at.t`, a producer MUST mint Event IDs that are lexicographically
monotonic in authoring order. The canonical comparator compares `at.t` first and
the raw Event ID code units second. Locale-sensitive comparison MUST NOT be used.

### Replacement for v0.6 section 7.1 cursor shape

The canonical fork cursor is:

```ts
type EventCursor = { t: number; eventId: string };
```

`forkAt({t,eventId})` is inclusive. The inherited fold contains every Event with
an ordering key less than or equal to the cursor and excludes every Event with a
greater key.

A bare `t` shorthand MAY be accepted only when validation proves exactly one
Event exists at that `t`. Zero or multiple Events at that `t` MUST produce an
error; an implementation MUST NOT guess a boundary.

## A3. Sensed Provenance (F3)

### Replacement for v0.6 provenance fields

```ts
type Basis = "authored" | "observed" | "estimated" | "derived";

type Method = {
  kind: "sensor" | "classifier" | "oracle" | "model" | "human" | "system";
  id?: string;
  detail?: Record<string, unknown>;
};

type Provenance = {
  basis: Basis;
  confidence?: number; // [0, 1]
  scale?: string;
  method?: Method;
};
```

`basis` describes the epistemic kind of assertion. `method` describes how it was
produced. `classifier`, `oracle`, and model names are method values and MUST NOT
be introduced as `basis` values.

`Provenance` MAY appear on every Change and, when present there, applies to that
assertion only. Two Changes in one Event MAY carry different provenance. The
existing magnitude and valence value envelopes use this same `Provenance` shape.

### Extension to v0.6 section 10

`sensor` is added to `author.kind`. A sensor author ID MUST be a stable sensor URN.

### Capture envelope

Every v0.7 Event MUST carry the capture metadata available at write time:

```ts
type CaptureEnvelope = {
  scope: {
    workspace: string;
    space?: string;
    creator?: string;
  };
  identity?: Record<string, string>;
};
```

`identity` holds producer-local identifiers available at capture, such as
`agent`, `task`, `repo`, and `branch`. Producers MUST NOT fabricate unavailable
identity values. The envelope is immutable event metadata and MUST survive
projection, replay, and serialization losslessly. Recall-time access enforcement
does not replace capture-time attachment.

### Lifecycle events and heartbeat semantics

`lifecycle` is a reserved Event kind. It carries:

```ts
type Lifecycle = {
  sensor: string;
  phase: "online" | "heartbeat" | "degraded" | "offline";
  observedAt: string;       // RFC 3339 instant
  heartbeatWindowMs: number; // positive integer
};
```

A lifecycle Event MUST have `author.kind: "sensor"`, and `author.id` MUST equal
`lifecycle.sensor`. A heartbeat refreshes the observation time but does not by
itself change the last explicitly declared online/degraded/offline phase.

After the heartbeat window expires, current freshness and status become
`stale/unknown`. An implementation MUST NOT synthesize `offline` from silence.
The last explicitly declared phase MAY be returned separately as historical
context, but MUST NOT be presented as the current status after expiry.

Observations and classifier outputs are assertions, not beliefs. A classifier
output uses `basis: "observed"` with `method.kind: "classifier"`; it is not
promoted to truth at capture.

## A4. Required Conformance Cases

The v0.7 suite MUST cover:

1. incremental, per-Change clamping using the Embers threshold-crossing values;
2. two Events at one `t`, with an inclusive cursor selecting the first only;
3. rejection of non-monotonic same-`t` producer IDs;
4. sensor online, heartbeat, observation, classified observation, degraded, and
   offline records;
5. two Changes in one Event with distinct provenance;
6. expired heartbeat yielding `unknown`, never synthetic `offline`;
7. rejection of classifier/oracle as undeclared basis values;
8. capture scope surviving validation, projection, and replay unchanged.

