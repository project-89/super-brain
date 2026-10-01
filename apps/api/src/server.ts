import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { handleEpisodeRecords, EpisodeHttpError } from "./episodes.js";
import { handleEpisodeSynthesis, EpisodeSynthesisError } from "./episode-synthesis.js";
import { EpisodeConflictError, EpisodeSourceBudgetError } from "@_89/fold-sdk";

import {
  EventOrderError,
  FoldValidationError,
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
  normalizeMemoryFeedbackInputV2,
  MemoryFeedbackError,
  MEMORY_CANDIDATE_DECISION_NODE_KIND,
  MEMORY_CANDIDATE_NODE_KIND,
  matchesMemoryProjects,
  recallMemoryCorpus,
} from "@_89/fold-epistemic";
import {
  FoldSdkAccessError,
  FoldSdkConflictError,
  FoldSdkError,
  PersonalMemoryUnavailableError,
  TrajectoryTaskUnavailableError,
  type FoldSdkAccessContext,
  type FoldSdkCursor,
  type FoldConsumerCursor,
  type FoldDeliveryCursor,
  authorizeEventAccess,
  type FoldIngestionCursor,
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
  trajectoryOutcomeInputSchema,
  TRAJECTORY_OUTCOME_NODE_KIND,
  type TrajectoryEventContext,
  type TrajectoryInput,
  taskManifestSchema, attemptManifestSchema, taskOutcomeInputSchema, taskInterventionInputSchema, TASK_EVIDENCE_NODE_KIND,
  TaskEvidenceError,
  type TaskManifest, type AttemptManifest,
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
  transcriptDerivationManifestSchema,
  transcriptDerivationChunkSchema,
  DERIVATION_NODE_KIND,
  DERIVATION_CHUNK_NODE_KIND,
  transcriptSourceSchema,
  IDENTITY_NODE_KIND,
  identityEntityInputSchema,
  identityAttributionInputSchema,
  projectAliasInputSchema,
} from "@_89/fold-transcript";

import type {
  ApiDependencies,
  ApiCapability,
  AuthenticatedSubject,
  TenantKey,
} from "./types.js";
import { API_CAPABILITIES } from "./types.js";
import { LocalLexicalMemoryRanker } from "./recall.js";
import {
  LocalEvidenceReasoner,
  validateReasoningResult,
} from "./reasoning.js";
import { buildDataQualityReport } from "./data-quality.js";

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
    cursor: z.object({ version: z.literal(2), sequence: z.string().regex(/^(0|[1-9][0-9]*)$/).max(19).refine((value) => /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= 9223372036854775807n, "sequence exceeds PostgreSQL bigint") }).strict(),
  })
  .strict();

const ingestionSequenceSchema = z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/).refine(value => BigInt(value) <= 9223372036854775807n);
// Ingestion positions accept the `{kind:"ingestion"}` form and the equivalent v2 delivery form `{version:2}`.
const ingestionCursorSchema = z.union([
  z.object({ kind: z.literal("ingestion"), sequence: ingestionSequenceSchema }).strict(),
  z.object({ version: z.literal(2), sequence: ingestionSequenceSchema }).strict(),
]).transform(({ sequence }) => ({ kind: "ingestion" as const, sequence }));

const ingestionConsumerBodySchema = z.union([
  z.object({ cursor: ingestionCursorSchema }).strict(),
  z.object({ migration: z.literal("replay-all") }).strict(),
  z.object({ reset: z.object({ expectedCursor: ingestionCursorSchema, reason: z.string().trim().min(10).max(2000) }).strict() }).strict(),
]);

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
  relation: z.enum(["supports", "opposes"]).optional(),
}).strict();

const memoryRevisionRefSchema = z.object({ memoryId: z.string().min(1).max(300), revision: z.number().int().nonnegative().safe() }).strict();
const memoryApplicabilitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unresolved") }).strict(),
  z.object({ kind: z.literal("global") }).strict(),
  z.object({ kind: z.literal("projects"), projectIds: z.array(z.string().trim().min(1).max(300)).min(1).max(100) }).strict(),
]);
// Legacy string aliases from the applicability-first API map onto the canonical discriminated form:
// "project" -> {kind:"projects", projectIds}, "general" -> {kind:"global"}, "unresolved" -> {kind:"unresolved"}.
const memoryApplicabilityInputSchema = z.union([memoryApplicabilitySchema, z.enum(["project", "general", "unresolved"])]);
const memoryValidityFields = { applicability: memoryApplicabilityInputSchema.optional(), sourceMemoryRefs: z.array(memoryRevisionRefSchema).max(100).optional(), supersedes: z.array(memoryRevisionRefSchema).max(100).optional(), contradicts: z.array(memoryRevisionRefSchema).max(100).optional() };
const memoryContributionSchema = z.object({ stamp: stampSchema, input: z.object({ evidence: z.array(memoryCandidateEvidenceSchema).min(1).max(100), expectedRevision: z.number().int().nonnegative().safe().optional() }).strict() }).strict();

const memoryInputSchema = z
  .object({
    ...memoryValidityFields,
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
    ...memoryValidityFields,
    projectIds: z.array(z.string().trim().min(1).max(300)).max(100).optional(),
    summary: z.string().max(500).optional(),
    content: jsonValueSchema.optional(),
    tags: z.array(z.string().min(1)).optional(),
    evidence: z.array(memoryCandidateEvidenceSchema).max(1_000).optional(),
  })
  .strict();

const memoryCandidateInputSchema = z.object({
  ...memoryValidityFields,
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
    includeNeedsReview: z.boolean().optional(),
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
    providerConfigRevision: z.string().trim().min(1).max(300).optional(),
    memoryRefs: z.array(memoryRevisionRefSchema).min(1).max(10).optional(),
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
  .object({ stamp: stampSchema, patch: memoryPatchSchema, expectedRevision: z.number().int().nonnegative().safe().optional(), ...causedByField })
  .strict();

const memoryForgetSchema = z
  .object({
    stamp: stampSchema,
    reason: z.string().min(1),
    ...causedByField,
  })
  .strict();

const memoryFeedbackInputSchema = z.unknown().transform((input, context) => {
  try { return normalizeMemoryFeedbackInputV2(input); }
  catch (error) { context.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : "Invalid feedback" }); return z.NEVER; }
});
const memoryFeedbackSchema = z.object({ stamp: stampSchema, input: memoryFeedbackInputSchema, ...causedByField }).strict();
const feedbackSubjectSchema = z.object({ organizationId: z.string().min(1).max(500), workspaceId: z.string().min(1).max(500), principalId: z.string().min(1).max(500) }).strict();
const memoryFeedbackBatchSchema = z.object({ stamp: stampSchema, expectedSubject: feedbackSubjectSchema, items: z.array(z.object({ stamp: stampSchema, memoryId: z.string().uuid(), input: memoryFeedbackInputSchema }).strict()).min(1).max(100) }).strict();
const evaluationSourceReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("memory"), memoryId: z.string().min(1).max(300), revision: z.number().int().nonnegative().safe() }).strict(),
  z.object({ kind: z.literal("event"), eventId: z.string().min(1).max(300) }).strict(),
]);
const evaluationSourceSelectionSchema = z.object({ selectionId: z.string().min(1).max(300), audience: z.literal("local-reviewed"), redactionVersion: z.string().min(1).max(300), expectedSubject: feedbackSubjectSchema, references: z.array(evaluationSourceReferenceSchema).max(100), reviewedReferences: z.array(evaluationSourceReferenceSchema).max(100) }).strict();

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

const memoryCandidateSupportSchema = z.object({
  stamp: stampSchema,
  input: memoryCandidateInputSchema.extend({ evidence: z.array(memoryCandidateEvidenceSchema).min(1).max(1_000) }),
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

const trajectoryOutcomeBodySchema = z.object({
  stamp: stampSchema,
  input: trajectoryOutcomeInputSchema,
}).strict();

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
  readonly appliedEventCount: number;
  readonly state: FoldState;
  readonly appliedChangeCount: number;
}

/** Stable identity of the authorization view a read was computed under. */
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

async function cachedProjection(
  sdk: Awaited<ReturnType<ApiDependencies["sdks"]["sdkFor"]>>,
  access: FoldSdkAccessContext,
  include: "canon" | "canon+draft",
): Promise<CachedProjection> {
  return sdk.systemProjection(access, include);
}

function projectionSectionRows(state: FoldState, section: ProjectionSection): readonly (readonly [string, unknown])[] {
  const byId = ([left]: readonly [string, unknown], [right]: readonly [string, unknown]) => left < right ? -1 : left > right ? 1 : 0;
  if (section === "nodes") return [...state.nodes.entries()].sort(byId);
  if (section === "edges") return [...state.edges.entries()].sort(byId);
  if (section === "values") return [...state.values.entries()].sort(byId);
  if (section === "redirects") return [...state.redirects.entries()].sort(byId);
  return state.diagnostics
    .map((diagnostic, index) => [`${diagnostic.eventId}\0${diagnostic.changeIndex}\0${index}`, diagnostic] as const)
    .sort(byId);
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

function applyAuthorizedRateLimit(response: ServerResponse, limiter: ApiDependencies["principalRateLimiter"], key: string): void {
  if (limiter === undefined) return;
  const decision = limiter.consume(key);
  if (decision.allowed) return;
  const retryAfterSeconds = decision.retryAfterSeconds ?? 1;
  response.setHeader("retry-after", String(retryAfterSeconds));
  throw new ApiHttpError(429, "rate_limited", "Authorized request budget exceeded", { retryAfterSeconds });
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
  if (error instanceof Error && "code" in error && error.code === "revision_conflict") {
    return new ApiHttpError(503, "revision_conflict", "Concurrent update; retry the identical command", { retryAfterSeconds: 1 });
  }
  if (error instanceof EpisodeSynthesisError) return new ApiHttpError(error.status, error.code, error.message, error.details);
  if (error instanceof EpisodeHttpError) return new ApiHttpError(error.status, error.code, error.message);
  if (error instanceof EpisodeConflictError) return new ApiHttpError(409, "episode_conflict", error.message);
  if (error instanceof EpisodeSourceBudgetError) return new ApiHttpError(413, "episode_input_too_large", error.message);
  if (error instanceof Error && error.name === "ClerkWebhookVerificationError") {
    return new ApiHttpError(401, "webhook_verification_failed", "Webhook signature verification failed");
  }
  if (error instanceof MemoryFeedbackError) return new ApiHttpError(400, "invalid_feedback", error.message);
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
  if (error instanceof Error && error.name === "EpistemicAccessError") return new ApiHttpError(403, "access_denied", "Memory write access denied");
  if (error instanceof Error && error.name === "MemoryProjectionError") return new ApiHttpError(409, "fold_conflict", "Memory projection invariants would be violated");
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
  if (error instanceof TaskEvidenceError) return new ApiHttpError(409, "task_evidence_conflict", error.message);
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
    DERIVATION_NODE_KIND,
    DERIVATION_CHUNK_NODE_KIND,
  ]);
  if (
    event.kind.startsWith("intention.") ||
    event.kind.startsWith("identity.") ||
    event.kind.startsWith("transcript.") ||
    event.kind.startsWith("memory.") ||
    event.kind.startsWith("trajectory.") ||
    event.changes.some(
      (change) => "nodeKind" in change &&
        (change.nodeKind === INTENTION_EVENT_NODE_KIND ||
          change.nodeKind === IDENTITY_NODE_KIND ||
          change.nodeKind === MEMORY_CANDIDATE_NODE_KIND ||
          change.nodeKind === MEMORY_CANDIDATE_DECISION_NODE_KIND ||
          change.nodeKind === TASK_EVIDENCE_NODE_KIND ||
          change.nodeKind === TRAJECTORY_OUTCOME_NODE_KIND ||
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

type PageCursorKind = "memory" | "candidate" | "run" | "trajectory" | "trajectory-run" | "task-evidence" | "trajectory-outcome" | "event" | "state" | "derivation" | "derived-record" | "derivation-source" | "identity";

interface PageCursor {
  readonly kind: PageCursorKind;
  readonly key: string | number;
  readonly id: string;
}

const pageCursorSchema = z.object({
  kind: z.enum(["memory", "candidate", "run", "trajectory", "trajectory-run", "task-evidence", "trajectory-outcome", "event", "state", "derivation", "derived-record", "derivation-source", "identity"]),
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

function afterCursorFromUrl(url: URL): FoldConsumerCursor | undefined {
  const sequence = url.searchParams.get("afterSequence");
  if (sequence !== null) {
    if (url.searchParams.has("afterT") || url.searchParams.has("afterEventId") ||
        !/^(0|[1-9][0-9]*)$/.test(sequence) || sequence.length > 19 || BigInt(sequence) > 9223372036854775807n) {
      throw new ApiHttpError(400, "invalid_cursor", "Use one delivery cursor version with a decimal sequence");
    }
    return { version: 2, sequence };
  }
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

async function streamBatch(dependencies: ApiDependencies, tenant: TenantKey, access: FoldSdkAccessContext,
  options: { readonly after?: FoldConsumerCursor; readonly includeDrafts?: boolean; readonly kinds?: readonly string[]; readonly limit: number }) {
  if (dependencies.sdks.streamEntries === undefined) {
    throw new ApiHttpError(501, "delivery_cursor_unavailable", "Store does not implement ingestion-ordered delivery");
  }
  return dependencies.sdks.streamEntries(tenant, access, options);
}

const streamCounts = new WeakMap<ApiDependencies, { total: number; principals: Map<string, number>; tenants: Map<string, number> }>();

/**
 * Delivery mode (default) uses v2 delivery cursors on a poll interval. Explicit `order=ingestion`
 * mode pages `{kind:"ingestion"}` cursors and drains committed backlog without idle waits.
 */
function startEventStream(request: IncomingMessage, response: ServerResponse, dependencies: ApiDependencies,
  tenant: TenantKey, subject: AuthenticatedSubject, initialCursor: FoldConsumerCursor | FoldIngestionCursor | undefined,
  includeDrafts: boolean, kinds: readonly string[] | undefined, ingestion = false): void {
  let counts = streamCounts.get(dependencies);
  if (counts === undefined) { counts = { total: 0, principals: new Map(), tenants: new Map() }; streamCounts.set(dependencies, counts); }
  const countState = counts;
  const principalKey = JSON.stringify([tenant.organizationId, subject.principalId]);
  const tenantKey = JSON.stringify([tenant.organizationId, tenant.workspaceId]);
  const principalCount = counts.principals.get(principalKey) ?? 0;
  const tenantCount = counts.tenants.get(tenantKey) ?? 0;
  if (counts.total >= (dependencies.eventStreamMaxConnections ?? 100) || principalCount >= (dependencies.eventStreamMaxPerPrincipal ?? 5) || tenantCount >= (dependencies.eventStreamMaxPerTenant ?? 25)) {
    throw new ApiHttpError(429, "stream_limit", "Event stream connection limit reached", { retryAfterSeconds: 5 });
  }
  counts.total += 1;
  counts.principals.set(principalKey, principalCount + 1);
  counts.tenants.set(tenantKey, tenantCount + 1);
  response.writeHead(200, { "cache-control": "no-store, no-transform", "connection": "keep-alive",
    "content-type": "text/event-stream; charset=utf-8", "x-accel-buffering": "no", "x-content-type-options": "nosniff" });
  response.write(": connected\n\n");
  let cursor = initialCursor;
  let closed = false;
  let polling = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let backlogTimer: ReturnType<typeof setImmediate> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(pollTimer); clearInterval(heartbeatTimer); clearTimeout(lifetimeTimer);
    clearTimeout(idleTimer); clearImmediate(backlogTimer);
    countState.total -= 1;
    const remaining = (countState.principals.get(principalKey) ?? 1) - 1;
    if (remaining === 0) countState.principals.delete(principalKey); else countState.principals.set(principalKey, remaining);
    const tenantRemaining = (countState.tenants.get(tenantKey) ?? 1) - 1;
    if (tenantRemaining === 0) countState.tenants.delete(tenantKey); else countState.tenants.set(tenantKey, tenantRemaining);
  };
  const fail = (error: unknown) => {
    if (closed) return;
    const failure = asHttpError(error);
    if (failure.status >= 500) dependencies.reportError?.(error);
    response.end(`event: stream-error\ndata: ${JSON.stringify({ status: failure.status, code: failure.code, message: failure.message })}\n\n`);
    close();
  };
  const authorize = async () => {
    const current = await authenticate(request, dependencies);
    if (current.principalId !== subject.principalId || current.credentialId !== subject.credentialId) {
      throw new ApiHttpError(401, "stream_identity_changed", "Event stream identity is no longer valid");
    }
    assertCredentialCapability(current, "events:read");
    const access = await dependencies.memberships.resolveAccess(current, tenant.organizationId, tenant.workspaceId);
    if (access === undefined) throw new ApiHttpError(403, "stream_access_revoked", "Event stream membership was revoked");
    return access;
  };
  const write = async (frame: string) => {
    if (closed || response.destroyed) return;
    if (response.write(frame)) return;
    await new Promise<void>((resolve, reject) => {
      const clean = () => { clearTimeout(timer); response.off("drain", drained); response.off("close", ended); };
      const drained = () => { clean(); resolve(); };
      const ended = () => { clean(); reject(new ApiHttpError(503, "stream_closed", "Event stream closed")); };
      const timer = setTimeout(() => { clean(); reject(new ApiHttpError(503, "stream_slow_consumer", "Event stream consumer is too slow")); }, dependencies.eventStreamDrainTimeoutMs ?? 10_000);
      response.once("drain", drained); response.once("close", ended);
    });
  };
  const poll = async () => {
    if (closed || polling) return;
    polling = true;
    let progressed = false;
    try {
      const access = await authorize();
      const options = { ...(includeDrafts ? { includeDrafts: true } : {}), ...(kinds === undefined ? {} : { kinds }) };
      let entries: readonly FoldLogEntry[];
      let cursors: readonly (FoldDeliveryCursor | FoldIngestionCursor)[];
      let scannedThrough: FoldDeliveryCursor | FoldIngestionCursor | undefined;
      if (ingestion) {
        const batch = await dependencies.sdks.ingestionEntries!(tenant, access, { ...options, limit: 100,
          ...(cursor === undefined ? {} : { after: cursor as FoldIngestionCursor }) });
        entries = batch.items.map(({ entry }) => entry);
        cursors = batch.items.map((item) => item.cursor);
        scannedThrough = batch.scannedThrough;
      } else {
        const batch = await streamBatch(dependencies, tenant, access, { ...options, limit: 500,
          ...(cursor === undefined ? {} : { after: cursor as FoldConsumerCursor }) });
        entries = batch.entries;
        cursors = batch.cursors;
        scannedThrough = batch.scannedThrough;
      }
      let currentAccess = access;
      for (const [index, entry] of entries.entries()) {
        if (closed) break;
        // Reauthorize after every asynchronous drain before the next event leaves the process.
        currentAccess = await authorize();
        if (!authorizeEventAccess(entry.event, currentAccess).allowed) continue;
        await write(`event: fold-event\ndata: ${JSON.stringify({ entry, cursor: cursors[index]! })}\n\n`);
      }
      if (scannedThrough !== undefined) {
        progressed = ingestion && "kind" in scannedThrough && (cursor === undefined ||
          ("kind" in cursor && BigInt(scannedThrough.sequence) > BigInt(cursor.sequence)));
        cursor = scannedThrough;
      }
    } catch (error) { fail(error); }
    finally {
      polling = false;
      if (ingestion && !closed) {
        // A scanned page may contain only denied rows. Continue on scan progress,
        // yielding between bounded pages, until the committed backlog is empty.
        if (progressed) {
          backlogTimer = setImmediate(() => { backlogTimer = undefined; void poll(); });
          backlogTimer.unref();
        } else {
          idleTimer = setTimeout(() => { idleTimer = undefined; void poll(); }, dependencies.eventStreamPollMs ?? DEFAULT_EVENT_STREAM_POLL_MS);
          idleTimer.unref();
        }
      }
    }
  };
  const pollTimer = ingestion ? undefined : setInterval(() => void poll(), dependencies.eventStreamPollMs ?? DEFAULT_EVENT_STREAM_POLL_MS);
  const heartbeatTimer = setInterval(() => {
    if (!closed && !polling && response.writableLength === 0) response.write(`: heartbeat ${Date.now()}\n\n`);
  }, EVENT_STREAM_HEARTBEAT_MS);
  const lifetimeTimer = setTimeout(() => fail(new ApiHttpError(503, "stream_rotation", "Reconnect to renew the event stream")), dependencies.eventStreamMaxAgeMs ?? 15 * 60_000);
  pollTimer?.unref(); heartbeatTimer.unref(); lifetimeTimer.unref();
  request.once("close", close); response.once("close", close);
  void poll();
}

function parsedRecallRequest(input: unknown): RecallRequest {
  const parsed = recallRequestSchema.parse(input);
  return {
    ...(parsed.scope === undefined ? {} : { scope: parsed.scope }),
    ...(parsed.includeNeedsReview === undefined ? {} : { includeNeedsReview: parsed.includeNeedsReview }),
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

function normalizedApplicability(
  applicability: z.infer<typeof memoryApplicabilityInputSchema> | undefined,
  projectIds: readonly string[] | undefined,
  patch: boolean,
): z.infer<typeof memoryApplicabilitySchema> | undefined {
  const ids = projectIds === undefined ? undefined : [...new Set(projectIds)];
  if (applicability === undefined) {
    if (!patch || ids === undefined) return undefined;
    if (ids.length === 0) throw new ApiHttpError(400, "invalid_applicability", "Clearing projectIds requires explicit general or unresolved applicability");
    return { kind: "projects", projectIds: ids };
  }
  if (typeof applicability !== "string") {
    return applicability.kind === "projects" ? { kind: "projects", projectIds: [...new Set(applicability.projectIds)] } : applicability;
  }
  if (applicability === "project") {
    if (ids === undefined || ids.length === 0) throw new ApiHttpError(400, "invalid_applicability", "project applicability requires at least one projectId");
    return { kind: "projects", projectIds: ids };
  }
  if (ids !== undefined && ids.length > 0) throw new ApiHttpError(400, "invalid_applicability", `${applicability} applicability requires empty projectIds`);
  // A string-alias reclassification must clear existing project IDs explicitly rather than implicitly.
  if (patch && ids === undefined) throw new ApiHttpError(400, "invalid_applicability", `${applicability} reclassification requires explicit empty projectIds`);
  return applicability === "general" ? { kind: "global" } : { kind: "unresolved" };
}

function parsedValidity(input: z.infer<typeof memoryPatchSchema> | z.infer<typeof memoryInputSchema> | z.infer<typeof memoryCandidateInputSchema>, patch = false) {
  const applicability = normalizedApplicability(input.applicability, input.projectIds, patch);
  return { ...(applicability === undefined ? {} : { applicability }), ...(input.sourceMemoryRefs === undefined ? {} : { sourceMemoryRefs: input.sourceMemoryRefs }), ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }), ...(input.contradicts === undefined ? {} : { contradicts: input.contradicts }) };
}

function parsedMemoryEvidence(input: z.infer<typeof memoryCandidateEvidenceSchema>) {
  return {
    eventId: input.eventId,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    ...(input.relation === undefined ? {} : { relation: input.relation }),
  };
}

function parsedMemoryInput(input: z.infer<typeof memoryInputSchema>): MemoryInput {
  return {
    ...parsedValidity(input),
    id: input.id,
    source: input.source,
    ...(input.spaceId === undefined ? {} : { spaceId: input.spaceId }),
    ...(input.audience === undefined ? {} : { audience: input.audience }),
    ...(input.projectIds === undefined ? {} : { projectIds: [...new Set(input.projectIds)] }),
    ...(input.summary === undefined ? {} : { summary: input.summary }),
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.tags === undefined ? {} : { tags: input.tags }),
    ...(input.entities === undefined ? {} : { entities: input.entities }),
    ...(input.evidence === undefined ? {} : { evidence: input.evidence.map(parsedMemoryEvidence) }),
  };
}

function parsedMemoryCandidateInput(input: z.infer<typeof memoryCandidateInputSchema>): MemoryCandidateInput {
  const { applicability: _applicability, ...rest } = input;
  return { ...rest, ...parsedValidity(input), ...(input.projectIds === undefined ? {} : { projectIds: [...new Set(input.projectIds)] }) } as MemoryCandidateInput;
}

function parsedMemoryPatch(input: z.infer<typeof memoryPatchSchema>): MemoryRevisionPatch {
  return {
    ...parsedValidity(input, true),
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
    ...(url.searchParams.has("includeNeedsReview") ? { includeNeedsReview: url.searchParams.get("includeNeedsReview") === "true" } : {}),
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

function routeCapability(resource: string | undefined, resourceId: string | undefined, method: string, subresource?: string): ApiCapability | undefined {
  if (resource === "identities") return method === "GET" ? (resourceId === "projects" ? "transcripts:read" : "events:read") : "organization:admin";
  if (resource === "repository-enrollments" || resource === "audit-log" || resource === "identity-bindings" || resource === "identity-audit-log") return "organization:admin";
  if (resource === "event-stream" || resource === "projection" || resource === "data-quality") return "events:read";
  if (resource === "events") return method === "GET" ? "events:read" : "events:write";
  if (resource === "work-episodes" && resourceId === "synthesize") return "reasoning:read";
  if (resource === "work-episodes" || resource === "work-episode-windows") return method === "GET" ? "memories:read" : "memories:write";
  if (resource === "consumers") return method === "GET" ? "consumers:read" : "consumers:write";
  if (resource === "trajectory-tasks") return method === "GET" ? "trajectories:read" : subresource === "outcomes" ? "task-outcomes:write" : subresource === "interventions" ? "task-interventions:write" : "trajectories:write";
  if (resource === "trajectories") return "trajectories:write";
  if (resource === "trajectory-outcomes") return method === "GET" ? "trajectories:read" : "trajectories:review";
  if (resource === "fleet") return "fleet:read";
  if (resource === "transcript-projects" || resource === "transcript-runs" || resource === "transcript-evidence-origins") return "transcripts:read";
  if (resource === "transcript-imports") return "transcripts:write";
  if (resource === "transcript-derivations") return method === "GET" ? "transcripts:read" : "transcripts:write";
  if (resource === "steering") return method === "GET" ? "steering:read" : "steering:write";
  if (resource === "reasoning") return "reasoning:read";
  if (resource === "memory-feedback-batches" || (resource === "memories" && subresource === "feedback" && method === "POST")) return "feedback:write";
  if (resource === "evaluation-sources") return "memories:read";
  if (resource === "memories" && (resourceId === "recall" || resourceId === "search")) return "memories:read";
  if (resource === "memories" || resource?.startsWith("memory-candidate") === true) {
    return method === "GET" ? "memories:read" : "memories:write";
  }
  return undefined;
}

function sdkSelectionForResource(resource: string | undefined, resourceId: string | undefined, method: string) {
  if (resource === "work-episodes" || resource === "work-episode-windows") return { kinds: ["work.episode-window-recorded", "memory.recorded", "memory.revised", "memory.forgotten", "transcript.project-recorded", "transcript.artifact-imported", "transcript.run-imported"] } as const;
  if (resource === "identities") {
    if (method === "GET" || !["alias-preview", "aliases"].includes(resourceId ?? "")) return { kinds: ["identity.revised", "transcript.project-recorded"] } as const;
    return { kindPrefixes: ["identity.", "memory."], kinds: ["transcript.project-recorded", "transcript.run-imported", "transcript.artifact-imported"] } as const;
  }
  // Memory writes validate cited evidence against arbitrary canonical events at append time,
  // so they load the complete authorized view rather than a memory-only selection.
  if (method !== "GET" && (resource === "memories" || resource?.startsWith("memory-") === true)) return undefined;
  if (resource === "memories" || resource?.startsWith("memory-") === true || resource === "reasoning") {
    return { kindPrefixes: ["memory.", "identity."], ...(resource?.startsWith("memory-candidate") === true ? { kinds: ["transcript.project-recorded"] } : {}) } as const;
  }
  if (resource === "transcript-projects" || (resource === "transcript-runs" && resourceId === undefined)) {
    return {
      kinds: ["identity.revised", "transcript.project-recorded", "transcript.run-imported", "transcript.artifact-imported"],
    } as const;
  }
  if (resource === "transcript-runs" && resourceId !== undefined) {
    return { kinds: ["transcript.project-recorded", "transcript.artifact-imported", "transcript.run-imported", "transcript.chunk-imported"], transcriptRunId: resourceId } as const;
  }
  if (resource === "transcript-derivations") {
    return { kinds: ["transcript.project-recorded", "transcript.artifact-imported", "transcript.run-imported"] } as const;
  }
  if (resource === "transcript-imports") {
    return { kinds: ["transcript.project-recorded", "transcript.artifact-imported", "transcript.run-imported", "transcript.chunk-imported"] } as const;
  }
  if (resource?.startsWith("transcript-") === true) {
    return { kindPrefixes: ["transcript."] } as const;
  }
  // Trajectory routes join task evidence whose acceptance sources may be any canonical event kind;
  // a trajectory-only selection would hide them, so these routes load the complete authorized view.
  if (resource === "trajectory-tasks" || resource === "trajectories" || resource === "trajectory-outcomes") return undefined;
  if (resource === "fleet") {
    return {
      kinds: ["lifecycle", "terminal.observation", "terminal.classification"],
      latestBySession: true,
    } as const;
  }
  if (resource === "steering") {
    return { kindPrefixes: ["drive.", "intention."] } as const;
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
  "data-quality",
  "projection",
  "memories",
  "trajectory-tasks",
  "fleet",
  "transcript-projects",
  "transcript-runs",
  "transcript-derivations",
  "steering",
]);

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  dependencies: ApiDependencies,
  allowedOrigins: ReadonlySet<string> | undefined,
  requestSignal: AbortSignal,
): Promise<void> {
  const method = request.method ?? "";
  const url = new URL(request.url ?? "/", "http://localhost");
  if (applyCorsPolicy(request, response, allowedOrigins)) return;
  if (url.pathname === "/health") {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    sendJson(response, 200, { status: "ok" });
    return;
  }
  if (url.pathname === "/ready") {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const readiness = await dependencies.operations?.readiness();
    // Public readiness discloses only availability, never dependency details.
    sendJson(response, readiness?.status === "ready" ? 200 : 503, { status: readiness?.status ?? "unavailable" });
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
  applyAuthorizedRateLimit(response, dependencies.principalRateLimiter, JSON.stringify([subject.organizationId ?? "unbound", subject.principalId]));
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
  applyAuthorizedRateLimit(response, dependencies.tenantRateLimiter, JSON.stringify([access.organizationId, workspaceId]));
  if (resource === "operations" && resourceSegments.length === 1 && method === "GET") {
    if (!subject.capabilities?.includes("operations:read") || (access.organizationRole !== "owner" && access.organizationRole !== "admin")) {
      throw new ApiHttpError(403, "operations_access_denied", "Operations diagnostics require an explicit operator credential and current organization administration access");
    }
    if (dependencies.operations?.diagnostics === undefined) throw new ApiHttpError(503, "operations_unavailable", "Operations diagnostics are unavailable");
    const result = await dependencies.operations.diagnostics({ organizationId: access.organizationId, workspaceId });
    const current = await authenticate(request, dependencies);
    const currentAccess = await dependencies.memberships.resolveAccess(current, access.organizationId, workspaceId);
    if (!current.capabilities?.includes("operations:read") || (currentAccess?.organizationRole !== "owner" && currentAccess?.organizationRole !== "admin")) throw new ApiHttpError(403, "operations_access_denied", "Operations access was revoked");
    sendJson(response, 200, result);
    return;
  }
  if (resource === "identity" && resourceSegments.length === 1 && method === "GET") {
    sendJson(response, 200, { principalId: subject.principalId, organizationId: access.organizationId, workspaceId: access.workspaceId, workspaceRole: access.workspaceRole, spaceRoles: access.spaceRoles, capabilities: subject.capabilities ?? API_CAPABILITIES, ...(subject.taskEvidenceAuthority === undefined ? {} : { taskEvidenceAuthority: subject.taskEvidenceAuthority }), ...(access.platformDataAccess === true ? { platformDataAccess: true } : {}) });
    return;
  }
  const provenance = (operation: "recall" | "search" | "reasoning", memories: readonly { readonly memory: { readonly id: string; readonly revision: number } }[], ranking: { readonly id: string; readonly kind: "lexical" | "semantic" | "explicit" }, provider?: { readonly id: string; readonly configRevision?: string }) => ({ version: 1 as const, recallId: randomUUID(), subject: { principalId: subject.principalId, organizationId: access.organizationId, workspaceId: access.workspaceId }, observedAt: new Date().toISOString(), operation, ranking, ...(provider === undefined ? {} : { provider }), items: memories.map(({ memory }, index) => ({ memoryId: memory.id, memoryRevision: memory.revision, rank: index + 1 })) });
  const tenant = { organizationId: access.organizationId, workspaceId };
  const sdk = await dependencies.sdks.sdkFor(tenant, sdkSelectionForResource(resource, resourceId, method));
  if (access.platformDataAccess !== true) {
    assertCredentialCapability(subject, routeCapability(resource, resourceId, method, resourceSegments[2]));
  }
  if (resource === "evaluation-sources" && resourceId === "selection" && resourceSegments.length === 2) {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const body = evaluationSourceSelectionSchema.parse(await readJsonBody(request, maxBodyBytes));
    if (body.references.some((reference) => reference.kind === "event")) assertCredentialCapability(subject, "trajectories:read");
    const freshAccess = organizationId === undefined ? await dependencies.memberships.resolveLegacyAccess(subject, workspaceId) : await dependencies.memberships.resolveAccess(subject, organizationId, workspaceId);
    if (freshAccess === undefined) throw new ApiHttpError(403, "workspace_access_denied", "Workspace access denied");
    if (body.expectedSubject.principalId !== subject.principalId || body.expectedSubject.organizationId !== freshAccess.organizationId || body.expectedSubject.workspaceId !== freshAccess.workspaceId) throw new ApiHttpError(409, "evaluation_subject_changed", "Evaluation sources belong to a different authenticated account");
    const selection = await sdk.selectEvaluationSources(freshAccess, body);
    const responseAccess = organizationId === undefined ? await dependencies.memberships.resolveLegacyAccess(subject, workspaceId) : await dependencies.memberships.resolveAccess(subject, organizationId, workspaceId);
    if (responseAccess === undefined) throw new ApiHttpError(403, "workspace_access_denied", "Workspace access denied");
    if (projectionAccessKey(responseAccess, "canon") !== projectionAccessKey(freshAccess, "canon")) throw new ApiHttpError(403, "evaluation_access_changed", "Evaluation source access changed while reading; select sources again");
    sendJson(response, 200, selection);
    return;
  }
  if (resource === "work-episodes" || resource === "work-episode-windows") {
    assertCredentialCapability(subject, "events:read");
    if (resourceId === "synthesize" && resource === "work-episodes" && method === "POST" && resourceSegments.length === 2) {
      const result = await handleEpisodeSynthesis({ sdk, access, input: await readJsonBody(request, maxBodyBytes), reasoners: dependencies.reasoners, reasoner: dependencies.reasoner,
        refreshAccess: async () => {
          const refreshed = await authenticate(request, dependencies);
          if (refreshed.principalId !== subject.principalId) throw new ApiHttpError(403, "workspace_access_denied", "Workspace access denied");
          assertCredentialCapability(refreshed, "events:read"); assertCredentialCapability(refreshed, "reasoning:read");
          const current = await dependencies.memberships.resolveAccess(refreshed, tenant.organizationId, workspaceId);
          if (current === undefined) throw new ApiHttpError(403, "workspace_access_denied", "Workspace access denied");
          return current;
        } });
      sendJson(response, 200, result); return;
    }
    const result = await handleEpisodeRecords({ sdk, access, author: subject.author, method, segments: resourceSegments, url,
      ...(method === "POST" ? { input: await readJsonBody(request, maxBodyBytes) } : {}) });
    sendJson(response, result.status, result.body); return;
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
    const order = url.searchParams.get("order") ?? "source";
    if (order !== "source" && order !== "ingestion") throw new ApiHttpError(400, "invalid_query", "stream order must be source or ingestion");
    if (order === "ingestion") {
      // Source-time cursors cannot position an ingestion stream. Like the default stream, a legacy
      // afterT/afterEventId request replays once from the ingestion origin; it never mixes cursor kinds.
      const legacySourceCursor = afterCursorFromUrl(url);
      const legacyReplay = legacySourceCursor !== undefined && !("version" in legacySourceCursor);
      if (dependencies.sdks.ingestionEntries === undefined || dependencies.sdks.latestIngestionCursor === undefined) throw new ApiHttpError(501, "ingestion_stream_unavailable", "Ingestion-order streams require a supported durable store");
      const rawSequence = url.searchParams.get("afterSequence");
      let after = rawSequence === null || legacyReplay ? undefined : ingestionCursorSchema.parse({ kind: "ingestion", sequence: rawSequence });
      const head = await dependencies.sdks.latestIngestionCursor(tenant, access, { ...(includeDrafts ? { includeDrafts: true } : {}), ...(kinds === undefined ? {} : { kinds }) });
      // A cursor may be beyond the visible head after access revocation. It must still be
      // within the committed workspace log; durable commit validation enforces that bound.
      if (after === undefined && !legacyReplay && replayFromUrl(url) === "tail") after = head;
      startEventStream(request, response, dependencies, tenant, subject, after, includeDrafts, kinds, true);
      return;
    }
    let after = afterCursorFromUrl(url);
    if (after === undefined && replayFromUrl(url) === "tail") {
      if (dependencies.sdks.latestEventCursor !== undefined) {
        after = await dependencies.sdks.latestEventCursor(tenant, access, {
          ...(includeDrafts ? { includeDrafts: true } : {}),
          ...(kinds === undefined ? {} : { kinds }),
        });
      } else {
        throw new ApiHttpError(501, "delivery_cursor_unavailable", "Store does not implement ingestion-ordered delivery");
      }
    }
    startEventStream(
      request,
      response,
      dependencies,
      tenant,
      subject,
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
    const order = url.searchParams.get("order") ?? "source";
    if (order !== "source" && order !== "ingestion") throw new ApiHttpError(400, "invalid_query", "consumer order must be source or ingestion");
    if (order === "ingestion") {
      if (dependencies.sdks.ingestionConsumerStatus === undefined || dependencies.sdks.commitIngestionCursor === undefined || dependencies.sdks.migrateConsumerCursor === undefined) throw new ApiHttpError(501, "ingestion_consumers_unavailable", "Ingestion consumers require a supported durable store");
      const scopedConsumerId = JSON.stringify([subject.principalId, resourceId]);
      const options = { ...(includeFromUrl(url) === "canon+draft" ? { includeDrafts: true } : {}), ...(url.searchParams.has("kind") ? { kinds: url.searchParams.getAll("kind") } : {}) };
      if (method === "POST") {
        const body = ingestionConsumerBodySchema.parse(await readJsonBody(request, maxBodyBytes));
        if ("migration" in body) await dependencies.sdks.migrateConsumerCursor(tenant, scopedConsumerId);
        else if ("reset" in body) {
          if (!canSteer(access)) throw new ApiHttpError(403, "workspace_admin_required", "Cursor reset requires workspace administrator access");
          if (dependencies.sdks.resetConsumerCursor === undefined) throw new ApiHttpError(501, "cursor_reset_unavailable", "This store does not support audited cursor resets");
          await dependencies.sdks.resetConsumerCursor(tenant, scopedConsumerId, subject.principalId, body.reset.expectedCursor, body.reset.reason);
        }
        else {
          await dependencies.sdks.commitIngestionCursor(tenant, scopedConsumerId, body.cursor);
          sendJson(response, 200, { consumerId: resourceId, cursor: body.cursor });
          return;
        }
      } else if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
      const status = await dependencies.sdks.ingestionConsumerStatus(tenant, access, scopedConsumerId, options);
      sendJson(response, 200, { consumerId: resourceId, ...status });
      return;
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

  if (resource === "identities") {
    if (resourceSegments.length > 2) throw new ApiHttpError(404, "not_found", "Identity resource not found");
    const canManage = access.platformDataAccess !== true && ["owner", "admin"].includes(access.workspaceRole) && subject.author.kind === "human" &&
      (subject.capabilities === undefined || subject.capabilities.includes("organization:admin"));
    if (method === "GET") {
      const snapshot = await sdk.identities(access);
      const meta = { revision: snapshot.revision, scope: snapshot.scope, canManage };
      if (resourceId === undefined) {
        sendJson(response, 200, { ...meta, counts: { entities: snapshot.entities.length, attributions: snapshot.attributions.length, aliases: snapshot.aliases.length, projects: snapshot.projects.length } });
        return;
      }
      if (!["entities", "attributions", "aliases", "history", "projects"].includes(resourceId) || resourceSegments.length !== 2) throw new ApiHttpError(404, "not_found", "Identity resource not found");
      const rawActive = url.searchParams.get("active");
      const active = rawActive === null ? undefined : z.enum(["true", "false"]).parse(rawActive) === "true";
      const rawKind = url.searchParams.get("kind");
      const kind = rawKind === null ? undefined : z.enum(["person", "account", "agent", "machine"]).parse(rawKind);
      let rows: readonly { readonly id: string; readonly at: number; readonly item: unknown }[];
      if (resourceId === "entities") rows = snapshot.entities.filter((item) => (kind === undefined || item.kind === kind) && (active === undefined || item.active === active)).map((item) => ({ id: item.id, at: item.recordedAt, item }));
      else if (resourceId === "attributions") rows = snapshot.attributions.filter((item) => active === undefined || item.active === active).map((item) => ({ id: item.entityId, at: item.recordedAt, item: { ...item, entityLabel: snapshot.entities.find(({ id }) => id === item.entityId)?.label, personLabel: snapshot.entities.find(({ id }) => id === item.personId)?.label } }));
      else if (resourceId === "aliases") rows = snapshot.aliases.filter((item) => active === undefined || item.active === active).map((item) => ({ id: item.aliasProjectId, at: item.recordedAt, item: { ...item, aliasProjectName: snapshot.projects.find(({ id }) => id === item.aliasProjectId)?.name, canonicalProjectName: snapshot.projects.find(({ id }) => id === item.canonicalProjectId)?.name } }));
      else if (resourceId === "projects") rows = snapshot.projects.map((item) => ({ id: item.id, at: 0, item }));
      else rows = snapshot.history.map((item) => ({ id: item.eventId, at: item.recordedAt, item }));
      const page = pagedNewestFirst([...rows].sort((a, b) => b.at - a.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)), "identity", positiveIntegerQuery(url, "limit", 100) ?? 100, pageCursorFromUrl(url, "identity"), (row) => row.at, (row) => `${resourceId}:${row.id}`);
      sendJson(response, 200, { ...meta, items: page.items.map(({ item }) => item), total: page.total, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
      return;
    }
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    if (!canManage) throw new ApiHttpError(403, "identity_admin_required", "Identity changes require a workspace administrator");
    const body = await readJsonBody(request, maxBodyBytes);
    const expectedRevisionSchema = z.string().min(1).max(500).nullable();
    if (resourceId === "alias-preview") {
      const parsed = z.object({ input: projectAliasInputSchema }).strict().parse(body);
      sendJson(response, 200, await sdk.previewProjectAlias(access, parsed.input));
      return;
    }
    if (resourceId === "entities") {
      const parsed = z.object({ expectedRevision: expectedRevisionSchema, input: identityEntityInputSchema }).strict().parse(body);
      const result = await sdk.reviseIdentity({ access, author: subject.author }, parsed.expectedRevision, { kind: "entity", input: parsed.input });
      sendJson(response, 201, { ...result, entity: { ...result.record.input, eventId: result.record.eventId, recordedAt: result.record.recordedAt, actorId: result.record.actorId } });
      return;
    }
    if (resourceId === "attributions") {
      const parsed = z.object({ expectedRevision: expectedRevisionSchema, input: identityAttributionInputSchema }).strict().parse(body);
      const result = await sdk.reviseIdentity({ access, author: subject.author }, parsed.expectedRevision, { kind: "attribution", input: parsed.input });
      sendJson(response, 201, { ...result, attribution: { ...result.record.input, eventId: result.record.eventId, recordedAt: result.record.recordedAt, actorId: result.record.actorId } });
      return;
    }
    if (resourceId === "aliases") {
      const parsed = z.object({ expectedRevision: expectedRevisionSchema, previewToken: z.string().regex(/^[a-f0-9]{64}$/), input: projectAliasInputSchema }).strict().parse(body);
      const result = await sdk.reviseIdentity({ access, author: subject.author }, parsed.expectedRevision, { kind: "project-alias", input: parsed.input }, parsed.previewToken);
      sendJson(response, 201, { ...result, alias: { ...result.record.input, eventId: result.record.eventId, recordedAt: result.record.recordedAt, actorId: result.record.actorId } });
      return;
    }
    throw new ApiHttpError(404, "not_found", "Identity resource not found");
  }

  if (resource === "events" && resourceId !== undefined) {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const entry = dependencies.sdks.eventById === undefined
      ? (await sdk.listEntries(access, { include: "canon" })).find(({ event }) => event.id === resourceId)
      : await dependencies.sdks.eventById(tenant, access, resourceId);
    if (entry === undefined || entry.status !== "canon") throw new ApiHttpError(404, "event_unavailable", "Event is unavailable");
    sendJson(response, 200, { entry });
    return;
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
      if (order === "desc" && limit !== undefined && dependencies.sdks.eventPage !== undefined && !url.searchParams.has("eventId")) {
        if (pageCursor !== undefined && typeof pageCursor.key !== "number") {
          throw new ApiHttpError(400, "invalid_cursor", "Event page cursor is invalid");
        }
        const identity: Partial<Record<"session" | "run" | "project" | "agent", string>> = {};
        const identityQueries = {
          session: "sessionId",
          run: "runId",
          project: "projectId",
          agent: "actorId",
        } as const;
        for (const [identityKey, queryKey] of Object.entries(identityQueries) as [keyof typeof identityQueries, string][]) {
          const value = url.searchParams.get(queryKey);
          if (value !== null) identity[identityKey] = value;
        }
        const before = pageCursor === undefined
          ? undefined
          : { t: pageCursor.key as number, eventId: pageCursor.id };
        const page = await dependencies.sdks.eventPage(tenant, access, {
          ...(include === "canon+draft" ? { includeDrafts: true } : {}),
          ...(url.searchParams.has("kind") ? { kinds: url.searchParams.getAll("kind") } : {}),
          limit,
          ...(before === undefined ? {} : { before }),
          ...(Object.keys(identity).length === 0 ? {} : { identity }),
        });
        sendJson(response, 200, {
          entries: page.entries,
          total: page.total,
          ...(page.nextCursor === undefined ? {} : {
            nextCursor: encodePageCursor({ kind: "event", key: page.nextCursor.t, id: page.nextCursor.eventId }),
          }),
        });
        return;
      }
      let entries = await sdk.listEntries(access, {
        ...(include === undefined ? {} : { include }),
        ...(cursor === undefined ? {} : { cursor }),
        ...(url.searchParams.has("kind") ? { kinds: url.searchParams.getAll("kind") } : {}),
      });
      if (url.searchParams.has("eventId")) {
        const ids = new Set(z.array(z.string().trim().min(1).max(500)).min(1).max(1000).parse(url.searchParams.getAll("eventId")));
        entries = entries.filter(({ event }) => ids.has(event.id));
      }
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

  if (resource === "data-quality" && resourceId === undefined) {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const storedReport = await dependencies.sdks.dataQuality?.(tenant, access);
    if (storedReport !== undefined) {
      sendJson(response, 200, { report: storedReport });
      return;
    }
    const entries = await sdk.listEntries(access, { include: "canon" });
    sendJson(response, 200, {
      report: buildDataQualityReport(entries.map(({ event }) => event)),
    });
    return;
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
        appliedEventCount: cached.appliedEventCount,
        appliedChangeCount: cached.appliedChangeCount,
      };
      sendJson(response, 200, {
        entries: [],
        total: cached.appliedEventCount,
        projected: cached.appliedEventCount,
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

  if (resource === "transcript-evidence-origins" && resourceId === undefined) {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const body = z.object({ references: z.array(memoryCandidateEvidenceSchema).max(100) }).strict().parse(await readJsonBody(request, maxBodyBytes));
    sendJson(response, 200, { origins: await sdk.transcriptEvidenceOrigins(access, body.references.map(parsedMemoryEvidence)) });
    return;
  }
  if (resource === "trajectory-tasks" && resourceId !== undefined && resourceSegments.length === 3 && resourceSegments[2] !== "tree") {
    const operation = resourceSegments[2];
    if (operation === "evidence" && method === "GET") {
      const state = await sdk.taskEvidence(access, resourceId);
      const items = [
        ...[...state.tasks.values()].map((task) => ({ id: `task:${task.taskVersion}`, kind: "task" as const, task })),
        ...[...state.attempts.values()].map((attempt) => ({ id: `attempt:${attempt.attemptId}`, kind: "attempt" as const, attempt })),
        ...state.records.flatMap((record) => record.recordType === "outcome" || record.recordType === "intervention" ? [{ id: `${record.recordType}:${record.input.id}`, kind: "evidence" as const, record }] : []),
      ].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
      const page = pagedNewestFirst(items, "task-evidence", positiveIntegerQuery(url, "limit", 1_000) ?? 100, pageCursorFromUrl(url, "task-evidence"), () => 0, (item) => item.id);
      sendJson(response, 200, { ...page, evidenceAvailability: "reference-only" }); return;
    }
    if (method !== "POST" || !["manifests", "attempts", "outcomes", "interventions"].includes(operation!)) throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const inputSchema = operation === "manifests" ? taskManifestSchema : operation === "attempts" ? attemptManifestSchema : operation === "outcomes" ? taskOutcomeInputSchema : taskInterventionInputSchema;
    const body = z.object({ stamp: stampSchema, spaceId: z.string().trim().min(1).max(500).optional(), captureIdentity: trajectoryCaptureIdentitySchema.optional(), input: inputSchema }).strict().parse(await readJsonBody(request, maxBodyBytes));
    if (body.input.taskId !== resourceId) throw new ApiHttpError(400, "invalid_task", "Task path must match input task");
    const context = trajectoryContext(subject, access, body.spaceId, body.captureIdentity);
    if (body.spaceId !== undefined && access.spaceRoles[body.spaceId] !== "writer" && access.spaceRoles[body.spaceId] !== "admin") throw new ApiHttpError(403, "task_write_denied", "Task writes require space writer access");
    let result;
    if (operation === "manifests") result = await sdk.recordTaskManifest(context, body.stamp, taskManifestSchema.parse(body.input) as TaskManifest);
    else if (operation === "attempts") result = await sdk.recordAttemptManifest(context, body.stamp, attemptManifestSchema.parse(body.input) as AttemptManifest);
    else {
      const evidenceAuthority = subject.taskEvidenceAuthority;
      if (evidenceAuthority === undefined || (operation === "interventions" && evidenceAuthority.kind !== "human")) throw new ApiHttpError(403, "task_evidence_authority_required", "This credential is not configured for this evidence authority");
      if (operation === "outcomes") {
        const input = taskOutcomeInputSchema.parse(body.input);
        if (input.kind === "acceptance" && evidenceAuthority.kind !== "human") throw new ApiHttpError(403, "human_acceptance_required", "Machine reporters cannot assert human acceptance");
        result = await sdk.recordTaskOutcome({ ...context, evidenceAuthority }, body.stamp, input);
      } else result = await sdk.recordTaskIntervention({ ...context, evidenceAuthority }, body.stamp, taskInterventionInputSchema.parse(body.input));
    }
    sendJson(response, 201, result); return;
  }
  if (resource === "trajectory-tasks" && resourceId === undefined) {
    if (method === "GET") {
      const limit = positiveIntegerQuery(url, "limit", 1_000);
      const cursor = pageCursorFromUrl(url, "trajectory");
      const compact = url.searchParams.get("compact") === "true";
      if (dependencies.sdks.trajectoryTasks !== undefined) {
        if (cursor !== undefined && typeof cursor.key !== "number") {
          throw new ApiHttpError(400, "invalid_cursor", "Trajectory cursor is invalid");
        }
        const page = await dependencies.sdks.trajectoryTasks(tenant, access, {
          limit: limit ?? 1_000,
          ...(cursor === undefined
            ? {}
            : { before: { lastRecordedAt: cursor.key as number, taskId: cursor.id } }),
        });
        const tasks = [];
        if (!compact) {
          // Page before replay: full-detail callers must not rebuild every tree.
          const details = new Map((await sdk.trajectoryTasks(access)).map((task) => [task.taskId, task]));
          for (const summary of page.tasks) {
            const detail = details.get(summary.taskId);
            if (detail !== undefined) tasks.push(detail);
          }
        }
        sendJson(response, 200, {
          tasks: compact ? page.tasks : tasks,
          total: page.total,
          ...(page.nextCursor === undefined
            ? {}
            : {
                nextCursor: encodePageCursor({
                  kind: "trajectory",
                  key: page.nextCursor.lastRecordedAt,
                  id: page.nextCursor.taskId,
                }),
              }),
        });
        return;
      }
      const tasks = await sdk.trajectoryTasks(access);
      const page = pagedNewestFirst(
        tasks,
        "trajectory",
        limit,
        cursor,
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

  if (resource === "transcript-derivations") {
    if (method === "GET" && resourceId === "sources") {
      const sources = await sdk.transcriptReprocessingSources(access);
      const page = pagedNewestFirst(sources.sort((a, b) => a.run.id < b.run.id ? -1 : a.run.id > b.run.id ? 1 : 0), "derivation-source", positiveIntegerQuery(url, "limit", 1_000) ?? 100, pageCursorFromUrl(url, "derivation-source"), () => 0, (item) => item.run.id);
      sendJson(response, 200, { sources: page.items, total: page.total, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
      return;
    }
    if (method === "POST" && resourceId === undefined) {
      if (!canSteer(access)) throw new ApiHttpError(403, "transcript_import_access_denied", "Transcript import access denied");
      const body = z.union([z.object({ manifest: transcriptDerivationManifestSchema }).strict(), z.object({ chunk: transcriptDerivationChunkSchema }).strict()]).parse(await readJsonBody(request, maxBodyBytes));
      const runId = "manifest" in body ? body.manifest.runId : body.chunk.runId;
      const runSdk = await dependencies.sdks.sdkFor(tenant, { kinds: ["transcript.project-recorded", "transcript.artifact-imported", "transcript.run-imported", "transcript.derivation-recorded", "transcript.derivation-chunk-recorded"], transcriptRunId: runId });
      const result = await runSdk.recordTranscriptDerivation({ access, author: { kind: "ingest", id: `transcript-reprocessor:${subject.principalId}` }, capture: { scope: { workspace: access.workspaceId }, identity: { source: "archive-reprocessing" } } }, body);
      sendJson(response, result.imported ? 201 : 200, result);
      return;
    }
    if (method === "GET") {
      const runId = url.searchParams.get("runId");
      if (!runId) throw new ApiHttpError(400, "invalid_query", "runId is required");
      const runSdk = await dependencies.sdks.sdkFor(tenant, { kinds: ["transcript.project-recorded", "transcript.artifact-imported", "transcript.run-imported", "transcript.derivation-recorded", "transcript.derivation-chunk-recorded"], transcriptRunId: runId });
      const derivations = await runSdk.transcriptDerivations(access, runId);
      const limit = positiveIntegerQuery(url, "limit", 1_000) ?? 100;
      if (resourceId === undefined) {
        const page = pagedNewestFirst(derivations.sort((a, b) => b.recordedAt - a.recordedAt || a.derivationId.localeCompare(b.derivationId)), "derivation", limit, pageCursorFromUrl(url, "derivation"), (item) => item.recordedAt, (item) => item.derivationId);
        sendJson(response, 200, { derivations: page.items.map(({ chunks, ...item }) => ({ ...item, storedChunks: chunks.length })), total: page.total, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
      } else {
        const derivation = derivations.find((item) => item.derivationId === resourceId);
        if (derivation === undefined) throw new ApiHttpError(404, "derivation_unavailable", "Transcript derivation is unavailable");
        const records = derivation.chunks.flatMap((chunk) => chunk.records);
        const page = pagedNewestFirst(records, "derived-record", limit, pageCursorFromUrl(url, "derived-record"), (item) => -item.ordinal, (item) => String(item.ordinal));
        sendJson(response, 200, { records: page.items, total: page.total, complete: derivation.complete, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
      }
      return;
    }
    throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
  }

  if (resource === "transcript-imports" && resourceId === undefined) {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    if (!canSteer(access)) {
      throw new ApiHttpError(403, "transcript_import_access_denied", "Transcript import access denied");
    }
    const bundle = transcriptImportBundleSchema.parse(await readJsonBody(request, maxBodyBytes));
    // Keep global identity/conflict metadata, but load action payloads only for the
    // original run and the deterministic snapshot that this import could create.
    const snapshotSuffix = `:snapshot:${bundle.artifact.sha256.slice(0, 16)}`;
    const importSdk = await dependencies.sdks.sdkFor(tenant, {
      kinds: ["transcript.project-recorded", "transcript.artifact-imported", "transcript.run-imported", "transcript.chunk-imported"],
      transcriptChunkRunIds: [bundle.run.id, `${bundle.run.id.slice(0, 500 - snapshotSuffix.length)}${snapshotSuffix}`],
    });
    const result = await importSdk.importTranscript(
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
    if (body.memoryIds !== undefined && body.memoryRefs !== undefined) throw new ApiHttpError(400, "invalid_request", "Use memoryRefs or memoryIds, not both");
    if (body.memoryRefs !== undefined && new Set(body.memoryRefs.map(({ memoryId }) => memoryId)).size !== body.memoryRefs.length) throw new ApiHttpError(400, "invalid_request", "memoryRefs must name each memory once");
    // Project aliases resolve to their canonical identities without rewriting source IDs.
    const reasoningProjectIds = body.projectIds === undefined ? undefined : await sdk.resolveProjectFilter(access, body.projectIds);
    const explicitMemoryIds = body.memoryRefs?.map(({ memoryId }) => memoryId) ?? (body.memoryIds === undefined ? undefined : [...new Set(body.memoryIds)]);
    const ranked = explicitMemoryIds === undefined
      ? await sdk.rankMemories(access, {
          query: body.question,
          ...(body.includeNeedsReview === undefined ? {} : { includeNeedsReview: body.includeNeedsReview }),
          ...(body.scope === undefined ? {} : { scope: body.scope }),
          ...(body.tags === undefined ? {} : { tags: body.tags }),
          ...(body.sources === undefined ? {} : { sources: body.sources }),
          ...(body.projectIds === undefined ? {} : { projectIds: body.projectIds }),
          ...(body.from === undefined ? {} : { from: body.from }),
          ...(body.to === undefined ? {} : { to: body.to }),
          limit: body.limit ?? 5,
        }, dependencies.memoryRanker ?? new LocalLexicalMemoryRanker(), { signal: requestSignal })
      : await (async () => {
          const memories = body.memoryRefs !== undefined ? await sdk.memoryRevisions(access, body.memoryRefs, body.includeNeedsReview === true) : await Promise.all(explicitMemoryIds.map((memoryId) => sdk.memoryById(access, memoryId)));
          // Explicit evidence must satisfy the same recall filters as ranked recall; currentness is checked below.
          const eligible = recallMemoryCorpus({
            memories: new Map(memories.flatMap((memory) => memory === undefined ? [] : [[memory.id, memory]])),
            forgotten: new Map(),
          }, access, {
            includeNeedsReview: true,
            ...(body.scope === undefined ? {} : { scope: body.scope }),
            ...(body.tags === undefined ? {} : { tags: body.tags }),
            ...(body.sources === undefined ? {} : { sources: body.sources }),
            ...(reasoningProjectIds === undefined ? {} : { projectIds: reasoningProjectIds }),
            ...(body.from === undefined ? {} : { from: body.from }),
            ...(body.to === undefined ? {} : { to: body.to }),
          });
          const eligibleIds = new Set(eligible.map((memory) => memory.id));
          if (memories.some((memory) => memory === undefined) || explicitMemoryIds.some((memoryId) => !eligibleIds.has(memoryId))) {
            throw new ApiHttpError(404, "reasoning_memory_unavailable", "One or more reasoning memories are unavailable");
          }
          if (body.includeNeedsReview !== true && memories.some((memory) => memory?.currentness?.status !== "current")) throw new ApiHttpError(409, "memory_needs_review", "Reasoning requires current memory revisions");
          return {
            memories: memories.map((memory) => ({ memory: memory!, score: undefined })),
            ranking: { id: "explicit-memory-set-v1", kind: "explicit" as const, corpusSize: memories.length },
          };
        })();
    const evidence = ranked.memories.map(({ memory, score }) => ({
      memoryId: memory.id,
      revision: memory.revision,
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
    if (body.providerConfigRevision !== undefined && reasoner.descriptor.configRevision !== body.providerConfigRevision) throw new ApiHttpError(409, "reasoning_config_changed", "Reasoning provider configuration changed");
    requestSignal.throwIfAborted();
    const result = validateReasoningResult(await reasoner.answer({ question: body.question, evidence, signal: requestSignal, ...(steering === undefined ? {} : { steering }) }), evidence);
    const freshAccess = organizationId === undefined ? await dependencies.memberships.resolveLegacyAccess(subject, workspaceId) : await dependencies.memberships.resolveAccess(subject, organizationId, workspaceId);
    if (freshAccess === undefined) throw new ApiHttpError(403, "workspace_access_denied", "Workspace access denied");
    await sdk.memoryRevisions(freshAccess, evidence.map(({ memoryId, revision }) => ({ memoryId, revision })), body.includeNeedsReview === true);
    const reasoningProvenance = provenance("reasoning", ranked.memories, ranked.ranking, reasoner.descriptor);
    // Best-effort version 2 "offered" delivery record for each cited exact revision. Delivery is not
    // adoption or validation, and recording failure never changes the answer.
    const recalled = new Set(result.citations);
    let recalledAt = Date.now();
    for (const [index, { memory }] of ranked.memories.entries()) {
      if (!recalled.has(memory.id)) continue;
      try {
        await sdk.recordMemoryFeedback(
          memoryContext(subject, freshAccess, memory.spaceId, memory.audience),
          {
            id: `reasoning-recall:${randomUUID()}`,
            t: recalledAt++,
            worldDate: new Date(recalledAt - 1).toISOString().slice(0, 10),
          },
          memory.id,
          {
            version: 2,
            signal: "offered",
            memoryRevision: memory.revision,
            recallId: reasoningProvenance.recallId,
            rank: index + 1,
            ranking: { id: ranked.ranking.id, kind: ranked.ranking.kind },
            provider: { id: reasoner.descriptor.id, ...(reasoner.descriptor.configRevision === undefined ? {} : { configRevision: reasoner.descriptor.configRevision }) },
            detail: `Cited by ${reasoner.descriptor.id}`,
          },
        );
      } catch (error) {
        dependencies.reportError?.(error);
      }
    }
    sendJson(response, 200, {
      ...result,
      provenance: reasoningProvenance,
      citationRefs: result.citations.map((memoryId) => ({ memoryId, revision: evidence.find((item) => item.memoryId === memoryId)!.revision })),
      provider: reasoner.descriptor,
      ...("feedback" in ranked ? { feedback: ranked.feedback } : {}),
      ranking: ranked.ranking,
      evidence: evidence.map(({ memoryId, revision, source, summary, score }) => ({
        memoryId,
        revision,
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

  if (resource === "trajectory-tasks" && resourceId !== undefined && resourceSegments.length === 3 && resourceSegments[2] === "tree") {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const record = await sdk.trajectoryTree(access, resourceId);
    if (record === undefined) throw new TrajectoryTaskUnavailableError(resourceId);
    sendJson(response, 200, { record });
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

  if (resource === "trajectory-outcomes" && resourceId === undefined) {
    if (method === "POST") {
      if (subject.author.kind !== "human") throw new ApiHttpError(403, "operator_required", "Outcome review requires an operator credential");
      const body = trajectoryOutcomeBodySchema.parse(await readJsonBody(request, maxBodyBytes));
      const result = await sdk.recordTrajectoryOutcome(trajectoryContext(subject, access, undefined), body.stamp, body.input);
      sendJson(response, 201, result);
      return;
    }
    if (method === "GET") {
      const taskId = url.searchParams.get("taskId");
      const trajectoryId = url.searchParams.get("trajectoryId");
      if (!taskId || !trajectoryId) throw new ApiHttpError(400, "invalid_query", "taskId and trajectoryId are required");
      const records = await sdk.trajectoryOutcomes(access, taskId, trajectoryId);
      const page = pagedNewestFirst([...records].sort((a, b) => b.recordedAt - a.recordedAt || a.eventId.localeCompare(b.eventId)),
        "trajectory-outcome", positiveIntegerQuery(url, "limit", 1_000) ?? 100,
        pageCursorFromUrl(url, "trajectory-outcome"), (record) => record.recordedAt, (record) => record.eventId);
      sendJson(response, 200, { records: page.items, total: page.total, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) });
      return;
    }
    throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
  }

  if (resource === "trajectories" && resourceId === undefined) {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const body = trajectoryRecordSchema.parse(await readJsonBody(request, maxBodyBytes));
    const input = parsedTrajectoryInput(body.input);
    const result = await sdk.recordTrajectory(
      trajectoryContext(subject, access, body.spaceId, body.captureIdentity),
      body.stamp,
      input,
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
      const requestedProjects = new Set(await sdk.resolveProjectFilter(access, url.searchParams.getAll("projectId")));
      const storedCandidates = await dependencies.sdks.memoryCandidates?.(tenant, access);
      const candidates = storedCandidates === undefined
        ? await sdk.memoryCandidates(access, {
            ...(status === undefined ? {} : { status }),
            ...(requestedProjects.size === 0 ? {} : { projectIds: [...requestedProjects] }),
          })
        : storedCandidates
            .filter((view) => status === undefined || view.status === status)
            .filter((view) => matchesMemoryProjects(view.candidate, [...requestedProjects]));
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
      if (view === undefined) {
        throw new ApiHttpError(404, "memory_candidate_unavailable", `Memory candidate ${acceptance.candidateId} is unavailable`);
      }
      if (view.candidate.audience !== body.audience || view.candidate.spaceId !== body.spaceId) {
        throw new ApiHttpError(400, "candidate_batch_scope_mismatch", "Every candidate must match the batch audience and space");
      }
    }
    if (body.audience === "workspace" && !canSteer(access)) throw new ApiHttpError(403, "shared_memory_review_access_denied", "Workspace memory review requires an owner or admin role");
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
    if (action !== "accept" && action !== "reject" && action !== "evidence") {
      throw new ApiHttpError(404, "not_found", "Route not found");
    }
    const view = (await sdk.memoryCandidates(access)).find(({ candidate }) => candidate.id === resourceId);
    if (view === undefined) {
      throw new ApiHttpError(404, "memory_candidate_unavailable", "Memory candidate is unavailable");
    }
    if (action !== "evidence" && view.candidate.audience === "workspace" && !canSteer(access)) throw new ApiHttpError(403, "shared_memory_review_access_denied", "Workspace memory review requires an owner or admin role");
    const context = memoryContext(subject, access, view.candidate.spaceId, view.candidate.audience);
    if (action === "evidence") {
      const raw = await readJsonBody(request, maxBodyBytes);
      const rawInput = typeof raw === "object" && raw !== null && "input" in raw ? (raw as { input?: unknown }).input : undefined;
      if (typeof rawInput === "object" && rawInput !== null && "id" in rawInput) {
        // Equivalent-proposal support: an undecided candidate absorbs evidence from a proposal with the same meaning and scope.
        if (view.status !== "proposed") throw new ApiHttpError(404, "memory_candidate_unavailable", "Memory candidate is unavailable");
        const body = memoryCandidateSupportSchema.parse(raw);
        sendJson(response, 200, await sdk.addMemoryCandidateEvidence(context, body.stamp, resourceId, parsedMemoryCandidateInput(body.input)));
        return;
      }
      const body = memoryContributionSchema.parse(raw);
      if (body.input.expectedRevision !== undefined) throw new ApiHttpError(400, "invalid_request", "Pending candidate contributions do not accept a memory revision");
      sendJson(response, 201, await sdk.contributeMemoryCandidateEvidence(context, body.stamp, resourceId, { evidence: body.input.evidence.map(parsedMemoryEvidence) }));
    } else if (action === "accept") {
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
    const memories = await sdk.recallMemories(access, recall);
    sendJson(response, 200, { memories, provenance: provenance("recall", memories, { id: "chronological-current-v1", kind: "explicit" }) });
    return;
  }

  if (resource === "memories" && resourceId === "search") {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const recall = parsedRankedRecallRequest(await readJsonBody(request, maxBodyBytes));
    const ranker = dependencies.memoryRanker ?? new LocalLexicalMemoryRanker();
    const result = await sdk.rankMemories(access, recall, ranker, { signal: requestSignal });
    const freshAccess = organizationId === undefined ? await dependencies.memberships.resolveLegacyAccess(subject, workspaceId) : await dependencies.memberships.resolveAccess(subject, organizationId, workspaceId);
    if (freshAccess === undefined) throw new ApiHttpError(403, "workspace_access_denied", "Workspace access denied");
    await sdk.memoryRevisions(freshAccess, result.memories.map(({ memory }) => ({ memoryId: memory.id, revision: memory.revision })), recall.includeNeedsReview === true);
    sendJson(response, 200, { ...result, provenance: provenance("search", result.memories, result.ranking) });
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
      const { limit, ...originalFilters } = recall;
      const filters = { ...originalFilters, ...(originalFilters.projectIds === undefined ? {} : { projectIds: await sdk.resolveProjectFilter(access, originalFilters.projectIds) }) };
      const storedMemories = await dependencies.sdks.memories?.(tenant, access);
      const page = storedMemories === undefined
        ? await sdk.recallMemoryPage(access, {
            ...filters,
            ...(limit === undefined ? {} : { limit }),
            ...(memoryCursor === undefined ? {} : { cursor: memoryCursor }),
          })
        : (() => {
            const corpus = recallMemoryCorpus({
              memories: new Map(storedMemories.map((memory) => [memory.id, memory])),
              forgotten: new Map(),
            }, access, filters);
            const remaining = memoryCursor === undefined
              ? corpus
              : corpus.filter((memory) => memory.createdAt < memoryCursor.createdAt || (memory.createdAt === memoryCursor.createdAt && memory.id > memoryCursor.memoryId));
            const items = remaining.slice(0, limit ?? 100);
            const last = items.at(-1);
            return {
              memories: items.map((memory) => ({ memory })),
              total: corpus.length,
              ...(last !== undefined && remaining.length > items.length ? { nextCursor: { createdAt: last.createdAt, memoryId: last.id } } : {}),
            };
          })();
      sendJson(response, 200, {
        memories: page.memories,
        provenance: provenance("recall", page.memories, { id: "memory-inventory-v1", kind: "explicit" }),
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

  if (resource === "memory-feedback-batches" && resourceSegments.length === 1) {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const body = memoryFeedbackBatchSchema.parse(await readJsonBody(request, maxBodyBytes));
    if (body.expectedSubject.organizationId !== access.organizationId || body.expectedSubject.workspaceId !== access.workspaceId || body.expectedSubject.principalId !== subject.principalId) throw new ApiHttpError(409, "feedback_subject_changed", "Queued feedback belongs to a different authenticated account");
    sendJson(response, 201, await sdk.recordMemoryFeedbackBatch(memoryContext(subject, access, undefined), body.stamp, body.items, body.expectedSubject));
    return;
  }

  if (resource === "memories" && resourceId !== undefined && resourceSegments.length === 3) {
    const action = decodeSegment(resourceSegments[2]!, "memory action");
    if (action === "evidence") {
      if (method === "GET") {
        const options = z.object({ revision: z.coerce.number().int().nonnegative().safe().optional(), contributionOffset: z.coerce.number().int().nonnegative().safe().optional(), offset: z.coerce.number().int().nonnegative().safe().optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict().parse(Object.fromEntries(url.searchParams));
        sendJson(response, 200, await sdk.memoryEvidencePage(access, resourceId, { ...(options.contributionOffset === undefined ? {} : { contributionOffset: options.contributionOffset }), ...(options.revision === undefined ? {} : { revision: options.revision }), ...(options.offset === undefined ? {} : { offset: options.offset }), ...(options.limit === undefined ? {} : { limit: options.limit }) }));
        return;
      }
      if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
      const scope = await sdk.memoryMutationScope(access, resourceId);
      if (scope === undefined) throw new PersonalMemoryUnavailableError(resourceId);
      const body = memoryContributionSchema.parse(await readJsonBody(request, maxBodyBytes));
      sendJson(response, 201, await sdk.contributeMemoryEvidence(memoryContext(subject, access, scope.spaceId, scope.audience), body.stamp, resourceId, { evidence: body.input.evidence.map(parsedMemoryEvidence), ...(body.input.expectedRevision === undefined ? {} : { expectedRevision: body.input.expectedRevision }) }));
      return;
    }
    if (action === "feedback" && method === "GET") {
      const revision = z.coerce.number().int().nonnegative().safe().optional().parse(url.searchParams.get("revision") ?? undefined);
      sendJson(response, 200, { summary: await sdk.memoryFeedbackSummary(access, resourceId, revision) }); return;
    }
    if (action !== "feedback") throw new ApiHttpError(404, "not_found", "Route not found");
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const current = await sdk.memoryMutationScope(access, resourceId);
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
    const current = await sdk.memoryMutationScope(access, resourceId);
    if (current === undefined) throw new PersonalMemoryUnavailableError(resourceId);
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
          body.expectedRevision,
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
  for (const value of [dependencies.eventStreamMaxConnections, dependencies.eventStreamMaxPerPrincipal, dependencies.eventStreamMaxPerTenant]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new TypeError("Event stream limits must be positive integers");
  }
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
    const startedAt = performance.now();
    response.once("finish", () => dependencies.operations?.observeResponse?.(response.statusCode, performance.now() - startedAt));
    const controller = new AbortController();
    const abort = () => { if (!response.writableEnded) controller.abort(new Error("API caller disconnected")); };
    request.once("aborted", abort); response.once("close", abort);
    void handleRequest(request, response, dependencies, allowedOrigins, controller.signal).catch((error: unknown) => {
      const httpError = asHttpError(error);
      if (httpError.status === 500) dependencies.reportError?.(error);
      if (!response.headersSent) sendError(response, httpError);
      else response.destroy();
    }).finally(() => { request.off("aborted", abort); response.off("close", abort); });
  });
  server.requestTimeout = DEFAULT_REQUEST_TIMEOUT_MS;
  server.headersTimeout = DEFAULT_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = DEFAULT_KEEP_ALIVE_TIMEOUT_MS;
  server.maxRequestsPerSocket = 1_000;
  return server;
}
