/** Files supplied here are explicitly selected, sanitized bytes, never paths to private storage. */
export interface EvaluationArtifact {
  readonly path: string;
  readonly mediaType: "application/json" | "text/plain" | "text/javascript" | "text/markdown";
  readonly content: string;
}
export interface EvaluationArtifactRef { readonly path: string; readonly sha256: string }
export interface FrozenEvaluation {
  readonly id: string;
  readonly taskId: string;
  readonly taskVersion: string;
  readonly inputStateId: string;
  readonly oracleVersion: string;
  readonly treeVersion: string;
  readonly annotationVersion: string;
  readonly frozenAt: string;
  readonly task: EvaluationArtifactRef;
  readonly input: EvaluationArtifactRef;
  readonly oracle: EvaluationArtifactRef;
  readonly tree: EvaluationArtifactRef;
  readonly rubric: EvaluationArtifactRef;
  readonly supportingArtifacts?: readonly EvaluationArtifactRef[];
}
export interface EvaluationChecks {
  readonly version: 1;
  readonly suiteVersion: string;
  readonly codeSha256?: string;
  readonly availability: "completed" | "unavailable";
  readonly checks: readonly { readonly id: string; readonly status: "passed" | "failed" | "unavailable"; readonly detail?: string }[];
  readonly reason?: string;
}
export interface EvaluationAnnotations {
  readonly version: 1;
  readonly annotationVersion: string;
  readonly annotations: readonly {
    readonly stepId: string;
    readonly assignment: (
      | { readonly kind: "mapped"; readonly nodeId: string }
      | { readonly kind: "ambiguous"; readonly candidates: readonly string[]; readonly reason: string }
      | { readonly kind: "unmapped"; readonly reason: string }
    ) & { readonly method: { readonly kind: "manual"; readonly id: "frozen-observable-rubric-v1"; readonly basis: "structural" | "semantic" } };
    readonly evidence: readonly (
      | { readonly kind: "code-span"; readonly artifactSha256: string; readonly startLine: number; readonly endLine: number }
      | { readonly kind: "check"; readonly caseId: string; readonly roundId: string }
      | { readonly kind: "submission"; readonly artifactSha256: string; readonly roundId: string }
    )[];
    readonly note?: string;
  }[];
}
export interface EvaluationRuntime {
  readonly provider: string;
  readonly configuredModel?: string;
  readonly observedModel?: string;
  readonly runtimeVersion: string;
  readonly configuration: EvaluationArtifactRef;
}
export interface SelectedEvaluationAttempt {
  readonly id: string;
  readonly kind: "real-provider" | "synthetic-fixture" | "preparation-failure";
  readonly condition: "no-memory" | "memory";
  readonly taskVersion: string;
  readonly inputStateId: string;
  readonly oracleVersion: string;
  readonly treeVersion: string;
  readonly annotationVersion: string;
  readonly runtime: EvaluationRuntime;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly submissions: readonly {
    readonly id: string;
    readonly output: EvaluationArtifactRef;
    readonly code?: EvaluationArtifactRef;
    readonly checks: EvaluationArtifactRef;
    readonly elapsedMs?: number;
    /** Source-provided observations only; no inferred attempt totals. */
    readonly usage?: EvaluationArtifactRef;
    /** Required for real provider submissions. Each round retains its own observed identity. */
    readonly runtime?: EvaluationRuntime;
  }[];
  readonly annotations: EvaluationArtifactRef;
  readonly memory?: { readonly source: { readonly memoryId: string; readonly revision: number }; readonly recallId: string; readonly injected: EvaluationArtifactRef };
  readonly reportedOutcome?: string;
}
export type EvaluationSourceReference =
  | { readonly kind: "memory"; readonly memoryId: string; readonly revision: number }
  | { readonly kind: "event"; readonly eventId: string };
export interface SelectedEvaluationSource {
  readonly reference: EvaluationSourceReference;
  readonly artifact: EvaluationArtifactRef;
  /** The SDK/API selection receipt remains private because it contains the authenticated subject. */
  readonly eligibility: "current-authorized";
  readonly selectionId: string;
}
export interface EvaluationExclusion {
  /** A synthetic label, never denied source contents or a private path. */
  readonly label: string;
  readonly reason: "unavailable-or-denied" | "stale-revision" | "needs-review" | "unreviewed" | "redacted" | "unsupported-source" | "provider-unavailable";
}
export interface SelectedEvaluationInput {
  readonly frozen: FrozenEvaluation;
  readonly attempts: readonly SelectedEvaluationAttempt[];
  readonly artifacts: readonly EvaluationArtifact[];
  readonly sources: readonly SelectedEvaluationSource[];
  readonly exclusions: readonly EvaluationExclusion[];
  readonly review: {
    readonly selectionId: string;
    readonly audience: "local-reviewed";
    readonly redactionVersion: string;
    readonly reviewedArtifactPaths: readonly string[];
    /** Synthetic reviewer label, not an account identifier. */
    readonly reviewedBy: string;
    readonly reviewedAt: string;
  };
}
export interface EvaluationReport {
  readonly version: 1;
  readonly experimentId: string;
  readonly limitations: readonly string[];
  readonly attempts: readonly {
    readonly id: string;
    readonly kind: SelectedEvaluationAttempt["kind"];
    readonly condition: SelectedEvaluationAttempt["condition"];
    readonly provider: string;
    readonly configuredModel?: string;
    readonly observedModel?: string;
    readonly comparisonGroup: string;
    readonly runtimeConsistency: "consistent" | "mixed" | "unavailable";
    readonly submissions: number;
    readonly acceptance: "passed" | "failed" | "unavailable";
    readonly confidence: number | null;
    readonly checks: { readonly passed: number; readonly failed: number; readonly unavailable: number };
    readonly annotations: { readonly mapped: number; readonly ambiguous: number; readonly unmapped: number; readonly missing: number; readonly structural: number; readonly semantic: number };
    readonly elapsedMs: number | null;
    readonly memoryExposure: "prompt-injected" | "none";
    readonly reportedOutcome?: string;
  }[];
}
export interface EvaluationBundleManifest {
  readonly version: 1;
  readonly format: "fold-selected-evaluation-v1";
  readonly frozen: FrozenEvaluation;
  readonly attempts: readonly SelectedEvaluationAttempt[];
  readonly sources: readonly SelectedEvaluationSource[];
  readonly exclusions: readonly EvaluationExclusion[];
  readonly review: SelectedEvaluationInput["review"];
  readonly artifacts: readonly (EvaluationArtifactRef & { readonly mediaType: EvaluationArtifact["mediaType"]; readonly bytes: number })[];
  readonly generated: readonly (EvaluationArtifactRef & { readonly bytes: number })[];
}
export interface SelectedEvaluationBundle {
  readonly files: Readonly<Record<string, string>>;
  readonly manifest: EvaluationBundleManifest;
  readonly report: EvaluationReport;
}
