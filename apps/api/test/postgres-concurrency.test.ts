import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { apiEvent } from "./helpers.js";

const connectionString = process.env.FOLD_TEST_DATABASE_URL;
const integrationDescribe = connectionString === undefined ? describe.skip : describe;
const root = "/v1/organizations/integration-org/workspaces/integration-workspace";
const ownerToken = "integration-owner-token";
const readerToken = "integration-reader-token";

interface SqlPool {
  query(sql: string): Promise<{ readonly rows: readonly Record<string, unknown>[] }>;
  end(): Promise<void>;
}
const { Pool } = createRequire(new URL("../../../packages/fold-postgres/package.json", import.meta.url))("pg") as {
  readonly Pool: new (options: { readonly connectionString: string }) => SqlPool;
};

interface ApiProcess {
  readonly child: ChildProcess;
  readonly baseUrl: string;
  readonly pid: number;
  readonly stop: () => Promise<void>;
  readonly membership: (state: "active" | "without-space" | "revoked") => Promise<void>;
}

function withTimeout<T>(promise: Promise<T>, message: string, timeoutMs = 8_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

async function startProcess(schema: string, seed: boolean): Promise<ApiProcess> {
  const child = fork(fileURLToPath(new URL("./fixtures/postgres-api-process.mjs", import.meta.url)), [], {
    // Deliberately omit all inherited application configuration and credentials.
    env: {
      PATH: process.env.PATH,
      FOLD_TEST_DATABASE_URL: connectionString!,
      FOLD_TEST_SCHEMA: schema,
      FOLD_TEST_SEED: String(seed),
    },
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });
  let ready: { readonly baseUrl: string; readonly pid: number };
  try {
    ready = await withTimeout(new Promise<{ readonly baseUrl: string; readonly pid: number }>((resolve, reject) => {
      const message = (value: { readonly kind?: string; readonly baseUrl?: string; readonly pid?: number }) => {
        if (value.kind === "ready" && value.baseUrl !== undefined && value.pid !== undefined) {
          child.off("message", message);
          child.off("exit", exited);
          resolve({ baseUrl: value.baseUrl, pid: value.pid });
        }
      };
      const exited = (code: number | null) => reject(new Error(`API child exited ${code}: ${output}`));
      child.on("message", message);
      child.once("exit", exited);
      child.once("error", reject);
    }), "API child startup timed out", 20_000);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return {
    child,
    ...ready,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.send({ kind: "close" });
      try { await withTimeout(exited, "API child shutdown timed out", 5_000); }
      catch { child.kill("SIGKILL"); await exited; }
    },
    membership: async (state) => {
      const id = randomUUID();
      const acknowledged = new Promise<void>((resolve, reject) => {
        const receive = (message: { readonly id?: string; readonly kind?: string; readonly message?: string }) => {
          if (message.id !== id) return;
          child.off("message", receive);
          if (message.kind === "ack") resolve();
          else reject(new Error(message.message ?? "Membership update failed"));
        };
        child.on("message", receive);
        child.send({ kind: "membership", id, state });
      });
      await withTimeout(acknowledged, "Membership update timed out");
    },
  };
}

async function request(api: ApiProcess, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(`${api.baseUrl}${root}${path}`, {
    method,
    headers: { authorization: `Bearer ${ownerToken}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8_000),
  });
  return { status: response.status, body: await response.json() as any };
}

interface DeliveryCursor { readonly version: 2; readonly sequence: string }
interface StreamEvent {
  readonly entry: { readonly event: { readonly id: string; readonly at: { readonly t: number } } };
  readonly cursor: DeliveryCursor;
}

async function openStream(api: ApiProcess, query: string, token = ownerToken) {
  const controller = new AbortController();
  const response = await fetch(`${api.baseUrl}${root}/event-stream?${query}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const events: StreamEvent[] = [];
  const observers = new Set<() => void>();
  let ended = false;
  const done = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!frame.split("\n").includes("event: fold-event")) continue;
          const payload = frame.split("\n").filter((line) => line.startsWith("data: ")).map((line) => line.slice(6)).join("\n");
          events.push(JSON.parse(payload) as StreamEvent);
          observers.forEach((observer) => observer());
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      ended = true;
      observers.forEach((observer) => observer());
    }
  })();
  // Keep disconnect errors observable through waits without unhandled rejection.
  void done.catch(() => undefined);
  return {
    events,
    until: async (id: string, allowClosed = false): Promise<StreamEvent | undefined> => {
      let observer: () => void;
      const found = new Promise<StreamEvent | undefined>((resolve, reject) => {
        observer = () => {
          const match = events.find(({ entry }) => entry.event.id === id);
          if (match !== undefined) resolve(match);
          else if (ended) {
            if (allowClosed) resolve(undefined);
            else reject(new Error(`Stream ended before ${id}`));
          }
        };
        observers.add(observer);
        observer();
      });
      try { return await withTimeout(found, `Stream did not deliver ${id}`); }
      finally { observers.delete(observer!); }
    },
    waitClosed: () => withTimeout(done, "Revoked stream did not close"),
    close: async () => { controller.abort(); await reader.cancel().catch(() => undefined); await done; },
  };
}

function stamp(id: string, t: number) { return { id, t, worldDate: "2026-09-04" }; }
function memoryId(index: number) { return `019c0000-0000-7000-8000-${String(index).padStart(12, "0")}`; }
function event(id: string, t: number, space = false) {
  const base = apiEvent({ id, t, principalId: "integration-owner", workspaceId: "integration-workspace" });
  return {
    ...base,
    capture: {
      ...base.capture,
      scope: { ...base.capture.scope, ...(space ? { space: "space-a" } : {}) },
      identity: { ...base.capture.identity, organization: "integration-org" },
    },
  };
}

integrationDescribe("two-process PostgreSQL API correctness", () => {
  const schema = `fold_api_process_${randomUUID().replaceAll("-", "")}`;
  const processes: ApiProcess[] = [];
  let first: ApiProcess;
  let second: ApiProcess;

  beforeAll(async () => {
    const pool = new Pool({ connectionString: connectionString! });
    try {
      const role = await pool.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
      expect(role.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
      expect((await pool.query("SHOW row_security")).rows[0]).toMatchObject({ row_security: "on" });
    } finally { await pool.end(); }
    // Exercise all four initializers (two tenancy, two event stores) against a
    // schema that does not exist yet; startup DDL must coordinate as well.
    const started = await Promise.allSettled([startProcess(schema, true), startProcess(schema, false)]);
    for (const result of started) if (result.status === "fulfilled") processes.push(result.value);
    for (const result of started) if (result.status === "rejected") throw result.reason;
    first = processes[0]!;
    second = processes[1]!;
    expect(first.pid).not.toBe(second.pid);
    expect(first.pid).not.toBe(process.pid);
  }, 45_000);

  afterAll(async () => {
    await Promise.all(processes.map((api) => api.stop()));
    if (connectionString === undefined) return;
    const pool = new Pool({ connectionString });
    try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { await pool.end(); }
  }, 15_000);

  it("accepts one competing decision and returns the same result on an exact retry", async () => {
    expect((await request(first, "/events", { event: event("candidate-evidence", 100) })).status).toBe(201);
    const candidateId = memoryId(1);
    const proposal = await request(first, "/memory-candidates", {
      stamp: stamp("candidate-proposal", 200),
      input: {
        id: candidateId, audience: "workspace", projectIds: ["integration-project"], source: "integration-fixture",
        summary: "A reviewed fixture decision", content: { decision: "Preserve exactly one acceptance" },
        evidence: [{ eventId: "candidate-evidence" }], confidence: 0.8, salience: 0.8,
        extractor: { kind: "human", id: "integration-review", version: "1" },
      },
    });
    expect(proposal.status).toBe(201);
    await Promise.all([request(first, "/memory-candidates"), request(second, "/memory-candidates")]);
    const decisions = [
      { stamp: stamp("accept-a", 300), memoryStamp: stamp("memory-a", 301), memoryId: memoryId(2) },
      { stamp: stamp("accept-b", 400), memoryStamp: stamp("memory-b", 401), memoryId: memoryId(3) },
    ];
    const responses = await Promise.all([
      request(first, `/memory-candidates/${candidateId}/accept`, decisions[0]),
      request(second, `/memory-candidates/${candidateId}/accept`, decisions[1]),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    const winner = responses.findIndex(({ status }) => status === 201);
    const retry = await request(winner === 0 ? second : first, `/memory-candidates/${candidateId}/accept`, decisions[winner]);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(responses[winner]!.body);
    for (const api of [first, second]) {
      const memories = await request(api, "/memories");
      expect(memories.body.memories).toHaveLength(1);
      const events = await request(api, "/events");
      expect(events.body.entries.filter(({ event: item }: any) => item.kind === "memory.candidate-accepted")).toHaveLength(1);
      expect(events.body.entries.filter(({ event: item }: any) => item.kind === "memory.recorded")).toHaveLength(1);
    }
  }, 20_000);

  it("deduplicates simultaneous identical acceptance requests across processes", async () => {
    expect((await request(first, "/events", { event: event("identical-evidence", 450) })).status).toBe(201);
    const candidateId = memoryId(4);
    expect((await request(first, "/memory-candidates", {
      stamp: stamp("identical-proposal", 500),
      input: {
        id: candidateId, audience: "workspace", applicability: { kind: "global" }, source: "integration-fixture",
        summary: "A retryable reviewed decision", content: { decision: "Keep stable receipt identity" },
        evidence: [{ eventId: "identical-evidence" }], confidence: 0.8, salience: 0.8,
        extractor: { kind: "human", id: "integration-review", version: "1" },
      },
    })).status).toBe(201);
    await Promise.all([request(first, "/memory-candidates"), request(second, "/memory-candidates")]);
    const body = { stamp: stamp("identical-accept", 600), memoryStamp: stamp("identical-memory", 601), memoryId: memoryId(5) };
    const responses = await Promise.all([
      request(first, `/memory-candidates/${candidateId}/accept`, body),
      request(second, `/memory-candidates/${candidateId}/accept`, body),
    ]);
    expect(responses.map(({ status }) => status)).toEqual([201, 201]);
    expect(responses[0]!.body).toEqual(responses[1]!.body);
    const events = (await request(second, "/events")).body.entries;
    expect(events.filter(({ event: item }: any) => item.id === "identical-accept")).toHaveLength(1);
    expect(events.filter(({ event: item }: any) => item.id === "identical-memory")).toHaveLength(1);
  }, 20_000);

  it("refreshes both warmed API snapshots after independent writers commit", async () => {
    const before = await Promise.all([request(first, "/memories"), request(second, "/memories")]);
    for (let pair = 0; pair < 4; pair += 1) {
      const bodies = [0, 1].map((side) => {
        const index = 10 + pair * 2 + side;
        return { stamp: stamp(`concurrent-memory-${index}`, 1_000 + index), input: {
          id: memoryId(index), audience: "workspace", applicability: { kind: "global" }, source: "integration-fixture",
          summary: `Independent memory ${index}`, content: { index },
        } };
      });
      const responses = await Promise.all([request(first, "/memories", bodies[0]), request(second, "/memories", bodies[1])]);
      for (const [side, response] of responses.entries()) {
        if (response.status === 409 || response.status === 503) expect((await request(side === 0 ? first : second, "/memories", bodies[side])).status).toBe(201);
        else expect(response.status).toBe(201);
      }
    }
    const snapshots = await Promise.all([request(first, "/memories"), request(second, "/memories")]);
    const ids = snapshots.map(({ body }) => body.memories.map(({ memory }: any) => memory.id).sort());
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[0]).toHaveLength(before[0]!.body.memories.length + 8);
  }, 20_000);

  it("rejects a reused command identity when nested application access data changes", async () => {
    const body = { stamp: stamp("nested-access-content", 2_000), input: {
      id: memoryId(90), audience: "workspace", applicability: { kind: "global" }, source: "integration-fixture",
      summary: "Application access policy", content: { access: { mode: "read" } },
    } };
    expect((await request(first, "/memories", body)).status).toBe(201);
    const changed = { ...body, input: { ...body.input, content: { access: { mode: "write" } } } };
    expect((await request(second, "/memories", changed)).status).toBe(409);
  }, 20_000);

  it("resumes a durable ingestion cursor after process restart and delivers a backdated event", async () => {
    const initial = await openStream(first, "replay=tail&kind=test.event");
    let cursor: DeliveryCursor;
    try {
      expect((await request(second, "/events", { event: event("newer-before-cursor", 5_000) })).status).toBe(201);
      const received = await initial.until("newer-before-cursor");
      expect(received?.cursor).toMatchObject({ version: 2, sequence: expect.stringMatching(/^\d+$/) });
      cursor = received!.cursor;
      expect((await request(first, "/consumers/delayed-integration", { cursor })).status).toBe(200);
    } finally { await initial.close(); }
    await first.stop();
    expect((await request(second, "/events", { event: event("late-after-cursor", 50) })).status).toBe(201);
    first = await startProcess(schema, false);
    processes.push(first);
    const saved = await request(first, "/consumers/delayed-integration");
    expect(saved.body.cursor).toEqual(cursor!);
    const resumed = await openStream(first, `afterSequence=${cursor!.sequence}&kind=test.event`);
    try {
      const received = await resumed.until("late-after-cursor");
      expect(BigInt(received!.cursor.sequence)).toBeGreaterThan(BigInt(cursor!.sequence));
      expect(received?.entry.event.at.t).toBe(50);
      expect(resumed.events.some(({ entry }) => entry.event.id === "newer-before-cursor")).toBe(false);
    } finally { await resumed.close(); }
    const legacy = await openStream(first, "afterT=5000&afterEventId=newer-before-cursor&kind=test.event");
    try { expect((await legacy.until("late-after-cursor"))?.cursor.version).toBe(2); }
    finally { await legacy.close(); }
    const canonical = (await request(first, "/events")).body.entries.map(({ event: item }: any) => item.id);
    expect(canonical.indexOf("late-after-cursor")).toBeLessThan(canonical.indexOf("newer-before-cursor"));
  }, 30_000);

  it("honors shared database space and workspace revocation on already-open streams", async () => {
    const scoped = await openStream(first, "replay=tail&kind=test.event", readerToken);
    try {
      expect((await request(second, "/events", { event: event("space-before-revocation", 6_000, true) })).status).toBe(201);
      await scoped.until("space-before-revocation");
      await second.membership("without-space");
      expect((await request(second, "/events", { event: event("space-after-revocation", 6_100, true) })).status).toBe(201);
      expect((await request(second, "/events", { event: event("workspace-after-space-change", 6_200) })).status).toBe(201);
      await scoped.until("workspace-after-space-change", true);
      expect(scoped.events.some(({ entry }) => entry.event.id === "space-after-revocation")).toBe(false);
    } finally { await scoped.close(); }
    await second.membership("active");
    const workspace = await openStream(first, "replay=tail&kind=test.event", readerToken);
    try {
      await second.membership("revoked");
      expect((await request(second, "/events", { event: event("workspace-after-revocation", 6_300) })).status).toBe(201);
      await workspace.waitClosed();
      expect(workspace.events.some(({ entry }) => entry.event.id === "workspace-after-revocation")).toBe(false);
    } finally { await workspace.close(); await second.membership("active"); }
  }, 25_000);

  it("rejects recording an existing memory ID under a new command without corrupting replay", async () => {
    const input = { id: memoryId(99), audience: "workspace", applicability: { kind: "global" }, source: "integration-fixture", summary: "Unique memory identity", content: { decision: "once" } };
    expect((await request(first, "/memories", { stamp: stamp("unique-memory-first", 7_000), input })).status).toBe(201);
    const duplicate = await request(second, "/memories", { stamp: stamp("unique-memory-duplicate", 7_100), input });
    expect(duplicate.status).toBe(409);
    expect((await request(first, "/memories")).status).toBe(200);
  }, 20_000);
});
