# Release Policy

Super Brain is pre-release software. Until an owner selects a project license,
the workspace packages remain private and `UNLICENSED`; no package may be
published to a public registry.

## Versioning

After the licensing gate is resolved, releases will use semantic versioning:

- patch: compatible fixes, tests, and operational hardening;
- minor: compatible APIs, event kinds, projections, and worker capabilities;
- major: incompatible schemas, authorization behavior, persistence formats, or
  removal of a supported interface.

Every release must be made from a reviewed commit on `main`, pass CI and secret
scanning, include migration and rollback notes, and identify the exact event
specification and package versions it supports. Published artifacts must be
reproducible from the tagged commit and must exclude `.data`, transcripts,
secrets, vaults, dumps, and local service configuration.

## Release Gate

Before the first public package release:

1. select and commit a license for every owned package;
2. verify dependency and borrowed-code licenses against the evidence manifest;
3. define supported Node.js, PostgreSQL, and event-schema versions;
4. complete a clean install, full verification, migration, backup, and restore
   drill from the release candidate;
5. sign and publish an annotated tag with a human-reviewed changelog.
