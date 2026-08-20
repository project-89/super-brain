import { describe, expect, it } from "vitest";

import { nextEventStamp, uuidV7 } from "./ids";

describe("browser identifiers", () => {
  it("creates RFC 9562 UUIDv7 values with the supplied timestamp", () => {
    const timestamp = 1_725_000_000_123;
    const id = uuidV7(timestamp);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id.replaceAll("-", "").slice(0, 12)).toBe(timestamp.toString(16).padStart(12, "0"));
  });

  it("emits lexicographically increasing event IDs at one timestamp", () => {
    const first = nextEventStamp(1_725_000_000_123);
    const second = nextEventStamp(1_725_000_000_123);
    expect(second.t).toBe(first.t);
    expect(second.id > first.id).toBe(true);
    expect(first.worldDate).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("rejects timestamps outside UUIDv7's 48-bit range", () => {
    expect(() => uuidV7(-1)).toThrow(/48-bit/);
    expect(() => uuidV7(0x1000000000000)).toThrow(/48-bit/);
  });
});
