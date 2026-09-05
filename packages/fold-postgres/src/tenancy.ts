import { randomUUID } from "node:crypto";

import { Pool, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/i;

export class RepositoryEnrollmentConflictError extends Error {
  override readonly name = "RepositoryEnrollmentConflictError";
}

export class TenantTargetUnavailableError extends Error {
  override readonly name = "TenantTargetUnavailableError";
}

export interface PostgresTenantAdministrationOptions {
  readonly connectionString: string;
  readonly schema?: string;
  readonly pool?: Omit<PoolConfig, "connectionString">;
  readonly requireRlsEnforcement?: boolean;
}

export interface RepositoryEnrollment {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly normalizedRemote: string;
  readonly projectId?: string;
  readonly enrolledBy: string;
  readonly enrolledAt: string;
}

export interface PlatformAccessAuditRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly principalId: string;
  readonly credentialId: string;
  readonly reason: string;
  readonly expiresAt: string;
  readonly accessedAt: string;
}

export interface TenantMembershipRecord {
  readonly organizationId: string;
  readonly organizationRole: "owner" | "admin" | "member";
  readonly workspaceId: string;
  readonly workspaceRole: "owner" | "admin" | "member";
  readonly principalId: string;
  readonly spaceRoles: Readonly<Record<string, "admin" | "writer" | "reader">>;
}

export interface ExternalOrganizationBinding {
  readonly externalId: string;
  readonly organizationId: string;
}

export interface ExternalPrincipalBinding {
  readonly externalId: string;
  readonly principalId: string;
}

export interface ExternalIdentityProvisioningEvent {
  /** Source occurrence time, never a delivery/retry timestamp. Missing legacy times are conservative zero. */
  readonly occurredAt?: number;
  readonly eventId: string;
  readonly provider: string;
  readonly type: "organization.upsert" | "organization.delete" | "membership.upsert" | "membership.delete" | "credential.upsert" | "credential.delete";
  readonly externalOrganizationId: string;
  readonly organizationId: string;
  readonly organizationName?: string;
  readonly externalPrincipalId?: string;
  readonly principalId?: string;
  readonly organizationRole?: TenantMembershipRecord["organizationRole"];
  readonly workspaceId?: string;
  readonly workspaceRole?: TenantMembershipRecord["workspaceRole"];
}

export interface IdentityProvisioningAuditRecord {
  readonly eventId: string;
  readonly organizationId: string;
  readonly provider: string;
  readonly eventType: ExternalIdentityProvisioningEvent["type"];
  readonly externalOrganizationId: string;
  readonly externalPrincipalId?: string;
  readonly appliedAt: string;
}

interface RepositoryEnrollmentRow extends QueryResultRow {
  readonly id: string;
  readonly organization_id: string;
  readonly workspace_id: string;
  readonly normalized_remote: string;
  readonly project_id: string | null;
  readonly enrolled_by: string;
  readonly enrolled_at: Date | string;
}

interface PlatformAccessAuditRow extends QueryResultRow {
  readonly id: string;
  readonly organization_id: string;
  readonly workspace_id: string;
  readonly principal_id: string;
  readonly credential_id: string;
  readonly reason: string;
  readonly expires_at: Date | string;
  readonly accessed_at: Date | string;
}

function checkedIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new TypeError(`invalid PostgreSQL identifier: ${value}`);
  return `"${value}"`;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TypeError(`${label} must not be empty`);
  return normalized;
}

function enrollment(row: RepositoryEnrollmentRow): RepositoryEnrollment {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    normalizedRemote: row.normalized_remote,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    enrolledBy: row.enrolled_by,
    enrolledAt: new Date(row.enrolled_at).toISOString(),
  };
}

function auditRecord(row: PlatformAccessAuditRow): PlatformAccessAuditRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    credentialId: row.credential_id,
    reason: row.reason,
    expiresAt: new Date(row.expires_at).toISOString(),
    accessedAt: new Date(row.accessed_at).toISOString(),
  };
}

export class PostgresTenantAdministration {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly ready: Promise<void>;
  private readonly requireRlsEnforcement: boolean;
  private closed = false;

  constructor(options: PostgresTenantAdministrationOptions) {
    if (options.connectionString.trim().length === 0) throw new TypeError("connectionString is required");
    this.pool = new Pool({ connectionString: options.connectionString, ...options.pool });
    this.schema = checkedIdentifier(options.schema ?? "public");
    this.requireRlsEnforcement = options.requireRlsEnforcement === true;
    this.ready = this.initialize();
  }

  private table(name: string): string {
    return `${this.schema}.${checkedIdentifier(name)}`;
  }

  private async initialize(): Promise<void> {
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
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table("fold_organizations")} (
        id text PRIMARY KEY,
        display_name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table("fold_workspaces")} (
        organization_id text NOT NULL REFERENCES ${this.table("fold_organizations")}(id),
        id text NOT NULL,
        display_name text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (organization_id, id)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table("fold_organization_memberships")} (
        organization_id text NOT NULL REFERENCES ${this.table("fold_organizations")}(id),
        principal_id text NOT NULL,
        role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
        source text NOT NULL DEFAULT 'managed',
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (organization_id, principal_id)
      )`);
      await client.query(`ALTER TABLE ${this.table("fold_organization_memberships")}
        ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'managed'`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table("fold_workspace_memberships")} (
        organization_id text NOT NULL,
        workspace_id text NOT NULL,
        principal_id text NOT NULL,
        role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
        space_roles jsonb NOT NULL DEFAULT '{}'::jsonb,
        source text NOT NULL DEFAULT 'managed',
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (organization_id, workspace_id, principal_id),
        FOREIGN KEY (organization_id, workspace_id)
          REFERENCES ${this.table("fold_workspaces")}(organization_id, id)
      )`);
      await client.query(`ALTER TABLE ${this.table("fold_workspace_memberships")}
        ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'managed'`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table("fold_repository_enrollments")} (
        id text PRIMARY KEY,
        organization_id text NOT NULL,
        workspace_id text NOT NULL,
        normalized_remote text NOT NULL,
        project_id text,
        enrolled_by text NOT NULL,
        enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (organization_id, normalized_remote),
        FOREIGN KEY (organization_id, workspace_id)
          REFERENCES ${this.table("fold_workspaces")}(organization_id, id)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table("fold_platform_access_audit")} (
        id text PRIMARY KEY,
        organization_id text NOT NULL,
        workspace_id text NOT NULL,
        principal_id text NOT NULL,
        credential_id text NOT NULL,
        reason text NOT NULL,
        expires_at timestamptz NOT NULL,
        accessed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY (organization_id, workspace_id)
          REFERENCES ${this.table("fold_workspaces")}(organization_id, id)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table("fold_external_organization_bindings")} (
        provider text NOT NULL,
        external_id text NOT NULL,
        organization_id text NOT NULL REFERENCES ${this.table("fold_organizations")}(id),
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (provider, external_id),
        UNIQUE (provider, organization_id)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table("fold_external_principal_bindings")} (
        provider text NOT NULL,
        external_id text NOT NULL,
        principal_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (provider, external_id)
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table("fold_identity_provisioning_audit")} (
        event_id text PRIMARY KEY,
        organization_id text NOT NULL,
        provider text NOT NULL,
        event_type text NOT NULL,
        external_organization_id text NOT NULL,
        external_principal_id text,
        applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS ${this.table("fold_identity_versions")} (
        organization_id text NOT NULL, provider text NOT NULL, external_organization_id text NOT NULL,
        entity_key text NOT NULL, occurred_at bigint NOT NULL, deleted boolean NOT NULL,
        PRIMARY KEY (organization_id, provider, external_organization_id, entity_key)
      )`);
      // Existing organizations are identity metadata, not protected content. Migrate each RLS scope explicitly.
      const legacyOrganizations = await client.query<{ id: string }>(`SELECT id FROM ${this.table("fold_organizations")}`);
      for (const organization of legacyOrganizations.rows) {
        await client.query("SELECT set_config('app.organization_id', $1, true)", [organization.id]);
        await client.query(`INSERT INTO ${this.table("fold_identity_versions")}
          (organization_id, provider, external_organization_id, entity_key, occurred_at, deleted)
          SELECT DISTINCT ON (organization_id, provider, external_organization_id, CASE WHEN event_type LIKE 'organization.%' THEN 'organization' ELSE split_part(event_type, '.', 1) || ':' || external_principal_id END)
            organization_id, provider, external_organization_id, CASE WHEN event_type LIKE 'organization.%' THEN 'organization' ELSE split_part(event_type, '.', 1) || ':' || external_principal_id END,
            floor(extract(epoch FROM applied_at) * 1000)::bigint, event_type LIKE '%.delete'
          FROM ${this.table("fold_identity_provisioning_audit")} WHERE organization_id = $1
          ORDER BY organization_id, provider, external_organization_id, CASE WHEN event_type LIKE 'organization.%' THEN 'organization' ELSE split_part(event_type, '.', 1) || ':' || external_principal_id END, applied_at DESC
          ON CONFLICT DO NOTHING`, [organization.id]);
      }
      for (const tableName of [
        "fold_identity_versions",
        "fold_workspaces",
        "fold_organization_memberships",
        "fold_workspace_memberships",
        "fold_repository_enrollments",
        "fold_platform_access_audit",
        "fold_identity_provisioning_audit",
      ] as const) {
        await client.query(`ALTER TABLE ${this.table(tableName)} ENABLE ROW LEVEL SECURITY`);
        await client.query(`ALTER TABLE ${this.table(tableName)} FORCE ROW LEVEL SECURITY`);
        await client.query(`DROP POLICY IF EXISTS fold_organization_isolation ON ${this.table(tableName)}`);
        await client.query(`CREATE POLICY fold_organization_isolation ON ${this.table(tableName)}
          USING (organization_id = current_setting('app.organization_id', true))
          WITH CHECK (organization_id = current_setting('app.organization_id', true))`);
      }
      await client.query(`CREATE OR REPLACE FUNCTION ${this.schema}.reject_fold_audit_mutation()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RAISE EXCEPTION 'platform access audit records are append-only';
        END $$`);
      await client.query(`DROP TRIGGER IF EXISTS fold_platform_access_audit_append_only
        ON ${this.table("fold_platform_access_audit")}`);
      await client.query(`CREATE TRIGGER fold_platform_access_audit_append_only
        BEFORE UPDATE OR DELETE ON ${this.table("fold_platform_access_audit")}
        FOR EACH ROW EXECUTE FUNCTION ${this.schema}.reject_fold_audit_mutation()`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async transaction<T>(organizationIdInput: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("PostgreSQL tenant administration is closed");
    await this.ready;
    const organizationId = required(organizationIdInput, "organizationId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Runtime transactions share the schema gate before taking table/tenant locks.
      // Initializers hold it exclusively, preventing DDL/bootstrap lock inversions.
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async ensureTenant(client: PoolClient, organizationId: string, workspaceId: string): Promise<void> {
    await client.query(`INSERT INTO ${this.table("fold_organizations")} (id, display_name)
      VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [organizationId]);
    await client.query(`INSERT INTO ${this.table("fold_workspaces")} (organization_id, id, display_name)
      VALUES ($1, $2, $2) ON CONFLICT (organization_id, id) DO NOTHING`, [organizationId, workspaceId]);
  }

  private async replaceMemberships(sourceInput: string, records: readonly TenantMembershipRecord[]): Promise<void> {
    if (this.closed) throw new Error("PostgreSQL tenant administration is closed");
    await this.ready;
    const source = required(sourceInput, "membership source");
    const byOrganization = new Map<string, TenantMembershipRecord[]>();
    for (const record of records) {
      const organizationId = required(record.organizationId, "organizationId");
      const list = byOrganization.get(organizationId) ?? [];
      list.push(record);
      byOrganization.set(organizationId, list);
    }
    const knownOrganizations = await this.pool.query<{ readonly id: string }>(
      `SELECT id FROM ${this.table("fold_organizations")}`,
    );
    const organizationIds = new Set([
      ...knownOrganizations.rows.map(({ id }) => id),
      ...byOrganization.keys(),
    ]);
    for (const organizationId of organizationIds) {
      const organizationRecords = byOrganization.get(organizationId) ?? [];
      await this.transaction(organizationId, async (client) => {
        for (const record of organizationRecords) {
          await this.ensureTenant(client, organizationId, required(record.workspaceId, "workspaceId"));
        }
        await client.query(`DELETE FROM ${this.table("fold_workspace_memberships")}
          WHERE organization_id = $1 AND source = $2`, [organizationId, source]);
        await client.query(`DELETE FROM ${this.table("fold_organization_memberships")}
          WHERE organization_id = $1 AND source = $2`, [organizationId, source]);
        const organizationPrincipals = new Map<string, TenantMembershipRecord["organizationRole"]>();
        for (const record of organizationRecords) {
          const previous = organizationPrincipals.get(record.principalId);
          if (previous !== undefined && previous !== record.organizationRole) {
            throw new TypeError(`conflicting organization roles for ${record.principalId} in ${organizationId}`);
          }
          organizationPrincipals.set(record.principalId, record.organizationRole);
          await client.query(`INSERT INTO ${this.table("fold_workspace_memberships")}
            (organization_id, workspace_id, principal_id, role, space_roles, source)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6)`, [
            organizationId,
            record.workspaceId,
            record.principalId,
            record.workspaceRole,
            JSON.stringify(record.spaceRoles),
            source,
          ]);
        }
        for (const [principalId, role] of organizationPrincipals) {
          await client.query(`INSERT INTO ${this.table("fold_organization_memberships")}
            (organization_id, principal_id, role, source)
            VALUES ($1, $2, $3, $4)`, [organizationId, principalId, role, source]);
        }
      });
    }
  }

  replaceStaticMemberships(records: readonly TenantMembershipRecord[]): Promise<void> {
    return this.replaceMemberships("static", records);
  }

  replaceProviderMemberships(
    providerInput: string,
    records: readonly TenantMembershipRecord[],
  ): Promise<void> {
    return this.replaceMemberships(`identity:${required(providerInput, "identity provider")}`, records);
  }

  async replaceExternalIdentityBindings(
    providerInput: string,
    organizations: readonly ExternalOrganizationBinding[],
    principals: readonly ExternalPrincipalBinding[],
  ): Promise<void> {
    if (this.closed) throw new Error("PostgreSQL tenant administration is closed");
    await this.ready;
    const provider = required(providerInput, "identity provider");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Runtime transactions share the schema gate before taking table/tenant locks.
      // Initializers hold it exclusively, preventing DDL/bootstrap lock inversions.
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");
      await client.query(`DELETE FROM ${this.table("fold_external_organization_bindings")}
        WHERE provider = $1`, [provider]);
      await client.query(`DELETE FROM ${this.table("fold_external_principal_bindings")}
        WHERE provider = $1`, [provider]);
      for (const binding of organizations) {
        const externalId = required(binding.externalId, "external organization id");
        const organizationId = required(binding.organizationId, "organizationId");
        await client.query(`INSERT INTO ${this.table("fold_organizations")} (id, display_name)
          VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`, [organizationId]);
        await client.query(`INSERT INTO ${this.table("fold_external_organization_bindings")}
          (provider, external_id, organization_id) VALUES ($1, $2, $3)`, [
          provider,
          externalId,
          organizationId,
        ]);
      }
      for (const binding of principals) {
        await client.query(`INSERT INTO ${this.table("fold_external_principal_bindings")}
          (provider, external_id, principal_id) VALUES ($1, $2, $3)`, [
          provider,
          required(binding.externalId, "external principal id"),
          required(binding.principalId, "principalId"),
        ]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveExternalOrganization(
    providerInput: string,
    externalIdInput: string,
  ): Promise<string | undefined> {
    if (this.closed) throw new Error("PostgreSQL tenant administration is closed");
    await this.ready;
    const result = await this.pool.query<{ readonly organization_id: string }>(`
      SELECT organization_id FROM ${this.table("fold_external_organization_bindings")}
      WHERE provider = $1 AND external_id = $2
    `, [required(providerInput, "identity provider"), required(externalIdInput, "external organization id")]);
    return result.rows[0]?.organization_id;
  }

  async resolveExternalPrincipal(
    providerInput: string,
    externalIdInput: string,
  ): Promise<string | undefined> {
    if (this.closed) throw new Error("PostgreSQL tenant administration is closed");
    await this.ready;
    const result = await this.pool.query<{ readonly principal_id: string }>(`
      SELECT principal_id FROM ${this.table("fold_external_principal_bindings")}
      WHERE provider = $1 AND external_id = $2
    `, [required(providerInput, "identity provider"), required(externalIdInput, "external principal id")]);
    return result.rows[0]?.principal_id;
  }

  async applyExternalIdentityProvisioningEvent(input: ExternalIdentityProvisioningEvent): Promise<boolean> {
    if (this.closed) throw new Error("PostgreSQL tenant administration is closed");
    await this.ready;
    const eventId = required(input.eventId, "provisioning event id");
    const provider = required(input.provider, "identity provider");
    const externalOrganizationId = required(input.externalOrganizationId, "external organization id");
    const organizationId = required(input.organizationId, "organizationId");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Runtime transactions share the schema gate before taking table/tenant locks.
      // Initializers hold it exclusively, preventing DDL/bootstrap lock inversions.
      await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('fold-schema-v1'))");
      await client.query("SELECT set_config('app.organization_id', $1, true)", [organizationId]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`identity:${provider}:${externalOrganizationId}`]);
      const occurredAt = input.occurredAt ?? (input.type.startsWith("credential.") ? Date.now() : 0);
      if (!Number.isSafeInteger(occurredAt) || occurredAt < 0) throw new TypeError("provisioning occurrence time must be a nonnegative safe integer");
      const entityKey = input.type.startsWith("organization.") ? "organization" : `${input.type.split(".")[0]}:${required(input.externalPrincipalId ?? "", "external principal id")}`;
      const deleted = input.type.endsWith(".delete");
      const versions = await client.query<{ entity_key: string; occurred_at: string; deleted: boolean }>(`
        SELECT entity_key, occurred_at, deleted FROM ${this.table("fold_identity_versions")}
        WHERE organization_id = $1 AND provider = $2 AND external_organization_id = $3
          AND entity_key = ANY($4::text[])`, [organizationId, provider, externalOrganizationId, [entityKey, "organization"]]);
      const current = versions.rows.find((row) => row.entity_key === entityKey);
      const organization = versions.rows.find((row) => row.entity_key === "organization");
      if ((entityKey !== "organization" && organization?.deleted === true) ||
          (current !== undefined && (BigInt(occurredAt) < BigInt(current.occurred_at) ||
           (BigInt(occurredAt) === BigInt(current.occurred_at) && (!deleted || current.deleted))))) {
        await client.query("COMMIT");
        return false;
      }
      const audit = await client.query(`INSERT INTO ${this.table("fold_identity_provisioning_audit")}
        (event_id, organization_id, provider, event_type, external_organization_id, external_principal_id)
        VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (event_id) DO NOTHING RETURNING event_id`, [
        eventId,
        organizationId,
        provider,
        input.type,
        externalOrganizationId,
        input.externalPrincipalId ?? null,
      ]);
      if (audit.rowCount === 0) {
        await client.query("COMMIT");
        return false;
      }

      await client.query(`INSERT INTO ${this.table("fold_identity_versions")}
        (organization_id, provider, external_organization_id, entity_key, occurred_at, deleted)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (organization_id, provider, external_organization_id, entity_key)
        DO UPDATE SET occurred_at = EXCLUDED.occurred_at, deleted = EXCLUDED.deleted`,
        [organizationId, provider, externalOrganizationId, entityKey, occurredAt, deleted]);

      if (input.type === "organization.delete") {
        await client.query(`DELETE FROM ${this.table("fold_workspace_memberships")}
          WHERE organization_id = $1 AND source = $2`, [organizationId, `identity:${provider}`]);
        await client.query(`DELETE FROM ${this.table("fold_organization_memberships")}
          WHERE organization_id = $1 AND source = $2`, [organizationId, `identity:${provider}`]);
        await client.query(`DELETE FROM ${this.table("fold_external_organization_bindings")}
          WHERE provider = $1 AND external_id = $2`, [provider, externalOrganizationId]);
        await client.query("COMMIT");
        return true;
      }

      const organizationName = required(input.organizationName ?? organizationId, "organization name");
      await client.query(`INSERT INTO ${this.table("fold_organizations")} (id, display_name)
        VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`, [
        organizationId,
        organizationName,
      ]);
      if (input.type !== "credential.upsert" && input.type !== "credential.delete") {
        await client.query(`INSERT INTO ${this.table("fold_external_organization_bindings")}
          (provider, external_id, organization_id) VALUES ($1, $2, $3)
          ON CONFLICT (provider, external_id) DO UPDATE SET organization_id = EXCLUDED.organization_id`, [
          provider,
          externalOrganizationId,
          organizationId,
        ]);
      }
      if (input.type === "organization.upsert") {
        await client.query("COMMIT");
        return true;
      }

      const externalPrincipalId = required(input.externalPrincipalId ?? "", "external principal id");
      let principalId = input.principalId === undefined ? undefined : required(input.principalId, "principalId");
      if (principalId === undefined && input.type === "credential.delete") {
        const binding = await client.query<{ readonly principal_id: string }>(`
          SELECT principal_id FROM ${this.table("fold_external_principal_bindings")}
          WHERE provider = $1 AND external_id = $2
        `, [provider, externalPrincipalId]);
        principalId = binding.rows[0]?.principal_id;
      }
      if (principalId === undefined && input.type === "credential.delete") {
        await client.query("COMMIT");
        return true;
      }
      principalId = required(principalId ?? "", "principalId");
      if (input.type === "membership.delete" || input.type === "credential.delete") {
        await client.query(`DELETE FROM ${this.table("fold_workspace_memberships")}
          WHERE organization_id = $1 AND principal_id = $2 AND source = $3
            ${input.workspaceId === undefined ? "" : "AND workspace_id = $4"}`, [
          organizationId,
          principalId,
          `identity:${provider}`,
          ...(input.workspaceId === undefined ? [] : [required(input.workspaceId, "workspaceId")]),
        ]);
        const remaining = await client.query(`SELECT 1 FROM ${this.table("fold_workspace_memberships")}
          WHERE organization_id = $1 AND principal_id = $2 AND source = $3 LIMIT 1`, [
          organizationId,
          principalId,
          `identity:${provider}`,
        ]);
        if (remaining.rowCount === 0) {
          await client.query(`DELETE FROM ${this.table("fold_organization_memberships")}
            WHERE organization_id = $1 AND principal_id = $2 AND source = $3`, [
            organizationId,
            principalId,
            `identity:${provider}`,
          ]);
          if (input.type === "credential.delete") {
            await client.query(`DELETE FROM ${this.table("fold_external_principal_bindings")}
              WHERE provider = $1 AND external_id = $2`, [provider, externalPrincipalId]);
          }
        }
        await client.query("COMMIT");
        return true;
      }

      const workspaceId = required(input.workspaceId ?? "", "workspaceId");
      const organizationRole = input.organizationRole;
      const workspaceRole = input.workspaceRole;
      if (organizationRole === undefined || workspaceRole === undefined) {
        throw new TypeError("membership roles are required");
      }
      await this.ensureTenant(client, organizationId, workspaceId);
      await client.query(`INSERT INTO ${this.table("fold_external_principal_bindings")}
        (provider, external_id, principal_id) VALUES ($1, $2, $3)
        ON CONFLICT (provider, external_id) DO UPDATE SET principal_id = EXCLUDED.principal_id`, [
        provider,
        externalPrincipalId,
        principalId,
      ]);
      await client.query(`INSERT INTO ${this.table("fold_organization_memberships")}
        (organization_id, principal_id, role, source) VALUES ($1, $2, $3, $4)
        ON CONFLICT (organization_id, principal_id) DO UPDATE
        SET role = EXCLUDED.role, source = EXCLUDED.source`, [
        organizationId,
        principalId,
        organizationRole,
        `identity:${provider}`,
      ]);
      await client.query(`INSERT INTO ${this.table("fold_workspace_memberships")}
        (organization_id, workspace_id, principal_id, role, space_roles, source)
        VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)
        ON CONFLICT (organization_id, workspace_id, principal_id) DO UPDATE
        SET role = EXCLUDED.role, source = EXCLUDED.source`, [
        organizationId,
        workspaceId,
        principalId,
        workspaceRole,
        `identity:${provider}`,
      ]);
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  listIdentityProvisioningAudit(organizationId: string): Promise<readonly IdentityProvisioningAuditRecord[]> {
    return this.transaction(organizationId, async (client) => {
      const result = await client.query<QueryResultRow & {
        readonly event_id: string;
        readonly organization_id: string;
        readonly provider: string;
        readonly event_type: ExternalIdentityProvisioningEvent["type"];
        readonly external_organization_id: string;
        readonly external_principal_id: string | null;
        readonly applied_at: Date | string;
      }>(`SELECT event_id, organization_id, provider, event_type,
          external_organization_id, external_principal_id, applied_at
        FROM ${this.table("fold_identity_provisioning_audit")}
        WHERE organization_id = $1 ORDER BY applied_at, event_id`, [organizationId]);
      return result.rows.map((row) => ({
        eventId: row.event_id,
        organizationId: row.organization_id,
        provider: row.provider,
        eventType: row.event_type,
        externalOrganizationId: row.external_organization_id,
        ...(row.external_principal_id === null ? {} : { externalPrincipalId: row.external_principal_id }),
        appliedAt: new Date(row.applied_at).toISOString(),
      }));
    });
  }

  resolveMembership(
    organizationId: string,
    workspaceId: string,
    principalId: string,
  ): Promise<TenantMembershipRecord | undefined> {
    return this.transaction(organizationId, async (client) => {
      const result = await client.query<QueryResultRow & {
        readonly organization_role: TenantMembershipRecord["organizationRole"];
        readonly workspace_role: TenantMembershipRecord["workspaceRole"];
        readonly space_roles: TenantMembershipRecord["spaceRoles"];
      }>(`SELECT organization.role AS organization_role,
          workspace.role AS workspace_role, workspace.space_roles
        FROM ${this.table("fold_organization_memberships")} organization
        JOIN ${this.table("fold_workspace_memberships")} workspace
          ON workspace.organization_id = organization.organization_id
          AND workspace.principal_id = organization.principal_id
        WHERE organization.organization_id = $1
          AND workspace.workspace_id = $2
          AND organization.principal_id = $3`, [organizationId, workspaceId, principalId]);
      const row = result.rows[0];
      return row === undefined ? undefined : {
        organizationId,
        organizationRole: row.organization_role,
        workspaceId,
        workspaceRole: row.workspace_role,
        principalId,
        spaceRoles: row.space_roles,
      };
    });
  }

  listPrincipalMemberships(
    organizationId: string,
    principalIdInput: string,
  ): Promise<readonly TenantMembershipRecord[]> {
    const principalId = required(principalIdInput, "principalId");
    return this.transaction(organizationId, async (client) => {
      const result = await client.query<QueryResultRow & {
        readonly organization_role: TenantMembershipRecord["organizationRole"];
        readonly workspace_id: string;
        readonly workspace_role: TenantMembershipRecord["workspaceRole"];
        readonly space_roles: TenantMembershipRecord["spaceRoles"];
      }>(`SELECT organization.role AS organization_role,
          workspace.workspace_id, workspace.role AS workspace_role, workspace.space_roles
        FROM ${this.table("fold_organization_memberships")} organization
        JOIN ${this.table("fold_workspace_memberships")} workspace
          ON workspace.organization_id = organization.organization_id
          AND workspace.principal_id = organization.principal_id
        WHERE organization.organization_id = $1
          AND organization.principal_id = $2
        ORDER BY workspace.workspace_id`, [organizationId, principalId]);
      return result.rows.map((row) => ({
        organizationId,
        organizationRole: row.organization_role,
        workspaceId: row.workspace_id,
        workspaceRole: row.workspace_role,
        principalId,
        spaceRoles: row.space_roles,
      }));
    });
  }

  listRepositoryEnrollments(organizationId: string, workspaceId: string): Promise<readonly RepositoryEnrollment[]> {
    return this.transaction(organizationId, async (client) => {
      const result = await client.query<RepositoryEnrollmentRow>(`
        SELECT id, organization_id, workspace_id, normalized_remote, project_id, enrolled_by, enrolled_at
        FROM ${this.table("fold_repository_enrollments")}
        WHERE organization_id = $1 AND workspace_id = $2
        ORDER BY enrolled_at, id
      `, [organizationId, workspaceId]);
      return result.rows.map(enrollment);
    });
  }

  enrollRepository(input: {
    readonly organizationId: string;
    readonly workspaceId: string;
    readonly normalizedRemote: string;
    readonly projectId?: string;
    readonly enrolledBy: string;
  }): Promise<RepositoryEnrollment> {
    const organizationId = required(input.organizationId, "organizationId");
    const workspaceId = required(input.workspaceId, "workspaceId");
    const normalizedRemote = required(input.normalizedRemote, "normalizedRemote");
    const enrolledBy = required(input.enrolledBy, "enrolledBy");
    return this.transaction(organizationId, async (client) => {
      await this.ensureTenant(client, organizationId, workspaceId);
      const result = await client.query<RepositoryEnrollmentRow>(`
        INSERT INTO ${this.table("fold_repository_enrollments")}
          (id, organization_id, workspace_id, normalized_remote, project_id, enrolled_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (organization_id, normalized_remote) DO NOTHING
        RETURNING id, organization_id, workspace_id, normalized_remote, project_id, enrolled_by, enrolled_at
      `, [randomUUID(), organizationId, workspaceId, normalizedRemote, input.projectId ?? null, enrolledBy]);
      const created = result.rows[0];
      if (created !== undefined) return enrollment(created);
      const existing = await client.query<RepositoryEnrollmentRow>(`
        SELECT id, organization_id, workspace_id, normalized_remote, project_id, enrolled_by, enrolled_at
        FROM ${this.table("fold_repository_enrollments")}
        WHERE organization_id = $1 AND normalized_remote = $2
      `, [organizationId, normalizedRemote]);
      const row = existing.rows[0];
      if (row === undefined || row.workspace_id !== workspaceId || row.project_id !== (input.projectId ?? null)) {
        throw new RepositoryEnrollmentConflictError(
          "repository is already enrolled to another organization workspace or project",
        );
      }
      return enrollment(row);
    });
  }

  recordPlatformAccess(input: Omit<PlatformAccessAuditRecord, "id" | "accessedAt">): Promise<PlatformAccessAuditRecord> {
    const organizationId = required(input.organizationId, "organizationId");
    const workspaceId = required(input.workspaceId, "workspaceId");
    return this.transaction(organizationId, async (client) => {
      const result = await client.query<PlatformAccessAuditRow>(`
        INSERT INTO ${this.table("fold_platform_access_audit")}
          (id, organization_id, workspace_id, principal_id, credential_id, reason, expires_at)
        SELECT $1, $2, $3, $4, $5, $6, $7::timestamptz
        FROM ${this.table("fold_workspaces")}
        WHERE organization_id = $2 AND id = $3
        RETURNING id, organization_id, workspace_id, principal_id, credential_id, reason, expires_at, accessed_at
      `, [randomUUID(), organizationId, workspaceId, input.principalId, input.credentialId, input.reason, input.expiresAt]);
      const row = result.rows[0];
      if (row === undefined) throw new TenantTargetUnavailableError("platform access target does not exist");
      return auditRecord(row);
    });
  }

  listPlatformAccessAudit(organizationId: string, workspaceId: string): Promise<readonly PlatformAccessAuditRecord[]> {
    return this.transaction(organizationId, async (client) => {
      const result = await client.query<PlatformAccessAuditRow>(`
        SELECT id, organization_id, workspace_id, principal_id, credential_id, reason, expires_at, accessed_at
        FROM ${this.table("fold_platform_access_audit")}
        WHERE organization_id = $1 AND workspace_id = $2
        ORDER BY accessed_at DESC, id DESC
      `, [organizationId, workspaceId]);
      return result.rows.map(auditRecord);
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.ready.catch(() => undefined);
    await this.pool.end();
  }
}
