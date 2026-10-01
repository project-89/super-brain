import { constants } from "node:fs";
import { open } from "node:fs/promises";

const FILE_SECRETS = ["FOLD_DATABASE_URL", "FOLD_API_CREDENTIALS_JSON", "FOLD_CLERK_BINDINGS_JSON",
  "CLERK_SECRET_KEY", "CLERK_MACHINE_SECRET_KEY", "CLERK_WEBHOOK_SIGNING_SECRET",
  "FOLD_EMBEDDING_TOKEN", "FOLD_REASONING_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

/** Docker/systemd secret files are read once, bounded and without following a
 * leaf symlink. Error messages identify the setting, never its bytes or path. */
export async function loadEnvironmentSecretFiles(environment: NodeJS.ProcessEnv): Promise<void> {
  for (const name of FILE_SECRETS) {
    const path = environment[`${name}_FILE`];
    if (path === undefined) continue;
    if (environment[name] !== undefined) throw new TypeError(`${name} and ${name}_FILE are mutually exclusive`);
    try {
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.size < 1 || before.size > 1_048_576) throw new Error("Invalid secret file");
        const bytes = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const result = await handle.read(bytes, length, bytes.length - length, length);
          if (result.bytesRead === 0) break;
          length += result.bytesRead;
        }
        const after = await handle.stat();
        if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Secret changed during read");
        const value = bytes.subarray(0, length).toString("utf8").trim();
        if (value.length === 0 || value.includes("\0")) throw new Error("Invalid secret content");
        environment[name] = value;
      } finally { await handle.close(); }
    } catch { throw new TypeError(`${name}_FILE must identify a stable, bounded regular secret file`); }
  }
}

export function postgresStartupPolicy(command: "serve" | "migrate" | "bootstrap", environment: NodeJS.ProcessEnv): {
  readonly schemaMode: "migrate" | "verify"; readonly seedMemberships: boolean;
} {
  const mode = command === "serve" ? (environment.FOLD_POSTGRES_SCHEMA_MODE ?? "migrate") : "migrate";
  if (mode !== "migrate" && mode !== "verify") throw new TypeError("FOLD_POSTGRES_SCHEMA_MODE must be migrate or verify");
  const seed = environment.FOLD_API_SEED_MEMBERSHIPS;
  if (seed !== undefined && seed !== "true" && seed !== "false") throw new TypeError("FOLD_API_SEED_MEMBERSHIPS must be true or false");
  if (mode === "verify" && seed === "true") throw new TypeError("Runtime verification cannot reseed memberships; run the explicit bootstrap command");
  return { schemaMode: mode, seedMemberships: command === "bootstrap" || (command === "serve" && mode === "migrate" && seed !== "false") };
}
