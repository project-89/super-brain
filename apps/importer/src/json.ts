export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function isoTimestamp(value: unknown): string | undefined {
  const text = stringValue(value);
  if (text === undefined || !Number.isFinite(Date.parse(text))) return undefined;
  return new Date(Date.parse(text)).toISOString();
}
