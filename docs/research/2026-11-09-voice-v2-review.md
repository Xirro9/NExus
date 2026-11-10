# REVIEWER #2 — Adversarial Review of SPEC-VOICE V2 Draft

**Date:** 2026-11-09 · **Reviewed:** `/tmp/opencode/v2-spec-draft.md` (all 20 sections + decision ledger) against `/tmp/opencode/v2-probes.md`, `/tmp/opencode/explore-opencode-surface.md`, `/tmp/opencode/researcher-v2-findings.md`, `docs/SPEC-VOICE.md` (V1), `docs/research/2026-11-09-voice-stack-research.md`.
**Method:** Full read of all six documents; independent read-only re-verification of load-bearing claims (live `GET /slots` and `GET /props` against llama.cpp `172.18.0.3:8080`; live GETs against the OpenCode service; `git log --all`/branch/stash audit and source greps in the NExus repo; Jerry `client.ts`/`sse.ts`/`types.ts` inspection; `nvidia-smi`). No generation probes, no POSTs, no writes outside `/tmp/opencode/`, no subagents.

**Verdict up front: APPROVE WITH CONDITIONS** — 5 blocking findings (1 critical, 4 major-blocking), all fixable as document amendments without changing the architecture. The V2 draft is substantially honest and evidence-grounded — its self-audit survives independent attack better than any spec I have reviewed in this pipeline — but it contains one asymmetric-safety hole, two gate-bypass/routing contradictions in the delegation path it just promoted into P1, a budget arithmetic flaw on its linchpin mechanism, and one unenforceable hard rule. None of these invalidate Option A′. All five must be fixed in the document before implementation starts.

---

## 1. Critical Findings

### C1 — Spoken permission replies are the only safety-critical path with zero transcription-error protection; "always" persists a standing privilege escalation. **BLOCKING**

**Evidence.** §6.2: *"spoken 'yes'/'always'/'no' maps 1:1 onto `POST /api/session/{id}/permission/{requestID}/reply {once|always|reject}`"*. Explore §C (VERIFIED): `always` **persists an allow rule**. §7.3/§7.4 build an elaborate transcription-error regime — verbatim-transcript riders, digit-wise echo-confirmation, closed confirmation vocabulary, one repeat — but **only for the delegation decision**. The downstream permission reply, which is the act that actually authorizes a tool execution, inherits none of it: a bare spoken "yes" with no echo, no closed-vocabulary gate, no confidence threshold, and — uniquely — a persistent side effect (`always` writes a saved allow rule the user cannot see in voice mode).

**Why it blocks.** The architecture's entire safety story (§1, §7.1 layering principle, §13) is "voice can never bypass OpenCode's permission engine." That is true structurally — but V2 adds a new *transport into* that engine and leaves its input unhardened. Failure modes: (a) STT mis-hears ambient speech or the announcer's own TTS as "yes" while a permission is pending (§7.2.4 explicitly checks utterances as permission replies first) → a tool call the user never approved executes; (b) a mis-heard "always" silently rewrites the permission ruleset permanently — worse than a single mis-grant, because it survives the session; (c) the asymmetry is indefensible on its own terms: V2 protects the *less* dangerous decision (whether to delegate) more heavily than the *more* dangerous one (whether the tool may act). The mandate's "confirmation gates bypassable?" question is answered **yes, by misrecognition, on exactly the path V2 newly opened**.

**Fix (document amendment, cheap).** In §6.2 and §7.4: (1) voice may reply `once` or `reject` only — spoken `always` is refused with a spoken pointer to the approval drawer; (2) every permission reply passes the same closed-vocabulary echo-confirm gate as L3/L4 ("The task wants to run `<action>`. Say yes to allow, no to deny."); (3) extend T9 with a negative-path test (spoken noise / "no" / unrelated sentence while `permission.asked` is pending → reject or re-prompt, unrelated running task untouched, and **assert no saved allow rule was created** in the whole P1 acceptance run).

---

## 2. Major Findings

### C2 — The "task:" prefix bypasses Jerry's own confirmation gate; class is unassigned on the prefix path. **BLOCKING**

**Evidence.** §7.2.1: *"Explicit prefixes (bypass everything): 'task: …' → delegate directly (no conversation call at all)."* §7.5 row 3 codifies "delegate immediately, no GLM routing call." But the L3/L4 gates (§7.1, §7.4) are keyed on `kind ∈ {destructive, privileged}`, which is produced **by the fused schema call the prefix path skips**. Nothing in the draft assigns a class to a prefix delegation. Spoken "task: delete the build directory" or "task: force-push to main" therefore delegates with no Jerry-side echo-confirm. The layering principle (§7.1) is not violated at the OpenCode layer — the concrete tool call still flows the permission engine — but (a) V2's own defense-in-depth gate is bypassed by design, and (b) if the operator's saved rules auto-allow some mutating tools, the destructive action can execute with *no* gate anywhere. This is precisely the bypass class the mandate names.

**Why it blocks.** V1's prefix existed in a world where the gate was the permission engine alone. V2 *added* the Jerry-side gate as a headline safety feature (§19b: "confirmation gates are safety-critical so they should not wait") and simultaneously specified a path around it.

**Fix.** Prefix delegations must not skip classification: either (a) the prefix forces `task.requested=true` in the (small, warm, cheap) fused call so `kind` is still produced and §7.4 applies uniformly; or (b) prefix delegations default to `kind="coding"` **and** the Voice-tasks session is created with a `permissions` ruleset that forces `ask` on mutating tool actions (create-body `permissions` is VERIFIED available, explore §A.1 — currently listed in §6.3 only as "if needed"; make it mandatory for this session). Option (a) plus the ruleset is the clean combination; it costs one warm small call on prefix turns, which is exactly the cost the prefix was trying to avoid — say so honestly and accept it for the destructive-safe trade, or restrict the no-call fast path to a literal allowlist of non-mutating verbs.

### C3 — Routing contradiction: the explain-veto guard intercepts the flagship follow-up query, and L1 "read-only" has no enforcement. **BLOCKING**

**Evidence.** §7.5 row 5 is an *acceptance fixture*: *"What did the task find?" → L1 read-only → read-only turn into task session*, and §6.2/§9.2 both route this query into the Voice-tasks session "which owns the truth." But §7.2.2 overrides *any* utterance matching "interrogative/how/what/why/explain/compare patterns → task verdicts are overridden to conversation." "What did the task find?" begins with "what." Under the guard as written, the fixture **fails**: the turn routes to the conversation path, where the model's only task knowledge is the one-line task-state summary (§9.3) — i.e., GLM is invited to improvise an answer about task results it cannot see. Three defects compound: (1) guard vs. §6.2/§7.5/§9.2 contradiction on a named fixture that T7 is supposed to pass; (2) if routed as a task turn while the session is **running**, §7.2.4's steer rule would inject the query into the active run — derailing task context mid-execution and spending the shared slot; (3) "read-only" is an intent label with no enforcement: the default pinned agent is `build` (§19f), which can execute tools; §19f defers the `plan` switch to "if P1 logs show misuse."

**Why it blocks.** This is a self-inconsistency between §6, §7 and §9 on the single most-used voice interaction in the delegated mode ("what did it find?"). T7 as specified would catch it, but the spec must not ship a fixture its own rules fail.

**Fix.** Add a state-based routing rule with **precedence over the lexico-syntactic guard**: utterance references the (existing) Voice-tasks session/task AND session state is known → if idle, route as L1 read-only turn into that session with the `plan` agent pinned for that turn (or a session ruleset denying mutations) — this is a state machine decision, not an intent guess; if running, answer from the log cursor/task-state line and offer to queue the question (`delivery:"queue"`). Scope the guard's veto to the *no-active-task* case. Bind L1 enforcement (plan pin or ruleset) in P1, not "if logs show misuse."

### C4 — `max_tokens 240` sits at the wrapper floor with zero margin; grammar-forced truncation loses the whole turn, and no truncation semantics are specified. **BLOCKING**

**Evidence.** §2.3: *"max_tokens 240 (≈200 spoken reply + wrapper overhead)"*. Count the wrapper: the schema *requires* the full task object on every turn — `{"task":{"requested":false,"kind":"none","prompt":"","target":""}}` ≈ 20–30 tokens — plus `{"reply":"` framing and JSON escaping. That leaves ~205–212 tokens for the reply. Two aggravators: (1) the reply has no length enforcement (add `maxLength` to the schema — supported by the converter — or accept drift); (2) on **task** turns the model also writes `task.prompt` content into the same budget, making delegation turns the *most* truncation-prone. With a grammar enforced, generation cannot terminate early — a chatty reply truncates mid-JSON, `finish_reason=length`, the payload is unparseable, and since V2 specifies **no** truncated-output handling (V1 §3.5 had explicit "parse-failure → speak 'I didn't catch that'"), the entire streamed reply is discarded. The §2.3 comparison table's evidence row ("MEASURED P2/P5/P6") covers 40-token probes; nothing measures a 200+-token schema turn.

**Why it blocks.** This is the linchpin mechanism's happy path. Occasional whole-turn loss with no defined recovery, on every conversational turn, is a reliability defect the probes never exercised.

**Fix.** In §2.3: raise to 320–400 after measuring decode tok/s in P1 (the draft never measures decode rate — add it to T3); put `reply` first in required order so a truncated stream still yields the reply text; add `maxLength` on the reply string; specify salvage semantics — incremental parse of the SSE delta stream: reply string usable for TTS even when the task object never arrives (routing fails open to conversation, consistent with the draft's own fail-open doctrine); fall back to "I didn't catch that" only when the reply string itself is incomplete.

### C5 — The `/slots` pre-check is TOCTOU-racy; a voice turn can silently queue behind an OpenCode turn, contradicting the §10.2 hard rule, with no recovery on the fired path. **BLOCKING**

**Evidence.** §10.1: *"Fire the fused turn immediately (pre-check `fail_on_no_slot` first)."* §10.2 hard rule: *"voice never preempts, never queues into llama-server."* But `fail_on_no_slot=1` is a property of the **`/slots` probe** (researcher §6, DOCUMENTED), not of `/v1/chat/completions` — the generation endpoint queues by default. Between the check returning idle and the server admitting the request (~10–100 ms), an OpenCode prompt can win the slot; the voice request then sits in llama-server's queue behind a turn that can run for minutes. Every mitigation the draft builds (filler, park, waiting chip, latest-utterance-wins) lives on the *pre-fire* defer path; the *fired-but-queued* path has none — the user sees "thinking" indefinitely. Escape is a manual barge-in, which the design never connects to this state. The mirror direction (OpenCode queued behind a just-fired 240-token voice turn) is bounded (~1–3 s, §10.2) and acceptable.

**Why it blocks.** §10.2 states the no-queue property as absolute; the specified mechanism cannot deliver it. Over days of operator use the race will hit, and its failure mode (unbounded silent hang of the primary conversational surface) is exactly what §10 exists to prevent.

**Fix.** Add a post-fire watchdog to §10.1: if no first SSE byte within a bounded window (e.g. 3–4 s, ≥ the MEASURED 3.4 s worst divergent TTFT) and `/slots` shows a foreign task `is_processing`, abort (S2 machinery, epoch-consistent) and re-park the utterance with the standard filler/chip path. Also add the corresponding test (see §5 below, gap G1). One paragraph; closes the only hole in the concurrency story.

### M1 — Guard false-veto on polite imperatives is unmeasured and the pressure valve is under-specified. **NONBLOCKING**

The architect's own ledger item 2, confirmed. "Can you fix the flaky test?" / "Could you run the migration?" match interrogative patterns ("can/could you") and would be vetoed to conversation — the user wanted the task. §7.2.2's "optional spoken offer" ("Want me to run that as a task?") is the right valve but its flow is unspecified (does "yes" then delegate through the gates? does it re-enter the schema path?). Required: T7's 20 additional pairs must include a polite-imperative subset (can/could/would you + verb, please-imperatives) with a target false-veto rate, and §7.2.2 must define the offer's continuation path. The guard should treat "can/could you + imperative verb" as task-favoring, not interrogative.

### M2 — The cost gate (§7.2.5) is incoherent when the slot is idle; cut it or bind it to busy. **NONBLOCKING**

§7.2.5 permits deferring a conversational turn when warmth telemetry shows "a large hot OpenCode working set" — but if the slot is **idle**, deferral protects nothing: the eviction happens the moment any divergent prompt (voice's included) runs, and OpenCode's next turn pays re-warm regardless of when the voice turn fired. Idle-deferral only adds dead air between the user's question and the filler. The coherent posture already exists in §10.1 (defer when occupied). Delete the idle case from §7.2.5 or restate it as: cost gate applies only when the slot is busy; when idle, fire immediately and accept the §10.3 externality. This is also a simplification (mandate: unnecessary complexity).

### M3 — Permission-asked announcement vs. reply-check ordering hazard. **NONBLOCKING**

§6.2 makes permission announcements "never throttled, never suppressed" but they still respect announce-when-quiet; §7.2.4 checks utterances as permission replies first when the session is awaiting permission. Interleaving: `permission.asked` arrives while the user is speaking → the user's next utterance is checked as a permission reply **before the announcement was ever heard** — the user is answering a question they never received. Fix: if the announcement for a pending permission has not yet been spoken, suppress the reply-check (route the utterance normally), speak the announcement at the next quiet window, and only then arm the closed-vocabulary reply gate. Pairs naturally with C1's fix.

### M4 — §3's KV-cache row overstates the A′/B contrast; task-state-line placement is unspecified. **NONBLOCKING**

Two honesty gaps in the comparison that decided the verdict (the verdict itself stands — parameter control is decisive and measured): (1) the row "voice history inflates the prefix it must keep warm; compaction turns are large slot consumers" is charged against B, but A′'s **Voice-tasks session accumulates every task's history unboundedly** with the same compaction economics — §9.4 never mentions task-session compaction. The differentiator is that A′ keeps the *conversation* prefix small, not that A′ has no growing prefix. State it. (2) §9.3's task-state line lives in the system prompt; any state transition (idle→running→awaiting→done) mutates the prompt at position ~0, invalidating the voice cache from the top. §3's "two stable prefixes" claim should acknowledge the churn and §9.3 should specify placement (mutable line **after** the static system core, ideally after the rolling history, so the stable prefix survives; the recompute is small either way, but the spec should say which).

---

## 3. Minor Findings (deferrable)

- **m1. Confirmation-gate echo wording (§7.4).** The spoken echo ends "— confirm?" — the gate's own prompt contains the acceptance keyword. If mic-open and echo playback ever overlap (late open, BT latency, P2 speaker mode before AEC), the gate can hear its own question. Make the gate provably half-duplex (mic opens only after the echo's Done+pad, reusing §8.4's definition) and phrase the echo question without gate vocabulary ("— is that right?").
- **m2. Log-cursor re-sync anchor (§9.4).** "Re-syncs from `after=0` if the cursor is stale" would replay the entire Voice-tasks history through the announcer (throttle storm, stale announcements). Anchor to the current tail (`log.synced` seq from the explore file's measured behavior), not 0.
- **m3. Post-abort 503 retry (§8.1/§10.1).** After a barge-in abort, S4 is MEASURED 120–363 ms; the next turn's pre-check normally happens ≥1.2 s later (EOT), so ordering is safe — but the invariant is unstated and a slow disconnect would produce a spurious defer+filler. State the S4-before-next-pre-check invariant and add a ≤500 ms bounded retry on 503 before deferring.
- **m4. Missing failure-mode rows (§10.1/§13/§17).** Disk-full during transcript JSONL writes (→ disable persistence + error frame, never crash); TTS/STT model load failure at startup (→ text-only degrade + chip — R9 covers panics, not load failure); llama-server connection reset mid-stream on the conversation path (→ SSE error handling: one retry, else spoken "connection lost"); OpenCode service down mid-task (→ announcer offline chip + log-cursor re-sync on reconnect, which §9.4 covers only for restart).
- **m5. §11.2 cells carry no proof labels** (mandate: labels on every claim). Inherit §11.1's labels per row or add a column.
- **m6. Test gaps (detail in §5 below).** Missing: watchdog/TOCTOU test, permission negative path, busy-defer E2E, divergence re-warm, gate echo negative path; T6 lacks a measurable acceptance criterion; T7 lacks the polite-imperative subset; T3 should add decode tok/s + host CPU characterization.
- **m7. Resampling silently dropped.** V1 §2.5 carried `rubato 5.0.1` (device-default-rate mic → 16 kHz mono f32 is mandatory in both specs); V2's component list (§2.4) and dependency story omit it. Reinstate (or state the cpal config guarantees 16 kHz on all target devices — it doesn't for BT HFP).
- **m8. Routing stability at temp 0.7.** The determinism evidence (P2==P6) is at temp 0; the fused turn ships at 0.7, where routing verdicts vary. T7's "temp variation" covers it — make explicit that the corpus runs at the operating temperature, and consider whether conversation quality actually needs 0.7 for ≤200-token replies.
- **m9. Per-class agent switching (§19f) re-renders the task session's system prompt** on every `build`↔`plan` switch → prefix churn + re-warm cost per switch. Note the cost in §19f; prefer the session ruleset (C2 fix) over agent toggling.
- **m10. §13 "no network egress from any voice module" is contradicted by P0's model downloads.** Scope the claim: no egress from the audio/LLM path; downloads are pinned-URL, digest-verified, and UI-mediated.
- **m11. Cap the spoken permission message.** §6.2 speaks `<message>` verbatim; the succeeded-summary is capped at ~240 chars — apply the same cap + markdown-strip to permission and form questions (also bounds injected-content readback).
- **m12. `requested=true, kind="none"` combo unspecified** (grammar permits it). Define handling (treat as conversation + log).
- **m13. Zero-heard turns leave consecutive user messages** in the GLM history (assistant turn omitted per §8.4). Specify merge or a placeholder system line so the messages array stays well-formed for the template.
- **m14. §16 is a placeholder** — fold this review's verdict and disposition table into the adopted document, as V1 did (§12).
- **m15. `?resume=true` wrapper (§6.3) + "stop everything" per-child interrupt deferred to P2 (§6.2)** — fine, but the P1 "stop the task" utterance on a task with live subagents will leave children running; the spoken result ("Stopped.") would be false. Either suppress the success canned line when children survive, or pull minimal child-discovery into P1.

---

## 4. Verified Strengths

1. **The V1 audit is real, and I reproduced it.** `git log --all` (zero voice/spike commits), branch list (`master` + `origin/master` only), empty stash, tree grep (single prose match in `Sidebar.tsx` line 314), and no `docs/SPEC-VOICE-V1.md` yet — every particular of §15.2's "FALSE as written" verdict checks out first-hand. Relabeling the pipeline's one fabricated "proven" claim and demoting it to T1 is the single most important integrity act in this draft, and it was done against the architect's own prior document.
2. **`/health` → `/slots` is measured and now live-confirmed by me.** During this review the slot was mid-generation (`is_processing:true`, `id_task:1867182`, 100,680 `n_prompt_tokens`) while `/health` would report ok; the undocumented `n_prompt_tokens*` fields are present exactly as claimed, and `chat_format:"peg-native"` corroborates the researcher's build characterization.
3. **The `reasoning_budget_tokens:0` requirement is triple-anchored.** Live `/props` shows the GLM template literally renders `reasoning_effort … else 'max'` and never references `enable_thinking` — the template-default-to-max claim is verbatim true — and probes P1 (empty content) vs P2 (conformant) measure the failure and the fix. Option B's falsification rests on this and it holds.
4. **The explain-vs-do hazard is measured, not hypothesized** (P5, temp 0, the exact mandate sentence), and V2's response — deterministic guard as the control, LLM verdict never solely authoritative, echo-confirm as the damage bound — is the correct control placement.
5. **rodio corrections are source-level and match the crate**: `Sink`→`Player` rename, `append`-after-`stop` safety, `len()==0` ≠ audible end, the 50 ms-code/100 ms-docs buffer discrepancy (a genuinely good catch), Done-receiver + pad as the heard-definition. V1's "<5 ms barge-in" claim is corrected without defensiveness.
6. **Latency re-baselining is honest.** §11.1's stage sum recomputes to 2.39–3.88 s raw, consistent with the quoted ≈2.5–3.2 s warm median; scenario 3's 5.5–6.5 s post-coding figure follows from the MEASURED 3.0–3.4 s divergence plus pipeline; ChatGPT comparisons are gone; the V1 number's false inputs are named.
7. **Option B was falsified on a measured parameter, not aesthetics** — and §3's latency anchor (warm OpenCode 0.41 s ≈ warm direct TTFT) correctly removes the per-turn-overhead argument from the table, keeping the comparison about cache economics and ownership. The falsification criteria for A′ (§3 end) are concrete and testable.
8. **The barge-in isolation hard rule is enforced by the strongest acceptance criterion in the doc** — T8's 50-barge-in event-diff with zero OpenCode session state changes — plus §8.5's enumerated absolutes and the §8.2 race table (which correctly closes the check-vs-enqueue race by single-writer construction, retaining V1 MAJOR-2).
9. **Two-register history ownership with the task-state bridge** (§9) answers the coherence mandate correctly: no mirrored truth, rebuildable derived views, results never injected into conversation history, heard-content rule prevents interrupted-turn corruption (§8.4 is the right UX-truth choice — the architect's ledger item 3 invites disagreement, but "the user cannot reference what they never heard" is the correct tiebreaker).
10. **The normalizer elevation is the correct response to #4139**: mandatory component, never-drop policy by construction, one-way transform protecting OpenCode-bound text/history/transcripts, corpus-gated (T10) with engine-swap coverage.
11. **The GPU doctrine rewrite is confirmed by my own re-measurement today**: 70,432 / 74,786 / 75,157 MiB of 97,887 per GPU, llama-server PID 13145 on all three. The refined claim ("unallocated but reserved for KV growth") is more precise than V1's and more precise than "no spare VRAM" — CPU-only as a reliability decision is the right framing.
12. **Gate discipline (§14) with entry gates + exit acceptance + named tests is the right roadmap shape**, and the delegation-in-P1 move (§19b) is defensible precisely because the native surface (pinning, steer/queue, permission loop, durable inbox) is VERIFIED and already half-wrapped in Jerry — I confirmed `createSession` sends `location` only, `interrupt` carries no `resume`, and `replyPermission`/inbox calls exist exactly as the explore file claims.

---

## 5. Unresolved Assumptions (mapped to T1–T10; gaps flagged)

| Assumption | Mapped test | Status / gap |
|---|---|---|
| Dual ONNX runtime coexistence | T1 | Well-defined procedure; correctly gated to P2. No gap. |
| sherpa static linking in AppImage | T2 | Defined; fallback documented. No gap. |
| Local STT/TTS latency + RSS on this host | T3 | **Gap:** must also measure GLM decode tok/s (feeds C4's budget) and characterize host CPU (admitted unmeasured, §5). RSS ≤1.5 GB stays an ESTIMATE until then. |
| Disconnect abort through Jerry's stack | T4 | ≤500 ms consistent with MEASURED 120–363 ms. No gap. |
| rodio stop→audible delta | T5 | Defined; feeds S3 + pad constant. No gap. |
| Fused-schema reply quality | T6 | **Gap:** "no systematic register degradation" is not measurable. Require a rubric (e.g., blind pairwise preference with a defined tie rule, or a length/register delta bound) and run at the operating temp (0.7), not a single seed. |
| Router/guard corpus | T7 | **Gap:** add polite-imperative subset with a false-veto target (M1), add task-status queries per the C3 fix, run at operating temp (m8). |
| 50-barge-in torture | T8 | Strong as written (event-diff assertion). No gap. |
| Permission round trip | T9 | **Gap:** happy-path only. Add negative paths (noise/mis-heard/"no" → reject; unrelated task untouched; **no saved allow rule created**) per C1. |
| Pronunciation corpus | T10 | Defined, falsifiable (zero dropped tokens is the right invariant). No gap. |
| **Missing tests entirely** | — | **G1:** TOCTOU/watchdog (C5) — fire voice turn, start OpenCode turn within ~200 ms, assert either first-byte within bound or abort+re-park with filler. **G2:** busy-defer E2E (§11.2 scenario 2: filler + park + fire-on-idle) — currently no acceptance test covers the defer path end-to-end. **G3:** post-coding divergence re-warm (scenario 3's "subsequent turns re-warm" is ESTIMATED, never tested). **G4:** prefix-bypass gate behavior (C2) — "task: <destructive>" must hit the echo-confirm. **G5:** gate echo negative path (m1) — echo playback while gate armed produces no confirm. |

Also unresolved and correctly labeled as such: int8 RSS halving (§5, honest), Silero false-trigger rate (researcher §7, UNVERIFIED, covered by the EOT JSONL), whether schema compilation is cached across requests (researcher §1b, UNVERIFIED — relevant to C4's grammar-overhead term on long turns).

---

## 6. Proof-Label Spot Audit (12 claims, cross-section)

| # | Claim (section) | Label in draft | My verification | Result |
|---|---|---|---|---|
| 1 | Wrapper-form `json_schema` accepted by this build (§2.3, §1) | VERIFIED (+MEASURED P2) | Researcher §1a source read + P2; consistent with live `/props` (`peg-native`, reasoning caps present) | **Confirmed** |
| 2 | `reasoning_budget_tokens:0` required for short calls (§1, §2.3, §4) | MEASURED | P1 empty-content vs P2 conformant; template `else 'max'` seen verbatim in live `/props` | **Confirmed** |
| 3 | GLM misclassifies "explain how to delete a git branch…" at temp 0 (§1, §7.2) | MEASURED | Probe P5 | **Confirmed** |
| 4 | GLM occupies all three GPUs, 70–75 GiB of 97,887 (§5) | MEASURED | **Re-measured today:** 70,432 / 74,786 / 75,157 MiB; PID 13145 on all three | **Confirmed** |
| 5 | `n_prompt_tokens*` undocumented-but-real cache fields (§10.1, §4) | MEASURED | **Live `GET /slots` during this review** returned all three fields on a mid-generation slot | **Confirmed** |
| 6 | Disconnect→slot-free 120–363 ms (§8.1 S4, §11.2) | MEASURED | `aborttest3.py` preserved in probes file; not re-run (generation probes out of my scope) | **Confirmed (by preserved probe)** |
| 7 | rodio 0.23 rename; ~50 ms code / ~100 ms docs buffer tail; Done+pad semantics (§2.4, §8, §12.4) | VERIFIED (source) | Researcher §5 read v0.23.0 source; matches independent crate knowledge | **Confirmed** |
| 8 | Kokoro English frontend drops numbers/currency/OOV (§2.4, §12.2) | VERIFIED (#4139) | Researcher §3a with maintainer quotes; open issue, version-pinned | **Confirmed** |
| 9 | Fresh OpenCode session 4.75 s vs warm 0.41 s first-text delta (§3) | MEASURED | `ocab2.py` in probes file | **Confirmed (by preserved probe)** |
| 10 | V1 "proven in P0 spike" is FALSE; git history clean (§15.2, §1) | Audit claim | **My own audit:** zero commits/branches/stashes; single prose match; no V1 rename yet | **Confirmed first-hand** |
| 11 | "Byte-identical determinism at temp 0" (§2.3 table) | MEASURED | P2==P6 — **one fixture pair, one schema+prompt** | **Partially confirmed — label overreaches**; qualify as "MEASURED (single fixture)" |
| 12 | "max_tokens 240 (≈200 spoken reply + wrapper overhead)" (§2.3) | **no label** (unlabeled arithmetic) | Wrapper recount: floor ~25–30 tokens, zero margin; task turns add `task.prompt` tokens; no truncation semantics specified | **Not confirmed — see C4** |

Two audit hits out of twelve: one label overreach (11, minor), one unlabeled claim whose arithmetic is load-bearing and wrong at the margin (12 → C4). Every MEASURED claim I could independently re-derive held up.

---

## 7. Final Recommendation

## **APPROVE WITH CONDITIONS**

The architecture (Option A′) is correct for this environment and the evidence discipline is the best this pipeline has produced — every audited MEASURED/VERIFIED claim survived independent attack, including the draft's self-incriminating V1 audit. The five conditions below are document amendments, not architecture changes; implementation (P0) may start once they are applied to the adopted spec (fold into §16 per m14). P1's delegation scope must not begin until C1–C3 are resolved in text.

**Conditions (must be fixed before implementation starts):**

1. **C1 → §6.2, §7.4, §13, T9:** spoken permission replies restricted to `once`/`reject`; echo-confirm gate on every permission reply; `always` reachable only via the GUI; T9 extended with negative paths including a no-saved-rule assertion.
2. **C2 → §7.2.1, §7.4, §6.3:** prefix delegations must not bypass class assignment or the §7.4 gate (force-classify or default-coding + mandatory ask-ruleset on the Voice-tasks session at creation).
3. **C3 → §6.2, §7.2, §7.5, §9.2, T7:** state-based routing precedence for task-status queries (idle → enforced read-only turn with plan/ruleset pinning; running → state-line answer + queue offer); guard veto scoped to the no-active-task case; §7.5 fixture made consistent with the guard.
4. **C4 → §2.3, T3:** raise `max_tokens` (320–400) sized by a measured decode rate; `reply` first in schema order + `maxLength`; specified truncation/salvage semantics (partial reply playable, routing fails open).
5. **C5 → §10.1, §10.2:** post-fire watchdog (no-first-byte bound → abort → re-park with filler) so the §10.2 no-queue rule is actually enforceable; add test G1 to §15.3.

**Recommended before P1 (non-blocking but expected):** M1 (polite-imperative fixtures + offer flow), M2 (cut or bind the idle cost gate), M3 (announcement/reply ordering), M4 (§3 honesty + state-line placement), and the missing tests G1–G5 with T6's measurable criterion.

**Summary counts:** 1 critical, 5 blocking total, 4 major non-blocking, 15 minor. **Fix first:** C1 (spoken `always` mis-grant surface), C2 (prefix gate bypass), C4 (linchpin token budget) — then C3 and C5.
