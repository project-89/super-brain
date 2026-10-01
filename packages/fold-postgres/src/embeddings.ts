import { createHash } from "node:crypto";

import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";

import { LocalLexicalMemoryRanker } from "@_89/fold-sdk";
import type {
  MemoryRankingResult,
  MemoryEmbeddingProvider,
  MemoryRanker,
  MemoryRankingDocument,
  MemoryRankingRequest,
} from "@_89/fold-sdk";
import type { SemanticMemoryCandidate } from "@_89/fold-epistemic";
import { POSTGRES_DEFAULT_ORGANIZATION_ID, type PostgresTenantScope } from "./store.js";
import { checkedSchemaMode, EMBEDDING_SCHEMA, recordSchemaVersion, verifyPostgresSchema, type PostgresSchemaMode } from "./schema.js";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

export interface PostgresVectorMemoryRankerOptions {
  readonly connectionString: string;
  readonly provider: MemoryEmbeddingProvider;
  readonly schema?: string;
  readonly pool?: Omit<PoolConfig, "connectionString">;
  readonly refreshTimeoutMs?: number;
  readonly queryTimeoutMs?: number;
  readonly requireRlsEnforcement?: boolean;
  readonly schemaMode?: PostgresSchemaMode;
}

interface ExistingEmbeddingRow extends QueryResultRow {
  readonly memory_id: string;
  readonly revision: number;
  readonly content_digest: string;
}

interface ScoredEmbeddingRow extends QueryResultRow {
  readonly memory_id: string;
  readonly score: number | string;
}

interface RefreshJob {
  readonly key: string;
  readonly tenant: PostgresTenantScope;
  readonly memoryId: string;
  readonly revision: number;
  readonly text: string;
  readonly digest: string;
  readonly bytes: number;
  attempts: number;
  nextAttemptAt: number;
  running: boolean;
}

function checkedIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new TypeError(`invalid PostgreSQL identifier: ${value}`);
  return `"${value}"`;
}

function documentText(document: MemoryRankingDocument): string {
  return [
    document.summary,
    document.summary,
    document.source,
    ...document.tags,
    ...document.entities.flatMap((entity) => [entity.name, entity.type]),
    JSON.stringify(document.content),
  ].join("\n");
}

function contentDigest(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function vectorLiteral(vector: readonly number[], dimensions: number): string {
  if (vector.length !== dimensions || vector.some((value) => !Number.isFinite(value))) {
    throw new TypeError(`embedding must contain ${dimensions} finite values`);
  }
  return `[${vector.join(",")}]`;
}

export class PostgresVectorMemoryRanker implements MemoryRanker {
  readonly descriptor: { readonly id: string; readonly kind: "semantic" };
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly provider: MemoryEmbeddingProvider;
  private readonly ready: Promise<void>;
  private readonly requireRlsEnforcement: boolean;
  private readonly schemaMode: PostgresSchemaMode;
  private readonly schemaName: string;
  private closed = false;
  private readonly fallback = new LocalLexicalMemoryRanker();
  private readonly refreshJobs = new Map<string, RefreshJob>();
  private refreshBytes = 0;
  private readonly refreshPlans = new Map<string, Promise<void>>();
  private refreshPump: Promise<void> | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly providerWork = new Set<Promise<unknown>>();
  private readonly providerControllers = new Set<AbortController>();
  private readonly refreshTimeoutMs: number;
  private readonly queryTimeoutMs: number;

  constructor(options: PostgresVectorMemoryRankerOptions) {
    if (options.connectionString.trim().length === 0) {
      throw new TypeError("connectionString is required");
    }
    if (!Number.isInteger(options.provider.descriptor.dimensions) || options.provider.descriptor.dimensions < 1 || options.provider.descriptor.dimensions > 16_000) {
      throw new TypeError("embedding dimensions must be an integer within [1, 16000]");
    }
    if (options.provider.descriptor.id.trim().length === 0) throw new TypeError("embedding provider id is required");
    this.pool = new Pool({ connectionString: options.connectionString, connectionTimeoutMillis: 5_000, ...options.pool });
    this.schemaName = options.schema ?? "public";
    this.schema = checkedIdentifier(this.schemaName);
    this.schemaMode = checkedSchemaMode(options.schemaMode);
    this.provider = options.provider;
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? 10_000;
    this.queryTimeoutMs = options.queryTimeoutMs ?? 3_000;
    if (![this.refreshTimeoutMs, this.queryTimeoutMs].every((value) => Number.isInteger(value) && value > 0 && value <= 60_000)) throw new TypeError("invalid embedding deadlines");
    this.requireRlsEnforcement = options.requireRlsEnforcement === true;
    this.descriptor = { id: `pgvector:${options.provider.descriptor.id}`, kind: "semantic" };
    this.ready = this.initialize();
  }

  private table(name: string): string {
    return `${this.schema}.${checkedIdentifier(name)}`;
  }

  private async initialize(): Promise<void> {
    const dimensions = this.provider.descriptor.dimensions;
    const client = await this.pool.connect();
    try {
      if (this.schemaMode === "verify") {
        await client.query("BEGIN READ ONLY");
        await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");
        await verifyPostgresSchema(client, this.schemaName, EMBEDDING_SCHEMA);
        const configured = await client.query<{ dimensions: number }>(`SELECT dimensions FROM ${this.table("fold_memory_embedding_config")} WHERE singleton = true`);
        if (configured.rows[0]?.dimensions !== dimensions) throw new TypeError("Runtime embedding dimensions differ from migrated configuration");
        await client.query("COMMIT");
        return;
      }
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('fold-schema-v1'))");
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      if (this.requireRlsEnforcement) {
        const role = await client.query<{ readonly rolsuper: boolean; readonly rolbypassrls: boolean }>(`
          SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
        `);
        if (role.rows[0]?.rolsuper === true || role.rows[0]?.rolbypassrls === true) {
          throw new Error("FOLD_REQUIRE_TENANT_RLS rejects PostgreSQL roles with superuser or BYPASSRLS");
        }
        const rowSecurity = await client.query<{ readonly row_security: string }>("SHOW row_security");
        if (rowSecurity.rows[0]?.row_security !== "on") {
          throw new Error("FOLD_REQUIRE_TENANT_RLS requires PostgreSQL row_security=on");
        }
      }
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table("fold_memory_embedding_config")} (
          singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
          dimensions integer NOT NULL CHECK (dimensions > 0)
        )
      `);
      await client.query(`
        INSERT INTO ${this.table("fold_memory_embedding_config")} (singleton, dimensions)
        VALUES (true, $1)
        ON CONFLICT (singleton) DO NOTHING
      `, [dimensions]);
      const configured = await client.query<{ readonly dimensions: number }>(`
        SELECT dimensions FROM ${this.table("fold_memory_embedding_config")} WHERE singleton = true
      `);
      if (configured.rows[0]?.dimensions !== dimensions) {
        throw new TypeError(`pgvector memory index is configured for ${configured.rows[0]?.dimensions} dimensions, not ${dimensions}`);
      }
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.table("fold_memory_embeddings")} (
          organization_id text NOT NULL DEFAULT '${POSTGRES_DEFAULT_ORGANIZATION_ID}',
          workspace_id text NOT NULL,
          memory_id text NOT NULL,
          revision integer NOT NULL,
          model_id text NOT NULL,
          content_digest text NOT NULL,
          embedding vector(${dimensions}) NOT NULL,
          indexed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
          PRIMARY KEY (organization_id, workspace_id, memory_id, model_id)
        )
      `);
      await client.query(`ALTER TABLE ${this.table("fold_memory_embeddings")}
        ADD COLUMN IF NOT EXISTS organization_id text NOT NULL DEFAULT '${POSTGRES_DEFAULT_ORGANIZATION_ID}'`);
      await client.query(`
        DO $migration$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = '${this.table("fold_memory_embeddings")}'::regclass
              AND contype = 'p'
              AND pg_get_constraintdef(oid) LIKE 'PRIMARY KEY (organization_id,%'
          ) THEN
            ALTER TABLE ${this.table("fold_memory_embeddings")}
              DROP CONSTRAINT IF EXISTS fold_memory_embeddings_pkey;
            ALTER TABLE ${this.table("fold_memory_embeddings")}
              ADD CONSTRAINT fold_memory_embeddings_pkey
              PRIMARY KEY (organization_id, workspace_id, memory_id, model_id);
          END IF;
        END
        $migration$
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS fold_memory_embeddings_tenant_model
        ON ${this.table("fold_memory_embeddings")} (organization_id, workspace_id, model_id, memory_id)`);
      await client.query(`
        CREATE INDEX IF NOT EXISTS fold_memory_embeddings_hnsw
        ON ${this.table("fold_memory_embeddings")} USING hnsw (embedding vector_cosine_ops)
      `);
      await client.query(`ALTER TABLE ${this.table("fold_memory_embeddings")} ENABLE ROW LEVEL SECURITY`);
      await client.query(`ALTER TABLE ${this.table("fold_memory_embeddings")} FORCE ROW LEVEL SECURITY`);
      await client.query(`DROP POLICY IF EXISTS fold_organization_isolation ON ${this.table("fold_memory_embeddings")}`);
      await client.query(`CREATE POLICY fold_organization_isolation ON ${this.table("fold_memory_embeddings")}
        USING (organization_id = current_setting('app.organization_id', true))
        WITH CHECK (organization_id = current_setting('app.organization_id', true))`);
      await recordSchemaVersion(client, this.schemaName, EMBEDDING_SCHEMA);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async open(): Promise<void> {
    if (this.closed) throw new Error("PostgreSQL memory ranker is closed");
    await this.ready;
  }

  private async setTenant(client: PoolClient, tenant: PostgresTenantScope): Promise<void> {
    await client.query("SELECT set_config('app.organization_id', $1, true)", [tenant.organizationId]);
  }

  private async tenantQuery<R extends QueryResultRow>(
    tenant: PostgresTenantScope,
    text: string,
    values: readonly unknown[],
  ): Promise<QueryResult<R>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Runtime transactions share the schema gate before taking table/tenant locks.
      // Initializers hold it exclusively, preventing DDL/bootstrap lock inversions.
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");
      await this.setTenant(client, tenant);
      const result = await client.query<R>(text, [...values]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private providerCall(inputs: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<readonly (readonly number[])[]> {
    if (this.closed || this.providerWork.size >= 4) return Promise.reject(new Error("embedding-capacity-unavailable"));
    signal?.throwIfAborted();
    const controller = new AbortController(); this.providerControllers.add(controller);
    const cancel = () => controller.abort(signal?.reason); signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("embedding-timeout")), timeoutMs);
    const actual = Promise.resolve().then(() => this.provider.embed(inputs, { signal: controller.signal, timeoutMs }));
    this.providerWork.add(actual);
    // Capacity follows physical settlement, including providers that ignore cancellation.
    void actual.then(() => this.providerWork.delete(actual), () => this.providerWork.delete(actual)).then(() => this.scheduleRefresh());
    return new Promise<readonly (readonly number[])[]>((resolve, reject) => {
      const abort = () => reject(controller.signal.reason ?? new Error("embedding-aborted"));
      controller.signal.addEventListener("abort", abort, { once: true });
      void actual.then((vectors) => controller.signal.aborted ? abort() : resolve(vectors), reject).finally(() => controller.signal.removeEventListener("abort", abort));
    }).finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); this.providerControllers.delete(controller); });
  }

  private enqueueDocuments(request: MemoryRankingRequest): Promise<void> {
    if (this.closed) return Promise.resolve();
    const tenant = { organizationId: request.organizationId ?? POSTGRES_DEFAULT_ORGANIZATION_ID, workspaceId: request.workspaceId };
    const partition = JSON.stringify([tenant.organizationId, tenant.workspaceId, this.provider.descriptor.id]);
    const prior = this.refreshPlans.get(partition); if (prior !== undefined) return prior;
    if (this.refreshPlans.size >= 8) return Promise.resolve();
    const prepared = request.documents.map((document) => {
      const text = documentText(document), digest = contentDigest(text);
      return { memoryId: document.memoryId, revision: document.revision, text, digest, bytes: Buffer.byteLength(text) * 2 + 256 };
    });
    const plan = (async () => {
      await this.open();
      const existing = await this.tenantQuery<ExistingEmbeddingRow>(tenant, `SELECT memory_id,revision,content_digest FROM ${this.table("fold_memory_embeddings")}
        WHERE organization_id=$1 AND workspace_id=$2 AND model_id=$3 AND memory_id=ANY($4::text[])`, [tenant.organizationId,tenant.workspaceId,this.provider.descriptor.id,prepared.map(({memoryId})=>memoryId)]);
      if (this.closed) return;
      const byId = new Map(existing.rows.map((row) => [row.memory_id,row]));
      for (const item of prepared) {
        const row = byId.get(item.memoryId);
        if (row?.revision === item.revision && row.content_digest === item.digest) continue;
        const key = JSON.stringify([partition,item.memoryId,item.revision,item.digest]);
        if (this.refreshJobs.has(key) || item.bytes > 256 * 1024) continue;
        if (this.refreshJobs.size >= 4096 || this.refreshBytes + item.bytes > 8 * 1024 * 1024) continue;
        this.refreshJobs.set(key,{ ...item,key,tenant,attempts:0,nextAttemptAt:0,running:false }); this.refreshBytes += item.bytes;
      }
      this.scheduleRefresh();
    })();
    this.refreshPlans.set(partition,plan);
    void plan.then(() => this.refreshPlans.delete(partition), () => this.refreshPlans.delete(partition));
    return plan;
  }

  private scheduleRefresh(): void {
    if (this.closed || this.refreshPump !== undefined || this.providerWork.size >= 4 || this.refreshTimer !== undefined) return;
    const pending = [...this.refreshJobs.values()].filter((job) => !job.running && job.attempts < 3);
    if (pending.length === 0) return;
    const delay = Math.max(0, Math.min(...pending.map(({nextAttemptAt})=>nextAttemptAt)) - Date.now());
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; void this.pumpRefresh().catch(() => undefined); }, delay);
    this.refreshTimer.unref();
  }

  private pumpRefresh(): Promise<void> {
    if (this.refreshPump !== undefined) return this.refreshPump;
    this.refreshPump = this.runRefresh().finally(() => { this.refreshPump = undefined; this.scheduleRefresh(); });
    return this.refreshPump;
  }

  private async runRefresh(): Promise<void> {
    while (!this.closed && this.providerWork.size < 4) {
      const first = [...this.refreshJobs.values()].find((job) => !job.running && job.attempts < 3 && job.nextAttemptAt <= Date.now());
      if (first === undefined) return;
      const batch = [...this.refreshJobs.values()].filter((job) => !job.running && job.attempts < 3 && job.nextAttemptAt <= Date.now() && job.tenant.organizationId === first.tenant.organizationId && job.tenant.workspaceId === first.tenant.workspaceId).slice(0,64);
      for (const job of batch) job.running = true;
      try {
        const vectors = await this.providerCall(batch.map(({text})=>text),this.refreshTimeoutMs);
        if (this.closed) return;
        if (vectors.length !== batch.length) throw new TypeError("embedding provider returned wrong vector count");
        for (const [index,job] of batch.entries()) {
          if (this.closed) return;
          await this.tenantQuery(job.tenant, `INSERT INTO ${this.table("fold_memory_embeddings")}
            (organization_id,workspace_id,memory_id,revision,model_id,content_digest,embedding) VALUES($1,$2,$3,$4,$5,$6,$7::vector)
            ON CONFLICT (organization_id,workspace_id,memory_id,model_id) DO UPDATE SET revision=EXCLUDED.revision,content_digest=EXCLUDED.content_digest,embedding=EXCLUDED.embedding,indexed_at=clock_timestamp()
            WHERE ${this.table("fold_memory_embeddings")}.revision <= EXCLUDED.revision`,
            [job.tenant.organizationId,job.tenant.workspaceId,job.memoryId,job.revision,this.provider.descriptor.id,job.digest,vectorLiteral(vectors[index]!,this.provider.descriptor.dimensions)]);
          this.refreshJobs.delete(job.key); this.refreshBytes -= job.bytes;
        }
      } catch (error) {
        for (const job of batch) if (this.refreshJobs.has(job.key)) {
          job.running = false;
          if (!(error instanceof Error && error.message === "embedding-capacity-unavailable")) job.attempts += 1;
          job.nextAttemptAt = Date.now() + Math.min(30_000,1_000 * 2 ** job.attempts);
        }
      }
    }
  }

  /** Explicit bounded refresh for operators/tests; ordinary rank requests schedule it independently. */
  async refresh(request: MemoryRankingRequest): Promise<void> { await this.enqueueDocuments(request); await this.pumpRefresh(); }
  refreshStatus(): { pending: number; running: number; retry: number; exhausted: number; bytes: number; providerCalls: number } {
    const jobs = [...this.refreshJobs.values()];
    return { pending: jobs.filter((job)=>!job.running && job.attempts===0).length, running: jobs.filter((job)=>job.running).length,
      retry: jobs.filter((job)=>!job.running && job.attempts>0 && job.attempts<3).length, exhausted: jobs.filter((job)=>job.attempts>=3).length, bytes:this.refreshBytes, providerCalls:this.providerWork.size };
  }
  repairRefresh(action: "retry" | "discard"): void {
    for (const job of this.refreshJobs.values()) if (job.attempts >= 3) {
      if (action === "discard") { this.refreshJobs.delete(job.key); this.refreshBytes -= job.bytes; }
      else { job.attempts = 0; job.nextAttemptAt = 0; }
    }
    this.scheduleRefresh();
  }

  async rank(request: MemoryRankingRequest): Promise<readonly SemanticMemoryCandidate[]> { return (await this.rankWithMetadata(request)).candidates; }
  async rankWithMetadata(request: MemoryRankingRequest): Promise<MemoryRankingResult> {
    request.signal?.throwIfAborted();
    if (this.closed) throw new Error("embedding ranker is closed");
    if (request.documents.length === 0) return { candidates: [], ranking: this.descriptor };
    void this.enqueueDocuments(request).catch(() => undefined);
    const tenant = { organizationId: request.organizationId ?? POSTGRES_DEFAULT_ORGANIZATION_ID, workspaceId: request.workspaceId };
    try {
      await this.open();
      const vectors = await this.providerCall([request.query],this.queryTimeoutMs,request.signal);
      if (vectors.length !== 1) throw new TypeError("embedding query requires one vector");
      const query = vectorLiteral(vectors[0]!,this.provider.descriptor.dimensions);
      const requested = request.documents.map((document)=>({memory_id:document.memoryId,revision:document.revision,content_digest:contentDigest(documentText(document))}));
      const result = await this.tenantQuery<ScoredEmbeddingRow & { indexed_count: string }>(tenant, `
        SELECT e.memory_id,COUNT(*) OVER() AS indexed_count,GREATEST(0,LEAST(1,1-(e.embedding <=> $1::vector))) AS score
        FROM ${this.table("fold_memory_embeddings")} e JOIN jsonb_to_recordset($5::jsonb) AS requested(memory_id text,revision integer,content_digest text)
          ON e.memory_id=requested.memory_id AND e.revision=requested.revision AND e.content_digest=requested.content_digest
        WHERE e.organization_id=$2 AND e.workspace_id=$3 AND e.model_id=$4 ORDER BY e.embedding <=> $1::vector,e.memory_id LIMIT $6
      `,[query,tenant.organizationId,tenant.workspaceId,this.provider.descriptor.id,JSON.stringify(requested),request.limit]);
      request.signal?.throwIfAborted();
      if (!this.closed && Number(result.rows[0]?.indexed_count ?? 0) === request.documents.length) return { candidates:result.rows.map((row)=>({memoryId:row.memory_id,score:Number(row.score)})),ranking:this.descriptor };
    } catch { request.signal?.throwIfAborted(); }
    return { candidates:await this.fallback.rank(request),ranking:this.fallback.descriptor };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.refreshTimer); this.refreshTimer = undefined;
    for (const controller of this.providerControllers) controller.abort(new Error("embedding-ranker-closed"));
    await this.provider.close?.();
    await this.refreshPump?.catch(() => undefined);
    await Promise.allSettled([...this.refreshPlans.values()]);
    this.refreshJobs.clear(); this.refreshBytes = 0;
    await this.ready.catch(() => undefined);
    await this.pool.end();
  }
}
