"""Train the policy-value baseline from TS search-policy data (guide §5.2).

Usage:
    python3 ai_bot/neural/train/train.py --data <positions.jsonl> \
        --epochs 12 --batch-size 256 --out <checkpoint-dir>
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time

import torch
from torch import nn

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from model.net import PolicyValueNet  # noqa: E402
from train.dataset import (  # noqa: E402
    load_positions,
    make_batch,
    precompute_actions,
    precompute_observations,
    train_holdout_split,
)


def evaluate(
    net: PolicyValueNet,
    positions,
    observations,
    action_arrays,
    mask_arrays,
    target_list,
    indices,
    batch_size: int,
) -> dict:
    net.eval()
    correct = 0
    total = 0
    value_error = 0.0
    with torch.no_grad():
        for start in range(0, len(indices), batch_size):
            chunk = indices[start : start + batch_size]
            obs, actions, masks, batch_targets, outcomes = make_batch(
                positions,
                observations,
                action_arrays,
                mask_arrays,
                target_list,
                chunk,
            )
            logits, value = net(obs, actions, masks)
            predicted = logits.argmax(dim=-1)
            correct += (predicted == batch_targets).sum().item()
            total += len(chunk)
            value_error += torch.abs(value - outcomes).sum().item()
    return {
        "accuracy": correct / max(1, total),
        "mean_value_error": value_error / max(1, total),
        "count": total,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True)
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, default=1234)
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    random.seed(args.seed)
    os.makedirs(args.out, exist_ok=True)

    positions = load_positions(args.data)
    train_indices, holdout_indices = train_holdout_split(positions)
    print(
        f"positions={len(positions)} train={len(train_indices)} "
        f"holdout={len(holdout_indices)}"
    )
    observations = precompute_observations(positions)
    action_arrays, mask_arrays, target_list = precompute_actions(positions)

    net = PolicyValueNet()
    optimizer = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-4)
    policy_loss_fn = nn.CrossEntropyLoss()
    value_loss_fn = nn.MSELoss()

    started = time.time()
    steps_per_epoch = max(1, len(train_indices) // args.batch_size)
    for epoch in range(args.epochs):
        net.train()
        random.shuffle(train_indices)
        total_policy = 0.0
        total_value = 0.0
        for start in range(0, len(train_indices), args.batch_size):
            chunk = train_indices[start : start + args.batch_size]
            obs, actions, masks, targets, outcomes = make_batch(
                positions,
                observations,
                action_arrays,
                mask_arrays,
                target_list,
                chunk,
            )
            optimizer.zero_grad()
            logits, value = net(obs, actions, masks)
            policy_loss = policy_loss_fn(logits, targets)
            value_loss = value_loss_fn(value, outcomes)
            loss = policy_loss + value_loss
            loss.backward()
            optimizer.step()
            total_policy += policy_loss.item()
            total_value += value_loss.item()
        train_metrics = evaluate(
            net,
            positions,
            observations,
            action_arrays,
            mask_arrays,
            target_list,
            train_indices[:2000],
            args.batch_size,
        )
        holdout_metrics = evaluate(
            net,
            positions,
            observations,
            action_arrays,
            mask_arrays,
            target_list,
            holdout_indices,
            args.batch_size,
        )
        elapsed = time.time() - started
        print(
            f"epoch {epoch + 1}/{args.epochs} "
            f"policy={total_policy / steps_per_epoch:.4f} "
            f"value={total_value / steps_per_epoch:.4f} "
            f"train_acc={train_metrics['accuracy']:.3f} "
            f"holdout_acc={holdout_metrics['accuracy']:.3f} "
            f"holdout_val_err={holdout_metrics['mean_value_error']:.3f} "
            f"({elapsed:.0f}s)"
        )
        torch.save(
            net.state_dict(),
            os.path.join(args.out, f"checkpoint-epoch-{epoch + 1}.pt"),
        )

    final_metrics = evaluate(
        net,
        positions,
        observations,
        action_arrays,
        mask_arrays,
        target_list,
        holdout_indices,
        args.batch_size,
    )
    config = {
        "architecture": "deep-sets-policy-value-v1",
        "obs_dim": 462,
        "action_dim": 43,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "lr": args.lr,
        "seed": args.seed,
        "data": os.path.abspath(args.data),
        "holdout_accuracy": final_metrics["accuracy"],
        "holdout_value_error": final_metrics["mean_value_error"],
        "positions": len(positions),
    }
    with open(os.path.join(args.out, "config.json"), "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)
    print(
        f"final holdout accuracy={final_metrics['accuracy']:.3f} "
        f"value_error={final_metrics['mean_value_error']:.3f}"
    )


if __name__ == "__main__":
    main()
