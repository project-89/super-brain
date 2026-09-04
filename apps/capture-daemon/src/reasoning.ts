import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import type { HookSource } from "./types.js";

export interface ExposedReasoningItem {
  readonly id: string;
  readonly text: string;
}

export interface ExposedReasoningDelta {
  readonly startCursor: number;
  readonly cursor: number;
  readonly records: readonly unknown[];
  readonly items: readonly ExposedReasoningItem[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function textParts(value: unknown): string[] {
  if (typeof value === "string") return value.trim().length === 0 ? [] : [value.trim()];
  if (Array.isArray(value)) return value.flatMap(textParts);
  const record = object(value);
  if (record === undefined) return [];
  return [record.text, record.summary_text, record.content].flatMap(textParts);
}

function reasoningText(record: Record<string, unknown>, source: HookSource): string | undefined {
  if (source === "claude-code" && record.type === "assistant") {
    const message = object(record.message);
    const blocks = Array.isArray(message?.content) ? message.content : [];
    const text = blocks.flatMap((block) => {
      const item = object(block);
      return item?.type === "thinking" ? textParts(item.thinking ?? item.text) : [];
    }).join("\n").trim();
    return text.length === 0 ? undefined : text;
  }
  if (source !== "codex") return undefined;
  const payload = object(record.payload);
  if (record.type === "response_item" && payload?.type === "reasoning") {
    const text = textParts(payload.summary).join("\n").trim();
    return text.length === 0 ? undefined : text;
  }
  if (
    record.type === "event_msg" &&
    typeof payload?.type === "string" &&
    payload.type.includes("reasoning")
  ) {
    return nonEmpty(payload.text) ?? nonEmpty(payload.message) ?? nonEmpty(payload.summary);
  }
  return undefined;
}

function itemFor(parsed: unknown, source: HookSource, offset: number): ExposedReasoningItem | undefined {
  const record = object(parsed);
  if (record === undefined) return undefined;
  const text = reasoningText(record, source);
  if (text === undefined) return undefined;
  const nativeId = nonEmpty(object(record.payload)?.id) ?? nonEmpty(record.uuid) ?? String(offset);
  const id = createHash("sha256").update(`${source}\0${nativeId}\0${text}`).digest("hex");
  return { id, text };
}

export async function readExposedReasoningDelta(
  path: string,
  source: HookSource,
  cursorInput = 0,
  options: { readonly maxBytes?: number } = {},
): Promise<ExposedReasoningDelta> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { startCursor: cursorInput, cursor: cursorInput, records: [], items: [] };
    }
    throw error;
  }
  const start = cursorInput > size ? 0 : Math.max(0, cursorInput);
  if (start === size) return { startCursor: start, cursor: start, records: [], items: [] };
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY;
  if (!(maxBytes > 0)) throw new TypeError("reasoning delta maxBytes must be positive");
  const end = Number.isFinite(maxBytes) ? Math.min(size - 1, start + Math.floor(maxBytes) - 1) : undefined;
  let carry = Buffer.alloc(0);
  let consumed = 0;
  const records: unknown[] = [];
  const items: ExposedReasoningItem[] = [];
  for await (const chunk of createReadStream(path, { start, ...(end === undefined ? {} : { end }) })) {
    const input = Buffer.concat([carry, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let lineStart = 0;
    for (let index = 0; index < input.length; index += 1) {
      if (input[index] !== 0x0a) continue;
      const line = input.subarray(lineStart, index).toString("utf8").trim();
      const lineOffset = start + consumed + lineStart;
      if (line.length > 0) {
        try {
          const parsed = JSON.parse(line) as unknown;
          records.push(parsed);
          const item = itemFor(parsed, source, lineOffset);
          if (item !== undefined) items.push(item);
        } catch {
          // A malformed complete producer record is skipped without losing the
          // cursor position for later valid records.
        }
      }
      lineStart = index + 1;
    }
    consumed += lineStart;
    carry = input.subarray(lineStart);
  }
  return { startCursor: start, cursor: start + consumed, records, items };
}
