import { resolve } from "node:path";

import { FoldJournal } from "@_89/fold-storage";

import { PostgresFoldDatabase } from "./store.js";

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

async function main(): Promise<void> {
  const connectionString = process.env.FOLD_DATABASE_URL;
  if (connectionString === undefined || connectionString.trim().length === 0) {
    throw new TypeError("FOLD_DATABASE_URL is required");
  }
  const workspaceId = argument("--workspace");
  const journalPath = resolve(argument("--journal"));
  const journal = await new FoldJournal(journalPath).read();
  const database = new PostgresFoldDatabase({ connectionString });
  try {
    const imported = await database.importEntries(workspaceId, journal.entries);
    const stored = await database.readEntries(workspaceId);
    console.log(JSON.stringify({ workspaceId, journalPath, imported, stored: stored.length }));
  } finally {
    await database.close();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
