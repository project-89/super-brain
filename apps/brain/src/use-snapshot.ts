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
    trajectoryTasks: [],
    transcriptProjects: [],
    transcriptRuns: [],
    fleet: EMPTY_FLEET,
    steering: EMPTY_STEERING,
    projection: EMPTY_PROJECTION,
    workingProjection: EMPTY_PROJECTION,
    loadedAt: Date.now(),
  };
}

async function loadPage(client: FoldApiClient, page: BrainPage): Promise<BrainSnapshot> {
  const snapshot = emptySnapshot();
  if (page === "overview") {
    const [memories, transcriptProjects, transcriptRuns] = await Promise.all([
      client.recallMemories({ scope: { kind: "all" }, limit: 4 }),
      client.listTranscriptProjects(),
      client.listTranscriptRuns(),
    ]);
    return { ...snapshot, memories, transcriptProjects, transcriptRuns };
  }
  if (page === "memory") {
    const memories = await client.recallMemories({ scope: { kind: "all" }, limit: 100 });
    return { ...snapshot, memories };
  }
  if (page === "history") {
    const [transcriptProjects, transcriptRuns] = await Promise.all([
      client.listTranscriptProjects(),
      client.listTranscriptRuns(),
    ]);
    return { ...snapshot, transcriptProjects, transcriptRuns };
  }
  if (page === "trajectories") {
    return { ...snapshot, trajectoryTasks: await client.listTrajectoryTasks() };
  }
  if (page === "fleet") {
    const [fleet, events] = await Promise.all([
      client.fleet(),
      client.listEvents({
        includeDrafts: true,
        kinds: ["terminal.observation", "terminal.classification"],
        limit: 200,
      }),
    ]);
    return { ...snapshot, fleet, events };
  }
  if (page === "steering") {
    const [fleet, steering] = await Promise.all([client.fleet(), client.steering()]);
    return { ...snapshot, fleet, steering };
  }
  if (page === "events") {
    const events = await client.listEvents({ includeDrafts: true, limit: 200 });
    return { ...snapshot, events };
  }
  const [projection, workingProjection] = await Promise.all([
    client.projection(),
    client.projection(true),
  ]);
  return { ...snapshot, projection, workingProjection };
}

export function useSnapshot(connection: ConnectionSettings, page: BrainPage) {
  const [state, setState] = useState<SnapshotState>({ loading: true, refreshing: false });
  const requestNumber = useRef(0);
  const abortController = useRef<AbortController | undefined>(undefined);

  const refresh = useCallback(
    async (background = false) => {
      if (!connection.workspaceId || !connection.token) {
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
