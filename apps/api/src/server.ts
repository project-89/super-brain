import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import {
  EventOrderError,
  FoldValidationError,
  eventSchema,
  jsonValueSchema,
  serializeFoldState,
  type Author,
  type FoldEvent,
} from "@_89/fold";
import type {
  EpistemicEventContext,
  MemoryInput,
  MemoryRevisionPatch,
  RecallRequest,
} from "@_89/fold-epistemic";
import {
  FoldSdkAccessError,
  FoldSdkConflictError,
  FoldSdkError,
  PersonalMemoryUnavailableError,
  TrajectoryTaskUnavailableError,
  type FoldSdkAccessContext,
  type FoldSdkCursor,
  type RankedMemoryRecallRequest,
  type TrajectoryTaskReport,
  type FoldSdkActivityContext,
  type FoldSdkSteeringContext,
} from "@_89/fold-sdk";
import { JournalError } from "@_89/fold-storage";
import type { TerminalManagerSignal } from "@_89/fold-activity";
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

import type {
  ApiDependencies,
  AuthenticatedSubject,
} from "./types.js";
import { LocalLexicalMemoryRanker } from "./recall.js";
import {
  LocalEvidenceReasoner,
  validateReasoningResult,
} from "./reasoning.js";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_HEADERS_TIMEOUT_MS = 10_000;
const DEFAULT_KEEP_ALIVE_TIMEOUT_MS = 5_000;

const stampSchema = z
  .object({
    id: z.string().min(1),
    t: z.number().finite().nonnegative(),
    worldDate: z.string().regex(/^\d{4,6}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/),
  })
  .strict();

const entitySchema = z
  .object({
    id: z.string().min(1).max(200),
    type: z.string().min(1).max(200),
    name: z.string().min(1).max(500),
  })
  .strict();

const memoryInputSchema = z
  .object({
    id: z.string().min(1),
    spaceId: z.string().min(1).optional(),
    source: z.string().min(1).max(200),
    summary: z.string().max(500).optional(),
    content: jsonValueSchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    entities: z.array(entitySchema).optional(),
  })
  .strict();

const memoryPatchSchema = z
  .object({
    summary: z.string().max(500).optional(),
    content: jsonValueSchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .strict();

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

const trajectoryTreeRecordSchema = z
  .object({
    stamp: stampSchema,
    spaceId: z.string().min(1).optional(),
    tree: sharedDecisionTreeSchema,
  })
  .strict();

const trajectoryRecordSchema = z
  .object({
    stamp: stampSchema,
    spaceId: z.string().min(1).optional(),
    input: trajectoryInputSchema,
  })
  .strict();

const activityIdentitySchema = z
  .object({
    agent: z.string().min(1).max(200),
    task: z.string().min(1).max(300),
    repo: z.string().min(1).max(300),
    branch: z.string().min(1).max(300),
    session: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
    runtime: z.string().min(1).max(200).optional(),
  })
  .strict();

const activitySignalSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session_started") }).strict(),
  z.object({ type: z.literal("session_ready") }).strict(),
  z.object({ type: z.literal("session_stopped"), reason: z.string().min(1).max(2_000).optional() }).strict(),
  z.object({ type: z.literal("session_error"), error: z.string().min(1).max(2_000) }).strict(),
  z.object({ type: z.literal("session_status_changed"), status: z.string().min(1).max(100) }).strict(),
  z.object({
    type: z.literal("login_required"),
    instructions: z.string().max(5_000).optional(),
    url: z.string().url().max(2_000).optional(),
  }).strict(),
  z.object({
    type: z.literal("auth_required"),
    method: z.string().min(1).max(200),
    instructions: z.string().max(5_000).optional(),
    url: z.string().url().max(2_000).optional(),
  }).strict(),
  z.object({
    type: z.literal("blocking_prompt"),
    promptType: z.string().min(1).max(200),
    prompt: z.string().max(5_000).optional(),
    autoResponded: z.boolean(),
  }).strict(),
  z.object({
    type: z.literal("stall_detected"),
    recentOutput: z.string().max(200_000),
    stallDurationMs: z.number().finite().nonnegative(),
  }).strict(),
  z.object({ type: z.literal("task_complete"), output: z.string().max(200_000).optional() }).strict(),
  z.object({ type: z.literal("tool_running"), toolName: z.string().min(1).max(300) }).strict(),
  z.object({ type: z.literal("output"), output: z.string().max(200_000) }).strict(),
  z.object({ type: z.literal("heartbeat") }).strict(),
  z.object({ type: z.literal("sensor_degraded"), detail: z.string().max(2_000).optional() }).strict(),
]);

const activitySignalRecordSchema = z
  .object({
    stamp: z.object({
      id: z.string().min(1),
      t: z.number().finite().nonnegative(),
      observedAt: z.string().datetime({ offset: true }),
    }).strict(),
    spaceId: z.string().min(1).optional(),
    identity: activityIdentitySchema,
    heartbeatWindowMs: z.number().int().min(250).max(3_600_000),
    signal: activitySignalSchema,
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
  const decision = dependencies.rateLimiter.consume(request.socket.remoteAddress ?? "unknown");
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
      "ProjectionValidationError",
      "TraceValidationError",
      "TrajectoryEventError",
      "TrajectoryProjectionError",
      "ActivityEventError",
      "FleetProjectionError",
    ].includes(error.name))
  ) {
    return new ApiHttpError(400, "invalid_request", error.message);
  }
  return new ApiHttpError(500, "internal_error", "Internal server error");
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new ApiHttpError(415, "unsupported_media_type", "Content-Type must be application/json");
  }
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
  if (size === 0) throw new ApiHttpError(400, "invalid_json", "Request body must contain JSON");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  if (
    event.kind.startsWith("intention.") ||
    event.changes.some(
      (change) => "nodeKind" in change && change.nodeKind === INTENTION_EVENT_NODE_KIND,
    )
  ) {
    throw new ApiHttpError(
      400,
      "reserved_event_route",
      "Intention events must use the human steering route",
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

function parsedRecallRequest(input: unknown): RecallRequest {
  const parsed = recallRequestSchema.parse(input);
  return {
    ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
    ...(parsed.tags === undefined ? {} : { tags: parsed.tags }),
    ...(parsed.sources === undefined ? {} : { sources: parsed.sources }),
    ...(parsed.from === undefined ? {} : { from: parsed.from }),
    ...(parsed.to === undefined ? {} : { to: parsed.to }),
    ...(parsed.limit === undefined ? {} : { limit: parsed.limit }),
    ...(parsed.candidates === undefined ? {} : { candidates: parsed.candidates }),
  };
}

function parsedRankedRecallRequest(input: unknown): RankedMemoryRecallRequest {
  return rankedRecallRequestSchema.parse(input) as RankedMemoryRecallRequest;
}

function parsedMemoryInput(input: z.infer<typeof memoryInputSchema>): MemoryInput {
  return {
    id: input.id,
    source: input.source,
    ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    ...(input.entities === undefined ? {} : { entities: input.entities }),
  };
}

function parsedMemoryPatch(input: z.infer<typeof memoryPatchSchema>): MemoryRevisionPatch {
  return {
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
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
    ...(finiteQueryNumber(url, "from") === undefined ? {} : { from: finiteQueryNumber(url, "from") }),
    ...(finiteQueryNumber(url, "to") === undefined ? {} : { to: finiteQueryNumber(url, "to") }),
    ...(limit === undefined ? {} : { limit }),
  });
}

function memoryContext(
  subject: AuthenticatedSubject,
  access: FoldSdkAccessContext,
  spaceId: string | undefined,
): EpistemicEventContext {
  return {
    access,
    author: subject.author,
    capture: {
      scope: {
        workspace: access.workspaceId,
        ...(spaceId === undefined ? {} : { space: spaceId }),
        creator: access.principalId,
      },
      identity: { principal: access.principalId, workspace: access.workspaceId },
    },
  };
}

function trajectoryContext(
  subject: AuthenticatedSubject,
  access: FoldSdkAccessContext,
  spaceId: string | undefined,
): TrajectoryEventContext {
  return {
    access,
    author: subject.author,
    capture: {
      scope: {
        workspace: access.workspaceId,
        ...(spaceId === undefined ? {} : { space: spaceId }),
      },
      identity: { principal: access.principalId, workspace: access.workspaceId },
    },
  };
}

function activityContext(
  access: FoldSdkAccessContext,
  body: z.infer<typeof activitySignalRecordSchema>,
): FoldSdkActivityContext {
  const sensor = `urn:sensor:terminal:${body.identity.session}`;
  return {
    access,
    sensor,
    sessionId: body.identity.session,
    heartbeatWindowMs: body.heartbeatWindowMs,
    capture: {
      scope: {
        workspace: access.workspaceId,
        ...(body.spaceId === undefined ? {} : { space: body.spaceId }),
      },
      identity: {
        principal: access.principalId,
        workspace: access.workspaceId,
        agent: body.identity.agent,
        task: body.identity.task,
        repo: body.identity.repo,
        branch: body.identity.branch,
        session: body.identity.session,
        ...(body.identity.runtime === undefined ? {} : { runtime: body.identity.runtime }),
      },
    },
  };
}

function canSimulate(access: FoldSdkAccessContext, dependencies: ApiDependencies): boolean {
  return dependencies.enableSimulation === true &&
    (access.workspaceRole === "owner" || access.workspaceRole === "admin");
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
  if (segments.length < 3 || segments[0] !== "v1" || segments[1] !== "workspaces") {
    throw new ApiHttpError(404, "not_found", "Route not found");
  }
  const workspaceId = decodeSegment(segments[2]!, "workspaceId");
  const subject = await authenticate(request, dependencies);
  const access = await dependencies.memberships.resolveAccess(subject, workspaceId);
  if (access === undefined) {
    throw new ApiHttpError(403, "workspace_access_denied", "Workspace access denied");
  }
  const sdk = await dependencies.sdks.sdkFor(workspaceId);
  const resource = segments[3];
  const resourceId = segments[4] === undefined ? undefined : decodeSegment(segments[4], "resourceId");
  const maxBodyBytes = dependencies.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  if (resource === "events" && resourceId === undefined) {
    if (method === "GET") {
      const include = includeFromUrl(url);
      const cursor = cursorFromUrl(url);
      const entries = await sdk.listEntries(access, {
        ...(include === undefined ? {} : { include }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(url.searchParams.has("kind") ? { kinds: url.searchParams.getAll("kind") } : {}),
      });
      sendJson(response, 200, { entries });
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
      sendJson(response, 200, { tasks: await sdk.trajectoryTasks(access) });
      return;
    }
    if (method === "POST") {
      const body = trajectoryTreeRecordSchema.parse(await readJsonBody(request, maxBodyBytes));
      const result = await sdk.recordTrajectoryTree(
        trajectoryContext(subject, access, body.spaceId),
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
    const orphanAfterMs = finiteQueryNumber(url, "orphanAfterMs");
    const fleet = await sdk.fleetSnapshot(access, nowMs, {
      ...(orphanAfterMs === undefined ? {} : { orphanAfterMs }),
    });
    sendJson(response, 200, {
      fleet,
      simulationEnabled: canSimulate(access, dependencies),
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

  if (resource === "steering" && resourceId !== undefined && segments.length === 5) {
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

  if (resource === "reasoning" && resourceId === "ask" && segments.length === 5) {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const body = reasoningRequestSchema.parse(await readJsonBody(request, maxBodyBytes));
    const ranked = await sdk.rankMemories(access, {
      query: body.question,
      ...(body.scope === undefined ? {} : { scope: body.scope }),
      ...(body.tags === undefined ? {} : { tags: body.tags }),
      ...(body.sources === undefined ? {} : { sources: body.sources }),
      ...(body.from === undefined ? {} : { from: body.from }),
      ...(body.to === undefined ? {} : { to: body.to }),
      limit: body.limit ?? 5,
    }, dependencies.memoryRanker ?? new LocalLexicalMemoryRanker());
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
    const reasoner = dependencies.reasoner ?? new LocalEvidenceReasoner();
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

  if (resource === "activity-signals" && resourceId === undefined) {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    if (dependencies.enableSimulation !== true) {
      throw new ApiHttpError(404, "not_found", "Route not found");
    }
    if (!canSimulate(access, dependencies)) {
      throw new ApiHttpError(403, "simulation_access_denied", "Fleet simulation access denied");
    }
    const body = activitySignalRecordSchema.parse(await readJsonBody(request, maxBodyBytes));
    const result = await sdk.recordActivitySignal(
      activityContext(access, body),
      body.stamp,
      body.signal as unknown as TerminalManagerSignal,
    );
    sendJson(response, 201, result);
    return;
  }

  if (resource === "trajectory-tasks" && resourceId !== undefined && segments.length === 5) {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const report = await sdk.trajectoryReport(access, resourceId);
    if (report === undefined) throw new TrajectoryTaskUnavailableError(resourceId);
    sendJson(response, 200, { report: serializeTrajectoryReport(report) });
    return;
  }

  if (resource === "trajectories" && resourceId === undefined) {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const body = trajectoryRecordSchema.parse(await readJsonBody(request, maxBodyBytes));
    const result = await sdk.recordTrajectory(
      trajectoryContext(subject, access, body.spaceId),
      body.stamp,
      parsedTrajectoryInput(body.input),
    );
    sendJson(response, 201, result);
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
      sendJson(response, 200, { memories: await sdk.recallMemories(access, recallFromUrl(url)) });
      return;
    }
    if (method === "POST") {
      const body = memoryRecordSchema.parse(await readJsonBody(request, maxBodyBytes));
      const input = parsedMemoryInput(body.input);
      const result = await sdk.recordMemory(
        memoryContext(subject, access, input.spaceId),
        body.stamp,
        input,
        body.causedBy,
      );
      sendJson(response, 201, result);
      return;
    }
    throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
  }

  if (resource === "memories" && resourceId !== undefined && segments.length === 5) {
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
    const context = memoryContext(subject, access, current.spaceId);
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
