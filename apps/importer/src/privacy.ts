import { createHmac } from "node:crypto";
import { extname } from "node:path";

import {
  transcriptImportBundleSchema,
  type TranscriptImportBundle,
} from "@_89/fold-transcript";

export type AnonymizationPolicy = "none" | "pseudonymous" | "strict";

const IDENTITY_FIELDS = new Set([
  "account_id",
  "accountId",
  "call_id",
  "callId",
  "conversation_id",
  "conversationId",
  "organization_id",
  "organizationId",
  "session_id",
  "sessionId",
  "task_id",
  "taskId",
  "tool_use_id",
  "toolUseId",
  "turn_id",
  "turnId",
  "user_id",
  "userId",
]);

const PATH_FIELDS = new Set([
  "cwd",
  "file_path",
  "filePath",
  "notebook_path",
  "notebookPath",
  "path",
  "paths",
  "project_root",
  "projectRoot",
  "rollout_path",
  "rolloutPath",
  "root",
  "target_file",
  "targetFile",
  "transcript_path",
  "transcriptPath",
]);

const REMOTE_FIELDS = new Set(["remote", "repository_url", "repositoryUrl"]);
const DIGEST_FIELDS = new Set([
  "gitHead",
  "head",
  "headAfter",
  "headBefore",
  "worktree",
  "worktreeAfter",
  "worktreeBefore",
]);

function safeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "value";
}

export class RecordAnonymizer {
  constructor(
    readonly policy: AnonymizationPolicy,
    private readonly key?: Uint8Array,
  ) {
    if (policy !== "none" && (key === undefined || key.byteLength < 32)) {
      throw new TypeError("pseudonymous and strict anonymization require a 32-byte key");
    }
  }

  digest(kind: string, value: string): string {
    if (this.policy === "none") return value;
    return createHmac("sha256", this.key!).update(`${kind}\0${value}`).digest("hex");
  }

  alias(kind: string, value: string): string {
    if (this.policy === "none") return value;
    return `${safeLabel(kind)}-${this.digest(kind, value).slice(0, 24)}`;
  }

  path(value: string): string {
    if (this.policy === "none") return value;
    if (this.policy === "strict") {
      const extension = extname(value).slice(0, 20);
      return `/private/${this.alias("path", value)}${extension}`;
    }
    if (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) return value;
    if (this.policy === "pseudonymous") {
      const normalized = value.replaceAll("\\", "/");
      const parts = normalized.split("/").filter(Boolean);
      const prefix = parts[0] === "Users" || parts[0] === "home" ? parts[0] : "workspace";
      const start = prefix === "workspace" ? 0 : 1;
      const aliases = parts.slice(start).map((part, index, values) => {
        if (index === 0 && prefix !== "workspace") return this.alias("user", part);
        const extension = index === values.length - 1 ? extname(part).slice(0, 20) : "";
        const stem = extension.length === 0 ? part : part.slice(0, -extension.length);
        return `${this.alias("path-segment", stem)}${extension}`;
      });
      return `/${prefix}/${aliases.join("/")}`;
    }
    return value;
  }

  text(value: string): string {
    if (this.policy === "none") return value;
    let result = value
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, (email) => this.alias("email", email.toLowerCase()))
      .replace(/git@([^:\s]+):([^\s]+)/g, (remote) => `urn:repo:${this.alias("remote", remote)}`);
    if (this.policy === "strict") {
      result = result
        .replace(/https?:\/\/[^\s)\]}>'"]+/gi, (url) => `urn:url:${this.alias("url", url)}`)
        .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (address) => this.alias("ip", address));
    }
    return result.replace(
      /(^|[\s"'`(])((?:\/[^/\s"'`()\[\]{}]+){2,})/g,
      (_match, prefix: string, path: string) => `${prefix}${this.path(path)}`,
    );
  }

  value(value: unknown, field?: string): unknown {
    if (this.policy === "none") return value;
    if (typeof value === "string") {
      if (field !== undefined && IDENTITY_FIELDS.has(field)) return this.alias(field, value);
      if (field !== undefined && PATH_FIELDS.has(field)) return this.path(value);
      if (field !== undefined && REMOTE_FIELDS.has(field)) return `urn:repo:${this.alias("remote", value)}`;
      if (field !== undefined && DIGEST_FIELDS.has(field)) return this.digest(field, value);
      if (field === "project" || field === "repo") return this.alias(field, value);
      if (field === "branch" || field === "git_branch") return this.alias("branch", value);
      if (field === "username" || field === "user_name") return this.alias("user", value);
      return this.text(value);
    }
    if (Array.isArray(value)) return value.map((item) => this.value(item, field));
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          key === "encrypted_content" ? item : this.value(item, key),
        ]),
      );
    }
    return value;
  }

  transcriptBundle(bundle: TranscriptImportBundle): TranscriptImportBundle {
    if (this.policy === "none") return bundle;
    const projectIds = new Map(bundle.projects.map(({ id }) => [id, this.alias("project", id)]));
    const artifactId = this.alias("artifact", bundle.artifact.id);
    const runId = this.alias("run", bundle.run.id);
    const turnIds = new Map(bundle.chunks.flatMap(({ turns }) =>
      turns.map(({ id }) => [id, this.alias("turn", id)] as const)
    ));
    return transcriptImportBundleSchema.parse({
      projects: bundle.projects.map((project) => ({
        ...project,
        id: projectIds.get(project.id)!,
        name: this.alias("project-name", project.name),
        identityKeyHash: this.digest("project-identity", project.identityKeyHash),
        roots: project.roots.map((root) => this.path(root)),
        ...(project.remote === undefined ? {} : { remote: `urn:repo:${this.alias("remote", project.remote)}` }),
      })),
      artifact: {
        ...bundle.artifact,
        id: artifactId,
        sha256: this.digest("artifact-content", bundle.artifact.sha256),
        sourcePathHash: this.digest("artifact-path", bundle.artifact.sourcePathHash),
        anonymizationPolicy: this.policy,
      },
      run: {
        ...bundle.run,
        id: runId,
        nativeId: this.alias("native-run", bundle.run.nativeId),
        artifactId,
        ...(bundle.run.projectId === undefined ? {} : { projectId: projectIds.get(bundle.run.projectId)! }),
        ...(bundle.run.cwd === undefined ? {} : { cwd: this.path(bundle.run.cwd) }),
        ...(bundle.run.branch === undefined ? {} : { branch: this.alias("branch", bundle.run.branch) }),
        segments: bundle.run.segments.map((segment) => ({
          ...segment,
          id: this.alias("segment", segment.id),
          ...(segment.projectId === undefined ? {} : { projectId: projectIds.get(segment.projectId)! }),
          ...(segment.cwd === undefined ? {} : { cwd: this.path(segment.cwd) }),
          ...(segment.repo === undefined ? {} : { repo: this.alias("repo-name", segment.repo) }),
          ...(segment.branch === undefined ? {} : { branch: this.alias("branch", segment.branch) }),
        })),
      },
      chunks: bundle.chunks.map((chunk) => ({
        ...chunk,
        runId,
        turns: chunk.turns.map((turn) => ({
          ...turn,
          id: turnIds.get(turn.id)!,
          ...(turn.nativeId === undefined ? {} : { nativeId: this.alias("native-turn", turn.nativeId) }),
        })),
        actions: chunk.actions.map((action) => ({
          ...action,
          id: this.alias("action", action.id),
          ...(action.turnId === undefined ? {} : { turnId: turnIds.get(action.turnId)! }),
        })),
      })),
    });
  }
}
