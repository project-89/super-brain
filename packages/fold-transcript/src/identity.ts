import { compareEventKeys, parseEvent, type Author, type FoldEvent } from "@_89/fold";
import { z } from "zod";
import { derivationHash } from "./derivations.js";

const id = z.string().trim().min(1).max(500);
const review = { reason: z.string().trim().min(1).max(2000), evidenceEventIds: z.array(id).max(100), active: z.boolean() };
export const identityEntityInputSchema = z.object({
  id, kind: z.enum(["person", "account", "agent", "machine"]), label: z.string().trim().min(1).max(300),
  source: z.object({ provider: id, externalId: id }).strict().optional(), ...review,
}).strict().superRefine((value, context) => {
  if (value.kind === "account" && value.source === undefined) context.addIssue({ code: "custom", message: "account identity requires source" });
  if (value.kind === "person" && value.source !== undefined) context.addIssue({ code: "custom", message: "person identity cannot be a source account" });
});
export const identityAttributionInputSchema = z.object({ entityId: id, personId: id, ...review }).strict();
export const projectAliasInputSchema = z.object({ aliasProjectId: id, canonicalProjectId: id, ...review }).strict();
export type IdentityEntityInput = z.infer<typeof identityEntityInputSchema>;
export type IdentityAttributionInput = z.infer<typeof identityAttributionInputSchema>;
export type ProjectAliasInput = z.infer<typeof projectAliasInputSchema>;
export type IdentityInput =
  | { readonly kind: "entity"; readonly input: IdentityEntityInput }
  | { readonly kind: "attribution"; readonly input: IdentityAttributionInput }
  | { readonly kind: "project-alias"; readonly input: ProjectAliasInput };
export interface IdentityMetadata { readonly eventId: string; readonly recordedAt: number; readonly actorId: string }
export type IdentityEntity = IdentityEntityInput & IdentityMetadata;
export type IdentityAttribution = IdentityAttributionInput & IdentityMetadata;
export type ProjectAlias = ProjectAliasInput & IdentityMetadata;
export type IdentityRecord = IdentityInput & IdentityMetadata & { readonly previousRevision: string | null; readonly workspaceId: string };
export interface IdentityProjection {
  readonly revision: string | null;
  readonly entities: ReadonlyMap<string, IdentityEntity>;
  readonly attributions: ReadonlyMap<string, IdentityAttribution>;
  readonly aliases: ReadonlyMap<string, ProjectAlias>;
  readonly history: readonly IdentityRecord[];
}
export const IDENTITY_NODE_KIND = "x.fold.identity-revision";
const inputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), input: identityEntityInputSchema }).strict(),
  z.object({ kind: z.literal("attribution"), input: identityAttributionInputSchema }).strict(),
  z.object({ kind: z.literal("project-alias"), input: projectAliasInputSchema }).strict(),
]);
const recordSchema = z.object({ previousRevision: id.nullable(), workspaceId: id, actorId: id, recordedAt: z.number().int().nonnegative(), operation: inputSchema }).strict();

export function identityRevisionEventId(workspaceId: string, previousRevision: string | null): string {
  return `identity:${derivationHash([workspaceId, previousRevision])}`;
}

export function identityRecordFromEvent(event: FoldEvent): IdentityRecord | undefined {
  const declared = event.kind === "identity.revised";
  const changes = event.changes.filter((change) => change.verb === "create" && change.nodeKind === IDENTITY_NODE_KIND);
  const reserved = event.id.startsWith("identity:") || event.changes.some((change) => "subject" in change && change.subject.startsWith("urn:fold:identity:"));
  if (reserved && !declared) throw new TypeError("Identity event IDs and subjects are reserved for reviewed identity records");
  if (!event.kind.startsWith("identity.") && changes.length === 0) return undefined;
  if (!declared || changes.length !== 1 || event.changes.length !== 1) throw new TypeError("Invalid identity event kind or changes");
  const change = changes[0]!;
  if (change.verb !== "create" || change.provenance?.basis !== "authored" || change.subject !== `urn:fold:${event.id}`) throw new TypeError("Invalid identity change envelope");
  const record = recordSchema.parse(change.after);
  if (event.author.kind !== "human" || event.author.id !== record.actorId || event.at.t !== record.recordedAt ||
      event.capture.scope.workspace !== record.workspaceId || event.capture.scope.space !== undefined || event.capture.scope.creator !== undefined ||
      event.capture.identity?.principal !== record.actorId || event.capture.identity?.workspace !== record.workspaceId ||
      event.id !== identityRevisionEventId(record.workspaceId, record.previousRevision)) throw new TypeError("Identity record does not match its authored workspace envelope");
  return { ...record.operation, previousRevision: record.previousRevision, workspaceId: record.workspaceId, actorId: record.actorId, recordedAt: record.recordedAt, eventId: event.id };
}

export function makeIdentityEvent(context: { readonly workspaceId: string; readonly principalId: string; readonly author: Author },
  stamp: { readonly t: number; readonly worldDate: string }, previousRevision: string | null, operation: IdentityInput): FoldEvent {
  const eventId = identityRevisionEventId(context.workspaceId, previousRevision);
  const event = parseEvent({
    specVersion: "0.7", id: eventId, kind: "identity.revised", title: `Reviewed ${operation.kind} identity`,
    at: { t: stamp.t, worldDate: stamp.worldDate, granularity: "beat" }, author: context.author,
    capture: { scope: { workspace: context.workspaceId }, identity: { principal: context.principalId, workspace: context.workspaceId } },
    changes: [{ verb: "create", subject: `urn:fold:${eventId}`, nodeKind: IDENTITY_NODE_KIND,
      after: { previousRevision, workspaceId: context.workspaceId, actorId: context.principalId, recordedAt: stamp.t, operation }, provenance: { basis: "authored" } }],
  });
  identityRecordFromEvent(event);
  return event;
}

export function canonicalProjectId(projection: Pick<IdentityProjection, "aliases">, projectId: string): string {
  const visited = new Set<string>();
  let current = projectId;
  while (projection.aliases.get(current)?.active === true) {
    if (visited.has(current)) throw new TypeError("Project alias cycle");
    visited.add(current);
    current = projection.aliases.get(current)!.canonicalProjectId;
  }
  return current;
}

export function resolveProjectIds(projection: Pick<IdentityProjection, "aliases">, requested: readonly string[]): string[] {
  const targets = new Set(requested.map((projectId) => canonicalProjectId(projection, projectId)));
  const known = new Set([...requested, ...projection.aliases.keys(), ...[...projection.aliases.values()].map((alias) => alias.canonicalProjectId)]);
  return [...known].filter((projectId) => targets.has(canonicalProjectId(projection, projectId))).sort();
}

export function rebuildIdentities(events: readonly FoldEvent[]): IdentityProjection {
  const entities = new Map<string, IdentityEntity>();
  const attributions = new Map<string, IdentityAttribution>();
  const aliases = new Map<string, ProjectAlias>();
  const history: IdentityRecord[] = [];
  let revision: string | null = null;
  let workspaceId: string | undefined;
  const identityEvents = events.filter((event) => event.kind.startsWith("identity.") || event.changes.some((change) => change.verb === "create" && change.nodeKind === IDENTITY_NODE_KIND));
  for (const event of identityEvents.sort(compareEventKeys)) {
    const record = identityRecordFromEvent(event);
    if (record === undefined) continue;
    if (record.previousRevision !== revision) throw new TypeError("Identity revision conflict");
    if (workspaceId !== undefined && workspaceId !== record.workspaceId) throw new TypeError("Identity workspace mismatch");
    workspaceId = record.workspaceId;
    const metadata = { eventId: record.eventId, actorId: record.actorId, recordedAt: record.recordedAt };
    if (record.kind === "entity") {
      const current = entities.get(record.input.id);
      if (current !== undefined && current.kind !== record.input.kind) throw new TypeError("Identity kind cannot change");
      if (record.input.active && record.input.source !== undefined) {
        const source = record.input.source;
        if ([...entities.values()].some((entity) => entity.active && entity.id !== record.input.id && entity.source?.provider === source.provider && entity.source.externalId === source.externalId)) throw new TypeError("Source account is already represented by another identity");
      }
      if (!record.input.active && [...attributions.values()].some((link) => link.active && (link.entityId === record.input.id || link.personId === record.input.id))) throw new TypeError("Revoke active attributions before deactivating an identity");
      entities.set(record.input.id, { ...record.input, ...metadata });
    } else if (record.kind === "attribution") {
      const entity = entities.get(record.input.entityId);
      const person = entities.get(record.input.personId);
      if (entity === undefined || entity.kind === "person" || person?.kind !== "person") throw new TypeError("Attribution requires a non-person identity and a person");
      if (record.input.active && (!entity.active || !person.active)) throw new TypeError("Attribution requires active identities");
      const current = attributions.get(record.input.entityId);
      if (!record.input.active && (current === undefined || current.personId !== record.input.personId)) throw new TypeError("Attribution revocation must name the current person");
      attributions.set(record.input.entityId, { ...record.input, ...metadata });
    } else {
      const input = record.input;
      if (input.aliasProjectId === input.canonicalProjectId) throw new TypeError("Project cannot alias itself");
      const current = aliases.get(input.aliasProjectId);
      if (!input.active && (current === undefined || current.canonicalProjectId !== input.canonicalProjectId)) throw new TypeError("Alias revocation must name the current target");
      aliases.set(input.aliasProjectId, { ...input, ...metadata });
      for (const projectId of aliases.keys()) canonicalProjectId({ aliases }, projectId);
    }
    history.push(record);
    revision = record.eventId;
  }
  return { revision, entities, attributions, aliases, history };
}
