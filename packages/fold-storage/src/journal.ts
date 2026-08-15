import {
  fold,
  type FoldLogEntry,
} from "@_89/fold";

import {
  createCheckpoint,
  type CreateCheckpointOptions,
} from "./checkpoint.js";
import {
  appendJournalRecord,
  readJournal,
  rewriteJournalAtomically,
} from "./jsonl.js";
import {
  checkpointRecord,
  eventRecord,
  type FoldCheckpoint,
  type JournalRecord,
} from "./records.js";
import type {
  AppendOptions,
  ReadJournalOptions,
  ReadJournalResult,
  ReplayJournalOptions,
  ReplayJournalResult,
} from "./types.js";

export async function appendEntry(
  path: string,
  entry: FoldLogEntry,
  options: AppendOptions = {},
): Promise<void> {
  await appendJournalRecord(path, eventRecord(entry), options);
}

export async function replayJournal(
  path: string,
  options: ReplayJournalOptions,
): Promise<ReplayJournalResult> {
  const read = await readJournal(path, options);
  const state = fold(read.entries, {
    include: options.include,
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    ...(options.components === undefined ? {} : { components: options.components }),
  });
  return { ...read, state };
}

export class FoldJournal {
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.queue.then(operation, operation);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  append(entry: FoldLogEntry, options: AppendOptions = {}): Promise<void> {
    return this.enqueue(() => appendEntry(this.path, entry, options));
  }

  appendRecord(record: JournalRecord, options: AppendOptions = {}): Promise<void> {
    return this.enqueue(() => appendJournalRecord(this.path, record, options));
  }

  checkpoint(options: CreateCheckpointOptions, appendOptions: AppendOptions = {}): Promise<FoldCheckpoint> {
    return this.enqueue(async () => {
      const read = await readJournal(this.path, {
        missing: "empty",
        ...(options.componentSet === undefined || options.componentSet === "core-v0.7"
          ? {}
          : {
              checkpointComponents: {
                [options.componentSet]: options.components ?? {},
              },
            }),
      });
      const checkpoint = createCheckpoint(read.entries, options);
      await appendJournalRecord(this.path, checkpointRecord(checkpoint), appendOptions);
      return checkpoint;
    });
  }

  read(options: ReadJournalOptions = {}): Promise<ReadJournalResult> {
    return this.enqueue(() => readJournal(this.path, options));
  }

  replay(options: ReplayJournalOptions): Promise<ReplayJournalResult> {
    return this.enqueue(() => replayJournal(this.path, options));
  }

  rewrite(records: readonly JournalRecord[], options: AppendOptions = {}): Promise<void> {
    return this.enqueue(() => rewriteJournalAtomically(this.path, records, options));
  }
}
