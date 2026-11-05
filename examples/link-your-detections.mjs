// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 제품 기본 잇기(linked-v1)를 직접 고른 검출기와 함께 쓰는 예입니다. 검출기 결과만 있으면 자체 가중치가 필요 없습니다.
//   node examples/link-your-detections.mjs
import { buildTracklets, LINKED_POLICY, linkTarget, renderTrajectory } from '../runtime/apps/web/public/tracking/linked-core.js';
import { describeFromImage } from '../runtime/apps/web/public/tracking/linked-tracker.js';
import { buildScene, detectionsAt, renderFrame, truthAt } from '../tools/lib/scenes.mjs';

// 여기서는 detectionsAt 이 검출기를 흉내 냅니다. 실제로는 EfficientDet-Lite0 같은 사람 검출기의 결과를 넣습니다.
const scene = buildScene('crowd_occlusion');
const frame = { width: scene.width, height: scene.height };

// 1. 초당 5장을 검출하고 사람마다 겉모습 값을 붙입니다.
const samples = [];
for (let i = 0; i <= scene.seconds * LINKED_POLICY.sampleHz; i += 1) {
  const t = i / LINKED_POLICY.sampleHz;
  const image = renderFrame(scene, t);
  const dets = detectionsAt(scene, t);
  for (const d of dets) d.desc = describeFromImage(image, d);
  samples.push({ t, dets });
}

// 2. 사용자가 고른 상자에서 출발해 대상의 줄을 잇습니다.
const box = truthAt(scene, 0).find((p) => p.id === 'target').box;
const built = buildTracklets(samples, frame);
const link = linkTarget({ samples, built, frame, seed: { t: 0, box }, rejected: [], seedDescs: [describeFromImage(renderFrame(scene, 0), box)] });
if (!link.ok) throw new Error(`시작하지 못했습니다: ${link.reason}`);

// 3. 시간순 궤적으로 받습니다.
for (const row of renderTrajectory(samples, link, { startT: 0, endT: scene.seconds }).filter((_, i) => i % 10 === 0)) {
  console.log(`${row.t.toFixed(1)}초  x=${row.box.x.toFixed(0)}  ${row.state}`);
}
