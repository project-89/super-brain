// Synthetic integration fixture: a real API, SDK, and PostgreSQL registry in a
// separate Node process. Its only control channel is the parent-owned IPC pipe.
import {
  createApiServer,
  PostgresMembershipResolver,
  PostgresSdkRegistry,
  StaticIdentityDirectory,
} from "../../dist/index.js";
import { PostgresTenantAdministration } from "../../../../packages/fold-postgres/dist/index.js";

const connectionString = process.env.FOLD_TEST_DATABASE_URL;
const schema = process.env.FOLD_TEST_SCHEMA;
if (!connectionString || !schema?.match(/^fold_api_process_[a-f0-9]+$/)) {
  throw new Error("An explicit test database and generated test schema are required");
}
const organizationId = "integration-org";
const workspaceId = "integration-workspace";
const identities = new StaticIdentityDirectory({
  "integration-owner-token": {
    principalId: "integration-owner",
    organizations: { [organizationId]: { role: "owner", workspaces: { [workspaceId]: { role: "owner", spaces: { "space-a": "admin" } } } } },
  },
  "integration-reader-token": {
    principalId: "integration-reader",
    organizations: { [organizationId]: { role: "member", workspaces: { [workspaceId]: { role: "member", spaces: { "space-a": "reader" } } } } },
  },
});
const administration = new PostgresTenantAdministration({ connectionString, schema, requireRlsEnforcement: true });
const registry = new PostgresSdkRegistry({ connectionString, schema, requireRlsEnforcement: true });
const owner = {
  organizationId, workspaceId, principalId: "integration-owner",
  organizationRole: "owner", workspaceRole: "owner", spaceRoles: { "space-a": "admin" },
};
const reader = {
  organizationId, workspaceId, principalId: "integration-reader",
  organizationRole: "member", workspaceRole: "member", spaceRoles: { "space-a": "reader" },
};
if (process.env.FOLD_TEST_SEED === "true") {
  await administration.replaceStaticMemberships([owner, reader]);
}
await registry.open();
const server = createApiServer({
  authenticator: identities,
  memberships: new PostgresMembershipResolver(administration),
  sdks: registry,
  eventStreamPollMs: 20,
  reportError: (error) => process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`),
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
process.send?.({ kind: "ready", baseUrl: `http://127.0.0.1:${server.address().port}`, pid: process.pid });

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await Promise.all([registry.close(), administration.close()]);
  process.exit(0);
}
process.on("message", async (message) => {
  try {
    if (message.kind === "close") return await close();
    if (message.kind === "membership") {
      const records = message.state === "revoked"
        ? [owner]
        : [owner, message.state === "without-space" ? { ...reader, spaceRoles: {} } : reader];
      await administration.replaceStaticMemberships(records);
      process.send?.({ kind: "ack", id: message.id });
    }
  } catch (error) {
    process.send?.({ kind: "error", id: message.id, message: error instanceof Error ? error.message : String(error) });
  }
});
process.once("disconnect", () => void close());
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
