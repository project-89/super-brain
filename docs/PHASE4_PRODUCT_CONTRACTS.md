# Phase 4 product and feedback handoff

Implemented and verified against the Phase 3 interfaces. The final Node 24.20.0/PostgreSQL gate passed 637 tests across 104 files, all typechecks and both builds. Actual browser checks and review regressions are recorded in `PHASE4_VALIDATION.md`. The existing Brain visual language is preserved.

## Ownership

- Platform: `fold-epistemic` feedback schema/replay, SDK/API authorization and aggregates, canonical client transport and operations.
- Product: Brain adapter, connection/token refresh integration, task evidence and memory review surfaces, processing/value display, browser fixture support. Capture daemon's operator-only status bridge belongs to this track if needed.
- Processing: MCP bounded context/completion/adoption flow, independently durable Node telemetry adapter, worker processing status publication. Coordinate shared client types before coding.

## Shared transport

`SuperBrainClient` owns canonical API requests, errors, stable mutation stamps, pagination, cancellation and deadlines. Accept a token supplier and obtain a fresh token for each request/reconnect. Honor caller cancellation through response body consumption; preserve abort/deadline classification and bounded retry hints. Do not silently replay non-idempotent mutations with new stamps. Brain retains only connection preferences and local private-artifact/operator access in its adapter. Never pass its operator token to a canonical API request. Session discovery also uses the shared transport policy.

Cover actual existing Brain operations rather than leaving a second private canonical request helper for unsupported routes. Reuse shared domain response types where possible. Keep pagination explicit; no accidental unbounded fetch-all in browser screens or context tools.

## Feedback meaning and delivery

Feedback joins the exact memory ID and revision that was presented, stable recall/batch identity, rank and ranking/provider provenance, and available task/attempt/session context. Revision zero is valid. Preserve historical legacy feedback as unattributed-to-revision rather than retroactively attaching it to the current revision.

Represent offered, injected, used, judged and outcome separately. Returning a context packet proves delivery only; actual use/adoption must be explicitly reported. Helpful/unhelpful/superseded are judgments and do not certify truth or automatically supersede a memory. An observed task outcome is linked to the Phase 3 record, not inferred from a usefulness vote.

Add a narrow `feedback:write` capability for an otherwise read-only principal. Feedback requires access to the referenced memory and exact revision; it must not grant memory editing or candidate acceptance. Preserve the memory's scope/audience in feedback. Recheck authorization on retry and prevent raw-event ingress from bypassing feedback validation. Bounded batch writes have stable IDs and atomic idempotent retry behavior.

Optional automatic telemetry must not fail, block, or cancel a successful recall. Separate a durable outbox from read delivery and expose pending/retry/denied/exhausted state. Persist only necessary identifiers and signals by default, not question text or credentials. Browser and Node persistence adapters share the logical outbox contract but use their appropriate storage. Partition by actual organization/workspace/principal identity; token rotation must not create a new namespace or deliver one account's feedback as another. Bound queue size and retry attempts. Persistent storage failure is visible as unavailable telemetry, without losing the successful read. An in-memory queue alone is not durable.

## Concrete shared ports

These additive contracts coordinate the platform, product and processing tracks. `RequestOptions {signal?,timeoutMs?}` and the existing `SuperBrainApiError` now include shared classification/retry behavior. `SuperBrainClientOptions.token` accepts either the existing string or a `TokenSupplier = (signal?:AbortSignal) => string | undefined | Promise<string | undefined>`. A request deadline includes token acquisition and body consumption. An unavailable token fails that request explicitly, without reusing a prior account's token. Each SSE reconnect resolves the supplier again. The exported source declarations remain the authoritative complete signatures.

```ts
interface AuthorizedReadSubject {
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly principalId: string;
}

interface RecallProvenance {
  readonly version: 1;
  readonly recallId: string;
  readonly subject: AuthorizedReadSubject;
  readonly observedAt: string;
  readonly operation: "recall" | "search" | "reasoning";
  readonly ranking: {
    readonly id: string;
    readonly kind: "lexical" | "semantic" | "explicit";
    readonly configRevision?: string;
  };
  readonly provider?: { readonly id: string; readonly configRevision?: string };
  readonly items: readonly {
    readonly memoryId: string;
    readonly memoryRevision: number;
    readonly rank: number;
  }[];
}

interface MemoryFeedbackInputV2 {
  readonly version: 2;
  readonly memoryRevision: number;
  readonly recallId: string;
  readonly signal: "offered" | "injected" | "used" | "judged" | "outcome";
  readonly judgment?: "helpful" | "unhelpful" | "superseded";
  readonly rank?: number;
  readonly ranking?: RecallProvenance["ranking"];
  readonly provider?: RecallProvenance["provider"];
  readonly taskId?: string;
  readonly attemptId?: string;
  readonly sessionId?: string;
  readonly outcomeEventId?: string;
  readonly detail?: string;
}

interface MemoryFeedbackBatchItem {
  readonly stamp: EventStamp;
  readonly memoryId: string;
  readonly input: MemoryFeedbackInputV2;
}

interface TelemetryBatch {
  readonly version: 1;
  readonly subject: AuthorizedReadSubject;
  readonly stamp: EventStamp;
  readonly items: readonly MemoryFeedbackBatchItem[];
}

interface TelemetryOutboxStatus {
  readonly pending: number;
  readonly retry: number;
  readonly denied: number;
  readonly exhausted: number;
  readonly unavailable?: string;
  readonly observedAt: string;
}

interface TelemetryOutbox {
  enqueue(batch: TelemetryBatch): Promise<void>;
  status(): Promise<TelemetryOutboxStatus>;
  flush?(options?: { readonly signal?: AbortSignal; readonly maxBatches?: number }): Promise<void>;
  close?(): Promise<void>;
}

recordMemoryFeedback(memoryId, input: MemoryFeedbackInputV2, causedBy?, {stamp?});
recordMemoryFeedbackBatch(items: readonly MemoryFeedbackBatchItem[], {
  stamp: EventStamp;
  expectedSubject: AuthorizedReadSubject;
});
recallMemoryPacket(request, options?: RequestOptions): Promise<{
  memories: readonly RecalledMemory[];
  provenance: RecallProvenance;
}>;
```

API read responses supply `provenance` from the subject/access actually used for that request. Ranked search and reasoning retain their existing fields and gain this field; `recallMemoryPacket` exposes the same envelope for callers that need explicit adoption. Existing array-returning recall convenience can unwrap the packet while scheduling optional telemetry from its provenance. No subsequent `identity()` request can assign a previous read to a newly selected account. The stable recall ID and exact ranked revisions are allocated once per successful result and reused by offered, injected and later explicit adoption/judgment signals.

Ranks are one-based positions in the returned packet. Provider `configRevision` retains the Phase 2 naming and identity semantics; it does not include tokens or change solely because a credential rotates.

Feedback is an actor's report. Copied ranking/provider fields preserve the offered context but are not independently authenticated provider judgments. A supplied recall ID alone does not prove server-side issuance; aggregates must not upgrade it into a validated experiment or private witness. The API resolves exact historical memory revisions through current access and checks any cited Phase 3 outcome event, task and attempt. A judgment does not require or fabricate a task outcome. New writes require the explicit revision; legacy stored records without it remain legacy. Historical revision zero is handled by definedness checks, not truthiness.

The proposed batch route is POST `/memory-feedback-batches` with `{stamp,expectedSubject,items}`, maximum 100 items, under `feedback:write`. The server compares expectedSubject to this request's actually resolved organization/workspace/principal before authorization and atomic commit; the caller cannot select the actor. This closes the token/account change between an adapter's identity check and its subsequent dispatch. The server derives each event's actor and the referenced memory's original audience/space, checks the complete batch before the atomic commit, and returns `{events,feedback}`. Item stamps and the batch stamp persist unchanged for retries. Inputs must reject mismatched signal/judgment/outcome fields, duplicate IDs with differing bodies, or references outside current access. Feedback does not advance the memory's claim revision.

`SuperBrainClientOptions.telemetryOutbox` receives the logical adapter. The client schedules optional offered telemetry after successful parsing, without awaiting the enqueue or network drain before returning the read. Adapter rejection updates observable telemetry failure state and never rejects the read. Once enqueue acknowledges durable persistence, retries/restart must preserve the same batch; termination before that asynchronous acknowledgement cannot be described as a durable write. The Node track uses encrypted local storage and the browser track uses its own durable database adapter, with the same queue bounds and explicit status contract. Adapters compare the currently authenticated subject with the stored batch subject before drain; account changes defer the old partition rather than relabeling it.

Explicit user judgment/adoption methods return their own success/failure and do not use the silent optional-read telemetry path. MCP retains the supplied recall ID, exact revisions and source provenance in its bounded context packet; a later completion/adoption report uses those values. Machine completion remains a reported outcome unless it resolves to an authenticated Phase 3 acceptance record.

## Context and operator experience

MCP supplies a bounded current project/task context packet with exact memory revisions, recall identity and evidence references. Keep imported evidence as data. Provide explicit memory correction/proposal and end-task result/adoption reporting, preserving the Phase 3 human/machine authority boundary. Machine tools cannot assert an authenticated human approval; self-reported completion remains distinguishable from witnessed acceptance. Use method factories suitable for actual MCP integration tests rather than only testing isolated helpers.

Brain shows task/attempt versions, start/final fingerprint and reconstruction availability, runtime/configuration/usage when recorded, interventions and delayed outcomes, structural versus independently assigned mappings, and unknown evidence explicitly. Canonical private-artifact references remain reference-only unless the local operator service verifies access to actual bytes.

Memory pages show applicability (including unresolved), currentness/review reasons, creator versus contributors, exact revision evidence links with pagination, and authorized correction/review controls. Label ranking as relevance and feedback as judgments; remove all-projects defaults for unresolved data and unsupported validated/confidence claims. Retain the distinction between proposals and approved memories.

Show processing counts for pending/waiting/retry/completed/excluded/exhausted jobs, observation timestamp and lag where measured. An unreachable/stale worker is unavailable, not healthy or complete. Publish only sanitized aggregate status through an explicitly authorized endpoint; do not expose private job payloads, filesystem paths or keys. Counts from a page of events must be labeled partial rather than global totals. Use exact-revision feedback to inform review/ranking cautiously; no vote-as-truth promotion.

## Verification gate

Exercise read-only MCP with feedback forbidden; network/storage failure after successful recall; durable retry/restart/dedup and identity change; historical revision feedback and unauthorized references; fresh-token browser requests, abort during body read and operator-token separation; bounded task context, correction and explicit adoption. Independently review source and anti-patterns, then run the full Node 24/PostgreSQL gate. Inspect actual Brain task, evidence, processing and correction flows in the in-app browser against disposable synthetic data. Do not connect browser tests to the live corpus.

Concrete review regressions include stale correction drafts rejected through `expectedRevision`; atomic outbox claims that cannot revive terminal rows or reduce retry counts across processes; queue-full/drop diagnostics surviving a status read; bounded terminal retention or an explicit repair mechanism; close/cancellation during delivery; and a rejected promise with no error value never acknowledged as success. Test operator destination validation and redirects before transmitting the local credential. Bind a plaintext processing-status ownership check to the actual opened file descriptor. Operator inspection includes unresolved/needs-review memories so they can be corrected, while ordinary ranked/context recall keeps its current-evidence default.
