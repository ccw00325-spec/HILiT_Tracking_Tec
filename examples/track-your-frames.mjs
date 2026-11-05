// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 가장 짧은 사용 예: 프레임을 넘기면 대상 상자를 돌려줍니다. 가중치가 필요 없습니다.
//   node examples/track-your-frames.mjs
import { HilitDcfTrackerCore } from '../runtime/apps/web/public/tracking/generated/dcf-tracker.js';
import { buildScene, renderFrame, truthAt } from '../tools/lib/scenes.mjs';

// 이 예제는 합성 장면을 쓰지만, 프레임은 { data: RGBA 배열, width, height } 이면 무엇이든 됩니다.
const scene = buildScene('baseline');
const first = truthAt(scene, 0).find((p) => p.id === 'target').box;

const tracker = new HilitDcfTrackerCore();
tracker.init(renderFrame(scene, 0), first, 0);

for (let t = 1; t <= 8; t += 1) {
  const { box, status, confidence } = tracker.update(renderFrame(scene, t), t);
  console.log(`${t}초  x=${box.x.toFixed(0)} y=${box.y.toFixed(0)}  ${status}  관측 품질 ${confidence.toFixed(2)}`);
}
