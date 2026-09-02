import { createHash } from "node:crypto";

import type { TranscriptRun } from "@_89/fold-transcript";

import type { ExtractedCandidate, VaultMessage } from "./types.js";

export const RULE_EXTRACTOR = { kind: "rule", id: "durable-transcript-memory", version: "1" } as const;

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

function candidateId(timestamp: number, identity: string): string {
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
      id: candidateId(timestampFor(run, message), identity),
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
      id: candidateId(timestampFor(run, message), identity),
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
  maxCandidates = 25,
): ExtractedCandidate[] {
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > 500) {
    throw new TypeError("maxCandidates must be an integer within [1, 500]");
  }
  const candidates: ExtractedCandidate[] = [];
  const summaries = new Set<string>();
  for (const message of messages) {
    const extracted = structuredObservations(run, runEventId, message);
    const candidatesForMessage = extracted.length > 0 ? extracted : durableStatements(run, runEventId, message);
    for (const candidate of candidatesForMessage) {
      const key = candidate.summary.toLocaleLowerCase().replace(/\s+/g, " ");
      if (summaries.has(key)) continue;
      summaries.add(key);
      candidates.push(candidate);
      if (candidates.length >= maxCandidates) return candidates;
    }
  }
  return candidates;
}
