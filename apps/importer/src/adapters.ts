import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline";

import type { TranscriptArtifact, TranscriptSource } from "@_89/fold-transcript";

import { TranscriptBuilder } from "./builder.js";
import { fileMetadata, sha256File, sha256Text } from "./files.js";
import { recordValue } from "./json.js";
import { NativeTranscriptNormalizer } from "./native.js";
import type { ParsedTranscript } from "./types.js";

const PARSER_VERSION = "2";

interface SourceMetadata {
  readonly byteLength: number;
  readonly modifiedAt: string;
}

function sameMetadata(left: SourceMetadata, right: SourceMetadata): boolean {
  return left.byteLength === right.byteLength && left.modifiedAt === right.modifiedAt;
}

async function artifactFor(
  path: string,
  source: TranscriptSource,
  parserId: string,
  parsedMetadata: SourceMetadata,
): Promise<TranscriptArtifact> {
  const beforeHash = await fileMetadata(path);
  if (!sameMetadata(parsedMetadata, beforeHash)) {
    throw new Error("Transcript source changed while it was being parsed; retry the scan");
  }
  const sha256 = await sha256File(path);
  const metadata = await fileMetadata(path);
  if (!sameMetadata(beforeHash, metadata)) {
    throw new Error("Transcript source changed while it was being hashed; retry the scan");
  }
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

async function parseNativeTranscript(path: string, source: TranscriptSource): Promise<ParsedTranscript> {
  const parsedMetadata = await fileMetadata(path);
  const nativeId = nativeIdFromFilename(path);
  const builder = new TranscriptBuilder(source, nativeId);
  const normalizer = new NativeTranscriptNormalizer(source, nativeId);
  await visitJsonl(path, (record) => builder.consume(normalizer.push(record)), () => {
    builder.countRecord();
    builder.countUnknown();
  });
  const artifact = await artifactFor(path, source, source === "codex" ? "codex-jsonl" : "claude-jsonl", parsedMetadata);
  return { sourcePath: path, bundle: builder.finish(artifact) };
}

export function parseClaudeTranscript(path: string): Promise<ParsedTranscript> {
  return parseNativeTranscript(path, "claude-code");
}

export function parseCodexTranscript(path: string): Promise<ParsedTranscript> {
  return parseNativeTranscript(path, "codex");
}
