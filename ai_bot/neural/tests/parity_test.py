"""Differential parity test: Python env vs TypeScript authoritative engine.

Replays the TS-generated traces (scripts/ai/neural/trace.ts) with the same
seeds and policy, asserting identical legal-action keys, state hashes and
observations. Fails loudly on the first mismatch with both states dumped.
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from typing import Any, Dict, List

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from env.game import (  # noqa: E402
    HIDDEN_CARD_ID,
    apply_simulation_discard,
    apply_simulation_main_action,
    apply_simulation_noble,
    create_initial_state,
    create_observation,
    create_player_view,
    create_simulation,
    enumerate_legal_actions,
)
from env.rng import SeededRNG  # noqa: E402


def canonical(value: Any) -> Any:
    if isinstance(value, list):
        return [canonical(entry) for entry in value]
    if isinstance(value, dict):
        return {
            key: canonical(value[key])
            for key in sorted(value.keys())
        }
    return value


def state_hash(state: Dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(canonical(state), sort_keys=True, separators=(",", ":")).encode(
            "utf-8"
        )
    ).hexdigest()


def observation_key(value: Any) -> str:
    return json.dumps(canonical(value), sort_keys=True, separators=(",", ":"))


def replay(trace_dir: str) -> None:
    game_files = sorted(
        path
        for path in os.listdir(trace_dir)
        if path.startswith("game-") and path.endswith(".jsonl")
    )
    if not game_files:
        raise AssertionError(f"No trace games found in {trace_dir}")
    for filename in game_files:
        with open(os.path.join(trace_dir, filename), "r", encoding="utf-8") as handle:
            lines = handle.read().strip().split("\n")
        header = json.loads(lines[0])
        seed = header["seed"]
        game_index = header["gameIndex"]
        num_players = header["numPlayers"]
        rng = SeededRNG(f"game:{seed}:{game_index}")
        state = create_initial_state(num_players, rng)
        assert state_hash(state) == header["initialHash"], (
            f"{filename}: initial state hash mismatch"
        )
        sim = create_simulation(
            state,
            {
                "currentPlayer": state["initialFirstPlayer"],
                "playOrder": state["playerOrder"],
                "playOrderPos": state["playerOrder"].index(
                    state["initialFirstPlayer"]
                ),
            },
            0,
        )
        for line in lines[1:]:
            entry = json.loads(line)
            player_id = entry["playerID"]
            expected_key = entry["actionKey"]
            move = entry["move"]
            legal = enumerate_legal_actions(sim.G, player_id, sim.current_player)
            keys = [candidate["actionKey"] for candidate in legal]
            if expected_key not in keys:
                raise AssertionError(
                    f"{filename} step {entry['step']}: action key {expected_key!r} "
                    f"missing from Python legal actions {keys}"
                )
            candidate = next(
                item for item in legal if item["actionKey"] == expected_key
            )
            if candidate["move"] != move:
                raise AssertionError(
                    f"{filename} step {entry['step']}: move mismatch "
                    f"{candidate['move']} vs {move}"
                )
            args = move["args"]
            if move["move"] == "mainAction":
                result = apply_simulation_main_action(sim, player_id, args[0])
            elif move["move"] == "discardTokens":
                result = apply_simulation_discard(sim, player_id, args[0])
            else:
                result = apply_simulation_noble(sim, player_id, args[0])
            if not result["ok"]:
                raise AssertionError(
                    f"{filename} step {entry['step']}: engine rejected the "
                    f"trace move: {result['errors']}"
                )
            actual_hash = state_hash(sim.G)
            if actual_hash != entry["stateHash"]:
                raise AssertionError(
                    f"{filename} step {entry['step']}: state hash mismatch\n"
                    f"expected {entry['stateHash']}\ngot      {actual_hash}\n"
                    f"state={json.dumps(canonical(sim.G), sort_keys=True)[:2000]}"
                )
        assert (sim.G["result"] or {}).get("winners") == (
            header["finalResult"] or {}
        ).get("winners"), f"{filename}: final winners mismatch"

    # Observation parity on the first game (playerView redaction).
    observations_path = os.path.join(trace_dir, "observations-game-0.json")
    if os.path.exists(observations_path):
        with open(observations_path, "r", encoding="utf-8") as handle:
            expected_observations = json.load(handle)
        # Replay game 0 from its trace file to rebuild observations.
        with open(os.path.join(trace_dir, game_files[0]), "r", encoding="utf-8") as handle:
            lines = handle.read().strip().split("\n")
        header = json.loads(lines[0])
        rng = SeededRNG(f"game:{header['seed']}:{header['gameIndex']}")
        state = create_initial_state(header["numPlayers"], rng)
        sim = create_simulation(
            state,
            {
                "currentPlayer": state["initialFirstPlayer"],
                "playOrder": state["playerOrder"],
                "playOrderPos": state["playerOrder"].index(
                    state["initialFirstPlayer"]
                ),
            },
            0,
        )
        for index, line in enumerate(lines[1:]):
            entry = json.loads(line)
            player_id = entry["playerID"]
            observation = create_observation(
                create_player_view(sim.G, player_id),
                player_id,
                {
                    "currentPlayer": sim.current_player,
                    "playOrder": sim.play_order,
                    "playOrderPos": sim.play_order_pos,
                },
            )
            assert observation_key(observation) == observation_key(
                expected_observations[index]
            ), f"observation mismatch at step {entry['step']}"
            move = entry["move"]
            args = move["args"]
            if move["move"] == "mainAction":
                apply_simulation_main_action(sim, player_id, args[0])
            elif move["move"] == "discardTokens":
                apply_simulation_discard(sim, player_id, args[0])
            else:
                apply_simulation_noble(sim, player_id, args[0])


if __name__ == "__main__":
    trace_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(__file__), "..", "..", "..",
        ".local-data", "ai-bot", "neural-traces", "parity-v1",
    )
    replay(os.path.abspath(trace_dir))
    print("parity OK")
