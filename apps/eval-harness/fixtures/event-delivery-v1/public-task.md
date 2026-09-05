# Event delivery reducer — version 1

Implement this synchronous JavaScript ES module using standard JavaScript builtins, without imports or external dependencies:

```js
export function reduceDelivery(state, arrivals) { /* your implementation */ }
```

`state` has `{checkpoint: string, events: Array<{id: string, t: number, payload: JSONValue}>}`. Each arrival has `{sequence: string, event: {id: string, t: number, payload: JSONValue}}`. The initial state is `{checkpoint:"0",events:[]}`. Return a fresh `{checkpoint,events}` object. `events` retains all logical occurrences, not just the new batch. Sharing unchanged event objects, payloads or arrays is permitted; do not mutate any input, including nested objects, during the call.

Delivery positions and canonical event times have different purposes:

- Only arrivals above the supplied checkpoint can add occurrences. A newly arrived backdated event remains deliverable even when its time precedes every retained event.
- Sequences/checkpoints are canonical decimal strings: no sign, whitespace, leading zeroes (except `"0"`), exponent, or decimal point. Their range is zero through `9223372036854775807`, inclusive. Arrival sequences start at one. Comparisons must remain exact above JavaScript's safe-number range.
- Batches may arrive in any order. The returned checkpoint is a decimal string equal to the maximum of the old checkpoint and delivered positions. An exact retry at a higher position advances it without adding an occurrence.
- An event ID identifies one immutable logical occurrence. Every appearance of an ID in the supplied state/batch must have identical time and JSON payload. Exact duplicate retained IDs collapse to one occurrence. Distinct IDs with equal time and payload remain distinct.
- Object key order does not affect immutable JSON equality; array order and nested content do. Payloads may be any JSON value with finite numbers, including null, strings, booleans, arrays and objects. Special-looking object keys are ordinary data.
- Duplicate ingestion positions within this batch must name identical immutable events, including IDs. The state has no position-to-event map; detecting position reuse across separate previous batches is not required.
- Validate every input, including older filtered arrivals and retained events. State/events/arrivals must have the stated shapes. IDs are nonempty strings, times nonnegative safe integers. Missing payloads and invalid nested values are invalid. Throw on invalid input, never return a partial result. Error wording is not graded.
- Sort retained events by numeric time, then ordinary JavaScript string ordering on IDs (`<`/`>` semantics), independent of arrival order. Do not use locale-sensitive ordering. Empty input preserves the checkpoint and still returns canonical event order.

Public examples illustrate the contract. Additional checks cover delayed events, large positions, retries, identity conflicts, nested equality, invalid input, continuation, input preservation and deterministic ordering. Completed checks determine automated acceptance; they do not represent human approval or model confidence.

Return only one JSON object with exactly two string fields: `{"code":"<complete JavaScript module source>","summary":"<concise factual implementation summary>"}`. Do not wrap it in Markdown or add other fields/text. Do not provide hidden reasoning. The harness may return observed check feedback for at most two revisions after the first submission, using the same task and initial fixture.
