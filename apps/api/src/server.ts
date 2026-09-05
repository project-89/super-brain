import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash, randomUUID } from "node:crypto";

import {
  EventOrderError,
  FoldValidationError,
  continueFold,
  eventSchema,
  fold,
  jsonValueSchema,
  serializeFoldState,
  type Author,
  type FoldEvent,
  type FoldLogEntry,
  type FoldState,
} from "@_89/fold";
import type {
  EpistemicEventContext,
  MemoryCandidateInput,
  MemoryFeedbackInput,
  MemoryInput,
  MemoryRevisionPatch,
  RecallRequest,
} from "@_89/fold-epistemic";
import {
  MEMORY_CANDIDATE_DECISION_NODE_KIND,
  MEMORY_CANDIDATE_NODE_KIND,
} from "@_89/fold-epistemic";
import {
  FoldSdkAccessError,
  FoldSdkConflictError,
  FoldSdkError,
  PersonalMemoryUnavailableError,
  TrajectoryTaskUnavailableError,
  type FoldSdkAccessContext,
  type FoldSdkCursor,
  type MemoryPageCursor,
  type RankedMemoryRecallRequest,
  type TrajectoryTaskReport,
  type FoldSdkSteeringContext,
  type FoldSdkTranscriptContext,
} from "@_89/fold-sdk";
import { JournalError } from "@_89/fold-storage";
import {
  sharedDecisionTreeSchema,
  trajectoryInputSchema,
  type TrajectoryEventContext,
  type TrajectoryInput,
} from "@_89/fold-trajectory";
import { z, ZodError } from "zod";
import {
  INTENTION_EVENT_NODE_KIND,
  type IntentionEnd,
  type SurfacedCandidate,
} from "@_89/fold-drives";
import {
  TRANSCRIPT_ARTIFACT_NODE_KIND,
  TRANSCRIPT_CHUNK_NODE_KIND,
  TRANSCRIPT_PROJECT_NODE_KIND,
  TRANSCRIPT_RUN_NODE_KIND,
  transcriptImportBundleSchema,
  transcriptSourceSchema,
} from "@_89/fold-transcript";

import type {
  ApiDependencies,
  ApiCapability,
  AuthenticatedSubject,
  TenantKey,
} from "./types.js";
import { LocalLexicalMemoryRanker } from "./recall.js";
import {
  LocalEvidenceReasoner,
  validateReasoningResult,
} from "./reasoning.js";

const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;
const DEFAULT_EVENT_STREAM_POLL_MS = 1_000;
const EVENT_STREAM_HEARTBEAT_MS = 15_000;

const stampSchema = z
  .object({
    id: z.string().min(1),
    t: z.number().finite().nonnegative(),
    worldDate: z.string().regex(/^\d{4,6}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/),
  })
  .strict();

const consumerCursorSchema = z
  .object({
    cursor: z.object({
      t: z.number().finite().nonnegative(),
      eventId: z.string().trim().min(1).max(500),
    }).strict(),
  })
  .strict();

const repositoryEnrollmentSchema = z.object({
  remote: z.string().trim().min(1).max(2_000),
  projectId: z.string().trim().min(1).max(500).optional(),
}).strict();

const identityBindingSchema = z.object({
  externalPrincipalId: z.string().trim().regex(/^(?:api-key|machine):[^/\s]+$/).max(500),
  organizationRole: z.enum(["admin", "member"]).default("member"),
  workspaceRole: z.enum(["admin", "member"]).default("member"),
}).strict();

const entitySchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.string().min(1).max(200),
    name: z.string().min(1).max(500),
  })
  .strict();

const memoryCandidateEvidenceSchema = z.object({
  eventId: z.string().trim().min(1).max(500),
  projectId: z.string().trim().min(1).max(300).optional(),
  runId: z.string().trim().min(1).max(500).optional(),
  turnId: z.string().trim().min(1).max(500).optional(),
}).strict();

const memoryInputSchema = z
  .object({
    id: z.string().min(1),
    spaceId: z.string().min(1).optional(),
    audience: z.enum(["personal", "workspace"]).optional(),
    projectIds: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
    source: z.string().min(1).max(200),
    summary: z.string().max(500).optional(),
    content: jsonValueSchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    entities: z.array(entitySchema).optional(),
    evidence: z.array(memoryCandidateEvidenceSchema).max(1_000).optional(),
  })
  .strict();

const memoryPatchSchema = z
  .object({
    summary: z.string().max(500).optional(),
    content: jsonValueSchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    evidence: z.array(memoryCandidateEvidenceSchema).max(1_000).optional(),
  })
  .strict();

const memoryCandidateInputSchema = z.object({
  id: z.string().min(1),
  spaceId: z.string().trim().min(1).max(300).optional(),
  audience: z.enum(["personal", "workspace"]).optional(),
  projectIds: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
  source: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(500),
  content: jsonValueSchema,
  tags: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  entities: z.array(entitySchema).max(100).optional(),
  evidence: z.array(memoryCandidateEvidenceSchema).min(1).max(100),
  confidence: z.number().finite().min(0).max(1),
  salience: z.number().finite().min(0).max(1),
  extractor: z.object({
    kind: z.enum(["rule", "model", "human"]),
    id: z.string().trim().min(1).max(200),
    version: z.string().trim().min(1).max(100),
  }).strict(),
}).strict();

const recallScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("all") }).strict(),
  z.object({ kind: z.literal("workspace") }).strict(),
  z.object({ kind: z.literal("space"), spaceId: z.string().min(1) }).strict(),
]);

const recallRequestSchema = z
  .object({
    scope: recallScopeSchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    sources: z.array(z.string().min(1)).optional(),
    projectIds: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
    from: z.number().finite().optional(),
    to: z.number().finite().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    candidates: z
      .array(
        z
          .object({
            memoryId: z.string().min(1),
            score: z.number().finite().min(0).max(1),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

const rankedRecallRequestSchema = recallRequestSchema
  .omit({ candidates: true })
  .extend({ query: z.string().trim().min(1).max(500) })
  .strict();

const reasoningRequestSchema = recallRequestSchema
  .omit({ candidates: true })
  .extend({
    question: z.string().trim().min(1).max(2_000),
    actorId: z.string().trim().min(1).max(300).optional(),
    providerId: z.string().trim().min(1).max(300).optional(),
    memoryIds: z.array(z.string().trim().min(1).max(300)).min(1).max(10).optional(),
    limit: z.number().int().min(1).max(10).optional(),
  })
  .strict();

const causedByField = { causedBy: z.array(z.string().min(1)).optional() };

const eventAppendSchema = z
  .object({
    event: eventSchema,
    status: z.enum(["canon", "draft"]).optional(),
  })
  .strict();

const memoryRecordSchema = z
  .object({ stamp: stampSchema, input: memoryInputSchema, ...causedByField })
  .strict();

const memoryRevisionSchema = z
  .object({ stamp: stampSchema, patch: memoryPatchSchema, ...causedByField })
  .strict();

const memoryForgetSchema = z
  .object({
    stamp: stampSchema,
    reason: z.string().min(1),
    ...causedByField,
  })
  .strict();

const memoryFeedbackSchema = z.object({
  stamp: stampSchema,
  input: z.object({
    signal: z.enum(["recalled", "helpful", "unhelpful", "superseded"]),
    query: z.string().trim().min(1).max(2_000).optional(),
    taskId: z.string().trim().min(1).max(500).optional(),
    sessionId: z.string().trim().min(1).max(500).optional(),
    detail: z.string().trim().min(1).max(2_000).optional(),
  }).strict(),
  ...causedByField,
}).strict();

const memoryCandidateProposalSchema = z.object({
  stamp: stampSchema,
  input: memoryCandidateInputSchema,
  ...causedByField,
}).strict();

const memoryCandidateImportSchema = z.object({
  audience: z.enum(["personal", "workspace"]),
  spaceId: z.string().trim().min(1).max(300).optional(),
  proposals: z.array(memoryCandidateProposalSchema).min(1).max(100),
}).strict();

const memoryCandidateAcceptSchema = z.object({
  stamp: stampSchema,
  memoryStamp: stampSchema,
  memoryId: z.string().min(1),
}).strict();

const memoryCandidatePromotionSchema = z.object({
  audience: z.enum(["personal", "workspace"]),
  spaceId: z.string().trim().min(1).max(300).optional(),
  acceptances: z.array(memoryCandidateAcceptSchema.extend({
    candidateId: z.string().min(1),
  })).min(1).max(100),
}).strict();

const memoryCandidateRejectSchema = z.object({
  stamp: stampSchema,
  reason: z.string().trim().min(1).max(500),
}).strict();

const trajectoryCaptureIdentitySchema = z.record(z.string().trim().min(1).max(2_000))
  .superRefine((identity, context) => {
    if (Object.keys(identity).length > 30) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "capture identity has too many fields" });
    }
    for (const reserved of ["principal", "workspace"]) {
      if (reserved in identity) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [reserved],
          message: `${reserved} is server-derived`,
        });
      }
    }
  });

const trajectoryTreeRecordSchema = z
  .object({
    stamp: stampSchema,
    spaceId: z.string().min(1).optional(),
    captureIdentity: trajectoryCaptureIdentitySchema.optional(),
    tree: sharedDecisionTreeSchema,
  })
  .strict();

const trajectoryRecordSchema = z
  .object({
    stamp: stampSchema,
    spaceId: z.string().min(1).optional(),
    captureIdentity: trajectoryCaptureIdentitySchema.optional(),
    input: trajectoryInputSchema,
  })
  .strict();

const satisfierSchema = z
  .object({
    kind: z.string().trim().min(1).max(200),
    ref: z.string().trim().min(1).max(500),
    params: z.record(jsonValueSchema).optional(),
  })
  .strict();

const surfacingTriggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("quiet") }).strict(),
  z.object({ kind: z.literal("threshold") }).strict(),
  z.object({ kind: z.literal("coincidence"), note: z.string().trim().min(1).max(2_000) }).strict(),
]);

const intentionEndSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("satisfied") }).strict(),
  z.object({ kind: z.literal("expired") }).strict(),
  z.object({ kind: z.literal("abandoned"), reason: z.string().trim().min(1).max(2_000) }).strict(),
  z.object({ kind: z.literal("superseded"), byIntentionId: z.string().trim().min(1).max(300) }).strict(),
]);

const steeringActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("surface"),
    stamp: stampSchema,
    candidate: z.object({
      id: z.string().trim().min(1).max(300),
      sourceDriveId: z.string().trim().min(1).max(300),
      satisfier: satisfierSchema,
      aim: z.string().trim().min(1).max(2_000),
      trigger: surfacingTriggerSchema,
    }).strict(),
    ...causedByField,
  }).strict(),
  z.object({
    action: z.literal("commit"),
    stamp: stampSchema,
    candidateId: z.string().trim().min(1).max(300),
    intentionId: z.string().trim().min(1).max(300),
    ...causedByField,
  }).strict(),
  z.object({
    action: z.literal("decline"),
    stamp: stampSchema,
    candidateId: z.string().trim().min(1).max(300),
    reason: z.string().trim().min(1).max(2_000),
    ...causedByField,
  }).strict(),
  z.object({
    action: z.literal("acted"),
    stamp: stampSchema,
    intentionId: z.string().trim().min(1).max(300),
    ...causedByField,
  }).strict(),
  z.object({
    action: z.literal("end"),
    stamp: stampSchema,
    intentionId: z.string().trim().min(1).max(300),
    end: intentionEndSchema,
    ...causedByField,
  }).strict(),
]);

export class ApiHttpError extends Error {
  override readonly name = "ApiHttpError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

function responseHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, responseHeaders());
  response.end(JSON.stringify(body));
}

function compactFoldState(state: FoldState): unknown {
  const serialized = JSON.parse(serializeFoldState({
    ...state,
    appliedEvents: [],
    appliedChanges: [],
  })) as Record<string, unknown>;
  return {
    ...serialized,
    appliedEventCount: state.appliedEvents.length,
    appliedChangeCount: state.appliedChanges.length,
  };
}

type ProjectionSection = "nodes" | "edges" | "values" | "redirects" | "diagnostics";

interface CachedProjection {
  readonly entryKeys: readonly string[];
  readonly state: FoldState;
  readonly appliedChangeCount: number;
}

const projectionCaches = new WeakMap<object, Map<string, CachedProjection>>();

function projectionAccessKey(access: FoldSdkAccessContext, include: "canon" | "canon+draft"): string {
  return JSON.stringify([
    include,
    access.principalId,
    access.organizationId ?? "",
    access.workspaceId,
    access.platformDataAccess === true,
    Object.entries(access.spaceRoles).sort(([left], [right]) => left.localeCompare(right)),
  ]);
}

function projectionEntryKey(entry: FoldLogEntry): string {
  return `${entry.status}\0${entry.event.at.t}\0${entry.event.id}`;
}

function cloneProjectionState(state: FoldState): FoldState {
  return {
    values: new Map(state.values),
    nodes: new Map(state.nodes),
    edges: new Map(state.edges),
    redirects: new Map(state.redirects),
    diagnostics: [...state.diagnostics],
    appliedEvents: [],
    appliedChanges: [],
  };
}

function isEntryPrefix(prefix: readonly string[], entries: readonly string[]): boolean {
  return prefix.length <= entries.length && prefix.every((entry, index) => entry === entries[index]);
}

async function cachedProjection(
  sdk: Awaited<ReturnType<ApiDependencies["sdks"]["sdkFor"]>>,
  access: FoldSdkAccessContext,
  include: "canon" | "canon+draft",
): Promise<CachedProjection> {
  const entries = await sdk.listEntries(access, { include });
  const entryKeys = entries.map(projectionEntryKey);
  let cache = projectionCaches.get(sdk);
  if (cache === undefined) {
    cache = new Map();
    projectionCaches.set(sdk, cache);
  }
  const key = projectionAccessKey(access, include);
  const current = cache.get(key);
  if (current !== undefined && isEntryPrefix(current.entryKeys, entryKeys)) {
    if (current.entryKeys.length === entryKeys.length) return current;
    const suffix = entries.slice(current.entryKeys.length);
    continueFold(current.state, suffix, {
      include: "canon+draft",
      existingCreate: "replace",
      retainApplied: false,
      validatedInput: true,
      orderedInput: true,
    });
    const updated = {
      entryKeys,
      state: current.state,
      appliedChangeCount: current.appliedChangeCount + suffix.reduce((total, entry) => total + entry.event.changes.length, 0),
    };
    cache.set(key, updated);
    return updated;
  }

  const alternateInclude = include === "canon" ? "canon+draft" : "canon";
  const alternate = cache.get(projectionAccessKey(access, alternateInclude));
  if (
    alternate !== undefined &&
    alternate.entryKeys.length === entryKeys.length &&
    alternate.entryKeys.every((entry, index) => entry === entryKeys[index])
  ) {
    const copied = { ...alternate, entryKeys, state: cloneProjectionState(alternate.state) };
    cache.set(key, copied);
    return copied;
  }

  const state = fold(entries, {
    include: "canon+draft",
    existingCreate: "replace",
    retainApplied: false,
    validatedInput: true,
    orderedInput: true,
  });
  const rebuilt = {
    entryKeys,
    state,
    appliedChangeCount: entries.reduce((total, entry) => total + entry.event.changes.length, 0),
  };
  cache.set(key, rebuilt);
  return rebuilt;
}

function projectionSectionRows(state: FoldState, section: ProjectionSection): readonly (readonly [string, unknown])[] {
  if (section === "nodes") return [...state.nodes.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (section === "edges") return [...state.edges.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (section === "values") return [...state.values.entries()].sort(([left], [right]) => left.localeCompare(right));
  if (section === "redirects") return [...state.redirects.entries()].sort(([left], [right]) => left.localeCompare(right));
  return state.diagnostics
    .map((diagnostic, index) => [`${diagnostic.eventId}\0${diagnostic.changeIndex}\0${index}`, diagnostic] as const)
    .sort(([left], [right]) => left.localeCompare(right));
}

function projectionSectionPage(
  state: FoldState,
  section: ProjectionSection,
  include: "canon" | "canon+draft",
  limit: number,
  cursor: PageCursor | undefined,
  query: string,
): { readonly rows: readonly (readonly [string, unknown])[]; readonly total: number; readonly nextCursor?: string } {
  const cursorKey = `${include}:${section}:${createHash("sha256").update(query).digest("hex").slice(0, 16)}`;
  if (cursor !== undefined && cursor.key !== cursorKey) {
    throw new ApiHttpError(400, "invalid_cursor", "Page cursor does not match the projection query");
  }
  const needle = query.toLocaleLowerCase();
  const filtered = projectionSectionRows(state, section).filter(([id, value]) =>
    needle.length === 0 || `${id}\n${JSON.stringify(value)}`.toLocaleLowerCase().includes(needle)
  );
  const remaining = cursor === undefined ? filtered : filtered.filter(([id]) => id > cursor.id);
  const rows = remaining.slice(0, limit);
  const last = rows.at(-1);
  return {
    rows,
    total: filtered.length,
    ...(last !== undefined && rows.length < remaining.length
      ? { nextCursor: encodePageCursor({ kind: "state", key: cursorKey, id: last[0] }) }
      : {}),
  };
}

function corsOriginSet(origins: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (origins === undefined) return undefined;
  if (origins.length === 0) throw new TypeError("corsOrigins must not be empty when configured");
  const result = new Set<string>();
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new TypeError(`Invalid CORS origin: ${origin}`);
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.origin !== origin ||
      parsed.username.length > 0 ||
      parsed.password.length > 0
    ) {
      throw new TypeError(`CORS origins must be exact HTTP(S) origins: ${origin}`);
    }
    result.add(origin);
  }
  return result;
}

function applyCorsPolicy(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: ReadonlySet<string> | undefined,
): boolean {
  if (allowedOrigins === undefined) return false;
  const origin = request.headers.origin;
  if (origin !== undefined && !allowedOrigins.has(origin)) {
    throw new ApiHttpError(403, "origin_denied", "Request origin is not allowed");
  }
  if (origin !== undefined) {
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
  }
  if (request.method !== "OPTIONS") return false;
  if (origin === undefined) {
    throw new ApiHttpError(403, "origin_required", "CORS preflight requires an Origin header");
  }
  response.writeHead(204, {
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
    "access-control-max-age": "600",
    "cache-control": "no-store",
  });
  response.end();
  return true;
}

function applyRateLimit(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ApiDependencies,
): void {
  if (dependencies.rateLimiter === undefined) return;
  const credential = request.headers.authorization ?? "anonymous";
  const fingerprint = createHash("sha256").update(credential).digest("hex").slice(0, 24);
  const decision = dependencies.rateLimiter.consume(`${request.socket.remoteAddress ?? "unknown"}:${fingerprint}`);
  response.setHeader("ratelimit-limit", decision.limit.toString());
  response.setHeader("ratelimit-remaining", decision.remaining.toString());
  response.setHeader("ratelimit-reset", Math.ceil(decision.resetAt / 1_000).toString());
  if (decision.allowed) return;
  const retryAfterSeconds = decision.retryAfterSeconds ?? 1;
  response.setHeader("retry-after", retryAfterSeconds.toString());
  throw new ApiHttpError(
    429,
    "rate_limited",
    "Request rate limit exceeded",
    { retryAfterSeconds },
  );
}

function sendError(response: ServerResponse, error: ApiHttpError): void {
  if (error.status === 401) response.setHeader("www-authenticate", "Bearer");
  sendJson(response, error.status, {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    },
  });
}

function asHttpError(error: unknown): ApiHttpError {
  if (error instanceof ApiHttpError) return error;
  if (error instanceof Error && error.name === "ClerkWebhookVerificationError") {
    return new ApiHttpError(401, "webhook_verification_failed", "Webhook signature verification failed");
  }
  if (error instanceof ZodError) {
    return new ApiHttpError(
      400,
      "invalid_request",
      "Request validation failed",
      error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  if (error instanceof PersonalMemoryUnavailableError) {
    return new ApiHttpError(404, "memory_unavailable", "Personal memory is unavailable");
  }
  if (error instanceof TrajectoryTaskUnavailableError) {
    return new ApiHttpError(404, "trajectory_task_unavailable", "Trajectory task is unavailable");
  }
  if (error instanceof FoldSdkAccessError) {
    return new ApiHttpError(403, "access_denied", "Capture scope access denied");
  }
  if (error instanceof FoldSdkConflictError) {
    return new ApiHttpError(409, "fold_conflict", error.message);
  }
  if (error instanceof Error && error.name === "PostgresFoldConflictError") {
    return new ApiHttpError(409, "fold_conflict", error.message);
  }
  if (error instanceof Error && error.name === "RepositoryEnrollmentConflictError") {
    return new ApiHttpError(409, "repository_enrollment_conflict", error.message);
  }
  if (error instanceof Error && error.name === "TenantTargetUnavailableError") {
    return new ApiHttpError(404, "tenant_unavailable", "Organization workspace is unavailable");
  }
  if (error instanceof EventOrderError || error instanceof FoldValidationError) {
    return new ApiHttpError(409, "fold_conflict", error.message);
  }
  if (error instanceof JournalError) {
    return new ApiHttpError(500, "storage_error", "Fold storage operation failed");
  }
  if (
    error instanceof FoldSdkError ||
    error instanceof TypeError ||
    (error instanceof Error && [
      "EpistemicAccessError",
      "MemoryEventError",
      "MemoryCandidateError",
      "ProjectionValidationError",
      "TraceValidationError",
      "TrajectoryEventError",
      "TrajectoryProjectionError",
      "ActivityEventError",
      "FleetProjectionError",
      "TranscriptEventError",
      "TranscriptProjectionError",
    ].includes(error.name))
  ) {
    return new ApiHttpError(400, "invalid_request", error.message);
  }
  return new ApiHttpError(500, "internal_error", "Internal server error");
}

async function readRawBody(request: IncomingMessage, maxBodyBytes: number): Promise<Buffer> {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    throw new ApiHttpError(413, "body_too_large", "Request body exceeds the configured limit");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBodyBytes) {
      request.resume();
      throw new ApiHttpError(413, "body_too_large", "Request body exceeds the configured limit");
    }
    chunks.push(bytes);
  }
  if (size === 0) throw new ApiHttpError(400, "empty_body", "Request body must not be empty");
  return Buffer.concat(chunks);
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiHttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
  const body = await readRawBody(request, maxBodyBytes);
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ApiHttpError(400, "invalid_json", "Request body is not valid JSON");
  }
}

function bearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  const match = header?.match(/^Bearer ([^\s]+)$/);
  if (match === null || match === undefined) {
    throw new ApiHttpError(401, "unauthorized", "A valid bearer token is required");
  }
  return match[1]!;
}

function sameAuthor(left: Author, right: Author): boolean {
  return (
    left.kind === right.kind &&
    left.id === right.id &&
    left.productionId === right.productionId
  );
}

function assertAuthenticatedAuthor(event: FoldEvent, subject: AuthenticatedSubject): void {
  if (!sameAuthor(event.author, subject.author)) {
    throw new ApiHttpError(403, "author_mismatch", "Event author is not authorized by this credential");
  }
}

function assertGenericAppendRoute(event: FoldEvent): void {
  const transcriptNodeKinds = new Set([
    TRANSCRIPT_PROJECT_NODE_KIND,
    TRANSCRIPT_ARTIFACT_NODE_KIND,
    TRANSCRIPT_RUN_NODE_KIND,
    TRANSCRIPT_CHUNK_NODE_KIND,
  ]);
  if (
    event.kind.startsWith("intention.") ||
    event.kind.startsWith("transcript.") ||
    event.kind.startsWith("memory.candidate-") ||
    event.changes.some(
      (change) => "nodeKind" in change &&
        (change.nodeKind === INTENTION_EVENT_NODE_KIND ||
          change.nodeKind === MEMORY_CANDIDATE_NODE_KIND ||
          change.nodeKind === MEMORY_CANDIDATE_DECISION_NODE_KIND ||
          transcriptNodeKinds.has(change.nodeKind)),
    )
  ) {
    throw new ApiHttpError(
      400,
      "reserved_event_route",
      "Reserved events must use their dedicated route",
    );
  }
}

function decodeSegment(value: string, label: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiHttpError(400, "invalid_path", `${label} is not valid URL encoding`);
  }
  if (decoded.trim().length === 0) {
    throw new ApiHttpError(400, "invalid_path", `${label} must not be empty`);
  }
  return decoded;
}

function cursorFromUrl(url: URL): FoldSdkCursor | undefined {
  const rawT = url.searchParams.get("cursorT");
  const eventId = url.searchParams.get("cursorEventId");
  if (rawT === null && eventId === null) return undefined;
  if (rawT === null || eventId === null) {
    throw new ApiHttpError(
      400,
      "invalid_cursor",
      "cursorT and cursorEventId must be provided together",
    );
  }
  const t = Number(rawT);
  if (!Number.isFinite(t) || eventId.trim().length === 0) {
    throw new ApiHttpError(400, "invalid_cursor", "Cursor values are invalid");
  }
  return { t, eventId };
}

type PageCursorKind = "memory" | "candidate" | "run" | "trajectory" | "trajectory-run" | "event" | "state";

interface PageCursor {
  readonly kind: PageCursorKind;
  readonly key: string | number;
  readonly id: string;
}

const pageCursorSchema = z.object({
  kind: z.enum(["memory", "candidate", "run", "trajectory", "trajectory-run", "event", "state"]),
  key: z.union([z.string(), z.number().finite()]),
  id: z.string().trim().min(1).max(10_000),
}).strict();

function encodePageCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function pageCursorFromUrl(url: URL, expectedKind: PageCursorKind): PageCursor | undefined {
  const raw = url.searchParams.get("pageCursor");
  if (raw === null) return undefined;
  try {
    const cursor = pageCursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (cursor.kind !== expectedKind) throw new Error("cursor kind mismatch");
    return cursor;
  } catch {
    throw new ApiHttpError(400, "invalid_cursor", "Page cursor is invalid");
  }
}

function pagedNewestFirst<T>(
  items: readonly T[],
  kind: PageCursorKind,
  limit: number | undefined,
  cursor: PageCursor | undefined,
  keyOf: (item: T) => string | number,
  idOf: (item: T) => string,
): { readonly items: readonly T[]; readonly total: number; readonly nextCursor?: string } {
  const remaining = cursor === undefined
    ? items
    : items.filter((item) => {
      const key = keyOf(item);
      if (typeof key !== typeof cursor.key) return false;
      return key < cursor.key || (key === cursor.key && idOf(item) > cursor.id);
    });
  const page = limit === undefined ? remaining : remaining.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page,
    total: items.length,
    ...(last !== undefined && page.length < remaining.length
      ? { nextCursor: encodePageCursor({ kind, key: keyOf(last), id: idOf(last) }) }
      : {}),
  };
}

function includeFromUrl(url: URL): "canon" | "canon+draft" | undefined {
  const include = url.searchParams.get("include");
  if (include === null) return undefined;
  if (include !== "canon" && include !== "canon+draft") {
    throw new ApiHttpError(400, "invalid_include", "include must be canon or canon+draft");
  }
  return include;
}

function finiteQueryNumber(url: URL, key: string): number | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new ApiHttpError(400, "invalid_query", `${key} must be finite`);
  }
  return value;
}

function positiveIntegerQuery(url: URL, key: string, maximum: number): number | undefined {
  const value = finiteQueryNumber(url, key);
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new ApiHttpError(400, "invalid_query", `${key} must be an integer within [1, ${maximum}]`);
  }
  return value;
}

function afterCursorFromUrl(url: URL): FoldSdkCursor | undefined {
  const rawT = url.searchParams.get("afterT");
  const eventId = url.searchParams.get("afterEventId");
  if (rawT === null && eventId === null) return undefined;
  if (rawT === null || eventId === null) {
    throw new ApiHttpError(
      400,
      "invalid_cursor",
      "afterT and afterEventId must be provided together",
    );
  }
  const t = Number(rawT);
  if (!Number.isFinite(t) || t < 0 || eventId.trim().length === 0) {
    throw new ApiHttpError(400, "invalid_cursor", "Event stream cursor is invalid");
  }
  return { t, eventId };
}

function replayFromUrl(url: URL): "tail" | "all" {
  const replay = url.searchParams.get("replay") ?? "tail";
  if (replay !== "tail" && replay !== "all") {
    throw new ApiHttpError(400, "invalid_replay", "replay must be tail or all");
  }
  return replay;
}

function isAfterCursor(entry: FoldLogEntry, cursor: FoldSdkCursor): boolean {
  return entry.event.at.t > cursor.t ||
    (entry.event.at.t === cursor.t && entry.event.id > cursor.eventId);
}

async function streamBatch(
  dependencies: ApiDependencies,
  sdk: Awaited<ReturnType<ApiDependencies["sdks"]["sdkFor"]>>,
  tenant: TenantKey,
  access: FoldSdkAccessContext,
  options: {
    readonly after?: FoldSdkCursor;
    readonly includeDrafts?: boolean;
    readonly kinds?: readonly string[];
    readonly limit: number;
  },
): Promise<{ readonly entries: readonly FoldLogEntry[]; readonly scannedThrough?: FoldSdkCursor }> {
  if (dependencies.sdks.streamEntries !== undefined) {
    return dependencies.sdks.streamEntries(tenant, access, options);
  }
  const entries = await sdk.listEntries(access, {
    ...(options.includeDrafts ? { include: "canon+draft" as const } : {}),
    ...(options.kinds === undefined ? {} : { kinds: options.kinds }),
  });
  const page = (options.after === undefined
    ? entries
    : entries.filter((entry) => isAfterCursor(entry, options.after!)))
    .slice(0, options.limit);
  const last = page.at(-1);
  return {
    entries: page,
    ...(last === undefined ? {} : { scannedThrough: { t: last.event.at.t, eventId: last.event.id } }),
  };
}

function startEventStream(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ApiDependencies,
  sdk: Awaited<ReturnType<ApiDependencies["sdks"]["sdkFor"]>>,
  tenant: TenantKey,
  access: FoldSdkAccessContext,
  initialCursor: FoldSdkCursor | undefined,
  includeDrafts: boolean,
  kinds: readonly string[] | undefined,
): void {
  response.writeHead(200, {
    "cache-control": "no-store, no-transform",
    "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  });
  response.write(": connected\n\n");

  let cursor = initialCursor;
  let closed = false;
  let polling = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer);
    clearInterval(heartbeatTimer);
  };
  const fail = (error: unknown) => {
    dependencies.reportError?.(error);
    if (!closed) {
      response.write(`event: stream-error\ndata: ${JSON.stringify({ code: "stream_failed" })}\n\n`);
      response.end();
    }
    close();
  };
  const poll = async () => {
    if (closed || polling) return;
    polling = true;
    try {
      const batch = await streamBatch(dependencies, sdk, tenant, access, {
        ...(cursor === undefined ? {} : { after: cursor }),
        ...(includeDrafts ? { includeDrafts: true } : {}),
        ...(kinds === undefined ? {} : { kinds }),
        limit: 500,
      });
      for (const entry of batch.entries) {
        const next = { t: entry.event.at.t, eventId: entry.event.id };
        response.write(`event: fold-event\ndata: ${JSON.stringify({ entry, cursor: next })}\n\n`);
      }
      if (batch.scannedThrough !== undefined) cursor = batch.scannedThrough;
    } catch (error) {
      fail(error);
    } finally {
      polling = false;
    }
  };
  const pollTimer = setInterval(() => void poll(), dependencies.eventStreamPollMs ?? DEFAULT_EVENT_STREAM_POLL_MS);
  const heartbeatTimer = setInterval(() => {
    if (!closed) response.write(`: heartbeat ${Date.now()}\n\n`);
  }, EVENT_STREAM_HEARTBEAT_MS);
  pollTimer.unref();
  heartbeatTimer.unref();
  request.once("close", close);
  response.once("close", close);
  void poll();
}

function parsedRecallRequest(input: unknown): RecallRequest {
  const parsed = recallRequestSchema.parse(input);
  return {
    ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
    ...(parsed.tags === undefined ? {} : { tags: parsed.tags }),
    ...(parsed.sources === undefined ? {} : { sources: parsed.sources }),
    ...(parsed.projectIds === undefined ? {} : { projectIds: parsed.projectIds }),
    ...(parsed.from === undefined ? {} : { from: parsed.from }),
    ...(parsed.to === undefined ? {} : { to: parsed.to }),
    ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    ...(parsed.candidates === undefined ? {} : { candidates: parsed.candidates }),
  };
}

function parsedRankedRecallRequest(input: unknown): RankedMemoryRecallRequest {
  return rankedRecallRequestSchema.parse(input) as RankedMemoryRecallRequest;
}

function parsedMemoryEvidence(input: z.infer<typeof memoryCandidateEvidenceSchema>) {
  return {
    eventId: input.eventId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
  };
}

function parsedMemoryInput(input: z.infer<typeof memoryInputSchema>): MemoryInput {
  return {
    id: input.id,
    source: input.source,
    ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
    ...(input.audience === undefined ? {} : { audience: input.audience }),
    ...(input.projectIds === undefined ? {} : { projectIds: input.projectIds }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    ...(input.entities === undefined ? {} : { entities: input.entities }),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence.map(parsedMemoryEvidence) }),
  };
}

function parsedMemoryCandidateInput(input: z.infer<typeof memoryCandidateInputSchema>): MemoryCandidateInput {
  return input as MemoryCandidateInput;
}

function parsedMemoryPatch(input: z.infer<typeof memoryPatchSchema>): MemoryRevisionPatch {
  return {
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence.map(parsedMemoryEvidence) }),
  };
}

function parsedTrajectoryInput(input: unknown): TrajectoryInput {
  return trajectoryInputSchema.parse(input) as unknown as TrajectoryInput;
}

function recallFromUrl(url: URL): RecallRequest {
  const scopeKind = url.searchParams.get("scope");
  const spaceId = url.searchParams.get("spaceId");
  let scope: RecallRequest["scope"];
  if (scopeKind !== null) {
    if (scopeKind === "all" || scopeKind === "workspace") scope = { kind: scopeKind };
    else if (scopeKind === "space" && spaceId !== null && spaceId.trim().length > 0) {
      scope = { kind: "space", spaceId };
    } else {
      throw new ApiHttpError(400, "invalid_scope", "scope must be all, workspace, or a named space");
    }
  } else if (spaceId !== null) {
    throw new ApiHttpError(400, "invalid_scope", "spaceId requires scope=space");
  }
  const limit = finiteQueryNumber(url, "limit");
  return parsedRecallRequest({
    ...(scope === undefined ? {} : { scope }),
    ...(url.searchParams.has("tag") ? { tags: url.searchParams.getAll("tag") } : {}),
    ...(url.searchParams.has("source") ? { sources: url.searchParams.getAll("source") } : {}),
    ...(url.searchParams.has("projectId") ? { projectIds: url.searchParams.getAll("projectId") } : {}),
    ...(finiteQueryNumber(url, "from") === undefined ? {} : { from: finiteQueryNumber(url, "from") }),
    ...(finiteQueryNumber(url, "to") === undefined ? {} : { to: finiteQueryNumber(url, "to") }),
    ...(limit === undefined ? {} : { limit }),
  });
}

function memoryContext(
  subject: AuthenticatedSubject,
  access: FoldSdkAccessContext,
  spaceId: string | undefined,
  audience: "personal" | "workspace" = "personal",
): EpistemicEventContext {
  return {
    access,
    author: subject.author,
    capture: {
      scope: {
        workspace: access.workspaceId,
        ...(spaceId === undefined ? {} : { space: spaceId }),
        ...(audience === "personal" ? { creator: access.principalId } : {}),
      },
      identity: { principal: access.principalId, workspace: access.workspaceId },
    },
  };
}

function trajectoryContext(
  subject: AuthenticatedSubject,
  access: FoldSdkAccessContext,
  spaceId: string | undefined,
  identity: Readonly<Record<string, string>> = {},
): TrajectoryEventContext {
  return {
    access,
    author: subject.author,
    capture: {
      scope: {
        workspace: access.workspaceId,
        ...(spaceId === undefined ? {} : { space: spaceId }),
      },
      identity: { ...identity, principal: access.principalId, workspace: access.workspaceId },
    },
  };
}

function transcriptContext(
  subject: AuthenticatedSubject,
  access: FoldSdkAccessContext,
  bundle: z.infer<typeof transcriptImportBundleSchema>,
): FoldSdkTranscriptContext {
  return {
    access,
    author: { kind: "ingest", id: `transcript-importer:${subject.principalId}` },
    capture: {
      scope: { workspace: access.workspaceId },
      identity: {
        principal: access.principalId,
        workspace: access.workspaceId,
        source: bundle.run.source,
        run: bundle.run.id,
        session: bundle.run.nativeId,
        ...(bundle.run.projectId === undefined ? {} : { project: bundle.run.projectId }),
      },
    },
  };
}

function canSteer(access: FoldSdkAccessContext): boolean {
  return access.workspaceRole === "owner" || access.workspaceRole === "admin";
}

function steeringContext(
  subject: AuthenticatedSubject,
  access: FoldSdkAccessContext,
  actorId: string,
): FoldSdkSteeringContext {
  return {
    access,
    actorId,
    author: subject.author,
    capture: {
      scope: { workspace: access.workspaceId },
      identity: { actor: actorId },
    },
  };
}

function serializeTrajectoryReport(report: TrajectoryTaskReport) {
  return {
    ...report,
    analysis: {
      ...report.analysis,
      edgeOutcomes: [...report.analysis.edgeOutcomes.values()],
    },
  };
}

async function authenticate(
  request: IncomingMessage,
  dependencies: ApiDependencies,
): Promise<AuthenticatedSubject> {
  const subject = await dependencies.authenticator.authenticate(bearerToken(request));
  if (subject === undefined) {
    throw new ApiHttpError(401, "unauthorized", "A valid bearer token is required");
  }
  return subject;
}

function routeCapability(resource: string | undefined, resourceId: string | undefined, method: string): ApiCapability | undefined {
  if (resource === "repository-enrollments" || resource === "audit-log" || resource === "identity-bindings" || resource === "identity-audit-log") return "organization:admin";
  if (resource === "event-stream" || resource === "projection") return "events:read";
  if (resource === "events") return method === "GET" ? "events:read" : "events:write";
  if (resource === "consumers") return method === "GET" ? "consumers:read" : "consumers:write";
  if (resource === "trajectory-tasks") return method === "GET" ? "trajectories:read" : "trajectories:write";
  if (resource === "trajectories") return "trajectories:write";
  if (resource === "fleet") return "fleet:read";
  if (resource === "transcript-projects" || resource === "transcript-runs") return "transcripts:read";
  if (resource === "transcript-imports") return "transcripts:write";
  if (resource === "steering") return method === "GET" ? "steering:read" : "steering:write";
  if (resource === "reasoning") return "reasoning:read";
  if (resource === "memories" && (resourceId === "recall" || resourceId === "search")) return "memories:read";
  if (resource === "memories" || resource?.startsWith("memory-candidate") === true) {
    return method === "GET" ? "memories:read" : "memories:write";
  }
  return undefined;
}

function assertCredentialCapability(subject: AuthenticatedSubject, capability: ApiCapability | undefined): void {
  if (capability === undefined || subject.capabilities === undefined || subject.capabilities.includes(capability)) return;
  throw new ApiHttpError(403, "credential_scope_denied", `Credential lacks ${capability}`);
}

function normalizedRepositoryRemote(input: string): string {
  const candidate = input.trim();
  if (candidate.startsWith("urn:repo:")) return candidate;
  const urlInput = /^git@[^:]+:.+/.test(candidate)
    ? `ssh://${candidate.replace(":", "/")}`
    : candidate;
  let url: URL;
  try {
    url = new URL(urlInput);
  } catch {
    throw new ApiHttpError(400, "invalid_repository_remote", "Repository remote must be an absolute URL or SCP-style Git remote");
  }
  if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol) || url.hostname.length === 0) {
    throw new ApiHttpError(400, "invalid_repository_remote", "Repository remote protocol is unsupported");
  }
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\.git$/i, "");
  if (pathname.length < 2) throw new ApiHttpError(400, "invalid_repository_remote", "Repository remote has no repository path");
  return `${url.hostname.toLowerCase()}${pathname}`;
}

function platformAccessGrant(request: IncomingMessage): { readonly reason: string; readonly expiresAt: string } {
  const reasonHeader = request.headers["x-super-brain-access-reason"];
  const expiryHeader = request.headers["x-super-brain-access-expires-at"];
  const reason = (Array.isArray(reasonHeader) ? reasonHeader[0] : reasonHeader)?.trim() ?? "";
  const expiresAt = (Array.isArray(expiryHeader) ? expiryHeader[0] : expiryHeader)?.trim() ?? "";
  if (reason.length < 10 || reason.length > 500) {
    throw new ApiHttpError(403, "platform_access_reason_required", "Platform data access requires a 10 to 500 character reason");
  }
  const expiry = Date.parse(expiresAt);
  const now = Date.now();
  if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 15 * 60_000) {
    throw new ApiHttpError(403, "platform_access_expiry_invalid", "Platform data access expiry must be within the next 15 minutes");
  }
  return { reason, expiresAt: new Date(expiry).toISOString() };
}

const PLATFORM_READABLE_RESOURCES = new Set([
  "events",
  "projection",
  "memories",
  "trajectory-tasks",
  "fleet",
  "transcript-projects",
  "transcript-runs",
  "steering",
]);

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ApiDependencies,
  allowedOrigins: ReadonlySet<string> | undefined,
): Promise<void> {
  const method = request.method ?? "";
  const url = new URL(request.url ?? "/", "http://localhost");
  if (applyCorsPolicy(request, response, allowedOrigins)) return;
  if (url.pathname === "/health") {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    sendJson(response, 200, { status: "ok" });
    return;
  }
  applyRateLimit(request, response, dependencies);

  const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
  if (segments[0] !== "v1") {
    throw new ApiHttpError(404, "not_found", "Route not found");
  }
  const maxBodyBytes = dependencies.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (segments.length === 3 && segments[1] === "webhooks" && segments[2] === "clerk") {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    if (dependencies.identityProvisioningWebhook === undefined) {
      throw new ApiHttpError(404, "not_found", "Route not found");
    }
    const result = await dependencies.identityProvisioningWebhook.handle({
      url: `http://${request.headers.host ?? "localhost"}${url.pathname}`,
      headers: request.headers,
      body: await readRawBody(request, maxBodyBytes),
    });
    sendJson(response, result.applied ? 200 : 202, result);
    return;
  }
  const subject = await authenticate(request, dependencies);
  if (segments.length === 2 && segments[1] === "session") {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const organizationId = subject.organizationId;
    if (organizationId === undefined) {
      throw new ApiHttpError(404, "session_tenant_unavailable", "Authenticated session has no active organization");
    }
    const discovered = await dependencies.tenantAdministration?.listPrincipalMemberships?.(
      organizationId,
      subject.principalId,
    ) ?? [];
    const memberships = (await Promise.all(discovered.map((membership) =>
      dependencies.memberships.resolveAccess(subject, organizationId, membership.workspaceId)
    ))).filter((membership): membership is NonNullable<typeof membership> => membership !== undefined);
    sendJson(response, 200, {
      principalId: subject.principalId,
      identityProvider: subject.identityProvider ?? "static",
      organizationId,
      memberships: memberships.map((membership) => ({
        organizationId: membership.organizationId,
        organizationRole: membership.organizationRole,
        workspaceId: membership.workspaceId,
        workspaceRole: membership.workspaceRole,
      })),
    });
    return;
  }
  let workspaceId: string;
  let organizationId: string | undefined;
  let access: Awaited<ReturnType<ApiDependencies["memberships"]["resolveAccess"]>>;
  let resourceSegments: readonly string[];
  if (segments.length >= 5 && segments[1] === "organizations" && segments[3] === "workspaces") {
    organizationId = decodeSegment(segments[2]!, "organizationId");
    workspaceId = decodeSegment(segments[4]!, "workspaceId");
    access = await dependencies.memberships.resolveAccess(subject, organizationId, workspaceId);
    resourceSegments = segments.slice(5);
  } else if (segments.length >= 3 && segments[1] === "workspaces") {
    workspaceId = decodeSegment(segments[2]!, "workspaceId");
    access = await dependencies.memberships.resolveLegacyAccess(subject, workspaceId);
    resourceSegments = segments.slice(3);
  } else {
    throw new ApiHttpError(404, "not_found", "Route not found");
  }
  const resource = resourceSegments[0];
  const resourceId = resourceSegments[1] === undefined
    ? undefined
    : decodeSegment(resourceSegments[1], "resourceId");
  if (
    access === undefined &&
    organizationId !== undefined &&
    method === "GET" &&
    resource !== undefined &&
    PLATFORM_READABLE_RESOURCES.has(resource) &&
    subject.capabilities?.includes("platform:data-read") === true
  ) {
    if (dependencies.tenantAdministration === undefined) {
      throw new ApiHttpError(503, "platform_audit_unavailable", "Audited platform access is unavailable");
    }
    const grant = platformAccessGrant(request);
    await dependencies.tenantAdministration.recordPlatformAccess({
      organizationId,
      workspaceId,
      principalId: subject.principalId,
      credentialId: subject.credentialId,
      reason: grant.reason,
      expiresAt: grant.expiresAt,
    });
    access = {
      principalId: subject.principalId,
      organizationId,
      organizationRole: "member",
      workspaceId,
      workspaceRole: "owner",
      spaceRoles: {},
      platformDataAccess: true,
    };
  }
  if (access === undefined) {
    throw new ApiHttpError(403, "workspace_access_denied", "Workspace access denied");
  }
  const tenant = { organizationId: access.organizationId, workspaceId };
  const sdk = await dependencies.sdks.sdkFor(tenant);
  if (access.platformDataAccess !== true) {
    assertCredentialCapability(subject, routeCapability(resource, resourceId, method));
  }
  if (resource === "identity-bindings") {
    if (access.organizationRole !== "owner" && access.organizationRole !== "admin") {
      throw new ApiHttpError(403, "organization_admin_required", "Organization administration access is required");
    }
    const administration = dependencies.tenantAdministration;
    const provision = administration?.applyExternalIdentityProvisioningEvent;
    if (provision === undefined) {
      throw new ApiHttpError(501, "identity_provisioning_unavailable", "Identity provisioning requires PostgreSQL");
    }
    if (resourceId === undefined && method === "POST") {
      const body = identityBindingSchema.parse(await readJsonBody(request, maxBodyBytes));
      const principalId = `clerk:${body.externalPrincipalId}`;
      const applied = await provision.call(administration, {
        eventId: `admin:${randomUUID()}`,
        provider: "clerk",
        type: "credential.upsert",
        externalOrganizationId: `internal:${access.organizationId}`,
        organizationId: access.organizationId,
        externalPrincipalId: body.externalPrincipalId,
        principalId,
        organizationRole: body.organizationRole,
        workspaceId,
        workspaceRole: body.workspaceRole,
      });
      sendJson(response, 201, { applied, principalId });
      return;
    }
    if (resourceId !== undefined && method === "DELETE") {
      if (!/^(?:api-key|machine):[^/\s]+$/.test(resourceId)) {
        throw new ApiHttpError(400, "invalid_external_principal", "External principal must be a Clerk API key or machine ID");
      }
      const applied = await provision.call(administration, {
        eventId: `admin:${randomUUID()}`,
        provider: "clerk",
        type: "credential.delete",
        externalOrganizationId: `internal:${access.organizationId}`,
        organizationId: access.organizationId,
        externalPrincipalId: resourceId,
        workspaceId,
      });
      sendJson(response, 200, { applied });
      return;
    }
    throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
  }
  if (resource === "identity-audit-log" && resourceId === undefined) {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    if (access.organizationRole !== "owner" && access.organizationRole !== "admin") {
      throw new ApiHttpError(403, "organization_admin_required", "Organization administration access is required");
    }
    const listAudit = dependencies.tenantAdministration?.listIdentityProvisioningAudit;
    if (listAudit === undefined) {
      throw new ApiHttpError(501, "identity_provisioning_unavailable", "Identity provisioning requires PostgreSQL");
    }
    sendJson(response, 200, {
      records: await listAudit.call(dependencies.tenantAdministration, access.organizationId),
    });
    return;
  }
  if (resource === "repository-enrollments" && resourceId === undefined) {
    if (access.organizationRole !== "owner" && access.organizationRole !== "admin") {
      throw new ApiHttpError(403, "organization_admin_required", "Organization administration access is required");
    }
    const administration = dependencies.tenantAdministration;
    if (administration === undefined) {
      throw new ApiHttpError(501, "tenant_administration_unavailable", "Tenant administration requires PostgreSQL");
    }
    if (method === "GET") {
      sendJson(response, 200, {
        enrollments: await administration.listRepositoryEnrollments(access.organizationId, workspaceId),
      });
      return;
    }
    if (method === "POST") {
      const body = repositoryEnrollmentSchema.parse(await readJsonBody(request, maxBodyBytes));
      const enrollment = await administration.enrollRepository({
        organizationId: access.organizationId,
        workspaceId,
        normalizedRemote: normalizedRepositoryRemote(body.remote),
        ...(body.projectId === undefined ? {} : { projectId: body.projectId }),
        enrolledBy: subject.principalId,
      });
      sendJson(response, 201, { enrollment });
      return;
    }
    throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
  }

  if (resource === "audit-log" && resourceId === undefined) {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    if (access.organizationRole !== "owner" && access.organizationRole !== "admin") {
      throw new ApiHttpError(403, "organization_admin_required", "Organization administration access is required");
    }
    if (dependencies.tenantAdministration === undefined) {
      throw new ApiHttpError(501, "tenant_administration_unavailable", "Tenant administration requires PostgreSQL");
    }
    sendJson(response, 200, {
      records: await dependencies.tenantAdministration.listPlatformAccessAudit(access.organizationId, workspaceId),
    });
    return;
  }

  if (resource === "event-stream" && resourceId === undefined) {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const include = includeFromUrl(url);
    const includeDrafts = include === "canon+draft";
    const kinds = url.searchParams.has("kind") ? url.searchParams.getAll("kind") : undefined;
    let after = afterCursorFromUrl(url);
    if (after === undefined && replayFromUrl(url) === "tail") {
      if (dependencies.sdks.latestEventCursor !== undefined) {
        after = await dependencies.sdks.latestEventCursor(tenant, access, {
          ...(includeDrafts ? { includeDrafts: true } : {}),
          ...(kinds === undefined ? {} : { kinds }),
        });
      } else {
        const entries = await sdk.listEntries(access, {
          ...(includeDrafts ? { include: "canon+draft" } : {}),
          ...(kinds === undefined ? {} : { kinds }),
        });
        const last = entries.at(-1);
        if (last !== undefined) after = { t: last.event.at.t, eventId: last.event.id };
      }
    }
    startEventStream(
      request,
      response,
      dependencies,
      sdk,
      tenant,
      access,
      after,
      includeDrafts,
      kinds,
    );
    return;
  }

  if (resource === "consumers" && resourceId !== undefined) {
    if (resourceId.length > 200) {
      throw new ApiHttpError(400, "invalid_consumer", "consumerId must be at most 200 characters");
    }
    if (
      dependencies.sdks.consumerCursor === undefined ||
      dependencies.sdks.commitConsumerCursor === undefined
    ) {
      throw new ApiHttpError(
        501,
        "durable_consumers_unavailable",
        "The configured Fold store does not persist consumer cursors",
      );
    }
    const scopedConsumerId = JSON.stringify([subject.principalId, resourceId]);
    if (method === "GET") {
      const cursor = await dependencies.sdks.consumerCursor(tenant, scopedConsumerId);
      sendJson(response, 200, { consumerId: resourceId, cursor: cursor ?? null });
      return;
    }
    if (method === "POST") {
      const body = consumerCursorSchema.parse(await readJsonBody(request, maxBodyBytes));
      await dependencies.sdks.commitConsumerCursor(tenant, scopedConsumerId, body.cursor);
      sendJson(response, 200, { consumerId: resourceId, cursor: body.cursor });
      return;
    }
    throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
  }

  if (resource === "events" && resourceId === undefined) {
    if (method === "GET") {
      const include = includeFromUrl(url);
      const cursor = cursorFromUrl(url);
      const limit = positiveIntegerQuery(url, "limit", 1_000);
      const order = url.searchParams.get("order") ?? "asc";
      if (order !== "asc" && order !== "desc") {
        throw new ApiHttpError(400, "invalid_query", "order must be asc or desc");
      }
      const pageCursor = pageCursorFromUrl(url, "event");
      if (pageCursor !== undefined && order !== "desc") {
        throw new ApiHttpError(400, "invalid_cursor", "Page cursor requires order=desc");
      }
      let entries = await sdk.listEntries(access, {
        ...(include === undefined ? {} : { include }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(url.searchParams.has("kind") ? { kinds: url.searchParams.getAll("kind") } : {}),
      });
      const identityFilters = {
        sessionId: "session",
        runId: "run",
        projectId: "project",
        actorId: "agent",
      } as const;
      for (const [queryKey, identityKey] of Object.entries(identityFilters)) {
        const value = url.searchParams.get(queryKey);
        if (value !== null) entries = entries.filter(({ event }) => event.capture.identity?.[identityKey] === value);
      }
      if (order === "desc") {
        const ordered = [...entries].sort((left, right) =>
          right.event.at.t - left.event.at.t || left.event.id.localeCompare(right.event.id)
        );
        const page = pagedNewestFirst(
          ordered,
          "event",
          limit,
          pageCursor,
          ({ event }) => event.at.t,
          ({ event }) => event.id,
        );
        sendJson(response, 200, {
          entries: page.items,
          total: page.total,
          ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        });
        return;
      }
      sendJson(response, 200, {
        entries: limit === undefined ? entries : entries.slice(-limit),
        total: entries.length,
      });
      return;
    }
    if (method === "POST") {
      const body = eventAppendSchema.parse(await readJsonBody(request, maxBodyBytes));
      assertAuthenticatedAuthor(body.event, subject);
      assertGenericAppendRoute(body.event);
      const entry = await sdk.append(access, body.event, body.status ?? "canon");
      sendJson(response, 201, { entry });
      return;
    }
    throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
  }

  if (resource === "projection" && resourceId === undefined) {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const include = includeFromUrl(url);
    const cursor = cursorFromUrl(url);
    const limit = positiveIntegerQuery(url, "limit", 1_000);
    const compact = url.searchParams.get("compact") === "true";
    const rawSection = url.searchParams.get("section");
    const section = rawSection === null ? undefined : z.enum(["nodes", "edges", "values", "redirects", "diagnostics"]).parse(rawSection);
    if (section !== undefined) {
      if (cursor !== undefined) throw new ApiHttpError(400, "invalid_cursor", "Event cursor cannot be combined with a projection section");
      const pageLimit = limit ?? 100;
      if (pageLimit > 200) throw new ApiHttpError(400, "invalid_request", "Projection section limit must be within [1, 200]");
      const projectionInclude = include ?? "canon";
      const cached = await cachedProjection(sdk, access, projectionInclude);
      const page = projectionSectionPage(
        cached.state,
        section,
        projectionInclude,
        pageLimit,
        pageCursorFromUrl(url, "state"),
        (url.searchParams.get("query") ?? "").trim(),
      );
      const emptyState = {
        values: [], nodes: [], edges: [], redirects: [], diagnostics: [],
        appliedEvents: [], appliedChanges: [],
        appliedEventCount: cached.entryKeys.length,
        appliedChangeCount: cached.appliedChangeCount,
      };
      sendJson(response, 200, {
        entries: [],
        total: cached.entryKeys.length,
        projected: cached.entryKeys.length,
        section,
        sectionTotal: page.total,
        counts: {
          nodes: cached.state.nodes.size,
          edges: cached.state.edges.size,
          values: cached.state.values.size,
          redirects: cached.state.redirects.size,
          diagnostics: cached.state.diagnostics.length,
        },
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
        state: {
          ...emptyState,
          ...(section === "nodes" ? { nodes: page.rows } : {}),
          ...(section === "edges" ? { edges: page.rows } : {}),
          ...(section === "values" ? { values: page.rows } : {}),
          ...(section === "redirects" ? { redirects: page.rows } : {}),
          ...(section === "diagnostics" ? { diagnostics: page.rows.map(([, value]) => value) } : {}),
        },
      });
      return;
    }
    if (limit !== undefined || compact) {
      const entries = await sdk.listEntries(access, {
        ...(include === undefined ? {} : { include }),
        ...(cursor === undefined ? {} : { cursor }),
      });
      const projectedEntries = limit === undefined ? entries : entries.slice(-limit);
      const state = fold(projectedEntries, {
        include: "canon+draft",
        existingCreate: "replace",
      });
      sendJson(response, 200, {
        entries: compact ? [] : projectedEntries,
        total: entries.length,
        projected: projectedEntries.length,
        state: compact ? compactFoldState(state) : JSON.parse(serializeFoldState(state)),
      });
      return;
    }
    const projected = await sdk.project(access, {
      ...(include === undefined ? {} : { include }),
      ...(cursor === undefined ? {} : { cursor }),
    });
    sendJson(response, 200, {
      entries: projected.entries,
      state: JSON.parse(serializeFoldState(projected.state)),
    });
    return;
  }

  if (resource === "trajectory-tasks" && resourceId === undefined) {
    if (method === "GET") {
      const tasks = await sdk.trajectoryTasks(access);
      const limit = positiveIntegerQuery(url, "limit", 1_000);
      const page = pagedNewestFirst(
        tasks,
        "trajectory",
        limit,
        pageCursorFromUrl(url, "trajectory"),
        (task) => task.lastRecordedAt,
        (task) => task.taskId,
      );
      sendJson(response, 200, {
        tasks: page.items,
        total: page.total,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      });
      return;
    }
    if (method === "POST") {
      const body = trajectoryTreeRecordSchema.parse(await readJsonBody(request, maxBodyBytes));
      const result = await sdk.recordTrajectoryTree(
        trajectoryContext(subject, access, body.spaceId, body.captureIdentity),
        body.stamp,
        body.tree,
      );
      sendJson(response, 201, result);
      return;
    }
    throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
  }

  if (resource === "fleet" && resourceId === undefined) {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const nowMs = finiteQueryNumber(url, "nowMs") ?? Date.now();
    const orphanAfterMs = finiteQueryNumber(url, "orphanAfterMs") ?? dependencies.fleetOrphanAfterMs;
    const fleet = await sdk.fleetSnapshot(access, nowMs, {
      ...(orphanAfterMs === undefined ? {} : { orphanAfterMs }),
    });
    sendJson(response, 200, { fleet });
    return;
  }

  if (resource === "transcript-projects" && resourceId === undefined) {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    sendJson(response, 200, { projects: await sdk.transcriptProjects(access) });
    return;
  }

  if (resource === "transcript-projects" && resourceId !== undefined && resourceSegments.length === 2) {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const project = (await sdk.transcriptProjects(access))
      .find((candidate) => candidate.project.id === resourceId);
    if (project === undefined) {
      throw new ApiHttpError(404, "transcript_project_unavailable", "Transcript project is unavailable");
    }
    const runs = await sdk.transcriptRuns(access, { projectId: resourceId });
    sendJson(response, 200, { ...project, runs });
    return;
  }

  if (resource === "transcript-runs" && resourceId === undefined) {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const rawSource = url.searchParams.get("source");
    const source = rawSource === null ? undefined : transcriptSourceSchema.parse(rawSource);
    const projectId = url.searchParams.get("projectId") ?? undefined;
    const runs = await sdk.transcriptRuns(access, {
      ...(source === undefined ? {} : { source }),
      ...(projectId === undefined ? {} : { projectId }),
    });
    const limit = positiveIntegerQuery(url, "limit", 1_000);
    const page = pagedNewestFirst(
      runs,
      "run",
      limit,
      pageCursorFromUrl(url, "run"),
      (run) => run.endedAt ?? run.startedAt ?? "",
      (run) => run.id,
    );
    sendJson(response, 200, {
      runs: page.items,
      total: page.total,
      ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    });
    return;
  }

  if (resource === "transcript-runs" && resourceId !== undefined && resourceSegments.length === 2) {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const run = await sdk.transcriptRun(access, resourceId);
    if (run === undefined) {
      throw new ApiHttpError(404, "transcript_run_unavailable", "Transcript run is unavailable");
    }
    sendJson(response, 200, run);
    return;
  }

  if (resource === "transcript-imports" && resourceId === undefined) {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    if (!canSteer(access)) {
      throw new ApiHttpError(403, "transcript_import_access_denied", "Transcript import access denied");
    }
    const bundle = transcriptImportBundleSchema.parse(await readJsonBody(request, maxBodyBytes));
    const result = await sdk.importTranscript(
      transcriptContext(subject, access, bundle),
      bundle,
      { importId: `transcript-import:${randomUUID()}`, importedAt: Date.now() },
    );
    sendJson(response, result.events.length === 0 ? 200 : 201, {
      imported: result.events.length > 0,
      eventCount: result.events.length,
      run: result.run,
    });
    return;
  }

  if (resource === "steering" && resourceId === undefined) {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    sendJson(response, 200, {
      actors: await sdk.steeringSnapshots(access),
      steeringEnabled: canSteer(access),
    });
    return;
  }

  if (resource === "steering" && resourceId !== undefined && resourceSegments.length === 2) {
    if (method === "GET") {
      sendJson(response, 200, { steering: await sdk.steeringSnapshot(access, resourceId) });
      return;
    }
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    if (!canSteer(access)) {
      throw new ApiHttpError(403, "steering_access_denied", "Human steering access denied");
    }
    const body = steeringActionSchema.parse(await readJsonBody(request, maxBodyBytes));
    const context = steeringContext(subject, access, resourceId);
    if (body.action === "surface") {
      sendJson(response, 201, await sdk.surfaceIntentionCandidate(
        context,
        body.stamp,
        body.candidate as Omit<SurfacedCandidate, "surfacedAtMs">,
        body.causedBy,
      ));
    } else if (body.action === "commit") {
      sendJson(response, 201, await sdk.commitIntentionCandidate(
        context, body.stamp, body.candidateId, body.intentionId, body.causedBy,
      ));
    } else if (body.action === "decline") {
      sendJson(response, 201, await sdk.declineIntentionCandidate(
        context, body.stamp, body.candidateId, body.reason, body.causedBy,
      ));
    } else if (body.action === "acted") {
      sendJson(response, 201, await sdk.recordIntentionAction(
        context, body.stamp, body.intentionId, body.causedBy,
      ));
    } else {
      sendJson(response, 201, await sdk.endIntention(
        context, body.stamp, body.intentionId, body.end as IntentionEnd, body.causedBy,
      ));
    }
    return;
  }

  if (resource === "reasoning" && resourceId === "ask" && resourceSegments.length === 2) {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const body = reasoningRequestSchema.parse(await readJsonBody(request, maxBodyBytes));
    const explicitMemoryIds = body.memoryIds === undefined ? undefined : [...new Set(body.memoryIds)];
    const ranked = explicitMemoryIds === undefined
      ? await sdk.rankMemories(access, {
          query: body.question,
          ...(body.scope === undefined ? {} : { scope: body.scope }),
          ...(body.tags === undefined ? {} : { tags: body.tags }),
          ...(body.sources === undefined ? {} : { sources: body.sources }),
          ...(body.projectIds === undefined ? {} : { projectIds: body.projectIds }),
          ...(body.from === undefined ? {} : { from: body.from }),
          ...(body.to === undefined ? {} : { to: body.to }),
          limit: body.limit ?? 5,
        }, dependencies.memoryRanker ?? new LocalLexicalMemoryRanker())
      : await (async () => {
          const memories = await Promise.all(explicitMemoryIds.map((memoryId) => sdk.memoryById(access, memoryId)));
          if (memories.some((memory) => memory === undefined)) {
            throw new ApiHttpError(404, "reasoning_memory_unavailable", "One or more reasoning memories are unavailable");
          }
          return {
            memories: memories.map((memory) => ({ memory: memory!, score: undefined })),
            ranking: { id: "explicit-memory-set-v1", kind: "explicit" as const, corpusSize: memories.length },
          };
        })();
    const evidence = ranked.memories.map(({ memory, score }) => ({
      memoryId: memory.id,
      source: memory.source,
      summary: memory.summary,
      content: memory.content,
      tags: memory.tags,
      ...(score === undefined ? {} : { score }),
    }));
    const steering = body.actorId === undefined
      ? undefined
      : await sdk.steeringSnapshot(access, body.actorId);
    let reasoner;
    try {
      reasoner = dependencies.reasoners?.provider(body.providerId)
        ?? dependencies.reasoner
        ?? new LocalEvidenceReasoner();
      if (body.providerId !== undefined && dependencies.reasoners === undefined && reasoner.descriptor.id !== body.providerId) {
        throw new TypeError(`reasoning provider is unavailable: ${body.providerId}`);
      }
    } catch (error) {
      throw new ApiHttpError(400, "reasoning_provider_unavailable", error instanceof Error ? error.message : "Reasoning provider is unavailable");
    }
    const result = validateReasoningResult(
      await reasoner.answer({
        question: body.question,
        evidence,
        ...(steering === undefined ? {} : { steering }),
      }),
      evidence,
    );
    sendJson(response, 200, {
      ...result,
      provider: reasoner.descriptor,
      ranking: ranked.ranking,
      evidence: evidence.map(({ memoryId, source, summary, score }) => ({
        memoryId,
        source,
        summary,
        ...(score === undefined ? {} : { score }),
      })),
      ...(steering === undefined ? {} : { steering }),
    });
    return;
  }

  if (resource === "reasoning" && resourceId === "providers" && resourceSegments.length === 2) {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const fallback = dependencies.reasoner ?? new LocalEvidenceReasoner();
    sendJson(response, 200, {
      providers: dependencies.reasoners?.statuses ?? [{ ...fallback.descriptor, configured: true, isDefault: true }],
    });
    return;
  }

  if (resource === "trajectory-tasks" && resourceId !== undefined && resourceSegments.length === 2) {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const report = await sdk.trajectoryReport(access, resourceId);
    if (report === undefined) throw new TrajectoryTaskUnavailableError(resourceId);
    const limit = positiveIntegerQuery(url, "limit", 1_000) ?? 100;
    const page = pagedNewestFirst(
      [...report.records].sort((left, right) =>
        right.recordedAt - left.recordedAt || left.trajectory.id.localeCompare(right.trajectory.id)
      ),
      "trajectory-run",
      limit,
      pageCursorFromUrl(url, "trajectory-run"),
      (record) => record.recordedAt,
      (record) => record.trajectory.id,
    );
    const ids = new Set(page.items.map((record) => record.trajectory.id));
    sendJson(response, 200, {
      report: {
        ...serializeTrajectoryReport(report),
        records: page.items,
        projected: report.projected.filter(({ id }) => ids.has(id)),
        divergences: report.divergences.filter(({ trajectoryId }) => ids.has(trajectoryId)),
        evaluations: report.evaluations.filter(({ trajectoryId }) => ids.has(trajectoryId)),
        runTotal: page.total,
        ...(page.nextCursor === undefined ? {} : { runCursor: page.nextCursor }),
      },
    });
    return;
  }

  if (resource === "trajectories" && resourceId === undefined) {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const body = trajectoryRecordSchema.parse(await readJsonBody(request, maxBodyBytes));
    const result = await sdk.recordTrajectory(
      trajectoryContext(subject, access, body.spaceId, body.captureIdentity),
      body.stamp,
      parsedTrajectoryInput(body.input),
    );
    sendJson(response, 201, result);
    return;
  }

  if (resource === "memory-candidates" && resourceId === undefined) {
    if (method === "GET") {
      const rawStatus = url.searchParams.get("status");
      const status = rawStatus === null
        ? undefined
        : z.enum(["proposed", "accepted", "rejected"]).parse(rawStatus);
      const limit = positiveIntegerQuery(url, "limit", 1_000);
      const rawOffset = finiteQueryNumber(url, "offset");
      if (rawOffset !== undefined && (!Number.isInteger(rawOffset) || rawOffset < 0)) {
        throw new ApiHttpError(400, "invalid_query", "offset must be a non-negative integer");
      }
      const candidates = await sdk.memoryCandidates(access, {
        ...(status === undefined ? {} : { status }),
        ...(url.searchParams.has("projectId") ? { projectIds: url.searchParams.getAll("projectId") } : {}),
      });
      if (rawOffset !== undefined) {
        sendJson(response, 200, {
          candidates: limit === undefined
            ? candidates.slice(rawOffset)
            : candidates.slice(rawOffset, rawOffset + limit),
          total: candidates.length,
        });
        return;
      }
      const page = pagedNewestFirst(
        candidates,
        "candidate",
        limit,
        pageCursorFromUrl(url, "candidate"),
        ({ candidate }) => candidate.proposedAt,
        ({ candidate }) => candidate.id,
      );
      sendJson(response, 200, {
        candidates: page.items,
        total: page.total,
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
      });
      return;
    }
    if (method === "POST") {
      const body = memoryCandidateProposalSchema.parse(await readJsonBody(request, maxBodyBytes));
      const input = parsedMemoryCandidateInput(body.input);
      sendJson(response, 201, await sdk.proposeMemoryCandidate(
        memoryContext(subject, access, input.spaceId, input.audience),
        body.stamp,
        input,
        body.causedBy,
      ));
      return;
    }
    throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
  }

  if (resource === "memory-candidate-imports" && resourceId === undefined) {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const body = memoryCandidateImportSchema.parse(await readJsonBody(request, maxBodyBytes));
    for (const proposal of body.proposals) {
      if ((proposal.input.audience ?? "personal") !== body.audience || proposal.input.spaceId !== body.spaceId) {
        throw new ApiHttpError(400, "candidate_batch_scope_mismatch", "Every candidate must match the batch audience and space");
      }
    }
    const candidates = await sdk.proposeMemoryCandidates(
      memoryContext(subject, access, body.spaceId, body.audience),
      body.proposals.map((proposal) => ({
        stamp: proposal.stamp,
        input: parsedMemoryCandidateInput(proposal.input),
        ...(proposal.causedBy === undefined ? {} : { causedBy: proposal.causedBy }),
      })),
    );
    sendJson(response, 201, { candidates });
    return;
  }

  if (resource === "memory-candidate-promotions" && resourceId === undefined) {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const body = memoryCandidatePromotionSchema.parse(await readJsonBody(request, maxBodyBytes));
    const views = new Map((await sdk.memoryCandidates(access)).map((view) => [view.candidate.id, view]));
    for (const acceptance of body.acceptances) {
      const view = views.get(acceptance.candidateId);
      if (view === undefined || view.status !== "proposed") {
        throw new ApiHttpError(404, "memory_candidate_unavailable", `Memory candidate ${acceptance.candidateId} is unavailable`);
      }
      if (view.candidate.audience !== body.audience || view.candidate.spaceId !== body.spaceId) {
        throw new ApiHttpError(400, "candidate_batch_scope_mismatch", "Every candidate must match the batch audience and space");
      }
    }
    if (body.audience === "workspace" && !canSteer(access)) {
      throw new ApiHttpError(403, "shared_memory_review_access_denied", "Workspace memory review requires an owner or admin role");
    }
    const accepted = await sdk.acceptMemoryCandidates(
      memoryContext(subject, access, body.spaceId, body.audience),
      body.acceptances.map((acceptance) => ({
        decisionStamp: acceptance.stamp,
        memoryStamp: acceptance.memoryStamp,
        candidateId: acceptance.candidateId,
        memoryId: acceptance.memoryId,
      })),
    );
    sendJson(response, 201, { accepted });
    return;
  }

  if (resource === "memory-candidates" && resourceId !== undefined && resourceSegments.length === 3) {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const action = decodeSegment(resourceSegments[2]!, "candidate action");
    if (action !== "accept" && action !== "reject") {
      throw new ApiHttpError(404, "not_found", "Route not found");
    }
    const view = (await sdk.memoryCandidates(access)).find(({ candidate }) => candidate.id === resourceId);
    if (view === undefined || view.status !== "proposed") {
      throw new ApiHttpError(404, "memory_candidate_unavailable", "Memory candidate is unavailable");
    }
    if (view.candidate.audience === "workspace" && !canSteer(access)) {
      throw new ApiHttpError(
        403,
        "shared_memory_review_access_denied",
        "Workspace memory review requires an owner or admin role",
      );
    }
    const context = memoryContext(subject, access, view.candidate.spaceId, view.candidate.audience);
    if (action === "accept") {
      const body = memoryCandidateAcceptSchema.parse(await readJsonBody(request, maxBodyBytes));
      sendJson(response, 201, await sdk.acceptMemoryCandidate(
        context,
        body.stamp,
        body.memoryStamp,
        resourceId,
        body.memoryId,
      ));
    } else {
      const body = memoryCandidateRejectSchema.parse(await readJsonBody(request, maxBodyBytes));
      sendJson(response, 201, await sdk.rejectMemoryCandidate(context, body.stamp, resourceId, body.reason));
    }
    return;
  }

  if (resource === "memories" && resourceId === "recall") {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const recall = parsedRecallRequest(await readJsonBody(request, maxBodyBytes));
    sendJson(response, 200, { memories: await sdk.recallMemories(access, recall) });
    return;
  }

  if (resource === "memories" && resourceId === "search") {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const recall = parsedRankedRecallRequest(await readJsonBody(request, maxBodyBytes));
    const ranker = dependencies.memoryRanker ?? new LocalLexicalMemoryRanker();
    sendJson(response, 200, await sdk.rankMemories(access, recall, ranker));
    return;
  }

  if (resource === "memories" && resourceId === undefined) {
    if (method === "GET") {
      const recall = recallFromUrl(url);
      const rawCursor = pageCursorFromUrl(url, "memory");
      let memoryCursor: MemoryPageCursor | undefined;
      if (rawCursor !== undefined) {
        if (typeof rawCursor.key !== "number") {
          throw new ApiHttpError(400, "invalid_cursor", "Memory page cursor is invalid");
        }
        memoryCursor = { createdAt: rawCursor.key, memoryId: rawCursor.id };
      }
      const { limit, ...filters } = recall;
      const page = await sdk.recallMemoryPage(access, {
        ...filters,
        ...(limit === undefined ? {} : { limit }),
        ...(memoryCursor === undefined ? {} : { cursor: memoryCursor }),
      });
      sendJson(response, 200, {
        memories: page.memories,
        total: page.total,
        ...(page.nextCursor === undefined ? {} : {
          nextCursor: encodePageCursor({
            kind: "memory",
            key: page.nextCursor.createdAt,
            id: page.nextCursor.memoryId,
          }),
        }),
      });
      return;
    }
    if (method === "POST") {
      const body = memoryRecordSchema.parse(await readJsonBody(request, maxBodyBytes));
      const input = parsedMemoryInput(body.input);
      if (input.audience === "workspace" && !canSteer(access)) {
        throw new ApiHttpError(
          403,
          "shared_memory_access_denied",
          "Workspace memory writes require an owner or admin role",
        );
      }
      const result = await sdk.recordMemory(
        memoryContext(subject, access, input.spaceId, input.audience),
        body.stamp,
        input,
        body.causedBy,
      );
      sendJson(response, 201, result);
      return;
    }
    throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
  }

  if (resource === "memories" && resourceId !== undefined && resourceSegments.length === 3) {
    const action = decodeSegment(resourceSegments[2]!, "memory action");
    if (action !== "feedback") throw new ApiHttpError(404, "not_found", "Route not found");
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const current = await sdk.memoryById(access, resourceId);
    if (current === undefined) throw new PersonalMemoryUnavailableError(resourceId);
    const body = memoryFeedbackSchema.parse(await readJsonBody(request, maxBodyBytes));
    sendJson(response, 201, await sdk.recordMemoryFeedback(
      memoryContext(subject, access, current.spaceId, current.audience),
      body.stamp,
      resourceId,
      body.input as MemoryFeedbackInput,
      body.causedBy,
    ));
    return;
  }

  if (resource === "memories" && resourceId !== undefined && resourceSegments.length === 2) {
    if (method !== "GET" && method !== "PATCH" && method !== "DELETE") {
      throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    }
    if (method === "GET") {
      const memory = await sdk.memoryById(access, resourceId);
      if (memory === undefined) throw new PersonalMemoryUnavailableError(resourceId);
      sendJson(response, 200, { memory });
      return;
    }
    const current = await sdk.memoryById(access, resourceId);
    if (current === undefined) throw new PersonalMemoryUnavailableError(resourceId);
    if (current.audience === "workspace" && !canSteer(access)) {
      throw new ApiHttpError(403, "shared_memory_access_denied", "Workspace memory changes require an owner or admin role");
    }
    const context = memoryContext(subject, access, current.spaceId, current.audience);
    if (method === "PATCH") {
      const body = memoryRevisionSchema.parse(await readJsonBody(request, maxBodyBytes));
      sendJson(
        response,
        200,
        await sdk.reviseMemory(
          context,
          body.stamp,
          resourceId,
          parsedMemoryPatch(body.patch),
          body.causedBy,
        ),
      );
      return;
    }
    if (method === "DELETE") {
      const body = memoryForgetSchema.parse(await readJsonBody(request, maxBodyBytes));
      sendJson(
        response,
        200,
        await sdk.forgetMemory(
          context,
          body.stamp,
          resourceId,
          body.reason,
          body.causedBy,
        ),
      );
      return;
    }
  }

  throw new ApiHttpError(404, "not_found", "Route not found");
}

export function createApiServer(dependencies: ApiDependencies): Server {
  if (
    dependencies.maxBodyBytes !== undefined &&
    (!Number.isInteger(dependencies.maxBodyBytes) || dependencies.maxBodyBytes <= 0)
  ) {
    throw new TypeError("maxBodyBytes must be a positive integer");
  }
  if (
    dependencies.eventStreamPollMs !== undefined &&
    (!Number.isInteger(dependencies.eventStreamPollMs) || dependencies.eventStreamPollMs < 10)
  ) {
    throw new TypeError("eventStreamPollMs must be an integer of at least 10 milliseconds");
  }
  const allowedOrigins = corsOriginSet(dependencies.corsOrigins);
  const server = createServer((request, response) => {
    void handleRequest(request, response, dependencies, allowedOrigins).catch((error: unknown) => {
      const httpError = asHttpError(error);
      if (httpError.status === 500) dependencies.reportError?.(error);
      if (!response.headersSent) sendError(response, httpError);
      else response.destroy();
    });
  });
  server.requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS;
  server.headersTimeout = DEFAULT_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = 1_000;
  return server;
}
