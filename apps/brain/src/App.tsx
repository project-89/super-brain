import {
  Boxes,
  BrainCircuit,
  FolderClock,
  History,
  LayoutDashboard,
  MessagesSquare,
  Moon,
  RadioTower,
  RefreshCw,
  Settings,
  Sun,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { FoldApiClient } from "./api";
import { initialConnection, saveConnection } from "./connection";
import { useSnapshot } from "./use-snapshot";
import type { BrainPage, ConnectionSettings, MemoryDraft, PersonalMemory, TrajectoryImportBundle } from "./types";
import { ConnectionDialog } from "./components/ConnectionDialog";
import { MemoryDialog } from "./components/MemoryDialog";
import { Modal } from "./components/Modal";
import { TrajectoryImportDialog } from "./components/TrajectoryImportDialog";
import { EventsPage } from "./pages/EventsPage";
import { MemoryPage } from "./pages/MemoryPage";
import { OverviewPage } from "./pages/OverviewPage";
import { StatePage } from "./pages/StatePage";
import { TrajectoriesPage } from "./pages/TrajectoriesPage";
import { FleetPage } from "./pages/FleetPage";
import { HistoryPage } from "./pages/HistoryPage";
import { SteeringPage } from "./pages/SteeringPage";

type Page = BrainPage;
type Theme = "light" | "dark";

const PAGES: readonly { readonly id: Page; readonly label: string; readonly icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "memory", label: "Memory", icon: BrainCircuit },
  { id: "history", label: "History", icon: FolderClock },
  { id: "trajectories", label: "Trajectories", icon: Waypoints },
  { id: "fleet", label: "Fleet", icon: RadioTower },
  { id: "steering", label: "Steering", icon: MessagesSquare },
  { id: "events", label: "Events", icon: History },
  { id: "state", label: "State", icon: Boxes },
];

function pageFromHash(): Page {
  const candidate = window.location.hash.replace(/^#\/?/, "") as Page;
  return PAGES.some(({ id }) => id === candidate) ? candidate : "overview";
}

function initialTheme(): Theme {
  const stored = localStorage.getItem("super-brain.theme");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export default function App() {
  const [connection, setConnection] = useState<ConnectionSettings>(initialConnection);
  const [page, setPage] = useState<Page>(pageFromHash);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [settingsOpen, setSettingsOpen] = useState(!connection.workspaceId || !connection.token);
  const [memoryDialog, setMemoryDialog] = useState<{ readonly open: boolean; readonly memory?: PersonalMemory }>({ open: false });
  const [forgetMemory, setForgetMemory] = useState<PersonalMemory>();
  const [forgetReason, setForgetReason] = useState("no longer needed");
  const [trajectoryImportOpen, setTrajectoryImportOpen] = useState(false);
  const [mutationPending, setMutationPending] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [mutationError, setMutationError] = useState<string>();
  const { snapshot, loading, refreshing, error, refresh } = useSnapshot(connection, page);

  useEffect(() => {
    const onHashChange = () => setPage(pageFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("super-brain.theme", theme);
  }, [theme]);

  useEffect(() => {
    if (notice === undefined) return;
    const timer = window.setTimeout(() => setNotice(undefined), 3_000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const api = useMemo(() => new FoldApiClient(connection), [connection]);

  const navigate = (next: Page) => {
    window.location.hash = next;
    setPage(next);
  };

  const saveSettings = (next: ConnectionSettings) => {
    setConnection(saveConnection(next));
    setSettingsOpen(false);
  };

  const saveMemory = async (draft: MemoryDraft) => {
    setMutationPending(true);
    setMutationError(undefined);
    try {
      if (memoryDialog.memory === undefined) {
        await api.createMemory(draft);
        setNotice("Memory recorded");
      } else {
        await api.reviseMemory(memoryDialog.memory.id, draft);
        setNotice("Memory revised");
      }
      setMemoryDialog({ open: false });
      await refresh(true);
    } catch (caught) {
      setMutationError(caught instanceof Error ? caught.message : "Memory write failed");
    } finally {
      setMutationPending(false);
    }
  };

  const confirmForget = async () => {
    if (forgetMemory === undefined || !forgetReason.trim()) return;
    setMutationPending(true);
    setMutationError(undefined);
    try {
      await api.forgetMemory(forgetMemory.id, forgetReason.trim());
      setForgetMemory(undefined);
      setNotice("Memory forgotten");
      await refresh(true);
    } catch (caught) {
      setMutationError(caught instanceof Error ? caught.message : "Memory forget failed");
    } finally {
      setMutationPending(false);
    }
  };

  const importTrajectories = async (bundle: TrajectoryImportBundle) => {
    setMutationPending(true);
    setMutationError(undefined);
    try {
      const count = await api.importTrajectoryBundle(bundle, snapshot?.trajectoryTasks ?? []);
      setTrajectoryImportOpen(false);
      setNotice(`${count} ${count === 1 ? "trajectory" : "trajectories"} imported`);
      await refresh(true);
    } finally {
      setMutationPending(false);
    }
  };

  const renderPage = () => {
    if (snapshot === undefined) return null;
    if (page === "memory") {
      return (
        <MemoryPage
          memories={snapshot.memories}
          candidates={snapshot.memoryCandidates}
          onRank={(options) => api.rankMemories(options)}
          onCreate={() => setMemoryDialog({ open: true })}
          onEdit={(memory) => setMemoryDialog({ open: true, memory })}
          onForget={(memory) => {
            setForgetMemory(memory);
            setForgetReason("no longer needed");
          }}
          onFeedback={async (memory, signal) => {
            setMutationPending(true);
            setMutationError(undefined);
            try {
              await api.recordMemoryFeedback(memory.id, signal);
              setNotice(signal === "helpful" ? "Memory marked helpful" : "Memory marked unhelpful");
            } catch (caught) {
              setMutationError(caught instanceof Error ? caught.message : "Memory feedback failed");
            } finally {
              setMutationPending(false);
            }
          }}
          onAcceptCandidate={async (candidate) => {
            setMutationPending(true);
            setMutationError(undefined);
            try {
              await api.acceptMemoryCandidate(candidate.id);
              setNotice("Memory candidate accepted");
              await refresh(true);
            } catch (caught) {
              setMutationError(caught instanceof Error ? caught.message : "Candidate acceptance failed");
            } finally {
              setMutationPending(false);
            }
          }}
          onRejectCandidate={async (candidate, reason) => {
            setMutationPending(true);
            setMutationError(undefined);
            try {
              await api.rejectMemoryCandidate(candidate.id, reason);
              setNotice("Memory candidate rejected");
              await refresh(true);
            } catch (caught) {
              setMutationError(caught instanceof Error ? caught.message : "Candidate rejection failed");
            } finally {
              setMutationPending(false);
            }
          }}
          mutationPending={mutationPending}
        />
      );
    }
    if (page === "events") return <EventsPage entries={snapshot.events} />;
    if (page === "trajectories") {
      return <TrajectoriesPage tasks={snapshot.trajectoryTasks} api={api} onImport={() => setTrajectoryImportOpen(true)} />;
    }
    if (page === "history") {
      return <HistoryPage projects={snapshot.transcriptProjects} runs={snapshot.transcriptRuns} api={api} />;
    }
    if (page === "fleet") {
      return <FleetPage response={snapshot.fleet} events={snapshot.events} />;
    }
    if (page === "steering") {
      return <SteeringPage response={snapshot.steering} fleet={snapshot.fleet.fleet.sessions} api={api} onRefresh={() => refresh(true)} />;
    }
    if (page === "state") {
      return (
        <StatePage
          canonicalState={snapshot.projection.state}
          workingState={snapshot.workingProjection.state}
        />
      );
    }
    return <OverviewPage snapshot={snapshot} navigate={navigate} />;
  };

  const disconnected = !connection.organizationId || !connection.workspaceId || !connection.token;
  const connectionLabel = disconnected ? "Not connected" : error ? "Connection error" : "Connected";

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" type="button" onClick={() => navigate("overview")} aria-label="Super Brain overview">
          <span className="brand__mark"><BrainCircuit aria-hidden="true" /></span>
          <span><strong>Super Brain</strong><small>Fold workspace</small></span>
        </button>
        <div className="topbar__context">
          <div className="workspace-identity">
            <span className={`connection-dot${error || disconnected ? " connection-dot--error" : ""}`} />
            <span><strong>{connection.workspaceId || "No workspace"}</strong><small>{connection.organizationId || connectionLabel}</small></span>
          </div>
          <div className="topbar__actions">
            <button className={`icon-button${refreshing ? " is-spinning" : ""}`} type="button" onClick={() => void refresh(true)} disabled={refreshing || disconnected} aria-label="Refresh workspace" title="Refresh">
              <RefreshCw aria-hidden="true" />
            </button>
            <button className="icon-button" type="button" onClick={() => setTheme((current) => current === "light" ? "dark" : "light")} aria-label={`Use ${theme === "light" ? "dark" : "light"} theme`} title={`Use ${theme === "light" ? "dark" : "light"} theme`}>
              {theme === "light" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
            </button>
            <button className="icon-button" type="button" onClick={() => setSettingsOpen(true)} aria-label="Connection settings" title="Connection settings">
              <Settings aria-hidden="true" />
            </button>
          </div>
        </div>
      </header>

      <aside className="sidebar">
        <nav aria-label="Primary navigation">
          {PAGES.map(({ id, label, icon: Icon }) => (
            <button type="button" key={id} className={page === id ? "is-active" : undefined} onClick={() => navigate(id)} aria-current={page === id ? "page" : undefined}>
              <Icon aria-hidden="true" /><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar__footer"><span className="sidebar__rule" /><span>Fold 0.7</span></div>
      </aside>

      <main className="main-content">
        {loading && snapshot === undefined ? (
          <div className="loading-layout" aria-label="Loading workspace"><span className="loading-line loading-line--short" /><span className="loading-line loading-line--heading" /><div className="loading-blocks"><span /><span /><span /><span /></div><span className="loading-panel" /></div>
        ) : error !== undefined && snapshot === undefined ? (
          <section className="connection-error">
            <span className="connection-error__icon"><X aria-hidden="true" /></span>
            <span className="eyebrow">{error.code}</span>
            <h1>Workspace unavailable</h1>
            <p>{error.message}</p>
            <div><button className="button button--primary" type="button" onClick={() => void refresh()}><RefreshCw aria-hidden="true" />Retry</button><button className="button button--secondary" type="button" onClick={() => setSettingsOpen(true)}><Settings aria-hidden="true" />Connection</button></div>
          </section>
        ) : renderPage()}
        {error !== undefined && snapshot !== undefined && (
          <button className="stale-banner" type="button" onClick={() => void refresh(true)}>
            <span>Refresh failed: {error.message}</span><RefreshCw aria-hidden="true" />
          </button>
        )}
      </main>

      <nav className="mobile-nav" aria-label="Primary navigation">
        {PAGES.map(({ id, label, icon: Icon }) => (
          <button type="button" key={id} className={page === id ? "is-active" : undefined} onClick={() => navigate(id)} aria-current={page === id ? "page" : undefined}><Icon aria-hidden="true" /><span>{label}</span></button>
        ))}
      </nav>

      <ConnectionDialog connection={connection} open={settingsOpen} required={disconnected} onClose={() => setSettingsOpen(false)} onSave={saveSettings} />
      <MemoryDialog memory={memoryDialog.memory} open={memoryDialog.open} pending={mutationPending} onClose={() => setMemoryDialog({ open: false })} onSave={saveMemory} />
      <TrajectoryImportDialog open={trajectoryImportOpen} pending={mutationPending} onClose={() => setTrajectoryImportOpen(false)} onImport={importTrajectories} />
      <Modal open={forgetMemory !== undefined} title="Forget memory" onClose={() => setForgetMemory(undefined)}>
        <div className="form-stack">
          <p className="confirm-copy">This removes <strong>{forgetMemory?.summary || "this memory"}</strong> from recall and records a durable tombstone.</p>
          <label className="field"><span>Reason</span><input value={forgetReason} onChange={(event) => setForgetReason(event.target.value)} autoFocus /></label>
          <footer className="modal__actions"><button className="button button--secondary" type="button" onClick={() => setForgetMemory(undefined)} disabled={mutationPending}>Cancel</button><button className="button button--danger" type="button" onClick={() => void confirmForget()} disabled={mutationPending || !forgetReason.trim()}><Trash2 aria-hidden="true" />{mutationPending ? "Forgetting" : "Forget"}</button></footer>
        </div>
      </Modal>

      {mutationError !== undefined && <div className="toast toast--error" role="alert"><span>{mutationError}</span><button className="icon-button" type="button" onClick={() => setMutationError(undefined)} aria-label="Dismiss error"><X aria-hidden="true" /></button></div>}
      {notice !== undefined && <div className="toast" role="status"><span>{notice}</span></div>}
    </div>
  );
}
