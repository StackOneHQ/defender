# Local Tier 1 + Tier 2 evaluation

Measured on 2026-11-05 against the public [xxz224 prompt-injection dataset](https://huggingface.co/datasets/xxz224/prompt-injection-attack-dataset/tree/3b49e90e56cdab5552ccec971d487ad4f2d393ad). These results use the open source packages' final `allowed` decision with both local layers enabled. No external LLM or StackOne hosted service was called.

## Results

| Package | Samples | F1 | Precision | Recall | False-positive rate |
| --- | --- | --- | --- | --- | --- |
| @stackone/defender 0.9.4 | 22,482 | 0.817 | 98.92% | 69.63% | 3.82% |
| stackone-defender 0.9.4 | 22,482 | 0.822 | 98.85% | 70.42% | 4.11% |

F1 is the harmonic mean of precision and recall. Precision is the share of blocked samples labeled as attacks; recall is the share of attack samples blocked. The false-positive rate is the share of benign samples blocked.

The TypeScript and Python packages were measured separately. Their runtime versions and results differ; these are not a claim of numerical parity. The Python source used in the run matches the current repository's package source byte for byte.

| Package | True positives | False positives | True negatives | False negatives |
| --- | --- | --- | --- | --- |
| @stackone/defender | 13,046 | 143 | 3,604 | 5,689 |
| stackone-defender | 13,194 | 154 | 3,593 | 5,541 |

## Method

- Dataset revision: `3b49e90e56cdab5552ccec971d487ad4f2d393ad`. The download's SHA-256 is checked before processing.
- Each source row contributes one benign `target_text` and five attack variants: `naive_attack`, `escape_attack`, `ignore_attack`, `fake_comp_attack`, `combine_attack`. This gives 3,747 benign samples and 18,735 attacks. The source's `target_label` and `inject_label` are original task labels, not injection labels.
- Text is stripped of surrounding whitespace, preserved otherwise, and submitted as `{ body: text }` with tool name `benchmark_tool`. The sample is predicted to be an attack exactly when `allowed` is false. A pattern hit alone is not treated as a block.
- Both local detection layers are enabled, blocking is enabled, and model loading is required. The bundled model uses its default threshold of 0.52 and temperature of 2.41. Multi-head policy and SFE are off; sentence cleaning stays on. Tier 3 is explicitly disabled.
- Both packages use identical model bytes: SHA-256 `3d4a1ba798c395c140202992c50e6c8de02fb1b9bd5aba6540848705b9c1e92c`.
- All samples stay in the denominator. In each run, 42 short samples were below the classifier's default minimum length and were decided by the remaining local policy. No model-load or inference failures occurred, and no result reported degraded coverage.
- TypeScript: Defender 0.9.4, Node 22.22.0, ONNX Runtime 1.21.0, Transformers.js 3.8.1. Python: Defender 0.9.4, Python 3.11.13, ONNX Runtime 1.24.2, tokenizers 0.22.2, NumPy 2.4.2. Both ran locally on macOS arm64 CPU. Latency was not benchmarked.

Full counts, per-attack-family counts, configuration and runtime versions are in [results-2026-11-05.json](./results-2026-11-05.json).

## Limits

This evaluates classification of labeled text wrapped as tool output. It does not measure downstream agent attack success, the hosted service, or a production traffic false-positive rate. It covers one dataset and one fixed operating point, without tuning on this run. Source rows and attack variants are related, and repeated texts are retained. No deduplication or independent training-overlap audit was performed, so this is not presented as an independently held-out test. Performance on other tool schemas, languages or attack types may differ.

## Reproduce

Run from the repository root. Download the public dataset directly; no Hugging Face token is needed. Benchmark text is untrusted input and is passed only to the local scanner.

```bash
curl -fL 'https://huggingface.co/datasets/xxz224/prompt-injection-attack-dataset/resolve/3b49e90e56cdab5552ccec971d487ad4f2d393ad/complete_dataset.csv' -o /tmp/defender-xxz224.csv
python3 benchmarks/local-defense/prepare_xxz224.py /tmp/defender-xxz224.csv /tmp/defender-xxz224.jsonl
```

The prepared JSONL SHA-256 is `8ad059d13d7715d4b37602b625dddfac8f222f68e6700dde777894737219f80b`.

### TypeScript

Use Node 22.22.0 to match the recorded environment. Install the published package beside the runner:

```bash
mkdir -p /tmp/defender-local-eval-node
npm install --prefix /tmp/defender-local-eval-node --no-audit --no-fund @stackone/defender@0.9.4 onnxruntime-node@1.21.0 @huggingface/transformers@3.8.1
cp benchmarks/local-defense/evaluate-local.mjs /tmp/defender-local-eval-node/
node /tmp/defender-local-eval-node/evaluate-local.mjs /tmp/defender-xxz224.jsonl /tmp/defender-typescript-results.json
```

### Python

Use Python 3.11.13 to match the recorded environment:

```bash
python3.11 -m venv /tmp/defender-local-eval-python
/tmp/defender-local-eval-python/bin/python -m pip install 'stackone-defender[onnx]==0.9.4' onnxruntime==1.24.2 tokenizers==0.22.2 numpy==2.4.2
/tmp/defender-local-eval-python/bin/python benchmarks/local-defense/evaluate_local.py /tmp/defender-xxz224.jsonl /tmp/defender-python-results.json
```

The scripts keep expected short-text skips in the evaluation and stop on unexpected classifier failures. Tiny score differences across runtime builds or hardware can change decisions close to the threshold.
