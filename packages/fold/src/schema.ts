import { z } from "zod";

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(jsonValueSchema),
  ]),
);

export const basisSchema = z.enum(["authored", "observed", "estimated", "derived"]);

export const methodSchema = z
  .object({
    kind: z.enum(["sensor", "classifier", "oracle", "model", "human", "system"]),
    id: z.string().min(1).optional(),
    detail: z.record(jsonValueSchema).optional(),
  })
  .strict();

export const provenanceSchema = z
  .object({
    basis: basisSchema,
    confidence: z.number().min(0).max(1).optional(),
    scale: z.string().min(1).optional(),
    method: methodSchema.optional(),
  })
  .strict();

const provenanceField = { provenance: provenanceSchema.optional() };
const targetFields = {
  subject: z.string().min(1),
  component: z.string().min(1),
  field: z.string().min(1).optional(),
  object: z.string().min(1).optional(),
};

const coreNodeKinds = z.enum([
  "character",
  "location",
  "object",
  "organization",
  "faction",
  "creature",
  "concept",
  "artifact",
  "media-asset",
  "narrative-node",
  "fact",
  "theme",
  "audience",
  "timeline",
]);

export const nodeKindSchema = z.union([
  coreNodeKinds,
  z.string().regex(/^x\.[a-z0-9-]+\.[a-z0-9-]+$/),
]);

const createChangeSchema = z
  .object({
    verb: z.literal("create"),
    subject: z.string().min(1),
    nodeKind: nodeKindSchema,
    after: z.record(jsonValueSchema),
    ...provenanceField,
  })
  .strict();

const destroyChangeSchema = z
  .object({
    verb: z.literal("destroy"),
    subject: z.string().min(1),
    before: z.record(jsonValueSchema),
    ...provenanceField,
  })
  .strict();

const setChangeSchema = z
  .object({
    verb: z.literal("set"),
    ...targetFields,
    before: jsonValueSchema,
    after: jsonValueSchema,
    ...provenanceField,
  })
  .strict();

const adjustChangeSchema = z
  .object({
    verb: z.literal("adjust"),
    ...targetFields,
    before: z.number().finite(),
    after: z.number().finite(),
    amount: z.number().finite(),
    ...provenanceField,
  })
  .strict();

const markChangeSchema = z
  .object({
    verb: z.literal("mark"),
    ...targetFields,
    before: z.boolean(),
    after: z.literal(true),
    ...provenanceField,
  })
  .strict();

const unmarkChangeSchema = z
  .object({
    verb: z.literal("unmark"),
    ...targetFields,
    before: z.boolean(),
    after: z.literal(false),
    ...provenanceField,
  })
  .strict();

const edgeFields = {
  subject: z.string().min(1),
  object: z.string().min(1),
  edgeType: z.string().min(1),
  edgeId: z.string().min(1),
  payload: jsonValueSchema.optional(),
};

const linkChangeSchema = z
  .object({ verb: z.literal("link"), ...edgeFields, ...provenanceField })
  .strict();

const unlinkChangeSchema = z
  .object({ verb: z.literal("unlink"), ...edgeFields, ...provenanceField })
  .strict();

const transferChangeSchema = z
  .object({
    verb: z.literal("transfer"),
    subject: z.string().min(1),
    object: z.string().min(1),
    before: z.string().min(1).nullable(),
    after: z.string().min(1).nullable(),
    ...provenanceField,
  })
  .strict();

const knowledgeFields = {
  subject: z.string().min(1),
  audience: z.string().min(1),
  object: z.string().min(1).optional(),
  before: z.boolean(),
};

const revealChangeSchema = z
  .object({
    verb: z.literal("reveal"),
    ...knowledgeFields,
    after: z.literal(true),
    ...provenanceField,
  })
  .strict();

const concealChangeSchema = z
  .object({
    verb: z.literal("conceal"),
    ...knowledgeFields,
    after: z.literal(true),
    ...provenanceField,
  })
  .strict();

const mergeChangeSchema = z
  .object({
    verb: z.literal("merge"),
    subject: z.string().min(1),
    object: z.string().min(1),
    before: z.record(jsonValueSchema),
    after: z.null(),
    ...provenanceField,
  })
  .strict();

export const changeSchema = z.discriminatedUnion("verb", [
  createChangeSchema,
  destroyChangeSchema,
  setChangeSchema,
  adjustChangeSchema,
  markChangeSchema,
  unmarkChangeSchema,
  linkChangeSchema,
  unlinkChangeSchema,
  transferChangeSchema,
  revealChangeSchema,
  concealChangeSchema,
  mergeChangeSchema,
]);

export const authorSchema = z
  .object({
    kind: z.enum(["human", "simulation", "agent", "rule", "generator", "ingest", "sensor"]),
    id: z.string().min(1),
    productionId: z.string().min(1).optional(),
  })
  .strict();

export const captureEnvelopeSchema = z
  .object({
    scope: z
      .object({
        workspace: z.string().min(1),
        space: z.string().min(1).optional(),
        creator: z.string().min(1).optional(),
      })
      .strict(),
    identity: z.record(z.string().min(1)).optional(),
  })
  .strict();

export const lifecycleSchema = z
  .object({
    sensor: z.string().min(1),
    phase: z.enum(["online", "heartbeat", "degraded", "offline"]),
    observedAt: z.string().datetime({ offset: true }),
    heartbeatWindowMs: z.number().int().positive(),
  })
  .strict();

const measurementSchema = provenanceSchema.extend({ value: z.number().finite() }).strict();

export const eventSchema = z
  .object({
    specVersion: z.literal("0.7"),
    id: z.string().min(1),
    kind: z.string().min(1),
    title: z.string().min(1),
    description: z.string().optional(),
    at: z
      .object({
        t: z.number().finite(),
        worldDate: z.string().regex(/^\d{4,6}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2})?$/),
        granularity: z.enum(["beat", "scene", "chapter", "era", "session"]).optional(),
      })
      .strict(),
    timelineId: z.string().min(1).optional(),
    participants: z.array(z.string().min(1)).optional(),
    location: z.string().min(1).optional(),
    author: authorSchema,
    causedBy: z.array(z.string().min(1)).optional(),
    magnitude: measurementSchema.optional(),
    valence: measurementSchema.optional(),
    capture: captureEnvelopeSchema,
    lifecycle: lifecycleSchema.optional(),
    changes: z.array(changeSchema).min(1),
    effects: z
      .array(
        z
          .object({
            id: z.string().min(1),
            type: z.string().min(1),
            payload: jsonValueSchema,
          })
          .strict(),
      )
      .optional(),
    extensions: z.record(jsonValueSchema).optional(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.author.kind === "sensor" && !/^urn:sensor:[^\s]+$/.test(event.author.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["author", "id"],
        message: "sensor author ids must be stable sensor URNs",
      });
    }

    if (event.kind === "lifecycle" && event.lifecycle === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lifecycle"],
        message: "lifecycle events require lifecycle metadata",
      });
    }

    if (event.lifecycle !== undefined) {
      if (event.kind !== "lifecycle") {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["kind"],
          message: "lifecycle metadata is reserved for kind=lifecycle",
        });
      }
      if (event.author.kind !== "sensor" || event.author.id !== event.lifecycle.sensor) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["author"],
          message: "lifecycle author must be the matching sensor",
        });
      }
    }
  });

export type Basis = z.infer<typeof basisSchema>;
export type Method = z.infer<typeof methodSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type Change = z.infer<typeof changeSchema>;
export type Author = z.infer<typeof authorSchema>;
export type CaptureEnvelope = z.infer<typeof captureEnvelopeSchema>;
export type Lifecycle = z.infer<typeof lifecycleSchema>;
export type FoldEvent = z.infer<typeof eventSchema>;

export function parseEvent(input: unknown): FoldEvent {
  return eventSchema.parse(input);
}
