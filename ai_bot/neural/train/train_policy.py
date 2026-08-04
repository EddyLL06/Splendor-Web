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

from model.net import PolicyValueNet, PolicyValueNetAttention  # noqa: E402
from features.encode import ACTION_DIM, OBS_DIM  # noqa: E402
from train.dataset import (  # noqa: E402
    make_batch_memmap,
    precompute_memmap,
)


def evaluate(
    net: PolicyValueNet,
    dataset,
    indices,
    batch_size: int,
    device: torch.device,
) -> dict:
    net.eval()
    correct = 0
    total = 0
    value_error = 0.0
    with torch.no_grad():
        for start in range(0, len(indices), batch_size):
            chunk = indices[start : start + batch_size]
            obs, actions, masks, batch_targets, outcomes = make_batch_memmap(
                dataset,
                chunk,
            )
            obs = obs.to(device)
            actions = actions.to(device)
            masks = masks.to(device)
            logits, value = net(obs, actions, masks)
            predicted = logits.argmax(dim=-1)
            expected = batch_targets.to(device).argmax(dim=-1)
            correct += (predicted == expected).sum().item()
            total += len(chunk)
            value_error += torch.abs(value - outcomes.to(device)).sum().item()
    return {
        "accuracy": correct / max(1, total),
        "mean_value_error": value_error / max(1, total),
        "count": total,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", required=True, help="Comma-separated positions.jsonl paths")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-size", type=int, default=512)
    parser.add_argument("--lr", type=float, default=3e-4)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, default=1234)
    parser.add_argument("--init", default=None, help="Optional checkpoint to fine-tune from")
    parser.add_argument("--value-weight", type=float, default=1.0)
    parser.add_argument("--arch", default="deep-sets", choices=["deep-sets", "attention"])
    parser.add_argument("--d-model", type=int, default=128)
    parser.add_argument("--heads", type=int, default=4)
    parser.add_argument("--layers", type=int, default=2)
    parser.add_argument("--log-every", type=int, default=200)
    args = parser.parse_args()

    torch.manual_seed(args.seed)
    random.seed(args.seed)
    torch.set_float32_matmul_precision("high")
    os.makedirs(args.out, exist_ok=True)

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    net = (
        PolicyValueNetAttention(
            d_model=args.d_model,
            heads=args.heads,
            layers=args.layers,
        )
        if args.arch == "attention"
        else PolicyValueNet()
    )
    net = net.to(device)
    print(f"architecture: {args.arch} ({sum(p.numel() for p in net.parameters())} params)")
    print(f"device: {device}")
    if args.init:
        net.load_state_dict(torch.load(args.init, map_location=device))
        print(f"fine-tuning from {args.init}")
    # Warm up CUDA before the CPU-bound data precompute so the GPU context
    # exists (and nvidia-smi shows the process) for the whole run.
    net.eval()
    with torch.no_grad():
        warm_obs = torch.zeros(1, OBS_DIM, device=device)
        warm_actions = torch.zeros(1, 1, ACTION_DIM, device=device)
        warm_mask = torch.zeros(1, 1, device=device)
        net(warm_obs, warm_actions, warm_mask)
    net.train()

    data_paths = [path.strip() for path in args.data.split(",") if path.strip()]
    print(f"precompute start: {len(data_paths)} files -> {os.path.join(args.out, 'data')}", flush=True)
    pre_started = time.time()
    dataset = precompute_memmap(data_paths, os.path.join(args.out, "data"))
    print(f"precompute done in {time.time() - pre_started:.0f}s", flush=True)
    total_positions = len(dataset["holdout"])
    holdout_flag = dataset["holdout"]
    train_indices = [
        index for index in range(total_positions) if not holdout_flag[index]
    ]
    holdout_indices = [
        index for index in range(total_positions) if holdout_flag[index]
    ]
    print(
        f"positions={total_positions} train={len(train_indices)} "
        f"holdout={len(holdout_indices)}"
    )
    optimizer = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(
        optimizer,
        T_max=args.epochs,
        eta_min=3e-5,
    )
    value_loss_fn = nn.MSELoss()

    started = time.time()
    steps_per_epoch = max(1, len(train_indices) // args.batch_size)
    total_batches = (len(train_indices) + args.batch_size - 1) // args.batch_size
    best_value_error = float("inf")
    best_epoch = 0
    for epoch in range(args.epochs):
        net.train()
        random.shuffle(train_indices)
        total_policy = 0.0
        total_value = 0.0
        for batch_index, start in enumerate(range(0, len(train_indices), args.batch_size), start=1):
            chunk = train_indices[start : start + args.batch_size]
            obs, actions, masks, targets, outcomes = make_batch_memmap(
                dataset,
                chunk,
            )
            obs = obs.to(device)
            actions = actions.to(device)
            masks = masks.to(device)
            targets = targets.to(device)
            outcomes = outcomes.to(device)
            optimizer.zero_grad()
            logits, value = net(obs, actions, masks)
            log_probs = torch.log_softmax(logits, dim=-1)
            safe_log_probs = torch.where(
                masks > 0, log_probs, torch.zeros_like(log_probs)
            )
            policy_loss = -(targets * safe_log_probs).sum(dim=-1).mean()
            value_loss = value_loss_fn(value, outcomes)
            loss = policy_loss + args.value_weight * value_loss
            loss.backward()
            optimizer.step()
            total_policy += policy_loss.item()
            total_value += value_loss.item()
            if batch_index % args.log_every == 0 or batch_index == total_batches:
                print(
                    f"epoch {epoch + 1}/{args.epochs} "
                    f"batch {batch_index}/{total_batches} "
                    f"policy={total_policy / batch_index:.4f} "
                    f"value={total_value / batch_index:.4f} "
                    f"elapsed={time.time() - started:.0f}s",
                    flush=True,
                )
        scheduler.step()
        train_metrics = evaluate(
            net,
            dataset,
            train_indices[:2000],
            args.batch_size,
            device,
        )
        holdout_metrics = evaluate(
            net,
            dataset,
            holdout_indices,
            args.batch_size,
            device,
        )
        improved = holdout_metrics["mean_value_error"] < best_value_error
        if improved:
            best_value_error = holdout_metrics["mean_value_error"]
            best_epoch = epoch
            torch.save(
                net.state_dict(),
                os.path.join(args.out, "best.pt"),
            )
        elapsed = time.time() - started
        print(
            f"epoch {epoch + 1}/{args.epochs} "
            f"policy={total_policy / steps_per_epoch:.4f} "
            f"value={total_value / steps_per_epoch:.4f} "
            f"train_acc={train_metrics['accuracy']:.3f} "
            f"holdout_acc={holdout_metrics['accuracy']:.3f} "
            f"holdout_val_err={holdout_metrics['mean_value_error']:.3f} "
            f"lr={scheduler.get_last_lr()[0]:.2e} "
            f"({elapsed:.0f}s)"
        )
        torch.save(
            net.state_dict(),
            os.path.join(args.out, f"checkpoint-epoch-{epoch + 1}.pt"),
        )
        if epoch - best_epoch >= 5:
            print(
                f"early stop at epoch {epoch + 1} "
                f"(best holdout value error {best_value_error:.3f} at epoch {best_epoch + 1})"
            )
            break

    final_metrics = evaluate(
        net,
        dataset,
        holdout_indices,
        args.batch_size,
        device,
    )
    config = {
        "architecture": "deep-sets-policy-value-v1",
        "arch": args.arch,
        "d_model": args.d_model,
        "heads": args.heads,
        "layers": args.layers,
        "obs_dim": 462,
        "action_dim": 43,
        "epochs": args.epochs,
        "batch_size": args.batch_size,
        "lr": args.lr,
        "seed": args.seed,
        "data": os.path.abspath(args.data),
        "holdout_accuracy": final_metrics["accuracy"],
        "holdout_value_error": final_metrics["mean_value_error"],
        "positions": total_positions,
    }
    with open(os.path.join(args.out, "config.json"), "w", encoding="utf-8") as handle:
        json.dump(config, handle, indent=2)
    print(
        f"final holdout accuracy={final_metrics['accuracy']:.3f} "
        f"value_error={final_metrics['mean_value_error']:.3f}"
    )


if __name__ == "__main__":
    main()
