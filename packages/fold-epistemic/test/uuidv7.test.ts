import { describe, expect, it } from "vitest";

import { assertUuidV7, compareUuidV7, isUuidV7, uuidV7Timestamp } from "../src/index.js";
import { MEMORY_A, MEMORY_B } from "./helpers.js";

describe("UUIDv7 identity", () => {
  it("accepts canonical lowercase version-7 identifiers", () => {
    expect(isUuidV7(MEMORY_A)).toBe(true);
    expect(() => assertUuidV7(MEMORY_A)).not.toThrow();
  });

  it.each([
    "550e8400-e29b-41d4-a716-446655440000",
    "01890F47-7C00-7000-8000-000000000001",
    "01890f47-7c00-7000-7000-000000000001",
    "not-a-uuid",
  ])("rejects a noncanonical identifier: %s", (value) => {
    expect(isUuidV7(value)).toBe(false);
    expect(() => assertUuidV7(value)).toThrow(/canonical lowercase UUIDv7/);
  });

  it("extracts the embedded 48-bit timestamp", () => {
    expect(uuidV7Timestamp(MEMORY_A)).toBe(Number.parseInt("01890f477c00", 16));
  });

  it("orders identifiers by canonical UUID byte order", () => {
    expect(compareUuidV7(MEMORY_A, MEMORY_B)).toBe(-1);
    expect(compareUuidV7(MEMORY_B, MEMORY_A)).toBe(1);
    expect(compareUuidV7(MEMORY_A, MEMORY_A)).toBe(0);
  });
});
