import type { JsonValue, PersonalMemory } from "./types";

export function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

export function formatRelative(timestamp: number, now = Date.now()): string {
  const difference = timestamp - now;
  const absolute = Math.abs(difference);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60_000) return formatter.format(Math.round(difference / 1_000), "second");
  if (absolute < 3_600_000) return formatter.format(Math.round(difference / 60_000), "minute");
  if (absolute < 86_400_000) return formatter.format(Math.round(difference / 3_600_000), "hour");
  return formatter.format(Math.round(difference / 86_400_000), "day");
}

export function memoryContent(memory: PersonalMemory): string {
  if (typeof memory.content === "string") return memory.content;
  if (memory.content === null) return "";
  return JSON.stringify(memory.content, null, 2);
}

export function compactJson(value: JsonValue | undefined): string {
  if (value === undefined) return "-";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
