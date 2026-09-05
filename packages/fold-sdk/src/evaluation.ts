import type { JsonValue } from "@_89/fold";

export type EvaluationSourceReference =
  | { readonly kind: "memory"; readonly memoryId: string; readonly revision: number }
  | { readonly kind: "event"; readonly eventId: string };
export interface EvaluationSourceSelectionRequest {
  readonly selectionId: string;
  readonly audience: "local-reviewed";
  readonly redactionVersion: string;
  readonly expectedSubject: { readonly organizationId: string; readonly workspaceId: string; readonly principalId: string };
  readonly references: readonly EvaluationSourceReference[];
  /** Exact refs explicitly reviewed by the caller. Missing review never exports private or shared data. */
  readonly reviewedReferences: readonly EvaluationSourceReference[];
}
export interface EvaluationSourceSelection {
  readonly selectionId: string;
  readonly audience: "local-reviewed";
  readonly redactionVersion: string;
  /** Private authorization receipt: do not include this subject in a shared artifact bundle. */
  readonly subject: EvaluationSourceSelectionRequest["expectedSubject"];
  readonly eligible: readonly {
    readonly reference: EvaluationSourceReference;
    readonly eligibility: "current-authorized";
    readonly updatedAt: number;
    /** Selected content for a second byte-level redaction review. No raw capture envelope or actor account IDs. */
    readonly snapshot: JsonValue;
  }[];
  readonly excluded: readonly {
    readonly reference: EvaluationSourceReference;
    readonly reason: "unavailable-or-denied" | "stale-revision" | "needs-review" | "unreviewed" | "unsupported-source";
  }[];
}
