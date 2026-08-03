# Round 11 — Attention Trunk + Strongest Result (66.7%)

Date: 2026-08-03
Branch: `codex-ds/ai_bot`

## What changed

- `ai_bot/neural/model/net.py`: added `PolicyValueNetAttention` (guide §4.1):
  typed entity MLPs (global/players/market/reserved/nobles) feeding two
  transformer blocks (d=128, 4 heads), pooled state token, same action
  scorer/value interface. 403k params. The flat 462-dim observation is
  sliced back into entity groups, so the TS/Python encoders are unchanged.
- `train_policy.py` / `export_onnx.py`: `--arch deep-sets|attention`.
- Trained on all 65,644 positions (s1-s5, search-target losses): holdout
  exact-move accuracy 41.0% (vs 38-40% Deep Sets), value error 0.602.

## Results vs Hard (2p, rotated seats, 0 illegal/deadlocks)

| Model | Search | Win rate (95% CI) | games |
| --- | --- | --- | --- |
| s4 Deep Sets | bot-tree PUCT 96x2/300ms | 61.7% (49.0-72.9) | 60 |
| s4 Deep Sets | bot-tree PUCT 192x3/500ms | 56.7% (39.2-72.6) | 30 |
| attention v1 | bot-tree PUCT 96x2/500ms | **66.7% (54.1-77.3)** | 60 |

Alternating PUCT remains weaker than bot-tree (16.7% with s4) and is parked.
Round 6 data (s6) with the attention teacher is generating next.
