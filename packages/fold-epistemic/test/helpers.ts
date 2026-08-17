import type { FoldEvent, JsonValue } from "@_89/fold";

import {
  makeMemoryRecordedEvent,
  memoryLogRecordsFromEvent,
  type EpistemicAccessContext,
  type EpistemicEventContext,
  type MemoryInput,
  type MemoryProjection,
  type PersonalMemory,
} from "../src/index.js";

export const MEMORY_A = "01890f47-7c00-7000-8000-000000000001";
export const MEMORY_B = "01890f47-7c01-7000-8000-000000000002";
export const MEMORY_C = "01890f47-7c02-7000-8000-000000000003";
export const MEMORY_D = "01890f47-7c03-7000-8000-000000000004";

interface ContextOptions {
  readonly principalId?: string;
  readonly workspaceId?: string;
  readonly workspaceRole?: EpistemicAccessContext["workspaceRole"];
  readonly spaceId?: string;
  readonly spaceRoles?: EpistemicAccessContext["spaceRoles"];
}

export function context(options: ContextOptions = {}): EpistemicEventContext {
  const principalId = options.principalId ?? "user-a";
  const workspaceId = options.workspaceId ?? "workspace-1";
  const spaceRoles =
    options.spaceRoles ?? (options.spaceId === undefined ? {} : { [options.spaceId]: "reader" as const });
  return {
    access: {
      principalId,
      workspaceId,
      workspaceRole: options.workspaceRole ?? "member",
      spaceRoles,
    },
    author: { kind: "agent", id: "brain-runtime" },
    capture: {
      scope: {
        workspace: workspaceId,
        ...(options.spaceId === undefined ? {} : { space: options.spaceId }),
        creator: principalId,
      },
      identity: { principal: principalId, workspace: workspaceId },
    },
  };
}

export function stamp(id: string, t: number) {
  return { id, t, worldDate: "2026-08-16" } as const;
}

export function recordedMemory(event: FoldEvent): PersonalMemory {
  const record = memoryLogRecordsFromEvent(event)[0];
  if (record?.recordType !== "recorded") throw new Error("expected one recorded memory");
  return record.memory;
}

interface MemoryOptions {
  readonly id?: string;
  readonly workspaceId?: string;
  readonly creatorId?: string;
  readonly spaceId?: string;
  readonly source?: string;
  readonly summary?: string;
  readonly content?: JsonValue;
  readonly tags?: readonly string[];
  readonly createdAt?: number;
}

export function memory(options: MemoryOptions = {}): PersonalMemory {
  const createdAt = options.createdAt ?? 100;
  return {
    id: options.id ?? MEMORY_A,
    workspaceId: options.workspaceId ?? "workspace-1",
    ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
    creatorId: options.creatorId ?? "user-a",
    source: options.source ?? "conversation",
    summary: options.summary ?? "A remembered fact",
    content: options.content ?? { fact: true },
    tags: options.tags ?? [],
    entities: [],
    createdAt,
    updatedAt: createdAt,
    revision: 0,
  };
}

export function projection(memories: readonly PersonalMemory[]): MemoryProjection {
  return { memories: new Map(memories.map((item) => [item.id, item])), forgotten: new Map() };
}

export function recordEvent(
  options: ContextOptions & MemoryOptions & { readonly eventId: string; readonly t: number },
): FoldEvent {
  const eventContext = context(options);
  const input: MemoryInput = {
    id: options.id ?? MEMORY_A,
    ...(options.spaceId === undefined ? {} : { spaceId: options.spaceId }),
    source: options.source ?? "conversation",
    summary: options.summary ?? "A remembered fact",
    content: options.content ?? { fact: true },
    tags: options.tags ?? [],
  };
  return makeMemoryRecordedEvent(eventContext, stamp(options.eventId, options.t), input);
}
