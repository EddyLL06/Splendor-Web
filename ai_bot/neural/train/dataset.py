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
    __slots__ = ("observation", "legal", "chosen", "outcome", "holdout")

    def __init__(
        self,
        observation: Dict[str, Any],
        legal: List[Dict[str, Any]],
        chosen: str,
        outcome: float,
        holdout: bool,
    ) -> None:
        self.observation = observation
        self.legal = legal
        self.chosen = chosen
        self.outcome = outcome
        self.holdout = holdout


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
) -> Tuple[List[np.ndarray], List[np.ndarray], List[int]]:
    """Precompute padded action tensors per position (max 64 actions)."""
    action_arrays: List[np.ndarray] = []
    mask_arrays: List[np.ndarray] = []
    targets: List[int] = []
    for position in positions:
        legal = position.legal[:MAX_ACTIONS]
        count = len(legal)
        actions = np.zeros((count, ACTION_DIM), dtype=np.float32)
        masks = np.ones((count,), dtype=np.float32)
        chosen_row = -1
        for column, candidate in enumerate(legal):
            actions[column] = np.asarray(
                encode_ai_move(candidate["move"], position.observation),
                dtype=np.float32,
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
        action_arrays.append(actions)
        mask_arrays.append(masks)
        targets.append(chosen_row)
    return action_arrays, mask_arrays, targets


def make_batch(
    positions: List[Position],
    observations: np.ndarray,
    action_arrays: List[np.ndarray],
    mask_arrays: List[np.ndarray],
    targets: List[int],
    indices: List[int],
) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    action_count = max(action_arrays[index].shape[0] for index in indices)
    obs = torch.from_numpy(observations[indices])
    actions = torch.zeros(
        (len(indices), action_count, ACTION_DIM), dtype=torch.float32
    )
    masks = torch.zeros((len(indices), action_count), dtype=torch.float32)
    target_tensor = torch.zeros((len(indices),), dtype=torch.long)
    outcomes = torch.zeros((len(indices),), dtype=torch.float32)
    for row, index in enumerate(indices):
        count = action_arrays[index].shape[0]
        actions[row, :count] = torch.from_numpy(action_arrays[index])
        masks[row, :count] = torch.from_numpy(mask_arrays[index])
        target_tensor[row] = targets[index]
        outcomes[row] = positions[index].outcome
    return obs, actions, masks, target_tensor, outcomes


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
