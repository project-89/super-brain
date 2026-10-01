# Architectural review — feature boundaries

Baseline: `/Users/jakobgrant/Workspaces/super-brain`, branch `main`, commit `eda5604e6e1d06465dac5e1b914c531c96b15031`, reviewed September 4, 2026 (America/Vancouver). Working tree was clean at the start. This is an assessment, not an implementation change.

The source review uses three approved boundaries. They follow the product's two intended outputs—useful shared intelligence and credible evaluation data—and the platform that must support both.

| Feature | Entry points | Core ownership | Purpose |
| --- | --- | --- | --- |
| Evidence acquisition and evaluation | `apps/capture-daemon/src/main.ts:83`, `apps/capture-daemon/src/server.ts:119`, `apps/importer/src/main.ts:1` | Capture daemon, importer, activity, transcripts, fleet, trajectories, trace and evaluation packs | Preserve observed work, source identity, private evidence, outcomes and comparable trajectories. |
| Memory, learning and consumption | `apps/memory-worker/src/main.ts:1`, `apps/mcp-server/src/main.ts:1`, `apps/brain/src/main.tsx:1` | Memory worker, epistemic and drives packs, API recall/reasoning, MCP and operator UI | Turn authorized evidence into reviewed knowledge, useful context, feedback and steering. |
| Canonical platform and hosted operation | `apps/api/src/main.ts:90`, `apps/api/src/server.ts:1298`, `packages/fold-sdk/src/client.ts:258`, `packages/fold-postgres/src/store.ts:99` | Fold kernel, journal/PostgreSQL storage, SDK, auth/tenancy, HTTP/SSE client, operations | Maintain deterministic truth, access boundaries, durable consumption and deployable services. |

`fold-narrative` is a specialized fixture-backed domain pack, outside the first coding-agent release's critical path. Similarities among legitimate domain projections or between a private vault and the canonical journal are not by themselves duplication defects.

Source basis: `README.md:1–141`, `docs/ARCHITECTURE.md:1–110`, `Fold_Platform_Super_Brain_Unified_Reference_v8.md:1–44`, plus the entry points above. Detailed flows and findings follow in `01-flowcharts/`.
