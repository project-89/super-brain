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

export function readableMemoryContent(content: JsonValue): string {
  if (typeof content === "string") return content;
  if (content === null) return "";
  if (typeof content !== "object") return String(content);
  if (Array.isArray(content)) return content.map((item) => typeof item === "string" ? item : JSON.stringify(item)).join("\n");
  const preferred = ["synthesis", "statement", "narrative", "subtitle", "summary", "detail"];
  const passages = preferred.flatMap((key) => typeof content[key] === "string" ? [content[key]] : []);
  const facts = Array.isArray(content.facts)
    ? content.facts.flatMap((fact) => typeof fact === "string" ? [`- ${fact}`] : [])
    : [];
  return [...new Set([...passages, ...facts])].join("\n\n") || JSON.stringify(content, null, 2);
}

export function memorySourceLabel(source: string): string {
  if (source === "claude-mem-observation") return "Imported Claude memory";
  if (source === "transcript-rule") return "Session learning";
  if (source === "continuous-cognition") return "Cross-project synthesis";
  if (source === "live-reasoning-checkpoint") return "Live reasoning checkpoint";
  return source.replaceAll("-", " ");
}

export function shortIdentifier(value: string, head = 8, tail = 6): string {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
}

export function eventKindLabel(kind: string): string {
  const labels: Readonly<Record<string, string>> = {
    "terminal.observation": "Agent activity",
    lifecycle: "Session presence",
    "memory.candidate-proposed": "Memory proposed",
    "memory.candidate-accepted": "Memory approved",
    "memory.candidate-rejected": "Memory rejected",
    "memory.recorded": "Memory stored",
    "memory.feedback-recorded": "Memory feedback",
    "transcript.project-recorded": "Project discovered",
    "transcript.artifact-imported": "Transcript retained",
    "transcript.run-imported": "Run archived",
    "transcript.chunk-imported": "Run evidence indexed",
    "trajectory.tree-recorded": "Decision path updated",
    "trajectory.recorded": "Run outcome recorded",
  };
  return labels[kind] ?? kind.replaceAll(/[.-]/g, " ");
}

export function eventCategory(kind: string): string {
  if (kind === "terminal.observation") return "Activity";
  if (kind === "lifecycle") return "Presence";
  if (kind.startsWith("transcript.")) return "History";
  if (kind.startsWith("memory.")) return "Knowledge";
  if (kind.startsWith("trajectory.")) return "Decisions";
  return "System";
}

export function compactJson(value: JsonValue | undefined): string {
  if (value === undefined) return "-";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
