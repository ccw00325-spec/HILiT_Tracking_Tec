#!/usr/bin/env node
// 위치 추적 코어(DCF)를 합성 프레임으로 돌려 프레임당 시간을 잽니다. 기기별 비교와 회귀 확인용이며 실사 정확도가 아닙니다.
//
//   node tools/bench-tracker.mjs [--frames 300] [--width 1280] [--height 720] [--json]
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HilitDcfTrackerCore } from '../runtime/apps/web/public/tracking/generated/dcf-tracker.js';

export const FLOOR_FPS = 12;

function makeFrame(width, height, cx, cy, boxW, boxH) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = (y * width + x) * 4;
      const inside = Math.abs(x - cx) < boxW / 2 && Math.abs(y - cy) < boxH / 2;
      const stripe = ((x >> 3) + (y >> 3)) % 2 === 0;
      const noise = ((x * 7 + y * 13) % 11) * 2;
      data[p] = inside ? (stripe ? 220 : 60) : 40 + noise;
      data[p + 1] = inside ? (stripe ? 60 : 200) : 90 + noise;
      data[p + 2] = inside ? 40 : 60 + noise;
      data[p + 3] = 255;
    }
  }
  return { data, width, height, ox: 0, oy: 0, frameWidth: width, frameHeight: height };
}

export function runBench({ frames = 120, width = 640, height = 360 } = {}) {
  const boxW = Math.round(width * 0.09);
  const boxH = Math.round(height * 0.34);
  const pos = (i) => ({ cx: width * 0.3 + i * (width * 0.4 / frames), cy: height * 0.5 + Math.sin(i / 15) * height * 0.06 });
  const tracker = new HilitDcfTrackerCore();
  const first = pos(0);
  tracker.init(makeFrame(width, height, first.cx, first.cy, boxW, boxH), { x: first.cx - boxW / 2, y: first.cy - boxH / 2, width: boxW, height: boxH }, 0);
  const times = [];
  let errorSum = 0;
  let tracked = 0;
  for (let i = 1; i < frames; i += 1) {
    const p = pos(i);
    const frame = makeFrame(width, height, p.cx, p.cy, boxW, boxH);
    const t0 = performance.now();
    const result = tracker.update(frame, i / 30);
    times.push(performance.now() - t0);
    const box = result?.box ?? result;
    if (box && Number.isFinite(box.x)) {
      errorSum += Math.hypot(box.x + box.width / 2 - p.cx, box.y + box.height / 2 - p.cy);
      tracked += 1;
    }
  }
  times.sort((a, b) => a - b);
  const at = (q) => times[Math.min(times.length - 1, Math.floor(times.length * q))];
  return {
    frames: times.length,
    width,
    height,
    p50Ms: Number(at(0.5).toFixed(2)),
    p95Ms: Number(at(0.95).toFixed(2)),
    budgetMs: Number((1000 / FLOOR_FPS).toFixed(1)),
    meanCenterErrorPx: tracked ? Number((errorSum / tracked).toFixed(2)) : null,
    trackedFrames: tracked,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : fallback; };
  const r = runBench({ frames: value('--frames', 300), width: value('--width', 1280), height: value('--height', 720) });
  if (args.includes('--json')) console.log(JSON.stringify(r));
  else console.log(`DCF ${r.width}x${r.height} ${r.frames}프레임: 중앙값 ${r.p50Ms}ms, 95% ${r.p95Ms}ms (예산 ${r.budgetMs}ms), 중심 오차 평균 ${r.meanCenterErrorPx}px`);
  process.exit(r.p95Ms > r.budgetMs ? 1 : 0);
}
