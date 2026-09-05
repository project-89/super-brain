import type { AddressInfo } from "node:net";

import { parseEvent, type FoldEvent, type FoldLogEntry } from "@_89/fold";
import {
  FoldSdk,
  FoldSdkConflictError,
  type FoldSdkAccessContext,
  type FoldSdkCursor,
  type FoldConsumerCursor,
  type FoldDeliveryCursor,
  authorizeEventAccess,
  type FoldSdkStore,
} from "@_89/fold-sdk";

import {
  StaticIdentityDirectory,
  createApiServer,
  type ApiDependencies,
  type FoldSdkRegistry,
  type TenantKey,
} from "../src/index.js";

export const MEMORY_A = "01890f47-7c00-7000-8000-000000000001";

class MemoryStore implements FoldSdkStore {
  readonly entries: FoldLogEntry[] = [];

  async read() {
    return { entries: [...this.entries] };
  }

  async append(entry: FoldLogEntry): Promise<void> {
    this.entries.push(entry);
  }
}

export class MemorySdkRegistry implements FoldSdkRegistry {
  private readonly sdks = new Map<string, FoldSdk>();
  private readonly stores = new Map<string, MemoryStore>();
  private readonly cursors = new Map<string, FoldConsumerCursor>();

  async sdkFor(tenant: TenantKey): Promise<FoldSdk> {
    const key = JSON.stringify([tenant.organizationId, tenant.workspaceId]);
    let sdk = this.sdks.get(key);
    if (sdk === undefined) {
      const store = new MemoryStore();
      this.stores.set(key, store);
      sdk = new FoldSdk(store);
      this.sdks.set(key, sdk);
    }
    return sdk;
  }

  async streamEntries(tenant: TenantKey, access: FoldSdkAccessContext, options: { after?: FoldConsumerCursor; includeDrafts?: boolean; kinds?: readonly string[]; limit: number }) {
    await this.sdkFor(tenant);
    const store = this.stores.get(JSON.stringify([tenant.organizationId, tenant.workspaceId]))!;
    const sequence = options.after !== undefined && "version" in options.after ? BigInt(options.after.sequence) : 0n;
    const page = store.entries.map((entry, index) => ({ entry, cursor: { version: 2 as const, sequence: String(index + 1) } }))
      .filter(({ cursor }) => BigInt(cursor.sequence) > sequence).slice(0, options.limit);
    const visible = page.filter(({ entry }) => (options.includeDrafts || entry.status === "canon") &&
      (options.kinds === undefined || options.kinds.includes(entry.event.kind)) && authorizeEventAccess(entry.event, access).allowed);
    return { entries: visible.map(({ entry }) => entry), cursors: visible.map(({ cursor }) => cursor),
      ...(page.at(-1) === undefined ? {} : { scannedThrough: page.at(-1)!.cursor }) };
  }

  async latestEventCursor(tenant: TenantKey): Promise<FoldDeliveryCursor> {
    await this.sdkFor(tenant);
    return { version: 2, sequence: String(this.stores.get(JSON.stringify([tenant.organizationId, tenant.workspaceId]))!.entries.length) };
  }

  async consumerCursor(tenant: TenantKey, consumerId: string) {
    return this.cursors.get(JSON.stringify([tenant.organizationId, tenant.workspaceId, consumerId]));
  }

  async commitConsumerCursor(tenant: TenantKey, consumerId: string, cursor: FoldConsumerCursor) {
    const key = JSON.stringify([tenant.organizationId, tenant.workspaceId, consumerId]);
    const current = this.cursors.get(key);
    if (
      current !== undefined &&
      "version" in current && "version" in cursor && BigInt(cursor.sequence) < BigInt(current.sequence)
    ) {
      throw new FoldSdkConflictError("consumer cursor cannot move backward");
    }
    this.cursors.set(key, cursor);
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
    readonly headers?: Readonly<Record<string, string>>;
  } = {},
): Promise<{ readonly status: number; readonly headers: Headers; readonly body: any }> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
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
