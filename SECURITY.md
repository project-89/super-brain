# Security Policy

## Supported Versions

Super Brain has not reached a stable release. Security fixes are applied to the
current `main` branch only.

## Reporting A Vulnerability

Do not open a public issue for a suspected vulnerability, leaked credential, or
exposed transcript. Use GitHub's private vulnerability reporting for
`project-89/super-brain` and include:

- the affected commit and component;
- reproduction steps with secrets and private data removed;
- the expected and observed authorization boundary;
- any evidence that organization, workspace, transcript, reasoning, or vault
  data was exposed.

Revoke any credential that may have been disclosed before submitting the
report. Do not upload live transcript artifacts, vault keys, database dumps, or
customer records as evidence.

## Data Sensitivity

Captured prompts, responses, tool activity, exposed reasoning, repository
metadata, and derived memories can contain confidential data. Production
operators must enable tenant RLS, encrypt backups and vaults, use one scoped
credential per sensor, and follow the deployment gate in
[`docs/MULTI_TENANCY.md`](docs/MULTI_TENANCY.md).
