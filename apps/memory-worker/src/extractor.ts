import { createHash } from "node:crypto";

import type { FoldEvent, JsonValue } from "@_89/fold";
import type { TranscriptRun } from "@_89/fold-transcript";

import type { ExtractedCandidate, VaultMessage } from "./types.js";

export const RULE_EXTRACTOR = { kind: "rule", id: "durable-transcript-memory", version: "2" } as const;
export const LIVE_EXTRACTOR = { kind: "rule", id: "live-structured-memory", version: "2" } as const;

/** Explicit v2 extractor contract: provenance locates a claim but is not its meaning.
 * Unknown/custom extractor payloads require exact content equality. */
export function extractedClaimContent(candidate: Pick<ExtractedCandidate, "content" | "source" | "extractor">): JsonValue {
  const content = candidate.content;
  if (content === null || typeof content !== "object" || Array.isArray(content)) return content;
  if (candidate.extractor.kind !== "rule" || candidate.extractor.version !== "2") return content;
  if (candidate.extractor.id === RULE_EXTRACTOR.id && candidate.source === "transcript-rule") {
    const { runId: _run, turnId: _turn, ...claim } = content;
    return claim;
  }
  if (candidate.extractor.id === LIVE_EXTRACTOR.id && ["live-human-decision", "live-reasoning-checkpoint"].includes(candidate.source)) {
    const { evidence: _evidence, artifactId: _artifact, sessionId: _session, turnId: _turn, model: _model, runtime: _runtime, ...claim } = content;
    return claim;
  }
  return content;
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\-\-[\s\S]*?\-\->/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(body: string, name: string): string | undefined {
  const match = body.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  const value = match?.[1] === undefined ? undefined : decodeXml(match[1]);
  return value?.length ? value : undefined;
}

function tags(body: string, name: string): string[] {
  return [...body.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "gi"))]
    .flatMap((match) => match[1] === undefined ? [] : [decodeXml(match[1])])
    .filter(Boolean);
}

export function deterministicCandidateId(timestamp: number, identity: string): string {
  const digest = createHash("sha256").update(identity).digest();
  const bytes = new Uint8Array(16);
  let remaining = Math.max(0, Math.min(0xffffffffffff, Math.floor(timestamp)));
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  bytes.set(digest.subarray(0, 10), 6);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function projectFor(run: TranscriptRun, at: string | undefined): string | undefined {
  if (run.cwd?.includes("/.claude-mem/observer-sessions") === true) return undefined;
  if (at === undefined) return run.projectId;
  const matching = run.segments
    .filter((segment) => segment.startedAt === undefined || segment.startedAt <= at)
    .filter((segment) => segment.endedAt === undefined || at < segment.endedAt)
    .at(-1);
  return matching?.projectId ?? run.projectId;
}

function timestampFor(run: TranscriptRun, message: VaultMessage): number {
  const parsed = Date.parse(message.at ?? run.startedAt ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function evidence(run: TranscriptRun, runEventId: string, message: VaultMessage) {
  const projectId = projectFor(run, message.at);
  return [{
    eventId: runEventId,
    runId: run.id,
    turnId: message.turnId,
    ...(projectId === undefined ? {} : { projectId }),
  }];
}

function structuredObservations(run: TranscriptRun, runEventId: string, message: VaultMessage): ExtractedCandidate[] {
  const observations = [...message.text.matchAll(/<observation>([\s\S]*?)<\/observation>/gi)];
  return observations.flatMap((match, index) => {
    const body = match[1];
    if (body === undefined) return [];
    const title = tag(body, "title");
    if (title === undefined) return [];
    const subtitle = tag(body, "subtitle");
    const narrative = tag(body, "narrative");
    const facts = tags(body, "fact");
    const concepts = tags(body, "concept");
    const files = [...new Set([
      ...tags(body, "file"),
      ...[...body.matchAll(/\/Users\/[A-Za-z0-9_./ -]+/g)].map((path) => path[0].trim()),
      ...(message.projectPath === undefined ? [] : [message.projectPath]),
    ])];
    const type = tag(body, "type");
    const projectId = projectFor(run, message.at);
    const identity = `${RULE_EXTRACTOR.version}\0xml\0${run.id}\0${message.turnId}\0${index}\0${title}\0${narrative ?? ""}`;
    return [{
      id: deterministicCandidateId(timestampFor(run, message), identity),
      projectIds: projectId === undefined ? [] : [projectId],
      source: "claude-mem-observation",
      summary: title.slice(0, 500),
      content: {
        ...(subtitle === undefined ? {} : { subtitle }),
        facts,
        ...(narrative === undefined ? {} : { narrative }),
        ...(files.length === 0 ? {} : { files }),
      },
      tags: [...new Set(["claude-mem", ...(type === undefined ? [] : [type]), ...concepts])],
      evidence: evidence(run, runEventId, message),
      confidence: 0.96,
      salience: 0.9,
      extractor: RULE_EXTRACTOR,
    }];
  });
}

function durableStatements(run: TranscriptRun, runEventId: string, message: VaultMessage): ExtractedCandidate[] {
  const cleaned = message.text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<observation>[\s\S]*?<\/observation>/gi, " ")
    .replace(/\s+/g, " ");
  const sentences = cleaned.split(/(?<=[.!?])\s+|\n+/).map((value) => value.trim());
  const durable = message.role === "user"
    ? /\b(?:we (?:decided|agreed|chose)|i (?:prefer|would like)|decision\s*:|must|should (?:never|not|have no)|do not|don't|from now on)\b/i
    : /\b(?:now (?:uses|supports|stores|requires|allows)|decision\s*:|we (?:decided|agreed|chose)|must|(?:contract|architecture|policy) (?:is|are) now)\b/i;
  return sentences.flatMap((statement, index) => {
    if (statement.length < 40 || statement.length > 500 || statement.includes("?") || !durable.test(statement)) return [];
    if (/^(?:[-*#>]|IMPORTANT|NOTE|Examples?|When |Never |Always |Use |Do not )/i.test(statement)) return [];
    if (message.role === "assistant" && /\bI(?:['’]m|['’]ll|['’]ve| am| will)\b|^We(?:['’]re| are) (?:adding|changing|checking|running|moving|tightening|documenting)/i.test(statement)) return [];
    if (/\b(?:is|are|be) being (?:added|changed|implemented|configured|migrated|tested)\b/i.test(statement)) return [];
    const projectId = projectFor(run, message.at);
    const isPreference = message.role === "user" && /\bi (?:prefer|want|would like)\b/i.test(statement);
    const identity = `${RULE_EXTRACTOR.version}\0statement\0${run.id}\0${message.turnId}\0${index}\0${statement.toLocaleLowerCase()}`;
    return [{
      id: deterministicCandidateId(timestampFor(run, message), identity),
      projectIds: projectId === undefined ? [] : [projectId],
      source: "transcript-rule",
      summary: statement,
      content: { statement, role: message.role, runId: run.id, turnId: message.turnId },
      tags: [isPreference ? "preference" : "durable-statement", message.role],
      evidence: evidence(run, runEventId, message),
      confidence: isPreference ? 0.84 : message.role === "assistant" ? 0.82 : 0.76,
      salience: /\b(?:architecture|security|database|deploy|production|must|decision)\b/i.test(statement) ? 0.85 : 0.65,
      extractor: RULE_EXTRACTOR,
    }];
  });
}

export function extractMemoryCandidates(
  run: TranscriptRun,
  runEventId: string,
  messages: readonly VaultMessage[],
  proposalBudget = 25,
): ExtractedCandidate[] {
  if (!Number.isInteger(proposalBudget) || proposalBudget < 1 || proposalBudget > 500) {
    throw new TypeError("proposalBudget must be an integer within [1, 500]");
  }
  const candidates: ExtractedCandidate[] = [];
  // Budgets govern job dispatch, never how much of the source is examined.
  // Scope/evidence consolidation happens once, at the worker boundary.
  for (const message of messages) {
    if (message.role === "tool") {
      if (message.result === undefined || !/\b(test|lint|build|check|verify|error|fail)\b/i.test(`${message.toolName ?? ""} ${message.text}`)) continue;
      const projectId = projectFor(run, message.at);
      const summary = `${message.toolName ?? "Tool"} verification result: ${message.result}. ${message.text.replace(/\s+/g, " ").trim()}`.slice(0, 500);
      candidates.push({
        id: deterministicCandidateId(timestampFor(run, message), `${RULE_EXTRACTOR.version}\0tool\0${run.id}\0${message.turnId}\0${message.nativeId ?? ""}\0${summary}`),
        projectIds: projectId === undefined ? [] : [projectId], source: "transcript-verification",
        summary, content: { result: message.result, excerpt: message.text.slice(0, 2_000), taskAcceptance: "unknown" },
        tags: ["verification", message.result], evidence: evidence(run, runEventId, message),
        confidence: 0.7, salience: message.result === "failure" ? 0.8 : 0.5, extractor: RULE_EXTRACTOR,
      });
      continue;
    }
    const extracted = structuredObservations(run, runEventId, message);
    const candidatesForMessage = extracted.length > 0 ? extracted : durableStatements(run, runEventId, message);
    candidates.push(...candidatesForMessage);
  }
  return candidates;
}

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function optionalText(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function boundedScore(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

export function extractLiveMemoryCandidates(event: FoldEvent): ExtractedCandidate[] {
  if (event.kind !== "terminal.observation") return [];
  const projectId = event.capture.identity?.repo;
  const sessionId = event.capture.identity?.session;
  const model = event.capture.identity?.model;
  const runtime = event.capture.identity?.runtime;
  const candidates: ExtractedCandidate[] = [];
  for (const change of event.changes) {
    if (change.verb !== "create" || change.nodeKind !== "x.fold.activity-observation") continue;
    const observation = optionalText(change.after.observation);
    if (observation !== "reasoning_checkpoint" && observation !== "human_decision") continue;
    const data = jsonObject(change.after.data);
    const summary = optionalText(data?.summary);
    if (summary === undefined) continue;
    const turnId = optionalText(data?.turnId) ?? event.capture.identity?.turn;
    const artifactId = optionalText(data?.artifactId);
    const verdict = optionalText(data?.verdict);
    const source = observation === "human_decision" ? "live-human-decision" : "live-reasoning-checkpoint";
    const evidence = {
      eventId: event.id,
      ...(projectId === undefined ? {} : { projectId }),
      ...(turnId === undefined ? {} : { turnId }),
    };
    const content: Record<string, JsonValue> = {
      summary,
      evidence: [evidence],
      ...(optionalText(data?.hypothesis) === undefined ? {} : { hypothesis: optionalText(data?.hypothesis)! }),
      ...(optionalText(data?.evidence) === undefined ? {} : { supportingEvidence: optionalText(data?.evidence)! }),
      ...(optionalText(data?.decision) === undefined ? {} : { decision: optionalText(data?.decision)! }),
      ...(verdict === undefined ? {} : { verdict }),
      ...(artifactId === undefined ? {} : { artifactId }),
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(turnId === undefined ? {} : { turnId }),
      ...(model === undefined ? {} : { model }),
      ...(runtime === undefined ? {} : { runtime }),
    };
    candidates.push({
      id: deterministicCandidateId(event.at.t, `${LIVE_EXTRACTOR.version}\0${observation}\0${event.id}`),
      ...(event.capture.scope.space === undefined ? {} : { spaceId: event.capture.scope.space }),
      projectIds: projectId === undefined ? [] : [projectId],
      source,
      summary: summary.slice(0, 500),
      content,
      tags: [observation === "human_decision" ? "human-decision" : "reasoning-checkpoint", ...(verdict === undefined ? [] : [verdict])],
      evidence: [evidence],
      confidence: boundedScore(data?.confidence, observation === "human_decision" ? 1 : 0.75),
      salience: observation === "human_decision" ? 1 : 0.8,
      extractor: LIVE_EXTRACTOR,
    });
  }
  return candidates;
}
