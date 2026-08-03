"""Python mirror of src/shared/ai/neural/encode.ts (golden-vector parity)."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from env.game import get_card, get_noble, load_data

NORMAL = ["white", "blue", "green", "red", "black"]
ALL_TOKENS = NORMAL + ["gold"]

MAX_PLAYERS = 4
MAX_MARKET_CARDS = 12
MAX_RESERVED_CARDS = 12
MAX_NOBLES = 5
MAX_ACTIONS = 64

OBS_DIM = 462
ACTION_DIM = 43


def _rel_seat(player_order: List[str], self_id: str, target_id: str) -> int:
    try:
        self_index = player_order.index(self_id)
        target_index = player_order.index(target_id)
    except ValueError:
        return 0
    return (target_index - self_index + len(player_order)) % len(player_order)


def _card_vector(card: Optional[Dict[str, Any]], present: float) -> List[float]:
    return [
        present,
        (card["tier"] if card else 0) / 3.0,
        (card["points"] if card else 0) / 5.0,
    ] + [((card["cost"][color] if card else 0) / 7.0) for color in NORMAL] + [
        1.0 if card and card["bonus"] == color else 0.0 for color in NORMAL
    ]


def _bonuses_of(purchased_ids: List[str]) -> List[int]:
    counts = {color: 0 for color in NORMAL}
    for card_id in purchased_ids:
        card = get_card(card_id)
        if card:
            counts[card["bonus"]] += 1
    return [counts[color] for color in NORMAL]


def _score_of(purchased_ids: List[str], noble_ids: List[str]) -> int:
    card_points = sum(
        (get_card(card_id) or {}).get("points", 0) for card_id in purchased_ids
    )
    noble_points = sum(
        (get_noble(noble_id) or {}).get("points", 0) for noble_id in noble_ids
    )
    return card_points + noble_points


def _tier_section(observation: Dict[str, Any], key: str, tier: int) -> Any:
    """Observations from TS JSON use string tier keys; Python env uses ints."""
    section = observation[key]
    if tier in section:
        return section[tier]
    return section[str(tier)]


def encode_observation(observation: Dict[str, Any]) -> List[float]:
    out: List[float] = []
    self_id = observation["playerID"]
    player_order = observation["playerOrder"]
    relative_order = [self_id] + [
        player_id for player_id in player_order if player_id != self_id
    ]

    # Global (15)
    out.extend(observation["bank"][color] / 7.0 for color in ALL_TOKENS)
    out.extend(
        _tier_section(observation, "deckCounts", tier) / 40.0
        for tier in (1, 2, 3)
    )
    out.extend(
        [
            observation["completedTurns"] / 200.0,
            1.0 if observation["finalRound"] else 0.0,
            len(observation["playerOrder"]) / 4.0,
        ]
    )
    pending = observation["pending"]
    out.extend(
        [
            1.0 if pending is None else 0.0,
            1.0 if pending and pending["type"] == "discard" else 0.0,
            1.0 if pending and pending["type"] == "noble" else 0.0,
        ]
    )

    # Players (4 x 19)
    for seat in range(MAX_PLAYERS):
        player_id = relative_order[seat] if seat < len(relative_order) else None
        player = observation["players"].get(player_id) if player_id else None
        if not player:
            out.extend([0.0] * 16)
            continue
        out.extend(player["tokens"][color] / 10.0 for color in ALL_TOKENS)
        out.extend(count / 10.0 for count in _bonuses_of(player["purchasedCardIds"]))
        out.extend(
            [
                _score_of(player["purchasedCardIds"], player["nobleIds"]) / 15.0,
                len(player["purchasedCardIds"]) / 25.0,
                len(player["reservedCards"]) / 3.0,
                len(player["nobleIds"]) / 5.0,
                1.0 if player_id == self_id else 0.0,
            ]
        )

    # Market cards (12 x 13)
    for tier in (1, 2, 3):
        for card_id in _tier_section(observation, "market", tier):
            out.extend(
                _card_vector(get_card(card_id) if card_id else None, 1.0 if card_id else 0.0)
            )

    # Reserved cards (12 x 15)
    for seat in range(MAX_PLAYERS):
        player_id = relative_order[seat] if seat < len(relative_order) else None
        player = observation["players"].get(player_id) if player_id else None
        for index in range(3):
            reserved = player["reservedCards"][index] if player and index < len(player["reservedCards"]) else None
            if not reserved:
                out.extend([0.0] * 16)
                continue
            known = reserved["cardId"] is not None
            card = get_card(reserved["cardId"]) if known else None
            out.extend(
                [
                    1.0,
                    _rel_seat(player_order, self_id, player_id) / MAX_PLAYERS,
                    reserved["tier"] / 3.0,
                    1.0 if reserved["source"] == "market" else 0.0,
                    1.0 if known else 0.0,
                    (card["points"] if card else 0) / 5.0,
                ]
                + [((card["cost"][color] if card else 0) / 7.0) for color in NORMAL]
                + [1.0 if card and card["bonus"] == color else 0.0 for color in NORMAL]
            )

    # Nobles (5 x 7)
    for index in range(MAX_NOBLES):
        noble_id = (
            observation["availableNobleIds"][index]
            if index < len(observation["availableNobleIds"])
            else None
        )
        noble = get_noble(noble_id) if noble_id else None
        out.extend(
            [
                1.0 if noble_id else 0.0,
                (noble["points"] if noble else 0) / 3.0,
            ]
            + [((noble["requirement"][color] if noble else 0) / 7.0) for color in NORMAL]
        )
    assert len(out) == OBS_DIM, f"obs dim {len(out)} != {OBS_DIM}"
    return out


def _action_type_index(action_type: str) -> int:
    return {
        "takeDifferent": 0,
        "takeSame": 1,
        "reserveMarket": 2,
        "reserveDeck": 3,
        "purchase": 4,
        "pass": 5,
        "discardTokens": 6,
        "chooseNoble": 7,
    }[action_type]


def _target_card_for(
    observation: Dict[str, Any], action: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    if action["type"] == "purchase":
        return get_card(action["location"]["cardId"])
    if action["type"] == "reserveMarket":
        return get_card(action["cardId"])
    return None


def encode_action(
    action: Dict[str, Any], observation: Dict[str, Any]
) -> List[float]:
    out: List[float] = []
    type_index = _action_type_index(action["type"])
    out.extend(1.0 if index == type_index else 0.0 for index in range(8))
    phase = 1 if action["type"] == "discardTokens" else (2 if action["type"] == "chooseNoble" else 0)
    out.extend(
        [
            1.0 if phase == 0 else 0.0,
            1.0 if phase == 1 else 0.0,
            1.0 if phase == 2 else 0.0,
        ]
    )
    tier = 0
    token_delta = [0.0] * 6
    payment = [0.0] * 6
    target = None
    noble = {"points": 0, "requirement": [0] * 5}
    if action["type"] == "takeDifferent":
        token_delta = [
            1.0 if color in action["colors"] else 0.0 for color in NORMAL
        ] + [0.0]
    elif action["type"] == "takeSame":
        token_delta = [
            2.0 if color == action["color"] else 0.0 for color in NORMAL
        ] + [0.0]
    elif action["type"] == "reserveMarket":
        tier = action["tier"]
        target = _target_card_for(observation, action)
    elif action["type"] == "reserveDeck":
        tier = action["tier"]
    elif action["type"] == "purchase":
        target = _target_card_for(observation, action)
        if action["location"]["source"] == "market":
            tier = action["location"]["tier"]
        payment = [action["payment"][color] for color in ALL_TOKENS]
    elif action["type"] == "discardTokens":
        payment = [action["tokens"][color] for color in ALL_TOKENS]
    elif action["type"] == "chooseNoble":
        noble_data = get_noble(action["nobleID"])
        noble = {
            "points": noble_data["points"] if noble_data else 0,
            "requirement": [
                noble_data["requirement"][color] if noble_data else 0
                for color in NORMAL
            ],
        }
    out.extend(
        [
            1.0 if tier == 1 else 0.0,
            1.0 if tier == 2 else 0.0,
            1.0 if tier == 3 else 0.0,
        ]
    )
    out.extend(value / 3.0 for value in token_delta)
    out.extend(value / 7.0 for value in payment)
    out.extend(
        [
            (target["points"] if target else 0) / 5.0,
        ]
        + [((target["cost"][color] if target else 0) / 7.0) for color in NORMAL]
        + [1.0 if target and target["bonus"] == color else 0.0 for color in NORMAL]
    )
    out.extend(
        [noble["points"] / 3.0]
        + [value / 7.0 for value in noble["requirement"]]
    )
    assert len(out) == ACTION_DIM, f"action dim {len(out)} != {ACTION_DIM}"
    return out


def encode_ai_move(
    move: Dict[str, Any], observation: Dict[str, Any]
) -> List[float]:
    argument = move["args"][0]
    if move["move"] == "mainAction":
        return encode_action(argument, observation)
    if move["move"] == "discardTokens":
        return encode_action(
            {"type": "discardTokens", "tokens": argument}, observation
        )
    return encode_action({"type": "chooseNoble", "nobleID": argument}, observation)
