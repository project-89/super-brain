import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { FoldLogEntry } from "@_89/fold";
import { FoldSdk, type FoldSdkStore } from "@_89/fold-sdk";
import {
  FoldJournal,
  type ReadJournalOptions,
} from "@_89/fold-storage";

import type { FoldSdkRegistry } from "./types.js";

class DurableJournalStore implements FoldSdkStore {
  constructor(private readonly journal: FoldJournal) {}

  read(options: ReadJournalOptions = {}) {
    return this.journal.read(options);
  }

  append(entry: FoldLogEntry): Promise<void> {
    return this.journal.append(entry, { sync: true });
  }
}

export function workspaceJournalFilename(workspaceId: string): string {
  if (workspaceId.trim().length === 0) throw new TypeError("workspaceId must not be empty");
  return `${createHash("sha256").update(workspaceId).digest("hex")}.jsonl`;
}

export class JournalSdkRegistry implements FoldSdkRegistry {
  private readonly ready: Promise<void>;
  private readonly sdks = new Map<string, FoldSdk>();

  constructor(readonly dataDirectory: string) {
    if (dataDirectory.trim().length === 0) throw new TypeError("dataDirectory must not be empty");
    this.ready = mkdir(dataDirectory, { recursive: true }).then(() => undefined);
  }

  async sdkFor(workspaceId: string): Promise<FoldSdk> {
    await this.ready;
    let sdk = this.sdks.get(workspaceId);
    if (sdk === undefined) {
      const path = join(this.dataDirectory, workspaceJournalFilename(workspaceId));
      sdk = new FoldSdk(new DurableJournalStore(new FoldJournal(path)));
      this.sdks.set(workspaceId, sdk);
    }
    return sdk;
  }
}
