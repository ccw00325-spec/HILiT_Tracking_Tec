/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·2e58d0e5 @license @preserve */
/* 저장 영상의 앞·뒤 추적 비교. 실시간 카메라 기본 경로가 아니다.

두 방향이 같은 자리에서 만나면 그 시각은 더 믿을 만하다.
어긋난 구간을 보간해서 확인된 신원으로 올리지 않는다.
효과가 숫자로 안 나오면 제품 기본 경로에 넣지 않는다.
*/

import { boxIou } from './hilit-grid-net';

export interface DirectedBox {
  t: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BidirectionalHit {
  t: number;
  iou: number;
  agree: boolean;
  extraDetect: boolean;
}

export const BIDIR_IOU = 0.5;

export function compareForwardBackward(
  forward: readonly DirectedBox[],
  backward: readonly DirectedBox[],
  iouThr = BIDIR_IOU,
): { hits: BidirectionalHit[]; agreeCount: number; extraDetectCount: number; interpolatedAsConfirmed: false } {
  const byT = new Map<string, DirectedBox>();
  for (const box of backward) byT.set(box.t.toFixed(3), box);
  const hits: BidirectionalHit[] = [];
  for (const f of forward) {
    const b = byT.get(f.t.toFixed(3));
    if (!b) continue;
    const iou = boxIou(f, b);
    const agree = iou >= iouThr;
    hits.push({
      t: f.t,
      iou,
      agree,
      extraDetect: !agree,
    });
  }
  return {
    hits,
    agreeCount: hits.filter((h) => h.agree).length,
    extraDetectCount: hits.filter((h) => h.extraDetect).length,
    interpolatedAsConfirmed: false,
  };
}
