# 2026-11-09 — Voice Stack Research (raw evidence appendix for SPEC-VOICE.md)

Pipeline: researcher A (STT/VAD/EOT/platform) → researcher B (TTS/audio/systems/frontend) → reviewer (15-claim verification). Claims are labeled VERIFIED-FACT / BENCHMARK / ESTIMATE / UNVERIFIED in the source reports.

---

# PART 1 — Researcher A: STT + VAD/EOT + platform

# STT + VAD/EOT Research Report (Researcher A) — 2026-11-09

All version numbers/licenses verified against live sources. Legend: [VERIFIED-FACT] / [BENCHMARK] / [ESTIMATE] / [UNVERIFIED].

## PART 1 — Rust Speech Frameworks

### sherpa-onnx official crate (k2-fsa)
- Official crate exists — `sherpa-onnx` + `sherpa-onnx-sys`, v2.0.1, published 2026-10-27. https://docs.rs/sherpa-onnx · https://crates.io/crates/sherpa-onnx [VERIFIED-FACT]
- `sherpa-rs` (thewh1teagle) archived 2026-06-06, read-only; README: "Deprecated… upstream now provides an official Rust API". https://github.com/thewh1teagle/sherpa-rs [VERIFIED-FACT]
- License Apache-2.0. [VERIFIED-FACT]
- Linking: static by default (build script auto-downloads matching prebuilt `-static-lib` archive); opt-in `shared` feature; `SHERPA_ONNX_LIB_DIR` / `SHERPA_ONNX_ARCHIVE_DIR` overrides. [VERIFIED-FACT]
- onnxruntime v1.28.2 since sherpa v1.13.8. [VERIFIED-FACT]
- GPU builds: CUDA 12.8 + cuDNN 9 (`-DSHERPA_ONNX_ENABLE_GPU=ON`); prebuilt GPU bundle `sherpa-onnx-v2.0.1-cuda-12.x-cudnn-9.x-linux-x64-gpu.tar.bz2`. ORT ≥1.27 GPU packages default to CUDA 13. [VERIFIED-FACT] https://k2-fsa.github.io/sherpa/onnx/install/linux.html
- GPU via the Rust crate: default prebuilt static/shared archives are CPU; GPU on Rust side means building from source (or extracting GPU tarball) and pointing SHERPA_ONNX_LIB_DIR. [ESTIMATE]
- Models: Whisper, Moonshine v1/v2, Qwen3-ASR, SenseVoice, Paraformer, Canary, NeMo Parakeet TDT/CTC (incl. `parakeet_tdt_simulate_streaming_microphone.rs`), FireRedASR, FunASR Nano, Zipformer (streaming), WeNet, Dolphin, MedASR, Omnilingual, Nemotron-3.5-ASR-streaming-0.6b. TTS: Kokoro, Matcha, VITS, Kitten, Pocket TTS, Supertonic, ZipVoice (piper-phonemize removed from lib in v2.0.0). VAD: Silero + Ten VAD. [VERIFIED-FACT]
- Very active: v2.0.0 2026-10-23, v2.0.1 2026-10-26; ships Tauri examples (`tauri-examples/app.md`). Hallucination-on-silence fixes for Moonshine v2 (#3923), Qwen3-ASR (#3907). [VERIFIED-FACT]

### whisper-rs (tazz4843)
- v0.16.0 (2026-03-12); repo moved to Codeberg (GitHub stale mirror). License Unlicense. Features cuda/hipblas/vulkan/metal/openblas. [VERIFIED-FACT]
- whisper.cpp pin inside whisper-rs-sys UNVERIFIED. Last release ~8 months ago; alive but slow. [VERIFIED-FACT/UNVERIFIED mix]
- Known perf bug class: "x10 slower in release build" (issue #226, workaround documented). [VERIFIED-FACT]
- Alternative: `whisper-cpp-plus` — safe bindings, real-time PCM streaming + VAD, whisper.cpp 1.8.3. [VERIFIED-FACT]

### transcribe-rs (cjpais)
- v0.3.12 (2026-10-02), MIT. Backends: ONNX (SenseVoice, GigaAM, Parakeet, Moonshine) via ort rc.12; Whisper via whisper-rs 0.16; batch-oriented API. Handy itself moved to `transcribe-cpp` (GGML/GGUF; what Handy 0.10 ships). [VERIFIED-FACT]

### ort (pyke.io)
- 2.0.0-rc.15 (2026-10-19), wraps ONNX Runtime 1.31, MIT/Apache-2.0, ~958k dl/week. rc.13+ ships CUDA 13 binaries only; CUDA 12 users must supply own ORT build (CUDA 12.8 + cuDNN 9). [VERIFIED-FACT]
- Real dictation apps built on ort+Parakeet+Silero: SilentKeys, Murmure. [VERIFIED-FACT]

### Other crates
- `parakeet-rs` 0.4 (ort-based, cuda/tensorrt/burn EPs) + 0.3.6 line supporting Nemotron-3.5-ASR-streaming. [VERIFIED-FACT]
- `parakeet.cpp` / NVIDIA official `NeMo-Speech.cpp` runtime + official q8_0 GGUFs; community mudler/parakeet.cpp has C API. [VERIFIED-FACT]

## PART 2 — STT Models

| Model | License (weights) | Params/VRAM | WER (benchmark) | Streaming | Rust path | Notes |
|---|---|---|---|---|---|---|
| Whisper large-v3-turbo | MIT | 809M; GGML fp16 1.62GB; q5_0 ≈574MB file; peak VRAM ~1.3–1.6GB int8 | 5.8% mean (Open-ASR-leaderboard methodology); RTFx ~216 | No (batch, 30s window; simulate-streaming only) | whisper-rs(cuda)/sherpa/whisper-cpp-plus | Multilingual; known silence hallucinations; initial_prompt supported |
| Parakeet TDT 0.6B v3 | CC-BY-4.0 | 0.6B; ~2GB RAM load; int8 ONNX ≈0.6–0.7GB | 6.34% avg (HF Open ASR Leaderboard) | TDT transducer; NeMo chunked streaming; sherpa "simulate streaming" mic examples | sherpa-onnx, parakeet-rs, ort | 25 European langs, auto lang-ID, punctuation+caps built-in; released 2025-08-14 |
| parakeet-unified-en-0.6b (2026) | NVIDIA Open Model License (not CC-BY) | 0.6B; Q8_0 GGUF 731MB (Handy ships) | unified offline+streaming | True unified streaming+offline | GGUF runtimes; sherpa export UNVERIFIED | English-only; Handy's recommended model |
| Nemotron 3.5 ASR Streaming 0.6B | OpenMDW-1.1 (permissive) | 0.6B | 40 language-locales | Streaming-native | sherpa ONNX export; parakeet-rs 0.3.6 | Newest |
| Moonshine v2 | MIT for all streaming models/sizes; legacy non-streaming non-English stay Moonshine Community License | tiny-streaming ~34M, small ~123M | v2 paper: 50ms (Tiny)/148ms (Small) per-chunk; Small Streaming 7.84% WER, Tiny 12.0% | Streaming-native (ergodic encoder) | sherpa moonshine_v2.rs; transcribe-rs | arXiv 2602.12241 |
| Kyutai STT (delayed streams) | Weights CC-BY-4.0; Python MIT; Rust backend Apache-2.0 | 1B en_fr / 2.6b-en | Fleurs-class; not on leaderboard [UNVERIFIED WER] | True streaming; text delay 0.5s (1B) / 2.5s (2.6b) | Rust moshi-server --features cuda | Built-in VAD head (EOT prob); 2.6b delay too big |
| Voxtral Realtime (Mini-4B-Realtime-2602) | Apache-2.0 | 4B; 8.87GB fp16 | Fleurs 8.72% @480ms (En 4.90%); GigaSpeech-2k 7.35% | Native streaming 240ms–2.4s delay | None Rust-native (vLLM/mistral-common; community ONNX port exists) | 13 langs; wrong runtime for Rust-only |
| Qwen3-ASR 0.6B/1.7B | Apache-2.0 | 0.6B (0.9B BF16) / 1.7B | 0.6B 6.42%; 1.7B 5.59% (HF Open ASR Leaderboard); RTFx 166 | Offline/streaming unified BUT official streaming only via vLLM | sherpa OfflineQwen3ASRModelConfig + simulate-streaming | 30 langs; hotwords |

- Whisper silence hallucination documented cross-version; mitigations: VAD-filter first, condition_on_previous_text=False, no_speech_threshold, hallucination_silence_threshold. [VERIFIED-FACT] https://github.com/openai/whisper/discussions/1783
- initial_prompt works in whisper.cpp/HF. [VERIFIED-FACT]
- RTFx 200–3,300 = batch throughput ≠ latency. End-to-end 5–15s utterance on RTX 6000 Ada-class: turbo int8 peak 1.3GB, RTF ~50x → ≈0.2–0.3s compute. [BENCHMARK] On RTX PRO 6000 Blackwell specifically: UNVERIFIED; ESTIMATE ~150–400ms for 10s q5_0 utterance.
- HF Open ASR leaderboard top 2026: Canary-Qwen 2.5B 5.63%, Parakeet-TDT-0.6B-v3 6.34%, Qwen3-ASR 5.59–6.42%, Whisper turbo ~5.8%. [BENCHMARK]

## PART 3 — VAD & Turn-Taking

| Component | Version | License | Size/cost | How | Rust path |
|---|---|---|---|---|---|
| Silero VAD | v6.2.3 current (v6.2.1 Feb 2026 made ORT optional) | MIT — maintainer-confirmed on the v6.2.3 ONNX file specifically (badge alt-text says CC-BY-NC but maintainer answered "MIT", Oct 25 2026) | ONNX ~1.3–2.3MB, 310K params; ~189–240µs/chunk median CPU | Acoustic speech prob per 32/64ms chunk; recurrent state = streaming | sherpa SileroVadModelConfig; or raw ort |
| Pipecat Smart Turn | v3.2 | BSD-2-Clause "truly open" (code + weights) | 8MB int8 CPU / 32MB GPU ONNX | Semantic: audio→"did user finish?" over ≤8s context; runs only during Silero silence | Standalone ONNX via raw ORT (repo ships inference.py using raw ORT) → portable to ort in Rust |
| Smart Turn latency | 10–12ms modern CPU; 60ms cheap AWS vCPU; 3.3ms L40S [BENCHMARK incl. preprocessing]; 23 languages | | | | |
| Ten VAD | current | ⚠️ NOT plain Apache-2.0: Apache-2.0 + riders (no competing-with-Agora deployment; own-benefit-only deployment; derivatives bound). Issue #9 confirms deliberate. | tiny, low-latency | Acoustic | sherpa TenVadModelConfig |
| LiveKit Turn Detector | text v0.4.x; v1.0 audio-based (2026) | Text model: "LiveKit Model License" (custom); plugin code Apache-2.0. v1 audio license UNVERIFIED | 0.5B Qwen2.5-0.5B-FT, INT8 ONNX, <500MB RAM, CPU | Text variant semantic P(<|im_end|>) over 6 turns/128 tokens; v1 fused semantic+acoustic; false-cutoff 9.9% vs 12.9% next-best | Python/Node plugin; ONNX loadable from Rust but license review needed |

- Silero false triggers: music/TV noise; mitigation = threshold + min_speech/min_silence knobs (sherpa exposes exactly these). [ESTIMATE from docs + practice]

## PART 4 — Platform (Tauri 2 Linux / WebKitGTK)
- WebKitGTK ships media-stream disabled by default: "navigator.mediaDevices does not exist at all". [VERIFIED-FACT] https://github.com/rcq-messenger/rcq-desktop/blob/main/DESKTOP.md
- webkitgtk.org: "Currently we are working to finish support for WebAudio and WebRTC." [VERIFIED-FACT]
- WebKitSettings:enable-webrtc exists (≥2.42) but Tauri/wry exposes no supported toggle; people patched runtime config themselves (KittyCAD); tauri issue #8851 unresolved. [VERIFIED-FACT]
- Handy maintains three WebKit renderer workarounds incl. per-version WEBKIT_DMABUF_RENDERER; stopped listening for SIGUSR1 (WebKitGTK uses it for JS GC — phantom recordings). [VERIFIED-FACT]
- AudioWorklet in WebKitGTK: treat as UNVERIFIED/unreliable. Playback rides GStreamer (gst-plugins-good/bad/ugly on user machine). [VERIFIED-FACT + ESTIMATE]
- Handy (38.2k★, MIT) production pattern: capture Rust-side cpal (`handy-recorder` = "Simple cross-platform microphone capture for Rust. Extracted from Handy… Opens a mic at whatever format the OS has it set to" → 16kHz mono f32, official push_to_talk example; underlying handy-cpal cpal fork with pipewire/pulseaudio features). Playback rodio+symphonia. VAD Silero Rust-side. STT transcribe-cpp (GGUF: ggml-large-v3-turbo.bin 1600MB, ggml-large-v3-q5_0.bin 1100MB, parakeet-unified-en-0.6b-Q8_0.gguf 731MB). Linux backends: dynamic-backends + Vulkan (not CUDA). Models via hf-hub (cjpais fork, cancellable). Hotkeys: tauri-plugin-global-shortcut + rdev. [VERIFIED-FACT]

## PICKS (Researcher A)
1. Whisper large-v3-turbo q5_0 via whisper-rs(cuda) — P0 dictation (batch-per-utterance ideal for push-to-talk; initial_prompt vocab bias; VAD-trimmed audio only).
2. Parakeet TDT 0.6B v3 int8 ONNX via official sherpa-onnx — P1 live (CC-BY-4.0, 6.34% WER, punctuation built-in, CPU-viable → zero GPU contention).
3. Qwen3-ASR-0.6B via sherpa — accuracy/hotword alternate (Apache-2.0).
Watchlist: Nemotron 3.5 ASR Streaming 0.6B, Moonshine v2. Ruled out: Voxtral Realtime, native-streaming Qwen3-ASR (vLLM/Python).

VAD/EOT PICK: Silero VAD v6.2.3 (MIT, sherpa) + Pipecat Smart Turn v3.2 (BSD-2, 8MB int8, 10–65ms CPU, standalone during Silero silence). Avoid Ten VAD (license riders); skip LiveKit (weights license).

CAPTURE VERDICT: Rust-side cpal — do NOT use webview getUserMedia (WebKitGTK media-stream off by default, no supported toggle, Handy proves Rust-side pattern).

## Could not verify
- whisper.cpp version pinned in whisper-rs 0.16.0 sys crate.
- Published Whisper latency on RTX PRO 6000 Blackwell specifically.
- Whether sherpa-onnx Rust crate can consume prebuilt GPU archive without source build.
- sherpa-onnx compatibility with Silero v6.x ONNX specifically (sherpa ships its own v4/v5 exports).
- LiveKit Turn Detector v1 (audio) weight license.
- Kyutai STT WER on standard benchmarks.
- AudioWorklet reliability in webkit2gtk-4.1 Ubuntu 24.04.

---

# PART 2 — Researcher B: TTS + audio processing + systems + frontend

# Jerry Voice Mode — Research Report: TTS, Echo Cancellation, Wake Word, Frameworks, Frontend

**Date:** 2026-11-09 · **Scope:** Stage-2 voice research for Jerry (Nexus, Tauri 2 + Rust, Ubuntu 24.04, 3× RTX PRO 6000, GLM/llama.cpp owns GPU 0 with `--parallel 1`)
**Constraints honored:** fully local, Rust-first (no Python services), voice must not starve GLM's GPU.
**Labels:** [VERIFIED-FACT] confirmed from a primary source (repo/API/official docs) · [BENCHMARK] measured number, see caveats · [ESTIMATE] derived, not measured · [UNVERIFIED] could not confirm — treat as hypothesis.
Stage-1 decisions are assumed settled and only referenced: cpal Rust-side capture (WebKitGTK getUserMedia not viable), Silero VAD v6.2.3 + Smart Turn v3.2 for EOT, STT via sherpa-onnx official crate v2.0.1 / whisper-rs, Handy as reference app.

---

## PART 1 — Text-to-Speech comparison

### Comparison table

| Model | License (code / weights) | Size & RAM | Latency to first audio | Streaming | Rust path | Voices | Flags |
|---|---|---|---|---|---|---|---|
| **Kokoro-82M v1.0** | Weights Apache-2.0 [VERIFIED-FACT]; community Rust code MIT; **phonemizer dep espeak-ng is GPLv3** [VERIFIED-FACT] | 82M params; 326 MB fp32 ONNX + 28 MB voices [VERIFIED-FACT]; ~1 GB RAM (HF card) [VERIFIED-FACT]; **1,246 MB peak RSS measured via Python fp32** [BENCHMARK] | Whole-utterance per call: 1.5 s (short) / 9.6 s (17 s paragraph), 1 thread [BENCHMARK]; sentence-split brings TTFA down to ~short-text figure [ESTIMATE]; RTF 51.7% 1-thread / 17.2% 4-thread [BENCHMARK] | No native streaming — `kokoro-onnx` `create_stream` yields a single chunk [BENCHMARK] | **sherpa-onnx official Rust crate** (kokoro example) or kokoro-onnx / tts-rs crates [VERIFIED-FACT] | 54 voices, 8 languages (`af_heart`…), UTMOS ~4.44 [VERIFIED-FACT] | espeak G2P artifacts (‖ markers, stress digits), number/contraction mispronunciations [VERIFIED-FACT]; int8 was *slower* than fp32 on the tested CPU [BENCHMARK]; espeak GPLv3 licensing consideration |
| **Kyutai Pocket TTS 4.0.1** | Code MIT; **weights CC BY 4.0**; HF repo **gated** (accept terms) [VERIFIED-FACT] | 100M params; 236 MB [BENCHMARK]; 968 MB RSS via Python [BENCHMARK] | **71 ms / 82 ms** first audio (runs on 2 cores by design) [BENCHMARK]; RTF 23.8% (2 cores) [BENCHMARK] | **Yes — 80 ms frames** [VERIFIED-FACT] | **sherpa-onnx pocket bundle** (English, Jan 2026, int8 98 MB) incl. `pocket_tts.rs` Rust example [VERIFIED-FACT]; newer Kyutai exports NOT supported (open issue #3755) [VERIFIED-FACT]; sherpa-vs-Python quality mismatch reported (#3172, closed) [VERIFIED-FACT] | Voice cloning via voice prompts (`alba`…) [VERIFIED-FACT] | English-only inside sherpa bundle; gated download complicates automated model fetch; quality caveat above |
| **Linnet `linnet-en-35m`** | Code Apache-2.0; **weights under "Linnet Weights License 1.0" — NOT open source** (free commercial use of *unmodified weights* + 2 built-in voices in your own products; cloning/custom voices, fine-tuning, training on outputs, general-purpose TTS services need a separate license) [VERIFIED-FACT] | 41M params (31M trunk + 9.9M decoder); 79–83 MB fp16; **187 MB RSS** [BENCHMARK] | **87 ms / 133 ms**; RTF **10.6%** 1-thread / 3.4% 4-thread; per-step 5.5 ms iPhone 13 Pro Max [BENCHMARK] | **Yes — 80 ms steps** [VERIFIED-FACT] | Runtime *is* Rust (`linnet-ops`/`linnet-tts` crates, Linux C `.so` binding) — but **no sherpa-onnx support** [VERIFIED-FACT] | 2 built-in voices; cloning requires VoxRT's **unpublished encoder** + separate license [VERIFIED-FACT] | English only; **no text normalization — "write numbers as words"** [VERIFIED-FACT]; v0.1.1 released 2026-11-04 — 5 days old, single vendor; per-session prime pass re-computes ~60 ms voice prefix (KV-cache reuse promised next release) [VERIFIED-FACT] |
| **Piper** | Original rhasspy/piper **archived 2025-10-06** (MIT) [VERIFIED-FACT]; active OHF-Voice/piper1-gpl is **GPL-3.0-or-later** (v1.8.0, seeking maintainers) [VERIFIED-FACT] | 16–28M per voice; 64–114 MB [BENCHMARK] | 180 / 283 ms (medium); RTF 5.8% / 2.1% [BENCHMARK] | Per sentence [BENCHMARK] | No official Rust crate; Rust wrappers would track the GPL package [ESTIMATE] | One model per voice, many languages; voices per-voice licensed [VERIFIED-FACT] | **GPL contamination risk vs Jerry's Apache-2.0** |
| **Qwen3-TTS (0.6B/1.7B)** | Weights Apache-2.0 [VERIFIED-FACT] | ~2.5–4.5 GB [VERIFIED-FACT] | 97–101 ms first-packet (vendor claim) [VERIFIED-FACT] | Yes (claim) [VERIFIED-FACT] | **Python/vLLM-only runtime → out** [VERIFIED-FACT] | many | GPU cost + Python-only disqualify |
| **Supertonic 3** | OpenRAIL-M; repo **archived Sept 2026** [VERIFIED-FACT] | ~99M ONNX | — | — | ONNX | — | archived |
| **Kitten TTS** | 0.8: Apache-2.0 (15–80M) [VERIFIED-FACT]; KittenTTS 2 (1.7B): Stellon license [VERIFIED-FACT] | small | — | — | Python-first | — | watchlist only |

### Evidence notes

- VoxRT head-to-head (published 2026-11-05, i9-13900K, 1 vs 4 pinned threads, same 3 texts, median of 3; **author is Linnet's maker — read with that bias**): Kokoro fp32 RTF 51.7%/17.2%, TTFA 1.5/9.6 s, RSS 1,246 MB; pocket-tts 23.8% (2 cores), 71/82 ms, 968 MB; Linnet 10.6%/3.4%, 87/133 ms, 187 MB; Piper medium 5.8%/2.1%, 180/283 ms, 503 MB. [BENCHMARK] — https://huggingface.co/blog/VoxRT/small-cpu-text-to-speech-models-compared-piper-kok
- Kokoro latency is whole-utterance: 9.6 s to first audio for a 17 s paragraph; the blog states caller-side sentence splitting brings first audio down to roughly the short-text figure. [BENCHMARK + ESTIMATE]
- Kokoro known artifacts verified in issue tracker and community docs: espeak phoneme markers leaking into audio, stress digits, number/contraction mispronunciations, mispronounced names. [VERIFIED-FACT] — https://github.com/pguso/kokoro/blob/main/PROBLEM.md, https://github.com/hexgrad/kokoro/issues/247
- Kokoro's espeak-ng dependency is GPLv3 — a distribution-licensing consideration for an Apache-2.0 app (data/code linkage question, not a usage blocker). [VERIFIED-FACT]
- sherpa-onnx ships pretrained Kokoro (download instructions + docs) and a **Pocket TTS English bundle (int8, 98 MB)** with a Rust example `pocket_tts.rs`; Kyutai's newer Pocket exports are not yet supported (k2-fsa issue #3755 open). [VERIFIED-FACT] — https://k2-fsa.github.io/sherpa/onnx/tts/pocket.html, https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html
- Pocket TTS: released 2026-01-13, MIT, ~200 ms first-chunk claim, streaming 80 ms frames, voice cloning. [VERIFIED-FACT] — https://kyutai.org/blog/2026-01-13-pocket-tts/, https://github.com/kyutai-labs/pocket-tts. Weights CC BY 4.0 and gated on HF per VoxRT. [VERIFIED-FACT]
- Linnet: Apache-2.0 code / non-OSS weights license; PyPI `linnet-tts` 0.1.1 (2026-11-04); limits self-declared: English only, no text normalization, misreads dense raw text, "quality below the big cloud models". [VERIFIED-FACT] — https://github.com/VoxRT/LinnetTTS, https://huggingface.co/VoxRT/linnet-en-35m

### VERDICT — TOP TTS PICK + FALLBACK

**TOP PICK: Kokoro-82M via the official sherpa-onnx Rust crate, with caller-side sentence-chunked synthesis, running on CPU.** It is the only option that is simultaneously Apache-2.0 weights, already supported by the exact crate Jerry uses for STT/VAD (zero new dependency), proven at 54 voices/8 languages, and small enough (~326 MB fp32, ~1 GB RAM) to live entirely off GPU 0 — so it cannot starve GLM. Whole-utterance latency (9.6 s for long paragraphs measured) is neutralized by sentence-splitting, which caps TTFA at roughly one short sentence of synth time (~200–500 ms on desktop CPU [ESTIMATE]); the espeak artifacts and the GPLv3 phonemizer dependency are known, bounded, and acceptable for v1.

**FALLBACK / UPGRADE PATH: Kyutai Pocket TTS through the same sherpa-onnx crate** (`pocket_tts.rs`, English Jan-2026 int8 bundle): true 80 ms streaming and 71–82 ms TTFA with voice cloning, at the cost of an English-only bundle, a reported sherpa-vs-Python quality gap, gated CC-BY-4.0 weights, and one open support issue for newer exports. **Watchlist: Linnet** — best raw numbers of the field (10.6% RTF, 187 MB, Rust-native runtime) but 5 days old, non-OSS weights license that locks cloning behind VoxRT's unpublished encoder, no text normalization (fatal for an assistant that says dates and numbers), and no sherpa integration.

---

## PART 2 — Echo cancellation / audio cleanup

| Option | What it is | License | Status | Fit for Jerry |
|---|---|---|---|---|
| **Headphones (no AEC)** | Strategy, not software | — | — | **Default mode** — removes the problem entirely |
| **PipeWire `module-echo-cancel`** | System-level AEC (WebRTC APM default), 4-stream design, config via `pipewire.conf.d` or `pactl load-module` | LGPL (PipeWire module runs in the daemon, not linked into the app) | Ubuntu 24.04 ships pipewire 1.0.5 [VERIFIED-FACT] | Speakers-mode solution **outside the app** — zero Rust code, applies to any mic |
| **tonarino `webrtc-audio-processing` 2.1.0** | Rust FFI wrapper of WebRTC AudioProcessing (AEC3, NS, AGC2, HPF); `bundled` feature static-builds the C++; `experimental-aec3-config` feature | "non-standard" (WebRTC-derived BSD-style) [VERIFIED-FACT] | **v2.1.0 published 2026-05-13**, active through 2026 (2.0.0 Feb → 2.1.0 May), ~97k recent downloads [VERIFIED-FACT] | In-app fallback; cost = C++ toolchain build burden in CI |
| **RubyBit `aec3`** | Pure-Rust AEC3 port incl. NS/AGC2/HPF/resample nodes; `karaoke_loopback` example | **License text vague [UNVERIFIED]** | 0.1.0–0.4.0, Oct 2026, very new [VERIFIED-FACT] | Watchlist only until license + maturity settle |
| **`nnnoiseless` 0.5.2** | RNNoise-style noise **suppression** (not true AEC) | BSD-3 | Mature, slow-moving [VERIFIED-FACT] | Complement (mic denoise), not an AEC substitute |
| `speexdsp-resampler` | Speex resampler pure-Rust port (resampling only, not AEC) | BSD-3 | **Stale: 0.1.0 (2020) is newest non-yanked; 0.2.0 published 2022-04-28 and yanked 2022-05-07**; 172k recent downloads [VERIFIED-FACT] | Prefer **`rubato` 5.0.1** (2026-10-01, MIT OR Apache-2.0, 6.1M recent downloads, actively maintained by CamillaDSP's author) for 48k→16k capture resampling [VERIFIED-FACT] |

### VERDICT — AEC (headphones-first strategy)

Ship v1 with **headphones as the assumed default and no in-app AEC at all**: Jerry's capture is Rust-side cpal, so there is no browser audio graph to hook an APM into, and every in-app option either drags a C++ WebRTC build into the build pipeline (tonarino wrapper, albeit actively maintained at 2.1.0) or is too immature to bet on (`aec3` crate license unverified). For **speaker mode, use system-level PipeWire `module-echo-cancel`** (documented `pactl load-module` / `pipewire.conf.d` config on Ubuntu 24.04's PipeWire 1.0.5) — it fixes echo for the whole desktop with zero app code and keeps the app license-clean; document it in settings rather than implementing it. Keep `nnnoiseless` in the toolbox as an optional mic-denoise stage, and use `rubato` (not the stale speex port) if a resample to 16 kHz is ever needed outside cpal's own conversion.

---

## PART 3 — Wake word

| Option | License | Model / mechanism | Rust integration | Notes |
|---|---|---|---|---|
| **sherpa-onnx KWS** | Apache-2.0 | Open-vocabulary **Zipformer 3.3M** (English gigaspeech 2024-01-01; new zh-en 2025-12-20), RTF 0.036 [VERIFIED-FACT] | **Same crate already in Jerry's stack** (STT + VAD + TTS) [VERIFIED-FACT] | Keyword defined as a **text file** with per-word boost + threshold — no training needed |
| **Rustpotter 3.0.2** | Apache-2.0 | Personal wake words (`.rpw`), DTW/MFCC refs, candle-based v3 [VERIFIED-FACT] | Native Rust, ~6k downloads/mo, active Oct 2026 [VERIFIED-FACT] | Requires recording personal wake-word refs |
| **openWakeWord** | Apache-2.0 | Pre-trained + custom wake words | **Python-only** | 2.6k stars, last push 2025-12-30; openwakeword.com now **sells commercial model licenses ($185/word)** — project drifting toward commercial model distribution [VERIFIED-FACT] |
| microWakeWord | Stock models Apache-2.0; **training-data CC-BY-NC question open** (OHF issue #100) [VERIFIED-FACT] | TFLite / ESP32-focused | No | Out of scope |
| Porcupine (Picovoice) | Proprietary | — | — | Out (license); used by Friday |

### VERDICT — Wake word

**sherpa-onnx KWS is the pick: it adds zero new dependencies** because the official crate Jerry already depends on for Silero VAD, Smart Turn hosting, and TTS ships an open-vocabulary Zipformer KWS with a text-file keyword spec (per-word boost/threshold) and RTF 0.036 — trivially cheap on CPU next to GLM. Rustpotter 3.0.2 is a credible second (native Rust, Apache-2.0, active) if a *branded* wake word ever needs custom recording-based training. Defer openWakeWord: Python-only in a Rust-first app, and its model-distribution shift toward paid commercial licenses is exactly the supply risk Jerry's stack should avoid. Sequencing note: wake word is a **post-v1 layer** — P0 remains push-to-talk, so the KWS integration can land when "always listening" becomes a requirement.

---

## PART 4 — Existing voice frameworks (reuse audit)

| Project | License | Status | Reuse verdict for Jerry |
|---|---|---|---|
| HF **speech-to-speech** | Apache-2.0 [VERIFIED-FACT] | Active; cascaded VAD→STT→LM→TTS; Smart Turn v3.2 CPU checkpoint; Pocket/Phonon/Qwen3-TTS-GGML backends added [VERIFIED-FACT] | **Pattern reference only** — Python orchestration layer, contradicts Rust-first |
| **Pipecat** (pipecat-ai) | **BSD-2-Clause** [VERIFIED-FACT] | 17,161 stars, 3,073 forks, pushed 2026-11-10 [VERIFIED-FACT] | Pattern reference; Smart Turn already adopted standalone from this ecosystem |
| Pipecat **Smart Turn v3.2** | BSD-2-Clause [VERIFIED-FACT] | ~8M params (Whisper-Tiny backbone); **CPU int8 8 MB / GPU fp32 32 MB**; 23 languages; 10–65 ms CPU; 16 kHz mono PCM ≤ 8 s, pad-at-beginning, rerun full turn if new speech arrives [VERIFIED-FACT] | **Already adopted** as Jerry's EOT second stage — standalone, no Pipecat dependency |
| **Open-LLM-VTuber** | Backend MIT, but frontend under custom "Open-LLM-VTuber License 1.0" since v1.2.0 + separate Live2D license; v2.0 rewrite in progress [VERIFIED-FACT] | — | **Disqualified** (license drift + avatar focus) |
| **Moshi** (Kyutai) | Weights CC-BY 4.0, code MIT/Apache [VERIFIED-FACT] | Full-duplex speech-text foundation model — **replaces the LLM**; ~24 GB VRAM PyTorch / int8 via Rust candle [VERIFIED-FACT] | **Disqualified** — GLM stays the brain |
| **Handy** (cjpais/Handy) | **MIT, 38,193 stars, 3,599 forks, Rust/Tauri v2, pushed 2026-11-07, handy.computer** [VERIFIED-FACT] | Maintains its own handy-cpal fork (PulseAudio record-stream stall fix) [VERIFIED-FACT] | **Primary code reference** for capture patterns; MIT permits real code reuse |
| orv / Talvio / Typr | MIT [VERIFIED-FACT] | Tauri 2 push-to-talk dictation apps (Silero VAD, whisper.cpp sidecar/worker) | Secondary references |
| Voicetypr | **AGPL-3.0** [VERIFIED-FACT] | — | No code reuse (contamination) |
| Voicebox | MIT [VERIFIED-FACT] | 37.9k stars but **FastAPI Python backend inside** [VERIFIED-FACT] | UX reference only |

### VERDICT — Reuse

**Reuse patterns and MIT code, never a Python orchestration layer:** Pipecat (BSD-2, verified) and HF speech-to-speech (Apache-2.0, verified) are architecturally instructive but Python-native, and Jerry's voice module must be a single shared Rust module beside the existing `sse_pump.rs`-style session machinery. From this ecosystem Jerry has already taken the right thing standalone — Smart Turn v3.2 (BSD-2, 8 MB int8 CPU model, runs only during Silero-detected silence, re-runs on the full turn when speech resumes). Handy (MIT, 38.2k stars, actively pushed) is the one project from which actual Rust code patterns — cpal capture, model management, Tauri integration — can be legitimately lifted; Open-LLM-VTuber's license drift and Moshi's replace-the-LLM architecture both remain disqualifying.

---

## PART 5 — Frontend components for voice (React 19 + Tailwind 4, Tauri WebView)

| Component need | Candidate | License | Verdict |
|---|---|---|---|
| Voice UI kit | **Pipecat UI** (pipecat-ai/pipecat-ui, shadcn registry `@pipecat`) | **BSD-2-Clause** [VERIFIED-FACT] — repo created 2026-09-05, 17 stars, TypeScript, installs as source, requires Node 22+/React 19/Tailwind 4 | Stack match is exact, but components bind to the `@pipecat-ai/client-react` transport client → **use as visual/UX pattern, not as a dependency** |
| Transport hooks | `@pipecat-ai/client-react` | (per Pipecat ecosystem, BSD-2) [VERIFIED-FACT for repo] | Not applicable — Jerry's transport is Rust-side Tauri commands + ipc `Channel`, not a WebRTC/SIP client |
| Live waveform / level meter | **react-audio-visualize** 1.2.0 (canvas bars) | MIT [VERIFIED-FACT] | **Live component requires a `MediaRecorder`** → dead end, since capture is Rust-side and WebKitGTK getUserMedia is not viable; the blob component can render an assembled WAV from IPC bytes for clip review [VERIFIED-FACT] |
| Waveform (heavy) | wavesurfer.js | not re-verified [UNVERIFIED] | Overkill; skip unless playback scrubbing is needed |
| **Recommended approach** | **Custom canvas components fed by Tauri ipc `Channel`** | in-house | Rust emits per-chunk RMS/peaks (or downsampled samples) over an ipc Channel; a ~100–300 LOC canvas component renders level meter + scrolling waveform with `requestAnimationFrame`; **no AudioWorklet needed** because there is no browser audio graph at all [ESTIMATE — implementation plan, consistent with verified constraints] |

Frontend state machine to build (mirrors Pipecat UI's UX pattern): `idle → listening → (barge-in aware) thinking → speaking`, with mic button slotted into the Composer send row (per stage-1 decision), live meter during listening, streaming transcript during thinking, and stop control wired to `nexus.stopSession`.

### Latency budget context

- Real-world ChatGPT voice medians: AVM ~1.51 s (Agora measurement), GPT-Live ~1.3 s median (P90 104 ms above median); OpenAI's 232–320 ms marketing claim not independently reproduced; GPT-4o Realtime v2 API TTFA reported 300–600 ms. [BENCHMARK] — https://www.agora.io/jp/blog/openai-didnt-publish-gpt-lives-latency-so-we-measured-it, https://mlq.ai/news/gpt-live-is-a-deployed-chatgpt-product-not-an-api-modelyet/
- Jerry target **~300–800 ms end-to-end** [ESTIMATE]: EOT (Silero + Smart Turn) 10–65 ms [BENCHMARK] + STT (Parakeet CPU / Whisper turbo ~0.2–0.3 s per 10 s utterance) + GLM TTFT (local, `--parallel 1` contention is the risk) + first TTS sentence (Kokoro sentence-chunk ~200–500 ms [ESTIMATE], Pocket 71–82 ms [BENCHMARK]). A cascaded pipeline at this bar beats the measured ChatGPT medians — the defensibility constraint is GLM TTFT, not TTS.

---

## Verification ledger (what remains unverified)

1. `aec3` crate (RubyBit) license text — flagged [UNVERIFIED]; do not adopt until read.
2. wavesurfer.js license/size — not re-verified; low relevance.
3. Kokoro TTFA after sentence-splitting *through the sherpa-onnx Rust path* specifically — derived [ESTIMATE]; VoxRT measured the Python `kokoro-onnx` path.
4. Pocket TTS quality-through-sherpa — user reports exist (issue #3172, closed) but no independent MOS; verify empirically during build.
5. `@pipecat-ai/client-react` npm license assumed BSD-2 with the org's repos — verify package LICENSE before any import (only relevant if patterns are copied, not imported).

## Sources (primary, this session)

- VoxRT CPU TTS benchmark: https://huggingface.co/blog/VoxRT/small-cpu-text-to-speech-models-compared-piper-kok
- Linnet: https://github.com/VoxRT/LinnetTTS · https://huggingface.co/VoxRT/linnet-en-35m · https://pypi.org/project/linnet-tts
- Kokoro: https://huggingface.co/hexgrad/Kokoro-82M · https://github.com/hexgrad/kokoro/issues/247 · https://github.com/pguso/kokoro/blob/main/PROBLEM.md
- Pocket TTS: https://kyutai.org/blog/2026-01-13-pocket-tts/ · https://github.com/kyutai-labs/pocket-tts
- sherpa-onnx TTS/KWS: https://k2-fsa.github.io/sherpa/onnx/tts/pocket.html · https://k2-fsa.github.io/sherpa/onnx/tts/pretrained_models/kokoro.html
- Piper: https://github.com/OHF-Voice/piper1-gpl · https://pypi.org/project/piper-tts
- Qwen3-TTS: https://github.com/QwenLM/Qwen3-TTS
- AEC/cleanup: crates.io APIs for webrtc-audio-processing (2.1.0, 2026-05-13), speexdsp-resampler, rubato (5.0.1, 2026-10-01) · nnnoiseless v0.5.2 · PipeWire module-echo-cancel docs
- Smart Turn: https://github.com/pipecat-ai/smart-turn (README: BSD-2, 8 MB int8 / 32 MB fp32, 23 languages)
- Frameworks/UI: GitHub APIs for pipecat-ai/pipecat (BSD-2, 17.2k★), pipecat-ai/pipecat-ui (BSD-2), cjpais/Handy (MIT, 38.2k★)
- Frontend: https://registry.npmjs.org/react-audio-visualize (MIT, 1.2.0, MediaRecorder-bound live component)
- Latency: https://www.agora.io/jp/blog/openai-didnt-publish-gpt-lives-latency-so-we-measured-it · https://mlq.ai/news/gpt-live-is-a-deployed-chatgpt-product-not-an-api-modelyet/

---

# PART 3 — Reviewer verification ledger (2026-11-09)

15 load-bearing claims independently verified against live sources; 13 confirmed outright, 2 corrected:

| # | Claim | Verdict |
|---|---|---|
| 1 | sherpa-onnx crate v2.0.1, Apache-2.0, default static feature (2026-10-27, csukuangfj) | CONFIRMED (crates.io API) |
| 2 | GPU build = CUDA 12.8 + cuDNN 9; v2.0.1 GPU tarball exists; CPU default static | CONFIRMED (k2-fsa docs) |
| 3 | Silero VAD MIT | CONFIRMED — repo LICENSE is MIT; HF badge itself unverifiable (API 401); residual ambiguity acceptable for personal use |
| 4 | Smart Turn v3.2 BSD-2, 8MB int8 / 32MB fp32, 23 langs, ~10ms CPU, silence-gated | CONFIRMED + undocumented detail: official >8s policy = truncate from beginning, keep last 8s, re-run on new speech |
| 5 | Parakeet TDT 0.6B v3 CC-BY-4.0, 6.34% avg, 25 EU langs, punct built-in | CONFIRMED; CPU viability rests on sherpa int8 exports (ESTIMATE, P1 spike) |
| 6 | Kokoro/espeak licensing | WRONG for pinned version — PR #4055 (2026-10-20, v2.0.0) removed espeak-ng + piper-phonemize; "sherpa-onnx is GPL-free"; data_dir deprecated/ignored; lexicon frontend drops numbers/OOV (issue #4139) |
| 7 | WebKitGTK getUserMedia not viable, no Tauri toggle | CONFIRMED (enable-webrtc property exists ≥2.42; wry exposes neither; tauri #2600/#13143) |
| 8 | Handy MIT, 38k★, active | CONFIRMED (38,196★, pushed 2026-11-07) |
| 9 | rodio 0.23 / cpal 0.18.2 / ringbuf 0.6.0 active; hound dormant 2023 (stable, Apache-2.0) | CONFIRMED (crates.io API) |
| 10 | whisper-rs 0.16.0 on Codeberg | CONFIRMED; oddity: 0 tags on Codeberg — crates.io is the only artifact source; pin version+checksum |
| 11 | Pocket TTS sherpa quality mismatch #3172 | CONFIRMED — root cause is the INT8 bundle; fp32 "significantly improves quality"; int8 bundle disqualified |
| 12 | PipeWire module-echo-cancel on Ubuntu 24.04, pactl-loadable, WebRTC APM | CONFIRMED (docs.pipewire.org; echo-cancel-capture source / echo-cancel-playback sink) |
| 13 | Kokoro int8 sherpa release asset exists | CONFIRMED (kokoro-int8-multi-lang-v1_1.tar.bz2); size manifest corrected (fp32 310–330MB vs int8 ~1/4; voices.bin v1.1 = 26MB) |
| 14 | llama.cpp --cache-reuse default 0 (disabled); /slots endpoint enabled by default | CONFIRMED (server README, discussion #13606) |
| 15 | Kokoro output 24 kHz fixed | CONFIRMED |

Unverifiable: HF license badge on snakers4/silero-vad ONNX asset; Rust-crate consumption of prebuilt GPU archives without source build; OpenCode 409 semantics from web (accepted from Jerry's verified API notes).

Code claims verified against the repo: sse_pump.rs StreamRegistry/AtomicBool/ipc::Channel idiom; Composer.tsx send/interrupt row = mic slot; CSP has no media-src/blob; api_fetch 30s total timeout; reqwest 0.12 json,stream features; reqwest built WITHOUT TLS (loopback-only voice path is enforced, add assert).
