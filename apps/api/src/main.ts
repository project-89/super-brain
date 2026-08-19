import { join } from "node:path";

import { StaticIdentityDirectory } from "./auth.js";
import { JournalSdkRegistry } from "./registry.js";
import { createApiServer } from "./server.js";

function portFromEnvironment(value: string | undefined): number {
  const port = value === undefined ? 3000 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError("FOLD_API_PORT must be an integer within [1, 65535]");
  }
  return port;
}

async function main(): Promise<void> {
  const credentials = process.env.FOLD_API_CREDENTIALS_JSON;
  if (credentials === undefined || credentials.trim().length === 0) {
    throw new TypeError("FOLD_API_CREDENTIALS_JSON is required");
  }
  const directory = StaticIdentityDirectory.fromJson(credentials);
  const dataDirectory = process.env.FOLD_DATA_DIR ?? join(process.cwd(), ".data", "fold");
  const registry = new JournalSdkRegistry(dataDirectory);
  const host = process.env.FOLD_API_HOST ?? "127.0.0.1";
  const port = portFromEnvironment(process.env.FOLD_API_PORT);
  const server = createApiServer({
    authenticator: directory,
    memberships: directory,
    sdks: registry,
    reportError: (error) => console.error(error),
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(`Fold API listening at http://${host}:${port}`);

  const close = () => {
    server.close((error) => {
      if (error !== undefined) {
        console.error(error);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
