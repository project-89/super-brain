import { parseEvent, type FoldEvent } from "@_89/fold";
import { trajectoryInputSchema, trajectoryLogRecordsFromEvent } from "@_89/fold-trajectory";
import { capturedEventDigest, capturedTrajectoryCommandDigest, readCompletedCaptureReceipt } from "./receipts.js";

export interface CapturedTrajectoryAuthorityOptions {
  readonly stateRoot: string;
  readonly receiptEncryptionKey?: Uint8Array;
  readonly trustedSensorId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
}
export type CapturedTrajectoryVerifier = (event: FoldEvent) => Promise<boolean>;

/** Witness the exact privacy-projected command; API-owned actor/workspace fields are checked separately. */
export function createCapturedTrajectoryVerifier(options: CapturedTrajectoryAuthorityOptions): CapturedTrajectoryVerifier {
  return async (input) => {
    if (options.receiptEncryptionKey?.byteLength !== 32) return false;
    try {
      const event = parseEvent(input);
      if (event.kind !== "trajectory.recorded" || event.capture.scope.workspace !== options.workspaceId || event.capture.scope.space !== undefined || event.capture.scope.creator !== undefined || event.changes.length !== 1 || event.capture.identity === undefined || event.participants === undefined) return false;
      const records = trajectoryLogRecordsFromEvent(event);
      const record = records.length === 1 && records[0]?.recordType === "trajectory" ? records[0] : undefined;
      if (record === undefined || record.workspaceId !== options.workspaceId || record.spaceId !== undefined || record.recordedAt !== event.at.t ||
        record.actorId !== event.capture.identity.principal || event.capture.identity.workspace !== options.workspaceId ||
        event.participants.length !== 1 || event.participants[0] !== record.actorId || capturedEventDigest(record.trajectory.capture) !== capturedEventDigest(event.capture)) return false;
      const { principal: _principal, workspace: _workspace, ...captureIdentity } = event.capture.identity;
      const receiptId = captureIdentity.receiptId;
      if (typeof receiptId !== "string" || receiptId.length === 0 || captureIdentity.sensor !== options.trustedSensorId) return false;
      const receipt = await readCompletedCaptureReceipt({ stateRoot: options.stateRoot, receiptId, encryptionKey: options.receiptEncryptionKey });
      if (receipt?.tenant?.organizationId !== options.organizationId || receipt.tenant.workspaceId !== options.workspaceId || receipt.tenant.sensorId !== options.trustedSensorId || receipt.artifact.eventTime !== event.at.t || receipt.occurrence.source !== captureIdentity.runtime) return false;
      const witness = receipt.trajectoryWitnesses?.[event.id];
      if (witness === undefined) return false;
      const { capture: _capture, ...trajectory } = record.trajectory;
      const command = { input: trajectoryInputSchema.parse({ ...trajectory, assignments: record.assignments, ...(record.reviewText === undefined ? {} : { reviewText: record.reviewText }) }), captureIdentity,
        runStamp: { id: event.id, t: event.at.t, worldDate: event.at.worldDate } };
      if (capturedTrajectoryCommandDigest(command) !== witness.digest) return false;
      const manifest = command.input.manifest; const binding = witness.privateRevisionBinding;
      if (manifest === undefined || manifest.attempt.attemptId !== command.input.id || manifest.attempt.taskId !== command.input.taskId || binding === undefined ||
        manifest.attempt.startRevision.revisionId !== binding.startPublicRevisionId || manifest.attempt.finalRevision?.revisionId !== binding.finalPublicRevisionId ||
        (binding.startPublicRevisionId !== undefined && !binding.startSourceRevisionId?.startsWith("git:")) ||
        (binding.finalPublicRevisionId !== undefined && !binding.finalSourceRevisionId?.startsWith("git:"))) return false;
      return true;
    } catch { return false; }
  };
}
