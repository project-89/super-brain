# Disposable PostgreSQL integration checks

The two-process API suite runs actual built API/SDK code in separate Node
processes against PostgreSQL 17 with pgvector. It requires a role with
`NOSUPERUSER NOBYPASSRLS` and `row_security=on`; using an administrative role is
an error. All records are synthetic. Each test invocation uses its own randomly
named schema and removes only that schema after stopping its children.

Build the API and its workspace dependencies, then use the Docker runner:

```sh
pnpm --filter '@_89/super-brain-api...' build
bash scripts/disposable-postgres.sh
```

The runner creates a new container, binds a random port on `127.0.0.1`, enables
pgvector, provisions the restricted test role, and supplies only its new
connection through `FOLD_TEST_DATABASE_URL`. It clears `FOLD_DATABASE_URL` for
the child command and never reuses a live database. Its EXIT/INT/TERM trap
removes exactly the container ID returned by this invocation, including when
the requested test command fails. No shared named volume is mounted.

To run additional targeted PostgreSQL tests in the same disposable instance:

```sh
bash scripts/disposable-postgres.sh -- pnpm --filter @_89/fold-postgres test
```

CI may instead provision a disposable PostgreSQL service and pass the explicit
restricted connection in `FOLD_TEST_DATABASE_URL`, then run:

```sh
pnpm --filter @_89/super-brain-api test test/postgres-concurrency.test.ts
```

The suite covers concurrent initialization of a fresh schema, competing and
identical candidate acceptance, exact retry of a committed decision from
another process, changed-request rejection, unique memory identity, cache refresh after separate writers, late
event delivery after a persisted consumer cursor and API restart, safe legacy
cursor replay, canonical event-time ordering, and space/workspace revocation
observed through another process's membership update. Membership changes go
through the real PostgreSQL administration and resolver. No production
identity provider, external account, or production token is involved.

The existing `postgres-isolation` CI job runs both the PostgreSQL package tests
and this two-process suite with the restricted role on Node.js 24.

The `test/fixtures/postgres-api-process.mjs` fixture only imports built packages.
Rebuild affected packages after changes before rerunning the suite. Its child
environment deliberately excludes inherited application credentials and
configuration; control messages use a parent-owned IPC pipe, not HTTP routes.

An absent `FOLD_TEST_DATABASE_URL` skips this integration suite. A skipped test
is not evidence that PostgreSQL behavior passed. These checks establish tested
local behavior, not an operated hosted deployment or provider revocation drill.
