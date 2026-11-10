# SPEC-VOICE V2 — Live Probe Evidence (MEASURED 2026-11-09)

All findings below were measured directly on the live system by the primary agent.
Probe scripts preserved: `/tmp/opencode/aborttest3.py` (disconnect-abort), `/tmp/opencode/ocab2.py` (OpenCode latency A/B).

CAVEAT: a single llama.cpp slot serves ALL clients (OpenCode sessions, curator/memory-distill
plugins, ad-hoc probes). Background clients were active at times (27–39% GPU util observed at
"idle"). Numbers marked (clean) were taken while the slot was observed idle immediately before.

---

## 1. GPU / hardware topology (MEASURED — nvidia-smi + docker inspect)

- 3× NVIDIA RTX PRO 6000 Blackwell Max-Q Workstation Edition, 97,887 MiB each.
- `llama-server` (PID 13145) occupies ALL THREE GPUs:
  - GPU 0: 70,376 MiB   GPU 1: 74,728 MiB   GPU 2: 73,058 MiB
  - GPU 2 additionally hosts gnome-remote-desktop-daemon (560 + 739 MiB).
- **V1 claim "GLM on GPU 0 with headroom on GPU 1/2" is DEAD.** No spare GPU capacity for voice models.
  CPU-only voice stack is the only viable allocation.
- GPU util at "idle": 27–39% (background GLM clients — curator plugin etc.).
- Container: `glm-server`, image `ghcr.io/ggml-org/llama.cpp:server-cuda13`, mount
  `~/ai-workbench/models/glm-cache -> /models`.
- Model: `ggml-org/GLM-5.3-Flash-GGUF:Q4_K`, 2 shards = **169 GB weights** + 623 MB mmproj Q8_0
  (snapshot 119034bc3d9d76eb41f91508e6f9fb19fde42672).
- Server cmdline flags: `--hf-repo ggml-org/GLM-5.3-Flash-GGUF:Q4_K --ctx-size 1048576
  --n-gpu-layers 99 --parallel 1 --flash-attn on`. `total_slots: 1`, n_ctx 1,048,576.
- Server fingerprint: `b11889-d854d98ba`.

## 2. llama.cpp server behavior (MEASURED)

### /health is NOT a busy detector
- `GET /health` returned **200 {"status":"ok"} while the slot was mid-generation**
  (observed during a live stream with slot.is_processing=true, decoded=71).
- V1's §6 concurrency design gated on /health → **broken as designed**. Use `/slots` instead.

### /slots (unauthenticated, MEASURED shape)
```json
[{"id":0,"n_ctx":1048576,"speculative":false,"is_processing":false,"id_task":1704402,
  "n_prompt_tokens":160356,"n_prompt_tokens_processed":0,"n_prompt_tokens_cache":0,
  "next_token":[{"n_decoded":71, ...}], "params":{...}}]
```
- `is_processing` = live busy flag; `next_token[0].n_decoded` = tokens generated for current task.
- `n_prompt_tokens` shows the retained prefix of the LAST task → KV cache persists across requests:
  observed 142,360 → 148,202 → 158,535 → 160,356 across successive tasks.
- RELIABILITY CAVEAT: `/slots` was briefly unresponsive (~3 s) on one occasion during
  abort + curator contention (while /health stayed 200). Any /slots-based gate needs a retry loop.

### Disconnect-abort (MEASURED, aborttest3.py, clean)
- Raw socket, streamed 20,714 bytes (decoded=71 tokens), then abrupt `SHUT_RDWR` client disconnect.
- Generation TRUNCATED (71 of 1500 max tokens). Slot `is_processing` → false at **t+121 ms**;
  disconnect→slot-free measured **120–363 ms** across runs. `/health` stayed 200 throughout.
- No queued-request interference observed (single slot). Server recovered cleanly.
- ⇒ Barge-in by HTTP disconnect WORKS on this build. V2 must still define stage-by-stage
  timing (physical onset → VAD detect → cancel request → audible stop) separately.

### TTFT / cache economics (MEASURED, clean)
- Divergent prompt after ~148–160K-token cached prefix: **TTFB 3.0–3.4 s** (multiple runs).
- Cache-warm small prompt: **TTFB 0.21–0.80 s**, total 1.24–2.08 s.
- Identical-prompt re-run after 148K context STILL cost 3.04 s → divergence from the retained
  prefix, not cold start, is the dominant first-token cost at scale.
- Operational consequence: any voice path that changes the prefix (new session, different
  system prompt, interleaved tasks) pays ~3 s TTFT until it re-warms.

## 3. OpenCode service API (MEASURED, ocab2.py)

- Service: `~/.local/state/opencode/service.json` (basic auth opencode:<pass>).
- `POST /api/session` body `{"location":{"directory":...}}` → envelope `{"data":{"id":"ses_..."}}`.
- `POST /api/session/{id}/prompt` body `{"text":"..."}` is **ASYNC** (acks ~0.00 s).
- Events: `GET /api/event` SSE; each `data:` line is `{"id":"evt_...","type":"...","properties":{...}}`.
  Captured vocabulary:
  session.inbox.enqueued, session.inbox.delivered, session.execution.started,
  session.execution.succeeded, session.instructions.updated, session.usage.updated,
  session.renamed, session.step.started/.streamed/.ended, session.reasoning.started/.delta/.ended,
  session.text.started/.delta/.ended.
- Latency A/B (clean, fresh session then same session):
  - Fresh session turn 1: first session event +0.03 s, **first text delta +4.75 s**, turn end +4.76 s.
  - Warm turn 2 (same session): first event +0.01 s, **first text delta +0.41 s**, turn end +0.42 s.
  - ⇒ Warm OpenCode turn ≈ warm direct-GLM TTFT (0.41 s vs 0.76 s) — OpenCode is NOT the latency
    problem; cache divergence is.
- Jerry already wraps (src/lib/opencode/client.ts): prompt, runCommand, interrupt
  (POST /api/session/{id}/interrupt), DELETE /api/session/{id} (cascades child sessions).
- PromptBody (types.ts:234): `{text, files?, agents?, skills?, metadata?, delivery?: "steer"|"queue"|null, resume?, id?}`.

## 4. Known prior evidence (from V1 pipeline, carried forward)

- Voice-stack research: `~/ai-workbench/projects/NExus/docs/research/2026-11-09-voice-stack-research.md`
  (sherpa-onnx 2.0.1 official crate; Silero VAD; Smart Turn; Parakeet int8; Kokoro; rodio 0.23/cpal 0.18.2/ringbuf 0.6).
- V1 reviewer verdict: APPROVE-WITH-CHANGES (8 majors, applied). V2 external evaluation: 8.5/10 → this revision.
- V1 reviewer + memory gotcha: sherpa-onnx-sys downloads prebuilt archives at BUILD time — pin URL+digest
  (SHERPA_ONNX_ARCHIVE_DIR); GPU builds need source build + SHERPA_ONNX_LIB_DIR.
- node:sqlite FTS5 gotchas, HF api 401 unauthenticated, hound 3.5.1 decode-only OK.
