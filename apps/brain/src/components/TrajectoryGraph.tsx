import dagre from "@dagrejs/dagre";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

import type { ProjectedTrajectory, SharedDecisionTree } from "../types";

const NODE_WIDTH = 188;
const NODE_HEIGHT = 64;

function mappedNodeIds(run: ProjectedTrajectory | undefined): ReadonlySet<string> {
  if (run === undefined) return new Set();
  return new Set(run.steps.flatMap(({ projection }) => projection.kind === "mapped" ? [projection.nodeId] : []));
}

export function TrajectoryGraph({ tree, successfulPath, selectedRun }: {
  readonly tree: SharedDecisionTree;
  readonly successfulPath: readonly string[];
  readonly selectedRun?: ProjectedTrajectory;
}) {
  const successful = new Set(successfulPath);
  const observed = mappedNodeIds(selectedRun);
  const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
  graph.setGraph({ rankdir: "LR", nodesep: 28, ranksep: 72, marginx: 32, marginy: 32 });
  tree.nodes.forEach(({ id }) => graph.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT }));
  tree.edges.forEach(({ sourceId, targetId }) => graph.setEdge(sourceId, targetId));
  dagre.layout(graph);

  const nodes: Node[] = tree.nodes.map((node) => {
    const point = graph.node(node.id) as { x: number; y: number };
    return {
      id: node.id,
      position: { x: point.x - NODE_WIDTH / 2, y: point.y - NODE_HEIGHT / 2 },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: { label: <><small>{node.kind}{node.id === tree.rootNodeId ? " · root" : ""}</small><strong>{node.label}</strong></> },
      className: [
        "tree-graph-node",
        `tree-graph-node--${node.kind}`,
        successful.has(node.id) ? "is-success-path" : "",
        observed.has(node.id) ? "is-observed" : "",
      ].filter(Boolean).join(" "),
      style: { width: NODE_WIDTH, height: NODE_HEIGHT },
    };
  });
  const edges: Edge[] = tree.edges.map((edge) => {
    const onSuccessPath = successfulPath.some((id, index) => id === edge.sourceId && successfulPath[index + 1] === edge.targetId);
    const onObservedPath = observed.has(edge.sourceId) && observed.has(edge.targetId);
    return {
      id: edge.id,
      source: edge.sourceId,
      target: edge.targetId,
      label: edge.label,
      markerEnd: { type: MarkerType.ArrowClosed },
      className: [onSuccessPath ? "is-success-path" : "", onObservedPath ? "is-observed" : ""].filter(Boolean).join(" "),
    };
  });
  const showEntireGraph = nodes.length <= 120;
  const rootPosition = nodes.find(({ id }) => id === tree.rootNodeId)?.position ?? { x: 0, y: 0 };
  const focusedViewport = {
    x: 32 - rootPosition.x * 0.78,
    y: 120 - rootPosition.y * 0.78,
    zoom: 0.78,
  };

  return <section className="tree-graph" aria-label="Complete decision tree">
    <header>
      <span><span className="eyebrow">Shared knowledge graph</span><h3>Complete decision tree</h3></span>
      <div className="tree-graph__legend"><span className="is-observed">Selected run</span><span className="is-success-path">Highest success</span></div>
    </header>
    <div className="tree-graph__canvas">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView={showEntireGraph}
        fitViewOptions={{ padding: 0.18 }}
        {...(showEntireGraph ? {} : { defaultViewport: focusedViewport })}
        minZoom={0.02}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable

      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
        <MiniMap pannable zoomable nodeStrokeWidth={2} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  </section>;
}
