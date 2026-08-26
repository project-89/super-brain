import { basename, normalize } from "node:path";

import {
  transcriptImportBundleSchema,
  type TranscriptAction,
  type TranscriptArtifact,
  type TranscriptChunk,
  type TranscriptProject,
  type TranscriptRun,
  type TranscriptSource,
  type TranscriptTurn,
} from "@_89/fold-transcript";

import { sha256Text } from "./files.js";

interface MutableTurn {
  readonly id: string;
  readonly ordinal: number;
  readonly nativeId?: string;
  startedAt?: string;
  endedAt?: string;
  messageCount: number;
  actionCount: number;
  readonly roles: Set<TranscriptTurn["roles"][number]>;
}

interface ContextObservation {
  readonly cwd?: string;
  readonly branch?: string;
  readonly remote?: string;
  readonly at?: string;
}

function normalizedRoot(value: string): string {
  const result = normalize(value);
  return result.length > 1 && result.endsWith("/") ? result.slice(0, -1) : result;
}

function sanitizedRemote(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().replace(/\/$/, "");
  if (trimmed.length === 0) return undefined;
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return trimmed;
  }
}

function remoteProjectName(remote: string): string | undefined {
  try {
    return basename(new URL(remote).pathname).replace(/\.git$/i, "") || undefined;
  } catch {
    return remote.split(/[/:]/).filter(Boolean).at(-1)?.replace(/\.git$/i, "");
  }
}

export function projectForRoot(root: string, remoteInput?: string): TranscriptProject {
  const normalized = normalizedRoot(root);
  const remote = sanitizedRemote(remoteInput);
  const identityKeyHash = sha256Text(remote === undefined ? `cwd:${normalized}` : `remote:${remote}`);
  return {
    id: `project-${identityKeyHash.slice(0, 24)}`,
    name: ((remote === undefined ? undefined : remoteProjectName(remote)) ?? basename(normalized)) || normalized,
    identityKeyHash,
    resolution: "resolved",
    roots: remote === undefined ? [normalized] : [],
    ...(remote === undefined ? {} : { remote }),
  };
}

function actionKind(name: string | undefined): TranscriptAction["kind"] {
  const normalized = name?.toLowerCase() ?? "";
  if (normalized.includes("apply_patch") || normalized.includes("edit") || normalized.includes("write")) return "file-change";
  if (normalized.includes("test")) return "test";
  if (normalized.includes("exec") || normalized.includes("shell") || normalized.includes("command")) return "command";
  return "tool-call";
}

export class TranscriptBuilder {
  private readonly turns: MutableTurn[] = [];
  private readonly turnsByNativeId = new Map<string, MutableTurn>();
  private readonly actions: TranscriptAction[] = [];
  private readonly messageIds = new Set<string>();
  private readonly actionIds = new Set<string>();
  private readonly contexts: ContextObservation[] = [];
  private readonly remotesByRoot = new Map<string, string>();
  private currentTurn: MutableTurn | undefined;
  private messages = 0;
  private records = 0;
  private unknown = 0;
  private startedAt: string | undefined;
  private endedAt: string | undefined;
  private model: string | undefined;
  private clientVersion: string | undefined;

  constructor(
    readonly source: TranscriptSource,
    readonly nativeId: string,
  ) {}

  countRecord(timestamp?: string): void {
    this.records += 1;
    if (timestamp !== undefined) {
      if (this.startedAt === undefined || timestamp < this.startedAt) this.startedAt = timestamp;
      if (this.endedAt === undefined || timestamp > this.endedAt) this.endedAt = timestamp;
    }
  }

  countUnknown(): void {
    this.unknown += 1;
  }

  setModel(model: string | undefined): void {
    if (model !== undefined) this.model = model;
  }

  setClientVersion(version: string | undefined): void {
    if (version !== undefined) this.clientVersion = version;
  }

  observeContext(
    cwd: string | undefined,
    branch: string | undefined,
    at: string | undefined,
    remoteInput?: string,
  ): void {
    if (cwd === undefined && branch === undefined) return;
    const normalizedCwd = cwd === undefined ? undefined : normalizedRoot(cwd);
    const previous = this.contexts.at(-1);
    const effectiveBranch = branch ??
      (previous !== undefined && previous.cwd === normalizedCwd ? previous.branch : undefined);
    const remote = sanitizedRemote(remoteInput) ??
      (normalizedCwd === undefined ? undefined : this.remotesByRoot.get(normalizedCwd));
    if (normalizedCwd !== undefined && remote !== undefined) this.remotesByRoot.set(normalizedCwd, remote);
    if (
      previous !== undefined &&
      previous.cwd === normalizedCwd &&
      previous.branch === effectiveBranch &&
      previous.remote === remote
    ) return;
    this.contexts.push({
      ...(normalizedCwd === undefined ? {} : { cwd: normalizedCwd }),
      ...(effectiveBranch === undefined ? {} : { branch: effectiveBranch }),
      ...(remote === undefined ? {} : { remote }),
      ...(at === undefined ? {} : { at }),
    });
  }

  startTurn(nativeId: string | undefined, at: string | undefined): string {
    if (nativeId !== undefined) {
      const existing = this.turnsByNativeId.get(nativeId);
      if (existing !== undefined) {
        this.currentTurn = existing;
        if (existing.startedAt === undefined && at !== undefined) existing.startedAt = at;
        return existing.id;
      }
    }
    const ordinal = this.turns.length;
    const turn: MutableTurn = {
      id: `${this.source}:${this.nativeId}:turn:${ordinal}`,
      ordinal,
      ...(nativeId === undefined ? {} : { nativeId }),
      ...(at === undefined ? {} : { startedAt: at }),
      messageCount: 0,
      actionCount: 0,
      roles: new Set(),
    };
    this.turns.push(turn);
    if (nativeId !== undefined) this.turnsByNativeId.set(nativeId, turn);
    this.currentTurn = turn;
    return turn.id;
  }

  addMessage(role: TranscriptTurn["roles"][number], at: string | undefined, nativeId?: string): void {
    if (this.currentTurn === undefined) this.startTurn(undefined, at);
    const turn = this.currentTurn!;
    const messageKey = nativeId === undefined ? undefined : `${role}:${nativeId}`;
    if (messageKey !== undefined && this.messageIds.has(messageKey)) return;
    if (messageKey !== undefined) this.messageIds.add(messageKey);
    turn.messageCount += 1;
    turn.roles.add(role);
    if (at !== undefined) {
      if (turn.startedAt === undefined) turn.startedAt = at;
      turn.endedAt = at;
    }
    this.messages += 1;
  }

  addToolCall(name: string | undefined, at: string | undefined, nativeId?: string): void {
    if (this.currentTurn === undefined) this.startTurn(undefined, at);
    const actionKey = nativeId === undefined ? undefined : `call:${nativeId}`;
    if (actionKey !== undefined && this.actionIds.has(actionKey)) return;
    if (actionKey !== undefined) this.actionIds.add(actionKey);
    const turn = this.currentTurn!;
    const ordinal = this.actions.length;
    this.actions.push({
      id: `${this.source}:${this.nativeId}:action:${ordinal}`,
      ordinal,
      turnId: turn.id,
      ...(at === undefined ? {} : { at }),
      kind: actionKind(name),
      ...(name === undefined ? {} : { name }),
      status: "started",
    });
    turn.actionCount += 1;
  }

  addToolResult(name: string | undefined, at: string | undefined, failed = false, nativeId?: string): void {
    if (this.currentTurn === undefined) this.startTurn(undefined, at);
    const actionKey = nativeId === undefined ? undefined : `result:${nativeId}`;
    if (actionKey !== undefined && this.actionIds.has(actionKey)) return;
    if (actionKey !== undefined) this.actionIds.add(actionKey);
    const turn = this.currentTurn!;
    const ordinal = this.actions.length;
    this.actions.push({
      id: `${this.source}:${this.nativeId}:action:${ordinal}`,
      ordinal,
      turnId: turn.id,
      ...(at === undefined ? {} : { at }),
      kind: "tool-result",
      ...(name === undefined ? {} : { name }),
      status: failed ? "failed" : "completed",
    });
    turn.actionCount += 1;
  }

  finish(artifact: TranscriptArtifact): ReturnType<typeof transcriptImportBundleSchema.parse> {
    const projectsById = new Map<string, TranscriptProject>();
    const segments = this.contexts.map((context, ordinal) => {
      const project = context.cwd === undefined ? undefined : projectForRoot(context.cwd, context.remote);
      if (project !== undefined) {
        const existing = projectsById.get(project.id);
        projectsById.set(project.id, existing === undefined
          ? project
          : { ...existing, roots: [...new Set([...existing.roots, ...project.roots])] });
      }
      return {
        id: `${this.source}:${this.nativeId}:segment:${ordinal}`,
        ordinal,
        ...(project === undefined ? {} : { projectId: project.id }),
        resolution: project === undefined ? "unassigned" as const : "resolved" as const,
        ...(context.cwd === undefined ? {} : { cwd: context.cwd, repo: basename(context.cwd) }),
        ...(context.branch === undefined ? {} : { branch: context.branch }),
        ...(context.at === undefined ? {} : { startedAt: context.at }),
        ...(this.contexts[ordinal + 1]?.at === undefined ? {} : { endedAt: this.contexts[ordinal + 1]!.at }),
      };
    });
    const firstSegment = segments[0];
    const runId = `${this.source}:${this.nativeId}`;
    const run: TranscriptRun = {
      id: runId,
      nativeId: this.nativeId,
      source: this.source,
      artifactId: artifact.id,
      ...(firstSegment?.projectId === undefined ? {} : { projectId: firstSegment.projectId }),
      projectResolution: firstSegment?.resolution ?? "unassigned",
      ...(this.startedAt === undefined ? {} : { startedAt: this.startedAt }),
      ...(this.endedAt === undefined ? {} : { endedAt: this.endedAt }),
      ...(firstSegment?.cwd === undefined ? {} : { cwd: firstSegment.cwd }),
      ...(firstSegment?.branch === undefined ? {} : { branch: firstSegment.branch }),
      ...(this.model === undefined ? {} : { model: this.model }),
      ...(this.clientVersion === undefined ? {} : { clientVersion: this.clientVersion }),
      counts: {
        records: this.records,
        turns: this.turns.length,
        messages: this.messages,
        actions: this.actions.length,
        unknown: this.unknown,
      },
      segments,
    };
    const turns: TranscriptTurn[] = this.turns.map((turn) => ({
      id: turn.id,
      ordinal: turn.ordinal,
      ...(turn.nativeId === undefined ? {} : { nativeId: turn.nativeId }),
      ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
      ...(turn.endedAt === undefined ? {} : { endedAt: turn.endedAt }),
      messageCount: turn.messageCount,
      actionCount: turn.actionCount,
      roles: [...turn.roles],
    }));
    const chunks: TranscriptChunk[] = [];
    for (let turnOffset = 0, actionOffset = 0, sequence = 0;
      turnOffset < turns.length || actionOffset < this.actions.length;
      turnOffset += 250, actionOffset += 250, sequence += 1) {
      chunks.push({
        runId,
        sequence,
        turns: turns.slice(turnOffset, turnOffset + 250),
        actions: this.actions.slice(actionOffset, actionOffset + 250),
      });
    }
    return transcriptImportBundleSchema.parse({
      projects: [...projectsById.values()],
      artifact,
      run,
      chunks,
    });
  }
}
