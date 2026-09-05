import { useEffect, useState } from "react";
import { SuperBrainClient } from "@_89/super-brain-client";
import type { ConnectionSettings } from "./types";
import { hasConnectionCredentials } from "./connection";
import { BrowserTelemetryOutbox } from "./telemetry-outbox";

export function useBrowserTelemetry(settings: ConnectionSettings): BrowserTelemetryOutbox | undefined {
  const [outbox, setOutbox] = useState<BrowserTelemetryOutbox>();
  useEffect(() => {
    if (!settings.workspaceId || !hasConnectionCredentials(settings)) { setOutbox(undefined); return; }
    const controller = new AbortController();
    const client = new SuperBrainClient({ baseUrl: settings.baseUrl, organizationId: settings.organizationId, workspaceId: settings.workspaceId, token: settings.tokenSupplier ?? settings.token, signal: controller.signal, timeoutMs: 20_000 });
    const queue = new BrowserTelemetryOutbox({
      subject: async () => client.identity(),
      deliver: (batch, signal) => client.recordMemoryFeedbackBatch(batch.items, { stamp: batch.stamp, expectedSubject: batch.subject, signal, timeoutMs: 20_000 }),
    });
    setOutbox(queue);
    const flush = () => { void queue.flush({ signal: controller.signal }).catch(() => undefined); };
    const timer = window.setInterval(flush, 15_000);
    window.addEventListener("online", flush); window.addEventListener("focus", flush); flush();
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("online", flush); window.removeEventListener("focus", flush); void queue.close(); };
  }, [settings.baseUrl, settings.organizationId, settings.workspaceId, settings.token, settings.tokenSupplier]);
  return outbox;
}
