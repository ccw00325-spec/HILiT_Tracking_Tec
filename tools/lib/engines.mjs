// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 합성 장면에 실제 추적 코드를 돌린다. 브라우저 데모와 시험 도구가 같은 경로를 쓴다.
// dcf: 픽셀만 보는 위치 추적. linked: 제품 기본 잇기 코드에 흉내 낸 검출을 넣은 것. 둘 다 가중치가 필요 없다.
import { HilitDcfTrackerCore } from '../../runtime/apps/web/public/tracking/generated/dcf-tracker.js';
import { buildTracklets, LINKED_POLICY, linkTarget, renderTrajectory } from '../../runtime/apps/web/public/tracking/linked-core.js';
import { describeFromImage } from '../../runtime/apps/web/public/tracking/linked-tracker.js';
import { scoreTrack } from './metrics.mjs';
import { detectionsAt, renderFrame, truthAt } from './scenes.mjs';

export const ENGINES = {
  linked: '검출 연결 추적 (제품 기본 잇기 코드, 검출은 흉내)',
  dcf: 'DCF 위치 추적 (픽셀만 사용)',
};

export function truthFn(scene) {
  return (t) => {
    const list = truthAt(scene, t);
    const target = list.find((p) => p.id === 'target');
    return { target: { box: target.box, visible: target.visible }, others: list.filter((p) => p !== target && p.box && p.visible >= 0.3).map((p) => p.box) };
  };
}

export function seedBox(scene) {
  return truthFn(scene)(0).target.box;
}

export function runDcf(scene, { fps = 10, params = {} } = {}) {
  const tracker = new HilitDcfTrackerCore(params);
  const box = seedBox(scene);
  tracker.init(renderFrame(scene, 0), box, 0);
  const rows = [{ t: 0, box: { ...box }, state: 'TRACKING_OK' }];
  const n = Math.floor(scene.seconds * fps);
  for (let i = 1; i <= n; i += 1) {
    const t = i / fps;
    const r = tracker.update(renderFrame(scene, t), t);
    rows.push({ t, box: r?.box ?? null, state: r?.status === 'lost' ? 'TARGET_LOST' : r?.status === 'tracked' ? 'TRACKING_OK' : 'TRACKING_WARNING' });
  }
  return { rows, decisions: [], asked: null };
}

export function runLinked(scene, { policy = {}, detect = {} } = {}) {
  const merged = { ...LINKED_POLICY, ...policy };
  const frame = { width: scene.width, height: scene.height };
  const samples = [];
  const n = Math.floor(scene.seconds * merged.sampleHz);
  for (let i = 0; i <= n; i += 1) {
    const t = i / merged.sampleHz;
    const img = renderFrame(scene, t);
    const dets = detectionsAt(scene, t, detect);
    for (const d of dets) d.desc = describeFromImage(img, d);
    samples.push({ t, dets });
  }
  const box = seedBox(scene);
  const seedDescs = [describeFromImage(renderFrame(scene, 0), box)].filter(Boolean);
  const built = buildTracklets(samples, frame, merged);
  const link = linkTarget({ samples, built, frame, seed: { t: 0, box }, rejected: [], seedDescs, stopOnAsk: false }, merged);
  if (!link.ok) return { rows: [], decisions: [], asked: null, failed: link.reason };
  const rows = renderTrajectory(samples, link, { startT: 0, endT: scene.seconds });
  return { rows, decisions: link.decisions, asked: link.ask ?? null };
}

export function runEngine(engine, scene, options = {}) {
  const started = performance.now();
  const out = engine === 'dcf' ? runDcf(scene, options) : runLinked(scene, options);
  return { ...out, score: scoreTrack(out.rows, truthFn(scene)), ms: performance.now() - started };
}
