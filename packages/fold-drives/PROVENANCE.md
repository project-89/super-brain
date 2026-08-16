# Provenance

`@_89/fold-drives` is a Super Brain implementation. Production code has no
runtime, build, or filesystem dependency on the Embers workspace.

## Embers

- Repository: `git@github.com:HaruHunab1320/embersjs.git`
- Pinned commit: `1bbafe059809026447f361d0e9f4a0e44e161ee9`
- License at the pinned commit: MIT
- Pinned worktree status when first inventoried: clean
- Inspected committed files:
  - `docs/design/v0.3/intention.md`
  - `src/types.ts`
  - `src/drives/{construct,drift,query,satiate,tick}.ts`
  - `src/intentions/{core,eligibility}.ts`
  - `src/metabolism/{metabolize,pressure}.ts`
  - `src/wear/{config,query,tick}.ts`
  - `src/being/{history,lifecycle}.ts`
  - `src/golden.test.ts`
  - `src/being/causal-log.test.ts`
  - related drive, intention, metabolism, and wear tests

No Embers file was copied. The local package reimplements the inspected numeric
and lifecycle behavior against package-owned immutable types and canonical Fold
records. Embers' full `Being`, practice substrate, capability gates, prose
voice, mutable lifecycle, serialization format, and host integration are
excluded.

The local implementation deliberately strengthens several boundaries: callers
supply event and domain IDs, malformed intention histories fail closed, event
payloads are JSON-only, source identity is mandatory, and explicit snapshots
are retained outside the intention fold. Custom drift remains supported in
memory but requires a stable ID because executable functions are not
serializable evidence.
