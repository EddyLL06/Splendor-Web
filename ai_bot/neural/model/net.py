"""Small entity policy-value network (guide §4 Deep Sets fallback).

The state encoder is a plain MLP over the fixed 462-dim padded observation
vector; actions are scored individually against the state embedding so the
model only ever scores the supplied legal set.
"""

from __future__ import annotations

import torch
from torch import nn

from features.encode import ACTION_DIM, OBS_DIM


class PolicyValueNet(nn.Module):
    def __init__(self, hidden: int = 256, state_dim: int = 128) -> None:
        super().__init__()
        self.obs_encoder = nn.Sequential(
            nn.Linear(OBS_DIM, hidden),
            nn.ReLU(),
            nn.Linear(hidden, state_dim),
            nn.ReLU(),
        )
        self.action_encoder = nn.Sequential(
            nn.Linear(ACTION_DIM, state_dim),
            nn.ReLU(),
        )
        self.policy_head = nn.Sequential(
            nn.Linear(state_dim * 3, 128),
            nn.ReLU(),
            nn.Linear(128, 1),
        )
        self.value_head = nn.Sequential(
            nn.Linear(state_dim, 64),
            nn.ReLU(),
            nn.Linear(64, 1),
            nn.Tanh(),
        )

    def forward(
        self,
        observation: torch.Tensor,
        actions: torch.Tensor,
        action_mask: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        """observation: (B, 462); actions: (B, A, 43); mask: (B, A)."""
        state_h = self.obs_encoder(observation)  # (B, state_dim)
        batch_size, action_count, _ = actions.shape
        action_h = self.action_encoder(
            actions.reshape(batch_size * action_count, -1)
        ).reshape(batch_size, action_count, -1)
        state_expanded = state_h.unsqueeze(1).expand(
            -1, action_count, -1
        )
        combined = torch.cat(
            [state_expanded, action_h, state_expanded * action_h], dim=-1
        )
        logits = self.policy_head(combined).squeeze(-1)  # (B, A)
        logits = logits.masked_fill(action_mask == 0, float("-inf"))
        value = self.value_head(state_h).squeeze(-1)  # (B,)
        return logits, value
