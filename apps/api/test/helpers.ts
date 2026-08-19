import type { AddressInfo } from "node:net";

import { parseEvent, type FoldEvent, type FoldLogEntry } from "@_89/fold";
import { FoldSdk, type FoldSdkAccessContext, type FoldSdkStore } from "@_89/fold-sdk";

import {
  StaticIdentityDirectory,
  createApiServer,
  type ApiDependencies,
  type FoldSdkRegistry,
} from "../src/index.js";

export const MEMORY_A = "01890f47-7c00-7000-8000-000000000001";

class MemoryStore implements FoldSdkStore {
  private readonly entries: FoldLogEntry[] = [];

  async read() {
    return { entries: [...this.entries] };
  }

  async append(entry: FoldLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

export class MemorySdkRegistry implements FoldSdkRegistry {
  private readonly sdks = new Map<string, FoldSdk>();

  async sdkFor(workspaceId: string): Promise<FoldSdk> {
    let sdk = this.sdks.get(workspaceId);
    if (sdk === undefined) {
      sdk = new FoldSdk(new MemoryStore());
      this.sdks.set(workspaceId, sdk);
    }
    return sdk;
  }
}

export function identityDirectory(): StaticIdentityDirectory {
  return new StaticIdentityDirectory({
    "token-a": {
      principalId: "user-a",
      workspaces: {
        "workspace-1": { role: "member", spaces: { "space-a": "reader" } },
      },
    },
    "token-b": {
      principalId: "user-b",
      workspaces: { "workspace-1": { role: "owner" } },
    },
  });
}

export async function startApi(
  overrides: Partial<ApiDependencies> = {},
): Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }> {
  const directory = identityDirectory();
  const server = createApiServer({
    authenticator: directory,
    memberships: directory,
    sdks: new MemorySdkRegistry(),
    ...overrides,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

export async function apiRequest(
  baseUrl: string,
  path: string,
  options: {
    readonly method?: string;
    readonly token?: string;
    readonly body?: unknown;
    readonly rawBody?: string;
    readonly contentType?: string;
  } = {},
): Promise<{ readonly status: number; readonly headers: Headers; readonly body: any }> {
  const headers = new Headers();
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body !== undefined || options.rawBody !== undefined) {
    headers.set("content-type", options.contentType ?? "application/json");
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(options.body === undefined && options.rawBody === undefined
      ? {}
      : { body: options.rawBody ?? JSON.stringify(options.body) }),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

interface EventOptions {
  readonly id: string;
  readonly t: number;
  readonly principalId?: string;
  readonly workspaceId?: string;
  readonly creatorId?: string;
  readonly kind?: string;
  readonly subject?: string;
}

export function apiEvent(options: EventOptions): FoldEvent {
  const principalId = options.principalId ?? "user-a";
  const workspaceId = options.workspaceId ?? "workspace-1";
  return parseEvent({
    specVersion: "0.7",
    id: options.id,
    kind: options.kind ?? "test.event",
    title: `Test event ${options.id}`,
    at: { t: options.t, worldDate: "2026-08-17", granularity: "beat" },
    participants: [principalId],
    author: { kind: "human", id: principalId },
    capture: {
      scope: {
        workspace: workspaceId,
        ...(options.creatorId === undefined ? {} : { creator: options.creatorId }),
      },
      identity: { principal: principalId, workspace: workspaceId },
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

export function access(
  overrides: Partial<FoldSdkAccessContext> = {},
): FoldSdkAccessContext {
  return {
    principalId: "user-a",
    workspaceId: "workspace-1",
    workspaceRole: "member",
    spaceRoles: { "space-a": "reader" },
    ...overrides,
  };
}

export function memoryRecordBody(
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    stamp: { id: "event-a", t: 100, worldDate: "2026-08-17" },
    input: {
      id: MEMORY_A,
      source: "conversation",
      content: { decision: "ship" },
      tags: ["decision"],
    },
    ...overrides,
  };
}
