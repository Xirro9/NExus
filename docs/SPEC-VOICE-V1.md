# SPEC-VOICE — Jerry Live Voice Conversation: Research Findings & Architecture Proposal

**Status:** PROPOSAL — awaiting operator approval. **No implementation has been done.**
**Date:** 2026-11-09 · **Pipeline:** explore → researcher (STT/VAD) → researcher (TTS/audio/systems) → architect → reviewer (**APPROVE-WITH-CHANGES**; all required changes applied below).
**Evidence files:** `docs/research/2026-11-09-voice-stack-research.md` (raw research + reviewer verification ledger), `~/Documents/voice-mode-research-report.md` (TTS/audio stage report).

---

## 1. Executive Summary

**Recommended architecture: Option A — a native Rust voice engine inside Jerry's `src-tauri`, with a hybrid LLM path.**

One process, no new services. Audio capture stays Rust-side (`cpal`, 16 kHz mono f32 — WebKitGTK `getUserMedia` is not viable: media-stream ships disabled, no supported Tauri toggle). A single dependency (`sherpa-onnx` official crate v2.0.1, Apache-2.0) provides VAD (Silero), STT (Parakeet TDT 0.6B v3 int8), and TTS (Kokoro-82M int8); semantic end-of-turn rides Pipecat Smart Turn v3.2 (BSD-2, 8 MB int8 ONNX) through the `ort` crate; playback is Rust-side (`rodio`) so the CSP and WebKitGTK GStreamer stack are never touched. Everything voice runs on **CPU — zero VRAM, zero contention with GLM on GPU 0**.

The hybrid LLM path: **voice conversation streams directly from Jerry to llama-server** (new `voice_llm.rs` on the existing `sse_pump.rs` pattern — `api_fetch`'s 30 s buffered timeout can't stream), while **task requests are delegated to a dedicated OpenCode "Voice tasks" session** via a `<task>` marker parsed from the same GLM turn (zero extra GLM calls). Barge-in = HTTP-stream abort + `rodio::Sink::stop()` keyed by a cancellation epoch — **structurally incapable of touching any OpenCode session or background task**, which is the mission's hard constraint.

Under `--parallel 1` the system builds **visibility, not priority**: canned Kokoro fillers (no GLM cost), a one-slot pending queue with latest-utterance-wins, and `/health`-derived slot indicators. Expected speech-stop → first-audio latency **≈1.3–2.2 s median** (estimates; ChatGPT voice measures 1.3–1.5 s), with every stage instrumented in P1 before tuning.

Roadmap: **P0 dictation → P1 live MVP → P2 natural conversation + task delegation → P3 wake word/advanced audio**. The reviewer approved with 8 required changes (sherpa v2.0.x TTS-frontend reality, epoch semantics, Smart Turn >8 s policy, cache-eviction honesty, transcript persistence, Pocket fallback bundle, thread-pool pinning, permission announcer) — **all incorporated in this document**.

**Strongest alternative:** Option C (hybrid Rust + Kyutai `moshi-server`) — the most real-time-native and genuinely Rust, but its pipeline is built around Kyutai's own LLM (disqualified: GLM must stay the brain), doubles the AppImage payload, and adds a second service to babysit. Kept as a documented fallback only if sherpa-onnx Rust bindings prove unusable in P0 spikes.

---

## 2. Technology Comparison (ranked)

### 2.1 Rust speech frameworks

| Rank | Option | Verdict |
|---|---|---|
| 1 | **`sherpa-onnx` official crate v2.0.1** (k2-fsa, 2026-10-27, Apache-2.0) | VAD+STT+TTS+KWS in one dep; static CPU prebuilt by default; extremely active (v2.0.0 + v2.0.1 within 4 days); ships Tauri examples; supersedes archived `sherpa-rs`. GPU = source build (CUDA 12.8 + cuDNN 9) — not needed for v1. |
| 2 | `whisper-rs` 0.16.0 (Unlicense, CUDA feature) | Fine for P0-style batch dictation; slow-moving (last release 2026-03, now on Codeberg; crates.io is the only artifact source — pin version + checksum). |
| 3 | `ort` 2.0.0-rc.15 (ONNX Runtime 1.31, MIT/Apache-2.0) | Required for Smart Turn (sherpa doesn't ship it). rc.13+ ships CUDA-13 binaries only — irrelevant for CPU use. |
| — | `transcribe-rs` 0.3.12 (MIT) | Good batch API, single maintainer; Handy itself moved to `transcribe-cpp` — a mild divergence signal. Not needed: sherpa covers our engines. |

### 2.2 Speech recognition

| Rank | Model | License (weights) | WER (benchmark) | Streaming | Rust path | Notes |
|---|---|---|---|---|---|---|
| 1 | **Parakeet TDT 0.6B v3** (default, live + dictation) | CC-BY-4.0 | 6.34% avg (HF Open ASR leaderboard); RTFx 3,332 | TDT transducer; sherpa simulate-streaming | sherpa-onnx | Punctuation/caps built-in; **CPU-viable → zero GPU contention**; 25 EU langs |
| 2 | **Whisper large-v3-turbo q5_0** (optional P2 setting for technical vocab) | MIT | 5.8% mean (same methodology) | No — batch per utterance | whisper-rs (cuda) / sherpa | ~574 MB file, ~1.3–1.6 GB VRAM; ~0.2–0.3 s/10 s utterance on Ada-class [BENCHMARK; Blackwell UNVERIFIED]; hallucinates on silence → feed VAD-trimmed audio only; `initial_prompt` for vocab bias |
| 3 | Qwen3-ASR-0.6B (alternate) | Apache-2.0 | 6.42% (1.7B: 5.59%) | Offline only in sherpa (native streaming = vLLM-only) | sherpa-onnx | Built-in **hotwords**; drop-in if Parakeet disappoints on jargon |
| — | Moonshine v2 (watchlist) | MIT (streaming models) | Small 7.84% | Streaming-native | sherpa | Sub-150 ms latency class; keep on radar |
| — | Kyutai STT | CC-BY-4.0 | not on leaderboards | True streaming, but 2.5 s text delay (2.6b) | moshi-server | Wrong delay profile; pipeline drags in Kyutai LLM |
| — | Voxtral Realtime | Apache-2.0 | En 4.90% Fleurs @480 ms | Native streaming | **vLLM/Python only** | Ruled out (runtime) |

Benchmark-throughput vs real-world-latency caveat: RTFx 200–3,300 numbers are batch throughput; end-to-end utterance latency is what §6 budgets, and every STT number there is labeled ESTIMATE until P1 measures it.

### 2.3 VAD & end-of-turn

| Rank | Component | License | Cost | Role |
|---|---|---|---|---|
| 1 | **Silero VAD v6.2.3** | MIT (repo LICENSE verified; maintainer confirmed for the ONNX asset — residual badge ambiguity acceptable for personal use) | ~2 MB, ~190–240 µs/window [MEASURED] | Acoustic speech segmentation; sherpa-native |
| 2 | **Pipecat Smart Turn v3.2** | BSD-2-Clause (code + weights) | 8 MB int8 ONNX, 10–12 ms modern CPU [MEASURED] | Semantic "did the user finish?" — runs **only during Silero silence**, standalone via raw ORT |
| — | Ten VAD | ⚠️ Apache-2.0 **+ Agora non-compete/deployment riders** | — | Rejected: legal trap for a distributable app |
| — | LiveKit Turn Detector | Custom "LiveKit Model License" on weights | 0.5B | Rejected; v1 audio-model license unverified |

### 2.4 Text-to-speech

| Rank | Option | License | TTFA | Rust path | Notes |
|---|---|---|---|---|---|
| 1 | **Kokoro-82M int8, sentence-chunked** | Apache-2.0 (weights) | ~200–500 ms/short sentence [ESTIMATE]; whole-utterance 9.6 s/17 s text [MEASURED → chunking mandatory] | sherpa-onnx | 54 voices, UTMOS ~4.44; int8 asset confirmed (`kokoro-int8-multi-lang-v1_1`); **sherpa v2.0.x uses a lexicon frontend (espeak removed — GPL-free); see §7 risk: numbers/OOV words can be dropped (issue #4139)** |
| 2 | **Pocket TTS via sherpa — fp32 bundle** (fallback) | MIT code; CC-BY-4.0 weights (HF-gated) | 71–82 ms [MEASURED], 80 ms streaming | sherpa `pocket_tts.rs` | English-only in sherpa; **fp32 bundle required — the 98 MB int8 bundle is disqualified by upstream evidence (issue #3172: int8 causes the quality gap; fp32 "significantly improves quality")** |
| — | Linnet (watchlist) | Non-OSS weights license | 87 ms, RTF 10.6% | Rust-native | Cloning locked behind unpublished encoder; no text normalization; 5 days old at review time |
| — | Piper1-gpl | GPL-3.0+ | — | — | Rejected (contagion); piper-voices repo MIT but active package is GPL |
| — | Qwen3-TTS | Not open-weights | — | — | Rejected |

### 2.5 Audio processing

| Concern | Pick | Rationale |
|---|---|---|
| Capture | `cpal` 0.18.2 (Handy's `handy-recorder` as pattern) | WebKitGTK capture ruled out; cpal is the proven Tauri-Linux path |
| Ring buffer | `ringbuf` 0.6.0 SPSC | Lock-free; no allocation in RT callback |
| AEC | **Headphones-first; none in-app for v1.** Speaker mode = system-level PipeWire `module-echo-cancel` (verified on Ubuntu 24.04, `pactl`-loadable) | In-app WebRTC APM = C++ build burden (webrtc-audio-processing 2.1.0 exists, non-standard license) for a mode we defer |
| Noise suppress (optional) | `nnnoiseless` (Rust-native) | Only if field reports demand |
| Resampling | `rubato` 5.0.1 | `speexdsp-resampler` stale/yanked |
| Playback | `rodio` 0.23 + raw PCM (hound optional/dormant) | Zero CSP change, `Sink::stop()` <5 ms barge-in, sink-empty notifications; `<audio>` = CSP relaxation + GStreamer plugin roulette |

### 2.6 Wake word (optional, post-v1)

**sherpa-onnx KWS** (open-vocab Zipformer 3.3M, RTF 0.036, text-file keyword w/ per-word boost) if ever needed; `Rustpotter` 3.0.2 second for a branded custom word. `openWakeWord` deferred (Python-only; paid-model drift). Not a core dependency.

### 2.7 Existing voice systems & frontend

- **Pipecat / HF Speech-to-Speech:** instructive patterns (Smart Turn adopted standalone; announce/throttle concepts), Python-native — rejected as orchestration. **Handy (MIT, 38.2k★, Tauri 2):** the legitimate Rust code reference (capture, model bootstrap, hotkeys). **Open-LLM-VTuber** (license drift), **Moshi** (replaces GLM), **Voicetypr** (AGPL): rejected.
- **Frontend: build in-house.** Pipecat UI is BSD-2 and stack-compatible but binds to its transport client — patterns only. Level meter/waveform = ~100–300 LOC canvas fed by `Level` frames over `ipc::Channel` at ~30 Hz (`react-audio-visualize`'s live component needs `MediaRecorder` → incompatible with Rust-side capture).

---

## 3. Proposed Architecture

### 3.1 Diagram (single Jerry process)

```
┌──────────────────────────── Jerry (single AppImage process) ────────────────────────────┐
│                                                                                          │
│  OS audio thread                  std thread "voice-dsp"          tokio runtime (existing)
│ ┌──────────────────┐ SPSC ring  ┌───────────────────────────┐   ┌────────────────────────┐
│ │ cpal input stream│──(ringbuf)▶│ VAD (Silero, sherpa)      │   │ voice_orchestrator     │
│ │ 16kHz mono f32   │  400ms cap │ RMS level meter           │   │  (turn state machine;  │◀─┐
│ │ (device default) │            │ utterance accumulator     │   │   SINGLE WRITER to     │  │
│ └──────────────────┘            └───────────┬───────────────┘   │   rodio Sink; owns     │  │
│        ▲ device hotplug poll (2s)           │ AudioEvent         │   epoch; bump =        │  │
│        │                                    │ {Level,            │   interruption only)   │  │
│        │                                    │  SpeechStart,      └──┬──────┬────────┬───┘  │
│        │                                    │  SpeechEnd(uttId)}    │      │        │      │
│        │                                    └─(tokio mpsc)▶ ┌────────┐ ┌────┴─────┐ ┌┴────────┐
│        │                                                     │ EOT    │ │ STT      │ │ LLM     │
│        │                                                     │ Smart  │ │ spawn_   │ │ reqwest │
│        │                                                     │ Turn   │ │ blocking │ │ SSE →   │
│        │                                                     │ (ort,  │ │ sherpa   │ │ sentence│
│        │                                                     │  CPU)  │ │ Parakeet │ │ chunker │
│        │                                                     └────────┘ └──────────┘ └──┬──────┘
│        │  ┌──────────────────────────┐     ┌──────────────────────┐                  │
│ │ rodio output   │◀── clips ──│ tts_pipeline         │◀─── sentences ───┘                  │
│ │ Sink (sentence │  (ordered) │ per-sentence Kokoro  │   (mpsc to orchestrator;            │
│ │ clip queue)    │            │ spawn_blocking, CPU  │    enqueue validated by epoch)      │
│ └──────┬─────────┘            └──────────────────────┘                                     │
│        ▼ stop() = barge-in          ┌──────────────────────────────────┐                  │
│  speaker/headphone out              │ opencode_bridge                  │──────────────────┘
│                                     │ session.execution.* events →     │
│                                     │ announcer (throttled,            │
│                                     │ announce-when-quiet; permission  │
│                                     │ states are never suppressed)     │
│                                     └──────────────────────────────────┘
│  ipc::Channel<VoiceFrame> ──▶ React: voice store (zustand) → ChatPanel / Composer / LevelMeter
└──────────────────────────────────────────────────────────────────────────────────────────┘
External: llama-server (GPU 0, --parallel 1) ◀── voice conversation turns + OpenCode turns (single FIFO slot)
          OpenCode service ◀── voice-task delegation (dedicated "Voice tasks" session)
```

### 3.2 Crate assignments & thread topology

As in the diagram. Key rules:
- **RT audio callback:** zero allocation/locking; only pushes f32 into the SPSC ring.
- **Single-writer enqueue (reviewer fix):** TTS synth tasks send `{clip, sentence_index, epoch}` to the orchestrator over mpsc; **only the orchestrator validates the epoch and touches the rodio Sink** — the check-vs-enqueue race is closed by construction.
- **Epoch = cancellation generation counter, bumped only on interruption** (barge-in / turn replacement) — never on natural Thinking→Speaking transitions, which previously self-cancelled the still-streaming LLM turn (reviewer MAJOR-2).
- Two ONNX runtimes coexist (sherpa static CPU + `ort` dylib) — proven in the P0 AppImage spike, not assumed.
- **Every ONNX session is created with `num_threads = 2–4`, spin-wait disabled where exposed** (reviewer MAJOR-7 — otherwise the "<5% sustained CPU" budget is fiction on a Threadripper).

### 3.3 Model storage & bootstrap

`~/.local/share/nexus/voice/models/` (XDG data; models are user-state, not AppImage payload — the hf-hub pattern Handy uses):

| File | Size | Source |
|---|---|---|
| `silero_vad.onnx` | ~2.3 MB | sherpa release asset |
| `smart-turn-v3.2-int8.onnx` | ~8 MB | pipecat-ai HF repo |
| `parakeet-tdt-0.6b-v3-int8/` | ~0.6 GB | sherpa release tarball (model + tokens) |
| `kokoro-int8-multi-lang-v1_1/` | model ≈ 80–100 MB int8 + `voices.bin` 26 MB (v1.1) | sherpa release assets (sizes pinned at build time — reviewer MINOR-3) |
| Pocket fp32 fallback bundle | ~236 MB | only if Kokoro fails the P1 listening test |

- **No espeak-ng-data bundling** — sherpa v2.0.0/2.0.1 removed espeak-ng/piper-phonemize (PR #4055, "sherpa-onnx is GPL-free"); `data_dir` is deprecated/ignored (reviewer MAJOR-1).
- Settings PanelCard "Voice models": resumable downloads, per-model progress frames, **sha256 digests captured into the repo at pin time** (HF LFS oids are sha256; sherpa tarball digests recorded once), manual file-drop fallback.
- **Supply chain:** `sherpa-onnx-sys`'s build script downloads prebuilt static archives from GitHub at cargo-build time — vendor the archive or pin URL+digest via `SHERPA_ONNX_ARCHIVE_DIR` (reviewer MINOR-4). `whisper-rs`, if ever used: pin crates.io version + checksum only (Codeberg has no tags).

### 3.4 `ipc::Channel<VoiceFrame>` schema

```rust
enum VoiceFrame {
  State      { mode: Mode, engine: EngineState },   // off|dictation|live × idle|listening|capturing|eot|transcribing|thinking|speaking|cooldown
  Level      { rms: f32, peak: f32, speech: bool }, // coalesced ~30 Hz
  Transcript { utterance_id: u64, text: String, final: bool },   // partials throttled ~5 Hz
  Response   { turn_id: u64, delta: String, sentence_index: u32 },
  Tts        { turn_id: u64, sentence_index: u32, state: TtsChunkState },
  BargeIn    { turn_id: u64, during: EngineState },
  Queue      { llm_busy: bool, pending_turn: bool, task: Option<TaskAnnounce> },
  Models     { model: String, bytes_done: u64, bytes_total: u64, state: DlState },
  Error      { code: String, message: String, recoverable: bool },
}
```

Internal broadcast bus → one forwarder task applies coalescing (levels 30 Hz, partials 5 Hz) → single `Channel`. Frontend: pure reducer into a `nexus/voice` zustand store (vitest-testable, matches `applyEvent` pattern). No `app.emit()` anywhere — the Channel is the only push path, matching `sse_pump.rs` precedent.

### 3.5 LLM path — hybrid (direct conversation + OpenCode delegation)

- **Conversation:** `voice_llm.rs` streams `chat/completions` (SSE) from llama-server via existing `reqwest` (`json`,`stream` features already present; plain HTTP — add an assert that `NEXUS_LLM_URL` is loopback for voice). max_tokens ≈ 200; spoken-style system prompt; rolling ~12-turn history; epoch-cancellable.
- **Tasks:** the system prompt mandates that a task request is answered **only** with `<task>{"prompt": "…"}</task>`; the orchestrator delegates to a dedicated, reused "Voice tasks" OpenCode session and speaks a canned ack. **Strict whole-message matching** (`^\s*<task>\{…\}</task>\s*$`, single tag, no surrounding prose; stream truncated mid-tag → parse-failure → speak "I didn't catch that") and a **3–5-word spoken echo** of the directive ("Delegating: fix the flaky test") — reviewer MINOR-1. Fail-open: ambiguity → conversation. Explicit prefix ("task:") bypasses classification.
- **Cache honesty (reviewer MAJOR-4):** with `--cache-reuse` defaulting to 0, any voice turn fired between OpenCode turns still evicts the OpenCode prefix — the hybrid makes *voice* turns cheap; it does not protect OpenCode from eviction. Mitigations: voice turns defer to a busy slot (§5), and the operator may enable `--cache-reuse 256` on llama-server (operator decision — changes OpenCode's profile too).
- Voice threads are **Jerry-owned** and deliberately invisible to OpenCode session search (documented trade-off; reviewer concurs — mirroring would create 409 contention and double-truth).

---

## 4. Barge-In (hard-constraint design)

**States:** `Off → Listening → Capturing → EotCheck → Transcribing → Thinking → Speaking → (Barged|Cooldown) → Listening`, with an orthogonal `TaskActive` overlay that never blocks the mic.

**Epoch procedure (user speech while Speaking):**

| Step | Action | Mechanism | Budget |
|---|---|---|---|
| 1 | Stop audio | `rodio Sink::stop()` — clears queued clips + kills current | <5 ms |
| 2 | Cancel queued TTS | epoch bump; synth tasks discard on next epoch check at the orchestrator (single writer) | ≤1 wasted sentence |
| 3 | Cancel LLM stream | `AtomicBool` stop on the `voice_llm` StreamRegistry entry; stream dropped | <50 ms |
| 4 | Settle history | only fully-played sentences kept; partially-played sentence dropped entirely (never heard); zero-completed → assistant message omitted; internal `interrupted` flag for UI only | — |
| 5 | Re-arm | Cooldown 500 ms post-our-speech / 300 ms post-barge-in → Listening | 300–500 ms |
| 6 | **Never** | No OpenCode interrupt, no session DELETE, no queue mutation for ANY session. Tasks keep running; announcer goes quiet and resumes announce-when-quiet | — |

**"Heard" definition (reviewer attack):** a sentence counts as heard only when its clip **fully drained** from the sink (sink-empty notification), not when playback started — implementable unambiguously via rodio's sink-empty events.

**Echo gating:** headphones = default (no loop; software gate still armed). Speakers = PipeWire `module-echo-cancel` helper + in-app gate (≥250 ms speech above raised threshold AND (Smart-Turn-positive segment OR playing >2 s)) + Cooldown. **Push-to-talk override ships in P1** as the guaranteed fallback.

**Torture harness (P1 acceptance):** scripted 50-barge-in run asserts **zero OpenCode session state changes**, mic capture closed on `voice_stop`, and no audio leaves the process.

## 5. End-of-Turn & Concurrency

**EOT ladder (reviewer-corrected):**
1. Silero: speech start = prob ≥0.5 sustained ≥250 ms; intra-utterance pauses <400 ms never trigger.
2. Smart Turn armed after 400 ms trailing silence; decision ladder `p_complete ≥0.65 → end`, `≤0.35 → keep listening`, **uncertain band 0.35–0.65 → one more 300 ms re-check, then fixed-silence fallback**.
3. **>8 s utterances:** feed Smart Turn the **last 8 s** (official policy: truncate from the beginning, zero-pad; re-run on new speech). P1 false-cut metric computed separately for >8 s utterances.
4. Hard-cut constant is **part of the aggressiveness profile** (fast 1200 ms / balanced 1200 ms / relaxed 1800–2000 ms) — a fixed 1200 ms cut would truncate habitual 1.5 s pausers whenever the band resolves uncertain.
5. Absolute caps: utterance >30 s → force STT; Smart Turn offline → pure fixed-silence mode (degrades, never hangs). <2 s utterances resolve complete (semantic models unreliable on "yes"/"stop").
6. **JSONL decision logging from day one:** `{utterance_ms, silence_ms, p_complete, outcome, corrected_by_user}` at `~/.local/state/nexus/voice/eot.jsonl`, size-capped/rotated, timings/booleans only — no transcripts.

**Concurrency under `--parallel 1` (visibility, not priority):** llama.cpp has no preemptive priority API; OpenCode priorities are cosmetic. Voice turns are short (max_tokens ≈200) → bounded ~2–3 s cost to tasks. Before firing, orchestrator checks cached slot state (`/health` slots, ≤1 Hz while live). Busy → **canned Kokoro filler** (no GLM; filler throttled — first attempt speaks, re-parks within ~30 s update the Queue chip only) + one-slot pending queue + UI waiting chip; **latest-utterance-wins** replacement. Tasks go through OpenCode's own busy/409 discipline with a Jerry-side one-deep queue. Dictation never touches GLM.

## 6. Performance Expectations (all MEASURED vs ESTIMATE labeled; instrument P1 before tuning debates)

| Stage | Value | Class |
|---|---|---|
| Mic → ring frame | 32 ms (512 @ 16 kHz) | structural |
| Silero inference | ~0.2–0.3 ms/window | MEASURED |
| Speech-start confirmation | 250 ms | TUNABLE |
| Trailing silence before EOT arm | 400 ms | TUNABLE |
| Smart Turn inference | 10–60 ms | MEASURED |
| Uncertain-band recheck | 0–300 ms (p90) | TUNABLE |
| STT (Parakeet int8, CPU, 5 s utt) | ~0.1–0.2 s | ESTIMATE (verify P1) |
| GLM TTFT (warm cache, ~1–2 k prefix) | ~200–500 ms | ESTIMATE (instrument P1 — biggest unknown) |
| First-sentence accumulation | ~0.3–0.7 s | ESTIMATE |
| Kokoro TTFA (short sentence, int8, CPU) | ~200–500 ms | ESTIMATE (whole-utterance 9.6 s/17 s is MEASURED → chunking mandatory) |
| Playback prefill | 100–150 ms | TUNABLE |
| **Total: speech-stop → first audio (median)** | **≈1.3–2.2 s** | ESTIMATE composite (north star: ChatGPT median 1.3–1.5 s MEASURED) |
| Worst case (slot busy) | filler ~0.5 s; real answer bounded by running turn | surfaced, never silent |

## 7. Resource Allocation

| Component | Where | Footprint |
|---|---|---|
| GLM | GPU 0 — untouched | existing |
| Silero / Smart Turn / Parakeet / Kokoro | **CPU** | ≤ ~1.5 GB RSS total (0.6 GB Parakeet + 0.3–0.5 GB Kokoro + runtimes/buffers) — **P0 spike must measure it**; int8-halving assumption is unproven (int8 cuts weights, not activations) |
| Threads | every ONNX session pinned `num_threads 2–4`, spin-wait off | sustained <5% CPU, bursts 1–2 cores (only credible WITH pinning) |

**GPU 1/2 offload: rejected for v1** (CUDA 12.8 + cuDNN 9 userspace inside the AppImage = +2–3 GB payload + driver fragility; CPU already fits the budget). Revisit only if P1 MEASURED numbers violate §6. **GPU-0 Whisper-turbo option (P2):** gated behind a setting; STT naturally runs during silence while GLM is idle, so contention is structurally low.

## 8. OpenCode Integration

| Concern | Design |
|---|---|
| Conversation transcript | Jerry-owned, "Voice" thread in ChatPanel; **persisted on disk** at `~/.local/state/nexus/voice/transcripts/*.jsonl` (per session), retention cap ~50 MB / 90 days, "clear voice history" control, load-on-start (reviewer MAJOR-5 — zustand/localStorage are not a persistence backend) |
| Dictation | capture → VAD trim → STT → Composer input (user reviews, sends manually); zero OpenCode interaction; usable while tasks run |
| Mode switch | mic button in Composer's send/interrupt row; `off → dictation → live`; **entering `live` is a deliberate second step** (long-press or confirmation — a misclick must not enable always-on mic); keyboard-operable with aria-labels; engine-state chip (`listening/thinking/speaking/waiting`); first-run **consent chip** before live mode (continuous mic); `nexus.voice.*` localStorage for settings only |
| Task delegation | dedicated "Voice tasks" session; `<task>` strict parsing; canned ack + spoken echo; 409 → "previous task still running" + one-deep queue |
| Spoken progress | driven by existing `session.execution.*` subscription: started (canned) / **permission-requested ("The task needs your approval" — never suppressed by announce-when-quiet; approval always via Jerry's existing permission UI; voice never auto-approves)** / succeeded ("Done." + first ~240 chars markdown-stripped) / failed (canned + error first line). Throttle ≤1 spoken update/10 s; phase transitions only; announce-when-quiet (user silent ≥3 s) |
| What voice never does | interrupt/delete/truncate any session; prompt busy sessions directly; touch llama-server for anything but conversation turns |

## 9. Security & Privacy

- **Mic lifecycle:** capture open only in dictation/live; `voice_stop` closes the cpal stream (asserted by test); Jerry shows its own state chip (Ubuntu's OS mic indicator is the backstop); consent chip gates live mode.
- **Audio retention:** utterance buffer RAM-only, 30 s cap, dropped at turn end; nothing written to disk except the user-visible transcript JSONLs (retention-capped) and the EOT decision log (no transcripts).
- **Local-only:** zero cloud calls; voice LLM path asserts loopback URL (reqwest built without TLS — a feature here); no audio leaves the process (torture-harness assertion).
- **Supply chain:** sha256 digests pinned in-repo at spec time; sherpa-onnx-sys build-time fetch vendored or digest-pinned; model downloads resumable + digest-verified.
- **IPC surface:** one new Channel + commands following the existing `is_allowed_path`-style validation discipline; no new capabilities beyond what voice commands need.
- **Injection:** spoken `<task>` text is user intent (same as typing it) and still passes OpenCode's permission gates; document-content `<task>` spoofing blocked by strict whole-message matching.

## 10. Implementation Roadmap

**P0 — Dictation (foundation + packaging spike)**
- Deliver: `voice_capture.rs` (cpal + ringbuf + hotplug), sherpa + Silero + Parakeet bootstrap + models PanelCard, Composer mic button (`off|dictation`), voice store + reducer, level meter; ONNX thread-pool pinning from the first session created.
- Spikes inside P0: AppImage sherpa static-link + `ort` dylib coexistence; RSS/cores measurement; Smart-Turn-via-`ort` parity.
- Accept: 10 s utterance → Composer text ≤1.5 s p50 (MEASURED); zero GLM/GPU usage (telemetry-asserted); BT hotplug recovery ≤2 s; mic closed on toggle-off (test); vitest reducer suite + `#[cfg(test)]` VAD/trim tests + `#[ignore]` live-mic harness.

**P1 — Live voice MVP**
- Deliver: `voice_llm.rs` (sse_pump pattern), sentence-chunked Kokoro + rodio single-writer pipeline, epoch barge-in + Cooldown, EOT ladder w/ JSONL logging, fillers + `/health` slot poll + waiting chip, full `VoiceFrame` schema, live transcript panel, push-to-talk override.
- Accept: speech-stop → first audio ≤2.5 s p50 MEASURED (stretch 1.8 s); barge-in audio-stop ≤200 ms MEASURED; **50-barge-in torture harness: zero OpenCode session state changes**; 30-min soak RSS growth <10%; EOT false-cut <10% (and computed separately for >8 s utterances); **Kokoro lexicon listening test incl. numbers/paths/code terms** (issue #4139 is a first-class failure mode — spelled-out-numbers system-prompt rule ships here).

**P2 — Natural conversation**
- Deliver: EOT tuning from logged data; speaker-mode profile + PipeWire echo-cancel helper; `<task>` delegation + announcer (incl. permission states) + voice-task session; on-disk transcript persistence + retention; rolling history + summary compaction; Whisper-turbo-GPU optional setting behind `SttEngine` trait; aggressiveness settings.
- Accept: false-cut <5% on corpus; delegation round trip with an unrelated running task untouched; speaker self-trigger ≈0 with echo-cancel.

**P3 — Advanced**
- Wake word (sherpa KWS; false-wake <1/h before default-on), global hotkey plugin, GPU-1 offload (only if budgets violated), in-app AEC re-evaluation (only if PipeWire path insufficient).

## 11. Alternatives Rejected

- **Option B (Pipecat/HF-s2s sidecar):** Python banned by mission; AppImage+Python+audio is the classic reliability quagmire; zero capability beyond verified crates. Patterns reused instead (Smart Turn standalone, announcer throttling).
- **Option C (Kyutai moshi-server):** most real-time-native and Rust, but the pipeline's brain is Kyutai's LLM (disqualified — GLM must stay), second service + ~2 GB weights, doubled AppImage. **Kept as documented fallback** if sherpa bindings fail P0 spikes.
- **Option D (separate voice daemon):** crash isolation not worth stale-daemon failure modes, IPC auth surface, second binary; in-process recovery on the StreamRegistry pattern suffices.
- **Webview mic capture (`getUserMedia`):** WebKitGTK ships media-stream off; no supported Tauri toggle; upstream WebRTC/WebAudio unfinished; Handy proves the Rust-side path.
- **Webview `<audio>` playback:** CSP relaxation + GStreamer plugin roulette + racy 50–200 ms stop; rodio gives <5 ms deterministic stop and sink-empty events.
- **Ten VAD** (Agora license riders), **LiveKit EOT** (custom weights license), **Voxtral Realtime + native-streaming Qwen3-ASR** (vLLM-only), **Moshi** (replaces GLM), **piper1-gpl** (GPL-3.0+), **Open-LLM-VTuber** (license drift), **Voicetypr** (AGPL), **Qwen3-TTS** (not open-weights), **Linnet** (non-OSS weights, watchlist only).
- **GPU-first voice stack:** CUDA-in-AppImage cost/fragility for latency we don't need yet (§6/§7).

## 12. Reviewer Findings (gate result: APPROVE-WITH-CHANGES)

**Verification:** 15 load-bearing claims independently spot-checked against live sources; 13 confirmed outright. Corrections found and applied: sherpa v2.0.x removed espeak-ng (GPL-free; lexicon frontend; `data_dir` ignored; issue #4139 numbers/OOV regression) — MAJOR-1; epoch bumped only on interruption + single-writer enqueue — MAJOR-2; Smart Turn >8 s official policy adopted + hard-cut in aggressiveness profile — MAJOR-3; residual cache-eviction honesty + optional `--cache-reuse 256` — MAJOR-4; on-disk transcript persistence specified — MAJOR-5; Pocket fallback re-pointed at fp32 bundle (int8 disqualified by issue #3172) — MAJOR-6; ONNX thread-pool pinning requirement — MAJOR-7; permission-requested announcer state — MAJOR-8. MINOR-1–5 applied (strict `<task>` matching + spoken echo, filler throttle, manifest size corrections, supply-chain pinning incl. sherpa-onnx-sys build-time fetch + loopback assert, privacy additions: EOT-log location/rotation, consent chip, mic-closed test, no-audio-leaks assertion). NOTES: Silero ONNX badge ambiguity acceptable for personal use; hound dormant but optional (raw PCM suffices); whisper-rs supply chain = crates.io only.

**Unresolved questions for the operator:**
1. Will Jerry ever be distributed beyond your machines? (Decides weight of licensing notes; whether the GPL external-phonemization escape hatch needs pre-building.)
2. Is deferring `<task>` delegation to P2 acceptable, or should it swap ahead of Smart-Turn tuning? (Mission lists it as a headline feature; P1 acceptance doesn't cover it.)
3. Enable `--cache-reuse 256` on llama-server once voice ships? (Changes OpenCode's performance profile too.)
4. Accept the spoken-register constraint ("spell out numbers/paths in live mode") as a standing GLM instruction? (Cheapest mitigation for the v2.x lexicon regression; shapes every spoken reply.)

## 13. Sources (primary)

- sherpa-onnx: https://crates.io/crates/sherpa-onnx · https://docs.rs/sherpa-onnx · https://github.com/k2-fsa/sherpa-onnx/releases · GPU build: https://k2-fsa.github.io/sherpa/onnx/install/linux.html · PR #4055 (espeak removal) · issue #4139 (lexicon numbers/OOV) · issue #3172 (Pocket int8 quality)
- sherpa-rs (archived): https://github.com/thewh1teagle/sherpa-rs
- whisper-rs: https://crates.io/crates/whisper-rs · https://codeberg.org/tazz4843/whisper-rs (+ issue #226)
- ort: https://lib.rs/crates/ort · https://ort.pyke.io/perf/execution-providers
- Whisper: https://github.com/openai/whisper/discussions/1783 (hallucination) · https://huggingface.co/openai/whisper-large-v3-turbo
- Parakeet TDT 0.6B v3: HF model card (CC-BY-4.0, 6.34% leaderboard) · https://catalog.ngc.nvidia.com (NeMo-Speech.cpp)
- Smart Turn: https://github.com/pipecat-ai/smart-turn (BSD-2, >8 s truncation policy) · https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/
- Silero VAD: https://github.com/snakers4/silero-vad (LICENSE MIT; discussion #817 badge question)
- Ten VAD license: https://raw.githubusercontent.com/TEN-framework/ten-vad/main/LICENSE · https://github.com/TEN-framework/ten-vad/issues/9
- Kokoro: k2-fsa sherpa TTS docs (int8 asset, 24 kHz) · kokoro HF card (Apache-2.0)
- Pocket TTS: sherpa `pocket_tts.rs` docs · HF gated card (CC-BY-4.0)
- Handy (reference impl): https://github.com/cjpais/Handy (MIT) · https://crates.io/crates/handy-recorder · https://crates.io/crates/handy-cpal
- WebKitGTK: https://webkitgtk.org · https://docs.rs/webkit2gtk (enable-webrtc) · https://github.com/tauri-apps/tauri/issues/8851 · https://v2.tauri.app/develop/debug/linux-graphics/
- PipeWire AEC: https://docs.pipewire.org (module-echo-cancel)
- LiveKit turn detector: https://huggingface.co/livekit/turn-detector · https://livekit.com/blog/solving-end-of-turn-detection
- Pipecat: https://github.com/pipecat-ai/pipecat (BSD-2)
- Full research reports with per-claim labels: `docs/research/2026-11-09-voice-stack-research.md`, `~/Documents/voice-mode-research-report.md`
