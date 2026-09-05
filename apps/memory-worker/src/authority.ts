import { createHash } from "node:crypto";
import { parseEvent, type FoldEvent } from "@_89/fold";
import {
  capturedEventDigest, normalizeHookEvidence, readCompletedCaptureReceipt, readHookVaultArtifact,
  type HookSource, type TaskAcceptanceEvidence,
} from "@_89/super-brain-capture-daemon";

export type CapturedEventVerifier = (event: FoldEvent) => Promise<boolean>;
export interface CaptureAuthorityOptions {
  readonly stateRoot: string;
  readonly vaultRoot: string;
  readonly receiptEncryptionKey?: Uint8Array;
  readonly vaultEncryptionKey?: Uint8Array;
  readonly trustedSensorId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
}
const object = (value: unknown): Record<string, unknown> | undefined => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

function observation(event: FoldEvent): { readonly kind: unknown; readonly data: Record<string, unknown> } | undefined {
  const observations = event.changes.flatMap((change) => change.verb === "create" && change.nodeKind === "x.fold.activity-observation" && object(change.after.data) !== undefined
    ? [{ kind: change.after.observation, data: object(change.after.data)! }] : []);
  return observations.length === 1 ? observations[0] : undefined;
}

/** The local receipt key is the trust root; caller-picked canonical author/authority labels are insufficient. */
export function createCapturedEventVerifier(options: CaptureAuthorityOptions): CapturedEventVerifier {
  return async (input) => {
    if (options.receiptEncryptionKey?.byteLength !== 32) return false;
    try {
      const event = parseEvent(input);
      if (event.kind !== "terminal.observation" || event.author.kind !== "sensor" || event.author.id !== options.trustedSensorId ||
        event.capture.scope.workspace !== options.workspaceId) return false;
      const captured = observation(event);
      if (captured === undefined || !text(captured.data.artifactId)) return false;
      const source = event.capture.identity?.runtime;
      if (source !== "codex" && source !== "claude-code" && source !== "hermes" && source !== "unknown") return false;
      const artifact = await readHookVaultArtifact({ vaultRoot: options.vaultRoot, source: source as HookSource,
        artifactId: captured.data.artifactId, ...(options.vaultEncryptionKey === undefined ? {} : { encryptionKey: options.vaultEncryptionKey }) });
      if (artifact === undefined || !text(artifact.receiptId)) return false;
      const artifactHash = createHash("sha256").update(JSON.stringify({ source: artifact.source, payload: artifact.payload,
        receiptId: artifact.receiptId, ...(artifact.authority === undefined ? {} : { authority: artifact.authority }) })).digest("hex");
      if (artifactHash !== artifact.id) return false;
      const receipt = await readCompletedCaptureReceipt({ stateRoot: options.stateRoot, receiptId: artifact.receiptId, encryptionKey: options.receiptEncryptionKey });
      if (receipt === undefined || receipt.tenant?.organizationId !== options.organizationId || receipt.tenant.workspaceId !== options.workspaceId ||
        receipt.artifact.eventTime !== event.at.t || receipt.occurrence.source !== source || receipt.eventDigests?.[event.id] !== capturedEventDigest(event)) return false;
      if (captured.kind === "human_decision") {
        if (receipt.artifact.id !== artifact.id || normalizeHookEvidence(artifact.payload).name !== "HumanDecision" ||
          artifact.authority?.kind !== "local-operator" || artifact.authority.principalId !== `operator:${options.trustedSensorId}` ||
          !Number.isFinite(Date.parse(artifact.authority.authenticatedAt)) ||
          capturedEventDigest(artifact.authority) !== capturedEventDigest(receipt.authority) ||
          capturedEventDigest(artifact.authority) !== capturedEventDigest(captured.data.authority)) return false;
      }
      return true;
    } catch { return false; }
  };
}

export async function verifiedTaskAcceptance(
  event: FoldEvent,
  expected: { readonly taskId: string; readonly attemptId: string; readonly revisionId: string },
  verifyCapturedEvent: CapturedEventVerifier,
): Promise<TaskAcceptanceEvidence | undefined> {
  try {
    event = parseEvent(event);
    const captured = observation(event);
    if (captured?.kind !== "human_decision") return undefined;
    const acceptance = object(captured.data.acceptance);
    const authority = object(acceptance?.authority);
    if (acceptance?.version !== 1 || acceptance.taskId !== expected.taskId || acceptance.attemptId !== expected.attemptId ||
      acceptance.revisionId !== expected.revisionId || !text(acceptance.taskId) || !text(acceptance.attemptId) || !text(acceptance.revisionId) ||
      acceptance.artifactId !== captured.data.artifactId || !text(acceptance.artifactId) ||
      (acceptance.eventId !== undefined && acceptance.eventId !== event.id) ||
      (acceptance.verdict !== "success" && acceptance.verdict !== "failure") || captured.data.verdict !== acceptance.verdict ||
      authority?.kind !== "local-operator" || !text(authority.principalId) || !text(authority.authenticatedAt) || !Number.isFinite(Date.parse(authority.authenticatedAt)) ||
      capturedEventDigest(authority) !== capturedEventDigest(captured.data.authority)) return undefined;
    if (!(await verifyCapturedEvent(event))) return undefined;
    return { version: 1, taskId: acceptance.taskId, attemptId: acceptance.attemptId, revisionId: acceptance.revisionId,
      verdict: acceptance.verdict, artifactId: acceptance.artifactId, eventId: event.id,
      authority: { kind: "local-operator", principalId: authority.principalId, authenticatedAt: authority.authenticatedAt } };
  } catch { return undefined; }
}
