# Project identity review

The Phase 1B inventory identifies evidence-backed **candidates for human review**.
It does not merge projects, choose canonical IDs, change access, rewrite source
hashes, or infer an owner. Same project names alone never create a candidate.

## Run the inventory

Build the importer, then use an authorized workspace credential in the environment:

```sh
pnpm --filter @_89/super-brain-importer build
node apps/importer/dist/main.js project-identities \
  --api-url http://127.0.0.1:3003 \
  --organization local --workspace local-history \
  --report .data/project-identities-review.json
```

`FOLD_API_TOKEN` is required; command-line tokens are rejected. `FOLD_API_URL`,
`FOLD_API_ORGANIZATION`, and `FOLD_API_WORKSPACE` can replace their options.
The organization defaults to `local`, consistent with other importer commands.
The report's parent directory must exist. The report is created exclusively with
mode `0600`; existing files and symlinks are never overwritten. Keep it private:
it contains project IDs, filesystem paths, normalized remotes, and source run and
segment references. It contains no transcript text, original remote credentials,
or bearer token. Normal CLI output contains scope and aggregate counts only.

## Interpretation

- The API's authorized project catalog and all cursor-paginated run metadata are
  read with GET requests only. This is not an atomic database snapshot; concurrent
  ingestion can change coverage. Unknown project references are counted, not
  assigned to another project. Fetch or pagination failure produces no report.
  More than 10,000 candidate pairs fails explicitly instead of truncating the
  inventory; use a narrower authorized workspace rather than accepting partial
  grouping. This bounds quadratic shared-path or shared-remote fanout.
- Each candidate is a pair marked `needs-review`, with same-remote or exact-path
  evidence. Pair ordering is lexical for stable display, not a canonical winner.
- Remotes remove user/password, query, and fragment. Hostnames are lowercased;
  path case and explicit ports are preserved. Only standard, no-explicit-port
  GitHub SSH/HTTPS owner/repository forms are equated (including `.git`). Other
  transports and hosts stay distinct; non-GitHub SCP paths are not equated to
  absolute SSH URL paths. Unsupported remotes are counted without
  reproducing their content. This comparison never changes importer identity hashes.
- Filesystem evidence comes from project roots, run working directories, and
  explicitly project-assigned segment working directories. Absolute paths are
  normalized lexically, without reading the filesystem, resolving symlinks, or
  folding case. Relative paths, child directories, and basename matches are not
  proof of a shared root. Segment repo labels are not repository identities.
- Shared paths can mean directory reuse, different machines using the same path,
  nested work, or an actual alias. Distinct normalized remotes at a shared path
  flag every affected pair, including a no-remote project bridging two remotes.
  This is a conflict to inspect, not a reason to pick one remote silently.
- Even matching remotes may represent intentionally separate historical projects
  or a repository moved/recreated over time. No transitive cluster is accepted as
  a verified identity. Review provenance before proposing reconciliation.

## Reviewed identities in the UI

The **Identities** page is separate from the read-only inventory CLI. Its views
are **People & sources**, **Attributions**, **Project aliases**, and **Change history**.
Lists and selectors use cursor pages. Changes to identity revision or workspace
scope during pagination invalidate the list instead of pairing old fields with a
new revision. People and source identity labels appear separately from stable IDs.

- People are distinct from accounts, agents, and machines. Account records require
  provider and external ID; person records cannot carry those account fields.
  Entity kinds cannot be changed. Duplicate active provider/external-ID identities
  are rejected. Names alone never establish identity.
- An attribution explicitly links one non-person identity to a person. It is an
  administrator's reviewed claim, not authentication, ownership, or proof that the
  person performed every action. Reassignments and revocations retain history.
  Active attributions must be revoked before an identity can be deactivated.
- Project aliases require **Preview affected records**, followed by **Apply reviewed
  change**. Preview shows names, full IDs, workspace visibility, conflicts, and
  requester-visible run/memory/proposal counts. Returning to edit invalidates the
  preview. Any changed reviewed input or stale identity revision requires review
  again. Counts are a visible evidence snapshot, not an atomic guarantee about
  unrelated concurrent ingestion or a count of other people's private records.
- Both project endpoints must have whole-workspace-visible project metadata.
  A project visible only in a restricted space or to its creator cannot be
  published as a workspace alias. Attached evidence IDs must likewise refer to
  canonical, whole-workspace-visible events.
- The source project IDs, hashes, and memory provenance are not rewritten. Alias
  chains expand relevant project-filtered recall and run lists within existing
  authorization. Revocation splits that resolution chain; it does not delete the
  source data, erase the prior decision, or move data between tenants.

Only authenticated human workspace owners/admins with the required capability can
mutate identities. Platform-wide data access remains read-only. The page displays
write controls from the server's `canManage` result; the API independently enforces
the permission on every write. No live reconciliation or person attribution is
automatically applied from the inventory.

## API and agent context

Workspace-scoped routes under `/v1/organizations/:organization/workspaces/:workspace`
include `GET identities/entities|attributions|aliases|history|projects`, each with
`limit` and `pageCursor`. `GET identities` returns revision, scope, permissions, and
counts rather than downloading every list. Entity/attribution POSTs require an
expected revision, reason, and evidence IDs. Alias POSTs additionally require the
token from `POST identities/alias-preview`. Identity changes are append-only
`identity.revised` events; generic event ingress cannot forge them.

MCP `super_brain_projects` discovers authorized project names and original/canonical
IDs in bounded cursor pages. Search and cited context require nonempty explicit
project IDs or configured `SUPER_BRAIN_PROJECT_IDS`; selected IDs are checked
against current authorized project metadata before each call. An explicit
`broaderDiscovery: true` permits authorized cross-project discovery, never broader
permissions. See [MCP configuration](../apps/mcp-server/README.md).

These mechanisms do not yet inventory ambiguous human ownership across existing
capture, automatically bind task/person identities, or produce person/day reports.
Those depend on reviewed attribution coverage and the later episode/state phases.

## Verification status

September 15 local verification includes full workspace build/typecheck/tests,
restricted-role PostgreSQL integration, 36 Brain tests, 16 MCP tests, and independent
identity review. Read-only desktop/mobile UI checks covered new-person draft
review, all identity views, 133 paginated project choices, and an alias impact
preview. All drafts were canceled; no live identity/attribution/alias was created.
The API, capture, and memory-worker services were restarted with the latest
builds. Capture is delivering again after the deep-tree fix, but its backlog and
four unavailable transcript sources remain open; see the timestamped
[rollout evidence](LEARNING_AND_AWARENESS_PLAN.md#september-15-verification-and-rollout-boundary).
Historical worker queueing remains an explicit, unapplied migration. Operational
drain progress is separate from identity feature verification or proof that the
larger learning product is complete.
