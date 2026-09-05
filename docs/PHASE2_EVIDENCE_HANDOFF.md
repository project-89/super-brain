# Phase 2 evidence and trust contracts

All implementation and verification used the isolated remediation checkout. The live checkout, hook binaries, capture services, private vault, and configured corpus were not changed.

## Native vault evidence

`apps/memory-worker/src/vault.ts` exports:

```ts
readVaultEvidence(vaultRoot: string, run: TranscriptRun, options: {
  artifact?: TranscriptArtifact;
  encryptionKey?: Uint8Array;
  canonicalTurns?: readonly TranscriptTurn[];
  maxBytes?: number;
}): Promise<VaultReadResult>
```

The worker obtains `artifact` and `chunks.flatMap(chunk => chunk.turns)` from the canonical run detail. `artifact.parser.version` selects the shared importer's `NativeTranscriptNormalizer` version 1 or 2. Raw source bytes never choose the historical interpretation. Turn identity is allocated before boilerplate, empty text, duplicate message, or role filtering. Tool results remain evidence with an explicit success, failure, or unknown result; successful execution is not task acceptance.

Canonical turn ordinals map to actual catalog turn IDs. This matters for pseudonymous imports: run native IDs and turn IDs use different HMAC namespaces, so reconstructing a canonical ID from an aliased native ID is incorrect. The vault filename uses `artifact.sha256`, which is also the private path digest for anonymized imports.

`VaultReadResult.status` distinguishes:

- `ready`: complete decoded messages and coverage. Coverage includes record/message/tool-result/unknown/exclusion counts, observed turn IDs, and `integrity: "verified" | "legacy-unverified"`.
- `waiting`: artifact, decryption key, or canonical metadata has not arrived.
- `retry`: authentication/decryption, I/O, or concurrent artifact modification failed.
- `excluded`: identity/integrity/parser/turn mismatch, malformed record, nonregular path, or configured size bound violation. Malformed lines carry their 1-based line number.

No partial messages are returned as ready after malformed lines or a checksum mismatch. The default read bound is 128 MiB and is configurable. The stream is bounded to its inspected size, so concurrent appenders cannot extend a pass indefinitely; subsequent modification is a retry. Encrypted paths require authenticated encryption envelopes even when historical checksum metadata is absent. Legacy `readVaultMessages` remains a compatibility wrapper using the historical parser version; durable processing uses `readVaultEvidence`.

## Stored-byte integrity and immutable migration

`TranscriptArtifact.storedSha256?: string` hashes the exact published redacted vault bytes, including encryption envelopes and line order. `storeRedactedArtifact` computes this after selecting the published target, so a repeat encrypted import retains the existing target's original nonce and checksum. Source identity (`sha256`) remains distinct from stored-byte integrity. Privacy projection preserves the stored checksum as a byte checksum.

Vault reading hashes the same stream it decodes and verifies the checksum before returning ready. Historical catalog records without the field remain readable but explicitly report `legacy-unverified`; a checksum is never invented for them.

A 409 during import can retain a previous parser interpretation after strict source/artifact/native identity equivalence. For the same parser version, fallback requires that the sole artifact difference is the additive checksum and the canonical run, projects, and chunks match exactly. The result remains `interpretation: "retained-existing"`, with no claim that new integrity metadata was committed. Changed chunks or other metadata continue to conflict. No old events are rewritten.

## Local capture authority

`apps/memory-worker/src/authority.ts` exports:

```ts
type CapturedEventVerifier = (event: FoldEvent) => Promise<boolean>;
createCapturedEventVerifier(options: {
  stateRoot: string;
  vaultRoot: string;
  receiptEncryptionKey?: Uint8Array;
  vaultEncryptionKey?: Uint8Array;
  trustedSensorId: string;
  organizationId: string;
  workspaceId: string;
}): CapturedEventVerifier;

verifiedTaskAcceptance(
  event: FoldEvent,
  expected: { taskId: string; attemptId: string; revisionId: string },
  verifyCapturedEvent: CapturedEventVerifier,
): Promise<TaskAcceptanceEvidence | undefined>;
```

The receipt encryption key is the trust root. Verification requires a schema-valid event from the configured sensor and workspace, the exact matching hook artifact and its content-addressed receipt provenance, and a matching recursive canonical JSON digest in the authenticated encrypted completed receipt. The receipt must contain the server-owned organization/workspace tenant binding. Object key order can change in JSONB without changing the digest. Caller-authored sensor, source, or authority labels are insufficient.

Human decisions additionally require the primary receipt artifact, a HumanDecision hook, the configured sensor's local-operator principal, and identical authenticated authority in the private artifact, receipt, and canonical observation. `verifiedTaskAcceptance` requires the exact task, attempt, revision, artifact, verdict, and optional event ID joins before returning typed acceptance. It accepts success or failure evidence without reinterpreting the verdict; the promotion policy must choose its intended verdict explicitly.

Missing keys, missing artifacts, old receipts without tenant/digest witnesses, plaintext substituted for an encrypted receipt, malformed events, forged copies, and any verification error return false/undefined. They do not confer promotion authority. Generic witnessed observations use the same exact digest contract; nested transcript-delta hook artifacts now inherit the transaction receipt ID.

The capture helper `readCompletedCaptureReceipt({stateRoot, receiptId, encryptionKey})` reads one deterministic completed witness directly; it does not scan the historical vault. Verification does not call a remote service or place private hook content in canonical metadata.

## Focused evidence regressions

The dedicated vault and authority suites cover native v1/v2 identity, tool-only and boilerplate turns, native message fragments, pseudonymous turn IDs, unknown outcomes, explicit unavailable/corrupt states, substituted valid JSONL, reordered encrypted records, matching trusted decisions, wrong task/attempt/revision joins, forged canonical copies, key/tenant/workspace/sensor mismatch, JSONB ordering, missing/legacy witnesses, plaintext witness substitution, artifact tampering, and nested transcript-delta receipt witnesses. Concurrent growth and plaintext replacement of legacy encrypted vault records are also covered. Importer regressions also cover stable encrypted reimport checksums and rejecting changed chunks during checksum migration.


## Independent integration review

The HTTP integration suite uses the real API, client, SDK, and worker against isolated synthetic state. It verifies machine proposal → human acceptance → machine evidence contribution; scoped evidence containment; human correction before later machine support; forgotten revisions during an in-flight provider call; and independent deterministic processing while model work waits. Review identified and coordinated fixes for captured `identity.repo`/multi-project segment authorization, summary-based promotion laundering, support of human-corrected claims, independent model scheduling, canonical applicability in synthesis, and source-time ordering of durable proposal stamps.

Phase 2 automatic promotion is limited to an exact attested successful human-decision candidate. Trajectory checkpoint promotion remains explicitly reviewable until Phase 3 adds the complete attested trajectory/final-revision/acceptance relationship; an arbitrary trajectory carrying a real approval ID is insufficient.
