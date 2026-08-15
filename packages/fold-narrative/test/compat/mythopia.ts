import { readFileSync } from "node:fs";

import {
  parseEvent,
  type Change,
  type FoldLogEntry,
} from "@_89/fold";
import { parse } from "yaml";

import {
  MEMBERSHIP_EDGE_TYPE,
  NARRATIVE_BOOTSTRAP_KIND,
  NARRATIVE_EVENT_KIND,
  NarrativeStore,
  type NarrativeArc,
  type NarrativeDefinition,
} from "../../src/index.js";

interface MythopiaArcDelta {
  arc: string;
  delta: number;
}

interface MythopiaKnowledge {
  learners?: string[];
  hidden_from?: string[];
  fact: string;
}

interface MythopiaEvent {
  id: string;
  title: string;
  story_time: {
    world_date: string;
    granularity?: "beat" | "scene" | "chapter" | "era";
  };
  location?: string;
  participants?: string[];
  magnitude?: number;
  valence?: number;
  arc_deltas?: MythopiaArcDelta[];
  stakes_deltas?: MythopiaArcDelta[];
  resolves?: string[];
  reopens?: string[];
  knowledge?: MythopiaKnowledge[];
  causes?: string[];
}

interface MythopiaCanon {
  mythos: {
    id: string;
    name: string;
    params?: { convergence_threshold?: number };
  };
  characters?: { id: string; members?: string[] }[];
  arcs?: {
    id: string;
    kind?: string;
    owner?: string;
    question?: string;
    stakes_baseline?: number;
  }[];
  events: MythopiaEvent[];
}

export interface MythopiaParityFixture {
  readonly definition: NarrativeDefinition;
  readonly entries: readonly FoldLogEntry[];
  readonly store: NarrativeStore;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function authoredMeasurement(value: number) {
  return { value, basis: "authored" as const };
}

export function loadMythopiaFixture(path: URL): MythopiaParityFixture {
  const canon = parse(readFileSync(path, "utf8")) as MythopiaCanon;
  const arcs: NarrativeArc[] = (canon.arcs ?? []).map((arc) => ({
    id: arc.id,
    ...(arc.kind === undefined ? {} : { kind: arc.kind }),
    ...(arc.owner === undefined ? {} : { owner: arc.owner }),
    ...(arc.question === undefined ? {} : { question: arc.question }),
    ...(arc.stakes_baseline === undefined ? {} : { stakesBaseline: arc.stakes_baseline }),
  }));
  const definition: NarrativeDefinition = {
    arcs,
    ...(canon.mythos.params?.convergence_threshold === undefined
      ? {}
      : { convergenceThreshold: canon.mythos.params.convergence_threshold }),
  };

  const bootstrapChanges: Change[] = arcs.map((arc) => ({
    verb: "create",
    subject: arc.id,
    nodeKind: "narrative-node",
    after: {
      "drama.state": "open",
      "drama.tension": 0,
      "drama.stakes": arc.stakesBaseline ?? 0,
      "drama.resolvedBy": null,
    },
  }));
  for (const group of canon.characters ?? []) {
    for (const member of group.members ?? []) {
      bootstrapChanges.push({
        verb: "link",
        subject: group.id,
        object: member,
        edgeType: MEMBERSHIP_EDGE_TYPE,
        edgeId: `membership:${group.id}:${member}`,
      });
    }
  }
  if (bootstrapChanges.length === 0) {
    bootstrapChanges.push({
      verb: "create",
      subject: canon.mythos.id,
      nodeKind: "narrative-node",
      after: { name: canon.mythos.name },
    });
  }

  const bootstrap = parseEvent({
    specVersion: "0.7",
    id: "fixture-bootstrap",
    kind: NARRATIVE_BOOTSTRAP_KIND,
    title: "Fixture bootstrap",
    at: { t: 0, worldDate: canon.events[0]?.story_time.world_date ?? "0001-01-01" },
    author: { kind: "ingest", id: "mythopia-fixture" },
    capture: { scope: { workspace: "mythopia-parity" } },
    changes: bootstrapChanges,
  });

  const coreTension = new Map(arcs.map((arc) => [arc.id, 0]));
  const coreStakes = new Map(arcs.map((arc) => [arc.id, arc.stakesBaseline ?? 0]));
  const coreState = new Map(arcs.map((arc) => [arc.id, "open"]));
  const coreResolvedBy = new Map<string, string | null>(arcs.map((arc) => [arc.id, null]));
  const known = new Set<string>();
  const shielded = new Set<string>();

  const ordered = canon.events
    .map((event, index) => ({ event, index }))
    .sort(
      (left, right) =>
        left.event.story_time.world_date.localeCompare(right.event.story_time.world_date) ||
        left.index - right.index,
    );

  const eventEntries: FoldLogEntry[] = ordered.map(({ event }, index) => {
    const changes: Change[] = [
      {
        verb: "set",
        subject: event.id,
        component: "narrative.source",
        field: "present",
        before: null,
        after: true,
      },
    ];

    for (const delta of event.arc_deltas ?? []) {
      const before = coreTension.get(delta.arc) ?? 0;
      const after = clamp01(before + delta.delta);
      changes.push({
        verb: "adjust",
        subject: delta.arc,
        component: "drama.tension",
        before,
        after,
        amount: delta.delta,
      });
      coreTension.set(delta.arc, after);
    }
    for (const delta of event.stakes_deltas ?? []) {
      const before = coreStakes.get(delta.arc) ?? 0;
      const after = clamp01(before + delta.delta);
      changes.push({
        verb: "adjust",
        subject: delta.arc,
        component: "drama.stakes",
        before,
        after,
        amount: delta.delta,
      });
      coreStakes.set(delta.arc, after);
    }
    for (const arc of event.resolves ?? []) {
      changes.push({
        verb: "set",
        subject: arc,
        component: "drama.state",
        before: coreState.get(arc) ?? "open",
        after: "closed",
      });
      changes.push({
        verb: "set",
        subject: arc,
        component: "drama.resolvedBy",
        before: coreResolvedBy.get(arc) ?? null,
        after: event.id,
      });
      coreState.set(arc, "closed");
      coreResolvedBy.set(arc, event.id);
    }
    for (const arc of event.reopens ?? []) {
      changes.push({
        verb: "set",
        subject: arc,
        component: "drama.state",
        before: coreState.get(arc) ?? "closed",
        after: "open",
      });
      changes.push({
        verb: "set",
        subject: arc,
        component: "drama.resolvedBy",
        before: coreResolvedBy.get(arc) ?? null,
        after: null,
      });
      coreState.set(arc, "open");
      coreResolvedBy.set(arc, null);
    }
    for (const assertion of event.knowledge ?? []) {
      for (const audience of assertion.learners ?? []) {
        const key = JSON.stringify([audience, assertion.fact]);
        changes.push({
          verb: "reveal",
          subject: assertion.fact,
          audience,
          before: known.has(key),
          after: true,
        });
        known.add(key);
      }
      for (const audience of assertion.hidden_from ?? []) {
        const key = JSON.stringify([audience, assertion.fact]);
        changes.push({
          verb: "conceal",
          subject: assertion.fact,
          audience,
          before: shielded.has(key),
          after: true,
        });
        shielded.add(key);
      }
    }

    const foldEvent = parseEvent({
      specVersion: "0.7",
      id: event.id,
      kind: NARRATIVE_EVENT_KIND,
      title: event.title,
      at: {
        t: index + 1,
        worldDate: event.story_time.world_date,
        ...(event.story_time.granularity === undefined
          ? {}
          : { granularity: event.story_time.granularity }),
      },
      ...(event.location === undefined ? {} : { location: event.location }),
      ...(event.participants === undefined ? {} : { participants: event.participants }),
      ...(event.causes === undefined ? {} : { causedBy: event.causes }),
      ...(event.magnitude === undefined
        ? {}
        : { magnitude: authoredMeasurement(event.magnitude) }),
      ...(event.valence === undefined ? {} : { valence: authoredMeasurement(event.valence) }),
      author: { kind: "ingest", id: "mythopia-fixture" },
      capture: { scope: { workspace: "mythopia-parity" } },
      changes,
      extensions: { "x.mythopia.sourceIndex": index },
    });
    return { event: foldEvent, status: "canon" };
  });

  const entries: FoldLogEntry[] = [
    { event: bootstrap, status: "canon" },
    ...eventEntries,
  ];
  return { definition, entries, store: new NarrativeStore(definition, entries) };
}
