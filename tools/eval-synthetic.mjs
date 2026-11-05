#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 가혹 조건 합성 시험. 가중치와 영상이 필요 없다. 실사 정확도가 아니라 코드 변경의 회귀를 잡는 용도다.
//
//   node tools/eval-synthetic.mjs                     표로 출력
//   node tools/eval-synthetic.mjs --check             eval/baseline.json 보다 나빠지면 exit 1
//   node tools/eval-synthetic.mjs --write-baseline    기준값을 다시 쓴다 (승인된 변경 뒤에만)
//   node tools/eval-synthetic.mjs --policy '{"contactIou":0.3}'     잇기 값을 바꿔 비교
//   node tools/eval-synthetic.mjs --sweep reentrySimMin=0.4,0.5,0.6 값을 돌려 가며 비교
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINES, runEngine } from './lib/engines.mjs';
import { buildScene, SCENARIOS } from './lib/scenes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'eval/baseline.json');
export const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
/** 허용 악화 폭. 합성 장면의 작은 흔들림으로 실패하지 않을 만큼만 둔다. */
export const MARGIN = { hitRate: 0.03, wrongRate: 0.03, switches: 0.34 };

const mean = (xs) => {
  const v = xs.filter((x) => x !== null && Number.isFinite(x));
  return v.length ? Number((v.reduce((s, x) => s + x, 0) / v.length).toFixed(3)) : null;
};

export function evaluateAll({ policy = {}, engines = Object.keys(ENGINES), scenarios = Object.keys(SCENARIOS), seeds = SEEDS } = {}) {
  const out = {};
  for (const engine of engines) {
    out[engine] = {};
    for (const name of scenarios) {
      const scores = seeds.map((seed) => runEngine(engine, buildScene(name, { seed }), { policy }).score);
      const m = (k) => mean(scores.map((s) => s[k]));
      out[engine][name] = {
        hitRate: m('hitRate'), wrongRate: m('wrongRate'), lostVisibleRate: m('lostVisibleRate'),
        hiddenClaimRate: m('hiddenClaimRate'), switches: m('switches'), recoverySec: m('recoverySec'), unrecovered: m('unrecovered'),
      };
    }
  }
  return out;
}

export function compareToBaseline(result, baseline, margin = MARGIN) {
  const worse = [];
  for (const [engine, rows] of Object.entries(baseline.results)) {
    for (const [name, base] of Object.entries(rows)) {
      const now = result[engine]?.[name];
      if (!now) { worse.push(`${engine}/${name}: 결과 없음`); continue; }
      if (base.hitRate !== null && now.hitRate < base.hitRate - margin.hitRate) worse.push(`${engine}/${name} 정답 ${base.hitRate}→${now.hitRate}`);
      if (base.wrongRate !== null && now.wrongRate > base.wrongRate + margin.wrongRate) worse.push(`${engine}/${name} 다른 사람 ${base.wrongRate}→${now.wrongRate}`);
      if (now.switches > base.switches + margin.switches) worse.push(`${engine}/${name} 전환 ${base.switches}→${now.switches}`);
    }
  }
  return worse;
}

const pct = (x) => (x === null ? '-' : `${(x * 100).toFixed(1)}%`);
export function table(result) {
  const lines = [
    '| 추적 | 장면 | 정답 | 다른 사람 | 보이는데 놓침 | 가려졌는데 정상 표시 | 전환 | 복구(초) |',
    '|---|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const [engine, rows] of Object.entries(result)) {
    for (const [name, r] of Object.entries(rows)) {
      lines.push(`| ${engine} | ${name} | ${pct(r.hitRate)} | ${pct(r.wrongRate)} | ${pct(r.lostVisibleRate)} | ${pct(r.hiddenClaimRate)} | ${r.switches} | ${r.recoverySec ?? '-'} |`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const policy = JSON.parse(value('--policy') ?? '{}');
  const sweep = value('--sweep');
  if (sweep) {
    const [key, list] = sweep.split('=');
    for (const raw of list.split(',')) {
      const v = Number(raw);
      console.log(`\n### ${key}=${v}\n${table(evaluateAll({ policy: { ...policy, [key]: v }, engines: ['linked'] }))}`);
    }
    process.exit(0);
  }
  const result = evaluateAll({ policy });
  const report = table(result);
  console.log(report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## 가혹 조건 합성 시험\n\n실사 정확도가 아닙니다.\n\n${report}\n`);
  if (args.includes('--write-baseline')) {
    mkdirSync(path.dirname(BASELINE), { recursive: true });
    writeFileSync(BASELINE, `${JSON.stringify({ note: 'Synthetic regression baseline. Not real-footage accuracy.', seeds: SEEDS, margin: MARGIN, results: result }, null, 2)}\n`);
    console.log(`기준값을 썼습니다: ${path.relative(ROOT, BASELINE)}`);
  }
  if (args.includes('--check')) {
    if (!existsSync(BASELINE)) { console.error('기준값이 없습니다.'); process.exit(2); }
    const worse = compareToBaseline(result, JSON.parse(readFileSync(BASELINE, 'utf8')));
    if (worse.length) { console.error(`기준보다 나빠졌습니다:\n  ${worse.join('\n  ')}`); process.exit(1); }
    console.log('기준값 이내입니다.');
  }
}
