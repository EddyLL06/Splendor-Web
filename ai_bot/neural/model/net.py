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
        # Finite large-negative mask keeps fp16 gradients stable while making
        # padded actions' softmax probability effectively zero.
        logits = logits.masked_fill(action_mask == 0, float("-1e4"))
        value = self.value_head(state_h).squeeze(-1)  # (B,)
        return logits, value


class PolicyValueNetAttention(nn.Module):
    """Guide §4.1 attention trunk: typed entity encoders + 2 transformer
    blocks + pooled state, with the same action-scoring interface as the
    Deep Sets fallback. Inputs remain the flat padded observation vector,
    sliced back into entity groups for the attention sequence."""

    def __init__(
        self,
        d_model: int = 128,
        heads: int = 4,
        layers: int = 2,
        ffn_dim: int = 256,
    ) -> None:
        super().__init__()
        self.d_model = d_model
        # Entity slice boundaries of the 462-dim observation:
        # global 15, players 4x16, market 12x13, reserved 12x16, nobles 5x7.
        self.global_mlp = nn.Sequential(nn.Linear(15, d_model), nn.ReLU())
        self.player_mlp = nn.Sequential(nn.Linear(16, d_model), nn.ReLU())
        self.market_mlp = nn.Sequential(nn.Linear(13, d_model), nn.ReLU())
        self.reserved_mlp = nn.Sequential(nn.Linear(16, d_model), nn.ReLU())
        self.noble_mlp = nn.Sequential(nn.Linear(7, d_model), nn.ReLU())
        self.state_token = nn.Parameter(torch.zeros(1, 1, d_model))
        layer = nn.TransformerEncoderLayer(
            d_model=d_model,
            nhead=heads,
            dim_feedforward=ffn_dim,
            dropout=0.0,
            activation="relu",
            batch_first=True,
        )
        self.trunk = nn.TransformerEncoder(layer, num_layers=layers)
        self.pool_mlp = nn.Sequential(
            nn.Linear(d_model, d_model),
            nn.ReLU(),
        )
        self.action_encoder = nn.Sequential(
            nn.Linear(ACTION_DIM, d_model),
            nn.ReLU(),
        )
        self.policy_head = nn.Sequential(
            nn.Linear(d_model * 3, ffn_dim),
            nn.ReLU(),
            nn.Linear(ffn_dim, 1),
        )
        self.value_head = nn.Sequential(
            nn.Linear(d_model, 64),
            nn.ReLU(),
            nn.Linear(64, 1),
            nn.Tanh(),
        )

    def _state_embedding(self, observation: torch.Tensor) -> torch.Tensor:
        batch = observation.shape[0]
        global_vec = observation[:, 0:15]
        players = observation[:, 15:79].reshape(batch, 4, 16)
        market = observation[:, 79:235].reshape(batch, 12, 13)
        reserved = observation[:, 235:427].reshape(batch, 12, 16)
        nobles = observation[:, 427:462].reshape(batch, 5, 7)
        entities = torch.cat(
            [
                self.global_mlp(global_vec).unsqueeze(1),
                self.player_mlp(players),
                self.market_mlp(market),
                self.reserved_mlp(reserved),
                self.noble_mlp(nobles),
                self.state_token.expand(batch, -1, -1),
            ],
            dim=1,
        )
        encoded = self.trunk(entities)
        state_h = self.pool_mlp(encoded[:, -1])
        return state_h

    def forward(
        self,
        observation: torch.Tensor,
        actions: torch.Tensor,
        action_mask: torch.Tensor,
    ) -> tuple[torch.Tensor, torch.Tensor]:
        state_h = self._state_embedding(observation)
        batch_size, action_count, _ = actions.shape
        action_h = self.action_encoder(
            actions.reshape(batch_size * action_count, -1)
        ).reshape(batch_size, action_count, -1)
        state_expanded = state_h.unsqueeze(1).expand(-1, action_count, -1)
        combined = torch.cat(
            [state_expanded, action_h, state_expanded * action_h], dim=-1
        )
        logits = self.policy_head(combined).squeeze(-1)
        logits = logits.masked_fill(action_mask == 0, float("-1e4"))
        value = self.value_head(state_h).squeeze(-1)
        return logits, value
