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
  FoldSdkError,
  PersonalMemoryUnavailableError,
  type FoldSdkAccessContext,
  type FoldSdkCursor,
} from "@_89/fold-sdk";
import { JournalError } from "@_89/fold-storage";
import { z, ZodError } from "zod";

import type {
  ApiDependencies,
  AuthenticatedSubject,
} from "./types.js";

const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

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
  if (error instanceof FoldSdkAccessError) {
    return new ApiHttpError(403, "access_denied", "Capture scope access denied");
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
    (error instanceof Error && (error.name === "MemoryEventError" || error.name === "EpistemicAccessError"))
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
): Promise<void> {
  const method = request.method ?? "";
  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname === "/health") {
    if (method !== "GET") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    sendJson(response, 200, { status: "ok" });
    return;
  }

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

  if (resource === "memories" && resourceId === "recall") {
    if (method !== "POST") throw new ApiHttpError(405, "method_not_allowed", "Method not allowed");
    const recall = parsedRecallRequest(await readJsonBody(request, maxBodyBytes));
    sendJson(response, 200, { memories: await sdk.recallMemories(access, recall) });
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
  return createServer((request, response) => {
    void handleRequest(request, response, dependencies).catch((error: unknown) => {
      const httpError = asHttpError(error);
      if (httpError.status === 500) dependencies.reportError?.(error);
      if (!response.headersSent) sendError(response, httpError);
      else response.destroy();
    });
  });
}
