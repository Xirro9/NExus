# Collection: legislation

Bills, public laws and congressional materials (congress.gov, govinfo).
Collection TTL: 30 days (root README, "Freshness / TTL model").

## Proposed vs enacted — the rule

**All documents in this collection describe PROPOSED legislation unless their
notes say otherwise.** Never summarize a bill as if it were law. Every
document ingested from a pre-enactment stage carries a verbatim status line
in `notes`, of the form:

```
Status: Introduced (not enacted), checked YYYY-MM-DD — <one-line action summary>. Sponsor <sponsor>; cosponsors <cosponsors>. <Congress>, <session>.
```

Seeded example (S. 5471):

```
Status: Introduced (not enacted), checked 2026-11-09 — read twice and referred to the Senate Committee on Commerce, Science, and Transportation. Sponsor Sen. Coons (D-DE); cosponsors Britt (R-AL), Schatz (D-HI), Lankford (R-OK). 119th Congress, 2d Session.
```

The `checked YYYY-MM-DD` date is the **as-of date**: the day the source was
last fetched live. Every status claim is valid only as of that date. A
document that becomes law must say so explicitly in notes (e.g. `Status:
Enacted — Public Law 119-xxx, checked YYYY-MM-DD`) and the law text is a new
document with its own slug.

## Citation style

Bill sections are cited by bill number, section anchor, and stage:

```
S. 5471 SEC. 4. (introduced)
```

Anchors are stored literally as the bill prints them (`SEC. 1.` … `SEC. 7.`,
trailing period included); the stage in parentheses is the document's
`version` field (`introduced`, `enr`, `ras`, …). Doc id + anchor resolves to
the exact passage:

```
node .opencode/plugins/research-library/cli.mjs get "<docId>" --section "SEC. 4" --json
```

## Seeded documents (2026-11-09)

| docId | title | sections | version | source |
|---|---|---|---|---|
| `legislation/s-5471-ai-systems-transparency-act` | S. 5471 (119th Congress, 2d Session): AI Systems Transparency Act — Introduced in Senate (IS) | 8 (`Preamble` + `SEC. 1.`–`SEC. 7.`) | introduced | govinfo BILLS-119s5471is XHTML |
| `legislation/s-5471-congressional-status` | S. 5471 — Congressional status record (119th Congress, 2d Session) | 6 | introduced | congress.gov bill page + govinfo content details |

Bill-text sectioning: a leading `Preamble` section holds the Congress/session
header, title block, introduction action, and enacting clause; `SEC. 1.`–
`SEC. 7.` hold the bill body with the bill's official short titles as
headings. All substantive text is preserved verbatim; whitespace is
normalized. Companion documents in other collections (`ai-research`,
`cybersecurity`) hold the NIST/OMB context this bill leans on.

## Re-verifying bill status

1. **Fetch live**: the congress.gov bill page (latest action, tracker, policy
   area) and the govinfo content details page (bibliographic summary). Never
   re-verify from memory or a cached copy.
2. **Nothing material changed** → re-import the same manifest with `status:
   "verified"`. Identical content hashes to a no-op that sets `verified_at`
   (resets the 30-day staleness clock; `retrieved_at` is never bumped).
3. **Status changed** (new action or new text version) → ingest the new text
   as a NEW document: new slug (e.g. an engrossed Senate text becomes
   `s-5471-engrossed-senate`) with the matching `version`. Engine rules: a
   new version means a new slug (doc ids have no version slot); re-importing
   the same `(collection, source_url, version)` with different content
   appends a revision instead. Always write a fresh status line with the new
   `checked` date — the engine auto-flips older same-source documents to
   `superseded`.
4. After any import: `node .opencode/plugins/research-library/cli.mjs refresh
   --reindex --json` and confirm the `documents` count and `skipped: []`.

Never edit files under `sources/` by hand and never touch
`indexes/research.db` — the CLI is the only writer.
