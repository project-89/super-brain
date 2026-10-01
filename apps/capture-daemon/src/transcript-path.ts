import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";

export function codexSessionIdFromPath(path: string): string | undefined {
  return new RegExp(`^rollout-.+-(${UUID})\\.jsonl$`, "i").exec(basename(path))?.[1];
}

async function hasSessionIdentity(path: string, sessionId: string): Promise<boolean> {
  const input = createReadStream(path, { encoding: "utf8", end: 256 * 1024 - 1 });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    // Codex's native identity is the first nonempty session_meta record, not its filename.
    for await (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as { type?: string; payload?: { id?: string } };
        return record.type === "session_meta" && record.payload?.id === sessionId;
      } catch { return false; }
    }
    return false;
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function locateTranscript(source: string, originalPath: string, nativeSessionId?: string): Promise<string> {
  try {
    await stat(originalPath);
    return originalPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || source !== "codex") throw error;
    const sessionId = nativeSessionId ?? codexSessionIdFromPath(originalPath);
    if (sessionId === undefined || !new RegExp(`^${UUID}$`, "i").test(sessionId)) throw error;
    // Only search the harness home containing the old path, never unrelated workspaces.
    let directory = dirname(resolve(originalPath));
    while (!["sessions", "archived_sessions"].includes(basename(directory))) {
      const parent = dirname(directory);
      if (parent === directory) throw error;
      directory = parent;
    }
    const home = dirname(directory);
    const pending = [join(home, "archived_sessions"), join(home, "sessions")].map(path => ({ path, depth: 0 }));
    let visited = 0;
    const matches: string[] = [];
    for (const entry of pending) {
      let entries;
      try { entries = await readdir(entry.path, { withFileTypes: true }); }
      catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw readError;
      }
      for (const candidate of entries) {
        if (++visited > 20_000) throw new Error("Codex transcript lookup exceeded its 20000-entry safety limit");
        const path = join(entry.path, candidate.name);
        if (candidate.isDirectory() && entry.depth < 4) pending.push({ path, depth: entry.depth + 1 });
        if (candidate.isFile() && codexSessionIdFromPath(path) === sessionId && await hasSessionIdentity(path, sessionId)) matches.push(path);
      }
    }
    if (matches.length > 1) throw new Error("multiple Codex transcripts match the native session identity; manual recovery required");
    if (matches.length === 1) return matches[0]!;
    throw error;
  }
}
