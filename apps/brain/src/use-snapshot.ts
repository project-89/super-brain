import { useCallback, useEffect, useRef, useState } from "react";

import { FoldApiClient, FoldApiError } from "./api";
import type { BrainSnapshot, ConnectionSettings } from "./types";

interface SnapshotState {
  readonly snapshot?: BrainSnapshot;
  readonly loading: boolean;
  readonly refreshing: boolean;
  readonly error?: FoldApiError;
}

export function useSnapshot(connection: ConnectionSettings) {
  const [state, setState] = useState<SnapshotState>({ loading: true, refreshing: false });
  const requestNumber = useRef(0);

  const refresh = useCallback(
    async (background = false) => {
      if (!connection.workspaceId || !connection.token) {
        setState({ loading: false, refreshing: false });
        return;
      }
      const request = ++requestNumber.current;
      setState((current) => ({
        ...current,
        loading: !background && current.snapshot === undefined,
        refreshing: background || current.snapshot !== undefined,
        error: undefined,
      }));
      try {
        const client = new FoldApiClient(connection);
        const [events, memories, projection] = await Promise.all([
          client.listEvents({ includeDrafts: true }),
          client.recallMemories({ scope: { kind: "all" }, limit: 100 }),
          client.projection(true),
        ]);
        if (request !== requestNumber.current) return;
        setState({
          snapshot: { events, memories, projection, loadedAt: Date.now() },
          loading: false,
          refreshing: false,
        });
      } catch (error) {
        if (request !== requestNumber.current) return;
        const apiError =
          error instanceof FoldApiError
            ? error
            : new FoldApiError(0, "request_failed", error instanceof Error ? error.message : "Request failed");
        setState((current) => ({ ...current, loading: false, refreshing: false, error: apiError }));
      }
    },
    [connection],
  );

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { ...state, refresh };
}
