#!/usr/bin/env node
// 폴더·파일·주소를 검사해 이 기술에서 가져온 코드인지 찾는다. 대상에 아무것도 보내지 않고 읽기만 한다.
//
//   node tools/detect-copy.mjs <폴더|파일|https://주소> [더...] [--json] [--extra-mark <문자열>]
//
// 세 가지를 본다.
//   1. 표시 문자열: 파일 머리의 지문과 소유권 상수
//   2. 코드 지문: 주석을 지우고 압축하거나 지역 변수 이름을 바꿔도 남는 코드 조각
//   3. 가중치 해시: models/manifest.json 의 SHA-256 과 같은 파일
// 결과: 찾으면 exit 1, 없으면 exit 0. 유사도는 단서이며 침해를 판정하지 않는다.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MARK } from './lib/stamp.mjs';
import { winnow } from './lib/winnow.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIR = new Set(['.git', 'node_modules', '.next']);
const TEXT = /\.(js|mjs|cjs|ts|tsx|jsx|java|kt|html|map|json)$/i;
const MAX_BYTES = 64 * 1024 * 1024;
export const MIN_SHARE = 0.2;
export const MIN_HITS = 8;

function loadIndex() {
  const index = JSON.parse(readFileSync(path.join(ROOT, 'fingerprints/index.json'), 'utf8'));
  const lookup = new Map();
  const files = index.files.map((f) => {
    const hashes = f.h.split(' ').map((v) => parseInt(v, 36));
    const item = { path: f.p, size: hashes.length };
    for (const h of hashes) {
      if (!lookup.has(h)) lookup.set(h, []);
      lookup.get(h).push(item);
    }
    return item;
  });
  return { lookup, files };
}

function loadWeights() {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'models/manifest.json'), 'utf8'));
  return new Map(manifest.models.filter((m) => m.distribution === 'private').map((m) => [m.sha256, m.id]));
}

async function* targets(input) {
  if (/^https?:\/\//.test(input)) {
    const res = await fetch(input, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${input} 응답 ${res.status}`);
    const body = await res.text();
    yield { name: input, buffer: Buffer.from(body) };
    if (/text\/html/.test(res.headers.get('content-type') ?? '')) {
      // 페이지가 불러오는 스크립트도 함께 읽는다.
      const urls = [...body.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map((m) => new URL(m[1], input).href);
      for (const url of urls) {
        const script = await fetch(url).catch(() => null);
        if (script?.ok) yield { name: url, buffer: Buffer.from(await script.text()) };
      }
    }
    return;
  }
  if (!existsSync(input)) throw new Error(`찾지 못했습니다: ${input}`);
  const stack = [input];
  while (stack.length) {
    const p = stack.pop();
    const st = statSync(p);
    if (st.isDirectory()) {
      if (SKIP_DIR.has(path.basename(p))) continue;
      for (const e of readdirSync(p)) stack.push(path.join(p, e));
    } else if (st.size <= MAX_BYTES) {
      yield { name: p, buffer: readFileSync(p) };
    }
  }
}

export async function scan(inputs, { extraMarks = [] } = {}) {
  const { lookup, files } = loadIndex();
  const weights = loadWeights();
  const marks = [MARK, ...extraMarks];
  const shared = new Map();
  const markHits = [];
  const weightHits = [];
  let scanned = 0;
  for (const input of inputs) {
    for await (const { name, buffer } of targets(input)) {
      scanned += 1;
      const sha = createHash('sha256').update(buffer).digest('hex');
      if (weights.has(sha)) weightHits.push({ file: name, model: weights.get(sha) });
      if (!TEXT.test(name) && !/^https?:/.test(name)) continue;
      const text = buffer.toString('utf8');
      for (const mark of marks) if (text.includes(mark)) markHits.push({ file: name, mark });
      for (const h of winnow(text)) {
        for (const item of lookup.get(h) ?? []) {
          if (!shared.has(item)) shared.set(item, new Set());
          shared.get(item).add(h);
        }
      }
    }
  }
  const code = [...shared]
    .map(([item, set]) => ({ source: item.path, hits: set.size, share: Number((set.size / item.size).toFixed(3)) }))
    .filter((m) => m.hits >= MIN_HITS && m.share >= MIN_SHARE)
    .sort((a, b) => b.hits - a.hits);
  return { scanned, indexedFiles: files.length, marks: markHits, weights: weightHits, code, found: markHits.length + weightHits.length + code.length > 0 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const extraMarks = [];
  const inputs = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--extra-mark') extraMarks.push(args[(i += 1)]);
    else if (args[i] !== '--json') inputs.push(args[i]);
  }
  if (!inputs.length) {
    console.error('사용법: node tools/detect-copy.mjs <폴더|파일|주소> [--json] [--extra-mark <문자열>]');
    process.exit(2);
  }
  const result = await scan(inputs, { extraMarks });
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`검사 파일 ${result.scanned}개 / 표시 ${result.marks.length}건 / 가중치 ${result.weights.length}건 / 코드 조각 ${result.code.length}개 파일`);
    for (const m of result.marks.slice(0, 20)) console.log(`  표시 ${m.file}`);
    for (const m of result.weights) console.log(`  가중치 ${m.model} ${m.file}`);
    for (const m of result.code.slice(0, 20)) console.log(`  코드 ${(m.share * 100).toFixed(0)}% (${m.hits}조각) ${m.source}`);
  }
  process.exit(result.found ? 1 : 0);
}
