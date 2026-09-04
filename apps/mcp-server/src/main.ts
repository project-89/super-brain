#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SuperBrainClient } from "@_89/super-brain-client";
import { z } from "zod";

import { CaptureBridge, type CaptureCheckpoint } from "./capture.js";

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.trim().length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function jsonResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const api = new SuperBrainClient({
  baseUrl: required(process.env.SUPER_BRAIN_URL ?? process.env.FOLD_API_URL, "SUPER_BRAIN_URL"),
  organizationId: process.env.SUPER_BRAIN_ORGANIZATION ?? process.env.FOLD_API_ORGANIZATION ?? "local",
  workspaceId: required(process.env.SUPER_BRAIN_WORKSPACE ?? process.env.FOLD_API_WORKSPACE, "SUPER_BRAIN_WORKSPACE"),
  token: required(process.env.SUPER_BRAIN_TOKEN ?? process.env.FOLD_API_TOKEN, "SUPER_BRAIN_TOKEN"),
  recallTelemetry: {
    ...(process.env.SUPER_BRAIN_SESSION_ID === undefined ? {} : { sessionId: process.env.SUPER_BRAIN_SESSION_ID }),
    ...(process.env.SUPER_BRAIN_TASK_ID === undefined ? {} : { taskId: process.env.SUPER_BRAIN_TASK_ID }),
    detail: "super-brain-mcp",
  },
});

const captureUrl = process.env.SUPER_BRAIN_CAPTURE_URL;
const captureToken = process.env.SUPER_BRAIN_CAPTURE_HOOK_TOKEN;
const rawSource = process.env.SUPER_BRAIN_HARNESS ?? "hermes";
if (rawSource !== "codex" && rawSource !== "claude-code" && rawSource !== "hermes") {
  throw new TypeError("SUPER_BRAIN_HARNESS must be codex, claude-code, or hermes");
}
const capture = captureUrl === undefined || captureToken === undefined
  ? undefined
  : new CaptureBridge({
      baseUrl: captureUrl,
      token: captureToken,
      source: rawSource,
      ...(process.env.SUPER_BRAIN_SESSION_ID === undefined ? {} : { sessionId: process.env.SUPER_BRAIN_SESSION_ID }),
      ...(process.env.SUPER_BRAIN_PROJECT_ROOT === undefined ? {} : { cwd: process.env.SUPER_BRAIN_PROJECT_ROOT }),
    });

const server = new McpServer({ name: "super-brain", version: "0.1.0" });

server.registerTool("super_brain_search", {
  title: "Search Super Brain Memory",
  description: "Search authorized durable memory before planning or making a project decision.",
  inputSchema: {
    query: z.string().trim().min(1).max(500),
    projectIds: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
    tags: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    sources: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
    limit: z.number().int().min(1).max(20).default(8),
  },
}, async ({ query, projectIds, tags, sources, limit }) => {
  const result = await api.rankMemories({
    query,
    limit,
    ...(projectIds === undefined ? {} : { projectIds }),
    ...(tags === undefined ? {} : { tags }),
    ...(sources === undefined ? {} : { sources }),
  });
  return jsonResult(result);
});

server.registerTool("super_brain_context", {
  title: "Ask Super Brain",
  description: "Answer a question from authorized memory and return exact memory citations and ranking provenance.",
  inputSchema: {
    question: z.string().trim().min(1).max(2_000),
    projectIds: z.array(z.string().trim().min(1).max(300)).max(20).optional(),
    actorId: z.string().trim().min(1).max(300).optional(),
    limit: z.number().int().min(1).max(10).default(5),
  },
}, async ({ question, projectIds, actorId, limit }) => {
  const result = await api.askReasoning({
    question,
    limit,
    ...(projectIds === undefined ? {} : { projectIds }),
    ...(actorId === undefined ? {} : { actorId }),
  });
  const intentionIds = result.steering?.intentions.map(({ id }) => id) ?? [];
  if (capture !== undefined && intentionIds.length > 0) await capture.steering(intentionIds);
  return jsonResult(result);
});

server.registerTool("super_brain_checkpoint", {
  title: "Record a Reasoning Checkpoint",
  description: "Record a concise inspectable reasoning summary or explicit human decision in the active task trajectory.",
  inputSchema: {
    kind: z.enum(["reasoning", "human-decision"]).default("reasoning"),
    summary: z.string().trim().min(1).max(2_000),
    hypothesis: z.string().trim().min(1).max(2_000).optional(),
    evidence: z.string().trim().min(1).max(2_000).optional(),
    decision: z.string().trim().min(1).max(2_000).optional(),
    verdict: z.enum(["success", "failure"]).optional(),
    confidence: z.number().finite().min(0).max(1).optional(),
  },
}, async ({ kind, summary, hypothesis, evidence, decision, verdict, confidence }) => {
  if (capture === undefined) {
    throw new Error("checkpoint capture requires SUPER_BRAIN_CAPTURE_URL and SUPER_BRAIN_CAPTURE_HOOK_TOKEN");
  }
  const checkpoint: CaptureCheckpoint = kind === "human-decision"
    ? { kind, summary, ...(verdict === undefined ? {} : { verdict }), ...(confidence === undefined ? {} : { confidence }) }
    : {
        kind,
        summary,
        ...(hypothesis === undefined ? {} : { hypothesis }),
        ...(evidence === undefined ? {} : { evidence }),
        ...(decision === undefined ? {} : { decision }),
        ...(confidence === undefined ? {} : { confidence }),
      };
  return jsonResult(await capture.checkpoint(checkpoint));
});

server.registerTool("super_brain_propose_memory", {
  title: "Propose Super Brain Memory",
  description: "Propose a durable project memory backed by existing canonical event IDs; proposal remains reviewable.",
  inputSchema: {
    summary: z.string().trim().min(1).max(500),
    content: z.string().trim().min(1).max(10_000),
    evidenceEventIds: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    projectIds: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
    tags: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
    confidence: z.number().finite().min(0).max(1).default(0.8),
    salience: z.number().finite().min(0).max(1).default(0.7),
  },
}, async ({ summary, content, evidenceEventIds, projectIds, tags, confidence, salience }) => jsonResult(
  await api.proposeMemoryCandidate({
    source: "harness-proposal",
    summary,
    content: { statement: content },
    projectIds,
    tags,
    evidence: evidenceEventIds.map((eventId) => ({ eventId })),
    confidence,
    salience,
    extractor: { kind: "human", id: "super-brain-mcp", version: "1" },
  }),
));

server.registerTool("super_brain_feedback", {
  title: "Record Memory Feedback",
  description: "Record whether a recalled memory was useful, unhelpful, or superseded for later evaluation and consolidation.",
  inputSchema: {
    memoryId: z.string().trim().min(1).max(500),
    signal: z.enum(["recalled", "helpful", "unhelpful", "superseded"]),
    query: z.string().trim().min(1).max(2_000).optional(),
    taskId: z.string().trim().min(1).max(500).optional(),
    sessionId: z.string().trim().min(1).max(500).optional(),
    detail: z.string().trim().min(1).max(2_000).optional(),
  },
}, async ({ memoryId, signal, query, taskId, sessionId, detail }) => jsonResult(
  await api.recordMemoryFeedback(memoryId, {
    signal,
    ...(query === undefined ? {} : { query }),
    ...(taskId === undefined ? {} : { taskId }),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(detail === undefined ? {} : { detail }),
  }),
));

await server.connect(new StdioServerTransport());
