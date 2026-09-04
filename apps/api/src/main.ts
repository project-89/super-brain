import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { PostgresTenantAdministration, PostgresVectorMemoryRanker } from "@_89/fold-postgres";

import { PostgresMembershipResolver, StaticIdentityDirectory } from "./auth.js";
import { JournalSdkRegistry, PostgresSdkRegistry } from "./registry.js";
import { FixedWindowRateLimiter } from "./rate-limit.js";
import { LocalLexicalMemoryRanker } from "./recall.js";
import { LocalEvidenceReasoner } from "./reasoning.js";
import { createApiServer } from "./server.js";
import { HttpMemoryEmbeddingProvider } from "./embeddings.js";
import { installApiLaunchAgent } from "./install.js";

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

function booleanFromEnvironment(name: string, value: string | undefined): boolean {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new TypeError(`${name} must be true or false`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  const command = args[0] ?? "serve";
  if (command === "install-service") {
    process.stdout.write(`${await installApiLaunchAgent(fileURLToPath(import.meta.url))}\n`);
    return;
  }
  if (command !== "serve") throw new TypeError("supported commands: serve, install-service");
  const credentials = process.env.FOLD_API_CREDENTIALS_JSON;
  if (credentials === undefined || credentials.trim().length === 0) {
    throw new TypeError("FOLD_API_CREDENTIALS_JSON is required");
  }
  const directory = StaticIdentityDirectory.fromJson(credentials);
  const dataDirectory = process.env.FOLD_DATA_DIR ?? join(process.cwd(), ".data", "fold");
  const databaseUrl = process.env.FOLD_DATABASE_URL;
  const requireRlsEnforcement = booleanFromEnvironment(
    "FOLD_REQUIRE_TENANT_RLS",
    process.env.FOLD_REQUIRE_TENANT_RLS,
  );
  const registry = databaseUrl === undefined || databaseUrl.trim().length === 0
    ? new JournalSdkRegistry(dataDirectory)
    : new PostgresSdkRegistry({ connectionString: databaseUrl, requireRlsEnforcement });
  const tenantAdministration = databaseUrl === undefined || databaseUrl.trim().length === 0
    ? undefined
    : new PostgresTenantAdministration({ connectionString: databaseUrl, requireRlsEnforcement });
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
      requireRlsEnforcement,
    });
  }
  const host = process.env.FOLD_API_HOST ?? "127.0.0.1";
  const port = portFromEnvironment(process.env.FOLD_API_PORT);
  const rateLimit = nonNegativeIntegerFromEnvironment(
    "FOLD_API_RATE_LIMIT_PER_MINUTE",
    process.env.FOLD_API_RATE_LIMIT_PER_MINUTE,
    300,
  );
  const fleetOrphanAfterMs = nonNegativeIntegerFromEnvironment(
    "FOLD_FLEET_ORPHAN_AFTER_MS",
    process.env.FOLD_FLEET_ORPHAN_AFTER_MS,
    24 * 60 * 60_000,
  );
  if (fleetOrphanAfterMs === 0) throw new TypeError("FOLD_FLEET_ORPHAN_AFTER_MS must be greater than zero");
  const corsOrigins = corsOriginsFromEnvironment(process.env.FOLD_API_CORS_ORIGINS);
  let server: ReturnType<typeof createApiServer>;
  try {
    await registry.open();
    if (tenantAdministration !== undefined) {
      await tenantAdministration.replaceStaticMemberships(directory.configuredMemberships());
    }
    server = createApiServer({
      authenticator: directory,
      memberships: tenantAdministration === undefined
        ? directory
        : new PostgresMembershipResolver(tenantAdministration),
      sdks: registry,
      memoryRanker: vectorRanker ?? new LocalLexicalMemoryRanker(),
      reasoner: new LocalEvidenceReasoner(),
      ...(tenantAdministration === undefined ? {} : { tenantAdministration }),
      ...(rateLimit === 0 ? {} : { rateLimiter: new FixedWindowRateLimiter(rateLimit) }),
      ...(corsOrigins === undefined ? {} : { corsOrigins }),
      fleetOrphanAfterMs,
      reportError: (error) => console.error(error),
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });
  } catch (error) {
    await Promise.all([registry.close(), vectorRanker?.close(), tenantAdministration?.close()]);
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
      void Promise.all([registry.close(), vectorRanker?.close(), tenantAdministration?.close()]).then(() => {
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
