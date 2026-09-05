import { createHash } from "node:crypto";

import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";

import type {
  MemoryEmbeddingProvider,
  MemoryRanker,
  MemoryRankingDocument,
  MemoryRankingRequest,
} from "@_89/fold-sdk";
import type { SemanticMemoryCandidate } from "@_89/fold-epistemic";
import { POSTGRES_DEFAULT_ORGANIZATION_ID, type PostgresTenantScope } from "./store.js";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

export interface PostgresVectorMemoryRankerOptions {
  readonly connectionString: string;
  readonly provider: MemoryEmbeddingProvider;
  readonly schema?: string;
  readonly pool?: Omit<PoolConfig, "connectionString">;
  readonly requireRlsEnforcement?: boolean;
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
  private closed = false;

  constructor(options: PostgresVectorMemoryRankerOptions) {
    if (options.connectionString.trim().length === 0) {
      throw new TypeError("connectionString is required");
    }
    if (!Number.isInteger(options.provider.descriptor.dimensions) || options.provider.descriptor.dimensions < 1 || options.provider.descriptor.dimensions > 16_000) {
      throw new TypeError("embedding dimensions must be an integer within [1, 16000]");
    }
    if (options.provider.descriptor.id.trim().length === 0) throw new TypeError("embedding provider id is required");
    this.pool = new Pool({ connectionString: options.connectionString, ...options.pool });
    this.schema = checkedIdentifier(options.schema ?? "public");
    this.provider = options.provider;
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
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
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

  private async ensureDocuments(tenant: PostgresTenantScope, documents: readonly MemoryRankingDocument[]): Promise<void> {
    if (documents.length === 0) return;
    await this.ready;
    const modelId = this.provider.descriptor.id;
    const ids = documents.map(({ memoryId }) => memoryId);
    const existing = await this.tenantQuery<ExistingEmbeddingRow>(tenant, `
      SELECT memory_id, revision, content_digest
      FROM ${this.table("fold_memory_embeddings")}
      WHERE organization_id = $1 AND workspace_id = $2 AND model_id = $3 AND memory_id = ANY($4::text[])
    `, [tenant.organizationId, tenant.workspaceId, modelId, ids]);
    const byId = new Map(existing.rows.map((row) => [row.memory_id, row]));
    const prepared = documents.map((document) => {
      const text = documentText(document);
      return { document, text, digest: contentDigest(text) };
    });
    const missing = prepared.filter(({ document, digest }) => {
      const current = byId.get(document.memoryId);
      return current === undefined || current.revision !== document.revision || current.content_digest !== digest;
    });
    if (missing.length === 0) return;
    const vectors: Array<readonly number[]> = [];
    for (let offset = 0; offset < missing.length; offset += 64) {
      const batch = missing.slice(offset, offset + 64);
      const embedded = await this.provider.embed(batch.map(({ text }) => text));
      if (embedded.length !== batch.length) throw new TypeError("embedding provider returned the wrong number of vectors");
      vectors.push(...embedded);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.setTenant(client, tenant);
      for (const [index, item] of missing.entries()) {
        const vector = vectorLiteral(vectors[index]!, this.provider.descriptor.dimensions);
        await client.query(`
          INSERT INTO ${this.table("fold_memory_embeddings")}
            (organization_id, workspace_id, memory_id, revision, model_id, content_digest, embedding)
          VALUES ($1, $2, $3, $4, $5, $6, $7::vector)
          ON CONFLICT (organization_id, workspace_id, memory_id, model_id) DO UPDATE SET
            revision = EXCLUDED.revision,
            content_digest = EXCLUDED.content_digest,
            embedding = EXCLUDED.embedding,
            indexed_at = clock_timestamp()
        `, [tenant.organizationId, tenant.workspaceId, item.document.memoryId, item.document.revision, modelId, item.digest, vector]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async rank(request: MemoryRankingRequest): Promise<readonly SemanticMemoryCandidate[]> {
    if (request.documents.length === 0) return [];
    const tenant = {
      organizationId: request.organizationId ?? POSTGRES_DEFAULT_ORGANIZATION_ID,
      workspaceId: request.workspaceId,
    };
    await this.ensureDocuments(tenant, request.documents);
    const queryVectors = await this.provider.embed([request.query]);
    const query = vectorLiteral(queryVectors[0]!, this.provider.descriptor.dimensions);
    const result = await this.tenantQuery<ScoredEmbeddingRow>(tenant, `
      SELECT memory_id, GREATEST(0, LEAST(1, 1 - (embedding <=> $1::vector))) AS score
      FROM ${this.table("fold_memory_embeddings")}
      WHERE organization_id = $2 AND workspace_id = $3 AND model_id = $4 AND memory_id = ANY($5::text[])
      ORDER BY embedding <=> $1::vector, memory_id
      LIMIT $6
    `, [
      query,
      tenant.organizationId,
      tenant.workspaceId,
      this.provider.descriptor.id,
      request.documents.map(({ memoryId }) => memoryId),
      request.limit,
    ]);
    return result.rows.map((row) => ({ memoryId: row.memory_id, score: Number(row.score) }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.ready.catch(() => undefined);
    await this.pool.end();
  }
}
