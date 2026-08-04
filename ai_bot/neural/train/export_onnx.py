"""Export the trained policy-value net to ONNX (guide §4.5/§9)."""

from __future__ import annotations

import argparse
import json
import os
import sys

import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from model.net import PolicyValueNet, PolicyValueNetAttention  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--arch", default="deep-sets", choices=["deep-sets", "attention"])
    args = parser.parse_args()

    with open(args.config, "r", encoding="utf-8") as handle:
        config = json.load(handle)
    net = (
        PolicyValueNetAttention(
            d_model=int(config.get("d_model", 128)),
            heads=int(config.get("heads", 4)),
            layers=int(config.get("layers", 2)),
        )
        if args.arch == "attention"
        else PolicyValueNet()
    )
    net.load_state_dict(torch.load(args.checkpoint, map_location="cpu"))
    net.eval()

    observation = torch.zeros((1, config["obs_dim"]), dtype=torch.float32)
    actions = torch.zeros((1, 3, config["action_dim"]), dtype=torch.float32)
    action_mask = torch.zeros((1, 3), dtype=torch.float32)
    torch.onnx.export(
        net,
        (observation, actions, action_mask),
        args.out,
        input_names=["observation", "actions", "action_mask"],
        output_names=["logits", "value"],
        dynamic_axes={
            "observation": {0: "batch"},
            "actions": {0: "batch", 1: "actions"},
            "action_mask": {0: "batch", 1: "actions"},
            "logits": {0: "batch", 1: "actions"},
            "value": {0: "batch"},
        },
        opset_version=17,
        dynamo=False,
    )
    print(f"exported {args.out}")


if __name__ == "__main__":
    main()
