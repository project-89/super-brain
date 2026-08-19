# Super Brain API

Authenticated HTTP delivery for scoped Fold events, projections, and personal
memory. The service uses `@_89/fold-sdk` exclusively for record and recall
behavior.

## Configuration

`FOLD_API_CREDENTIALS_JSON` is required. It maps bearer tokens to a principal,
an optional fixed Fold author, and explicit workspace memberships:

```json
{
  "replace-with-a-secret": {
    "principalId": "user-a",
    "author": { "kind": "human", "id": "user-a" },
    "workspaces": {
      "workspace-1": {
        "role": "owner",
        "spaces": { "space-a": "admin" }
      }
    }
  }
}
```

Tokens are retained only as SHA-256 lookup keys in process. Unknown fields,
roles, author shapes, empty credentials, and malformed JSON fail at startup.
Do not commit real credentials.

Optional environment:

- `FOLD_API_HOST`, default `127.0.0.1`;
- `FOLD_API_PORT`, default `3000`;
- `FOLD_DATA_DIR`, default `.data/fold` under the working directory.

Build and run with:

```bash
pnpm --filter @_89/super-brain-api build
FOLD_API_CREDENTIALS_JSON='{"local-secret":{"principalId":"local","workspaces":{"local":{"role":"owner"}}}}' \
  pnpm --filter @_89/super-brain-api start
```

## Routes

`GET /health` is public. All other routes require
`Authorization: Bearer <token>`.

| Method | Route | Behavior |
| --- | --- | --- |
| `GET`, `POST` | `/v1/workspaces/:workspace/events` | Access-filtered records or authenticated append |
| `GET` | `/v1/workspaces/:workspace/projection` | Access-filtered materialized Fold state |
| `GET`, `POST` | `/v1/workspaces/:workspace/memories` | Metadata recall or personal-memory creation |
| `POST` | `/v1/workspaces/:workspace/memories/recall` | Recall with optional semantic candidates |
| `GET`, `PATCH`, `DELETE` | `/v1/workspaces/:workspace/memories/:id` | Lookup, revision, or explicit forgetting |

Event reads accept `include=canon|canon+draft`, paired `cursorT` and
`cursorEventId`, and repeated `kind` filters. Memory reads accept
`scope=all|workspace|space`, `spaceId`, repeated `tag` and `source`, `from`,
`to`, and `limit`.

Event append authors must exactly match the author bound to the credential.
Memory authorship, creator scope, principal identity, and workspace are derived
by the server and cannot be supplied by the request. Space membership is
resolved on every request, so revocation applies immediately to raw records,
projection, and recall.

Each workspace uses an opaque SHA-256 journal filename and one serialized SDK
instance. Appends use complete-line JSONL with `sync: true`. This is an
in-process transaction boundary; deploying multiple service processes against
one data directory requires a store with cross-process locking or compare-and-
append semantics.

TLS termination, credential rotation, external identity providers, distributed
transactions, vector ranking, rate limits, and CORS policy remain deployment
concerns rather than implicit behavior in this local service.
