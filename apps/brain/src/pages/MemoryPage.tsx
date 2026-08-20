import { Edit3, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { EmptyState, PageHeader, SearchField } from "../components/Common";
import { formatDateTime, memoryContent, uniqueSorted } from "../format";
import type { PersonalMemory, RecalledMemory } from "../types";

export function MemoryPage({
  memories,
  onCreate,
  onEdit,
  onForget,
}: {
  readonly memories: readonly RecalledMemory[];
  readonly onCreate: () => void;
  readonly onEdit: (memory: PersonalMemory) => void;
  readonly onForget: (memory: PersonalMemory) => void;
}) {
  const [query, setQuery] = useState("");
  const [source, setSource] = useState("all");
  const [scope, setScope] = useState("all");
  const [spaceId, setSpaceId] = useState("");
  const [selectedId, setSelectedId] = useState<string>();
  const sources = useMemo(() => uniqueSorted(memories.map(({ memory }) => memory.source)), [memories]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return memories.filter(({ memory }) => {
      if (source !== "all" && memory.source !== source) return false;
      if (scope === "workspace" && memory.spaceId !== undefined) return false;
      if (scope === "space" && memory.spaceId !== spaceId.trim()) return false;
      if (!needle) return true;
      return [memory.summary, memoryContent(memory), memory.source, ...memory.tags]
        .join("\n")
        .toLocaleLowerCase()
        .includes(needle);
    });
  }, [memories, query, source, scope, spaceId]);

  useEffect(() => {
    if (filtered.length === 0) setSelectedId(undefined);
    else if (!filtered.some(({ memory }) => memory.id === selectedId)) setSelectedId(filtered[0]!.memory.id);
  }, [filtered, selectedId]);

  const selected = filtered.find(({ memory }) => memory.id === selectedId)?.memory;

  return (
    <div className="page page--memory">
      <PageHeader
        eyebrow="Private recall"
        title="Personal memory"
        actions={<button className="button button--primary" type="button" onClick={onCreate} aria-label="New memory" title="New memory"><Plus aria-hidden="true" />New memory</button>}
      />
      <div className="filter-bar">
        <SearchField value={query} onChange={setQuery} placeholder="Search memory" />
        <label className="compact-field"><span>Source</span><select value={source} onChange={(event) => setSource(event.target.value)}><option value="all">All sources</option>{sources.map((value) => <option key={value}>{value}</option>)}</select></label>
        <label className="compact-field"><span>Scope</span><select value={scope} onChange={(event) => setScope(event.target.value)}><option value="all">All accessible</option><option value="workspace">Workspace only</option><option value="space">Space</option></select></label>
        {scope === "space" && <label className="compact-field compact-field--space"><span>Space</span><input value={spaceId} onChange={(event) => setSpaceId(event.target.value)} /></label>}
        <span className="result-count">{filtered.length} {filtered.length === 1 ? "memory" : "memories"}</span>
      </div>

      <section className="master-detail">
        <div className="master-list" aria-label="Memories">
          {filtered.length === 0 ? (
            <EmptyState title="No matching memories" />
          ) : filtered.map(({ memory, score }) => (
            <button
              type="button"
              className={`memory-row${memory.id === selectedId ? " memory-row--selected" : ""}`}
              key={memory.id}
              onClick={() => setSelectedId(memory.id)}
            >
              <span className="memory-row__top"><strong>{memory.summary || "Untitled memory"}</strong><time>{formatDateTime(memory.updatedAt)}</time></span>
              <span className="memory-row__excerpt">{memoryContent(memory) || "No content"}</span>
              <span className="memory-row__meta"><span>{memory.source}</span><span>{memory.spaceId ?? "workspace"}</span><span>r{memory.revision}</span>{score !== undefined && <span>{Math.round(score * 100)}%</span>}</span>
            </button>
          ))}
        </div>

        <article className="detail-pane">
          {selected === undefined ? (
            <EmptyState title="Select a memory" />
          ) : (
            <>
              <header className="detail-pane__header">
                <div><span className="eyebrow">Revision {selected.revision}</span><h2>{selected.summary || "Untitled memory"}</h2></div>
                <div className="detail-pane__actions">
                  <button className="icon-button" type="button" title="Revise memory" aria-label="Revise memory" onClick={() => onEdit(selected)}><Edit3 aria-hidden="true" /></button>
                  <button className="icon-button icon-button--danger" type="button" title="Forget memory" aria-label="Forget memory" onClick={() => onForget(selected)}><Trash2 aria-hidden="true" /></button>
                </div>
              </header>
              <dl className="metadata-grid">
                <div><dt>Source</dt><dd>{selected.source}</dd></div>
                <div><dt>Scope</dt><dd>{selected.spaceId ?? "Workspace"}</dd></div>
                <div><dt>Created</dt><dd>{formatDateTime(selected.createdAt)}</dd></div>
                <div><dt>Updated</dt><dd>{formatDateTime(selected.updatedAt)}</dd></div>
              </dl>
              {selected.tags.length > 0 && <div className="tag-list" aria-label="Tags">{selected.tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
              <div className="memory-content"><pre>{memoryContent(selected) || "No content"}</pre></div>
              {selected.entities.length > 0 && (
                <section className="detail-section"><h3>Entities</h3><ul className="entity-list">{selected.entities.map((entity) => <li key={`${entity.type}:${entity.id}`}><strong>{entity.name}</strong><span>{entity.type}</span><code>{entity.id}</code></li>)}</ul></section>
              )}
            </>
          )}
        </article>
      </section>
    </div>
  );
}
