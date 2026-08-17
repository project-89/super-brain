import { authorizeRecall, canAccessSpace, validateAccessContext } from "./access.js";
import { normalizeMemoryTags } from "./events.js";
import type {
  EpistemicAccessContext,
  MemoryProjection,
  PersonalMemory,
  RecallRequest,
  RecalledMemory,
} from "./types.js";
import { assertUuidV7, compareUuidV7 } from "./uuidv7.js";

export const DEFAULT_RECALL_LIMIT = 20;
export const MAX_RECALL_LIMIT = 100;

function validateRequest(request: RecallRequest): number {
  const limit = request.limit ?? DEFAULT_RECALL_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RECALL_LIMIT) {
    throw new TypeError(`recall limit must be an integer within [1, ${MAX_RECALL_LIMIT}]`);
  }
  if (request.from !== undefined && !Number.isFinite(request.from)) {
    throw new TypeError("recall from must be finite");
  }
  if (request.to !== undefined && !Number.isFinite(request.to)) {
    throw new TypeError("recall to must be finite");
  }
  if (request.from !== undefined && request.to !== undefined && request.from > request.to) {
    throw new TypeError("recall from must not exceed to");
  }
  for (const source of request.sources ?? []) {
    if (source.trim().length === 0) throw new TypeError("recall sources must not contain empty values");
  }
  return limit;
}

function matchesScope(memory: PersonalMemory, request: RecallRequest): boolean {
  const scope = request.scope ?? { kind: "all" };
  if (scope.kind === "all") return true;
  if (scope.kind === "workspace") return memory.spaceId === undefined;
  return memory.spaceId === scope.spaceId;
}

function matchesFilters(memory: PersonalMemory, request: RecallRequest): boolean {
  if (!matchesScope(memory, request)) return false;
  const tags = normalizeMemoryTags(request.tags);
  if (tags.length > 0 && !tags.every((tag) => memory.tags.includes(tag))) return false;
  if (request.sources !== undefined && request.sources.length > 0 && !request.sources.includes(memory.source)) {
    return false;
  }
  if (request.from !== undefined && memory.createdAt < request.from) return false;
  if (request.to !== undefined && memory.createdAt > request.to) return false;
  return true;
}

function candidateScores(request: RecallRequest): ReadonlyMap<string, number> | undefined {
  if (request.candidates === undefined) return undefined;
  const scores = new Map<string, number>();
  for (const candidate of request.candidates) {
    assertUuidV7(candidate.memoryId, "semantic candidate memory id");
    if (!Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 1) {
      throw new TypeError("semantic candidate score must be within [0, 1]");
    }
    const current = scores.get(candidate.memoryId);
    if (current === undefined || candidate.score > current) scores.set(candidate.memoryId, candidate.score);
  }
  return scores;
}

export function recallMemories(
  projection: MemoryProjection,
  access: EpistemicAccessContext,
  request: RecallRequest = {},
): RecalledMemory[] {
  validateAccessContext(access);
  const limit = validateRequest(request);
  const scores = candidateScores(request);
  const scope = request.scope;
  if (scope?.kind === "space" && !canAccessSpace(access, scope.spaceId)) return [];
  const recalled: RecalledMemory[] = [];

  for (const memory of projection.memories.values()) {
    if (!authorizeRecall(memory, access).allowed) continue;
    if (!matchesFilters(memory, request)) continue;
    if (scores !== undefined) {
      const score = scores.get(memory.id);
      if (score === undefined) continue;
      recalled.push({ memory, score });
    } else {
      recalled.push({ memory });
    }
  }

  recalled.sort((left, right) => {
    if (scores !== undefined) {
      const scoreOrder = (right.score ?? 0) - (left.score ?? 0);
      if (scoreOrder !== 0) return scoreOrder;
    }
    const timeOrder = right.memory.createdAt - left.memory.createdAt;
    if (timeOrder !== 0) return timeOrder;
    return compareUuidV7(left.memory.id, right.memory.id);
  });
  return recalled.slice(0, limit);
}

export function recallMemoryById(
  projection: MemoryProjection,
  access: EpistemicAccessContext,
  memoryId: string,
): PersonalMemory | undefined {
  validateAccessContext(access);
  assertUuidV7(memoryId, "memory id");
  const memory = projection.memories.get(memoryId);
  return memory !== undefined && authorizeRecall(memory, access).allowed ? memory : undefined;
}
