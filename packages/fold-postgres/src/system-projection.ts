import { createHash } from "node:crypto";

import { continueFold, fold, sortLog, type FoldLogEntry, type FoldState } from "@_89/fold";
import { authorizeEventAccess, type FoldSdkAccessContext, type FoldSdkCursor, type FoldSdkSystemProjection } from "@_89/fold-sdk";
import type { PoolClient } from "pg";

export interface SystemCheckpoint extends FoldSdkSystemProjection {
  readonly sequence: string;
  readonly through?: FoldSdkCursor;
}

type Entries<T> = T extends Map<infer K, infer V> ? [K, V][] : never;
type SerializedState = {
  readonly values: Entries<FoldState["values"]>;
  readonly nodes: Entries<FoldState["nodes"]>;
  readonly edges: Entries<FoldState["edges"]>;
  readonly redirects: Entries<FoldState["redirects"]>;
  readonly diagnostics: FoldState["diagnostics"];
};

function encodeState(state: FoldState): SerializedState {
  return {
    values: [...state.values], nodes: [...state.nodes], edges: [...state.edges],
    redirects: [...state.redirects], diagnostics: state.diagnostics,
  };
}

function decodeState(state: SerializedState): FoldState {
  return {
    values: new Map(state.values), nodes: new Map(state.nodes), edges: new Map(state.edges),
    redirects: new Map(state.redirects), diagnostics: [...state.diagnostics], appliedEvents: [], appliedChanges: [],
  };
}

export function systemProjectionKey(access: FoldSdkAccessContext, include: "canon" | "canon+draft"): string {
  // Bump this version whenever reducer semantics or authorization rules change.
  return "system-v1:" + createHash("sha256").update(JSON.stringify([
    include, access.organizationId ?? "local", access.workspaceId, access.principalId,
    access.workspaceRole, access.platformDataAccess === true,
    Object.entries(access.spaceRoles).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
  ])).digest("hex");
}

export async function advanceSystemProjection(
  client: PoolClient,
  tables: { readonly events: string; readonly checkpoints: string; readonly cells: string },
  tenant: { readonly organizationId: string; readonly workspaceId: string },
  access: FoldSdkAccessContext,
  include: "canon" | "canon+draft",
  key: string,
  cached?: SystemCheckpoint,
): Promise<SystemCheckpoint> {
  const params = [tenant.organizationId, tenant.workspaceId];
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [JSON.stringify(["system-projection", ...params, key])]);
  const latest = await client.query<{ sequence: string }>(`
    SELECT COALESCE(MAX(sequence), 0)::text AS sequence FROM ${tables.events}
    WHERE organization_id = $1 AND workspace_id = $2
  `, params);
  const sequence = latest.rows[0]!.sequence;
  if (cached?.sequence === sequence) return cached;

  let previous = cached;
  {
    const saved = await client.query<{ state: Omit<SystemCheckpoint, "state"> }>(`
      SELECT state FROM ${tables.checkpoints}
      WHERE organization_id = $1 AND workspace_id = $2 AND projection = $3 AND configuration_digest = $3
    `, [...params, key]);
    const checkpoint = saved.rows[0]?.state;
    // A second process may have advanced durable cells while this process held an older cache.
    if (checkpoint !== undefined && checkpoint.sequence !== previous?.sequence) {
      await client.query(`DECLARE system_projection_cells NO SCROLL CURSOR FOR
        SELECT section, cell_id, value FROM ${tables.cells}
        WHERE organization_id = $1 AND workspace_id = $2 AND projection = $3
      `, [...params, key]);
      const state = fold([], { include: "canon+draft", retainApplied: false });
      const diagnostics: { index: number; value: FoldState["diagnostics"][number] }[] = [];
      while (true) {
        const cells = await client.query<{ section: keyof SerializedState; cell_id: string; value: unknown }>("FETCH FORWARD 500 FROM system_projection_cells");
        if (cells.rows.length === 0) break;
        for (const cell of cells.rows) {
          if (cell.section === "diagnostics") diagnostics.push({ index: Number(cell.cell_id), value: cell.value as FoldState["diagnostics"][number] });
          else (state[cell.section] as Map<string, unknown>).set(cell.cell_id, cell.value);
        }
      }
      await client.query("CLOSE system_projection_cells");
      for (const { value } of diagnostics.sort((a, b) => a.index - b.index)) state.diagnostics.push(value);
      previous = { ...checkpoint, state };
    }
  }
  if (previous?.sequence === sequence) return previous;

  // Compare ties in JavaScript's canonical code-unit order, not the database collation.
  const possibleLate = previous?.through === undefined ? [] : (await client.query<{
    t: number; event_id: string; scope: FoldLogEntry["event"]["capture"]["scope"];
  }>(`
    SELECT t, event_id, event #> '{capture,scope}' AS scope FROM ${tables.events}
    WHERE organization_id = $1 AND workspace_id = $2 AND sequence > $3::bigint AND sequence <= $4::bigint AND t <= $5
      ${include === "canon" ? "AND status = 'canon'" : ""}
  `, [...params, previous.sequence, sequence, previous.through.t])).rows;
  const late = possibleLate.some((row) =>
    (row.t < previous!.through!.t || row.event_id <= previous!.through!.eventId) &&
    authorizeEventAccess({ capture: { scope: row.scope } }, access).allowed);
  const rebuild = previous === undefined || late;
  const options = { include: "canon+draft", existingCreate: "replace", retainApplied: false, validatedInput: true, orderedInput: true } as const;
  const state = rebuild ? fold([], options) : decodeState(encodeState(previous!.state));
  let through = rebuild ? undefined : previous?.through;
  let eventCount = 0;
  let changeCount = 0;
  await client.query(`DECLARE system_projection_events NO SCROLL CURSOR FOR
    SELECT event, status FROM ${tables.events}
    WHERE organization_id = $1 AND workspace_id = $2 AND sequence > $3::bigint AND sequence <= $4::bigint
      ${include === "canon" ? "AND status = 'canon'" : ""}
    ORDER BY t, sequence
  `, [...params, rebuild ? "0" : previous!.sequence, sequence]);
  let pending: FoldLogEntry[] = [];
  while (true) {
    const page = await client.query<FoldLogEntry>("FETCH FORWARD 500 FROM system_projection_events");
    pending.push(...page.rows.filter(({ event }) => authorizeEventAccess(event, access).allowed));
    const lastTime = pending.at(-1)?.event.at.t;
    const ready = page.rows.length === 0 ? pending : pending.filter(({ event }) => event.at.t !== lastTime);
    pending = page.rows.length === 0 ? [] : pending.filter(({ event }) => event.at.t === lastTime);
    // Keep equal-time groups together and use the Fold's exact code-unit ordering.
    const ordered = sortLog(ready);
    continueFold(state, ordered, options);
    eventCount += ordered.length;
    changeCount += ordered.reduce((count, entry) => count + entry.event.changes.length, 0);
    const last = ordered.at(-1)?.event;
    if (last !== undefined) through = { t: last.at.t, eventId: last.id };
    if (page.rows.length === 0) break;
  }
  await client.query("CLOSE system_projection_events");
  const next: SystemCheckpoint = {
    state, sequence,
    ...(through === undefined ? {} : { through }),
    appliedEventCount: (rebuild ? 0 : previous!.appliedEventCount) + eventCount,
    appliedChangeCount: (rebuild ? 0 : previous!.appliedChangeCount) + changeCount,
  };
  if (rebuild) {
    await client.query(`DELETE FROM ${tables.cells} WHERE organization_id = $1 AND workspace_id = $2 AND projection = $3`, [...params, key]);
  }
  type Cell = { section: keyof SerializedState; cell_id: string; value: unknown };
  let batch: Cell[] = [];
  let batchBytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    await client.query(`
      INSERT INTO ${tables.cells} (organization_id, workspace_id, projection, section, cell_id, value)
      SELECT $1, $2, $3, section, cell_id, value FROM jsonb_to_recordset($4::jsonb)
        AS cells(section text, cell_id text, value jsonb)
      ON CONFLICT (organization_id, workspace_id, projection, section, cell_id)
      DO UPDATE SET value = EXCLUDED.value
    `, [...params, key, JSON.stringify(batch)]);
    batch = [];
    batchBytes = 0;
  };
  const appendCell = async (cell: Cell) => {
    batchBytes += Buffer.byteLength(JSON.stringify(cell));
    batch.push(cell);
    if (batch.length >= 256 || batchBytes >= 1_000_000) await flush();
  };
  for (const section of ["nodes", "edges", "values", "redirects"] as const) {
    const old = rebuild ? undefined : previous!.state[section];
    for (const [cell_id, value] of state[section]) {
      if (old?.get(cell_id) !== value) await appendCell({ section, cell_id, value });
    }
    const deleted = old === undefined ? [] : [...old.keys()].filter((id) => !state[section].has(id));
    if (deleted.length > 0) {
      await client.query(`DELETE FROM ${tables.cells} WHERE organization_id = $1 AND workspace_id = $2 AND projection = $3 AND section = $4 AND cell_id = ANY($5::text[])`, [...params, key, section, deleted]);
    }
  }
  for (let index = rebuild ? 0 : previous!.state.diagnostics.length; index < state.diagnostics.length; index += 1) {
    await appendCell({ section: "diagnostics", cell_id: String(index), value: state.diagnostics[index] });
  }
  await flush();
  await client.query(`
    INSERT INTO ${tables.checkpoints}
      (organization_id, workspace_id, projection, cursor_t, cursor_event_id, state, configuration_digest)
    VALUES ($1, $2, $3, $4, $5, $6::jsonb, $3)
    ON CONFLICT (organization_id, workspace_id, projection) DO UPDATE SET
      cursor_t = EXCLUDED.cursor_t, cursor_event_id = EXCLUDED.cursor_event_id,
      state = EXCLUDED.state, configuration_digest = EXCLUDED.configuration_digest, updated_at = clock_timestamp()
  `, [...params, key, through?.t ?? 0, through?.eventId ?? "", JSON.stringify({
    sequence, ...(through === undefined ? {} : { through }),
    appliedEventCount: next.appliedEventCount, appliedChangeCount: next.appliedChangeCount,
  })]);
  return next;
}
