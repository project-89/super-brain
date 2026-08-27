import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { ZodError } from "zod";

import { verifyCheckpoint } from "./checkpoint.js";
import {
  parseJournalRecord,
  type JournalRecord,
} from "./records.js";
import {
  JournalError,
  type AppendOptions,
  type JournalDiagnostic,
  type ReadJournalOptions,
  type ReadJournalResult,
} from "./types.js";

const DEFAULT_MAX_LINE_BYTES = 16 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) {
    return error.issues.map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`).join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

function parseLine(path: string, bytes: Buffer, line: number): JournalRecord {
  if (bytes.length === 0) {
    throw new JournalError(`blank JSONL record at line ${line}`, "blank-line", path, line);
  }

  let input: unknown;
  try {
    input = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new JournalError(
      `invalid JSON at line ${line}: ${errorMessage(error)}`,
      "invalid-json",
      path,
      line,
    );
  }

  try {
    return parseJournalRecord(input);
  } catch (error) {
    throw new JournalError(
      `invalid journal record at line ${line}: ${errorMessage(error)}`,
      "invalid-record",
      path,
      line,
    );
  }
}

function withoutCarriageReturn(bytes: Buffer): Buffer {
  return bytes.at(-1) === 13 ? bytes.subarray(0, -1) : bytes;
}

export function encodeJournalRecord(record: JournalRecord): string {
  return `${JSON.stringify(parseJournalRecord(record))}\n`;
}

export async function readJournal(
  path: string,
  options: ReadJournalOptions = {},
): Promise<ReadJournalResult> {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const tailPolicy = options.tailPolicy ?? "error";
  const verifyCheckpoints = options.verifyCheckpoints ?? true;
  const records: JournalRecord[] = [];
  const entries: ReadJournalResult["entries"][number][] = [];
  const checkpoints: ReadJournalResult["checkpoints"][number][] = [];
  const diagnostics: JournalDiagnostic[] = [];
  const seenEventIds = new Set<string>();
  const previousIdAtTime = new Map<number, string>();

  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (options.missing === "empty") return { records, entries, checkpoints, diagnostics };
      throw new JournalError(`journal does not exist: ${path}`, "missing-file", path);
    }
    throw error;
  }

  let pending = Buffer.alloc(0);
  let line = 1;

  const accept = (record: JournalRecord, recordLine: number): void => {
    if (record.recordType === "event") {
      if (seenEventIds.has(record.event.id)) {
        throw new JournalError(
          `duplicate event id at line ${recordLine}: ${record.event.id}`,
          "invalid-record",
          path,
          recordLine,
        );
      }
      const previousId = previousIdAtTime.get(record.event.at.t);
      if (previousId !== undefined && previousId >= record.event.id) {
        throw new JournalError(
          `event ids at t=${record.event.at.t} are not monotonic at line ${recordLine}: ${previousId}, ${record.event.id}`,
          "invalid-record",
          path,
          recordLine,
        );
      }
      seenEventIds.add(record.event.id);
      previousIdAtTime.set(record.event.at.t, record.event.id);
      entries.push({ event: record.event, status: record.status });
    } else {
      if (verifyCheckpoints) {
        let components;
        if (record.checkpoint.componentSet !== "core-v0.7") {
          components = options.checkpointComponents?.[record.checkpoint.componentSet];
          if (components === undefined) {
            throw new JournalError(
              `checkpoint at line ${recordLine} requires component set ${record.checkpoint.componentSet}`,
              "checkpoint-components-unavailable",
              path,
              recordLine,
            );
          }
        }
        const verification = verifyCheckpoint(record.checkpoint, entries, components);
        if (!verification.valid) {
          throw new JournalError(
            `checkpoint mismatch at line ${recordLine}; expected ${verification.expected.stateDigest}`,
            "checkpoint-mismatch",
            path,
            recordLine,
          );
        }
      }
      checkpoints.push(record.checkpoint);
    }
    records.push(record);
  };

  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (true) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);

      let newline = pending.indexOf(10);
      while (newline >= 0) {
        const lineBytes = withoutCarriageReturn(pending.subarray(0, newline));
        if (lineBytes.length > maxLineBytes) {
          throw new JournalError(
            `journal line ${line} exceeds ${maxLineBytes} bytes`,
            "line-too-large",
            path,
            line,
          );
        }
        accept(parseLine(path, lineBytes, line), line);
        pending = pending.subarray(newline + 1);
        line += 1;
        newline = pending.indexOf(10);
      }

      if (pending.length > maxLineBytes) {
        throw new JournalError(
          `journal line ${line} exceeds ${maxLineBytes} bytes`,
          "line-too-large",
          path,
          line,
        );
      }
    }

    if (pending.length > 0) {
      const tail = withoutCarriageReturn(pending);
      try {
        accept(parseLine(path, tail, line), line);
      } catch (error) {
        if (
          tailPolicy === "recover-truncated-tail" &&
          error instanceof JournalError &&
          error.kind === "invalid-json"
        ) {
          diagnostics.push({
            kind: "truncated-tail-ignored",
            line,
            byteLength: tail.length,
          });
        } else {
          throw error;
        }
      }
    }
  } finally {
    await handle.close();
  }

  return { records, entries, checkpoints, diagnostics };
}

async function ensureParent(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

export async function appendJournalRecord(
  path: string,
  record: JournalRecord,
  options: AppendOptions = {},
): Promise<void> {
  const encoded = encodeJournalRecord(record);
  await ensureParent(path);
  const handle = await open(path, "a+", 0o600);
  try {
    const stat = await handle.stat();
    if (stat.size > 0) {
      const lastByte = Buffer.allocUnsafe(1);
      await handle.read(lastByte, 0, 1, stat.size - 1);
      if (lastByte[0] !== 10) {
        throw new JournalError(
          `refusing to append after an unterminated journal line: ${path}`,
          "torn-tail",
          path,
        );
      }
    }
    await handle.appendFile(encoded, "utf8");
    if (options.sync === true) await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function rewriteJournalAtomically(
  path: string,
  records: readonly JournalRecord[],
  options: AppendOptions = {},
): Promise<void> {
  const encoded = records.map(encodeJournalRecord).join("");
  await ensureParent(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(encoded, "utf8");
    if (options.sync === true) await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
