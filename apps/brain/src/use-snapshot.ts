import { useCallback, useEffect, useRef, useState } from "react";

import { FoldApiClient, FoldApiError } from "./api";
import type {
  BrainPage,
  BrainSnapshot,
  ConnectionSettings,
  FleetResponse,
  ProjectionResponse,
  SteeringResponse,
} from "./types";

interface SnapshotState {
  readonly page?: BrainPage;
  readonly snapshot?: BrainSnapshot;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly error?: FoldApiError;
}

const EMPTY_PROJECTION: ProjectionResponse = {
  entries: [],
  state: {
    values: [],
    nodes: [],
    edges: [],
    redirects: [],
    diagnostics: [],
    appliedEvents: [],
    appliedChanges: [],
  },
};

const EMPTY_FLEET: FleetResponse = {
  fleet: { rebuiltAt: new Date(0).toISOString(), sessions: [], recoveryActions: [] },
};

const EMPTY_STEERING: SteeringResponse = { actors: [], steeringEnabled: false };

function emptySnapshot(): BrainSnapshot {
  return {
    events: [],
    memories: [],
    memoryCandidates: [],
    trajectoryTasks: [],
    transcriptProjects: [],
    transcriptRuns: [],
    fleet: EMPTY_FLEET,
    steering: EMPTY_STEERING,
    projection: EMPTY_PROJECTION,
    workingProjection: EMPTY_PROJECTION,
    memoryTotal: 0,
    memoryCandidateTotal: 0,
    trajectoryTaskTotal: 0,
    transcriptRunTotal: 0,
    eventTotal: 0,
    loadedAt: Date.now(),
  };
}

async function loadPage(client: FoldApiClient, page: BrainPage): Promise<BrainSnapshot> {
  const snapshot = emptySnapshot();
  if (page === "overview") {
    const [fleet, captureHealth, dataQuality] = await Promise.all([
      client.fleet(),
      client.captureHealth().catch(() => undefined),
      client.dataQuality().catch(() => undefined),
    ]);
    return {
      ...snapshot,
      memoryTotal: dataQuality?.memories.total ?? 0,
      memoryCandidateTotal: dataQuality?.memories.proposed ?? 0,
      trajectoryTaskTotal: dataQuality?.trajectories.tasks ?? 0,
      transcriptRunTotal: dataQuality?.transcripts.runs ?? 0,
      fleet,
      ...(captureHealth === undefined ? {} : { captureHealth }),
      ...(dataQuality === undefined ? {} : { dataQuality }),
    };
  }
  if (page === "memory") {
    const [memoryPage, candidatePage, events, transcriptProjects] = await Promise.all([
      client.recallMemoryPage({ scope: { kind: "all" }, limit: 100 }),
      client.listMemoryCandidatePage({ status: "proposed", limit: 100 }),
      (async () => {
        const entries = [] as BrainSnapshot["events"][number][];
        let cursor: string | undefined;
        do {
          const feedbackPage = await client.listEventsPage({ kinds: ["memory.feedback-recorded"], limit: 1_000, ...(cursor === undefined ? {} : { cursor }) });
          entries.push(...feedbackPage.items);
          cursor = feedbackPage.nextCursor;
        } while (cursor !== undefined);
        return entries;
      })(),
      client.listTranscriptProjects(),
    ]);
    return {
      ...snapshot,
      memories: memoryPage.items,
      memoryTotal: memoryPage.total,
      ...(memoryPage.nextCursor === undefined ? {} : { memoryCursor: memoryPage.nextCursor }),
      memoryCandidates: candidatePage.items,
      memoryCandidateTotal: candidatePage.total,
      ...(candidatePage.nextCursor === undefined ? {} : { memoryCandidateCursor: candidatePage.nextCursor }),
      transcriptProjects,
      events,
    };
  }
  if (page === "history") {
    const [transcriptProjects, runPage] = await Promise.all([
      client.listTranscriptProjects(),
      client.listTranscriptRunPage({ limit: 100 }),
    ]);
    return {
      ...snapshot,
      transcriptProjects,
      transcriptRuns: runPage.items,
      transcriptRunTotal: runPage.total,
      ...(runPage.nextCursor === undefined ? {} : { transcriptRunCursor: runPage.nextCursor }),
    };
  }
  if (page === "trajectories") {
    const [taskPage, transcriptProjects] = await Promise.all([
      client.listTrajectoryTaskPage({ limit: 50 }),
      client.listTranscriptProjects(),
    ]);
    return {
      ...snapshot,
      trajectoryTasks: taskPage.items,
      trajectoryTaskTotal: taskPage.total,
      ...(taskPage.nextCursor === undefined ? {} : { trajectoryTaskCursor: taskPage.nextCursor }),
      transcriptProjects,
    };
  }
  if (page === "fleet") {
    return { ...snapshot, fleet: await client.fleet() };
  }
  if (page === "steering") {
    const [fleet, steering] = await Promise.all([client.fleet(), client.steering()]);
    return { ...snapshot, fleet, steering };
  }
  if (page === "events") {
    const eventPage = await client.listEventsPage({ includeDrafts: true, limit: 100 });
    return {
      ...snapshot,
      events: eventPage.items,
      eventTotal: eventPage.total,
      ...(eventPage.nextCursor === undefined ? {} : { eventCursor: eventPage.nextCursor }),
    };
  }
  return snapshot;
}

export function useSnapshot(connection: ConnectionSettings, page: BrainPage) {
  const [state, setState] = useState<SnapshotState>({ loading: true, refreshing: false });
  const requestNumber = useRef(0);
  const abortController = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(
    async (background = false) => {
      if (!connection.organizationId || !connection.workspaceId || !connection.token) {
        setState({ page, loading: false, refreshing: false });
        return;
      }
      const request = ++requestNumber.current;
      abortController.current?.abort();
      const controller = new AbortController();
      abortController.current = controller;
      setState((current) => current.page === page ? {
        ...current,
        loading: !background && current.snapshot === undefined,
        refreshing: background || current.snapshot !== undefined,
        error: undefined,
      } : { page, loading: true, refreshing: false });
      try {
        const snapshot = await loadPage(new FoldApiClient(connection, controller.signal), page);
        if (request !== requestNumber.current) return;
        setState({ page, snapshot, loading: false, refreshing: false });
      } catch (error) {
        if (request !== requestNumber.current || controller.signal.aborted) return;
        const apiError = error instanceof FoldApiError
          ? error
          : new FoldApiError(0, "request_failed", error instanceof Error ? error.message : "Request failed");
        setState((current) => ({ ...current, loading: false, refreshing: false, error: apiError }));
      }
    },
    [connection, page],
  );

  useEffect(() => {
    void refresh();
    const timer = page === "fleet" || page === "steering"
      ? window.setInterval(() => void refresh(true), 30_000)
      : undefined;
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      abortController.current?.abort();
    };
  }, [page, refresh]);

  return { ...state, refresh };
}
