import { join } from "node:path";

import { PostgresVectorMemoryRanker } from "@_89/fold-postgres";

import { StaticIdentityDirectory } from "./auth.js";
import { JournalSdkRegistry, PostgresSdkRegistry } from "./registry.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { LocalLexicalMemoryRanker } from "./recall.js";
import { LocalEvidenceReasoner } from "./reasoning.js";
import { createApiServer } from "./server.js";
import { HttpMemoryEmbeddingProvider } from "./embeddings.js";

function portFromEnvironment(value: string | undefined): number {
  const port = value === undefined ? 3000 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("FOLD_API_PORT must be an integer within [1, 65535]");
  }
  return port;
}

function nonNegativeIntegerFromEnvironment(
  name: string,
  value: string | undefined,
  fallback: number,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function corsOriginsFromEnvironment(value: string | undefined): readonly string[] | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const origins = value.split(",").map((origin) => origin.trim());
  if (origins.some((origin) => origin.length === 0)) {
    throw new TypeError("FOLD_API_CORS_ORIGINS must be a comma-separated list of origins");
  }
  return origins;
}

async function main(): Promise<void> {
  const credentials = process.env.FOLD_API_CREDENTIALS_JSON;
  if (credentials === undefined || credentials.trim().length === 0) {
    throw new TypeError("FOLD_API_CREDENTIALS_JSON is required");
  }
  const directory = StaticIdentityDirectory.fromJson(credentials);
  const dataDirectory = process.env.FOLD_DATA_DIR ?? join(process.cwd(), ".data", "fold");
  const databaseUrl = process.env.FOLD_DATABASE_URL;
  const registry = databaseUrl === undefined || databaseUrl.trim().length === 0
    ? new JournalSdkRegistry(dataDirectory)
    : new PostgresSdkRegistry({ connectionString: databaseUrl });
  const embeddingUrl = process.env.FOLD_EMBEDDING_URL;
  let vectorRanker: PostgresVectorMemoryRanker | undefined;
  if (embeddingUrl !== undefined) {
    if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
      throw new TypeError("FOLD_EMBEDDING_URL requires FOLD_DATABASE_URL");
    }
    const model = process.env.FOLD_EMBEDDING_MODEL;
    const dimensions = Number(process.env.FOLD_EMBEDDING_DIMENSIONS);
    if (model === undefined) throw new TypeError("FOLD_EMBEDDING_MODEL is required when embeddings are enabled");
    vectorRanker = new PostgresVectorMemoryRanker({
      connectionString: databaseUrl,
      provider: new HttpMemoryEmbeddingProvider({
        url: embeddingUrl,
        model,
        dimensions,
        ...(process.env.FOLD_EMBEDDING_TOKEN === undefined ? {} : { token: process.env.FOLD_EMBEDDING_TOKEN }),
      }),
    });
  }
  const host = process.env.FOLD_API_HOST ?? "127.0.0.1";
  const port = portFromEnvironment(process.env.FOLD_API_PORT);
  const rateLimit = nonNegativeIntegerFromEnvironment(
    "FOLD_API_RATE_LIMIT_PER_MINUTE",
    process.env.FOLD_API_RATE_LIMIT_PER_MINUTE,
    300,
  );
  const corsOrigins = corsOriginsFromEnvironment(process.env.FOLD_API_CORS_ORIGINS);
  await registry.open();
  let server: ReturnType<typeof createApiServer>;
  try {
    server = createApiServer({
      authenticator: directory,
      memberships: directory,
      sdks: registry,
      memoryRanker: vectorRanker ?? new LocalLexicalMemoryRanker(),
      reasoner: new LocalEvidenceReasoner(),
      ...(rateLimit === 0 ? {} : { rateLimiter: new FixedWindowRateLimiter(rateLimit) }),
      ...(corsOrigins === undefined ? {} : { corsOrigins }),
      reportError: (error) => console.error(error),
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    await Promise.all([registry.close(), vectorRanker?.close()]);
    throw error;
  }
  console.log(`Fold API listening at http://${host}:${port}`);

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    const forceClose = setTimeout(() => server.closeAllConnections(), 10_000);
    forceClose.unref();
    server.close((error) => {
      clearTimeout(forceClose);
      void Promise.all([registry.close(), vectorRanker?.close()]).then(() => {
        if (error !== undefined) {
          console.error(error);
          process.exitCode = 1;
        }
      }).catch((closeError: unknown) => {
        console.error(closeError);
        process.exitCode = 1;
      });
    });
    server.closeIdleConnections();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
