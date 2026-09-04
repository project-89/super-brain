import { describe, expect, it } from "vitest";

import { RecordAnonymizer } from "../src/index.js";

const key = new Uint8Array(Array.from({ length: 32 }, (_, index) => index + 1));

describe("record anonymization", () => {
  it("creates stable aliases while retaining useful tool and content structure", () => {
    const anonymizer = new RecordAnonymizer("pseudonymous", key);
    const first = anonymizer.value({
      session_id: "session-private",
      cwd: "/Users/alice/work/project-a",
      branch: "alice/private-ticket",
      prompt: "Ask alice@example.com to run pnpm test",
      tool_name: "exec_command",
    }) as Record<string, string>;
    const second = anonymizer.value({ session_id: "session-private" }) as Record<string, string>;

    expect(first.session_id).toBe(second.session_id);
    expect(first.session_id).not.toContain("private");
    expect(first.cwd).toMatch(/^\/Users\/user-[a-f0-9]{24}\/path-segment-/);
    expect(first.cwd).not.toMatch(/alice|project-a/);
    expect(first.branch).not.toContain("alice");
    expect(first.prompt).toContain("run pnpm test");
    expect(first.prompt).not.toContain("alice@example.com");
    expect(first.tool_name).toBe("exec_command");
  });

  it("makes strict paths and network locations opaque", () => {
    const anonymizer = new RecordAnonymizer("strict", key);
    const value = anonymizer.value({
      file_path: "/Users/alice/work/private/customer.ts",
      target_file: "src/private-customer.ts",
      output: "See https://internal.example.test/customer at 10.1.2.3",
    }) as Record<string, string>;
    expect(value.file_path).toMatch(/^\/private\/path-[a-f0-9]{24}\.ts$/);
    expect(value.target_file).toMatch(/^\/private\/path-[a-f0-9]{24}\.ts$/);
    expect(value.output).not.toMatch(/internal\.example|10\.1\.2\.3|alice/);
  });

  it("does not alter opaque provider ciphertext", () => {
    const anonymizer = new RecordAnonymizer("strict", key);
    expect(anonymizer.value({ encrypted_content: "https://cipher.example/10.1.2.3" }))
      .toEqual({ encrypted_content: "https://cipher.example/10.1.2.3" });
  });
});
