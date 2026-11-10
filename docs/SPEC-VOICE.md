# SPEC-VOICE V2: Revised Architecture Proposal

**Status:** APPROVE WITH CONDITIONS — reviewer #2 verdict applied; all 5 blocking conditions fixed in this draft (§16). Awaiting operator approval. Research/design only — nothing implemented, no config changed, no dependency added, no model downloaded.
**Date:** 2026-11-09 · **Pipeline:** explore (OpenCode surface) → probes (live llama.cpp/OpenCode measurements) → researcher (verification pass) → architect (this document) → reviewer #2 (pending).
**Supersedes:** SPEC-VOICE V1. **V1 is preserved verbatim at `docs/SPEC-VOICE-V1.md`** (adoption step: `git mv docs/SPEC-VOICE.md docs/SPEC-VOICE-V1.md` when this draft is approved; V1's research appendices remain valid evidence files).
**Evidence files (V2):** `docs/research/2026-11-09-voice-v2-probes.md` (live MEASURED), `docs/research/2026-11-09-voice-v2-opencode-api.md` (OpenCode v2.2.5 API), `docs/research/2026-11-09-voice-v2-verification.md` (structured output / TTS / rodio / /slots verification). V1-era: `docs/research/2026-11-09-voice-stack-research.md`, `~/Documents/voice-mode-research-report.md`.

**Proof-label vocabulary** (defined formally in §15; used on every claim below):

| Label | Meaning |
|---|---|
| MEASURED | Live probe on **this machine, this build**, today, with the probe preserved |
| VERIFIED | Read from primary source code / API of the exact pinned version |
| DOCUMENTED | Official docs of the pinned version (no source read) |
| BENCHMARK | Third-party measurement on **other hardware/software path** — indicative, not local |
| ESTIMATED | Derived arithmetic from labeled inputs — not observed |
| UNVERIFIED | Asserted without evidence; treat as hypothesis |
| REQUIRES IMPLEMENTATION TEST | Can only be settled by building it; test procedure defined in §15 |

---

## 1. Executive Summary

**Recommended architecture: Option A′ — a native Rust voice engine inside Jerry's `src-tauri`, with a direct-GLM conversation path whose single per-turn call is schema-structured, and with ALL task execution delegated to a dedicated, pinned OpenCode "Voice tasks" session using only native OpenCode mechanisms** (create-time agent/model pinning, prompt delivery steer/queue, the existing permission ask/reply loop Jerry already implements, and the per-session durable log endpoint for announcements).

The four V2-corrective decisions, each driven by measurement:

1. **The `<task>` marker is abolished.** V1 asked GLM to self-declare tasks inside a freeform reply with a string-matching convention. V2 fuses routing into the single conversation turn via `response_format: json_schema` + `reasoning_budget_tokens: 0` — MEASURED working on this exact build (schema-conformant, deterministic at temp 0, ~0.25 s warm grammar overhead), with a deterministic lexico-syntactic guard that can override the model's routing verdict, and spoken confirmation gates for destructive/privileged classes. GLM at temp 0 MEASURED misclassifying "explain how to delete a git branch" as a task — the guard, not the prompt, is the control.
2. **The concurrency gate moves from `/health` to `/slots`.** `/health` returned 200 while the slot was mid-generation (MEASURED) — V1's design was broken as written. `/slots` provides `is_processing`, `?fail_on_no_slot=1` (503 instead of queueing), and undocumented cache-warmth fields (`n_prompt_tokens*`) that let Jerry predict TTFT class before spending the slot.
3. **The latency model is re-grounded and honestly worse.** Warm-cache TTFT 0.21–0.8 s and divergent-after-~150K-prefix TTFT 3.0–3.4 s are MEASURED. With the balanced 1200 ms end-of-turn silence, expected speech-stop → first-audio median is **≈2.5–3.2 s** (ESTIMATED composite; V1's 1.3–2.2 s assumed sub-balanced EOT and grammar-free TTFT). After heavy OpenCode coding turns, the first voice reply pays the measured ~3 s divergence tax. ChatGPT-Voice comparisons are dropped entirely per the V2 mandate.
4. **The resource model is rewritten around contention, not capacity.** GLM occupies all three RTX PRO 6000 (70–75 GiB of 97,887 MiB each — MEASURED); V1's "GPU 0 with headroom on GPU 1/2" is dead. Voice runs CPU-only. The binding constraints are CPU thread/memory-bandwidth contention with llama-server's host-side work and the single shared llama.cpp slot — not VRAM.

Barge-in is specified as five separately measurable stages (physical onset → VAD detect → cancel request → audible stop → slot free), with the rodio corrections folded in: `Sink` is now `Player` (0.23 rename, VERIFIED), rodio-side stop is ≤5 ms but the audible tail persists ~50–100 ms (OS output buffer cannot be retracted), and "heard" means a per-clip `Done` receiver plus a ≥50 ms pad — not `len()==0`.

Roadmap: **P0 dictation (sherpa-only, single ONNX runtime) → P1 live MVP + minimal safe task delegation → P2 natural routing + Smart Turn + speaker mode → P3 advanced.** Smart Turn is deferred to P2 (defensible on the third-party 35.2%-false-cut@300 ms evidence) — which also moves the dual-ONNX-runtime coexistence question out of P0 entirely. V1's claim that coexistence was "proven in the P0 AppImage spike" is **FALSE as written** (git history contains zero spike artifacts; §15 audits every V1 proof label) and is relabeled REQUIRES IMPLEMENTATION TEST with a defined procedure.

**Strongest alternative:** Option B (all voice turns through OpenCode sessions) — genuinely simpler to maintain and it makes history ownership uniform — but it is **falsified on this build by a measured parameter-control gap**: OpenCode cannot set per-request `reasoning_budget_tokens`, and with GLM's template defaulting to max reasoning effort, a small-token conversational turn burns its entire budget on thinking and returns empty content (MEASURED, probe P1). §3 scores all options across the ten required dimensions.

---

## 2. Revised Recommended Architecture

### 2.1 One-paragraph statement

Jerry hosts the full voice DSP stack as Rust modules in `src-tauri` (capture `cpal` → SPSC `ringbuf` → VAD/EOT → STT → orchestrator state machine → TTS → playback `rodio::Player`), all CPU. Conversation turns go from Jerry **directly** to llama-server (`/v1/chat/completions`, SSE, loopback-asserted) as **one schema-structured call per turn**. Anything that must *act* goes to a dedicated OpenCode session created with pinned `agent` + `model`, addressed with native prompt delivery (`steer`/`queue`), gated by OpenCode's own permission engine, and narrated from that session's durable log endpoint. Voice never config-changes llama.cpp or OpenCode, never preempts the slot, and structurally cannot execute anything outside OpenCode.

### 2.2 Diagram (single Jerry process)

```
┌────────────────────────────── Jerry (single AppImage process) ─────────────────────────────┐
│  OS audio thread              std thread "voice-dsp"            tokio runtime (existing)   │
│ ┌────────────────┐ SPSC ring ┌─────────────────────────┐  ┌──────────────────────────────┐ │
│ │ cpal input     │──ringbuf──▶│ Silero VAD (sherpa,CPU) │  │ voice_orchestrator           │ │
│ │ 16kHz mono f32 │            │ RMS level meter         │  │  turn state machine          │ │
│ └────────────────┘            │ utterance accumulator   │  │  SINGLE WRITER to Player;    │ │
│        ▲ hotplug poll 2s      └──────────┬──────────────┘  │  owns epoch; bump =          │ │
│        │                                 │ AudioEvent       │  interruption only           │ │
│        │                                 └─(mpsc)▶ ┌────────┴───┐ ┌──────────┐ ┌─────────┐ │
│        │                                          │ EOT ladder │ │ STT      │ │ voice_  │ │
│        │                                          │ (fixed-    │ │ Parakeet │ │ llm.rs  │ │
│        │                                          │  silence   │ │ int8 CPU │ │ SSE +   │ │
│        │                                          │  P1)       │ │ sherpa   │ │ json_   │ │
│        │                                          └────────────┘ └──────────┘ │ schema  │ │
│        │   ┌───────────────────────┐  ┌────────────────────────┐                  └────┬────┘ │
│        │   │ rodio::Player         │◀─│ tts_pipeline           │◀── sentences ──────────┘      │
│        │   │ (sentence clips,      │  │ normalizer (determin-  │   (mpsc; enqueue validated    │
│        └──▶│  per-clip Done recv)  │  │  istic, TTS-input only)│   by epoch; single writer)    │
│            └──────────┬────────────┘  └────────────────────────┘                               │
│                       ▼ stop() = barge-in        ┌─────────────────────────────────────────┐  │
│         speaker/headphone out                    │ opencode_bridge                         │  │
│                                                  │  Voice-tasks session: pinned create,    │  │
│                                                  │  prompt(steer|queue), interrupt?resume, │  │
│                                                  │  per-session log follower → announcer,  │  │
│                                                  │  permission.asked → speak → replyPermission, │
│  ipc::Channel<VoiceFrame> ─▶ React voice store   │  form.created → speak → form reply      │  │
│  (zustand reducer; vitest-tested)                └─────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
External: llama-server (3×GPU, --parallel 1, ONE slot) ◀── voice conversation turns + OpenCode turns
          OpenCode service ◀── ALL voice task execution (Voice-tasks session)
```

### 2.3 The fused structured turn (replaces `<task>`)

Every conversational turn is **one** GLM call:

- Endpoint `/v1/chat/completions`, SSE stream, loopback URL asserted (reqwest built without TLS — a feature).
- Params: `response_format: json_schema` (wrapper form — VERIFIED accepted by this build's source), `reasoning_budget_tokens: 0` (MEASURED required — otherwise thinking consumes the whole small budget and content comes back empty), `temperature 0.7`, `max_tokens 320` initial — sized from the wrapper floor: the schema-forced `task` object plus JSON framing costs ~25–30 tokens on every turn (ESTIMATED recount), leaving ~290 for reply + `task.prompt`; the budget is re-sized in P1 from a MEASURED decode rate (added to T3) with 320–400 as the working range. Delegation turns are the most truncation-prone (the model writes `task.prompt` into the same budget). Probes validated schema turns at 40 tokens; 200+-token schema turns are UNMEASURED until P1 — T3/T6 cover them.
- Schema (grammar-safe: no unions, flat object; `reply` listed first so a truncated stream still yields the reply text — REQUIRES IMPLEMENTATION TEST that grammar emission follows schema property order):

```json
{"name":"voice_turn","strict":true,"schema":{
  "type":"object","additionalProperties":false,"required":["reply","task"],
  "properties":{
    "reply":{"type":"string","maxLength":800},
    "task":{"type":"object","additionalProperties":false,
            "required":["requested","kind","prompt","target"],
            "properties":{
              "requested":{"type":"boolean"},
              "kind":{"type":"string","enum":["none","read_only","coding","destructive","privileged"]},
              "prompt":{"type":"string"},
              "target":{"type":"string"}}}}}}
```

- Orchestrator handling (§7 has the full ladder): `task.requested=false` → speak `reply`. `requested=true` → run the deterministic guard (§7.2); guard-vetoed → speak `reply` (+ optional offer to run it as a task); guard-passed + `kind ∈ {read_only, coding}` → delegate + speak; `kind ∈ {destructive, privileged}` → spoken echo-confirmation gate (§7.4) before any delegation. `requested=true, kind="none"` (the grammar permits the combo) → treat as conversation + log the anomaly (m12).
- **Truncation salvage (C4).** The SSE delta stream is parsed incrementally. On `finish_reason=length` (or stream end mid-JSON): if the `reply` string is complete and closed, it is spoken and routing **fails open to conversation** (the task object never arrived → no delegation; anomaly logged) — consistent with the fail-open doctrine; if the reply string itself is incomplete, ONE automatic retry fires at `max_tokens 400` freeform (no schema; style cost bounded by the failed turn's length); if that also fails, Jerry speaks an explicit "I didn't catch that." Silent whole-turn loss is never an acceptable outcome.
- The system prompt carries: spoken-register guidance, the rolling voice history, and a one-line live task-state summary (§9.3).

Why one fused call instead of V1's marker or a separate classifier call:

| Design | GLM calls/turn | Failure mode | Evidence |
|---|---|---|---|
| V1 `<task>` in-band marker | 1 | Prose leakage, truncated tag, document-content spoofing; strict regex is a workaround, not a guarantee | V1 reviewer MINOR-1; fragile by construction |
| Separate out-of-band classifier + reply call | 2 | Second tiny call diverges the cache after any big OpenCode turn → +~3 s per ambiguous turn (MEASURED divergence economics); extra eviction of the working set | researcher §1b: every interleaved small request paid 2.9–3.2 s under contention |
| **Fused schema turn (V2)** | 1 | Schema conformity is grammar-guaranteed (MEASURED conformant; byte-identical determinism at temp 0 — MEASURED on a single fixture pair); style-stiffening risk bounded by A/B test (T6, §15) | MEASURED P2/P5/P6 (40-token probes; 200+-token schema turns UNMEASURED → T3/T6) |

### 2.4 Component decisions carried from V1 (unchanged and re-affirmed)

- Capture: `cpal` 0.18.2, 16 kHz mono f32, SPSC `ringbuf` 0.6, RT callback does nothing but push frames; `rubato` 5.0.1 resamples when the device native rate ≠ 16 kHz (BT HFP devices cannot be assumed 16 kHz — carried from V1 §2.5, reinstated). WebKitGTK `getUserMedia` remains non-viable (media-stream disabled, no supported Tauri toggle — VERIFIED).
- STT: Parakeet TDT 0.6B v3 int8 via `sherpa-onnx` 2.0.1 (simulate-streaming), CPU.
- TTS: Kokoro-82M int8 via sherpa, sentence-chunked, **with a Jerry-owned deterministic normalizer** (§12.3 — this is new and mandatory; the sherpa Kokoro English frontend DROPS numbers/currency/OOV — VERIFIED upstream issue #4139).
- Playback: `rodio` 0.23 `Player` (not `Sink` — renamed), raw PCM, single-writer enqueue, per-clip `append_with_signal()` Done receivers.
- Voice threads: every ONNX session created with `num_threads 2–4`, spin-wait disabled where exposed.
- Frontend: `ipc::Channel<VoiceFrame>` → zustand reducer; no `app.emit()`; no webview audio graph.

### 2.5 What V2 deliberately does NOT change (V1 findings that survive verification)

espeak-ng/piper-phonemize removal in sherpa v2.0.x (GPL-free, VERIFIED); Pocket TTS fp32-only fallback (int8 bundle disqualified by upstream #3172, VERIFIED); Silero VAD v6.2.3; Smart Turn >8 s truncation policy; PipeWire `module-echo-cancel` as the speaker-mode AEC (system-level, zero app code); model storage under `~/.local/share/nexus/voice/models/` with sha256-pinned downloads; supply-chain pinning of `sherpa-onnx-sys` build-time archive fetch (`SHERPA_ONNX_ARCHIVE_DIR`).

---

## 3. Alternative Architecture Comparison

The evaluator's mandate: compare Option A (direct GLM + OpenCode delegation), Option B (OpenCode-native voice sessions), Option C (shared conversation abstraction with distinct adapters) across ten dimensions, using measured evidence. The measured anchors: warm OpenCode turn first-text-delta 0.41 s ≈ warm direct TTFB 0.21–0.8 s — **per-turn agent-loop overhead is NOT the differentiator**; the real differentiators are cache-divergence economics (3.0–3.4 s MEASURED) and history/permission/parameter ownership.

| Dimension | A′ (direct GLM conversation + OpenCode delegation) | B (all voice turns through OpenCode) | C (shared abstraction, two adapters) |
|---|---|---|---|
| **Warm latency** | TTFB 0.21–0.8 s MEASURED + ~0.25 s grammar ESTIMATE | First text delta 0.41 s warm MEASURED — parity; fresh session 4.75 s MEASURED when the Voice session is (re)created | Same as whichever adapter serves the turn |
| **Divergent TTFT after OpenCode coding turns** | Voice prefix is small (system + ≤12 turns, EST ~1–3K tokens) → re-warm is warm-class (~0.2–0.8 s MEASURED class) | Voice-session prefix includes OpenCode instructions + full session history → grows unboundedly until compaction; re-warm cost grows with it | Same as A′ |
| **Per-request parameter control** | **Full** (reasoning_budget_tokens 0, temp, max_tokens per call) | **None** — OpenCode owns provider calls; sampling params are global config, agents pin model only (VERIFIED, explore §E); GLM template defaults to max reasoning effort → small conversational turns return empty content (MEASURED P1) | Only if the abstraction leaks params — it will |
| **KV-cache behavior** | Two prefixes; the CONVERSATION prefix stays small (system + ≤12 turns) → cheap re-warm; voice turns short (max_tokens 320) bound eviction cost. Honest symmetry: A′'s Voice-tasks session also accumulates task history unboundedly with the same compaction economics as B (§9.4) — the differentiator is the small conversation prefix, not an absence of growing prefixes | Same single slot; voice-session prefix includes instructions + full history and grows until compaction; compaction turns are large slot consumers | Same as A′ |
| **Session consistency** | Two homes by design (voice thread ≠ task session) — see §9 coherence rules | One home; conversational and task registers mixed in one history | Abstraction over homes; same split as A′ |
| **Agent integration** | Delegation only, via native pinning/steer/queue (VERIFIED sufficient) | Native and automatic — every turn is an agent turn | Same as A′ |
| **Tool access** | Conversation path structurally toolless (no `tools` param) — **execution only via OpenCode** | Conversation turns can call tools mid-chat (feature, but widens the execution surface for chit-chat) | Same as A′ |
| **Permission enforcement** | All execution behind OpenCode's permission engine; conversation cannot act by construction; voice replies to `permission.asked` via the existing `replyPermission` loop (Jerry already implements it) | Same engine, larger trigger surface | Same as A′ |
| **Implementation complexity** | Two pathways: `voice_llm.rs` on the proven `sse_pump.rs` pattern + a thin bridge to client.ts wrappers (several unwrapped but VERIFIED endpoints) | One pathway, but TTS sentence-chunking must parse agent-loop event shapes; every conversational turn needs inbox/interrupt handling | A′ + an indirection layer paid before a third adapter exists |
| **Reliability (voice availability)** | Conversation needs only llama-server up; dictation needs nothing; OpenCode outage degrades tasks only | OpenCode outage kills ALL voice conversation; every reply crosses the agent loop | Same as A′ |
| **Maintainability** | Moderate: one custom client to keep aligned with llama.cpp API | Best: nothing custom | Worst until a third adapter justifies it |

**Verdict: A′.** The decisive dimension is parameter control: `reasoning_budget_tokens: 0` is MEASURED mandatory for short calls on this build, and only the direct path can set it per request. Two secondary deciders: the toolless conversation path makes "spoken instruction can never bypass OpenCode permissions" true by construction rather than by policy, and heard-content history control (§8.4) is only possible when Jerry owns the conversation history.

**What would falsify A′:**
1. OpenCode adds per-session/per-request sampling overrides (reasoning budget) → B's decisive flaw disappears; re-score.
2. P1 measurement shows the direct-path client is a recurring defect source (stream parsing, abort races) exceeding the agent-loop coupling cost B would pay.
3. Fused-schema replies measurably degrade spoken quality vs freeform (test T6 fails its acceptance) → fall back to freeform conversation turn + separate pinned-prefix classifier call for the residual ambiguous set only, accepting the +1-call tax on those turns.

Option C is explicitly deferred, not rejected: if P2 evidence shows the direct/OpenCode split leaking into unrelated modules, extract the abstraction then (rule of three). V1's other rejected alternatives (Pipecat/HF-s2s Python sidecar, Kyutai moshi-server, separate voice daemon, webview capture/playback, Ten VAD, LiveKit detector, Voxtral, Moshi, piper1-gpl, Qwen3-TTS, Linnet) remain rejected for the V1 reasons, re-verified where V2 evidence touches them (Pocket: fp32 bundle confirmed present, 168.1 MB — VERIFIED; HF gating does not apply to the sherpa release tarball — VERIFIED).

---

## 4. Updated Technology Decisions

| Component | V1 position | V2 decision | Driver |
|---|---|---|---|
| LLM conversation path | Direct SSE + `<task>` marker | Direct SSE + **fused json_schema turn** + `reasoning_budget_tokens: 0` | MEASURED: schema conformity + thinking suppression; marker fragility |
| Routing | GLM self-declaration, regex-parsed | Ladder + deterministic guard + fused schema + native OpenCode state machines | MEASURED explain-vs-do misclassification (P5); VERIFIED native steer/queue/pin surface |
| Busy detection | `/health` slot polling | **`/slots`** (`is_processing`, `?fail_on_no_slot=1`, cache-warmth fields) with retry loop | MEASURED: `/health` 200-while-busy; `/slots` hiccup → retry required |
| EOT | Silero + Smart Turn v3.2 in P1 | Silero + **fixed-silence 1200 ms in P1; Smart Turn deferred to P2** behind the dual-runtime gate | DOCUMENTED third-party eval: Smart Turn 35.2% false-cut @300 ms vs fixed-silence ≈≤5% ESTIMATED; deferral buys tuning-risk reduction, costs ~0.8–1.0 s dead air |
| Dual ONNX runtime (sherpa static + `ort` dylib) | "Proven in P0 spike" | **UNVERIFIED → REQUIRES IMPLEMENTATION TEST (T1); moved to P2 entry gate** — P0/P1 are sherpa-only | Audit: git history has zero spike artifacts (verified this session); Smart Turn deferral removes `ort` from P0/P1 |
| Playback | rodio 0.23 `Sink::stop()`, "<5 ms barge-in", sink-empty = heard | rodio 0.23 **`Player`**; audible stop = stop + ~50–100 ms OS-buffer tail; heard = per-clip Done receiver + ≥50 ms pad | VERIFIED v0.23.0 source (rename; `len()==0` = mixer pull, not audible end; buffer 50 ms code vs 100 ms doc) |
| TTS normalization | Spelled-out-numbers system-prompt rule | **Jerry-owned deterministic pre-TTS normalizer + user lexicon** (§12.3); prompt rule demoted to optional | VERIFIED issue #4139: lexicon-only frontend drops numbers/currency/OOV |
| Task delegation timing | P2 | **Minimal safe delegation in P1** (explicit prefix + non-destructive schema tasks + confirmation gates); natural-language routing tuned in P2 | VERIFIED native surface makes it small; mission headline feature |
| GPU Whisper STT option (P2) | "Contention structurally low" | **Dropped from roadmap** (revisit only as a P3 experiment with explicit operator approval) | MEASURED GPU topology: no VRAM voice can safely claim (§5) |
| Task queue (Jerry-side one-deep) | Jerry-owned queue | **OpenCode native inbox** (`delivery:"queue"`, durable, manageable via inbox list/update/delete — wrapper additions) | VERIFIED durable inbox semantics; less Jerry state to drift |
| Announcer transport | Global `session.execution.*` subscription | **Per-session durable log** `GET /api/experimental/session/{id}/log?after=&follow=true` for the Voice-tasks session; global `?types=`-filtered stream kept as fallback | VERIFIED durable/replayable/attribution-exact; global stream is volatile (4096-event overflow) |
| Voice process model | In-process | In-process, unchanged, **plus fault-isolation discipline** (§17 R9): panic-catching task boundaries, watchdog re-init, fault-injection test in P0 | Evaluator re-check; V1's rejection reasons still outweigh a daemon |

---

## 5. Verified Hardware Assumptions

All MEASURED today (nvidia-smi + docker inspect; probe file preserved):

| Fact | Value |
|---|---|
| GPUs | 3× NVIDIA RTX PRO 6000 Blackwell Max-Q, 97,887 MiB each |
| llama-server occupancy | GPU 0: 70,376 MiB · GPU 1: 74,728 MiB · GPU 2: 73,058 MiB (+ gnome-remote-desktop 560+739 MiB) |
| Unallocated (today) | ≈ 27.5 / 23.2 / 24.8 GiB per GPU — **not reservable for voice** (below) |
| Weights | GLM-5.3-Flash Q4_K, 2 shards = 169 GB + 623 MB mmproj |
| Serving | `--ctx-size 1048576 --n-gpu-layers 99 --parallel 1 --flash-attn on`; `total_slots: 1`; fingerprint `b11889-d854d98ba` |
| Idle GPU util | 27–39% (background GLM clients: curator/memory-distill plugins, probes) |
| Container | `glm-server`, `ghcr.io/ggml-org/llama.cpp:server-cuda13`, models mounted from `~/ai-workbench/models/glm-cache` |

**Corrected resource doctrine.** V1 claimed "GLM on GPU 0, headroom on GPU 1/2". Dead. The corrected statement is more precise than "no spare VRAM": 22–27 GiB per GPU is unallocated *today*, but (a) it is the growth space for a 1M-token-context KV cache and llama.cpp compute buffers — claiming any of it risks OOM-killing GLM mid-task, which is exactly "making OpenCode less reliable"; (b) prompt-processing bursts spike VRAM transiently; (c) voice needs zero VRAM to hit its latency targets on CPU. **CPU-only voice stack is a reliability decision, not a capacity impossibility.** GPU-resident voice models (e.g. Whisper-turbo STT) are dropped from the roadmap.

**The real contention surfaces (this is what the resource section is now about):**

| Surface | Mechanism | V2 posture |
|---|---|---|
| **The single llama.cpp slot** | Every token-generating client — OpenCode sessions, curator plugin, ad-hoc probes, voice — serializes through one FIFO slot | Voice fires only on observed-idle (`/slots`), defers when busy, keeps turns short (max_tokens 320). §10 |
| **KV cache eviction** | Any divergent prompt evicts/recomputes: 3.0–3.4 s TTFT MEASURED after ~148–160K retained prefix; identical-prompt rerun still 3.04 s → divergence, not cold start, dominates | Visibility (cache-warmth telemetry), restraint (defer conversational turns while big OpenCode working sets are hot), `--cache-reuse 256` analyzed and NOT recommended for now (§19c) |
| **CPU threads / memory bandwidth** | llama-server uses host CPU for scheduling/tokenization/detokenization even though inference is GPU-side; voice ONNX bursts want 1–2 cores | Every ONNX session `num_threads 2–4`, spin-wait off; P0 measures sustained/burst CPU and RSS on THIS host (host CPU model was not captured in probes — not characterized here, no invented specs) |
| **Disk/model IO** | Model downloads (0.6 GB Parakeet etc.) at first run | Download at first-run, digest-pinned, resumable, off the audio path |

**Voice stack CPU footprint (to be MEASURED in P0/T3):** ESTIMATED ≤ ~1.5 GB RSS total (Parakeet int8 ~0.6–0.7 GB + Kokoro int8 ~0.3–0.5 GB + runtimes/buffers). The int8-halving assumption is unproven (int8 shrinks weights, not activations). Sustained CPU <5% is only credible WITH thread pinning (V1 reviewer MAJOR-7, retained).

---

## 6. LLM and OpenCode Integration Design

### 6.1 The two paths

| | Conversation path | Task path |
|---|---|---|
| Owner | Jerry (`voice_llm.rs`) | OpenCode (Voice-tasks session) |
| Endpoint | llama-server `/v1/chat/completions` (SSE, direct) | OpenCode `POST /api/session/{id}/prompt` (async — acks ~0.00 s MEASURED) |
| Params | Per-request: json_schema turn, `reasoning_budget_tokens: 0`, temp 0.7, max_tokens 320, rolling ≤12-turn history | Whatever OpenCode's pinned agent/model config dictates (Jerry does not touch it) |
| Tools | **None** (no `tools` param — cannot act) | Full agent toolset, gated by OpenCode permissions |
| Failure isolation | OpenCode outage → conversation unaffected | llama-server busy → tasks queue inside OpenCode's own discipline |
| History | Jerry-owned voice thread (§9) | OpenCode-owned (`opencode.db`) |

### 6.2 The Voice-tasks session

- Created once, reused: `POST /api/session` with `{title:"Voice tasks", agent, model, permissions, location}` — create-time agent+model pinning is VERIFIED and currently unused by Jerry. Default pin: `build` agent, current GLM model. **A session `permissions` ruleset forcing `ask` on mutating tool actions is MANDATORY at creation** — the defense-in-depth backstop for EVERY delegation path (prefix turns, L1 read-only turns, misclassified turns; C2/C3). Exact ruleset action vocabulary REQUIRES IMPLEMENTATION TEST (enumerate OpenCode's permission action names at implementation). Per-class agent switching via `POST /api/session/{id}/agent` (VERIFIED) is a P2 option only — each switch re-renders the session prompt (prefix churn + re-warm per switch, m9); the ruleset, not agent toggling, is the primary mutation control.
- Delivery: new task on idle session → plain prompt (starts immediately — VERIFIED both steer and queue start a run on an idle session). Follow-up while running ("also run the tests") → `delivery:"steer"` (injected at the next step boundary, same turn, no abort — VERIFIED). New task while running → `delivery:"queue"` (durable, parked; native — replaces V1's Jerry-side queue). Jerry wraps the inbox list/update/delete endpoints for user-visible management ("cancel that queued thing").
- Stop: "stop the task" (explicit spoken intent, distinct from barge-in) → `POST /api/session/{id}/interrupt` (default `resume=false`). Note VERIFIED: **no subagent cascade** — child sessions keep running; "stop everything" needs per-child interrupt via `/api/session?parentID=` + `/api/session/active` (deferred to P2, documented). `?resume=true` is wrapped for "resume where you left off". Because children survive the interrupt, the spoken result is honest (m15): Jerry runs a read-only child check (`GET /api/session?parentID=` + `/api/session/active`) and speaks "Stopped." only when none are active — otherwise "Stopped; background subtasks may still be running."
- Permissions: `permission.asked` → announcer speaks "The task needs your approval: <action>" — the action text is capped ~240 chars and markdown-stripped, same as succeeded-summaries (m11; also bounds injected-content readback); never throttled, never suppressed. Approval is ALWAYS via OpenCode's engine — voice adds a transport, never a bypass. **Spoken replies are restricted to `once` or `reject` (C1):** `always` persists a standing allow rule that is invisible in voice mode, so no single mis-transcription may be able to create one — a spoken "always" is refused with a pointer to the approval drawer ("For always, use the approval drawer."). Every spoken permission reply passes the same closed-vocabulary echo gate as L3/L4 (§7.4): the action is spoken, then "Say yes to allow once, or no to deny — is that right?"; a confirmed "yes" maps onto `replyPermission {once}`, "no" onto `{reject}`. **The reply gate arms only after the announcement has actually been spoken (M3):** if `permission.asked` arrives while the user is speaking, that utterance is routed normally, the announcement waits for the next quiet window, and the gate arms after it — the user never answers a question they never heard.
- Forms: `form.created` → question is spoken → spoken answer → `POST …/form/:formID/reply`. Unanswered forms self-answer with an assumption (VERIFIED) — voice mode must always answer or explicitly defer; silence is not neutral.
- Announcements: per-session durable log follower (`?after=` cursor, resumable, durable events only) drives the announcer: started (canned) / permission-requested / succeeded ("Done." + first ~240 chars, markdown-stripped) / failed (canned + first error line). Throttle ≤1 spoken update/10 s; phase transitions only; announce-when-quiet (user silent ≥3 s). The log endpoint is experimental — fallback is the global event stream with `?types=` narrowing + sessionID matching (both VERIFIED).
- Status queries: "what's the status?" reads the log cursor state + `/slots` warmth — no GLM call. "What did the task find?" is routed as a read-only turn into the task session itself (it owns the truth; §7/§9).

### 6.3 Jerry-side wrapper gaps to close (code, not config — VERIFIED server-supported, unwrapped in Jerry)

create-session with `{agent, model, permissions, title}` (ruleset MANDATORY — §6.2) · `POST …/agent` switch · inbox list/update/delete · `interrupt?resume=` · `experimental/…/wait` (block-until-idle barrier for announcer) · per-session `log` follower · form create/get/reply · `PATCH …/session` (ruleset) if needed. No OpenCode or llama.cpp configuration changes are proposed.

### 6.4 Ownership boundary (explicit answer to "what belongs to Jerry vs OpenCode")

| Owns | System | Rationale |
|---|---|---|
| Conversation history & context assembly, instructions, compaction, revert | **OpenCode** | DB is the truth; duplicating it creates drift on revert/fork/compact (explore §G traps) |
| Session lifecycle, inbox queue + delivery semantics | **OpenCode** (Jerry calls the endpoints) | Durable state machines already correct |
| Permission engine, tool execution, provider calls, retries, usage | **OpenCode** | Security-critical; voice never re-implements |
| Voice conversation transcript (direct-GLM turns) | **Jerry** | No OpenCode-side truth exists for these turns; not a second source of truth |
| Voice session lifecycle: create/pin/delete Voice-tasks session, steer/queue prompts, interrupt on explicit command | **Jerry** | Presentation + orchestration, no state duplication |
| Announcer, state chips, permission UI transport | **Jerry** | Derived views, rebuildable from `GET …/message` + log replay (refetch-heal invariant retained) |
| Slot visibility via `/slots` | **Jerry** | Outside OpenCode entirely; OpenCode has no slot concept |
| EOT decisions, TTS normalization, audio | **Jerry** | Voice-domain only |

Anti-trap rules (from explore §G, adopted as invariants): never mirror OpenCode messages into Jerry stores; never cache inbox/permission state beyond event-heal; never announce from stale snapshots (log cursor instead).

---

## 7. Safe Task-Routing Architecture

### 7.1 The ladder

| Class | Examples | Path | Gate |
|---|---|---|---|
| L0 Ordinary conversation | "what do you mean?", "thanks", "why is it slow?" | Direct GLM, speak reply | none |
| L1 Information retrieval / read-only ops | "what's in my config file", "list the failing tests", "what did the task find?" | Delegate to Voice-tasks session — read-only ENFORCED (session ask-ruleset on mutating actions + answer-from-context instruction; §6.2, bound in P1) | spoken ack + echo |
| L2 Coding tasks | "fix the flaky test", "write the migration" | Delegate (coding) | spoken ack + echo |
| L3 Destructive ops | "delete this directory", "force-push", "git clean" | Delegate (destructive) **only after** spoken echo-confirmation | confirmation gate (§7.4) |
| L4 Privileged ops | "install the dependency", "change the server config", "run as root" | Delegate (privileged) **only after** confirmation; OpenCode permissions still apply downstream | confirmation gate + permission engine |

Layering principle: **Jerry's gates decide WHETHER to delegate; OpenCode's permission engine decides whether the delegated task may ACT.** A spoken instruction can never bypass OpenCode permissions — delegation is a prompt into a session, and every tool call inside it flows the normal ask/reply loop. Voice's reply to a permission request uses the same endpoint Jerry's UI uses.

### 7.2 Deterministic guard (runs before/over the schema verdict; ~0 ms, unit-testable)

Evaluated in strict precedence order; the first matching rule wins:

1. **Meta-utterances:** "stop", "never mind", "actually…", "scratch that" → local handling (barge-in / pending-utterance replacement / queue edit via native inbox endpoints). No GLM call.
2. **Permission-reply gate** (only when a permission is pending AND its announcement has already been spoken — §6.2/M3): utterances are first checked against the closed reply vocabulary {yes, no, repeat, cancel}.
3. **Task-status reference rule (state-based; C3 — takes precedence over the lexico-syntactic guard):** if the Voice-tasks session exists AND the utterance references it ("what did the task find", "read me the result", "what did it say"; anaphora like "it/that" only when a task pointer is the most recent event) AND the utterance contains NO imperative-verb + resource-target pattern and NO destructive keyword → this is a question ABOUT the task, not a new instruction: session **idle** → enforced read-only turn into that session (L1; enforcement bound in P1 — §6.2 ruleset + answer-from-context instruction); session **running** → answer locally from the log cursor / task-state line (no GLM, no steer — steering a query into an active run derails task context and spends the slot) and offer to queue the question (`delivery:"queue"`). The reference/instruction separation: meta-references lack a new imperative target; "delete what the task created" contains a destructive verb + target and is routed as a NEW task instruction (rule 5 escalates it).
4. **Explicit prefixes:** "task: …" → **forced-classify turn (C2 — no longer a GLM-free bypass)**: the fused call fires with a system-prompt variant anchoring `task.requested=true` ("the user explicitly marked this as a task; produce the task object; keep `reply` to a short spoken ack"), so `kind` is still produced and §7.4 applies uniformly; "explain: …"/"how do I …" → force conversation. Documented to the user in-app.
5. **Destructive-keyword escalation (escalate-only):** delete/rm/force-push/clean/drop/reset-class patterns force `kind="destructive"` regardless of the model verdict — the guard may escalate a class, never de-escalate one.
6. **Explain-vs-do veto (scoped):** utterance matches interrogative/how/why/explain/compare patterns → task verdicts are overridden to conversation (+ spoken offer, rule 7) — **only when no task-status reference matched rule 3** ("What did the task find?" must never be vetoed) and only when no active-run steer applies. "Can/could/would you + imperative verb" and please-imperatives are TASK-FAVORING, not interrogative (M1) — the veto exists for explain-patterns, not politeness. This exists because GLM at temp 0 MEASURED classifying "explain how to delete a git branch without losing commits" as a task (probe P5) — the exact hazard named in the mandate, real on this model.
7. **Spoken offer continuation (M1):** "yes" to the veto's offer ("Want me to run that as a task?") re-enters delegation as a forced-classify turn — identical mechanics to the "task:" prefix (rule 4): same class assignment, same §7.4 gate.
8. **State-based steer/queue:** Voice-tasks session running + short imperative-ish continuation ("also run the tests") → steer into the active run.
9. **Fused-schema adjudication:** `task.requested/kind` honored per §2.3, subject to rules 3/5/6 above; the bare LLM verdict never alone authorizes destructive delegation.
10. **Cost gate (busy-only; M2):** conversational deferral is governed SOLELY by slot occupancy (§10.1). When the slot is idle, fire immediately — idle deferral protects nothing (eviction occurs on the next divergent prompt regardless of timing) and only adds dead air; the §10.3 externality is accepted. Tasks are never deferred for cost.

**Cost honesty on the prefix path (C2):** the forced-classify turn re-introduces one warm small call (~0.2–0.8 s + ~0.25 s grammar, MEASURED class) on prefix turns — exactly the cost the prefix existed to avoid — accepted deliberately so that no delegation path skips class assignment (test G4). The no-GLM property is retained only for rule-1 meta-utterances.

The fused schema's `task.requested/kind` is then adjudicated: guard-vetoed → converse; `destructive`/`privileged` → confirmation gate; else delegate. The bare LLM verdict **never** alone authorizes destructive delegation (researcher §2 recommendation, adopted).

### 7.3 Transcription-error protection

- STT transcript is displayed live and stored with the turn; every delegation carries the **verbatim transcript** as a metadata line alongside the interpreted `task.prompt`, so the agent sees the original words when interpretation mangles a name.
- Destructive/privileged echo-confirmation speaks back the interpreted target with digits/paths expanded ("Delete the directory home slash mahin slash projects slash old-notes — confirm?"), digit-by-digit per the normalizer's rules. A mis-recognized filename is heard and correctable before anything runs.
- Confirmation vocabulary is closed: confirm / cancel / repeat. Anything else re-prompts. Barge-in during the gate cancels it.
- Low STT confidence (below calibrated threshold, P1) → ask-repeat once, then fall back to dictation-style display.

### 7.4 Confirmation gate mechanics

`destructive|privileged` → orchestrator enters `Confirming` state: speak echo → listen (closed vocabulary {yes, no, repeat, cancel}, fixed 5 s window, one repeat) → confirm → delegate + canned "On it."; cancel → speak "Cancelled." + remain conversational. The gate is **provably half-duplex** (m1): the mic opens only after the echo's Done+pad (§8.4 definition), and the echo question avoids gate vocabulary ("— is that right?", never "confirm?") so the gate can never hear its own prompt. **Uniformity (C2):** every delegation path passes through class assignment + this gate — the `task:` prefix (§7.2.4) and the spoken-offer continuation (§7.2.7) both produce a classified turn; nothing delegates unclassified. **Permission replies (C1)** use the same closed-vocabulary echo gate, restricted to `once`/`reject` (§6.2). All gates logged to the EOT/decision JSONL (booleans + class + outcome, no transcripts). The gate is Jerry-side and precedes delegation; OpenCode's own permission ask may still fire downstream for the concrete tool call — voice handles it via §6.2, never auto-approving.

### 7.5 Worked examples (each is an acceptance fixture)

| Spoken utterance | Guard/schema outcome | Action |
|---|---|---|
| "Explain how to delete a git branch without losing commits" | explain-veto fires (P5 regression fixture) | converse; optional task offer |
| "Delete the build directory" | task/destructive | echo-confirm → delegate on confirm |
| "Task: fix the flaky auth test" | prefix forced-classify (§7.2.4) | one warm classify call → kind assigned → delegate; a destructive keyword would escalate + gate (G4) |
| "Also run the integration tests" (task running) | state-based | steer into active run |
| "What did the task find?" (session idle) | task-status rule (§7.2.3 — precedence over the guard) | enforced read-only turn into task session; the explain-veto must NOT fire (T7 fixture) |
| "Can you fix the flaky test?" (no active task) | polite imperative → task-favoring (M1) | routed to the classify/delegate path, not vetoed (T7 subset) |
| "Never mind" | meta | cancel pending utterance / gate |
| "Why is the slot busy?" | interrogative + meta-ish | converse (state read locally, no GLM needed for the fact) |

---

## 8. Interruption and Cancellation Design

### 8.1 The five stages (each separately measurable; the state machine names them)

| Stage | Definition | Mechanism | Budget | Label |
|---|---|---|---|---|
| S0 | Physical speech onset | Acoustic ground truth (harness reference only) | — | harness-measured |
| S1 | VAD detection | Silero prob ≥0.5 sustained ≥250 ms during Speaking | ~250 ms + ~0.2 ms/window inference | 250 ms TUNABLE; inference BENCHMARK (other host) |
| S2 | Cancel request issued | epoch bump (single writer) + `Player::stop()` + `AtomicBool` abort on the voice SSE stream + reqwest drop | rodio-side ≤5 ms; stream drop <50 ms | rodio ≤5 ms VERIFIED (source) |
| S3 | Audible stop | last sample reaches DAC | **OS output buffer cannot be retracted: ~50 ms (code) / ~100 ms (docs)** | VERIFIED source; actual delta REQUIRES IMPLEMENTATION TEST (T5) |
| S4 | llama slot free | server observes client disconnect → `is_processing` false | **120–363 ms** | MEASURED (aborttest3.py) |
| S5 | Re-armed | Cooldown → Listening | 300 ms post-barge-in / 500 ms post-our-speech | TUNABLE |

Physical onset → audible stop ≈ **305–355 ms** (S1+S2+S3, ESTIMATED composite of labeled parts); onset → Listening ≈ 0.9–1.2 s. V1's "<5 ms barge-in" was the rodio-side stop only and is corrected; the audible tail is irreducible below the buffer size (a smaller buffer via `DeviceSinkBuilder::with_buffer_size` trades underrun risk — REQUIRES IMPLEMENTATION TEST if pursued).

### 8.2 Race analysis

| Race | Resolution |
|---|---|
| Speech starts during TTS synth (clip not yet audible) | Epoch bump discards at next orchestrator check; nothing audible to stop |
| Speech starts during clip N playback | `Player::stop()` kills current + queued (append-after-stop is safe in 0.23 — VERIFIED keep-alive queue); tail ≤ S3 |
| LLM stream vs chunker vs synth | Sentence objects carry `{turn_id, sentence_index, epoch}`; single-writer enqueue at the orchestrator validates epoch — check-vs-enqueue race closed by construction (V1 reviewer MAJOR-2, retained) |
| Stream already finished, TTS still playing | HTTP abort unnecessary; epoch + stop suffice (no wasted disconnect) |
| Barge-in during Cooldown/Listening | No-op — not Speaking; EOT ladder owns the state |
| Barge-in during a confirmation gate | Cancels the gate (nothing was delegated) |
| Two barge-ins in quick succession | Epoch is monotonic; second bump supersedes; Player restart idempotent |
| `/slots` poll in flight during barge-in | Slot state is advisory only; barge-in never consults it |

### 8.3 Queued clips from previous turns never play after interruption

By construction: (a) already-queued clips are cleared by `Player::stop()`; (b) in-flight synth tasks discard on epoch check at the single-writer enqueue point; (c) a new turn's clips carry the new epoch. There is no path from an old epoch to the Player.

### 8.4 History hygiene on interruption (heard-content rule)

A sentence enters voice history **only** when its clip fully drained audibly: per-clip `append_with_signal()` Done receiver **+ pad ≥ one output buffer (≥50 ms)** — `len()==0` is the mixer pulling the last sample, not the audible end (VERIFIED source; V1's sink-empty definition corrected). Partially-heard sentence → dropped entirely; zero-heard sentences → assistant turn omitted from history (UI-only `interrupted` flag). Consequence: the next turn's context matches what the user actually heard — interrupted responses cannot corrupt future context. Cost: generated-but-unheard tokens are wasted and the user may re-ask; accepted. Zero-heard turns omit the assistant message entirely — to keep the messages array well-formed for the chat template, consecutive user messages are separated by an `(interrupted — not heard)` assistant placeholder line that exists only in history and is never spoken (m13).

### 8.5 Absolute constraints (torture-harness assertions, P1 acceptance)

1. Voice barge-in **never** calls any OpenCode endpoint — no interrupt, no DELETE, no inbox mutation, for ANY session, including the Voice-tasks session. Tasks keep running; the announcer goes quiet and resumes announce-when-quiet.
2. Task interruption happens ONLY on explicit "stop the task" class intent (distinct code path, requires TaskActive state).
3. Mic capture closes on `voice_stop` (test-asserted); no audio leaves the process (§13).
4. 50-barge-in scripted run asserts zero OpenCode session state changes (event-diff verified) — P1 gate.

---

## 9. Conversation History Ownership

### 9.1 Two registers, two owners, one bridge

- **Voice conversation register** — Jerry-owned: system prompt + rolling ≤12 heard turns; persisted on disk at `~/.local/state/nexus/voice/transcripts/*.jsonl` (per day), retention ~50 MB / 90 days, in-app "clear voice history", load-on-start. Persist default ON with a prominent opt-out (operator decision §19e). Heard-content rule from §8.4 applies to the in-memory context; the JSONL additionally records raw transcripts (user side) for auditability.
- **Task register** — OpenCode-owned in `opencode.db`. Never mirrored into Jerry stores (drift on revert/fork/compact/move — explore §G). Jerry renders task detail on demand from `GET …/message` / log replay.

### 9.2 How conversation transitions into tasks (and back)

Forward: guard/schema selects a task class → delegation prompt = interpreted `task.prompt` + verbatim-transcript metadata line → OpenCode session. The voice history records only the spoken ack/echo + a system-generated task pointer line ("→ delegated: fix flaky test (task running)") so the conversational thread stays readable without duplicating task content.

Backward: task results flow to the user via the announcer (spoken summary) — they are NOT injected into the voice conversation history. "What did the task find?" routes per §7.2.3 (state-based, guard-exempt): session idle → enforced read-only turn **into the task session** (read-only = the session's mandatory ask-ruleset on mutating actions + an answer-from-context prompt instruction, §6.2 — the answer is composed where the truth lives); session running → answered locally from the task-state line / log cursor, with an offer to queue. The only OpenCode→voice-channel data is the **task-state line** (§9.3).

### 9.3 The task-state line (the coherence bridge)

One sentence in the voice prompt, maintained by the orchestrator from Voice-tasks session state (idle / running (n steps, current tool) / awaiting permission / last outcome succeeded|failed|interrupted), derived from the log follower + `experimental/…/wait` barrier — rebuildable, never a second truth. It lets conversation turns refer to task reality ("is it done?" → yes/no from state, no GLM) without importing task payloads. **Placement (M4):** the line is emitted LAST in the prompt — after the static system core AND after the rolling history — so state transitions mutate only the prompt tail and the stable voice prefix (system core + history) survives; the per-turn recompute is small either way, but the spec fixes the placement.

### 9.4 Compaction and lifecycle

Rolling window drop is P1 (oldest turns fall off; JSONL retains full history on disk). Summarize-dropped-turns compaction is P2, executed only when the slot is observed idle (a compaction call is a normal GLM call and pays the same contention rules). **Task-session growth (M4):** the Voice-tasks session's own history also accumulates unboundedly with the same compaction economics — compaction there uses OpenCode's native compact endpoint (steer-by-default, VERIFIED), idle-gated, P2. App quit / restart: voice history reloads from JSONL; the Voice-tasks session persists server-side (durable); the log cursor re-syncs to the CURRENT tail (the `log.synced` seq at connect — m2), never replaying stale history through the announcer; on OpenCode reconnect mid-session the same tail-anchor applies (m4).

---

## 10. Concurrency and Resource Management

### 10.1 Slot-state machine (gate = `/slots`, not `/health`)

`GET /slots?fail_on_no_slot=1` → 503 = busy (clean non-queueing pre-check, DOCUMENTED) · 200 + `is_processing` · `n_prompt_tokens`/`n_prompt_tokens_cache` = cache-warmth telemetry (undocumented-but-real in this build, MEASURED) → TTFT-class prediction (small retained prefix ≈ warm 0.1–0.8 s; large foreign prefix ≈ divergent ~3 s). Poll ≤1 Hz while live, with retry loop — `/slots` hiccuped ~3 s once under contention (MEASURED); on persistent unavailability Jerry treats the slot as **busy** (conservative) and speaks "brain unavailable" for conversation; dictation (zero GLM) keeps working.

| Situation | Behavior |
|---|---|
| GLM idle | Fire the fused turn immediately (pre-check `fail_on_no_slot` first; the post-fire watchdog below closes the admission race) |
| GLM occupied by an OpenCode turn | **Defer.** Speak canned Kokoro filler (no GLM; throttled — first attempt speaks, re-parks within ~30 s update the chip only) + park the utterance (RAM, one slot, latest-utterance-wins) + waiting chip. Poll ≤1 Hz; fire when idle |
| GLM occupied, user issues a task | Delegate via prompt — OpenCode's own admission handles it (steer/queue/durable inbox); voice adds no queue of its own for tasks |
| Multiple voice requests | Single-user app: latest-utterance-wins replacement of the parked utterance |
| Permission needed | Task pauses (`awaiting-permission`); announcer speaks it (never suppressed); spoken grant → `replyPermission` |
| User prioritizes | Barge-in frees the voice path (S2–S4); "stop the task" → explicit interrupt of the Voice-tasks session only |
| Server restart | `/slots` unreachable → busy-posture (§10.1); voice conversation degraded with spoken notice; OpenCode tasks unaffected; no config action by Jerry |
| Voice request while voice already speaking | That IS barge-in (§8) |

**Post-fire watchdog (C5 — closing the admission race).** `fail_on_no_slot=1` is a property of the `/slots` probe, NOT of `/v1/chat/completions` — the generation endpoint queues by default, so between an idle pre-check and server admission (~10–100 ms) an OpenCode prompt can win the slot, leaving a voice turn silently queued behind a minutes-long task: exactly the §10.2 violation, on the one path the draft had left uncovered (every pre-fire mitigation lives on the defer path). Closure: after submit, if **no first SSE byte within 4 s** (≥ the MEASURED 3.4 s worst divergent TTFT, so a legitimately slow warm-up is never aborted), Jerry aborts the stream (§8 S2 machinery, epoch-consistent) and re-checks `/slots`: idle → re-fire once; busy → re-park the utterance on the standard filler/chip path. The UI shows the truth either way (waiting chip → "queued behind task" state), and barge-in / "never mind" always escapes. A turn lost to the watchdog costs ≤4 s of generation — bounded and announced; silent unbounded hang is impossible.

**Retry and ordering invariants (m3).** After a barge-in abort, S4 (slot free) completes within 120–363 ms MEASURED while the next turn's pre-check happens ≥1.2 s later (EOT) — the invariant "S4 settles before the next pre-check" is stated here and asserted in P1. A slow disconnect could still produce a spurious defer, so a busy/503 pre-check result gets a ≤500 ms bounded single retry before deferring.

**Failure-mode matrix (m4).**

| Failure | Behavior |
|---|---|
| Disk full during transcript JSONL write | Disable persistence for the session + Error frame; never crash; audio path unaffected |
| STT/TTS model load failure at startup | Text-only degrade (live transcript without audio) + Models chip error; capture still gated by mic rules |
| llama-server connection reset mid-stream | One retry on the conversation turn; else spoken "Connection lost" + Error frame |
| OpenCode service down mid-task | Announcer offline chip; no task actions attempted; log-cursor tail re-sync on reconnect (§9.4) |

### 10.2 No competing scheduler (hard rule)

llama.cpp has no preemptive priority API; voice never preempts and never *knowingly* queues into llama-server (a queued request would delay the *next* OpenCode turn — the exact "make OpenCode less reliable" failure). The admission race between the pre-check and server admission is closed by the post-fire watchdog (§10.1): a fired turn that fails to obtain the slot within the bound is aborted and re-parked, so the no-queue property is **enforceable, not aspirational** (test G1). Voice visibility ≠ priority: fillers and chips make waiting legible; deferral protects the primary workload. Voice conversational turns are bounded (~320 max_tokens ≈ 1–3 s slot occupancy ESTIMATE).

### 10.3 The eviction externality, stated honestly

A voice turn fired between OpenCode turns still evicts the OpenCode working set — the hybrid makes *voice* turns cheap; it does not protect OpenCode. Mitigations, in order: deferral-first posture (§7.2.5, §10.1); short turns; warmth-telemetry-aware timing (defer conversational turns while a large working set is hot and recently active); optional `--cache-reuse 256` analyzed and **not recommended now** (§19c — likely small benefit for voice because the voice prefix diverges from OpenCode prompts early; changes the primary workload's profile; requires operator approval and an A/B). This is a structural cost of `--parallel 1`; the design constrains it, does not eliminate it.

### 10.4 CPU budget

ONNX sessions pinned `num_threads 2–4`, spin-wait off; bursts 1–2 cores during STT/TTS; sustained target <5% (only credible with pinning — MEASURED in P0/T3). RSS target ≤ ~1.5 GB ESTIMATE (§5). No GPU allocation of any kind.

---

## 11. Realistic Latency Expectations

### 11.1 Stage budget (speech-stop → first audio)

| Stage | Value | Label |
|---|---|---|
| Mic → ring frame | 32 ms (512 @ 16 kHz) | structural |
| Silero inference | ~0.2 ms/window | BENCHMARK (other host) |
| Trailing-silence EOT wait (balanced) | 1200 ms | design constant (P1); Smart Turn would cut to ~400–470 ms (P2) |
| STT Parakeet int8 CPU (5 s utt) | ~0.10–0.25 s | ESTIMATE → T3 |
| Router guard | ~0 | deterministic |
| GLM TTFT, voice prefix warm | 0.21–0.80 s | MEASURED (TTFB) |
| Grammar overhead (small schema) | ~0.25 s | ESTIMATE (bounded by P5-vs-P3 like-for-like; confounded runs excluded) |
| GLM TTFT, divergent after ~148–160K foreign prefix | 3.0–3.4 s | MEASURED |
| First-sentence accumulation (stream → first boundary) | ~0.3–0.7 s | ESTIMATE |
| Kokoro TTFA (short sentence, int8, CPU) | ~0.2–0.5 s | ESTIMATE → T3 (VoxRT's 1.5 s short-text was Python fp32 whole-utterance on an i9-13900K — chunking mandatory) |
| Playback prefill | 100–150 ms | TUNABLE |
| **Total, warm, balanced EOT** | **≈2.5–3.2 s median** | ESTIMATED composite; instrument P1 before tuning debates |

V1's "1.3–2.2 s median" is corrected: it assumed ~650 ms effective EOT and grammar-free TTFT. The 1200 ms silence is a deliberate false-cut-avoidance choice (Smart Turn deferred, §4); P2 Smart Turn is the path to ~1.6–2.3 s. No ChatGPT-Voice comparisons are used as targets (mandate).

### 11.2 Six scenarios × best / expected / degraded

| # | Scenario | Best | Expected | Degraded | Dominant term |
|---|---|---|---|---|---|
| 1 | Idle GLM, simple warm exchange | ~2.2 s | ~2.8 s | ~3.5 s (background clients interleaved) | EOT silence + TTFT |
| 2 | GLM busy with an OpenCode task | filler ~0.5 s (canned); answer parked | answer at task-turn end + scenario-1 pipeline | task runs minutes → answer whenever it ends; chip + filler; user can cancel pending utterance ("never mind" — local) | unbounded task turn |
| 3 | First voice turn after a long-coding session (148–160K foreign prefix retained) | ~5.0 s | **~5.5–6.5 s** (3.0–3.4 s TTFT MEASURED + pipeline) | ~6.5–7 s (busier background) | prefix divergence; subsequent voice turns re-warm to scenario 1 |
| 4 | Simple conversational exchange, warm (== 1) | ~2.2 s | ~2.8 s | ~3.5 s | EOT silence |
| 5 | Voice request needing tool execution | voice-side ack ≈ scenario 1 + ~0 s (delegation ack async MEASURED) | spoken ack ≤ scenario 1; result latency = full agent turn (unbounded, announced via log) | agent turn long/fails → announcer states it | agent execution, NOT voice latency |
| 6 | Interrupted response | onset→audible stop ~305 ms | ~355 ms; slot free +120–363 ms (MEASURED); Listening ~0.9–1.2 s | +1 EOT window if re-trigger mid-cooldown | VAD confirm + OS buffer |

*(Labels: scenario rows are ESTIMATED composites of §11.1's labeled components — m5. The MEASURED cell inputs are the divergence TTFT (3.0–3.4 s), the delegation ack (~0 s), and S4 (120–363 ms).)*

### 11.3 Overlap vs sequential

Overlapped by design: TTS of sentence N+1 synthesizes during playback of sentence N (clip queue); first sentence synthesizes as soon as its text boundary completes, before the stream ends. Sequential in v1: STT after EOT decision (an incremental-decode-during-silence optimization could hide ~0.1–0.15 s — P2 candidate, not load-bearing).

### 11.4 Measurement procedures (P1 instruments before any tuning)

Per-stage monotonic timestamps emitted to the EOT/decision JSONL: S0–S5 barge-in stages, EOT outcome, TTFT class predicted vs observed (`n_prompt_tokens` before vs TTFT after), first-audio time. Acceptance thresholds in §14; all numbers above are falsifiable against these logs.

---

## 12. Speech Recognition and Synthesis Strategy

### 12.1 STT

**Parakeet TDT 0.6B v3 int8** via sherpa (simulate-streaming), CC-BY-4.0, punctuation/caps built-in, CPU. WER 6.34% leaderboard (BENCHMARK). Local latency on THIS host: ESTIMATE → T3. Alternatives kept on the bench: Qwen3-ASR-0.6B (hotwords, drop-in via sherpa) if jargon WER disappoints; Whisper-turbo GPU **dropped** (§4/§5). Dictation path = capture → VAD trim → STT → Composer for manual review/send — zero GLM, usable while tasks run.

### 12.2 TTS default (decisive)

**Kokoro-82M int8 via sherpa, sentence-chunked, CPU — with the Jerry normalizer as a mandatory component, not an accessory.** Rationale: Apache-2.0 weights; zero new dependency (same crate as VAD/STT); lexicon override path exists (`--kokoro-lexicon` comma-separated files — VERIFIED) giving deterministic pronunciation control; 54 voices. Known regression: the English frontend is lexicon-only and DROPS numbers/currency/OOV (VERIFIED #4139) — hence §12.3. **Fallback: Pocket TTS fp32 bundle** (168.1 MB, VERIFIED present) — 71–82 ms TTFA class (BENCHMARK, author-bias caveat) but rule-FSTs + SentencePiece frontend with **no lexicon → weaker pronunciation control** (OOV → subwords, ESTIMATED); English-only. Fallback triggers on: corpus round-trip failure of Kokoro (§12.5) or sustained quality rejection in listening tests. Never the int8 Pocket bundle (upstream #3172, VERIFIED).

### 12.3 The Jerry-owned normalizer (deterministic, unit-testable, TTS-input only)

Runs in `tts_pipeline.rs` on sentence objects queued for synthesis. One-way transform: the text submitted to OpenCode, the conversation history, and persisted transcripts are NEVER altered. Layers:

1. **Protected-token expansion** (before Kokoro sees the text): IPs digit-by-digit with "dot" (never "one hundred seventy-two"); paths/URLs component speech with `~` → "home"; versions/ids (`v2.4.1` → "v two point four point one", `Q4_K` → "Q four K", `GLM-5.3-Flash` → "G L M five point three flash"); acronyms (uppercase runs ≥2, exception list) letter-by-letter; numbers/ordinals/times → words (num2words-equivalent; NeMo/misaki rule sets as prior art).
2. **User pronunciation lexicon** `~/.config/nexus/voice/pronunciations.toml`: string→spoken-form replacements, plus optional word→IPA entries appended as a second `--kokoro-lexicon` file.
3. **Never-drop policy:** unrecognized protected-token class → spoken letter-by-letter. The #4139 failure mode must be impossible by construction for Jerry's output.

REQUIRES IMPLEMENTATION TEST (T10 covers it): whether one combined Rust pre-pass feeding plain text beats maintaining OpenFst rule FSTs (the FST hook is engine-supported but FST authoring from Rust is poor; the maintainer's FST preference targets upstream generalization).

### 12.4 rodio playback semantics (corrected)

`Player` (0.23 rename — VERIFIED); `append()` after `stop()` safe (keep-alive queue); `len()==0`/`empty()` = mixer pulled last sample ≠ audible end; `stop()` rodio-side ≤5 ms but OS-buffer tail ~50 ms (code) / ~100 ms (docs) is irretractable; per-clip completion = `append_with_signal()` Done receiver + ≥50 ms pad; `sleep_until_end()` tracks only the last append — not used for per-clip tracking. Buffer latency and Done→silence delta: T5.

### 12.5 Pronunciation test corpus (acceptance fixture; researcher §4 adopted verbatim)

~10 items per category: IPs, shell commands, file paths, versions/build-ids, acronyms, technical terms, ordinary-conversation control (guards over-expansion). Objective check: TTS output → Parakeet STT → normalize → compare `expected_spoken` (WER per item). Pass: zero dropped tokens (the #4139 mode), correct expansions, round-trip WER ≤1 word (0 for IPs/versions); category pass ≥90%. The corpus gates engine swaps (Kokoro↔Pocket) and normalizer changes.

### 12.6 EOT strategy

P1: Silero (speech start prob ≥0.5 sustained ≥250 ms; intra-utterance pauses <400 ms never trigger) + fixed-silence end 1200 ms (balanced, the only profile in P1); <2 s utterances resolve complete; >30 s → force STT; VAD failure → degraded-but-functional pure fixed-silence mode. JSONL decision logging from day one (`{utterance_ms, silence_ms, outcome, corrected_by_user}` at `~/.local/state/nexus/voice/eot.jsonl`, rotated, no transcripts). P2: Smart Turn v3.2 behind gate T1 (dual-runtime coexistence) + parity test, tuned from the logged data; the third-party 35.2%@300 ms false-cut number sets expectations ( DOCUMENTED benchmark; methodology caveats apply); >8 s utterances feed Smart Turn the last 8 s (official truncation policy, VERIFIED). Aggressiveness profiles (fast/relaxed) land in P2 only with corpus data.

---

## 13. Security and Privacy Model

| Control | Design |
|---|---|
| Local-only default | Zero cloud calls; voice LLM path asserts loopback `NEXUS_LLM_URL`; reqwest built without TLS (a feature); **no network egress from the audio/LLM path** — the only egress anywhere in voice is first-run model downloads (pinned URLs, digest-verified, UI-mediated; m10) |
| Mic lifecycle | Capture open ONLY in dictation/live; `voice_stop` closes the cpal stream (test-asserted); app-quit closes it (shutdown test); entering live mode is a deliberate second step + first-run consent chip |
| Recording indicators | Jerry state chip (off/dictation/listening/thinking/speaking/waiting) + Ubuntu OS mic indicator as backstop; no "silent listening" state exists |
| Audio retention | Utterance buffer RAM-only, 30 s cap, dropped at turn end; nothing audio-related written to disk — only user-visible transcript JSONLs (retention-capped, clearable, opt-out toggle §19e) and the EOT decision log (booleans/timings, no transcripts) |
| Voice-history deletion | "Clear voice history" control (per-day and all); delete = file removal + in-memory reset |
| Model supply chain | sha256 digests pinned in-repo at pin time; downloads resumable + digest-verified at download AND re-verified at first load per model version; `sherpa-onnx-sys` build-time archive vendored or URL+digest pinned (`SHERPA_ONNX_ARCHIVE_DIR`); version pinning is part of the model manifest, surfaced in Settings |
| IPC surface | One new Channel + commands following existing validation discipline; no new Tauri capabilities beyond voice needs |
| Mis-recognition protection | §7.3: verbatim transcript rides every delegation; destructive echo-confirm with digit-wise expansion; closed confirmation vocabulary; low-confidence ask-repeat |
| Prompt injection — spoken instructions | Spoken text is user intent (equivalent to typing it); it can only become a prompt into an OpenCode session, where the permission engine governs every tool call. Voice never auto-approves permissions and never auto-answers forms |
| Prompt injection — retrieved content | Delegation prompts are composed from the transcribed utterance ONLY — never document content (blocks document-embedded `<task>` spoofing by construction; the V1 marker is gone anyway). Announcer speaks model-composed summaries (~240 chars, markdown-stripped), not raw retrieved content; form questions are spoken verbatim but require an explicit spoken answer |
| Execution surface | Conversation path is toolless by construction; execution exists only inside OpenCode sessions under its permission engine |
| Permission replies by voice | Restricted to `once`/`reject` behind the closed-vocabulary echo gate (§6.2/§7.4); `always` (a persistent allow rule) is UI-only — a single mis-transcription cannot create standing privilege (C1); T9 asserts no saved allow rule is created in any negative path |
| Reliability of shutdown | `voice_stop` + app-exit paths close capture and Player; asserted by tests; no background audio threads survive |

---

## 14. Phased Implementation Plan

### Gate discipline

Each phase has an **entry gate** (uncertainty that must resolve before the phase begins) and an **exit acceptance** (MEASURED criteria). No phase starts on optimism.

### P0 — Dictation foundation (single ONNX runtime; no `ort`, no Smart Turn)

- **Entry gate:** operator approves this spec's P0 scope + model-download consent (§19a).
- **Scope/deliverables:** `voice_capture.rs` (cpal + ringbuf + hotplug); sherpa bootstrap (Silero + Parakeet) + models PanelCard (resumable, digest-pinned downloads, manual file-drop fallback); Composer mic button (`off|dictation`); voice store + reducer + level meter; ONNX thread pinning from the first session; **T2 (sherpa static in AppImage) and T3 (latency/RSS on this host) executed here**; fault-injection test (kill ONNX session mid-inference → clean re-init, app survives).
- **Acceptance:** 10 s utterance → Composer text ≤1.5 s p50 (MEASURED); zero GPU usage (telemetry-asserted); BT hotplug recovery ≤2 s; mic closed on toggle-off (test); vitest reducer suite + `#[cfg(test)]` VAD/trim tests + `#[ignore]` live-mic harness; RSS within T3 budget.
- **Risks:** Parakeet int8 CPU slower than estimated (T3 measures; fallback Qwen3-ASR swap — same crate); AppImage static-link failure (T2; fallback: system sherpa via `SHERPA_ONNX_LIB_DIR`, documented install step).
- **Rollback:** feature-flagged module; dictation-only shippable state at all times.

### P1 — Live voice MVP + minimal safe task delegation

- **Entry gate:** P0 acceptance met; operator consents to live mic + P1 delegation scope (§19b).
- **Scope/deliverables:** `voice_llm.rs` (fused schema turn, `reasoning_budget_tokens: 0`, sse_pump pattern, loopback assert); sentence-chunked Kokoro + normalizer (§12.3) + Player single-writer pipeline; epoch barge-in with S0–S5 instrumentation; fixed-silence EOT + JSONL decision log; `/slots` gate + warmth telemetry + fillers + waiting chip; full `VoiceFrame` schema; live transcript panel; push-to-talk override; **delegation: "task:" prefix + schema task field (non-destructive classes) + destructive/privileged confirmation gates + Voice-tasks session create/pin + announcer via per-session log + permission speaking + form speaking**; OpenCode wrapper additions (§6.3); on-disk transcript persistence + retention + clear control.
- **Acceptance (all MEASURED):** speech-stop → first audio ≤3.2 s p50 warm (stretch 2.6 s); barge-in audible-stop ≤400 ms from detected onset (S1→S3), slot free per S4; **50-barge-in torture: zero OpenCode session state changes**; 30-min soak RSS growth <10%; EOT false-cut <10% with balanced profile; pronunciation corpus pass (§12.5); explain-vs-do fixture (P5 sentence) routes to conversation; destructive echo-confirm round trip; permission asked→spoken grant→executed round trip with an unrelated running task untouched; interrupted-turn history equals heard content (test).
- **Risks:** schema turn style degradation (T6 A/B inside P1; fallback = freeform + residual classifier); warm-TTFT variance under background clients (warmth telemetry + deferral absorb).
- **Rollback:** live mode behind flag; delegation can be disabled independently (conversation-only live mode remains).

### P2 — Natural conversation + full routing + Smart Turn + speaker mode

- **Entry gate:** P1 acceptance; **T1 dual-runtime coexistence PASSED** + Smart-Turn-via-`ort` parity test; EOT JSONL shows the false-cut profile and >8 s bucket behavior.
- **Scope/deliverables:** Smart Turn integration (uncertain-band ladder, >8 s truncation policy, aggressiveness profiles from logged data); natural-language routing tuning (few-shot set for the fused turn, guard calibration from decision log); speaker-mode profile + PipeWire `module-echo-cancel` helper docs + echo gate; rolling-history compaction (idle-slot-gated); per-child interrupt ("stop everything") via child-session discovery; optional `generate`-based spoken status summaries; incremental-STT overlap optimization if logs justify.
- **Acceptance:** false-cut <5% on logged corpus; Smart Turn adds ≤100 ms to EOT decision p50; delegation ambiguity set (no prefix) routes correctly on the §7.5 fixtures ≥95%; speaker self-trigger ≈0 with echo-cancel; compaction runs only on observed-idle slot (log-asserted).
- **Risks:** Smart Turn real-world false-cut worse than benchmark suggests (fallback: stay on fixed-silence — the P1 profile remains shipped and tunable); dual-runtime packaging failure (fallback: run Smart Turn in a tiny sidecar process OR stay fixed-silence indefinitely — both documented).
- **Rollback:** Smart Turn and profiles are additive flags; P1 behavior preserved.

### P3 — Advanced

Wake word (sherpa KWS; false-wake <1/h before default-on), global hotkey, GPU-resident STT experiment (only with explicit operator approval and a contention argument — currently dropped, §4), in-app AEC re-evaluation only if the PipeWire path proves insufficient. Entry gate: P2 acceptance + operator pick from §19.

---

## 15. Explicit Proof-of-PoC Requirements

### 15.1 Label vocabulary (normative for this spec and all descendant docs)

- **MEASURED** — live probe, this machine, this build, today, probe script preserved. Configuration evidence (flags, versions) is NOT measurement; it is VERIFIED/DOCUMENTED.
- **VERIFIED** — read from the primary source of the exact pinned version (crate source, server source, API schema).
- **DOCUMENTED** — official docs of the pinned version.
- **BENCHMARK** — third-party measurement on other hardware/software path; indicative only.
- **ESTIMATED** — derived arithmetic from labeled inputs.
- **UNVERIFIED** — no evidence; hypothesis.
- **REQUIRES IMPLEMENTATION TEST** — unsettleable except by building; must name its test below.

### 15.2 V1 proof-label audit (every "proven/demonstrated" claim re-examined)

| V1 claim | Where | Verdict | V2 disposition |
|---|---|---|---|
| Dual ONNX runtime coexistence "proven in the P0 AppImage spike" | §3.2 | **FALSE as written** — git log --all has zero spike commits/branches/stashes; no voice code exists in src/ or src-tauri/ (grep clean, re-verified this session); V1's own roadmap (line 269) schedules the spike *inside* P0 | UNVERIFIED → REQUIRES IMPLEMENTATION TEST **T1**; moved to P2 entry gate; P0/P1 are sherpa-only |
| "rodio `Sink::stop()` <5 ms barge-in" | §2.5/§8 | Misleading — <5 ms is rodio-side only | Corrected: audible stop includes ~50–100 ms OS-buffer tail (VERIFIED source); T5 measures the actual delta |
| "sink-empty notification = sentence heard" | §4/§8 | WRONG — `len()==0` = mixer pulled last sample, not audible end; 0.23 renamed Sink→Player | Corrected: per-clip Done receiver + ≥50 ms pad (§8.4, §12.4) |
| "`/health` slots" busy gate | §5/§6 | BROKEN — `/health` 200-while-busy MEASURED | Replaced by `/slots` gate (§10) |
| "GLM on GPU 0, GPU 1/2 headroom" | §1/§7 | DEAD — all three GPUs 70–75 GiB occupied (MEASURED) | §5 rewritten around contention; GPU voice dropped |
| "Expected 1.3–2.2 s median" | §1/§6 | Optimistic composite — sub-balanced EOT + grammar-free TTFT assumed | §11 recomputed: ≈2.5–3.2 s warm median (ESTIMATED, honest inputs) |
| ChatGPT voice 1.3–1.5 s as north star | §6 | Dropped per mandate | Removed from targets |
| Silero "~190–240 µs [MEASURED]", Smart Turn "10–12 ms [MEASURED]" | §2.3 | Mis-labeled — measured on other hosts | Relabeled BENCHMARK; T3 measures locally |
| Kokoro "TTFA ~200–500 ms [ESTIMATE]" | §2.4 | Kept ESTIMATE but under-qualified — VoxRT measured the Python fp32 path on an i9-13900K | ESTIMATE + host/path caveat; T3 + corpus measure the actual sherpa int8 path |
| "Whole-utterance 9.6 s/17 s text [MEASURED]" | §2.4 | Valid but other-host BENCHMARK | Relabeled BENCHMARK; chunking mandate unchanged |
| espeak removal / GPL-free / lexicon regression | §2.4 | CORRECT (VERIFIED #4055/#4139) | Retained; normalizer elevated to mandatory component |
| "<task> marker = zero extra GLM calls" | §3.5 | True on call-count, fragile on robustness | Replaced by fused schema turn (same call count, grammar-guaranteed structure) |

### 15.3 Named PoC/implementation tests (each: procedure + pass criterion)

| ID | Test | Procedure | Pass |
|---|---|---|---|
| T1 | Dual ONNX runtime coexistence | AppImage build linking sherpa static CPU archive + `ort` dylib; load one Silero session via sherpa and one Smart Turn session via `ort` simultaneously; run 1000 inferences interleaved | No link/load errors; both produce correct outputs; RSS within budget |
| T2 | sherpa static in AppImage | Package T1-minus-ort build; launch on clean user session | Model loads from XDG dir; no system sherpa present |
| T3 | Local STT/TTS latency + RSS + decode rate | On THIS host: 5 s and 10 s utterances through Parakeet int8 (p50/p90); Kokoro int8 short-sentence TTFA p50/p90; steady + peak RSS per session with pinned threads; **GLM decode tok/s on 200+-token schema turns (sizes the C4 budget) + host CPU characterization** | Feeds §11 re-baseline; RSS ≤1.5 GB total; no budget violation; `max_tokens` finalized from the measured decode rate |
| T4 | End-to-end disconnect abort via Jerry stack | `voice_llm.rs` stream mid-generation → drop → poll `/slots` | `is_processing` false within ≤500 ms (consistent with MEASURED 120–363 ms) |
| T5 | rodio stop→audible delta | Play a tone; `stop()`; record loopback/reference capture | Measures actual tail (expected 50–100 ms); feeds S3 budget and pad constant |
| T6 | Fused-schema reply quality | A/B: 50 fixed prompts freeform vs schema-wrapped at the OPERATING temp (0.7), multiple seeds; blind pairwise preference with a defined tie rule + length/register delta bound; includes 200+-token turns and truncation-salvage cases | Measurable: blind preference ≥40% schema-arm (no significant loss) AND zero uncaught truncation failures; else fallback routing (§3) |
| T7 | Router/guard corpus | §7.5 fixtures + 20 additional pairs (imperative vs interrogative) incl. P5 sentence, a **polite-imperative subset** (can/could/would you + verb, please-imperatives; M1) and **task-status queries** (C3), all at the OPERATING temp (0.7; m8) | Explain-vs-do 100% on fixtures; task-status queries 100% guard-exempt; polite-imperative false-veto ≤10%; destructive never delegates unconfirmed; if routing is unstable at 0.7 → lower conversation temp (0.3–0.5) before any architecture change |
| T8 | 50-barge-in torture | Scripted barge-ins during Speaking while an unrelated OpenCode task runs | Zero OpenCode session state changes (event diff); mic closed on stop; no audio egress |
| T9 | Voice permission round trip (happy + negative) | Happy: task triggers `permission.asked` → announcement spoken → echo gate → spoken "yes". Negative: ambient noise / mis-heard audio / unrelated sentence / spoken "always" while pending | Happy: `replyPermission {once}` called; action executes; unrelated task untouched. Negative: reject or re-prompt, no execution, **and no saved allow rule created anywhere in the run** (C1) |
| T10 | Pronunciation corpus round trip | §12.5 corpus through normalizer + Kokoro → Parakeet → WER | Zero dropped tokens; per-category ≥90% |
| G1 | TOCTOU/watchdog (C5) | Fire a voice turn; start an OpenCode turn within ~200 ms | Either first SSE byte within the 4 s bound, or abort + re-park with filler/chip; no silent queueing |
| G2 | Busy-defer E2E (§11.2 scenario 2) | Occupied slot → spoken utterance | Filler speaks, utterance parks, fires on idle, answer completes; latest-utterance-wins replacement works |
| G3 | Divergence re-warm (§11.2 scenario 3) | Big OpenCode turn → voice turn → second voice turn | Turn 1 TTFT in the 3.0–3.4 s MEASURED class; turn 2 re-warm in the 0.2–0.8 s MEASURED class |
| G4 | Prefix gate uniformity (C2) | "task: delete the build directory" + a non-destructive prefix fixture | Forced-classify assigns the class; destructive hits echo-confirm; cancel delegates nothing |
| G5 | Gate echo negative path (m1) | Echo playback overlapping gate mic-open | Echo audio produces no confirm; gate waits for real input |

---

## 16. Independent Reviewer Findings

**Reviewer #2 verdict: APPROVE WITH CONDITIONS** — full report at `docs/research/2026-11-09-voice-v2-review.md` (independent re-verification: live `/slots` + `/props` against llama.cpp, live OpenCode GETs, git/tree audit of the NExus repo, Jerry `client.ts`/`sse.ts`/`types.ts` inspection; no generation probes, no POSTs, no writes outside `/tmp/opencode/`).

- **Verdict:** Option A′ stands; the evidence discipline was confirmed — 12-claim proof-label spot audit: 10 confirmed (several re-measured live), 1 label overreach (determinism "single fixture pair" — qualified in §2.3), 1 unlabeled arithmetic claim (the token budget — resolved as C4). The V1 audit was independently reproduced first-hand.
- **5 blocking conditions, ALL APPLIED in this draft:**
  - **C1** — spoken permission replies restricted to `once`/`reject`; every reply behind the closed-vocabulary echo gate; `always` reachable only via the GUI; T9 negative paths + no-saved-rule assertion (§6.2, §7.4, §13, T9).
  - **C2** — prefix delegations forced-classify (no GLM-free bypass) + mandatory session ask-ruleset at creation; no delegation path skips class assignment or the gate (§6.2, §7.2.4, §7.4, G4).
  - **C3** — state-based task-status routing with precedence over the explain-veto guard; running-session queries answered from state, never steered into the active run; L1 read-only enforcement bound in P1 via the ruleset + answer-from-context instruction (§6.2, §7.2.3, §7.5, §9.2, T7).
  - **C4** — `max_tokens` raised 240→320 (320–400 range finalized from T3's measured decode rate); wrapper-floor recount recorded; `reply` first in schema order + `maxLength` backstop; defined truncation-salvage semantics (partial reply playable, routing fails open, one freeform retry, explicit spoken failure) (§2.3, T3, T6).
  - **C5** — post-fire watchdog (no-first-byte within 4 s → abort → re-fire or re-park) closing the `/slots` admission TOCTOU; §10.2 restated as enforceable; test G1 (§10.1, §10.2, §15.3).
- **Non-blocking findings applied:** M1–M4 and m1–m15 (disposition in the Decision Ledger).
- **Gate effect:** implementation (P0) may start with this draft as the adopted spec; the reviewer's "P1 delegation scope must not begin until C1–C3 are resolved" is satisfied by these amendments.

---

## 17. Remaining Architectural Risks

| # | Risk | Likelihood | Impact | Posture |
|---|---|---|---|---|
| R1 | Single-slot contention degrades BOTH pathways; voice feels slow (3 s+) after coding sessions | High (MEASURED divergence) | Medium | Deferral-first + warmth telemetry + short turns; expectation set in §11; operator option §19c revisitable |
| R2 | sherpa-onnx 2.0.x churn (v2.0.0/2.0.1 within days; lexicon regressions like #4139) | Medium | Medium | Pin version; corpus gates upgrades; normalizer makes Jerry output-independent of frontend gaps |
| R3 | Parakeet int8 CPU latency worse than ESTIMATE on this host | Medium | Medium | T3 measures in P0; Qwen3-ASR drop-in; dictation unaffected |
| R4 | Kokoro int8 quality/TTFA through sherpa worse than ESTIMATE | Medium | Medium | T3 + corpus; Pocket fp32 fallback pre-qualified |
| R5 | Fused-schema constrains spoken style | Low–Medium | Low | T6 A/B; fallback routing defined (§3) |
| R6 | Residual explain-vs-do misclassification past the guard | Medium | High for destructive classes | Confirmation gates bound damage to an echo-confirm; verbatim transcript rides delegation; decision log for audit; fixtures in T7 |
| R7 | Echo/self-trigger in speaker mode | Medium (headphones default) | Medium | Headphones-first; PipeWire AEC; push-to-talk override ships P1 |
| R8 | OpenCode experimental endpoints drift (`log`, `wait`) | Medium | Low | Fallback: global `?types=`-filtered stream + sessionID matching (both VERIFIED); wrappers isolated in bridge module |
| R9 | Voice DSP fault takes down all of Jerry (in-process stack) | Low | High | Panic-catching task boundaries; watchdog re-init; P0 fault-injection test; dictation/live degrade independently; if P0/P1 field data shows crashes, revisit the daemon split with evidence |
| R10 | KV eviction: voice turns evict OpenCode working sets | Structural (MEASURED) | Medium | §10.3 posture; no elimination under `--parallel 1` |
| R11 | `/slots` unresponsiveness windows | Low (observed once, ~3 s) | Low | Retry loop; conservative busy posture |
| R12 | Barge-in tail perceived as "didn't cut me off" on slow output devices | Low | Low | T5 measures; buffer-size setting (underrun-caveated); push-to-talk fallback |

---

## 18. Authoritative Technical Sources

**Internal evidence (primary for V2):** `docs/research/2026-11-09-voice-v2-probes.md` (MEASURED GPU/slots/abort/TTFT/OpenCode latency) · `docs/research/2026-11-09-voice-v2-opencode-api.md` (OpenCode v2.2.5 API, VERIFIED/MEASURED) · `docs/research/2026-11-09-voice-v2-verification.md` (structured output, TTS frontends, rodio, /slots — with probe log `docs/research/2026-11-09-voice-v2-probe-results.jsonl`) · V1 appendices: `docs/research/2026-11-09-voice-stack-research.md`, `~/Documents/voice-mode-research-report.md`.

**External (pinned where it matters):**
- llama.cpp server: README (POST /v1/chat/completions; /slots incl. `?fail_on_no_slot=1`; save/restore), source `tools/server/server-common.cpp` + `common/chat-auto-parser-generator.cpp` (response_format/grammar/reasoning_budget semantics) @ master post-refactor ≈ build `b11889-d854d98ba`; discussion #13606 (`--cache-reuse` default 0).
- sherpa-onnx: crates.io/docs.rs v2.0.1; k2-fsa docs (GPU build, Kokoro/Pocket model cards); PR #4055 (espeak removal); issues #4139 (lexicon drops), #3172 (Pocket int8), #3755; `offline-tts-kokoro-impl.h`, `offline-tts-pocket-impl.h`.
- rodio v0.23.0 source: `src/player.rs`, `src/queue.rs`, `src/stream.rs` (Player rename; Done semantics; buffer arithmetic); cpal 0.18.2; ringbuf 0.6.
- OpenCode v2.2.5: embedded OpenAPI + dist source (VERIFIED labels in explore file); session-diff doc (steer-in-same-turn semantics); opencode.ai/docs/agents.
- Pipecat Smart Turn v3.2: github.com/pipecat-ai/smart-turn (BSD-2; >8 s policy); Daily.co v3 announcement; third-party eval: Evalgent turn-detector sweep 2026 (Smart Turn 35.2%/14.8% @300/600 ms; LiveKit 9.9%/4.5%) — DOCUMENTED, methodology caveats.
- Silero VAD v6.2.3 (MIT, maintainer-confirmed ONNX; badge ambiguity note stands).
- Parakeet TDT 0.6B v3 HF card (CC-BY-4.0; leaderboard 6.34%); HF Open ASR leaderboard methodology.
- Kokoro-82M (Apache-2.0; UTMOS ~4.44); VoxRT CPU TTS benchmark (author-bias noted).
- WebKitGTK media-stream status; tauri issues #8851/#2600/#13143; Handy (MIT) as Rust capture reference.
- PipeWire `module-echo-cancel` docs (Ubuntu 24.04 pipewire 1.0.5).
- End-of-turn latency trade-off literature: Deepgram/AssemblyAI/Cerebrium write-ups; arXiv 2609.11066 (prosody+silence F1 0.93 @400 ms).

---

## 19. Unresolved Operator Decisions (each with recommended default + tradeoff)

| # | Decision | Recommendation | Tradeoff / rationale |
|---|---|---|---|
| a | **Distribution/packaging** | Personal-machine AppImage; voice models **download-at-first-run** from pinned URLs with in-repo sha256 manifest + manual file-drop fallback; models live in XDG data (user-state), never in the AppImage | Download needs network once per model and a trust step (digests); bundling ~200–400 MB bloats every app update for zero benefit on known machines. If distribution beyond your machines ever happens, revisit (licensing notes + bundle-vs-download flip) |
| b | **Task-delegation phase** | **P1 gets minimal safe delegation** (prefix-routed + non-destructive schema tasks + confirmation gates + announcer + permission speaking); natural-language routing tuning stays P2 | Pro: mission headline lands a phase early; native surface makes P1 delta small; confirmation gates are cheap and safety-critical so they should not wait. Con: P1 scope grows; mitigation — delegation is independently flaggable/rollbackable |
| c | **Enable llama.cpp `--cache-reuse 256`?** | **Do not enable now.** Revisit only if P1 logs show voice-divergent TTFT is the dominant pain AND a controlled A/B (voice TTFT + OpenCode turn latency, on vs off) shows net benefit | Expected benefit for voice is likely small: `--cache-reuse` tolerates small divergences, but the voice prompt diverges from OpenCode prompts near token 0 (different system prompt/instructions) — MEASURED divergence cost is from large-prefix mismatch, not small gaps. Cost: changes the primary workload's (OpenCode's) performance profile; requires a server restart and separate operator approval. Config change — NOT part of this proposal |
| d | **Spelled-out-numbers standing prompt** | **No standing prompt.** The deterministic normalizer (§12.3) is the mechanism; a soft "prefer words over symbols when speaking" line may be A/B'd in P1 corpus testing but is not load-bearing | Researcher evidence: normalizer is deterministic and testable; prompt-hoping is neither (GLM's compliance varies per reply). A hard standing rule would constrain every reply's phrasing for a problem the TTS boundary already owns. Transcript stays natural either way |
| e | **Transcript persistence default** (new, minor) | Persist ON (90 d / 50 MB cap, clear control, opt-out toggle) | Coherent history across restarts is a feature on a single-user machine; opt-out exists for privacy-posture changes. Default-OFF would trade the feature for a principle on a machine with no other party |
| f | **Voice-tasks agent pin** (new, minor) | `build` agent, current GLM model, created with the MANDATORY ask-ruleset (§6.2); read-only enforcement via the ruleset, NOT per-class agent switching — `plan` toggling is a P2 option only, since each switch re-renders the session prompt (prefix churn + re-warm per switch, m9) | Keeps one session (context continuity per task thread); the ruleset gates mutations without prompt churn |

---

## 20. V1→V2 Change Summary

| Area | V1 | V2 | Driver |
|---|---|---|---|
| Routing | `<task>` in-band marker, regex-parsed | Fused json_schema turn + deterministic guard + ladder + confirmation gates | MEASURED schema support + explain-vs-do failure; evaluator concern 3 |
| Busy detection | `/health` | `/slots` (+`fail_on_no_slot`, warmth telemetry, retry) | MEASURED 200-while-busy |
| GPU story | "GLM on GPU 0, headroom on 1/2"; GPU Whisper P2 option | All 3 GPUs occupied (MEASURED); CPU-only as reliability doctrine; GPU Whisper dropped | Probe §1; evaluator concern 2 |
| Latency | 1.3–2.2 s median; ChatGPT north star | 2.5–3.2 s warm median (ESTIMATED, honest); 6-scenario × 3-tier model; ChatGPT comparisons removed | MEASURED TTFT; evaluator concerns 6 |
| Barge-in | "<5 ms", sink-empty = heard | Five-stage model; Player rename; ~50–100 ms audible tail; Done+pad "heard" definition; race table | rodio source VERIFIED; evaluator concern 4 |
| Smart Turn | P1 | P2 behind T1 gate; fixed-silence P1; profiles from logs | Third-party 35.2%@300 ms evidence |
| Dual runtime | "Proven in P0 spike" | UNVERIFIED → T1 at P2 gate; P0/P1 sherpa-only | Git-history audit (false claim) |
| TTS normalization | Spelled-numbers prompt rule | Mandatory deterministic normalizer + user lexicon + never-drop policy + corpus | VERIFIED #4139 |
| Task queue | Jerry-side one-deep | OpenCode native durable inbox (steer/queue/update/delete) | VERIFIED inbox semantics |
| Delegation timing | P2 | Minimal-safe in P1, full routing P2 | Evaluator 14b; native surface |
| Announcer | Global event subscription | Per-session durable log follower (+ global fallback) | VERIFIED log endpoint; 4096-overflow volatility |
| Concurrency prose | "visibility, not priority" | Full state table: idle/busy-by-OpenCode/queued/multi-request/permission/user-priority/restart; no-preemption hard rule; eviction externality quantified | Evaluator concern 5; MEASURED |
| History | Rolling 12 turns + persistence | Two-register ownership + task-state bridge + heard-content rule + read-back routing into task session | Evaluator "history coherent" mandate |
| Privacy | V1 set | + digest re-verification at load, forms handling, delegation-prompt composition rule (utterance-only), persistence opt-out decision | Evaluator concern 9 |
| Roadmap | 4 phases, spikes inside P0 | 4 phases with entry gates + exit acceptance + named tests T1–T10; uncertainty gates explicit | Evaluator concern 10 |
| Proof labels | Ad hoc | Normative vocabulary + full V1 claim audit | Evaluator concerns 11 + audit anchor |
| Reviewer #2 conditions | — | All 5 blocking conditions applied (C1 spoken-permission hardening, C2 prefix gate uniformity, C3 task-status routing precedence + bound L1 enforcement, C4 token budget + salvage semantics, C5 post-fire watchdog); M1–M4 + m1–m15 non-blocking applied; verdict recorded in §16 | Reviewer report `docs/research/2026-11-09-voice-v2-review.md` |

---

---

# ARCHITECT'S DECISION LEDGER

*(Not part of the spec — pipeline metadata for the primary agent and reviewer #2.)*

**Places I reversed or materially modified a V1 decision:**

- **Abolished the `<task>` marker** (V1 §3.5) → fused `json_schema` turn. Same GLM call count, grammar-guaranteed structure, kills the prose-leakage/spoofing class. The researcher's out-of-band-classifier idea was itself rejected because a second tiny call pays the measured ~3 s divergence tax after big OpenCode turns — the fused call keeps routing free at the margin.
- **`/health` → `/slots`** — V1's gate was broken as designed (200-while-busy MEASURED). Added warmth telemetry + conservative-busy posture on `/slots` hiccups.
- **Smart Turn demoted P1→P2**, dual-runtime coexistence demoted P0-spike→P2-gate (T1). Two birds: the third-party 35.2% false-cut number justifies the deferral, and deferring removes `ort` from P0/P1 packaging entirely — P0 becomes single-runtime, which shrinks the riskiest packaging claim to a later, better-instrumented test.
- **Relabeled V1's "proven in the P0 AppImage spike" as FALSE** — independently re-verified this session (zero spike commits/branches/stashes; grep-clean tree; only match is a prose comment in Sidebar.tsx). This is the spec's single most important integrity fix.
- **Corrected the barge-in claims**: Sink→Player rename, "<5 ms" → rodio-side-only, sink-empty → Done receiver + ≥50 ms pad.
- **Recomputed the latency headline upward** (1.3–2.2 → 2.5–3.2 s warm median) rather than defending V1's number; dropped ChatGPT comparisons per mandate.
- **GPU story rewritten**: "no spare VRAM" is imprecise — 22–27 GiB is unallocated but is GLM's growth space; I made CPU-only a reliability doctrine and dropped the GPU-Whisper P2 option V1 carried.
- **Re-timed delegation P2→P1-minimal.** The explore findings (pinning, steer/queue, permission loop already in Jerry) make the safe subset cheap; the confirmation gates are safety-critical and shouldn't wait a phase.
- **Jerry-side task queue deleted** in favor of OpenCode's durable native inbox — less Jerry state, survives restarts.
- **Answered the four operator questions with defaults**: (a) download-at-first-run hash-pinned, (b) P1-minimal delegation, (c) do NOT enable `--cache-reuse 256` (benefit for voice likely small because the voice prefix diverges near token 0; changes OpenCode's profile; needs its own A/B), (d) no spelled-numbers standing prompt — the normalizer owns it.

**What reviewer #2 should attack hardest:**

1. **The fused-schema turn is the linchpin.** If T6 shows schema-wrapping stiffens GLM's spoken register, my fallback (freeform + residual classifier on ambiguous turns only) reintroduces the +1-call eviction tax on exactly the turns that need routing. Attack the fallback's cost model.
2. **The deterministic guard's recall.** It's regex-class; I claim it + echo-confirmation bounds the explain-vs-do hazard, but I have no corpus measurement — T7 is the test, and the guard's false-veto rate (converse when the user wanted a task) is under-specified. Is the "Want me to run that as a task?" offer enough of a pressure valve?
3. **Heard-content history** drops generated-but-unheard text — I claim next-turn coherence improves; a reviewer could argue the model's own partial reasoning in the dropped text had value and that OpenCode-style "keep what was streamed" is better. I chose UX-truth over model-truth; argue with me.
4. **Warm-median honesty vs mission appetite**: 2.5–3.2 s with a 5.5–6.5 s post-coding first turn. If the operator finds that unacceptable, the only lever inside current constraints is Smart Turn (P2) and the EOT constant — neither reaches sub-2 s. Say so plainly if you disagree with shipping P1 at this profile.
5. **R9 (in-process crash isolation)** — I kept V1's in-process decision with a fault-injection test rather than reversing; if the reviewer thinks a voice DSP segfault taking down the operator's primary tool is disqualifying, the daemon split deserves a real design, not a risk-table row.
6. **Announcer on the experimental log endpoint** — durability vs the risk the endpoint changes; my fallback is defined but the primary choice leans on an `experimental/` path.

**Reviewer #2 conditions — what I changed for each:**

- **C1 — spoken permission replies hardened (§6.2, §7.4, §13, T9).** Chose vocabulary restriction over echo-protecting `always`: voice may reply `once`/`reject` only; `always` is UI-only. Justification: a mis-granted `once` is bounded (one execution, the action is spoken first, the permission engine still governs it), but `always` persists a cross-session allow rule with no voice-mode review surface — persistence asymmetry demands channel asymmetry, and no transcription-safe gate should reach a standing privilege escalation. Every spoken reply still passes the closed-vocabulary echo gate; the gate arms only after the announcement was actually spoken (M3 pairing); T9 gains negative paths with an explicit no-saved-rule assertion.
- **C2 — prefix gate uniformity (§6.2, §7.2.4, §7.4, G4).** "task:" no longer skips GLM: it fires a forced-classify turn (anchored `task.requested=true`, short-ack reply) so `kind` is always produced, with local destructive-keyword escalation that can only escalate, never de-escalate; the Voice-tasks session's ask-ruleset is now MANDATORY at creation (also the L1 backstop). Honest cost stated in-text: the prefix re-pays one warm small call — accepted deliberately so no delegation path is unclassified. The no-GLM property survives only for meta-utterances.
- **C3 — routing contradiction resolved (§6.2, §7.2.3, §7.5, §9.2, T7).** New state-based task-status rule with strict precedence over the lexico-syntactic guard: references to an existing task + no imperative-target pattern → idle = enforced read-only turn into the task session; running = state-line answer + queue offer (never steer a query into an active run). The reference/instruction separation is structural: meta-references lack a new imperative verb + resource target; "delete what the task created" carries a destructive verb+target and routes as a new instruction. L1 read-only enforcement = mandatory session ruleset + answer-from-context instruction, bound in P1 (per-turn `plan` pinning deferred to P2 per m9's prompt-churn cost). Flagship fixture made guard-consistent; T7 gains a 100% guard-exempt criterion.
- **C4 — token budget + salvage (§2.3, T3, T6).** max_tokens 240→320 initial (320–400 working range, finalized from T3's newly added measured decode rate); wrapper-floor recount recorded (~25–30 tokens ESTIMATED — the reviewer's arithmetic adopted); `reply` first in schema order + `maxLength` backstop, with the emission-order assumption labeled REQUIRES IMPLEMENTATION TEST; salvage semantics defined: incrementally parsed SSE stream, complete-`reply` → spoken + routing fails open to conversation, incomplete reply → one freeform retry at 400, then explicit spoken failure — silent whole-turn loss impossible; delegation turns flagged as most truncation-prone; determinism label qualified to "single fixture pair"; 200+-token schema turns flagged UNMEASURED until T3/T6.
- **C5 — watchdog (§10.1, §10.2, §15.3).** Post-fire no-first-byte bound of 4 s (≥ the MEASURED 3.4 s worst divergent TTFT so legitimate slow warm-ups are never aborted) → abort via §8 S2 machinery → re-fire once if idle, else re-park with filler/chip; user-visible "queued behind task" state; §10.2 restated from absolute to enforceable ("never *knowingly* queues"; race closed by the watchdog); test G1 added; m3's S4-precedes-pre-check invariant + ≤500 ms bounded 503 retry added alongside.

**Non-blocking findings — applied ALL of M1–M4 and m1–m15** (none skipped): M1 polite-imperative fixtures + defined offer continuation (T7 target false-veto ≤10%) · M2 idle cost-gate cut (idle deferral protects nothing — simplification) · M3 announcement-before-reply-gate arming · M4 §3 KV-row honesty (task session grows too; the differentiator is the small conversation prefix) + §9.3 state-line placed last in the prompt + §9.4 task-session compaction note · m1 half-duplex gate + rephrased echo ("is that right?") · m2 log re-sync anchored to the current tail, never `after=0` · m3 (folded into C5) · m4 failure-mode matrix added to §10.1 · m5 §11.2 label note · m6 G1–G5 + T3/T6/T7/T9 extensions · m7 rubato reinstated in §2.4 · m8 corpora run at operating temp + temp-lowering fallback · m9 §19f prefers the ruleset over agent toggling · m10 egress claim scoped to the audio/LLM path · m11 permission/form announcement text capped ~240 chars + markdown-stripped · m12 `requested=true, kind="none"` → conversation + log · m13 zero-heard turns insert an interrupted placeholder assistant line (template-safe alternation, never spoken) · m14 §16 verdict block · m15 honest stop-result ("Stopped; background subtasks may still be running") via read-only child-discovery GETs, full per-child interrupt stays P2.

**New attack surfaces I'd flag after these amendments:** (1) the 4 s watchdog bound vs pathological slow first tokens — false aborts on legitimately divergent-but-slow turns; the G1 corpus should include a worst-case warm-up; (2) anchoring bias — the forced-classify prompt anchors `task.requested=true`, which may inflate `kind` confidence on prefix turns; G4's non-destructive fixture checks this; (3) ruleset action-vocabulary coverage — if OpenCode's permission rule actions don't cover every mutating tool, the L1 backstop has a hole (REQUIRES IMPLEMENTATION TEST, first item of P1 delegation work).
