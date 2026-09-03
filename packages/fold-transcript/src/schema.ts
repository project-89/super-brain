import { z } from "zod";

export const transcriptSourceSchema = z.enum(["claude-code", "codex"]);
export const identityResolutionSchema = z.enum(["resolved", "estimated", "unassigned"]);
const timestampSchema = z.string().datetime({ offset: true });
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const transcriptProjectSchema = z.object({
  id: z.string().trim().min(1).max(300),
  name: z.string().trim().min(1).max(500),
  identityKeyHash: sha256Schema,
  resolution: identityResolutionSchema,
  roots: z.array(z.string().trim().min(1)).max(100),
  remote: z.string().trim().min(1).max(2_000).optional(),
}).strict();

export const transcriptArtifactSchema = z.object({
  id: z.string().trim().min(1).max(300),
  source: transcriptSourceSchema,
  sha256: sha256Schema,
  sourcePathHash: sha256Schema,
  byteLength: z.number().int().nonnegative(),
  mediaType: z.string().trim().min(1).max(200),
  parser: z.object({ id: z.string().trim().min(1), version: z.string().trim().min(1) }).strict(),
  modifiedAt: timestampSchema.optional(),
  contentPolicy: z.enum(["metadata-only", "redacted"]),
  reasoningPolicy: z.enum(["excluded", "included"]).optional(),
  stored: z.boolean(),
  redactionCount: z.number().int().nonnegative(),
}).strict();

export const transcriptContextSegmentSchema = z.object({
  id: z.string().trim().min(1).max(300),
  ordinal: z.number().int().nonnegative(),
  projectId: z.string().trim().min(1).max(300).optional(),
  resolution: identityResolutionSchema,
  cwd: z.string().trim().min(1).optional(),
  repo: z.string().trim().min(1).max(500).optional(),
  branch: z.string().trim().min(1).max(500).optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
}).strict();

export const transcriptRunSchema = z.object({
  id: z.string().trim().min(1).max(500),
  nativeId: z.string().trim().min(1).max(500),
  source: transcriptSourceSchema,
  artifactId: z.string().trim().min(1).max(300),
  projectId: z.string().trim().min(1).max(300).optional(),
  projectResolution: identityResolutionSchema,
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
  cwd: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).max(500).optional(),
  model: z.string().trim().min(1).max(500).optional(),
  clientVersion: z.string().trim().min(1).max(200).optional(),
  counts: z.object({
    records: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    messages: z.number().int().nonnegative(),
    actions: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative(),
  }).strict(),
  segments: z.array(transcriptContextSegmentSchema).max(10_000),
}).strict();

export const transcriptTurnSchema = z.object({
  id: z.string().trim().min(1).max(500),
  ordinal: z.number().int().nonnegative(),
  nativeId: z.string().trim().min(1).max(500).optional(),
  startedAt: timestampSchema.optional(),
  endedAt: timestampSchema.optional(),
  messageCount: z.number().int().nonnegative(),
  actionCount: z.number().int().nonnegative(),
  roles: z.array(z.enum(["user", "assistant", "developer", "system", "tool", "other"])),
}).strict();

export const transcriptActionSchema = z.object({
  id: z.string().trim().min(1).max(500),
  ordinal: z.number().int().nonnegative(),
  turnId: z.string().trim().min(1).max(500).optional(),
  at: timestampSchema.optional(),
  kind: z.enum(["tool-call", "tool-result", "command", "file-change", "test", "other"]),
  name: z.string().trim().min(1).max(500).optional(),
  status: z.enum(["started", "completed", "failed", "unknown"]).optional(),
}).strict();

export const transcriptChunkSchema = z.object({
  runId: z.string().trim().min(1).max(500),
  sequence: z.number().int().nonnegative(),
  turns: z.array(transcriptTurnSchema).max(500),
  actions: z.array(transcriptActionSchema).max(500),
}).strict();

export const transcriptImportBundleSchema = z.object({
  projects: z.array(transcriptProjectSchema).max(10_000),
  artifact: transcriptArtifactSchema,
  run: transcriptRunSchema,
  chunks: z.array(transcriptChunkSchema).max(10_000),
}).strict().superRefine((bundle, context) => {
  if (bundle.run.artifactId !== bundle.artifact.id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["run", "artifactId"], message: "run artifactId must match artifact id" });
  }
  const projectIds = new Set(bundle.projects.map(({ id }) => id));
  if (bundle.run.projectId !== undefined && !projectIds.has(bundle.run.projectId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["run", "projectId"], message: "run projectId must reference a bundled project" });
  }
  bundle.run.segments.forEach((segment, index) => {
    if (segment.projectId !== undefined && !projectIds.has(segment.projectId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["run", "segments", index, "projectId"], message: "segment projectId must reference a bundled project" });
    }
  });
  if (projectIds.size !== bundle.projects.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["projects"], message: "bundled project ids must be unique" });
  }
  bundle.chunks.forEach((chunk, index) => {
    if (chunk.runId !== bundle.run.id) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["chunks", index, "runId"], message: "chunk runId must match run id" });
    }
    if (chunk.sequence !== index) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["chunks", index, "sequence"], message: "chunk sequences must be contiguous from zero" });
    }
  });
});

export type TranscriptSource = z.infer<typeof transcriptSourceSchema>;
export type IdentityResolution = z.infer<typeof identityResolutionSchema>;
export type TranscriptProject = z.infer<typeof transcriptProjectSchema>;
export type TranscriptArtifact = z.infer<typeof transcriptArtifactSchema>;
export type TranscriptContextSegment = z.infer<typeof transcriptContextSegmentSchema>;
export type TranscriptRun = z.infer<typeof transcriptRunSchema>;
export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;
export type TranscriptAction = z.infer<typeof transcriptActionSchema>;
export type TranscriptChunk = z.infer<typeof transcriptChunkSchema>;
export type TranscriptImportBundle = z.infer<typeof transcriptImportBundleSchema>;
