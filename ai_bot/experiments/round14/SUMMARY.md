# Round 14 — Fix Railway CI failure: stale expert deadline + first-move model load

Date: 2026-08-04
Branch: `codex-ds/ai_bot`

## Problem

Railway build failed at `npm test`:

```
FAIL tests/ai/neural-expert.worker.test.ts > loads the bundled ONNX model ...
Error: NO_LEGAL_ACTION
```

Root cause: the Expert search deadline was computed in the controller
(`now + 500ms`) BEFORE the worker thread finished loading the ONNX model.
On the slower Docker builder the model load consumed the whole budget, so
`computeNeuralPuctDecision` skipped every determinization and reported
`NoLegalActionError`; the heuristic fallback received the same expired
deadline and failed the same way. This would also degrade the first Expert
move in production after a worker restart.

## Fix

- `src/server/ai/worker.ts`: the ONNX model now starts loading as soon as
  the worker boots (no per-request load latency), and the effective search
  deadline is recomputed from `now + expertMaxMs` when the request actually
  starts (used by both the neural search and the heuristic fallback).
- `src/shared/ai/search/neural-puct.ts`: if no simulation can run (deadline
  already expired), the search degrades to the neural policy prior over the
  root legal actions (marked `timedOut`, `fallbackLevel: 1`) instead of
  throwing `NO_LEGAL_ACTION`; the root legal set is always enumerated once
  even past the deadline.
- `tests/ai/neural-expert.worker.test.ts`: generous pool watchdog
  (`hardMaxMs: 3000`) so the model load cannot race the watchdog in CI.

## Gates

Typecheck clean; full Vitest **201/201**; `npm run build` clean.
The Railway build that previously failed is expected to pass on redeploy.

## Follow-up: production rules-fingerprint verification

Railway runtime images do not ship `src/`, so the startup fingerprint check
logged `[ai] rules fingerprint unavailable (source tree missing);
compatibility check skipped.` (benign, but the check was a no-op in prod).
Fixed:

- `scripts/ai/write-rules-fingerprint.ts` runs at the end of `npm run build`
  and writes `dist-server/ai-rules-fingerprint.txt` from the source tree.
- `rulesFingerprintOrNull` now prefers the build-time export, then the
  source tree, then null. Production containers therefore report a real
  `rules fingerprint match` (verified: generated value equals the model
  manifest `1ba7ffbd...`).
- Added a unit test for the build-time export path.
