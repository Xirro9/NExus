# Research library

Deterministic, LLM-free store for source documents the researcher agent
collects. Everything here is plain files + one derived SQLite index; the
engine (`src/lib/research/engine.ts`) is the single source of truth for
semantics, and the CLI (`.opencode/plugins/research-library/cli.mjs`) is the
only writer you should drive by hand.

## Layout

```
research-library/
  collections/<slug>/      reserved per-collection working dirs (may stay empty)
  metadata/collections.json   display names/descriptions + optional TTL overrides
  sources/<collection>/<slug>/   unit of record — original bytes + manifest
    r<rev>-<hash8>.<ext>       one file per content revision (prior files kept)
    manifest.json              parsed text + full revision history
  indexes/research.db       DERIVED SQLite index (FTS5) — rebuildable
  cache/                    scratch space, never authoritative
```

**The database is derived.** Sources + manifests are the unit of record; the
DB can be deleted and rebuilt at any time:

```
node .opencode/plugins/research-library/cli.mjs refresh --reindex
```

`reindex` replays every `sources/**/manifest.json` in sorted order; corrupt
manifests are skipped in isolation and reported (`skipped[]` in the JSON
output). Manifests carry the parsed section text, so replay is parser-free.

## Conventions

### Proposed vs enacted (legislation)

Bills move; a snapshot from the introduction stage must never read as law.
Every legislation ingested from a pre-enactment stage MUST carry notes of the
form:

```
Status: introduced in Senate (not enacted), checked 2026-11-09
```

When a bill advances, ingest the new text as a new document (new slug, e.g.
`s-5471-enr`) with its own version — the engine flips the older rows of the
same source URL to `superseded` automatically (and records the flip in their
manifests). Never edit an existing revision in place.

### Citations

Cite by document id and section anchor, bill-number style:

```
S. 5471 SEC. 4. (introduced)
```

The doc id (`legislation/s-5471`) plus the anchor (`SEC. 4`) is enough to
retrieve the exact passage with `get --section "SEC. 4"`.

### Freshness / TTL model

Staleness is computed at read time, never stored: `ageDays` counts from the
newest of `retrieved_at` / `verified_at`, and a document is stale when that
exceeds its collection TTL (legislation 30d, cybersecurity 90d,
ai-research 180d, technical-docs 365d, projects 30d). TTLs can be overridden
per collection in `metadata/collections.json` (`ttlDays`). The `stale` status
value is reserved for explicit researcher marking — ingest only ever sets
`cached`, `verified` (which also bumps `verified_at`), or engine-managed
`superseded`.

## CLI quick reference

```
status                                    [--json]
list      [--collection <slug>]           [--json]
search    "<query>" [--collection <slug>] [--limit 1-50] [--scope all|documents|sections] [--json]
get       "<docId>" [--section "<anchor substring>"] [--max-chars N] [--json]
import    (--manifest <path.json> | --stdin) [--json]
refresh   [--reindex]                     [--json]
```

`--json` keeps stdout pure machine JSON (human logs go to stderr). Exit codes:
0 ok, 2 usage/validation, 3 not found, 4 I/O error. Root resolution order:
`--root` > `RESEARCH_LIBRARY_ROOT` > walk-up to the directory containing
`research-library/`.

## Identity + idempotency

A document's identity is `(collection, source_url, version)`; content is
hashed (sha256 over normalized text). Re-ingesting the same identity with the
same content is a no-op — `retrieved_at` is never bumped. Same identity with
new content appends a revision (`r<rev>-<hash8>.<ext>`); the prior file is
retained and the full history lives in the manifest's `revisions[]`.
