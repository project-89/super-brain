import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

import type { TranscriptArtifact, TranscriptSource } from "@_89/fold-transcript";

import { TranscriptBuilder } from "./builder.js";
import { fileMetadata, sha256File, sha256Text } from "./files.js";
import { arrayValue, isoTimestamp, recordValue, stringValue } from "./json.js";
import type { ParsedTranscript } from "./types.js";

const PARSER_VERSION = "1";

async function artifactFor(path: string, source: TranscriptSource, parserId: string): Promise<TranscriptArtifact> {
  const [sha256, metadata] = await Promise.all([sha256File(path), fileMetadata(path)]);
  return {
    id: `artifact-${sha256}`,
    source,
    sha256,
    sourcePathHash: sha256Text(path),
    byteLength: metadata.byteLength,
    mediaType: "application/x-ndjson",
    parser: { id: parserId, version: PARSER_VERSION },
    modifiedAt: metadata.modifiedAt,
    contentPolicy: "metadata-only",
    stored: false,
    redactionCount: 0,
  };
}

async function visitJsonl(
  path: string,
  visitor: (record: Record<string, unknown>) => void,
  invalid: () => void,
): Promise<void> {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      const record = recordValue(parsed);
      if (record === undefined) invalid();
      else visitor(record);
    } catch {
      invalid();
    }
  }
}

function nativeIdFromFilename(path: string): string {
  const filename = basename(path, ".jsonl");
  const uuid = filename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i)?.[1];
  return uuid ?? filename;
}

function role(value: unknown): "user" | "assistant" | "developer" | "system" | "tool" | "other" {
  return value === "user" || value === "assistant" || value === "developer" || value === "system" || value === "tool"
    ? value
    : "other";
}

export async function parseClaudeTranscript(path: string): Promise<ParsedTranscript> {
  const source = "claude-code" as const;
  const builder = new TranscriptBuilder(source, nativeIdFromFilename(path));
  const knownTypes = new Set([
    "assistant", "attachment", "file-history-snapshot", "last-prompt", "progress",
    "queue-operation", "summary", "system", "tool-use-summary", "user",
  ]);
  await visitJsonl(path, (record) => {
    const at = isoTimestamp(record.timestamp);
    builder.countRecord(at);
    builder.observeContext(stringValue(record.cwd), stringValue(record.gitBranch), at);
    builder.setClientVersion(stringValue(record.version));
    const type = stringValue(record.type);
    if (type === "user") {
      const message = recordValue(record.message);
      const blocks = arrayValue(message?.content);
      const hasToolResult = blocks.some((block) => recordValue(block)?.type === "tool_result");
      if (record.isMeta !== true && !hasToolResult) {
        builder.startTurn(stringValue(record.promptId) ?? stringValue(record.uuid), at);
        builder.addMessage("user", at, stringValue(record.uuid));
      } else if (hasToolResult) {
        builder.addMessage("tool", at, stringValue(record.uuid));
      }
      for (const block of blocks) {
        const value = recordValue(block);
        if (value?.type === "tool_result") {
          const callId = stringValue(value.tool_use_id);
          builder.addToolResult(callId, at, value.is_error === true, callId);
        }
      }
    } else if (type === "assistant") {
      const message = recordValue(record.message);
      builder.setModel(stringValue(message?.model));
      const blocks = arrayValue(message?.content);
      if (blocks.some((block) => recordValue(block)?.type !== "thinking")) {
        builder.addMessage("assistant", at, stringValue(message?.id));
      }
      for (const block of blocks) {
        const value = recordValue(block);
        if (value?.type === "tool_use") {
          builder.addToolCall(stringValue(value.name), at, stringValue(value.id));
        }
      }
    } else if (type !== undefined && !knownTypes.has(type)) {
      builder.countUnknown();
    }
  }, () => {
    builder.countRecord();
    builder.countUnknown();
  });
  const artifact = await artifactFor(path, source, "claude-jsonl");
  return { sourcePath: path, bundle: builder.finish(artifact) };
}

export async function parseCodexTranscript(path: string): Promise<ParsedTranscript> {
  const source = "codex" as const;
  const builder = new TranscriptBuilder(source, nativeIdFromFilename(path));
  await visitJsonl(path, (record) => {
    const at = isoTimestamp(record.timestamp);
    builder.countRecord(at);
    const type = stringValue(record.type);
    const payload = recordValue(record.payload);
    if (type === "session_meta") {
      const git = recordValue(payload?.git);
      builder.observeContext(
        stringValue(payload?.cwd),
        stringValue(git?.branch),
        at,
        stringValue(git?.repository_url),
      );
      builder.setClientVersion(stringValue(payload?.cli_version));
    } else if (type === "turn_context") {
      builder.startTurn(stringValue(payload?.turn_id), at);
      builder.observeContext(stringValue(payload?.cwd), stringValue(payload?.git_branch), at);
      builder.setModel(stringValue(payload?.model));
    } else if (type === "event_msg") {
      if (payload?.type === "task_started") builder.startTurn(stringValue(payload.turn_id), at);
    } else if (type === "response_item") {
      const payloadType = stringValue(payload?.type);
      if (payloadType === "message") {
        builder.addMessage(role(payload?.role), at, stringValue(payload?.id));
      } else if (payloadType === "function_call" || payloadType === "custom_tool_call") {
        builder.addToolCall(stringValue(payload?.name), at, stringValue(payload?.call_id));
      } else if (payloadType === "function_call_output" || payloadType === "custom_tool_call_output") {
        const callId = stringValue(payload?.call_id);
        builder.addToolResult(callId, at, false, callId);
      } else if (payloadType !== "reasoning") {
        builder.countUnknown();
      }
    } else if (type !== "world_state" && type !== "compacted") {
      builder.countUnknown();
    }
  }, () => {
    builder.countRecord();
    builder.countUnknown();
  });
  const artifact = await artifactFor(path, source, "codex-jsonl");
  return { sourcePath: path, bundle: builder.finish(artifact) };
}
