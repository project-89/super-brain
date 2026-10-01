import type { EpisodeCitation, EpisodePage, EpisodeSourceRecord } from "./episode-types";

export type SourceFocus = EpisodeCitation | string;
export function focusCitation(focus: SourceFocus | undefined): EpisodeCitation | undefined { return typeof focus === "string" ? { eventId: focus } : focus; }
export function evidenceObject(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
export function sourceRecords(event: unknown): Record<string, unknown>[] {
  const changes = evidenceObject(event)?.changes;
  return Array.isArray(changes) ? changes.flatMap(change => {
    const records = evidenceObject(evidenceObject(change)?.after)?.chunk;
    const items = evidenceObject(records)?.records;
    return Array.isArray(items) ? items.flatMap(item => { const record = evidenceObject(item); return record === undefined ? [] : [record]; }) : [];
  }) : [];
}
export function recordMatchesCitation(record: Record<string, unknown>, citation: EpisodeCitation | undefined): boolean {
  return citation !== undefined && (citation.recordOrdinal !== undefined || citation.line !== undefined)
    && (citation.recordOrdinal === undefined || record.ordinal === citation.recordOrdinal) && (citation.line === undefined || record.line === citation.line);
}

export function mergeEpisodePages<T>(previous: EpisodePage<T>, next: EpisodePage<T>, key: (item: T) => string): EpisodePage<T> {
  if (previous.coverage !== next.coverage || previous.revision !== next.revision) throw new Error("Episode evidence changed. Refresh before continuing.");
  return { ...next, items: [...new Map([...previous.items, ...next.items].map(item => [key(item), item])).values()] };
}
export function evidenceLabel(quality: EpisodeSourceRecord["quality"]) {
  return { "memory-derived": "Current memory account", "checkpoint": "Recorded checkpoint or check", "direct-transcript": "Retained transcript records", "metadata-only": "Metadata only; insufficient task content" }[quality];
}
export function decodeEpisodeEvidence(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeEpisodeEvidence);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (record.dataEncoding === "base64-json-utf8") {
    const data = record.data as { base64?: unknown } | undefined;
    if (typeof data?.base64 !== "string") throw new Error("Retained transcript encoding is invalid");
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(data.base64), character => character.charCodeAt(0)))) as unknown;
    const { dataEncoding: _encoding, ...rest } = record;
    return { ...rest, data: decodeEpisodeEvidence(parsed) };
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, decodeEpisodeEvidence(item)]));
}
