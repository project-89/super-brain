import { useCallback, useEffect, useRef, useState } from "react";

import { hasConnectionCredentials } from "./connection";
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
  readonly connection?: ConnectionSettings;
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
    const [memoryPage, candidatePage, taskPage, transcriptProjects, runPage, fleet, captureHealth, processing] = await Promise.all([
      client.recallMemoryPage({ scope: { kind: "all" }, limit: 4 }),
      client.listMemoryCandidatePage({ status: "proposed", limit: 1 }),
      client.listTrajectoryTaskPage({ limit: 1 }),
      client.listTranscriptProjects(),
      client.listTranscriptRunPage({ limit: 100 }),
      client.fleet(),
      client.captureHealth().catch(() => undefined),
      client.processingStatus().catch(() => ({ available: false as const, reason: "local-operator-unavailable" })),
    ]);
    return {
      ...snapshot,
      memories: memoryPage.items,
      memoryTotal: memoryPage.total,
      memoryCandidates: candidatePage.items,
      memoryCandidateTotal: candidatePage.total,
      trajectoryTasks: taskPage.items,
      trajectoryTaskTotal: taskPage.total,
      transcriptProjects,
      transcriptRuns: runPage.items,
      transcriptRunTotal: runPage.total,
      fleet,
      processing,
      ...(captureHealth === undefined ? {} : { captureHealth }),
    };
  }
  if (page === "memory") {
    const [memoryPage, candidatePage] = await Promise.all([
      client.recallMemoryPage({ scope: { kind: "all" }, includeNeedsReview: true, limit: 100 }),
      client.listMemoryCandidatePage({ status: "proposed", limit: 100 }),
    ]);
    return {
      ...snapshot,
      memories: memoryPage.items,
      memoryTotal: memoryPage.total,
      ...(memoryPage.nextCursor === undefined ? {} : { memoryCursor: memoryPage.nextCursor }),
      memoryCandidates: candidatePage.items,
      memoryCandidateTotal: candidatePage.total,
      ...(candidatePage.nextCursor === undefined ? {} : { memoryCandidateCursor: candidatePage.nextCursor }),
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
    const taskPage = await client.listTrajectoryTaskPage({ limit: 50 });
    return {
      ...snapshot,
      trajectoryTasks: taskPage.items,
      trajectoryTaskTotal: taskPage.total,
      ...(taskPage.nextCursor === undefined ? {} : { trajectoryTaskCursor: taskPage.nextCursor }),
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
  const projection = await client.projection();
  return { ...snapshot, projection };
}

export function useSnapshot(connection: ConnectionSettings, page: BrainPage) {
  const [state, setState] = useState<SnapshotState>({ loading: true, refreshing: false });
  const requestNumber = useRef(0);
  const priorConnection = useRef<ConnectionSettings | undefined>(undefined);
  const abortController = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(
    async (background = false) => {
      if (!connection.organizationId || !connection.workspaceId || !hasConnectionCredentials(connection)) {
        setState({ connection, page, loading: false, refreshing: false });
        return;
      }
      const connectionChanged = priorConnection.current !== connection; priorConnection.current = connection;
      const request = ++requestNumber.current;
      abortController.current?.abort();
      const controller = new AbortController();
      abortController.current = controller;
      setState((current) => !connectionChanged && current.page === page ? {
        ...current,
        loading: !background && current.snapshot === undefined,
        refreshing: background || current.snapshot !== undefined,
        error: undefined,
      } : { connection, page, loading: true, refreshing: false });
      try {
        const snapshot = await loadPage(new FoldApiClient(connection, controller.signal), page);
        if (request !== requestNumber.current) return;
        setState({ connection, page, snapshot, loading: false, refreshing: false });
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
    const timer = page === "fleet" || page === "steering" || page === "overview"
      ? window.setInterval(() => void refresh(true), 30_000)
      : undefined;
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      abortController.current?.abort();
    };
  }, [page, refresh]);

  return { ...(state.connection === connection ? state : { loading: true, refreshing: false }), refresh };
}
