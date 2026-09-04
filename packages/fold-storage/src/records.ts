import {
  eventSchema,
  jsonValueSchema,
  type FoldLogEntry,
} from "@_89/fold";
import { z } from "zod";

const materializedNodeSchema = z
  .object({
    id: z.string().min(1),
    nodeKind: z.string().min(1).optional(),
    exists: z.boolean(),
    properties: z.record(jsonValueSchema),
  })
  .strict();

const materializedEdgeSchema = z
  .object({
    id: z.string().min(1),
    subject: z.string().min(1),
    object: z.string().min(1),
    edgeType: z.string().min(1),
    payload: jsonValueSchema.optional(),
  })
  .strict();

const beforeMismatchDiagnosticSchema = z
  .object({
    kind: z.literal("before-mismatch"),
    eventId: z.string().min(1),
    changeIndex: z.number().int().nonnegative(),
    expected: jsonValueSchema,
    actual: jsonValueSchema.optional(),
  })
  .strict();

const existingCreateReplacedDiagnosticSchema = z
  .object({
    kind: z.literal("existing-create-replaced"),
    eventId: z.string().min(1),
    changeIndex: z.number().int().nonnegative(),
    subject: z.string().min(1),
  })
  .strict();

const materializedDiagnosticSchema = z.discriminatedUnion("kind", [
  beforeMismatchDiagnosticSchema,
  existingCreateReplacedDiagnosticSchema,
]);

export const materializedFoldStateSchema = z
  .object({
    values: z.array(z.tuple([z.string(), jsonValueSchema])),
    nodes: z.array(materializedNodeSchema),
    edges: z.array(materializedEdgeSchema),
    redirects: z.array(z.tuple([z.string(), z.string()])),
    diagnostics: z.array(materializedDiagnosticSchema),
  })
  .strict();

export const foldCheckpointSchema = z
  .object({
    include: z.enum(["canon", "canon+draft"]),
    componentSet: z.string().min(1),
    through: z
      .object({
        t: z.number().finite(),
        eventId: z.string().min(1),
      })
      .strict()
      .nullable(),
    eventCount: z.number().int().nonnegative(),
    stateDigest: z.string().regex(/^[a-f0-9]{64}$/),
    state: materializedFoldStateSchema,
  })
  .strict();

export const eventJournalRecordSchema = z
  .object({
    formatVersion: z.literal(1),
    recordType: z.literal("event"),
    status: z.enum(["draft", "canon"]),
    event: eventSchema,
  })
  .strict();

export const checkpointJournalRecordSchema = z
  .object({
    formatVersion: z.literal(1),
    recordType: z.literal("checkpoint"),
    checkpoint: foldCheckpointSchema,
  })
  .strict();

export const journalRecordSchema = z.discriminatedUnion("recordType", [
  eventJournalRecordSchema,
  checkpointJournalRecordSchema,
]);

export type MaterializedFoldState = z.infer<typeof materializedFoldStateSchema>;
export type FoldCheckpoint = z.infer<typeof foldCheckpointSchema>;
export type EventJournalRecord = z.infer<typeof eventJournalRecordSchema>;
export type CheckpointJournalRecord = z.infer<typeof checkpointJournalRecordSchema>;
export type JournalRecord = z.infer<typeof journalRecordSchema>;

export function parseJournalRecord(input: unknown): JournalRecord {
  return journalRecordSchema.parse(input);
}

export function eventRecord(
  entry: FoldLogEntry,
): EventJournalRecord {
  return eventJournalRecordSchema.parse({
    formatVersion: 1,
    recordType: "event",
    status: entry.status,
    event: entry.event,
  });
}

export function checkpointRecord(checkpoint: FoldCheckpoint): CheckpointJournalRecord {
  return checkpointJournalRecordSchema.parse({
    formatVersion: 1,
    recordType: "checkpoint",
    checkpoint,
  });
}
