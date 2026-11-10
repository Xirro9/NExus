# SPEC-VOICE V2 — Researcher Findings (independent verification pass)

**Date:** 2026-11-09 · **Role:** researcher (verification subagent) · **Build under test:** llama.cpp server `b11889-d854d98ba` (`ghcr.io/ggml-org/llama.cpp:server-cuda13`, GLM-5.3-Flash Q4_K, `--parallel 1`, total_slots=1)
**Method:** 6 generation probes (≤40 tokens, temp 0, /slots-wait before each) + 1 one-token grammar-validation call (disclosed in §1) + source-level verification against llama.cpp master (post-refactor layout matching this build) + docs.rs/GitHub sources. No config changes, no model downloads, no services started.
**Raw probe log:** `/tmp/opencode/probe-results.jsonl` · harness: `/tmp/opencode/probe.py` · slot snapshot: `/tmp/opencode/slots-snapshot.json`

**Labels:** MEASURED (live probe, this machine today) · VERIFIED (read from primary source code/docs) · DOCUMENTED (official docs) · ESTIMATED (derived, not measured) · UNVERIFIED (assert without evidence) · REQUIRES IMPLEMENTATION TEST.

---

## 1. Structured output for intent classification

### 1a. Does the installed build produce schema-conformant output? — YES, with one mandatory setting

| Probe | Path | Constraint | Thinking? | Result |
|---|---|---|---|---|
| P1 | `/v1/chat/completions` | `response_format: json_schema` (OpenAI wrapper form) | ON (default) | **Content EMPTY.** All 40 tokens consumed by `reasoning_content` (free prose), truncated mid-thought. MEASURED 22:02 |
| P2 | `/v1/chat/completions` | same + `reasoning_budget_tokens: 0` | OFF | `{"intent":"task","target":"delete_file"}` — parses, `intent ∈ enum`, no fences, zero reasoning. MEASURED |
| P3 | `/v1/chat/completions` | none (same messages) | OFF | Invented its own schema: `{"intent":"delete_file","entities":{"path":"…"}}` — **not** conformant. MEASURED |
| P4 | `/completion` | `grammar` (GBNF) | n/a (no template) | `{"intent":"task","target":"/home/mg-12623-8/Documents/notes.txt"}` — grammar-conformant, full path preserved. MEASURED |
| P5 | `/v1/chat/completions` | json_schema + budget 0, *converse* prompt | OFF | `{"intent":"task","target":"git_branch_deletion"}` — conformant; **semantic misclassification, see §2.** MEASURED |
| P6 | = P2 repeat | json_schema + budget 0 | OFF | **Byte-identical to P2** → deterministic at temp 0 for this schema+prompt. MEASURED |

- **VERIFIED (source, `tools/server/server-common.cpp` @ master, same architecture as this build):** the chat endpoint accepts `response_format` `json_object`(+`schema`), `json_schema`(+`schema`), **and the OpenAI wrapper form `{"type":"json_schema","json_schema":{"name":…,"strict":…,"schema":{…}}}`** — the wrapper is explicitly parsed (schema extracted from `json_schema.schema`).
- **VERIFIED (source):** `grammar` and top-level `json_schema` are accepted body params on **both** `/completion` and `/v1/chat/completions`; they are mutually exclusive ("Cannot use both json_schema and grammar"), and `grammar` + tools + tool_choice ≠ none → 400 "Cannot use custom grammar constraints with tools". README (§ POST /v1/chat/completions) corroborates: "llama.cpp `/completion`-specific features … are also supported."
- **MECHANISM (VERIFIED, `common/chat-auto-parser-generator.cpp`):** with a response_format set, the PEG grammar is **not lazy** (`grammar_lazy = false`) and is compiled over `reasoning_parser + optional ```json fence + schema-forced JSON`. Reasoning is *optional* in the grammar, so a thinking-trained model may still burn tokens on `<think>` before emitting JSON — exactly what P1 measured. Killing thinking is therefore required for small token budgets.
- **The required knob (VERIFIED, source + MEASURED):** per-request `"reasoning_budget_tokens": 0` → server sets reasoning-budget start/end tags and ends thinking immediately; P2/P5/P6 show empty `reasoning_content` and immediate content. `reasoning_effort: "none"` also sets `enable_thinking=false` (source), but this GLM template only renders `low|high|max` and defaults to **max** (`chat_template_caps.supports_reasoning_effect = true`; template source inspected via `/props`), so `reasoning_budget_tokens: 0` is the reliable per-request suppression. `chat_template_kwargs.enable_thinking` is accepted as the strings `"true"`/`"false"` but the GLM template never references it (inspected) — do not rely on it.
- **GBNF correctness trap (MEASURED):** an undefined rule (`ws`) in a hand-written grammar → HTTP 400 `"Failed to initialize samplers: failed to parse grammar"` at request time, not at load time. Validate grammars offline.
- **SSML/phoneme tags: N/A** for this layer (that's TTS; see §3).

**V2 recommendation (decisive):** the intent router should use `/v1/chat/completions` + `response_format: json_schema` (wrapper form) + `reasoning_budget_tokens: 0` + `temperature: 0` + tiny schema (`{"intent": enum, "target": string}`). Schema enforcement is *necessary*, not cosmetic — P3 shows the unconstrained model invents keys. The `<task>`-tag convention from V1 (GLM self-declaring inside the conversation turn) can be replaced or supplemented by this out-of-band classifier call; see §2.

### 1b. Does the constraint change TTFT? — small, but the measurement is cache-confounded

| Probe | Cache state before | first-event | first-content |
|---|---|---|---|
| P2 constrained | foreign ~97K-token prefix (divergent) | 3.02 s | 3.04 s |
| P3 unconstrained | own prompt warm (57 tok) | **0.097 s** | **0.116 s** |
| P5 constrained | tiny foreign prefix (76 tok) | 0.346 s | 0.365 s |
| P6 constrained | foreign ~104K prefix | 2.85 s | 2.87 s |

- Best like-for-like pair (P3 vs P5: same tiny-prompt regime, both near-warm): constraint delta ≈ **0.25 s** → **ESTIMATED** grammar overhead ≤ ~0.3 s for a small schema on a warm cache. (llama.cpp compiles the schema to a GBNF grammar per request; whether identical schemas are cached across requests is **UNVERIFIED**.)
- P2/P4/P6 all landed ~2.9–3.2 s because background clients (OpenCode/curator) kept re-populating the slot with ~100K-token prefixes between probes — this **re-confirms the morning's divergence economics** (3.0–3.4 s) and demonstrates the exact contention a voice router will live in: *every* interleaved small request pays full-prefix eviction/recompute.
- **V2 consequence:** pin one stable classifier prompt (same system+few-shot block every call) so its prefix stays warm → measured warm-classifier TTFT ≈ 0.1–0.4 s. Accept that the first classifier call after any big OpenCode turn pays ~3 s (same for the converse direction: the classifier evicts OpenCode's working set — the §1b table *is* the cache-eviction tax in action).

### 1c. Exactly which constrained-generation params this build supports (from README + source)

- `/v1/chat/completions`: `response_format` (`text` | `json_object` [+`schema`] | `json_schema` [+wrapper]) — DOCUMENTED (README ~line 1449) + VERIFIED (source). Top-level `json_schema` and `grammar` also accepted (source). `reasoning_effort` ("none" disables thinking), `reasoning_budget_tokens` / `thinking_budget_tokens` (0 = immediate end), `reasoning_budget_message`, `chat_template_kwargs` — VERIFIED (source). New in this generation of the server: `reasoning_control` + `/v1/chat/completions/control` (README).
- `/completion`: `grammar`, `json_schema`, all sampling params — DOCUMENTED.
- Version caveats: this build post-dates the server refactor (`tools/server/server-{common,chat,context,…}.cpp`, PEG-native chat parsing — slot `params.chat_format` = `"peg-native"` MEASURED). Grammar triggers/lazy grammars apply to *tool-call* grammars; response-format grammars are eager. Invalid grammar → 400 at request time (DOCUMENTED + MEASURED). `--grammar`/`-j` CLI flags exist server-side but are irrelevant to V2 (per-request only).

---

## 2. Native vs prompt-based routing

Assessed against the explore specialist's VERIFIED/MEASURED API map (`/tmp/opencode/explore-opencode-surface.md`) + opencode.ai/docs/agents (DOCUMENTED corroboration: `default_agent`, primary/subagent modes, per-agent permission rules with allow/ask/deny and last-rule-wins, per-agent model pinning).

### Rides native OpenCode mechanisms (NO Jerry-side classification)

| Voice situation | Native mechanism | Evidence |
|---|---|---|
| Explicit task request ("task: …") | Prompt into dedicated Voice-tasks session; session pinned `agent`+`model` at creation | explore §A.1/§E VERIFIED |
| Mid-task follow-up ("also run the tests") | `delivery:"steer"` into the **already-active** task session — injected at next step boundary, same turn, no abort | explore §B VERIFIED |
| Park a request behind a running task | `delivery:"queue"` + `resume:false` for admit-without-wake | explore §B VERIFIED |
| Task approval / refusal by voice | `permission.asked` → Jerry speaks it → spoken yes/no → existing `replyPermission {once\|always\|reject, message?}` | explore §C VERIFIED; Jerry loop already implemented |
| Agent asks a blocking question | `form.created` → speak question → `POST …/form/:formID/reply` | explore §A.9/§C VERIFIED (unanswered forms self-answer — must handle) |
| "Stop / cancel / never mind" | Barge-in (epoch + abort) for speech; `POST …/interrupt` for the task session; `interrupt?resume=true` resumes steer items only | explore §D VERIFIED |
| "What's the status?" | Per-session durable log `GET /api/experimental/session/{id}/log?after=&follow=true` → announcer | explore §F VERIFIED (MEASURED live) |

Key structural point: **steer/queue/pin/permission are state machines, not intents.** Jerry selects the target from *observable state* (is a task running in the Voice-tasks session?), not from understanding the sentence.

### Residual gaps that DO need Jerry-side classification

1. **Explain-vs-do — MEASURED failure.** P5: "explain how to delete a git branch without losing commits" → `{"intent":"task"}` at temp 0 with a bare classifier prompt. The exact confusion §2 of the mission names is real on this model. Mitigations ranked: (a) explicit spoken prefix ("task:") bypass — already in V1, keep it; (b) few-shot classifier prompt with paired examples (imperative vs "how do I / explain / what is") — REQUIRES IMPLEMENTATION TEST; (c) deterministic lexico-syntactic guard (interrogatives/"how"/"explain"/"what"/"why" → converse unless prefixed) as a cheap pre-filter. **Recommendation: all three; never let the bare-prompt LLM verdict alone authorize destructive task delegation.**
2. **Conversation-vs-task default when no task is active and no prefix** — genuinely ambiguous utterances ("fix the flaky test" vs "why is the test flaky?"). Needs the classifier; fail-open to conversation (V1 rule) remains right because task turns cost the shared slot ~3 s TTFT after divergence (MEASURED, §1b) and mutate shared state.
3. **Meta-utterances** ("actually, scratch that", "wait, first do X") → Jerry-side pending-utterance replacement (latest-utterance-wins) and queue editing; OpenCode's inbox update (steer↔queue, DELETE) is native but *deciding* to use it is Jerry's.
4. **Cost gating.** OpenCode has no notion of llama.cpp slot state; Jerry owns `/slots` visibility and decides when a task turn is worth evicting a warm conversation prefix.
5. **Classifier mechanics are Jerry-side by construction** — OpenCode has no "classify then route" primitive; §1 shows the primitive Jerry would use works on this build.

**Routing shapes (mission items):** (i) plain prompt into task session = native, no classification needed once routed; (ii) `PromptBody.agents:[{name}]` is an **attachment/mention inside one session, not routing** (explore §E VERIFIED) — do not use it as a router; (iii) dedicated pinned session = the correct native home for tasks (create-time `agent`+`model` pinning verified). **Recommendation:** V2 = pinned Voice-tasks session + deterministic prefixes + tiny structured-output classifier for the residual gap, with the explain-vs-do guard as a first-class acceptance test.

---

## 3. Deterministic TTS text normalization

### 3a. What sherpa-onnx Kokoro (v2.0.1) actually does — almost nothing, and it DROPS tokens

- **VERIFIED (k2-fsa issue #4139, opened 2026-10-29 against 2.0.1, still open, with maintainer reply):** since PR #4055 removed espeak-ng, the Kokoro *English* frontend relies on the lexicon alone; "any word that isn't in it is dropped." Reporter's examples: "The budget is 1969 dollars" → "The budget is dollars"; unknown names vanish. "numbers, currency, percentages and unknown names still disappear" (#4075 fixed only punctuation). For an assistant that must say IPs, versions, and paths this is a first-class failure mode, not an edge case.
- **Maintainer's position (VERIFIED, same issue):** numbers/symbols → prefer rule-FST normalization (points at NVIDIA NeMo text-processing as the rule source); OOV → "We ignore OOVs. You may either add OOV entries to `lexicon.txt`, or tokenize the text before feeding it into sherpa-onnx. We prefer not to include a built-in g2p model."
- **Mechanisms that exist in the sherpa Kokoro path (VERIFIED, docs + `offline-tts-kokoro-impl.h`):**
  - `--kokoro-lexicon` accepts **comma-separated lexicon files** → Jerry can ship a *user-extensible override lexicon* (word → IPA tokens) loaded AFTER the stock `lexicon-us-en.txt`. This is the pronunciation-override mechanism (no SSML anywhere in the pipeline; the misaki inline-phoneme syntax `[word](/IPA/)` exists only in Python misaki).
  - `--tts-rule-fsts` accepts OpenFst text-normalization rules (`kaldifst::TextNormalizer`) applied pre-tokenization — the documented hook for number/date/phone expansion (used by the bundled Chinese `number-zh.fst`/`date-zh.fst`/`phone-zh.fst`).
  - `phoneme_codepoints` path: pass pre-phonemized text (issue #4139 reporter uses it).
  - `phonemize` cargo feature (optional `piper-phonemize` 1.5.9, espeak-based) exists in the Rust examples — the GPL escape hatch V1 left open; using it re-introduces the GPL dependency the v2.0.x refactor removed.
- **Canonical Kokoro (misaki, Python) DOES normalize** (spaCy + num2words + optional espeak fallback for OOV — VERIFIED from misaki README), which explains why Python-side Kokoro demos sound fine and the sherpa Rust path doesn't: **the normalization never made it into the Rust frontend.** kokoro-onnx (thewh1teagle, Python) uses espeak-ng (V1 report, consistent).

### 3b. Pocket TTS via sherpa — credible fallback, not the default

- **VERIFIED:** bundles exist in `tts-models` release: `sherpa-onnx-pocket-tts-int8-2026-01-26.tar.bz2` (98.3 MB) and **`sherpa-onnx-pocket-tts-2026-01-26.tar.bz2` (168.1 MB, the fp32 bundle V1 requires — confirmed present)**.
- **VERIFIED (docs + `offline-tts-pocket-impl.h`):** zero-shot voice cloning from a reference clip, no reference transcript needed; `--num-steps` = quality/speed tradeoff; text frontend = `kaldifst` rule FSTs + **SentencePiece tokenizer** (`vocab.json`) — *no lexicon*. Consequences: OOV words degrade to subword tokens rather than being dropped (**ESTIMATED from SP design — REQUIRES IMPLEMENTATION TEST**), but there is **no word→IPA override path**, so fine-grained pronunciation control is *weaker* than Kokoro's lexicon.
- Quality/latency: 71–82 ms TTFA, RTF 23.8% @2 cores (VoxRT benchmark, author-bias caveat — carried from V1); sherpa-vs-Python quality gap root-caused to int8 (#3172, closed; fp32 fixes). English-only in sherpa. HF gating applies to Kyutai's original weights, not the sherpa release tarball (correction to V1's "gated download" caveat — the tarball is a plain GitHub release asset).
- **Verdict:** fallback/upgrade only. English-only + no pronunciation lexicon + cloning-oriented voice = worse fit for a deterministic technical assistant than Kokoro + Jerry lexicon.

### 3c. The Jerry-owned normalization layer (recommended design)

**Requirement honored by construction:** normalization runs at the TTS boundary only (`tts_pipeline.rs`, on the sentence objects queued for synthesis). The text submitted to OpenCode, the conversation history, and persisted transcripts are untouched — one-way transform, never a second copy of truth.

Layers (all deterministic, all unit-testable):
1. **Protected-token extraction:** IPs, version strings, paths, code spans, acronyms → replaced by spoken forms *before* Kokoro sees the text.
   - IPs → "one seven two dot one eight dot zero dot three" (digit-by-digit; never "one hundred seventy-two").
   - Paths/URLs → component speech ("dot config slash opencode slash opencode dot json"), `~` → "home".
   - Versions/identifiers: `v2.4.1` → "v two point four point one"; `Q4_K` → "Q four K"; `GLM-5.3-Flash` → "G L M five point three flash".
   - Acronyms: uppercase runs (≥2, in exception list) → letter-by-letter (JSON, SSH, VAD, TTFT); exception list for things read as words (e.g. "rust", "cargo").
   - Numbers/ordinals/times → words (num2words-equivalent; the misaki/NeMo rule sets are the prior art to port).
2. **User pronunciation lexicon** (`~/.config/nexus/voice/pronunciations.toml`): string→spoken-form replacements (layer 1 escape hatch), and optionally word→IPA entries appended as a second `--kokoro-lexicon` file for words that are spelled right but mispronounced.
3. **Fallback policy:** if a protected-token class is unrecognized, speak it letter-by-letter (never drop — the #4139 failure mode must be impossible by construction for Jerry's output).
Prior art surveyed: no SSML support in any engine in this stack (Kokoro/Pocket/misaki-Rust); phoneme tags exist only as Python misaki syntax or lexicon IPA entries; rule FSTs are the engine-native normalization hook. **REQUIRES IMPLEMENTATION TEST:** whether one combined Rust pass feeding plain text beats maintaining a custom OpenFst rule FST (the FST path is engine-supported but FST authoring tooling in Rust is poor; the maintainer's FST preference is for upstream generalization, not a hard requirement for Jerry).

---

## 4. Pronunciation test corpus (spec only — nothing implemented)

**Design:** fixed YAML/JSON corpus, each item `{id, category, raw, expected_spoken, notes}`. Evaluation = human listening test + **objective round-trip check**: TTS output → Parakeet STT → normalize (lowercase, strip punctuation) → compare against `expected_spoken` (WER per item). Pass criterion per item: every token spoken (zero dropped tokens — the #4139 failure mode), correct digit/letter expansion, round-trip WER ≤ 1 word (0 for IPs/versions). Category pass = ≥90% items; corpus is the P1 "Kokoro lexicon listening test" made concrete. ~10 items/category, drawn from THIS environment:

1. **IP addresses / hosts** (10): `172.18.0.3`, `172.18.0.4`, `127.0.0.1`, `10.0.0.1`, `192.168.1.100`, `0.0.0.0`, `255.255.255.0`, `10.42.0.1`, `1.1.1.1`, `100.64.0.1`. Expected: digit-by-digit, "." → "dot".
2. **Shell commands** (12): `nvidia-smi`, `gdbus`, `busctl`, `pgrep -f`, `pactl`, `cargo build --release`, `git rebase -i HEAD~3`, `docker compose up -d`, `npm run tauri build`, `curl -sSL`, `sha256sum`, `systemctl --user restart pipewire`. Expected: command word-forms ("nvidia S-M-I" → accept "N-V-I-D-I-A smeye"? — pin per-item), flags spelled ("dash s S L").
3. **File paths** (12): `~/.config/opencode/opencode.json`, `~/ai-workbench/projects/NExus/src-tauri/src/sse_pump.rs`, `/home/mg-12623-8/Documents/notes.txt`, `/tmp/opencode/v2-probes.md`, `~/.local/state/opencode/service.json`, `src-tauri/tauri.conf.json`, `docs/SPEC-VOICE.md`, `~/.git-credentials`, `/etc/pipewire/pipewire.conf.d`, `node_modules/.bin/vite`, `~/.local/share/applications/jerry.desktop`, `Cargo.toml`.
4. **Version numbers / build ids** (10): `GLM-5.3-Flash`, `Q4_K`, `v2.2.5`, `0.23.0`, `2.0.1`, `CUDA 12.8`, `cuDNN 9`, `b11889-d854d98ba`, `piper-phonemize 1.5.9`, `97,887 MiB`.
5. **Acronyms** (10): `GLM`, `SSH`, `JSON`, `FTS5`, `VAD`, `EOT`, `TTFT`, `SSE`, `IPC`, `AEC`.
6. **Technical terminology** (10): `sherpa-onnx`, `Kokoro`, `Parakeet`, `Silero`, `rodio`, `cpal`, `ringbuf`, `reqwest`, `zustand`, `Tauri`, `WebKitGTK`, `PipeWire` (12 listed; keep 10–12).
7. **Ordinary conversation** (10): "Hey Jerry, what's on my plate today?", "That worked, thanks.", "Run it again.", "What changed since yesterday?", "Stop.", "Go ahead.", "Never mind.", "Summarize that in one sentence.", "Read me the first paragraph.", "How long did that take?" — control group: no normalization should fire; guards against over-expansion ("stop" must never become "S-T-O-P").

Categories 1–6 exist to fail today (per #4139); category 7 guards regressions. The corpus doubles as the acceptance fixture for §3c's normalizer and for any engine swap (Pocket).

---

## 5. rodio playback-completion semantics — **API RENAMED: `Sink` → `Player` in 0.23**

All claims below VERIFIED from rodio v0.23.0 source (`src/player.rs`, `src/queue.rs`, `src/stream.rs`, tag `v0.23.0`):

- **`Sink` no longer exists in 0.23.** Crate root exports `Player` (`pub use crate::player::Player`); SPEC-VOICE V1's "rodio 0.23 `Sink::stop()`" is stale naming (Sink lived through 0.22.x). API surface otherwise equivalent: `append`, `clear`, `skip_one`, `stop`, `detach`, `sleep_until_end`, `empty`, `len`, `try_seek`, `pause`/`play`.
- **`len()` / `empty()`** = `sound_count` atomic: incremented at `append()` (enqueue), decremented by the `Done` wrapper **when the source is exhausted** (last sample *pulled by the mixer*) — **NOT when the last sample reaches the DAC**. `empty()` is literally `len()==0`.
- **`append()` after `stop()` is SAFE in 0.23** (V1's known-race concern is fixed by construction): `Player::new()` creates the queue with `keep_alive_if_empty=true`; on append, if `stopped` is set the player drains (`sleep_until_end` if sounds remain), clears `stopped`, and proceeds. No dropped clip, no closed stream.
- **`stop()` latency:** sets `controls.stopped`; each playing source polls the flag via `periodic_access(Duration::from_millis(5))` → source stops within ≤~5 ms of playback time. **But** rodio documents that samples already in the OS buffer cannot be retracted: "We can not change a sample already in the OS buffer. That means there is a minimum delay (latency) of `<buffer size>/<sample_rate×channels>` before a change made through rodio takes effect." Default output buffer: module doc says ~100 ms, the code computes **50 ms** (`sample_rate/(1000/50)` frames, rounded to a multiple of two) — a docs/code discrepancy worth flagging upstream. **V1's "<5 ms audible barge-in" claim must be corrected: <5 ms is the rodio-side stop; the audible tail persists up to ~50–100 ms.** Configurable lower via `DeviceSinkBuilder::with_buffer_size` (underrun risk documented).
- **Reliable "this clip finished audibly" pattern:** per-clip `append_with_signal()` receiver (fires when that source is exhausted — rodio's own `callback_on_end` example pattern) **+ a fixed drain pad ≈ one output-buffer duration (≥50 ms)** before marking the sentence "heard". `sleep_until_end()` is one-shot and tracks only the *last* appended clip (the receiver is overwritten per append) — do not use it for per-clip tracking. **REQUIRES IMPLEMENTATION TEST:** actual buffer latency and Done→silence delta on the target machine (measure `stop()` → audible end with a tone).
- **`try_seek`:** blocks 0–5 ms, saturates at end; errors if the source can't seek. Irrelevant for sentence clips but safe.
- **Beyond rodio:** the only buffering between rodio and the DAC is cpal's device buffer (rodio's mixer feeds it directly); the 50 ms default above IS that buffer. No hidden second queue.

---

## 6. `/slots` field semantics — cross-check vs upstream README

Build `b11889-d854d98ba`, single slot. MEASURED snapshot (`/tmp/opencode/slots-snapshot.json`) vs README "GET /slots" section:

| Field | Live build | README example | Verdict |
|---|---|---|---|
| `id`, `n_ctx`, `speculative`, `is_processing`, `id_task` | ✓ | ✓ | matches (README documents `id_task`, `is_processing`) |
| `params.*` (samplers, chat_format, reasoning_format, generation_prompt, …) | ✓ incl. `adaptive_target`/`adaptive_decay` (PR #17927), `top_n_sigma`, `xtc`, DRY | ✓ minus `adaptive_*` | README example slightly stale vs build; build is newer. `chat_format:"peg-native"` confirms the PEG-parser generation |
| `next_token[0].{n_decoded, n_remain, has_next_token, has_new_line}` | ✓ | ✓ | matches; `n_decoded` = tokens decoded for the CURRENT task (matches morning evidence) |
| **`n_prompt_tokens`, `n_prompt_tokens_processed`, `n_prompt_tokens_cache`** | ✓ (slot-level, live) | **✗ absent from README example** | ** undocumented-but-real in this build.** `n_prompt_tokens` = retained prefix size of the last task (KV persists across requests — observed 41K→49K→76K→97K→103K as foreign clients ran); `n_prompt_tokens_cache` = served-from-cache portion |

- No upstream doc *contradicts* measured behavior found. `/health` semantics confirmed: 200 = "model loaded and ready" — **it is not a busy flag** (README never claims it is; V1's reading was the error).
- Fields/knobs V2's concurrency design should use:
  - `is_processing` + retry loop (morning caveat: `/slots` hiccuped ~3 s once under contention) — confirmed correct busy gate.
  - `n_prompt_tokens` as a **cache-warmth telemetry**: lets the voice orchestrator *predict* TTFT class (small retained prefix ≈ warm ≈ 0.1–0.8 s; large foreign prefix ≈ divergent ≈ ~3 s) and decide whether a conversational reply is worth evicting a big working set. This turns the morning's one-off finding into a runtime signal.
  - `?fail_on_no_slot=1` → 503 instead of queueing (DOCUMENTED) — a cheap non-blocking pre-check before firing voice turns.
  - `POST /slots/{id}?action=save|restore|erase` (DOCUMENTED) — manual KV persistence exists, but `--cache-ram` (default 8192 MiB) + `--cache-idle-slots` (default enabled) already do this automatically; only relevant as an advanced escape hatch. Note: a 100K+-token GLM KV likely exceeds the 8 GB RAM cache → evicted prefixes may be recomputed, consistent with the measured 3 s divergence cost. (ESTIMATED arithmetic, not measured.)
  - `/metrics` `llamacpp:n_busy_slots_per_decode` exists but requires `--metrics` (not enabled here) — ignore for V2.

---

## 7. Smart Turn / VAD deferral — cost of deferring to P2 (short, per instructions)

- Third-party benchmark (Evalgent harness, 2026, sweep over threshold/min-silence/timeout per model): **false cut-offs at 300 ms silence: Smart Turn v3.2 35.2%, LiveKit v1 9.9%, Deepgram Flux 12.9%; at 600 ms: Smart Turn 14.8%, LiveKit 4.5%.** Latency to reach ≤5% false cuts: Smart Turn ~1051 ms, LiveKit ~543 ms; OpenAI semantic VAD reached no cutoffs but ~1143 ms at 5%. (DOCUMENTED benchmark; methodology and domain caveats apply — Smart Turn looks materially worse than LiveKit's text-based detector here, worth knowing before P2 tuning expectations.)
- Industry consensus (Deepgram/AssemblyAI/Cerebrium write-ups): fixed-silence timers trade latency vs mid-turn fragmentation directly; 200–400 ms of an ~800 ms perceived-latency budget goes to endpointing; no standard "acceptable" false-cut rate exists — build a baseline and track it. An arXiv study (2609.11066) adds nuance: prosody+silence alone reach F1 0.93 / 7.8% FA at 400 ms — semantic text adds little there.
- **Cost of P1-without-Smart-Turn (V2 decision input):** with V1's balanced 1200 ms fixed-silence profile, expected false-cut is below the benchmark's 5%-at-1051 ms operating point (**ESTIMATED**), at the price of ~1.2 s added dead air; Smart Turn's CPU cost (10–65 ms MEASURED) is negligible, so deferring it buys *tuning risk reduction*, not compute savings. Silero-VAD-only end-of-silence has no published false-trigger rate; treat as UNVERIFIED, covered by the EOT decision-log JSONL V1 already specifies. Verdict: deferral is defensible; keep the >8 s truncation policy and the aggressiveness profile in the spec so P2 lands on logged data.

---

## Top 10 findings

| # | Finding | Label | V2 impact |
|---|---|---|---|
| 1 | Structured output WORKS on this build: `response_format: json_schema` (wrapper form accepted) + `reasoning_budget_tokens: 0` + temp 0 → schema-conformant, deterministic (P2==P6); unconstrained GLM invents its own keys (P3) | MEASURED | Intent router is feasible; schema is mandatory, not cosmetic |
| 2 | With default thinking (template renders "Reasoning Effort: Max"), a 40-token budget is consumed entirely by `reasoning_content` — content empty (P1). `reasoning_budget_tokens: 0` is the reliable per-request kill switch; `chat_template_kwargs.enable_thinking` is a no-op for this template | MEASURED+VERIFIED | ALL short voice LLM calls must set it, conversation path included |
| 3 | GLM itself misclassifies "explain how to delete X" as `task` (P5) — the explain-vs-do hazard is real at temp 0 | MEASURED | Keep "task:" prefix convention + few-shot classifier + deterministic guard; never LLM-verdict-alone for destructive delegation |
| 4 | Grammar overhead ≈ 0.25 s TTFT on warm cache (P5 vs P3); the ~3 s hits were foreign-~100K-prefix divergence, reproduced 3× during probes | MEASURED (confounded, bounded) | Pin a stable classifier prompt; accept ~3 s first-classifier-call after big OpenCode turns |
| 5 | sherpa-onnx 2.0.1 Kokoro English frontend is lexicon-only and DROPS numbers/currency/OOV ("1969 dollars"→"dollars"); maintainer: add lexicon entries or pre-tokenize; rule FSTs = sanctioned normalization hook; no SSML anywhere | VERIFIED (issue #4139) | Jerry must own a deterministic pre-TTS normalizer + user pronunciation lexicon — exactly §3c |
| 6 | rodio 0.23 renamed `Sink`→`Player`; append-after-stop safe (keep-alive queue); `len()==0` = mixer pulled last sample ≠ audible end; OS buffer ~50 ms (code) vs 100 ms (doc) cannot be retracted by `stop()` | VERIFIED (v0.23.0 source) | V1 §4 correction: barge-in audible tail ~50–100 ms; "heard" = Done receiver + ≥50 ms pad |
| 7 | `/slots` exposes undocumented `n_prompt_tokens*` cache fields in this build → runtime cache-warmth telemetry for TTFT-class prediction; `?fail_on_no_slot=1` = clean busy check; README example is stale (no contradictions found) | MEASURED vs DOCUMENTED | Concurrency gate + eviction-aware scheduling |
| 8 | OpenCode natively covers steering/queueing, session pinning, permission reply, forms, interrupt-with-resume; routing decisions left to Jerry are exactly: explain-vs-do, converse-vs-task default, meta-utterances, cost gating | VERIFIED (explore + docs) | Native-first routing table in §2; `PromptBody.agents` is an attachment, NOT a router |
| 9 | Pocket TTS: fp32 bundle confirmed in release assets; text path = rule FSTs + SentencePiece (no lexicon → weaker pronunciation control, OOV→subwords ESTIMATED); English-only; HF gating does not apply to the sherpa tarball | VERIFIED (+1 ESTIMATED) | Kokoro+lexicon stays default; Pocket fallback stands |
| 10 | Smart Turn v3.2 third-party eval: 35.2% false-cut @300 ms / 14.8% @600 ms (worse than LiveKit v1 9.9%/4.5%); fixed-silence 1200 ms profile ≈ ≤5% false-cut ESTIMATED | DOCUMENTED | P1-without-Smart-Turn deferral is defensible; keep EOT decision log for P2 tuning |

**Probe accounting:** 6 full generation probes (P1–P6) + 1 one-token grammar-validation request (during the P4 400-debug; disclosed). All probes ≤40 tokens, temp 0, /slots-idle wait honored, never parallel. Raw log: `/tmp/opencode/probe-results.jsonl`.
