import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { TranscriptRun, TranscriptSource } from "@_89/fold-transcript";

import type { VaultMessage } from "./types.js";
import { decryptVaultLine } from "@_89/super-brain-importer";

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.flatMap((item) => {
    const block = recordValue(item);
    if (block === undefined) return [];
    if (block.type !== "text" && block.type !== "input_text" && block.type !== "output_text") return [];
    const text = stringValue(block.text);
    return text === undefined ? [] : [text];
  }).join("\n").trim();
}

function isBoilerplate(text: string): boolean {
  const prefix = text.trimStart().slice(0, 160);
  return /^(?:You are (?:Codex|Claude)|# AGENTS\.md instructions|<permissions instructions>|<environment_context>|<collaboration_mode>|Hello memory agent)/i.test(prefix);
}

function turnId(source: TranscriptSource, nativeId: string, ordinal: number): string {
  return `${source}:${nativeId}:turn:${ordinal}`;
}

export function messagesFromVaultRecords(
  source: TranscriptSource,
  nativeId: string,
  records: readonly Record<string, unknown>[],
): VaultMessage[] {
  const messages: VaultMessage[] = [];
  const seen = new Set<string>();
  let ordinal = -1;
  const codexTurns = new Map<string, number>();
  let currentTurn: number | undefined;
  let observedProjectPath: string | undefined;

  const startTurn = (nativeTurnId?: string) => {
    if (nativeTurnId !== undefined) {
      const existing = codexTurns.get(nativeTurnId);
      if (existing !== undefined) {
        currentTurn = existing;
        return;
      }
    }
    ordinal += 1;
    currentTurn = ordinal;
    if (nativeTurnId !== undefined) codexTurns.set(nativeTurnId, ordinal);
  };

  const add = (role: "user" | "assistant", text: string, nativeMessageId?: string, at?: string) => {
    const normalized = text.trim();
    if (normalized.length === 0 || isBoilerplate(normalized)) return;
    if (currentTurn === undefined) startTurn();
    const key = nativeMessageId === undefined ? undefined : `${role}:${nativeMessageId}`;
    if (key !== undefined && seen.has(key)) return;
    if (key !== undefined) seen.add(key);
    messages.push({
      role,
      text: normalized,
      turnId: turnId(source, nativeId, currentTurn!),
      ...(at === undefined ? {} : { at }),
      ...(observedProjectPath === undefined ? {} : { projectPath: observedProjectPath }),
    });
  };

  for (const record of records) {
    const type = stringValue(record.type);
    const at = stringValue(record.timestamp);
    if (source === "claude-code") {
      if (type === "user") {
        const message = recordValue(record.message);
        const content = textContent(message?.content);
        const workingDirectory = content.match(/<working_directory>([^<]+)<\/working_directory>/i)?.[1]?.trim();
        if (workingDirectory?.startsWith("/") === true) observedProjectPath = workingDirectory;
        const blocks = Array.isArray(message?.content) ? message.content : [];
        const hasToolResult = blocks.some((item) => recordValue(item)?.type === "tool_result");
        if (record.isMeta !== true && !hasToolResult) {
          startTurn(stringValue(record.promptId) ?? stringValue(record.uuid));
          add("user", content, stringValue(record.uuid), at);
        }
      } else if (type === "assistant") {
        const message = recordValue(record.message);
        add("assistant", textContent(message?.content), stringValue(message?.id), at);
      }
      continue;
    }

    const payload = recordValue(record.payload);
    if (type === "turn_context") startTurn(stringValue(payload?.turn_id));
    else if (type === "event_msg" && payload?.type === "task_started") startTurn(stringValue(payload.turn_id));
    else if (type === "response_item" && payload?.type === "message") {
      const role = payload.role === "user" || payload.role === "assistant" ? payload.role : undefined;
      if (role !== undefined) add(role, textContent(payload.content), stringValue(payload.id), at);
    }
  }
  return messages;
}

export function vaultPath(vaultRoot: string, run: TranscriptRun, encrypted = false): string | undefined {
  const sha256 = run.artifactId.replace(/^artifact-/, "");
  if (!/^[0-9a-f]{64}$/.test(sha256)) return undefined;
  return join(vaultRoot, run.source, sha256.slice(0, 2), `${sha256}.jsonl${encrypted ? ".enc" : ""}`);
}

export async function readVaultMessages(
  vaultRoot: string,
  run: TranscriptRun,
  encryptionKey?: Uint8Array,
): Promise<readonly VaultMessage[] | undefined> {
  const encryptedPath = vaultPath(vaultRoot, run, true);
  const plainPath = vaultPath(vaultRoot, run);
  if (encryptedPath === undefined || plainPath === undefined) return undefined;
  const path = await access(encryptedPath).then(() => encryptedPath).catch(() =>
    access(plainPath).then(() => plainPath).catch(() => undefined));
  if (path === undefined) return undefined;
  const records: Record<string, unknown>[] = [];
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    const decrypted = decryptVaultLine(line, encryptionKey);
    try {
      const record = recordValue(JSON.parse(decrypted) as unknown);
      if (record !== undefined) records.push(record);
    } catch {
      // Redacted vaults contain JSONL; malformed lines are ignored independently.
    }
  }
  return messagesFromVaultRecords(run.source, run.nativeId, records);
}
