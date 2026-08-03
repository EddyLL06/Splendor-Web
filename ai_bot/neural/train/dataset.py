"""JSONL dataset loader for the neural policy baseline."""

from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Tuple

import numpy as np
import torch

from features.encode import ACTION_DIM, OBS_DIM, encode_ai_move, encode_observation

MAX_ACTIONS = 64


class Position:
    __slots__ = (
        "observation",
        "legal",
        "chosen",
        "outcome",
        "holdout",
        "visits",
        "search_value",
    )

    def __init__(
        self,
        observation: Dict[str, Any],
        legal: List[Dict[str, Any]],
        chosen: str,
        outcome: float,
        holdout: bool,
        visits: Dict[str, int],
        search_value: float,
    ) -> None:
        self.observation = observation
        self.legal = legal
        self.chosen = chosen
        self.outcome = outcome
        self.holdout = holdout
        self.visits = visits
        self.search_value = search_value


def load_positions(path: str, holdout_mod: int = 10) -> List[Position]:
    positions: List[Position] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            meta_raw, entry_raw = line.split(" ", 1)
            meta = json.loads(meta_raw)
            entry = json.loads(entry_raw)
            keys = [item["key"] for item in entry["legal"]]
            if entry["chosen"] not in keys:
                raise ValueError(
                    f"chosen action {entry['chosen']} not in legal set"
                )
            positions.append(
                Position(
                    observation=entry["obs"],
                    legal=entry["legal"],
                    chosen=entry["chosen"],
                    outcome=float(meta["outcome"]),
                    holdout=meta["gameIndex"] % holdout_mod == 0,
                    visits=entry.get("visits") or {},
                    search_value=(
                        float(entry["searchValue"])
                        if entry.get("searchValue") is not None
                        else float("nan")
                    ),
                )
            )
    return positions


def precompute_observations(positions: List[Position]) -> np.ndarray:
    observations = np.zeros((len(positions), OBS_DIM), dtype=np.float32)
    for index, position in enumerate(positions):
        observations[index] = np.asarray(
            encode_observation(position.observation), dtype=np.float32
        )
    return observations


def precompute_actions(
    positions: List[Position],
) -> Tuple[
    List[np.ndarray],
    List[np.ndarray],
    List[np.ndarray],
    List[float],
    List[float],
]:
    """Precompute padded action tensors per position (max 64 actions)."""
    action_arrays: List[np.ndarray] = []
    mask_arrays: List[np.ndarray] = []
    target_arrays: List[np.ndarray] = []
    value_targets: List[float] = []
    for position in positions:
        legal = position.legal[:MAX_ACTIONS]
        count = len(legal)
        actions = np.zeros((count, ACTION_DIM), dtype=np.float32)
        masks = np.ones((count,), dtype=np.float32)
        target = np.zeros((count,), dtype=np.float32)
        total_visits = sum(position.visits.values())
        chosen_row = -1
        for column, candidate in enumerate(legal):
            actions[column] = np.asarray(
                encode_ai_move(candidate["move"], position.observation),
                dtype=np.float32,
            )
            if position.visits:
                target[column] = (
                    position.visits.get(candidate["key"], 0) / max(1, total_visits)
                )
            if candidate["key"] == position.chosen:
                chosen_row = column
        if chosen_row < 0:
            chosen_row = count
            target_entry = next(
                item for item in position.legal if item["key"] == position.chosen
            )
            actions = np.concatenate(
                [
                    actions,
                    np.asarray(
                        [encode_ai_move(target_entry["move"], position.observation)],
                        dtype=np.float32,
                    ),
                ],
                axis=0,
            )
            masks = np.concatenate([masks, np.ones((1,), dtype=np.float32)])
            count += 1
            target = np.concatenate(
                [target, np.asarray([1.0 / max(1, count)], dtype=np.float32)]
            )
        elif not position.visits:
            target[chosen_row] = 1.0
        action_arrays.append(actions)
        mask_arrays.append(masks)
        target_arrays.append(target)
        if position.search_value == position.search_value:
            value_targets.append(
                max(-1.0, min(1.0, position.search_value))
            )
        else:
            value_targets.append(position.outcome)
    return action_arrays, mask_arrays, target_arrays, value_targets


def make_batch(
    positions: List[Position],
    observations: np.ndarray,
    action_arrays: List[np.ndarray],
    mask_arrays: List[np.ndarray],
    target_arrays: List[np.ndarray],
    value_targets: List[float],
    indices: List[int],
) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    action_count = max(action_arrays[index].shape[0] for index in indices)
    obs = torch.from_numpy(observations[indices])
    actions = torch.zeros(
        (len(indices), action_count, ACTION_DIM), dtype=torch.float32
    )
    masks = torch.zeros((len(indices), action_count), dtype=torch.float32)
    target_matrix = torch.zeros(
        (len(indices), action_count), dtype=torch.float32
    )
    outcomes = torch.zeros((len(indices),), dtype=torch.float32)
    for row, index in enumerate(indices):
        count = action_arrays[index].shape[0]
        actions[row, :count] = torch.from_numpy(action_arrays[index])
        masks[row, :count] = torch.from_numpy(mask_arrays[index])
        target_matrix[row, :count] = torch.from_numpy(target_arrays[index])
        outcomes[row] = value_targets[index]
    return obs, actions, masks, target_matrix, outcomes


def train_holdout_split(
    positions: List[Position],
) -> Tuple[List[int], List[int]]:
    train = [
        index for index, position in enumerate(positions) if not position.holdout
    ]
    holdout = [
        index for index, position in enumerate(positions) if position.holdout
    ]
    return train, holdout
