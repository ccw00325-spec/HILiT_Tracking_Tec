#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 내 영상의 추적 결과를 정답과 비교합니다. 합성 시험과 같은 정의로 채점합니다.
//
//   node tools/eval-track.mjs --pred 결과.json --gt 정답.json [--tolerance 0.06]
//
// 결과.json: [{ "t": 0.1, "box": {"x":0,"y":0,"width":10,"height":20}, "state": "TRACKING_OK" }, ...]
// 정답.json: [{ "t": 0.1, "box": {...} 또는 null, "visible": 0~1 (없으면 box 유무로 판단), "others": [{...}] }, ...]
// 각 결과는 tolerance 초 안의 가장 가까운 정답과 비교하고, 정답이 없는 시각은 뺍니다.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreTrack } from './lib/metrics.mjs';

export function scoreFiles(pred, gt, tolerance = 0.06) {
  const sorted = [...gt].sort((a, b) => a.t - b.t);
  const nearest = (t) => {
    let best = null;
    for (const g of sorted) if (!best || Math.abs(g.t - t) < Math.abs(best.t - t)) best = g;
    return best && Math.abs(best.t - t) <= tolerance ? best : null;
  };
  const rows = pred.filter((r) => nearest(r.t));
  const score = scoreTrack(rows, (t) => {
    const g = nearest(t);
    return { target: { box: g.box ?? null, visible: g.visible ?? (g.box ? 1 : 0) }, others: g.others ?? [] };
  });
  return { ...score, matchedFrames: rows.length, unmatchedFrames: pred.length - rows.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (!value('--pred') || !value('--gt')) {
    console.error('사용법: node tools/eval-track.mjs --pred 결과.json --gt 정답.json');
    process.exit(2);
  }
  const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
  console.log(JSON.stringify(scoreFiles(read(value('--pred')), read(value('--gt')), Number(value('--tolerance') ?? 0.06)), null, 2));
}
