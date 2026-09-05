import { expect, it } from "vitest";
import { RequestScope } from "./request-scope";
it("rejects an old evidence page after a revision or authenticated API changes", async () => {
  const api = {}; const scope = new RequestScope(); const applied: string[] = [];
  scope.select([api, "memory", 0]); const old = scope.capture(); let resolve!: (page: string) => void;
  const stale = new Promise<string>((done) => { resolve = done; }).then((page) => { if (scope.current(old)) applied.push(page); });
  scope.select([api, "memory", 1]); const current = scope.capture(); applied.push("revision-1-initial");
  resolve("revision-0-more-evidence"); await stale; expect(applied).toEqual(["revision-1-initial"]); expect(scope.current(current)).toBe(true);
  scope.select([{}, "memory", 1]); expect(scope.current(current)).toBe(false);
});
