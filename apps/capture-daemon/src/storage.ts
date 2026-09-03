import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { chmod, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";

import { redactJsonValue } from "@_89/super-brain-importer";

import type { CaptureState, HookSource, SpoolJob, VaultArtifact } from "./types.js";

const EMPTY_STATE: CaptureState = {
  version: 1,
  lastEventTime: -1,
  seenArtifacts: [],
  sessions: {},
};

async function secureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function atomicPrivateJson(path: string, value: unknown): Promise<void> {
  await secureDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await file.sync();
    await file.close();
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeSource(source: HookSource): string {
  return source.replace(/[^a-z0-9-]/g, "-");
}

export class StateStore {
  private readonly path: string;

  constructor(stateRoot: string) {
    this.path = join(stateRoot, "state.json");
  }

  async load(): Promise<CaptureState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as CaptureState;
      if (parsed.version !== 1 || !Array.isArray(parsed.seenArtifacts) || typeof parsed.sessions !== "object") {
        throw new Error("capture state has an unsupported shape");
      }
      return {
        ...parsed,
        sessions: Object.fromEntries(
          Object.entries(parsed.sessions).map(([id, session]) => [id, { ...session, active: false }]),
        ),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return EMPTY_STATE;
      throw error;
    }
  }

  save(state: CaptureState): Promise<void> {
    return atomicPrivateJson(this.path, state);
  }
}

export class HookVault {
  constructor(private readonly root: string) {}

  async store(source: HookSource, payload: unknown, eventTime: number): Promise<VaultArtifact> {
    const redacted = redactJsonValue(payload).value;
    const canonical = JSON.stringify({ source, payload: redacted });
    const id = sha256(canonical);
    const directory = join(this.root, "hooks", safeSource(source), id.slice(0, 2));
    const path = join(directory, `${id}.json`);
    try {
      await stat(path);
      return { id, receivedAt: new Date(eventTime).toISOString(), eventTime, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const receivedAt = new Date(eventTime).toISOString();
    await atomicPrivateJson(path, { version: 1, id, source, receivedAt, eventTime, payload: redacted });
    return { id, receivedAt, eventTime, path };
  }
}

export class DurableSpool {
  private readonly pending: string;
  private readonly failed: string;

  constructor(stateRoot: string) {
    this.pending = join(stateRoot, "spool", "pending");
    this.failed = join(stateRoot, "spool", "failed");
  }

  async initialize(): Promise<void> {
    await secureDirectory(this.pending);
    await secureDirectory(this.failed);
  }

  async enqueue(job: SpoolJob): Promise<void> {
    await this.initialize();
    const filename = `${job.id.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
    const path = join(this.pending, filename);
    try {
      await stat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicPrivateJson(path, job);
    }
  }

  async list(): Promise<readonly { readonly path: string; readonly job: SpoolJob }[]> {
    await this.initialize();
    const files = (await readdir(this.pending)).filter((name) => name.endsWith(".json")).sort();
    const jobs = await Promise.all(files.map(async (name) => {
      const path = join(this.pending, name);
      return { path, job: JSON.parse(await readFile(path, "utf8")) as SpoolJob };
    }));
    return jobs;
  }

  complete(path: string): Promise<void> {
    return unlink(path);
  }

  async reject(path: string, reason: string): Promise<void> {
    const name = path.split("/").at(-1) ?? `${Date.now()}.json`;
    const target = join(this.failed, name);
    await rename(path, target);
    await atomicPrivateJson(`${target}.error.json`, { failedAt: new Date().toISOString(), reason });
  }
}
