# Contributing

## Development

Use Node.js 24 and the repository-pinned pnpm version:

```sh
corepack enable
corepack prepare pnpm@10.8.1 --activate
pnpm install --frozen-lockfile
pnpm verify
```

Keep changes scoped to an existing package boundary. New event formats require
schema, replay, authorization, and malformed-input tests. Changes to tenant
storage must preserve organization and workspace keys through caches, cursors,
workers, vectors, and artifacts.

Do not commit credentials, local `.data` content, transcripts, vault material,
or database exports. Tests must use synthetic records.

## Pull Requests

Describe the behavior changed, the commands used to verify it, migration or
compatibility impact, and any operational prerequisite that cannot be tested in
the repository. CI must pass before merge.

## Licensing

The repository is currently `UNLICENSED`. A public checkout does not grant
permission to redistribute or reuse its source. Do not contribute code copied
from another project unless its provenance and compatible license are recorded
in [`docs/EVIDENCE_MANIFEST.md`](docs/EVIDENCE_MANIFEST.md).
