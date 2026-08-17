const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV7(value: string): boolean {
  return UUID_V7_PATTERN.test(value);
}

export function assertUuidV7(value: string, label = "id"): void {
  if (!isUuidV7(value)) throw new TypeError(`${label} must be a canonical lowercase UUIDv7`);
}

export function uuidV7Timestamp(value: string): number {
  assertUuidV7(value);
  return Number.parseInt(value.slice(0, 8) + value.slice(9, 13), 16);
}

export function compareUuidV7(left: string, right: string): number {
  assertUuidV7(left, "left id");
  assertUuidV7(right, "right id");
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
