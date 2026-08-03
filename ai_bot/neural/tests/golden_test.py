"""Golden-vector parity test: Python encoder vs TS encoder (guide §3.3/§8)."""

from __future__ import annotations

import json
import math
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from features.encode import (  # noqa: E402
    ACTION_DIM,
    OBS_DIM,
    encode_ai_move,
    encode_observation,
)

GOLDEN_PATH = os.path.join(os.path.dirname(__file__), "golden-vectors.json")


def almost_equal(left: float, right: float, tolerance: float = 1e-6) -> bool:
    return math.isclose(left, right, abs_tol=tolerance, rel_tol=tolerance)


def main() -> None:
    with open(GOLDEN_PATH, "r", encoding="utf-8") as handle:
        golden = json.load(handle)
    assert len(golden["observation"]) == OBS_DIM
    # The golden file stores tensors only; rebuild the observation by
    # replaying the same seeded game so the Python encoder sees identical
    # public information.
    import os

    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from env.game import (  # noqa: F811
        apply_simulation_main_action,
        create_initial_state,
        create_observation,
        create_player_view,
        create_simulation,
        enumerate_legal_actions,
    )
    from env.rng import SeededRNG  # noqa: F811

    rng = SeededRNG("golden:vector")
    state = create_initial_state(2, rng)
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
    apply_simulation_main_action(sim, sim.current_player, {
        "type": "takeDifferent",
        "colors": ["white", "blue", "green"],
    })
    apply_simulation_main_action(sim, sim.current_player, {
        "type": "takeDifferent",
        "colors": ["green", "red", "black"],
    })
    apply_simulation_main_action(sim, sim.current_player, {
        "type": "reserveDeck",
        "tier": 2,
    })
    player_id = sim.current_player
    observation = create_observation(
        create_player_view(sim.G, player_id),
        player_id,
        sim.ctx(),
    )
    encoded = encode_observation(observation)
    for index, (actual, expected) in enumerate(zip(encoded, golden["observation"])):
        if not almost_equal(actual, expected):
            raise AssertionError(
                f"observation vector mismatch at {index}: {actual} vs {expected}"
            )
    legal = enumerate_legal_actions(sim.G, player_id, sim.current_player)
    assert [candidate["actionKey"] for candidate in legal] == golden["legalKeys"]
    for candidate, expected in zip(legal, golden["actions"]):
        actual = encode_ai_move(candidate["move"], observation)
        assert len(actual) == ACTION_DIM
        for index, (left, right) in enumerate(zip(actual, expected)):
            if not almost_equal(left, right):
                raise AssertionError(
                    f"action {candidate['actionKey']} mismatch at {index}: "
                    f"{left} vs {right}"
                )
    print("golden parity OK")


if __name__ == "__main__":
    main()
