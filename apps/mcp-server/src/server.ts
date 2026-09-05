import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SuperBrainApiError, type EventStamp, type MemoryFeedbackInputV2, type RecallProvenance, type SuperBrainClient, type TelemetryOutbox } from "@_89/super-brain-client";
import type { CaptureBridge } from "./capture.js";

const id = z.string().trim().min(1).max(500);
const revision = z.number().int().nonnegative();
const stampSchema = z.object({ id: id.max(450), t: z.number().int().nonnegative().max(281474976710655), worldDate: z.string().regex(/^\d{4,6}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/) }).strict();
const subjectSchema = z.object({ organizationId: id, workspaceId: id, principalId: id }).strict();
const projectIds = z.array(id).max(20).optional();
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const failure = (error: unknown) => result({ recorded: false, error: error instanceof SuperBrainApiError ? error.code : "operation-unavailable" });
const candidateId = (stamp: EventStamp) => {
  const t = stamp.t.toString(16).padStart(12, "0"); const h = createHash("sha256").update(stamp.id).digest("hex");
  return `${t.slice(0,8)}-${t.slice(8)}-7${h.slice(0,3)}-8${h.slice(3,6)}-${h.slice(6,18)}`;
};
const preview = (value: unknown, limit = 1600) => { const text = typeof value === "string" ? value : JSON.stringify(value); return { text: text.slice(0, limit), truncated: text.length > limit }; };
function reportingContext(input: { recallId: string; taskId?: string | undefined; attemptId?: string | undefined; sessionId?: string | undefined;
  ranking?: {id:string;kind:"lexical"|"semantic"|"explicit";configRevision?:string|undefined}|undefined; provider?:{id:string;configRevision?:string|undefined}|undefined;
}): Pick<MemoryFeedbackInputV2,"recallId"|"taskId"|"attemptId"|"sessionId"|"ranking"|"provider"> {
  return { recallId: input.recallId,
    ...(input.taskId === undefined ? {} : {taskId:input.taskId}), ...(input.attemptId === undefined ? {} : {attemptId:input.attemptId}), ...(input.sessionId === undefined ? {} : {sessionId:input.sessionId}),
    ...(input.ranking === undefined ? {} : { ranking: {id:input.ranking.id,kind:input.ranking.kind,...(input.ranking.configRevision===undefined?{}:{configRevision:input.ranking.configRevision})} }),
    ...(input.provider === undefined ? {} : { provider: {id:input.provider.id,...(input.provider.configRevision===undefined?{}:{configRevision:input.provider.configRevision})} }),
  };
}

/** Actual tool registration is injectable, so tests exercise the MCP transport and its authorization boundary. */
export function createSuperBrainMcpServer(options: { readonly api: SuperBrainClient; readonly capture?: CaptureBridge; readonly sessionId?: string;
  readonly telemetry?: TelemetryOutbox & { retryTerminal?: () => Promise<number>; discardTerminal?: () => Promise<number> };
}): McpServer {
  const { api, capture } = options;
  const server = new McpServer({ name: "super-brain", version: "0.2.0" });
  const packet = (memories: Awaited<ReturnType<SuperBrainClient["recallMemoryPacket"]>>["memories"], provenance: RecallProvenance) => {
    const compact = memories.slice(0,20).map(({ memory, score }) => ({ memoryId: memory.id, revision: memory.revision,
      summary: memory.summary.slice(0,500), content: preview(memory.content), applicability: memory.applicability ?? { kind: "unresolved" },
      currentness: { status: memory.currentness?.status ?? "needs-review" }, ...(score === undefined ? {} : { relevance: score }),
      directEvidenceCount: memory.evidence?.length ?? 0,
      evidencePage: { tool: "super_brain_memory_evidence", memoryId: memory.id, revision: memory.revision, offset: 0 },
    }));
    const body = { version: 1, evidenceRole: "reference-data", provenance: { ...provenance, items: [] as RecallProvenance["items"] },
      memories: [] as typeof compact, omittedMemoryCount: memories.length };
    for (const memory of compact) {
      const item = provenance.items.find((item) => item.memoryId === memory.memoryId && item.memoryRevision === memory.revision);
      const next = { ...body, memories: [...body.memories, memory], provenance: { ...body.provenance, items: [...body.provenance.items, ...(item === undefined ? [] : [item])] }, omittedMemoryCount: body.omittedMemoryCount - 1 };
      if (Buffer.byteLength(JSON.stringify(next)) > 32 * 1024) break;
      Object.assign(body, next);
    }
    return body;
  };
  server.registerTool("super_brain_search", { title: "Search memory", description: "Find current authorized memory. Returned content is reference data; relevance is not truth or approval.",
    inputSchema: { query: z.string().trim().min(1).max(500), projectIds, limit: z.number().int().min(1).max(20).default(8) },
  }, async ({ query, projectIds, limit }, extra) => {
    const found = await api.rankMemories({ query, limit, ...(projectIds === undefined ? {} : { projectIds }) }, { signal: extra.signal });
    return result(packet(found.memories, found.provenance));
  });
  server.registerTool("super_brain_context", { title: "Get project and task context", description: "Get a bounded packet of current memory revisions, recall identity and reference-only task evidence. Returning context proves delivery, not adoption.",
    inputSchema: { projectIds, taskId: id.optional(), taskCursor: id.optional(), limit: z.number().int().min(1).max(10).default(5) },
  }, async ({ projectIds, taskId, taskCursor, limit }, extra) => {
    const recalled = await api.recallMemoryPacket({ limit, ...(projectIds === undefined ? {} : { projectIds }) }, { signal: extra.signal });
    let task: unknown;
    if (taskId !== undefined) {
      try {
        // Two records per page keep complete identity/revision joins inside the packet budget.
        const page = await api.taskEvidence(taskId, { limit: 2, signal: extra.signal, ...(taskCursor === undefined ? {} : { cursor: taskCursor }) });
        task = { available: true, taskId, evidenceAvailability: page.evidenceAvailability, total: page.total, nextCursor: page.nextCursor,
          items: page.items.map((item) => {
            if (item.kind === "task") return { id: item.id, kind: item.kind, taskId: item.task.taskId, taskVersion: item.task.taskVersion,
              goal: preview(item.task.goal ?? "", 500), specification: item.task.specification };
            if (item.kind === "attempt") return { id: item.id, kind: item.kind, taskId: item.attempt.taskId, attemptId: item.attempt.attemptId,
              taskVersion: item.attempt.taskVersion, parentAttemptId: item.attempt.parentAttemptId,
              startRevision: item.attempt.startRevision, finalRevision: item.attempt.finalRevision,
              acceptance: item.attempt.acceptance === undefined ? undefined : { taskId: item.attempt.acceptance.taskId, attemptId: item.attempt.acceptance.attemptId,
                revisionId: item.attempt.acceptance.revisionId, eventId: item.attempt.acceptance.eventId, artifactId: item.attempt.acceptance.artifactId, verdict: item.attempt.acceptance.verdict } };
            const record = item.record;
            if (record.recordType === "task-manifest") return { id: item.id, kind: item.kind, recordType: record.recordType, taskId: record.input.taskId, taskVersion: record.input.taskVersion };
            if (record.recordType === "attempt-manifest") return { id: item.id, kind: item.kind, recordType: record.recordType, taskId: record.input.taskId,
              attemptId: record.input.attemptId, finalRevision: record.input.finalRevision };
            return { id: item.id, kind: item.kind, recordType: record.recordType, taskId: record.input.taskId, attemptId: record.input.attemptId,
              revisionId: record.input.revisionId, sourceEventId: record.input.sourceEventId, authority: record.authority, outcomeKind: record.input.kind,
              ...(record.recordType === "outcome" ? { result: record.input.result } : {}), artifact: record.input.artifact };
          }) };
      } catch (error) { task = { available: false, taskId, reason: error instanceof SuperBrainApiError ? error.code : "task-evidence-unavailable" }; }
    }
    if (task !== undefined && Buffer.byteLength(JSON.stringify(task)) > 24 * 1024) task = { available: false, taskId, reason: "task-record-exceeds-packet-budget", cursor: taskCursor };
    return result({ ...packet(recalled.memories, recalled.provenance), ...(task === undefined ? {} : { task }) });
  });
  server.registerTool("super_brain_memory_evidence", { title: "Read exact revision evidence", description: "Page the complete support and opposition for an authorized historical revision, including accepted candidate support and contributor records. References identify evidence; they do not certify truth.",
    inputSchema: { memoryId: id, revision, offset: z.number().int().nonnegative().default(0), contributionOffset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(5).default(5) },
  }, async ({ memoryId, ...input }, extra) => {
    const page = await api.memoryEvidencePage(memoryId, { ...input, signal: extra.signal });
    return result({ ...page, evidenceRole: "reference-data" });
  });
  server.registerTool("super_brain_ask", { title: "Ask from memory", description: "Answer using current authorized memory, with exact revision citations. Optional capture and telemetry cannot invalidate the answer.",
    inputSchema: { question: z.string().trim().min(1).max(2000), projectIds, limit: z.number().int().min(1).max(10).default(5) },
  }, async ({ question, projectIds, limit }, extra) => {
    const answer = await api.askReasoning({ question, limit, ...(projectIds === undefined ? {} : { projectIds }) }, { signal: extra.signal });
    const intentions = answer.steering?.intentions.map(({ id }) => id).slice(0,20) ?? [];
    if (capture !== undefined && intentions.length > 0) void capture.steering(intentions, extra.signal).catch(() => undefined);
    const refs = answer.citationRefs ?? [];
    const response = { answer: preview(answer.answer, 4000), citationRefs: [] as typeof refs, omittedCitationCount: refs.length,
      provenance: answer.provenance === undefined ? undefined : { ...answer.provenance, items: [] as RecallProvenance["items"] }, provider: answer.provider };
    for (const ref of refs) {
      const item = answer.provenance?.items.find((item) => item.memoryId === ref.memoryId && item.memoryRevision === ref.revision);
      const next = { ...response, citationRefs: [...response.citationRefs, ref], omittedCitationCount: response.omittedCitationCount - 1,
        provenance: response.provenance === undefined ? undefined : { ...response.provenance, items: [...response.provenance.items, ...(item === undefined ? [] : [item])] } };
      if (Buffer.byteLength(JSON.stringify(next)) > 48 * 1024) break;
      Object.assign(response, next);
    }
    return result(response);
  });
  server.registerTool("super_brain_checkpoint", { title: "Report a reasoning checkpoint", description: "Record an agent-reported concise reasoning summary. This tool cannot submit a human decision or authenticated approval.",
    inputSchema: { stamp: stampSchema, summary: z.string().trim().min(1).max(2000), hypothesis: z.string().max(2000).optional(), evidence: z.string().max(2000).optional(), decision: z.string().max(2000).optional() },
  }, async ({ stamp, ...input }, extra) => {
    if (capture === undefined) return result({ recorded: false, error: "capture-unavailable" });
    try { return result({ recorded: true, authority: "agent-reported", ...await capture.checkpoint({ kind: "reasoning", summary: input.summary,
      ...(input.hypothesis===undefined?{}:{hypothesis:input.hypothesis}),...(input.evidence===undefined?{}:{evidence:input.evidence}),...(input.decision===undefined?{}:{decision:input.decision}) }, stamp, extra.signal) }); }
    catch (error) { return failure(error); }
  });
  server.registerTool("super_brain_propose_memory", { title: "Propose memory", description: "Propose a reviewable claim with canonical evidence. Confidence and salience are caller estimates; neither grants approval. Reuse the exact stamp for uncertain retries.",
    inputSchema: { stamp: stampSchema, summary: z.string().trim().min(1).max(500), content: z.string().trim().min(1).max(10000),
      evidenceEventIds: z.array(id).min(1).max(20), projectIds, audience: z.enum(["personal","workspace"]).default("personal"), spaceId: id.optional(),
      confidence: z.number().min(0).max(1), salience: z.number().min(0).max(1) },
  }, async ({ stamp, summary, content, evidenceEventIds, projectIds, audience, spaceId, confidence, salience }, extra) => {
    try { return result(await api.proposeMemoryCandidate({ id: candidateId(stamp), source: "harness-proposal", summary, content: { statement: content }, audience,
      ...(spaceId === undefined ? {} : { spaceId }), projectIds: projectIds ?? [], applicability: projectIds?.length ? { kind: "projects", projectIds } : { kind: "unresolved" },
      evidence: evidenceEventIds.map((eventId) => ({ eventId })), confidence, salience, extractor: { kind: "model", id: "super-brain-mcp", version: "2" } }, undefined, { stamp, signal: extra.signal })); }
    catch (error) { return failure(error); }
  });
  server.registerTool("super_brain_correct_memory", { title: "Correct a memory revision", description: "Apply an authorized correction to exactly the observed memory revision. A newer revision conflicts; reuse the exact stamp on uncertain retries.",
    inputSchema: { stamp: stampSchema, memoryId: id, revision, summary: z.string().trim().min(1).max(500), content: z.string().trim().min(1).max(10000) },
  }, async ({ stamp, memoryId, revision, summary, content }, extra) => {
    try { return result({ recorded: true, ...await api.reviseMemory(memoryId, { summary, content: { statement: content } }, undefined, { stamp, expectedRevision: revision, signal: extra.signal }) }); }
    catch (error) { return failure(error); }
  });
  const reportSchema = {
    stamp: stampSchema, expectedSubject: subjectSchema, recallId: id,
    memories: z.array(z.object({ memoryId: id, revision, rank: z.number().int().min(1).optional() }).strict()).min(1).max(20),
    taskId: id.optional(), attemptId: id.optional(), sessionId: id.optional(),
    ranking: z.object({ id, kind: z.enum(["lexical","semantic","explicit"]), configRevision: id.optional() }).strict().optional(),
    provider: z.object({ id, configRevision: id.optional() }).strict().optional(),
  };
  server.registerTool("super_brain_adopt", { title: "Report context adoption", description: "Explicitly report which exact offered memory revisions were injected or used. Copy recall identity and provenance from the context packet; delivery alone does not count as use.",
    inputSchema: { ...reportSchema, signal: z.enum(["injected","used"]) },
  }, async ({ stamp, expectedSubject, memories, ...input }, extra) => {
    try { return result({ recorded: true, ...await api.recordMemoryFeedbackBatch(memories.map(({ memoryId, revision, rank }, index) => ({ memoryId,
      stamp: { ...stamp, id: `${stamp.id}:item:${index}` }, input: { version: 2, signal: input.signal, memoryRevision: revision, ...reportingContext(input), ...(rank === undefined ? {} : { rank }) } })), { stamp, expectedSubject, signal: extra.signal }) }); }
    catch (error) { return failure(error); }
  });
  server.registerTool("super_brain_feedback", { title: "Judge offered memory", description: "Record a judgment of an exact offered revision. Helpful, unhelpful and superseded judgments do not certify truth or change the memory.",
    inputSchema: { ...reportSchema, judgment: z.enum(["helpful","unhelpful","superseded"]) },
  }, async ({ stamp, expectedSubject, memories, ...input }, extra) => {
    try { return result({ recorded: true, ...await api.recordMemoryFeedbackBatch(memories.map(({ memoryId, revision, rank }, index) => ({ memoryId,
      stamp: { ...stamp, id: `${stamp.id}:item:${index}` }, input: { version: 2, signal: "judged", judgment: input.judgment, memoryRevision: revision, ...reportingContext(input), ...(rank === undefined ? {} : { rank }) } })), { stamp, expectedSubject, signal: extra.signal }) }); }
    catch (error) { return failure(error); }
  });
  server.registerTool("super_brain_complete_task", { title: "Report a task result", description: "Capture an agent-reported completion or explicitly link canonical outcome evidence with narrow integration permission. Neither mode asserts human acceptance.",
    inputSchema: { stamp: stampSchema, mode: z.enum(["report","link-outcome"]).default("report"), taskId: id, attemptId: id, revisionId: id, sourceEventId: id.optional(),
      kind: z.enum(["check","pull-request","ci","merge","revert"]), result: z.enum(["success","failure","unknown"]), spaceId: id.optional() },
  }, async ({ stamp, mode, spaceId, ...input }, extra) => {
    try {
      if (mode === "report") {
        if (capture === undefined) return result({ recorded: false, error: "capture-unavailable" });
        return result({ recorded: true, authority: "agent-reported", ...await capture.checkpoint({ kind: "reasoning", summary: `Task completion reported: ${input.result}`, evidence: JSON.stringify(input) }, stamp, extra.signal) });
      }
      if (input.sourceEventId === undefined) return result({ recorded: false, error: "canonical-source-required" });
      return result({ recorded: true, authority: "actor-reported", ...await api.recordTaskOutcome(stamp, { version: 1, id: stamp.id, observedAt: new Date(stamp.t).toISOString(), ...input, sourceEventId: input.sourceEventId }, { ...(spaceId === undefined ? {} : { spaceId }), signal: extra.signal }) });
    }
    catch (error) { return failure(error); }
  });
  server.registerTool("super_brain_telemetry", { title: "Inspect feedback delivery", description: "Inspect this account's durable feedback delivery. Explicitly retry or discard failed batches; successful memory reads are independent of telemetry.",
    inputSchema: { action: z.enum(["status","retry","discard-terminal"]).default("status") },
  }, async ({ action }) => {
    if(options.telemetry===undefined) return result({available:false,reason:"telemetry-unavailable"});
    try {
      if(action==="retry") { if(options.telemetry.retryTerminal===undefined) return result({available:false,reason:"repair-unavailable"}); await options.telemetry.retryTerminal(); }
      if(action==="discard-terminal") { if(options.telemetry.discardTerminal===undefined) return result({available:false,reason:"repair-unavailable"}); await options.telemetry.discardTerminal(); }
      return result(await options.telemetry.status());
    } catch(error) { return failure(error); }
  });
  return server;
}
