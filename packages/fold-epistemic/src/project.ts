import { compareEventKeys, type FoldEvent } from "@_89/fold";

import { forgottenMemoryFromRecord, memoryLogRecordsFromEvent } from "./events.js";
import type { ForgottenMemory, MemoryProjection, PersonalMemory } from "./types.js";
import { assertUuidV7 } from "./uuidv7.js";

export class MemoryProjectionError extends Error {
  override readonly name = "MemoryProjectionError";
}

export function rebuildMemories(events: readonly FoldEvent[]): MemoryProjection {
  const memories = new Map<string, PersonalMemory>();
  const forgotten = new Map<string, ForgottenMemory>();
  for (const event of [...events].sort(compareEventKeys)) {
    for (const record of memoryLogRecordsFromEvent(event)) {
      if (record.recordType === "recorded") {
        if (record.actorId !== record.memory.creatorId) {
          throw new MemoryProjectionError(`memory ${record.memory.id} creator does not match event principal`);
        }
        if (record.workspaceId !== record.memory.workspaceId) {
          throw new MemoryProjectionError(`memory ${record.memory.id} workspace does not match event`);
        }
        if (record.spaceId !== record.memory.spaceId) {
          throw new MemoryProjectionError(`memory ${record.memory.id} space does not match event`);
        }
        if (memories.has(record.memory.id) || forgotten.has(record.memory.id)) {
          throw new MemoryProjectionError(`memory ${record.memory.id} was recorded more than once`);
        }
        memories.set(record.memory.id, record.memory);
      } else {
        assertUuidV7(record.memoryId, "memory id");
        const current = memories.get(record.memoryId);
        if (current === undefined) {
          throw new MemoryProjectionError(`${record.recordType} references inactive memory ${record.memoryId}`);
        }
        if (
          current.creatorId !== record.actorId ||
          current.workspaceId !== record.workspaceId ||
          current.spaceId !== record.spaceId
        ) {
          throw new MemoryProjectionError(`${record.recordType} principal does not own memory ${record.memoryId}`);
        }
        if (record.atMs < current.updatedAt) {
          throw new MemoryProjectionError(`${record.recordType} predates memory ${record.memoryId}`);
        }
        if (record.recordType === "revised") {
          memories.set(record.memoryId, {
            ...current,
            ...record.patch,
            updatedAt: record.atMs,
            revision: current.revision + 1,
          });
        } else {
          memories.delete(record.memoryId);
          forgotten.set(record.memoryId, forgottenMemoryFromRecord(record));
        }
      }
    }
  }
  return { memories, forgotten };
}

export function activeMemoryById(
  projection: MemoryProjection,
  memoryId: string,
): PersonalMemory | undefined {
  assertUuidV7(memoryId, "memory id");
  return projection.memories.get(memoryId);
}
