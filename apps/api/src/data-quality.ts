import type { FoldEvent } from "@_89/fold";
import {
  listMemoryCandidateViews,
  memoryFeedbackRecordsFromEvent,
  rebuildMemories,
  rebuildMemoryCandidates,
} from "@_89/fold-epistemic";
import { rebuildTranscriptCatalog } from "@_89/fold-transcript";
import { effectiveTrajectoryRecord, rebuildTrajectories } from "@_89/fold-trajectory";

export interface DataQualityReport {
  readonly generatedAt: number;
  readonly corpus: {
    readonly events: number;
    readonly firstEventAt?: number;
    readonly lastEventAt?: number;
    readonly observations: number;
    readonly lifecycleSignals: number;
    readonly archivedRecords: number;
    readonly derivedRecords: number;
    readonly observedProjects: number;
    readonly observedSessions: number;
  };
  readonly transcripts: {
    readonly projects: number;
    readonly runs: number;
    readonly resolvedRuns: number;
    readonly turns: number;
    readonly actions: number;
    readonly unknownRecords: number;
    readonly artifacts: number;
    readonly storedArtifacts: number;
    readonly policyDeclaredArtifacts: number;
    readonly reasoningIncludedArtifacts: number;
    readonly redactions: number;
    readonly bySource: readonly {
      readonly source: string;
      readonly runs: number;
      readonly turns: number;
      readonly actions: number;
      readonly unknownRecords: number;
    }[];
  };
  readonly memories: {
    readonly total: number;
    readonly withEvidence: number;
    readonly proposed: number;
    readonly accepted: number;
    readonly rejected: number;
    readonly highConfidencePending: number;
    readonly projectScopedPending: number;
    readonly duplicatePending: number;
    readonly oldestPendingAt?: number;
    readonly recalled: number;
    readonly validated: number;
    readonly feedback: {
      readonly recalled: number;
      readonly helpful: number;
      readonly unhelpful: number;
      readonly superseded: number;
    };
    readonly candidateSources: readonly {
      readonly source: string;
      readonly proposed: number;
      readonly accepted: number;
      readonly rejected: number;
    }[];
  };
  readonly trajectories: {
    readonly tasks: number;
    readonly runs: number;
    readonly successful: number;
    readonly failed: number;
    readonly unknown: number;
    readonly reviewed: number;
    readonly tasksWithDecisions: number;
    readonly tasksWithOutcomes: number;
    readonly nodes: number;
    readonly decisionNodes: number;
    readonly mappedSteps: number;
    readonly totalSteps: number;
  };
}

function normalizedSummary(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function buildDataQualityReport(events: readonly FoldEvent[], now = Date.now()): DataQualityReport {
  const candidates = listMemoryCandidateViews(rebuildMemoryCandidates(events));
  const pending = candidates.filter(({ status }) => status === "proposed");
  const memories = [...rebuildMemories(events).memories.values()];
  const transcripts = rebuildTranscriptCatalog(events);
  const trajectoryState = rebuildTrajectories(events);
  const feedback = events.flatMap(memoryFeedbackRecordsFromEvent);
  const feedbackCounts = { recalled: 0, helpful: 0, unhelpful: 0, superseded: 0 };
  const recalledMemoryIds = new Set<string>();
  const validatedMemoryIds = new Set<string>();
  for (const record of feedback) {
    feedbackCounts[record.signal] += 1;
    if (record.signal === "recalled") recalledMemoryIds.add(record.memoryId);
    else validatedMemoryIds.add(record.memoryId);
  }

  const sourceCounts = new Map<string, { proposed: number; accepted: number; rejected: number }>();
  for (const view of candidates) {
    const current = sourceCounts.get(view.candidate.source) ?? { proposed: 0, accepted: 0, rejected: 0 };
    current[view.status] += 1;
    sourceCounts.set(view.candidate.source, current);
  }

  const pendingSummaries = new Set<string>();
  let duplicatePending = 0;
  for (const { candidate } of pending) {
    const key = normalizedSummary(candidate.summary);
    if (pendingSummaries.has(key)) duplicatePending += 1;
    else pendingSummaries.add(key);
  }

  const transcriptSources = new Map<string, {
    runs: number;
    turns: number;
    actions: number;
    unknownRecords: number;
  }>();
  for (const run of transcripts.runs.values()) {
    const current = transcriptSources.get(run.source) ?? { runs: 0, turns: 0, actions: 0, unknownRecords: 0 };
    current.runs += 1;
    current.turns += run.counts.turns;
    current.actions += run.counts.actions;
    current.unknownRecords += run.counts.unknown;
    transcriptSources.set(run.source, current);
  }

  const artifacts = [...transcripts.artifacts.values()];
  const runs = [...transcripts.runs.values()];
  const trees = [...trajectoryState.trees.values()];
  const trajectoryRuns = [...trajectoryState.trajectories.values()].map((record) => effectiveTrajectoryRecord(trajectoryState, record));
  const treeNodes = trees.flatMap(({ tree }) => tree.nodes);
  const trajectorySteps = trajectoryRuns.flatMap(({ trajectory }) => trajectory.steps);
  const assignments = trajectoryRuns.flatMap(({ assignments: values }) => Object.values(values));
  const observedProjects = new Set<string>();
  const observedSessions = new Set<string>();
  for (const event of events) {
    if (event.kind !== "terminal.observation") continue;
    const project = event.capture.identity?.project;
    const session = event.capture.identity?.session;
    if (project !== undefined) observedProjects.add(project);
    if (session !== undefined) observedSessions.add(session);
  }
  const eventRange = events.reduce<{ first: number; last: number } | undefined>((range, { at }) => range === undefined
    ? { first: at.t, last: at.t }
    : { first: Math.min(range.first, at.t), last: Math.max(range.last, at.t) }, undefined);

  return {
    generatedAt: now,
    corpus: {
      events: events.length,
      ...(eventRange === undefined ? {} : {
        firstEventAt: eventRange.first,
        lastEventAt: eventRange.last,
      }),
      observations: events.filter(({ kind }) => kind === "terminal.observation").length,
      lifecycleSignals: events.filter(({ kind }) => kind === "lifecycle").length,
      archivedRecords: events.filter(({ kind }) => kind.startsWith("transcript.") && !kind.startsWith("transcript.derivation")).length,
      derivedRecords: events.filter(({ kind }) => kind.startsWith("memory.") || kind.startsWith("trajectory.") || kind.startsWith("transcript.derivation")).length,
      observedProjects: observedProjects.size,
      observedSessions: observedSessions.size,
    },
    transcripts: {
      projects: transcripts.projects.size,
      runs: runs.length,
      resolvedRuns: runs.filter(({ projectResolution }) => projectResolution === "resolved").length,
      turns: runs.reduce((sum, run) => sum + run.counts.turns, 0),
      actions: runs.reduce((sum, run) => sum + run.counts.actions, 0),
      unknownRecords: runs.reduce((sum, run) => sum + run.counts.unknown, 0),
      artifacts: artifacts.length,
      storedArtifacts: artifacts.filter(({ stored }) => stored).length,
      policyDeclaredArtifacts: artifacts.filter(({ reasoningPolicy }) => reasoningPolicy !== undefined).length,
      reasoningIncludedArtifacts: artifacts.filter(({ reasoningPolicy }) => reasoningPolicy === "included").length,
      redactions: artifacts.reduce((sum, artifact) => sum + artifact.redactionCount, 0),
      bySource: [...transcriptSources]
        .map(([source, counts]) => ({ source, ...counts }))
        .sort((left, right) => right.runs - left.runs || left.source.localeCompare(right.source)),
    },
    memories: {
      total: memories.length,
      withEvidence: memories.filter(({ evidence }) => (evidence?.length ?? 0) > 0).length,
      proposed: pending.length,
      accepted: candidates.filter(({ status }) => status === "accepted").length,
      rejected: candidates.filter(({ status }) => status === "rejected").length,
      highConfidencePending: pending.filter(({ candidate }) => candidate.confidence >= 0.8).length,
      projectScopedPending: pending.filter(({ candidate }) => candidate.projectIds.length > 0).length,
      duplicatePending,
      ...(pending.length === 0 ? {} : {
        oldestPendingAt: Math.min(...pending.map(({ candidate }) => candidate.proposedAt)),
      }),
      recalled: recalledMemoryIds.size,
      validated: validatedMemoryIds.size,
      feedback: feedbackCounts,
      candidateSources: [...sourceCounts]
        .map(([source, counts]) => ({ source, ...counts }))
        .sort((left, right) =>
          right.proposed + right.accepted + right.rejected - (left.proposed + left.accepted + left.rejected) ||
          left.source.localeCompare(right.source)
        ),
    },
    trajectories: {
      tasks: trees.length,
      runs: trajectoryRuns.length,
      successful: trajectoryRuns.filter(({ trajectory }) => trajectory.outcome === "success").length,
      failed: trajectoryRuns.filter(({ trajectory }) => trajectory.outcome === "failure").length,
      unknown: trajectoryRuns.filter(({ trajectory }) => trajectory.outcome === "unknown").length,
      reviewed: trajectoryRuns.filter(({ reviewText, outcomeReview }) => outcomeReview !== undefined || reviewText?.trim()).length,
      tasksWithDecisions: trees.filter(({ tree }) => tree.nodes.some(({ kind }) => kind === "decision")).length,
      tasksWithOutcomes: trees.filter(({ tree }) => tree.nodes.some(({ kind }) => kind === "outcome")).length,
      nodes: treeNodes.length,
      decisionNodes: treeNodes.filter(({ kind }) => kind === "decision").length,
      mappedSteps: assignments.filter(({ kind }) => kind === "mapped").length,
      totalSteps: trajectorySteps.length,
    },
  };
}
