import type { FoldLogEntry } from "@_89/fold";
import { FoldSdk } from "@_89/fold-sdk";
import { createApiServer, StaticIdentityDirectory } from "@_89/super-brain-api";
import { SuperBrainClient, type RecallProvenance } from "@_89/super-brain-client";
import { sha256 } from "./hash.js";

export interface RetrievedSyntheticMemory {
  readonly source: { readonly memoryId: string; readonly revision: number };
  readonly recallId: string;
  readonly content: string;
  readonly contentSha256: string;
  readonly request: { readonly query: string; readonly limit: number };
  readonly provenance: RecallProvenance;
  readonly approval: { readonly kind: "synthetic-human-record"; readonly eventId: string };
}

/** Synthetic canonical log replay is used for fresh source selection at export time. */
export async function createSyntheticMemoryApi(entries: FoldLogEntry[] = []) {
  const sdk = new FoldSdk({ async read() { return { entries: [...entries] }; }, async append(entry) { entries.push(entry); }, async appendMany(additions) { entries.push(...additions); } });
  const workspaceId = "synthetic-evaluation", principalId = "synthetic-reviewer", organizationId = "local";
  const token = "synthetic-local-evaluation-only";
  const identities = new StaticIdentityDirectory({ [token]: { principalId, author: { kind: "human", id: principalId }, workspaces: { [workspaceId]: { role: "admin" } } } });
  const server = createApiServer({ authenticator: identities, memberships: identities, sdks: { sdkFor: async () => sdk } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (address === null || typeof address === "string") throw new Error("Synthetic memory listener unavailable");
  const client = new SuperBrainClient({ baseUrl: `http://127.0.0.1:${address.port}`, token, organizationId, workspaceId, timeoutMs: 10_000 });
  const close = async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); };
  return { client, close, entries };
}

/** Actual API creation and retrieval in an isolated in-memory tenant. No user's memory corpus is read. */
export async function createSyntheticMemoryService(content: string) {
  const { client, close, entries } = await createSyntheticMemoryApi();
  try {
    const created = await client.recordMemory({ id: "01890f47-7c00-7000-8000-000000000051", audience: "workspace", source: "synthetic-approved-lesson", summary: "Ingestion positions, canonical timestamps, and occurrence identity", content, applicability: { kind: "global" } });
    await client.recordMemory({ id: "01890f47-7c00-7000-8000-000000000052", audience: "workspace", source: "synthetic-distractor", summary: "Unrelated garden note", content: "Water the synthetic garden plants in the morning.", applicability: { kind: "global" } });
    return {
      client, entries,
      async retrieve(): Promise<RetrievedSyntheticMemory> {
        const request = { query: "ingestion positions canonical timestamps occurrence identity", limit: 1 };
        const result = await client.rankMemories(request);
        const row = result.memories[0];
        if (result.memories.length !== 1 || row?.memory.id !== created.memory.id || row.memory.revision !== 0 || row.memory.content !== content || row.memory.currentness?.status !== "current") throw new Error("Synthetic approved memory retrieval did not return the expected exact revision");
        const item = result.provenance.items.find((item) => item.memoryId === row.memory.id && item.memoryRevision === row.memory.revision);
        if (item === undefined) throw new Error("Synthetic retrieval lacks exact revision provenance");
        return { source: { memoryId: row.memory.id, revision: row.memory.revision }, recallId: result.provenance.recallId, content, contentSha256: sha256(content), request, provenance: result.provenance, approval: { kind: "synthetic-human-record", eventId: created.event.id } };
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
