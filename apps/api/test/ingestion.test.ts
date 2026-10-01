import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PostgresFoldDatabase } from "@_89/fold-postgres";
import { PostgresSdkRegistry } from "../src/index.js";
import { access, apiEvent, apiRequest, MemorySdkRegistry, startApi } from "./helpers.js";

describe("ingestion stream routing", () => {
  it("rejects unsupported stores and never mixes source and ingestion cursors", async () => {
    const api = await startApi();
    try {
      for (const path of ["event-stream?order=ingestion", "consumers/test?order=ingestion"]) {
        expect((await apiRequest(api.baseUrl, `/v1/workspaces/workspace-1/${path}`, { token: "token-a" })).status).toBe(501);
      }
      // Mixing a sequence with a source-time cursor is rejected; a lone legacy cursor replays from origin.
      expect((await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/event-stream?order=ingestion&afterSequence=1&afterT=2&afterEventId=old", { token: "token-a" })).status).toBe(400);
      expect((await apiRequest(api.baseUrl, "/v1/workspaces/workspace-1/event-stream?order=ingestion&afterT=2&afterEventId=old", { token: "token-a" })).status).toBe(501);
    } finally { await api.close(); }
  });

  it("stops paging while an SSE client applies socket backpressure", async () => {
    const sdk = await new MemorySdkRegistry().sdkFor({ organizationId: "local", workspaceId: "workspace-1" });
    const event = { ...apiEvent({ id: "large", t: 1 }), title: "x".repeat(80_000) };
    const ingestionEntries = vi.fn(async () => ({ items: Array.from({ length: 100 }, (_, index) => ({ entry: { event, status: "canon" as const }, cursor: { kind: "ingestion" as const, sequence: String(index + 1) } })), scannedThrough: { kind: "ingestion" as const, sequence: "100" } }));
    const api = await startApi({ eventStreamPollMs: 10, sdks: { sdkFor: async () => sdk, ingestionEntries, latestIngestionCursor: async () => ({ kind: "ingestion", sequence: "0" }) } });
    const abort = new AbortController();
    try {
      const response = await fetch(`${api.baseUrl}/v1/workspaces/workspace-1/event-stream?order=ingestion&replay=all`, { headers: { authorization: "Bearer token-a" }, signal: abort.signal });
      expect(response.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(ingestionEntries).toHaveBeenCalledTimes(1);
    } finally { abort.abort(); await api.close(); }
  });

  it("drains bounded ingestion pages without idle waits, including denied pages, and stops after close", async () => {
    const sdk = await new MemorySdkRegistry().sdkFor({ organizationId: "local", workspaceId: "workspace-1" });
    const position = (sequence: number) => ({ kind: "ingestion" as const, sequence: String(sequence) });
    let releaseLast!: () => void;
    const lastPage = new Promise<void>(resolve => { releaseLast = resolve; });
    let enteredLast!: () => void;
    const lastEntered = new Promise<void>(resolve => { enteredLast = resolve; });
    const after: (string | undefined)[] = [];
    const ingestionEntries = vi.fn(async (_tenant, _access, options) => {
      after.push(options.after?.sequence);
      expect(options.limit).toBe(100);
      if (after.length === 4) { enteredLast(); await lastPage; }
      const end = after.length * 100;
      return {
        // The second scanned page is entirely inaccessible to this subscriber.
        items: after.length === 2 ? [] : Array.from({ length: 100 }, (_, index) => ({
          entry: { event: apiEvent({ id: `backlog-${end - 99 + index}`, t: index }), status: "canon" as const },
          cursor: position(end - 99 + index),
        })),
        scannedThrough: position(end),
      };
    });
    const api = await startApi({ eventStreamPollMs: 60_000, sdks: { sdkFor: async () => sdk, ingestionEntries, latestIngestionCursor: async () => position(0) } });
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error("Backlog waited for the idle poll")), 2_000);
    let apiClosed = false;
    try {
      const response = await fetch(`${api.baseUrl}/v1/workspaces/workspace-1/event-stream?order=ingestion&afterSequence=0`, { headers: { authorization: "Bearer token-a" }, signal: abort.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const reading = (async () => { while (!(await reader.read()).done) { /* Drain the socket. */ } })().catch(() => undefined);
      await Promise.race([lastEntered, reading]);
      expect(after).toEqual(["0", "100", "200", "300"]);
      abort.abort();
      await reading;
      await api.close();
      apiClosed = true;
      releaseLast();
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      expect(ingestionEntries).toHaveBeenCalledTimes(4);
    } finally { clearTimeout(timeout); abort.abort(); releaseLast(); if (!apiClosed) await api.close(); }
  });
});

const connectionString = process.env.FOLD_TEST_DATABASE_URL;
(connectionString === undefined ? describe.skip : describe)("PostgreSQL ingestion subscriptions", () => {
  it("delivers every numeric sequence through actual SSE across 100 and 1000 boundaries", async () => {
    const schema = `ingestion_sse_${randomUUID().replaceAll("-", "")}`;
    const database = new PostgresFoldDatabase({ connectionString: connectionString!, schema });
    const registry = new PostgresSdkRegistry({ connectionString: connectionString!, schema });
    const tenant = { organizationId: "local", workspaceId: "workspace-1" };
    const pool = new Pool({ connectionString });
    const api = await startApi({ sdks: registry, eventStreamPollMs: 10 });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error("SSE failed to enumerate all numeric positions")), 10_000);
    try {
      await database.appendEntries(tenant, Array.from({ length: 1205 }, (_, index) => ({ status: "canon" as const,
        event: apiEvent({ id: `numeric-${index + 1}`, t: 1205 - index, kind: "wanted" }),
      })));
      const connection = await pool.connect();
      let expected: { event_id: string; sequence: string }[];
      try {
        await connection.query("BEGIN"); await connection.query("SELECT set_config('app.organization_id',$1,true)", [tenant.organizationId]);
        expected = (await connection.query<{ event_id: string; sequence: string }>(`SELECT e.event_id,e.sequence::text AS sequence FROM "${schema}".fold_events e WHERE organization_id=$1 AND workspace_id=$2 ORDER BY e.sequence`, [tenant.organizationId, tenant.workspaceId])).rows;
        await connection.query("COMMIT");
      } finally { connection.release(); }
      const response = await fetch(`${api.baseUrl}/v1/workspaces/workspace-1/event-stream?order=ingestion&afterSequence=0&kind=wanted`, { headers: { authorization: "Bearer token-a" }, signal: abort.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      const actual: { event_id: string; sequence: string }[] = [];
      let buffer = "";
      while (actual.length < expected.length) {
        const chunk = await reader.read(); if (chunk.done) break; buffer += chunk.value;
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
          if (!frame.startsWith("event: fold-event\n")) continue;
          const value = JSON.parse(frame.split("\ndata: ")[1]!) as { entry: { event: { id: string } }; cursor: { sequence: string } };
          actual.push({ event_id: value.entry.event.id, sequence: value.cursor.sequence });
        }
      }
      expect(actual).toEqual(expected);
      expect(new Set(actual.map(row => row.event_id)).size).toBe(1205);
      expect(actual[99]!.sequence).toBe("100"); expect(actual[999]!.sequence).toBe("1000");
    } finally {
      clearTimeout(timer); abort.abort(); await api.close(); await registry.close(); await database.close();
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); await pool.end();
    }
  });

  it("retains late events across restart, filters tenant and private data, and previews explicit migration", async () => {
    const schema = `ingestion_api_${randomUUID().replaceAll("-", "")}`;
    const pool = new Pool({ connectionString });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    const database = new PostgresFoldDatabase({ connectionString: connectionString!, schema });
    const registry = new PostgresSdkRegistry({ connectionString: connectionString!, schema });
    const tenant = { organizationId: "local", workspaceId: "workspace-1" };
    const acl = access({ organizationId: "local" });
    const api = await startApi({ sdks: registry, eventStreamPollMs: 10 });
    const abort = new AbortController();
    try {
      const seed = apiEvent({ id: "high-water", t: 9000, kind: "wanted" });
      await database.appendEntries(tenant, [{ event: seed, status: "canon" }]);
      const head = await registry.latestIngestionCursor(tenant, acl, { kinds: ["wanted"] });
      // New legacy commits are refused by the store; seed a retained pre-v2 offset as an upgraded database would hold it.
      const seeding = await pool.connect();
      try {
        await seeding.query("BEGIN");
        await seeding.query("SELECT set_config('app.organization_id', $1, true)", [tenant.organizationId]);
        await seeding.query(`INSERT INTO "${schema}".fold_consumer_offsets (organization_id, workspace_id, consumer_id, cursor_t, cursor_event_id, cursor_sequence) VALUES ($1, $2, $3, 9000, $4, NULL)`,
          [tenant.organizationId, tenant.workspaceId, JSON.stringify(["user-a", "worker"]), seed.id]);
        await seeding.query("COMMIT");
      } finally { seeding.release(); }
      const path = "/v1/workspaces/workspace-1/consumers/worker?order=ingestion&kind=wanted";
      const preview = await apiRequest(api.baseUrl, path, { token: "token-a" });
      expect(preview).toMatchObject({ status: 200, body: { cursor: null, migrationRequired: true, headCursor: head } });
      expect((await apiRequest(api.baseUrl, path, { token: "token-b" })).body).toMatchObject({ cursor: null, legacyCursor: null, migrationRequired: false });
      const denied = apiEvent({ id: "private", t: 2, kind: "wanted", creatorId: "user-b", principalId: "user-b" });
      const space = apiEvent({ id: "restricted-space", t: 3, kind: "wanted" });
      await database.appendEntries(tenant, [
        { event: denied, status: "canon" },
        { event: { ...space, capture: { ...space.capture, scope: { workspace: "workspace-1", space: "denied-space" } } }, status: "canon" },
        { event: apiEvent({ id: "draft", t: 4, kind: "wanted" }), status: "draft" },
        { event: apiEvent({ id: "other-kind", t: 5, kind: "other" }), status: "canon" },
        { event: apiEvent({ id: "late", t: 1, kind: "wanted" }), status: "canon" },
      ]);
      await database.appendEntries({ ...tenant, organizationId: "foreign" }, [{ event: apiEvent({ id: "other-tenant", t: 1, kind: "wanted" }), status: "canon" }]);
      const page = await registry.ingestionEntries(tenant, acl, { after: head, kinds: ["wanted"], limit: 100 });
      expect(page.items.map(({ entry }) => entry.event.id)).toEqual(["late"]);
      await expect(registry.ingestionEntries({ ...tenant, organizationId: "foreign" }, acl, { limit: 1 })).rejects.toThrow(/tenant mismatch/);
      const commitBeforeMigration = await apiRequest(api.baseUrl, path, { method: "POST", token: "token-a", body: { cursor: page.items[0]!.cursor } });
      expect(commitBeforeMigration.status).toBe(409);
      const migrated = await apiRequest(api.baseUrl, path, { method: "POST", token: "token-a", body: { migration: "replay-all" } });
      expect(migrated).toMatchObject({ status: 200, body: { cursor: { kind: "ingestion", sequence: "0" }, legacyCursor: { t: 9000 }, migrationRequired: false, headCursor: page.items[0]!.cursor } });
      const response = await fetch(`${api.baseUrl}/v1/workspaces/workspace-1/event-stream?order=ingestion&afterSequence=${head.sequence}&kind=wanted`, { headers: { authorization: "Bearer token-a" }, signal: abort.signal });
      expect(response.status).toBe(200);
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let data = "";
      while (!data.includes('"id":"late"')) { const chunk = await reader.read(); if (chunk.done) break; data += chunk.value; }
      for (const hidden of ["private", "restricted-space", "other-kind", "other-tenant", '"id":"draft"', "high-water"]) expect(data).not.toContain(hidden);
      expect(data).toContain('"kind":"ingestion"');
      expect((await apiRequest(api.baseUrl, path, { method: "POST", token: "token-a", body: { cursor: page.items[0]!.cursor } })).status).toBe(200);
      const resetBody = { reset: { expectedCursor: page.items[0]!.cursor, reason: "Repair numeric ingestion pagination" } };
      expect((await apiRequest(api.baseUrl, path, { method: "POST", token: "token-a", body: resetBody })).status).toBe(403);
      expect((await apiRequest(api.baseUrl, path, { method: "POST", token: "token-b", body: { migration: "replay-all" } })).status).toBe(200);
      expect((await apiRequest(api.baseUrl, path, { method: "POST", token: "token-b", body: { cursor: page.items[0]!.cursor } })).status).toBe(200);
      expect((await apiRequest(api.baseUrl, path, { method: "POST", token: "token-b", body: { reset: { expectedCursor: { kind: "ingestion", sequence: "0" }, reason: resetBody.reset.reason } } })).status).toBe(409);
      const reset = await apiRequest(api.baseUrl, path, { method: "POST", token: "token-b", body: resetBody });
      expect(reset).toMatchObject({ status: 200, body: { cursor: { kind: "ingestion", sequence: "0" } } });
      expect((await apiRequest(api.baseUrl, path, { token: "token-a" })).body.cursor).toEqual(page.items[0]!.cursor);
      expect((await apiRequest(api.baseUrl, path, { method: "POST", token: "token-a", body: { cursor: { kind: "ingestion", sequence: "9999999999999999999999" } } })).status).toBe(400);
      const reopened = new PostgresSdkRegistry({ connectionString: connectionString!, schema });
      try { expect((await reopened.ingestionConsumerStatus(tenant, acl, JSON.stringify(["user-a", "worker"]), { kinds: ["wanted"] })).cursor).toEqual(page.items[0]!.cursor); }
      finally { await reopened.close(); }
    } finally {
      abort.abort(); await api.close(); await registry.close(); await database.close();
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`); await pool.end();
    }
  });
});
