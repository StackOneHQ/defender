"""Evaluate the public Python package's Tier 1 + Tier 2 allow/block decision."""

import hashlib
import importlib.metadata
import json
import platform
import sys
from pathlib import Path

from stackone_defender import create_prompt_defense

source, output = map(Path, sys.argv[1:])
if importlib.metadata.version("stackone-defender") != "0.9.4":
    raise RuntimeError("This evaluation is pinned to Defender 0.9.4")
config = {
    "enable_tier1": True,
    "enable_tier2": True,
    "require_tier2": True,
    "block_high_risk": True,
    "enable_tier3": False,
    "use_sfe": False,
    "sanitize_content": True,
}
defense = create_prompt_defense(**config)
defense.warmup_tier2()
data = source.read_bytes()
rows = [json.loads(line) for line in data.decode().splitlines()]
counts = {"tp": 0, "fp": 0, "tn": 0, "fn": 0}
groups = {}
degraded = skipped = 0
skip_reasons = {}
for index, row in enumerate(rows, 1):
    if not isinstance(row["text"], str) or row["label"] not in (0, 1):
        raise ValueError(f"Invalid text or label in sample {row['id']}")
    result = defense.defend_tool_result({"body": row["text"]}, "benchmark_tool")
    expected_skip = result.tier2_skip_reason in [
        "All strings skipped by classifier: Text below minTextLength",
        "All strings skipped by classifier: No classifiable sentences",
    ]
    if result.tier2_available is False or (result.tier2_score is None and not expected_skip):
        raise RuntimeError(f"Unexpected Tier 2 failure for {row['id']}: {result.tier2_skip_reason}")
    if result.tier3 is not None:
        raise RuntimeError(f"Unexpected Tier 3 result in local-only evaluation for {row['id']}")
    degraded += bool(result.coverage_degraded)
    skipped += bool(result.tier2_skip_reason)
    if result.tier2_skip_reason:
        skip_reasons[result.tier2_skip_reason] = skip_reasons.get(result.tier2_skip_reason, 0) + 1
    key = ("fn" if result.allowed else "tp") if row["label"] else ("tn" if result.allowed else "fp")
    counts[key] += 1
    groups.setdefault(row["group"], {"tp": 0, "fp": 0, "tn": 0, "fn": 0})[key] += 1
    if index % 1000 == 0:
        print(f"Processed {index}/{len(rows)}", file=sys.stderr, flush=True)
tp, fp, tn, fn = (counts[k] for k in ["tp", "fp", "tn", "fn"])
report = {
    "package": "stackone-defender",
    "version": importlib.metadata.version("stackone-defender"),
    "runtime": platform.python_version(),
    "onnxruntime": importlib.metadata.version("onnxruntime"),
    "tokenizers": importlib.metadata.version("tokenizers"),
    "numpy": importlib.metadata.version("numpy"),
    "datasetSha256": hashlib.sha256(data).hexdigest(),
    "samples": len(rows),
    "config": config,
    "toolName": "benchmark_tool",
    "inputShape": "{ body: text }",
    "decision": "not result.allowed",
    "threshold": 0.52,
    "multihead": False,
    "coverageDegraded": degraded,
    "tier2Skipped": skipped,
    "skipReasons": skip_reasons,
    "results": dict(
        **counts,
        precision=tp / (tp + fp),
        recall=tp / (tp + fn),
        f1=2 * tp / (2 * tp + fp + fn),
        falsePositiveRate=fp / (fp + tn),
    ),
    "groups": groups,
}
output.write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report["results"]))
