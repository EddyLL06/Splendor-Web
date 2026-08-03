# Round 13 — Neural Expert Wired into Production (AI_BOT_EXPERT_ENABLED=true)

Date: 2026-08-04
Branch: `codex-ds/ai_bot`

## Decision (user-requested)

Promote the current best neural checkpoint into the Expert difficulty so
players get it immediately. `AI_BOT_EXPERT_ENABLED` default changed to
`true`; Expert now runs the bundled ONNX policy-value network with bounded
bot-tree PUCT in the shared worker pool.

## What changed

- `ai_bot/models/neural/policy-attn-s6.onnx` (attention, 403k params,
  SHA-256 `4fb0a087...`) + manifest `policy-attn-s6.json` (encoder dims
  462/43, rules fingerprint, training rounds s1-s6, 2p validation notes).
- `src/server/ai/worker.ts`: lazily loads the ONNX model (worker thread),
  routes Expert requests through `computeNeuralPuctDecision`
  (`mode: 'bot-tree'`), falls back to the heuristic Expert search if the
  model is missing/inference fails, then the controller falls back to
  Normal. Fallback decisions are marked `fallbackLevel: 2`.
- `src/server/ai/worker-pool.ts`: `workerData` passthrough to workers.
- `src/server/config.ts`: `aiBotNeuralModel`, `aiBotExpertSims` (96),
  `aiBotExpertDeterminizations` (2), `aiBotExpertMaxMs` (500);
  `aiBotExpertEnabled` default `true`. `.env.example` updated.
- `src/server/ai/bot-controller.ts` + coordinator: Expert deadline uses
  `AI_BOT_EXPERT_MAX_MS`.
- `src/server/http/app.ts`: startup log for model presence + diagnostics
  `expertModel` fields (path, sims, determinizations, maxMs).
- Docs: README/SERVER_SETUP env table and guidance updated (Expert enabled
  by default; fallback behavior; 2C/2GB keeps 1 worker).
- Test: `tests/ai/neural-expert.worker.test.ts` spawns a real worker,
  loads the committed ONNX and asserts a legal `neural-puct-v1` decision.

## Gates

Typecheck clean; full Vitest **201/201**; `npm run build` clean;
`npm run ai:smoke` passes (12 games, 0 illegal/deadlocks).

## Known caveats

- Reliable 2p strength vs Hard is ~63-67% (200-game confirmation); one
  60-game run reached 80%. 3/4-player benchmarks are still pending, so
  "Expert" is the strongest available agent but has not passed the 75%
  promotion gate yet.
- Wall-clock-budgeted searches are reproducible only when they complete
  within budget; the worker watchdog + Normal fallback keep games safe.
- Inline mode (`AI_BOT_WORKERS=0`, tests) keeps the heuristic Expert path
  so the main process never blocks; production default uses a worker.
