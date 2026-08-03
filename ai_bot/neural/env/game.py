"""Authoritative Splendor rules ported 1:1 from the TypeScript engine.

Mirrors: src/shared/rules/{setup,selectors,engine}.ts,
src/shared/ai/{legal-actions,simulate,observation}.ts and
src/game/playerView.ts. The TS trace parity test (scripts/ai/neural/trace.ts
vs ai_bot/neural/tests/parity_test.py) proves equivalence on shared seeds.
"""

from __future__ import annotations

import copy
import json
import os
from typing import Any, Dict, List, Optional, Tuple

from .rng import SeededRNG

NORMAL_COLORS = ["white", "blue", "green", "red", "black"]
TOKEN_COLORS = NORMAL_COLORS + ["gold"]

NORMAL_TOKEN_COUNT = {2: 4, 3: 5, 4: 7}
NOBLE_COUNT = {2: 3, 3: 4, 4: 5}
MAX_DISCARD_CANDIDATES = 256

DATA_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
    "game-data.json",
)

_DATA: Optional[Dict[str, Any]] = None


def load_data() -> Dict[str, Any]:
    global _DATA
    if _DATA is None:
        with open(DATA_PATH, "r", encoding="utf-8") as handle:
            _DATA = json.load(handle)
    return _DATA


def get_card(card_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if card_id is None:
        return None
    return next(
        (card for card in load_data()["cards"] if card["id"] == card_id),
        None,
    )


def get_noble(noble_id: Optional[str]) -> Optional[Dict[str, Any]]:
    if noble_id is None:
        return None
    return next(
        (noble for noble in load_data()["nobles"] if noble["id"] == noble_id),
        None,
    )


def cards_for_tier(tier: int) -> List[Dict[str, Any]]:
    return [card for card in load_data()["cards"] if card["tier"] == tier]


def empty_gem_counts() -> Dict[str, int]:
    return {color: 0 for color in NORMAL_COLORS}


def empty_token_counts() -> Dict[str, int]:
    counts = empty_gem_counts()
    counts["gold"] = 0
    return counts


def total_tokens(tokens: Dict[str, int]) -> int:
    return sum(tokens.values())


def _clone(value: Any) -> Any:
    return copy.deepcopy(value)


def create_initial_state(num_players: int, rng: SeededRNG) -> Dict[str, Any]:
    if num_players < 2 or num_players > 4:
        raise ValueError("Gem Council supports exactly 2 to 4 players.")
    player_order = [str(index) for index in range(num_players)]
    first_player_index = rng.int(num_players)
    initial_first_player = player_order[first_player_index]
    players = {
        player_id: {
            "tokens": empty_token_counts(),
            "purchasedCardIds": [],
            "reservedCards": [],
            "nobleIds": [],
        }
        for player_id in player_order
    }
    turn_counts = {player_id: 0 for player_id in player_order}
    decks: Dict[int, List[str]] = {}
    market: Dict[int, List[Optional[str]]] = {}
    for tier in (1, 2, 3):
        shuffled = rng.shuffle([card["id"] for card in cards_for_tier(tier)])
        market[tier] = shuffled[:4]
        decks[tier] = shuffled[4:]
    normal_count = NORMAL_TOKEN_COUNT[num_players]
    bank = empty_token_counts()
    for color in NORMAL_COLORS:
        bank[color] = normal_count
    bank["gold"] = 5
    return {
        "bank": bank,
        "decks": decks,
        "market": market,
        "availableNobleIds": rng.shuffle(
            [noble["id"] for noble in load_data()["nobles"]]
        )[: NOBLE_COUNT[num_players]],
        "players": players,
        "playerOrder": player_order,
        "initialFirstPlayer": initial_first_player,
        "pending": None,
        "turnReady": False,
        "completedTurns": 0,
        "turnCounts": turn_counts,
        "finalRound": None,
        "actionLog": [],
        "nextLogID": 1,
        "result": None,
    }


# ---------------------------------------------------------------------------
# Selectors (src/shared/rules/selectors.ts)
# ---------------------------------------------------------------------------


def get_bonuses(state: Dict[str, Any], player_id: str) -> Dict[str, int]:
    bonuses = empty_gem_counts()
    player = state["players"].get(player_id)
    for card_id in player["purchasedCardIds"] if player else []:
        card = get_card(card_id)
        if card:
            bonuses[card["bonus"]] += 1
    return bonuses


def get_score(state: Dict[str, Any], player_id: str) -> int:
    player = state["players"].get(player_id)
    if not player:
        return 0
    card_points = sum(
        get_card(card_id)["points"] if get_card(card_id) else 0
        for card_id in player["purchasedCardIds"]
    )
    noble_points = sum(
        get_noble(noble_id)["points"] if get_noble(noble_id) else 0
        for noble_id in player["nobleIds"]
    )
    return card_points + noble_points


def get_eligible_noble_ids(state: Dict[str, Any], player_id: str) -> List[str]:
    bonuses = get_bonuses(state, player_id)
    eligible = []
    for noble_id in state["availableNobleIds"]:
        noble = get_noble(noble_id)
        if noble and all(
            bonuses[color] >= noble["requirement"][color]
            for color in NORMAL_COLORS
        ):
            eligible.append(noble_id)
    return eligible


def effective_cost_for_card(
    state: Dict[str, Any], player_id: str, card: Dict[str, Any]
) -> Dict[str, int]:
    bonuses = get_bonuses(state, player_id)
    effective = empty_gem_counts()
    for color in NORMAL_COLORS:
        effective[color] = max(0, card["cost"][color] - bonuses[color])
    return effective


def _payment_shape_errors(payment: Any) -> List[Dict[str, str]]:
    if not isinstance(payment, dict):
        return [{"code": "PAYMENT_SHAPE", "message": "Payment is missing."}]
    errors = []
    for color in TOKEN_COLORS:
        amount = payment.get(color)
        if not isinstance(amount, int) or isinstance(amount, bool) or amount < 0:
            errors.append(
                {
                    "code": "PAYMENT_AMOUNT",
                    "message": f"{color} payment must be a non-negative integer.",
                }
            )
    return errors


def analyze_payment(
    state: Dict[str, Any],
    player_id: str,
    card: Dict[str, Any],
    proposed_payment: Optional[Dict[str, int]] = None,
) -> Dict[str, Any]:
    player = state["players"].get(player_id)
    effective_cost = effective_cost_for_card(state, player_id, card)
    suggested_payment = empty_token_counts()
    suggested_gold = 0
    if player:
        for color in NORMAL_COLORS:
            suggested_payment[color] = min(
                effective_cost[color], player["tokens"][color]
            )
            suggested_gold += effective_cost[color] - suggested_payment[color]
    suggested_payment["gold"] = suggested_gold
    errors = []
    if not player:
        errors.append({"code": "PLAYER_NOT_FOUND", "message": "Player was not found."})
        return {
            "effectiveCost": effective_cost,
            "suggestedPayment": suggested_payment,
            "errors": errors,
        }
    payment = proposed_payment if proposed_payment is not None else suggested_payment
    shape_errors = _payment_shape_errors(payment)
    if shape_errors:
        return {
            "effectiveCost": effective_cost,
            "suggestedPayment": suggested_payment,
            "errors": shape_errors,
        }
    remaining_cost = 0
    for color in NORMAL_COLORS:
        amount = payment[color]
        if amount > player["tokens"][color]:
            errors.append(
                {
                    "code": "PAYMENT_NOT_OWNED",
                    "message": f"You do not own {amount} {color} tokens.",
                }
            )
        if amount > effective_cost[color]:
            errors.append(
                {
                    "code": "PAYMENT_OVERPAY",
                    "message": f"{color} payment exceeds the effective cost.",
                }
            )
        remaining_cost += max(0, effective_cost[color] - amount)
    if payment["gold"] != remaining_cost:
        errors.append(
            {
                "code": "PAYMENT_GOLD_MISMATCH",
                "message": f"Gold payment must be exactly {remaining_cost}.",
            }
        )
    if payment["gold"] > player["tokens"]["gold"]:
        errors.append(
            {
                "code": "PAYMENT_NOT_ENOUGH_GOLD",
                "message": f"You need {payment['gold']} gold but own {player['tokens']['gold']}.",
            }
        )
    return {
        "effectiveCost": effective_cost,
        "suggestedPayment": suggested_payment,
        "errors": errors,
    }


def find_purchasable_card(
    state: Dict[str, Any], player_id: str, location: Dict[str, Any]
) -> Tuple[bool, Any, List[Dict[str, str]]]:
    if not isinstance(location, dict):
        return False, None, [
            {"code": "CARD_LOCATION", "message": "Card location is missing."}
        ]
    if location.get("source") == "market":
        tier = location.get("tier")
        card_id = location.get("cardId")
        if (
            tier not in (1, 2, 3)
            or not isinstance(card_id, str)
            or card_id not in state["market"].get(tier, [])
        ):
            return False, None, [
                {
                    "code": "CARD_NOT_IN_MARKET",
                    "message": "That card is no longer in the market.",
                }
            ]
        card = get_card(card_id)
        if not card or card["tier"] != tier:
            return False, None, [
                {"code": "CARD_UNKNOWN", "message": "Card data is invalid."}
            ]
        return True, card, []
    if location.get("source") == "reserved":
        card_id = location.get("cardId")
        if not isinstance(card_id, str):
            return False, None, [
                {"code": "CARD_UNKNOWN", "message": "Card data is invalid."}
            ]
        player = state["players"].get(player_id, {})
        reserved = next(
            (
                entry
                for entry in player.get("reservedCards", [])
                if entry["cardId"] == card_id
            ),
            None,
        )
        card = get_card(card_id)
        if not reserved or not card:
            return False, None, [
                {
                    "code": "CARD_NOT_RESERVED",
                    "message": "That card is not in your reserved cards.",
                }
            ]
        return True, card, []
    return False, None, [
        {"code": "CARD_LOCATION", "message": "Card location is invalid."}
    ]


def create_standings(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    standings = [
        {
            "playerID": player_id,
            "score": get_score(state, player_id),
            "purchasedCardCount": len(
                state["players"][player_id]["purchasedCardIds"]
            ),
        }
        for player_id in state["playerOrder"]
    ]
    standings.sort(
        key=lambda entry: (
            -entry["score"],
            entry["purchasedCardCount"],
            state["playerOrder"].index(entry["playerID"]),
        )
    )
    return standings


def has_legal_main_action(state: Dict[str, Any], player_id: str) -> bool:
    player = state["players"].get(player_id)
    if not player or state["pending"] is not None or state["result"] is not None:
        return False
    available_colors = 0
    for color in NORMAL_COLORS:
        if state["bank"][color] >= 4:
            return True
        if state["bank"][color] > 0:
            available_colors += 1
    if available_colors >= 2:
        return True
    if len(player["reservedCards"]) < 3:
        for tier in (1, 2, 3):
            if any(card_id is not None for card_id in state["market"][tier]) or len(
                state["decks"][tier]
            ) > 0:
                return True
    for tier in (1, 2, 3):
        for card_id in state["market"][tier]:
            if card_id is None:
                continue
            ok, card, _ = find_purchasable_card(
                state, player_id, {"source": "market", "tier": tier, "cardId": card_id}
            )
            if ok and not analyze_payment(state, player_id, card)["errors"]:
                return True
    for reserved in player["reservedCards"]:
        if reserved["cardId"] is None:
            continue
        ok, card, _ = find_purchasable_card(
            state, player_id, {"source": "reserved", "cardId": reserved["cardId"]}
        )
        if ok and not analyze_payment(state, player_id, card)["errors"]:
            return True
    return False


# ---------------------------------------------------------------------------
# Engine (src/shared/rules/engine.ts)
# ---------------------------------------------------------------------------


def _failure(code: str, message: str) -> Dict[str, Any]:
    return {"ok": False, "errors": [{"code": code, "message": message}]}


def _failures(errors: List[Dict[str, str]]) -> Dict[str, Any]:
    return {"ok": False, "errors": errors}


def _add_log(
    state: Dict[str, Any],
    kind: str,
    message: str,
    i18n: Optional[Dict[str, Any]] = None,
    animation: Optional[Dict[str, Any]] = None,
) -> None:
    entry: Dict[str, Any] = {"id": state["nextLogID"], "kind": kind, "message": message}
    if i18n:
        entry["i18n"] = i18n
    if animation:
        entry["animation"] = animation
    state["actionLog"].append(entry)
    state["nextLogID"] += 1
    if len(state["actionLog"]) > 40:
        del state["actionLog"][0 : len(state["actionLog"]) - 40]


def _refill_market_slot(
    state: Dict[str, Any], tier: int, slot_index: int
) -> Optional[str]:
    replacement = state["decks"][tier].pop(0) if state["decks"][tier] else None
    state["market"][tier][slot_index] = replacement
    return replacement


def _all_players_have_equal_turns(state: Dict[str, Any]) -> bool:
    counts = [state["turnCounts"][player_id] for player_id in state["playerOrder"]]
    return all(count == counts[0] for count in counts)


def _finish_game(state: Dict[str, Any]) -> None:
    standings = create_standings(state)
    leader = standings[0]
    winners = [
        standing["playerID"]
        for standing in standings
        if standing["score"] == leader["score"]
        and standing["purchasedCardCount"] == leader["purchasedCardCount"]
    ]
    state["result"] = {"winners": winners, "standings": standings}
    _add_log(
        state,
        "game-over",
        f"Player {int(winners[0]) + 1} won the game."
        if len(winners) == 1
        else f"{' and '.join('Player ' + str(int(w) + 1) for w in winners)} shared the victory.",
        {"key": "win", "values": {"playerID": winners[0]}}
        if len(winners) == 1
        else {"key": "sharedWin", "values": {"playerIDs": winners}},
    )


def _complete_turn(state: Dict[str, Any], player_id: str) -> None:
    state["pending"] = None
    state["completedTurns"] += 1
    state["turnCounts"][player_id] += 1
    if not state["finalRound"] and get_score(state, player_id) >= 15:
        state["finalRound"] = {
            "triggeredBy": player_id,
            "triggeredAtCompletedTurn": state["completedTurns"],
        }
        _add_log(
            state,
            "final-round",
            f"Player {int(player_id) + 1} reached 15 prestige; the final round began.",
            {"key": "finalRound", "values": {"playerID": player_id}},
        )
    if state["finalRound"] and _all_players_have_equal_turns(state):
        _finish_game(state)
    state["turnReady"] = True


def _award_noble(state: Dict[str, Any], player_id: str, noble_id: str) -> None:
    state["availableNobleIds"] = [
        entry for entry in state["availableNobleIds"] if entry != noble_id
    ]
    state["players"][player_id]["nobleIds"].append(noble_id)
    _add_log(
        state,
        "noble",
        f"Player {int(player_id) + 1} received noble {noble_id}.",
        {"key": "noble", "values": {"playerID": player_id, "noble": noble_id}},
    )


def _resolve_nobles_or_complete(state: Dict[str, Any], player_id: str) -> None:
    eligible = get_eligible_noble_ids(state, player_id)
    if not eligible:
        _complete_turn(state, player_id)
        return
    if len(eligible) == 1:
        _award_noble(state, player_id, eligible[0])
        _complete_turn(state, player_id)
        return
    state["pending"] = {
        "type": "noble",
        "playerID": player_id,
        "eligibleNobleIds": eligible,
    }


def _resolve_after_main_action(state: Dict[str, Any], player_id: str) -> None:
    overage = total_tokens(state["players"][player_id]["tokens"]) - 10
    if overage > 0:
        state["pending"] = {"type": "discard", "playerID": player_id, "count": overage}
        return
    _resolve_nobles_or_complete(state, player_id)


def _validate_actor(
    state: Dict[str, Any], player_id: str, current_player_id: str
) -> Optional[Dict[str, Any]]:
    if player_id not in state["players"]:
        return _failure("PLAYER_NOT_FOUND", "Player was not found.")
    if state["result"]:
        return _failure("GAME_OVER", "The game is already over.")
    if state["turnReady"]:
        return _failure("TURN_COMPLETE", "This turn is already complete.")
    if player_id != current_player_id:
        return _failure("OUT_OF_TURN", "It is not your turn.")
    return None


def _take_different(
    state: Dict[str, Any], player_id: str, colors: List[str]
) -> Dict[str, Any]:
    available_colors = [color for color in NORMAL_COLORS if state["bank"][color] >= 1]
    expected_count = 2 if len(available_colors) == 2 else 3
    if not isinstance(colors, list) or len(colors) != expected_count:
        return _failure(
            "TAKE_DIFFERENT_COUNT",
            f"Choose exactly {expected_count} normal gem colors.",
        )
    if any(color not in NORMAL_COLORS for color in colors):
        return _failure("TAKE_GOLD", "Gold cannot be taken as a normal gem.")
    if len(set(colors)) != len(colors):
        return _failure(
            "TAKE_DIFFERENT_DUPLICATE", "The selected gem colors must be different."
        )
    for color in colors:
        if state["bank"][color] < 1:
            return _failure("TAKE_UNAVAILABLE", f"No {color} token is available in the bank.")
    next_state = _clone(state)
    for color in colors:
        next_state["bank"][color] -= 1
        next_state["players"][player_id]["tokens"][color] += 1
    _add_log(
        next_state,
        "tokens",
        f"Player {int(player_id) + 1} took one {', '.join(colors)} token"
        + ("s" if len(colors) > 1 else "") + ".",
        {"key": "different", "values": {"playerID": player_id, "colors": colors}},
    )
    _resolve_after_main_action(next_state, player_id)
    return {"ok": True, "value": next_state}


def _take_same(
    state: Dict[str, Any], player_id: str, color: str
) -> Dict[str, Any]:
    if color not in NORMAL_COLORS:
        return _failure(
            "TAKE_GOLD", "Choose one normal gem color; gold cannot be selected."
        )
    if state["bank"][color] < 4:
        return _failure(
            "TAKE_SAME_BANK", f"At least four {color} tokens must be in the bank."
        )
    next_state = _clone(state)
    next_state["bank"][color] -= 2
    next_state["players"][player_id]["tokens"][color] += 2
    _add_log(
        next_state,
        "tokens",
        f"Player {int(player_id) + 1} took two {color} tokens.",
        {"key": "same", "values": {"playerID": player_id, "color": color}},
    )
    _resolve_after_main_action(next_state, player_id)
    return {"ok": True, "value": next_state}


def _reserve_market(
    state: Dict[str, Any], player_id: str, tier: int, card_id: str
) -> Dict[str, Any]:
    if len(state["players"][player_id]["reservedCards"]) >= 3:
        return _failure(
            "RESERVE_LIMIT", "You may not hold more than three reserved cards."
        )
    if (
        tier not in (1, 2, 3)
        or not isinstance(card_id, str)
        or card_id not in state["market"].get(tier, [])
    ):
        return _failure(
            "RESERVE_MARKET_MISSING", "That card is no longer in the market."
        )
    card = get_card(card_id)
    if not card or card["tier"] != tier:
        return _failure("CARD_UNKNOWN", "Card data is invalid.")
    next_state = _clone(state)
    slot_index = next_state["market"][tier].index(card_id)
    if slot_index < 0:
        return _failure("RESERVE_MARKET_MISSING", "That card is no longer in the market.")
    next_state["market"][tier][slot_index] = None
    next_state["players"][player_id]["reservedCards"].append(
        {"cardId": card_id, "tier": tier, "source": "market"}
    )
    replacement_card_id = _refill_market_slot(next_state, tier, slot_index)
    if next_state["bank"]["gold"] > 0:
        next_state["bank"]["gold"] -= 1
        next_state["players"][player_id]["tokens"]["gold"] += 1
    _add_log(
        next_state,
        "reserve",
        f"Player {int(player_id) + 1} reserved public card {card_id}.",
        {"key": "reservePublic", "values": {"playerID": player_id, "card": card_id}},
        {
            "type": "market-card",
            "action": "reserve",
            "playerID": player_id,
            "tier": tier,
            "slotIndex": slot_index,
            "cardId": card_id,
            "replacementCardId": replacement_card_id,
        },
    )
    _resolve_after_main_action(next_state, player_id)
    return {"ok": True, "value": next_state}


def _reserve_deck(state: Dict[str, Any], player_id: str, tier: int) -> Dict[str, Any]:
    if len(state["players"][player_id]["reservedCards"]) >= 3:
        return _failure(
            "RESERVE_LIMIT", "You may not hold more than three reserved cards."
        )
    if tier not in (1, 2, 3) or len(state["decks"].get(tier, [])) == 0:
        return _failure("RESERVE_EMPTY_DECK", "That development deck is empty.")
    next_state = _clone(state)
    card_id = next_state["decks"][tier].pop(0)
    next_state["players"][player_id]["reservedCards"].append(
        {"cardId": card_id, "tier": tier, "source": "deck"}
    )
    if next_state["bank"]["gold"] > 0:
        next_state["bank"]["gold"] -= 1
        next_state["players"][player_id]["tokens"]["gold"] += 1
    _add_log(
        next_state,
        "reserve",
        f"Player {int(player_id) + 1} reserved a hidden tier {tier} card.",
        {"key": "reserveHidden", "values": {"playerID": player_id, "tier": tier}},
        {"type": "reserve-deck", "playerID": player_id, "tier": tier},
    )
    _resolve_after_main_action(next_state, player_id)
    return {"ok": True, "value": next_state}


def _purchase(state: Dict[str, Any], player_id: str, action: Dict[str, Any]) -> Dict[str, Any]:
    ok, card, errors = find_purchasable_card(state, player_id, action["location"])
    if not ok:
        return _failures(errors)
    payment = action["payment"]
    analysis = analyze_payment(state, player_id, card, payment)
    if analysis["errors"]:
        return _failures(analysis["errors"])
    next_state = _clone(state)
    for color in TOKEN_COLORS:
        next_state["players"][player_id]["tokens"][color] -= payment[color]
        next_state["bank"][color] += payment[color]
    next_state["players"][player_id]["purchasedCardIds"].append(card["id"])
    if action["location"]["source"] == "market":
        tier = action["location"]["tier"]
        slot_index = next_state["market"][tier].index(action["location"]["cardId"])
        if slot_index < 0:
            return _failure("CARD_NOT_IN_MARKET", "That card is no longer in the market.")
        next_state["market"][tier][slot_index] = None
        replacement_card_id = _refill_market_slot(next_state, tier, slot_index)
        _add_log(
            next_state,
            "purchase",
            f"Player {int(player_id) + 1} purchased {card['id']}.",
            {"key": "purchase", "values": {"playerID": player_id, "card": card["id"]}},
            {
                "type": "market-card",
                "action": "purchase",
                "playerID": player_id,
                "tier": tier,
                "slotIndex": slot_index,
                "cardId": card["id"],
                "replacementCardId": replacement_card_id,
            },
        )
    else:
        next_state["players"][player_id]["reservedCards"] = [
            reserved
            for reserved in next_state["players"][player_id]["reservedCards"]
            if reserved["cardId"] != action["location"]["cardId"]
        ]
        _add_log(
            next_state,
            "purchase",
            f"Player {int(player_id) + 1} purchased {card['id']}.",
            {"key": "purchase", "values": {"playerID": player_id, "card": card["id"]}},
            {"type": "reserved-purchase", "playerID": player_id, "cardId": card["id"]},
        )
    _resolve_after_main_action(next_state, player_id)
    return {"ok": True, "value": next_state}


def apply_main_action(
    state: Dict[str, Any],
    player_id: str,
    current_player_id: str,
    action: Dict[str, Any],
) -> Dict[str, Any]:
    actor_error = _validate_actor(state, player_id, current_player_id)
    if actor_error:
        return actor_error
    if state["pending"]:
        return _failure(
            "PENDING_RESOLUTION",
            "Return excess tokens before taking another action."
            if state["pending"]["type"] == "discard"
            else "Choose a noble before taking another action.",
        )
    if not isinstance(action, dict):
        return _failure("ACTION_INVALID", "Action is missing or invalid.")
    action_type = action["type"]
    if action_type == "takeDifferent":
        return _take_different(state, player_id, action["colors"])
    if action_type == "takeSame":
        return _take_same(state, player_id, action["color"])
    if action_type == "reserveMarket":
        return _reserve_market(state, player_id, action["tier"], action["cardId"])
    if action_type == "reserveDeck":
        return _reserve_deck(state, player_id, action["tier"])
    if action_type == "purchase":
        return _purchase(state, player_id, action)
    if action_type == "pass":
        if has_legal_main_action(state, player_id):
            return _failure(
                "PASS_NOT_NEEDED",
                "A legal action exists; passing is only allowed as a stall rescue.",
            )
        next_state = _clone(state)
        _add_log(
            next_state,
            "pass",
            f"Player {int(player_id) + 1} passed (no legal action).",
            {"key": "pass", "values": {"playerID": player_id}},
        )
        _resolve_after_main_action(next_state, player_id)
        return {"ok": True, "value": next_state}
    return _failure("ACTION_INVALID", "Action type is invalid.")


def apply_discard(
    state: Dict[str, Any],
    player_id: str,
    current_player_id: str,
    returned: Dict[str, int],
) -> Dict[str, Any]:
    actor_error = _validate_actor(state, player_id, current_player_id)
    if actor_error:
        return actor_error
    pending = state["pending"]
    if (
        not pending
        or pending["type"] != "discard"
        or pending["playerID"] != player_id
    ):
        return _failure("DISCARD_NOT_PENDING", "No token return is pending.")
    errors = []
    returned_total = 0
    if not isinstance(returned, dict):
        return _failure("DISCARD_SHAPE", "Token return is missing.")
    for color in TOKEN_COLORS:
        amount = returned.get(color)
        if not isinstance(amount, int) or isinstance(amount, bool) or amount < 0:
            errors.append(
                {
                    "code": "DISCARD_AMOUNT",
                    "message": f"{color} return must be a non-negative integer.",
                }
            )
            continue
        returned_total += amount
        if amount > state["players"][player_id]["tokens"][color]:
            errors.append(
                {
                    "code": "DISCARD_NOT_OWNED",
                    "message": f"You do not own {amount} {color} tokens.",
                }
            )
    if returned_total != pending["count"]:
        errors.append(
            {
                "code": "DISCARD_EXACT",
                "message": f"Return exactly {pending['count']} token"
                + ("s" if pending["count"] != 1 else "") + ".",
            }
        )
    if errors:
        return _failures(errors)
    next_state = _clone(state)
    for color in TOKEN_COLORS:
        next_state["players"][player_id]["tokens"][color] -= returned[color]
        next_state["bank"][color] += returned[color]
    _add_log(
        next_state,
        "discard",
        f"Player {int(player_id) + 1} returned "
        + ", ".join(
            f"{returned[color]} {color}"
            for color in TOKEN_COLORS
            if returned.get(color, 0) > 0
        )
        + ".",
        {"key": "discard", "values": {"playerID": player_id, "tokens": returned}},
    )
    next_state["pending"] = None
    _resolve_nobles_or_complete(next_state, player_id)
    return {"ok": True, "value": next_state}


def apply_noble_selection(
    state: Dict[str, Any],
    player_id: str,
    current_player_id: str,
    noble_id: str,
) -> Dict[str, Any]:
    actor_error = _validate_actor(state, player_id, current_player_id)
    if actor_error:
        return actor_error
    pending = state["pending"]
    if (
        not pending
        or pending["type"] != "noble"
        or pending["playerID"] != player_id
    ):
        return _failure("NOBLE_NOT_PENDING", "No noble selection is pending.")
    if (
        not isinstance(noble_id, str)
        or noble_id not in pending["eligibleNobleIds"]
        or noble_id not in get_eligible_noble_ids(state, player_id)
    ):
        return _failure(
            "NOBLE_INELIGIBLE", "That noble is not currently available to you."
        )
    next_state = _clone(state)
    next_state["pending"] = None
    _award_noble(next_state, player_id, noble_id)
    _complete_turn(next_state, player_id)
    return {"ok": True, "value": next_state}


def suggested_discard(state: Dict[str, Any], player_id: str) -> Dict[str, int]:
    suggestion = empty_token_counts()
    pending = state["pending"]
    remaining = (
        pending["count"]
        if pending and pending["type"] == "discard" and pending["playerID"] == player_id
        else 0
    )
    for color in reversed(TOKEN_COLORS):
        amount = min(state["players"][player_id]["tokens"].get(color, 0), remaining)
        suggestion[color] = amount
        remaining -= amount
    return suggestion


# ---------------------------------------------------------------------------
# Legal action enumeration (src/shared/ai/legal-actions.ts)
# ---------------------------------------------------------------------------


def _color_combinations(colors: List[str], size: int) -> List[List[str]]:
    results: List[List[str]] = []
    current: List[str] = []

    def visit(start: int) -> None:
        if len(current) == size:
            results.append(list(current))
            return
        for index in range(start, len(colors)):
            current.append(colors[index])
            visit(index + 1)
            current.pop()

    visit(0)
    return results


def _build_discards(
    owned: Dict[str, int],
    count: int,
    color_index: int,
    current: Dict[str, int],
    output: List[Dict[str, int]],
    budget: Dict[str, int],
) -> None:
    if budget["remaining"] <= 0:
        return
    if color_index == len(TOKEN_COLORS):
        if count == 0:
            output.append(dict(current))
            budget["remaining"] -= 1
        return
    color = TOKEN_COLORS[color_index]
    maximum = min(owned[color], count)
    for amount in range(0, maximum + 1):
        current[color] = amount
        _build_discards(
            owned, count - amount, color_index + 1, current, output, budget
        )
        if budget["remaining"] <= 0:
            return
    current[color] = 0


def enumerate_discard_candidates(
    state: Dict[str, Any],
    player_id: str,
    max_candidates: int = MAX_DISCARD_CANDIDATES,
) -> List[Dict[str, Any]]:
    pending = state["pending"]
    if not pending or pending["type"] != "discard" or pending["playerID"] != player_id:
        return []
    owned = state["players"][player_id]["tokens"]
    candidates: List[Dict[str, int]] = []
    _build_discards(
        owned,
        pending["count"],
        0,
        empty_token_counts(),
        candidates,
        {"remaining": max_candidates},
    )
    return [
        {
            "actionKey": f"discard:{index}",
            "move": {"move": "discardTokens", "args": [counts]},
        }
        for index, counts in enumerate(candidates)
    ]


def enumerate_noble_candidates(
    state: Dict[str, Any], player_id: str
) -> List[Dict[str, Any]]:
    pending = state["pending"]
    if not pending or pending["type"] != "noble" or pending["playerID"] != player_id:
        return []
    eligible = set(get_eligible_noble_ids(state, player_id))
    return [
        {
            "actionKey": f"noble:{noble_id}",
            "move": {"move": "chooseNoble", "args": [noble_id]},
        }
        for noble_id in pending["eligibleNobleIds"]
        if noble_id in eligible
    ]


def _purchase_action(
    player_id: str, state: Dict[str, Any], location: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    ok, card, _ = find_purchasable_card(state, player_id, location)
    if not ok:
        return None
    analysis = analyze_payment(state, player_id, card)
    if analysis["errors"]:
        return None
    return {
        "type": "purchase",
        "location": location,
        "payment": analysis["suggestedPayment"],
    }


def enumerate_main_actions(
    state: Dict[str, Any], player_id: str, current_player: str
) -> List[Dict[str, Any]]:
    if state["pending"] is not None:
        return []
    player = state["players"].get(player_id)
    if not player or player_id != current_player:
        return []
    candidates: List[Dict[str, Any]] = []
    reserve_limit = len(player["reservedCards"]) < 3
    available_colors = [color for color in NORMAL_COLORS if state["bank"][color] > 0]
    if len(available_colors) == 2:
        candidates.append(
            {
                "actionKey": f"takeDifferent:{','.join(available_colors)}",
                "move": {
                    "move": "mainAction",
                    "args": [
                        {"type": "takeDifferent", "colors": list(available_colors)}
                    ],
                },
            }
        )
    else:
        for colors in _color_combinations(NORMAL_COLORS, 3):
            if all(state["bank"][color] > 0 for color in colors):
                candidates.append(
                    {
                        "actionKey": f"takeDifferent:{','.join(colors)}",
                        "move": {
                            "move": "mainAction",
                            "args": [{"type": "takeDifferent", "colors": colors}],
                        },
                    }
                )
    for color in NORMAL_COLORS:
        if state["bank"][color] >= 4:
            candidates.append(
                {
                    "actionKey": f"takeSame:{color}",
                    "move": {
                        "move": "mainAction",
                        "args": [{"type": "takeSame", "color": color}],
                    },
                }
            )
    if reserve_limit:
        for tier in (1, 2, 3):
            for card_id in state["market"][tier]:
                if card_id is not None:
                    candidates.append(
                        {
                            "actionKey": f"reserveMarket:{tier}:{card_id}",
                            "move": {
                                "move": "mainAction",
                                "args": [
                                    {
                                        "type": "reserveMarket",
                                        "tier": tier,
                                        "cardId": card_id,
                                    }
                                ],
                            },
                        }
                    )
            if len(state["decks"][tier]) > 0:
                candidates.append(
                    {
                        "actionKey": f"reserveDeck:{tier}",
                        "move": {
                            "move": "mainAction",
                            "args": [{"type": "reserveDeck", "tier": tier}],
                        },
                    }
                )
    for tier in (1, 2, 3):
        for card_id in state["market"][tier]:
            if card_id is None:
                continue
            location = {"source": "market", "tier": tier, "cardId": card_id}
            action = _purchase_action(player_id, state, location)
            if action:
                candidates.append(
                    {
                        "actionKey": f"purchase:market:{tier}:{card_id}",
                        "move": {"move": "mainAction", "args": [action]},
                    }
                )
    for reserved in player["reservedCards"]:
        if reserved["cardId"] is None:
            continue
        location = {"source": "reserved", "cardId": reserved["cardId"]}
        action = _purchase_action(player_id, state, location)
        if action:
            candidates.append(
                {
                    "actionKey": f"purchase:reserved:{reserved['cardId']}",
                    "move": {"move": "mainAction", "args": [action]},
                }
            )
    if not candidates and not has_legal_main_action(state, player_id):
        candidates.append(
            {
                "actionKey": "pass:stall-rescue",
                "move": {"move": "mainAction", "args": [{"type": "pass"}]},
            }
        )
    return candidates


def enumerate_legal_actions(
    state: Dict[str, Any], player_id: str, current_player: str
) -> List[Dict[str, Any]]:
    pending = state["pending"]
    if pending and pending["type"] == "discard":
        return enumerate_discard_candidates(state, player_id)
    if pending and pending["type"] == "noble":
        return enumerate_noble_candidates(state, player_id)
    return enumerate_main_actions(state, player_id, current_player)


# ---------------------------------------------------------------------------
# Simulation wrapper (src/shared/ai/simulate.ts) + player view/observation
# ---------------------------------------------------------------------------


class SimulationState:
    def __init__(
        self,
        G: Dict[str, Any],
        current_player: str,
        play_order: List[str],
        play_order_pos: int,
        state_id: int = 0,
    ) -> None:
        self.G = G
        self.current_player = current_player
        self.play_order = play_order
        self.play_order_pos = play_order_pos
        self.state_id = state_id

    def ctx(self) -> Dict[str, Any]:
        return {
            "currentPlayer": self.current_player,
            "playOrder": list(self.play_order),
            "playOrderPos": self.play_order_pos,
        }


def create_simulation(
    G: Dict[str, Any],
    ctx: Dict[str, Any],
    state_id: int = 0,
) -> SimulationState:
    return SimulationState(
        G,
        ctx["currentPlayer"],
        list(ctx["playOrder"]),
        ctx["playOrderPos"],
        state_id,
    )


def _advance_if_turn_complete(sim: SimulationState) -> None:
    if sim.G["result"] is not None:
        return
    if not sim.G["turnReady"]:
        return
    if sim.G["pending"] is not None:
        return
    sim.play_order_pos = (sim.play_order_pos + 1) % len(sim.play_order)
    sim.current_player = sim.play_order[sim.play_order_pos]
    sim.G["turnReady"] = False


def _apply_result(sim: SimulationState, result: Dict[str, Any]) -> Dict[str, Any]:
    if not result["ok"]:
        return result
    sim.G = result["value"]
    sim.state_id += 1
    _advance_if_turn_complete(sim)
    return {"ok": True, "value": sim.G}


def apply_simulation_main_action(
    sim: SimulationState, player_id: str, action: Dict[str, Any]
) -> Dict[str, Any]:
    return _apply_result(
        sim, apply_main_action(sim.G, player_id, sim.current_player, action)
    )


def apply_simulation_discard(
    sim: SimulationState, player_id: str, returned: Dict[str, int]
) -> Dict[str, Any]:
    return _apply_result(
        sim, apply_discard(sim.G, player_id, sim.current_player, returned)
    )


def apply_simulation_noble(
    sim: SimulationState, player_id: str, noble_id: str
) -> Dict[str, Any]:
    return _apply_result(
        sim, apply_noble_selection(sim.G, player_id, sim.current_player, noble_id)
    )


def clone_simulation(sim: SimulationState) -> SimulationState:
    return SimulationState(
        _clone(sim.G),
        sim.current_player,
        list(sim.play_order),
        sim.play_order_pos,
        sim.state_id,
    )


HIDDEN_CARD_ID = "__hidden__"


def create_player_view(state: Dict[str, Any], player_id: str) -> Dict[str, Any]:
    view = _clone(state)
    for tier in (1, 2, 3):
        view["decks"][tier] = [HIDDEN_CARD_ID] * len(state["decks"][tier])
    for other_id, player in state["players"].items():
        if other_id == player_id:
            continue
        for reserved in view["players"][other_id]["reservedCards"]:
            if reserved["source"] == "deck":
                reserved["cardId"] = None
    return view


def create_observation(
    player_view: Dict[str, Any], player_id: str, ctx: Dict[str, Any]
) -> Dict[str, Any]:
    for tier in (1, 2, 3):
        if any(card_id != HIDDEN_CARD_ID for card_id in player_view["decks"][tier]):
            raise ValueError(
                f"deck tier {tier} contains real card IDs; feed the filtered playerView."
            )
    observation = {
        "version": 1,
        "playerID": player_id,
        "bank": dict(player_view["bank"]),
        "market": {
            tier: list(player_view["market"][tier]) for tier in (1, 2, 3)
        },
        "deckCounts": {
            tier: len(player_view["decks"][tier]) for tier in (1, 2, 3)
        },
        "availableNobleIds": list(player_view["availableNobleIds"]),
        "players": {
            owner_id: {
                "tokens": dict(player_view["players"][owner_id]["tokens"]),
                "purchasedCardIds": list(
                    player_view["players"][owner_id]["purchasedCardIds"]
                ),
                "reservedCards": [
                    {
                        "tier": reserved["tier"],
                        "source": reserved["source"],
                        "cardId": reserved["cardId"],
                    }
                    for reserved in player_view["players"][owner_id]["reservedCards"]
                ],
                "nobleIds": list(player_view["players"][owner_id]["nobleIds"]),
            }
            for owner_id in player_view["playerOrder"]
        },
        "playerOrder": list(player_view["playerOrder"]),
        "currentPlayer": ctx["currentPlayer"],
        "playOrderPos": ctx["playOrderPos"],
        "turnReady": player_view["turnReady"],
        "pending": _clone(player_view["pending"]),
        "completedTurns": player_view["completedTurns"],
        "turnCounts": dict(player_view["turnCounts"]),
        "finalRound": _clone(player_view["finalRound"]),
        "result": _clone(player_view["result"]),
    }
    return observation
