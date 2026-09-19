# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the
codebase. This repo is **single-context**: one repo, one bounded context.

## Before exploring, read these

In order:

1. **This repo's `AGENTS.md` / `CLAUDE.md`** — the canonical per-repo contract: commands,
   conventions, architecture, and the repo's own rules. Read it before anything else.
2. **The workspace `CLAUDE.md`** at `/Users/mjnong/REPOS/CellarNode/CLAUDE.md` — the sibling-repo
   map, shared package inventory, ports, agent-team workflow, and cross-cutting bans.
   CellarNode is a **sibling layout, not a monorepo**: each repo has its own PRs, CI, and
   release cadence.
3. **ADR records** — read current decisions under `docs/adr/`; historical RepoSkein records are archived under `docs/adr/reposkein-archive/`.
4. **`CONTEXT.md`** at the repo root, if it exists.

If `CONTEXT.md` doesn't exist, **proceed silently**. Don't flag its absence; don't suggest
creating it upfront. `/domain-modeling` creates it lazily when terms actually get resolved.

## ADRs in this repository

Historical RepoSkein ADR records are preserved byte-for-byte in `docs/adr/reposkein-archive/`. New ADRs are ordinary Markdown files under `docs/adr/`; use a descriptive filename such as `docs/adr/0001-short-title.md` and include context, decision, consequences, and alternatives.

If a proposed change conflicts with an existing ADR, surface the conflict in the review and update or supersede the Markdown ADR in the same change.

## Prefer the graph over grep

For structural questions — "who calls X", "what breaks if I change this", "what moves with this
file" — use RepoSkein rather than grep. It costs roughly 8× fewer context tokens on structural
queries.

`semantic_find` → `get_context_profile` → `impact` → `get_temporal_context` →
edit → `reindex_file` → `write_semantic_summary`.

**Federation caveat:** `federated: true` is a **silent no-op** in this sibling layout — the 17
repos have no common git parent, so there are no `FEDERATES_TO` edges. An `impact` result that
quietly covered one repo looks exactly like a safe green light. For genuine cross-repo blast
radius use `read_cypher`, which sees every repo loaded into the shared Neo4j, filtered by
`n.repo_id`.

## Use the project's vocabulary

When your output names a domain concept — an issue title, a refactor proposal, a hypothesis, a
test name — use the term this project actually uses. Established vocabulary, which agents get
wrong by default:

- **Producer-facing surfaces say "product"**, never "beverage" or "variant". Those are the
  backend/admin terms. Admin surfaces are exempt and use the domain terms directly.
- **Classification labels come from `@cellarnode/beverage-utils`**, never raw classification
  slugs rendered as-is.
- **`beverage_classifications` is canonical**; `beverage_categories` is deprecated.
- **Matches are a producer concept** (beverage ↔ tender). The importer surface is about **offers
  received** and notifications — do not describe match counts as an importer metric.

If the concept you need isn't established anywhere yet, that's a signal: either you're inventing
language the project doesn't use (reconsider) or there's a real gap (note it for
`/domain-modeling`).
