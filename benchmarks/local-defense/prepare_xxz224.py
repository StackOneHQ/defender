"""Expand the pinned public xxz224 CSV into labeled JSONL for local evaluation."""

import csv
import hashlib
import json
import sys
from pathlib import Path

REVISION = "3b49e90e56cdab5552ccec971d487ad4f2d393ad"
SHA256 = "315a1aa0c9f32fff8b220a9ed059a3c36d6050f790dcf84d37c588439da3b403"
COLUMNS = ["target_text", "naive_attack", "escape_attack", "ignore_attack", "fake_comp_attack", "combine_attack"]

source, output = map(Path, sys.argv[1:])
assert hashlib.sha256(source.read_bytes()).hexdigest() == SHA256, "Unexpected dataset checksum"
with source.open(newline="", encoding="utf-8") as f:
    rows = list(csv.DictReader(f))
assert len(rows) == 3747
count = 0
with output.open("w", encoding="utf-8") as f:
    for column in COLUMNS:
        for index, row in enumerate(rows):
            text = row[column].strip()
            assert text, (column, index)
            # target_label/inject_label are source-task labels, not injection labels.
            label = 0 if column == "target_text" else 1
            f.write(
                json.dumps(
                    {"id": f"{column}/{index}", "group": column, "text": text, "label": label}, ensure_ascii=False
                )
                + "\n"
            )
            count += 1
assert count == 22482
print(json.dumps({"samples": count, "sha256": hashlib.sha256(output.read_bytes()).hexdigest()}))
