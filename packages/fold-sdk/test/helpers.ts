import { parseEvent, type FoldEvent, type FoldLogEntry } from "@_89/fold";
import type { EpistemicEventContext } from "@_89/fold-epistemic";

import type { FoldSdkAccessContext, FoldSdkStore } from "../src/index.js";

export const MEMORY_A = "01890f47-7c00-7000-8000-000000000001";
export const MEMORY_B = "01890f47-7c01-7000-8000-000000000002";

export class MemoryStore implements FoldSdkStore {
  readonly entries: FoldLogEntry[] = [];
  readCount = 0;

  constructor(readonly stableReads = false) {}

  async read(): Promise<{ readonly entries: readonly FoldLogEntry[] }> {
    this.readCount += 1;
    return { entries: [...this.entries] };
  }

  async append(entry: FoldLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

interface AccessOptions {
  readonly principalId?: string;
  readonly workspaceId?: string;
  readonly workspaceRole?: FoldSdkAccessContext["workspaceRole"];
  readonly spaces?: readonly string[];
}

export function access(options: AccessOptions = {}): FoldSdkAccessContext {
  return {
    principalId: options.principalId ?? "user-a",
    workspaceId: options.workspaceId ?? "workspace-1",
    workspaceRole: options.workspaceRole ?? "member",
    spaceRoles: Object.fromEntries((options.spaces ?? []).map((spaceId) => [spaceId, "reader"])),
  };
}

interface EventOptions {
  readonly id: string;
  readonly t: number;
  readonly workspaceId?: string;
  readonly spaceId?: string;
  readonly creatorId?: string;
  readonly actorId?: string;
  readonly kind?: string;
  readonly subject?: string;
}

export function event(options: EventOptions): FoldEvent {
  const workspaceId = options.workspaceId ?? "workspace-1";
  const actorId = options.actorId ?? options.creatorId ?? "user-a";
  return parseEvent({
    specVersion: "0.7",
    id: options.id,
    kind: options.kind ?? "test.event",
    title: `Test event ${options.id}`,
    at: { t: options.t, worldDate: "2026-08-17", granularity: "beat" },
    participants: [actorId],
    author: { kind: "human", id: actorId },
    capture: {
      scope: {
        workspace: workspaceId,
        ...(options.spaceId === undefined ? {} : { space: options.spaceId }),
        ...(options.creatorId === undefined ? {} : { creator: options.creatorId }),
      },
      identity: { principal: actorId, workspace: workspaceId },
    },
    changes: [
      {
        verb: "create",
        subject: options.subject ?? `node-${options.id}`,
        nodeKind: "fact",
        after: { label: options.id },
        provenance: { basis: "authored" },
      },
    ],
  });
}

interface MemoryContextOptions extends AccessOptions {
  readonly spaceId?: string;
}

export function memoryContext(options: MemoryContextOptions = {}): EpistemicEventContext {
  const currentAccess = access({
    ...options,
    spaces:
      options.spaces ?? (options.spaceId === undefined ? [] : [options.spaceId]),
  });
  return {
    access: currentAccess,
    author: { kind: "agent", id: "brain-runtime" },
    capture: {
      scope: {
        workspace: currentAccess.workspaceId,
        ...(options.spaceId === undefined ? {} : { space: options.spaceId }),
        creator: currentAccess.principalId,
      },
      identity: {
        principal: currentAccess.principalId,
        workspace: currentAccess.workspaceId,
      },
    },
  };
}

export function stamp(id: string, t: number) {
  return { id, t, worldDate: "2026-08-17" } as const;
}
