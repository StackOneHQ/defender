import { OnnxClassifier as NewClassifier } from './src/classifiers/onnx-classifier.ts';
import { OnnxClassifier as OldClassifier } from './onnx-classifier-old.ts';

const modelPath = '/Users/hiskud/Workspace/defender/src/classifiers/models/minilm-multihead-v5';

const newC = new NewClassifier(modelPath);
await newC.loadModel();
await newC.warmup();

const oldC = new OldClassifier(modelPath);
await oldC.loadModel();
await oldC.warmup();

function mkText(nTokensApprox) {
  const word = 'report ';
  return word.repeat(Math.max(1, Math.round(nTokensApprox / 1.3)));
}

function pathological(n) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(i % 10 === 0 ? mkText(200) : mkText(15));
  return arr;
}

function spread(n) {
  const targets = [20, 60, 120, 240];
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(mkText(targets[i % targets.length]));
  return arr;
}

async function timeIt(label, classifier, texts, reps) {
  await classifier.classifyBatch(texts);
  const t0 = performance.now();
  for (let r = 0; r < reps; r++) await classifier.classifyBatch(texts);
  const t1 = performance.now();
  console.log(`${label}: n=${texts.length} avg=${((t1 - t0) / reps).toFixed(2)}ms`);
}

console.log('--- spread(40): 10 strings each in the 32/64/128/256 buckets ---');
await timeIt('OLD (pre-bucket)', oldC, spread(40), 20);
await timeIt('NEW (bucketed)  ', newC, spread(40), 20);

console.log('--- spread(16): 4 strings each in 4 buckets ---');
await timeIt('OLD (pre-bucket)', oldC, spread(16), 30);
await timeIt('NEW (bucketed)  ', newC, spread(16), 30);

console.log('--- pathological(40): PR benchmark shape ---');
await timeIt('OLD (pre-bucket)', oldC, pathological(40), 20);
await timeIt('NEW (bucketed)  ', newC, pathological(40), 20);
