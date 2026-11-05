/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·873607d9 @license @preserve */
/* 검출기 비교 숫자. 결과를 보기 전에 채택 규칙을 고정한다.

정답이 없으면 0이나 100을 넣지 않는다.
내부 재획득 횟수·검출 점수를 정확도로 쓰지 않는다.
*/

import { boxIou } from './hilit-grid-net';

/** tracking-core MATCH_IOU 와 같다. 평가 뒤에 맞추지 않는다. */
export const STAGE2_IOU = 0.5;

export const STAGE2_ADOPT_RULES = Object.freeze({
  recordedBeforeResults: true,
  iou: STAGE2_IOU,
  minInspectedFramesPerClip: 8,
  minActionSpans: 1,
  holdoutThresholdLocked: true,
  commercialMustBeApproved: true,
  nanoFamilyForbidden: true,
  desktopP95MsMax: 50,
  s24Required: false,
  autoReacquireMustStayGated: true,
  note: '실사 사람 정답이 8프레임 미만이면 제품 기본 검출기로 승격하지 않는다.',
});

export interface PrResult {
  precision: number | null;
  recall: number | null;
  tp: number;
  fp: number;
  fn: number;
  gtCount: number;
  predCount: number;
  iou: number;
  kind: 'synthetic' | 'seed-diagnostic' | 'unmeasured' | 'real-holdout';
}

export function greedyPr(
  preds: Array<{ x: number; y: number; width: number; height: number }>,
  gts: Array<{ x: number; y: number; width: number; height: number }>,
  iou = STAGE2_IOU,
  kind: PrResult['kind'] = 'synthetic',
): PrResult {
  if (!gts.length) {
    return {
      precision: null,
      recall: null,
      tp: 0,
      fp: preds.length,
      fn: 0,
      gtCount: 0,
      predCount: preds.length,
      iou,
      kind: 'unmeasured',
    };
  }
  const used = new Set<number>();
  let tp = 0;
  for (const pred of preds) {
    let best = -1;
    let bestIou = 0;
    gts.forEach((gt, i) => {
      if (used.has(i)) return;
      const v = boxIou(pred, gt);
      if (v > bestIou) { bestIou = v; best = i; }
    });
    if (best >= 0 && bestIou >= iou) {
      used.add(best);
      tp += 1;
    }
  }
  const fp = Math.max(0, preds.length - tp);
  const fn = Math.max(0, gts.length - tp);
  return {
    precision: preds.length ? tp / preds.length : null,
    recall: tp / gts.length,
    tp,
    fp,
    fn,
    gtCount: gts.length,
    predCount: preds.length,
    iou,
    kind,
  };
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function decideProductAdoption(input: {
  inspectedFramesPerClip: number;
  actionSpans: number;
  holdoutThresholdLocked: boolean;
  commercialApproved: boolean;
  nanoFamilyUsed: boolean;
  realPr: PrResult | null;
}): { adopt: false; reasons: string[] } {
  const reasons: string[] = [];
  if (input.inspectedFramesPerClip < STAGE2_ADOPT_RULES.minInspectedFramesPerClip) {
    reasons.push('클립당 검수 박스 프레임이 8장 미만');
  }
  if (input.actionSpans < STAGE2_ADOPT_RULES.minActionSpans) {
    reasons.push('동작 구간 사람 정답 없음');
  }
  if (!input.holdoutThresholdLocked) reasons.push('홀드아웃 임계값 미고정');
  if (!input.commercialApproved) reasons.push('상업 권리 미승인');
  if (input.nanoFamilyUsed) reasons.push('NanoTrack/NanoDet 계열 금지');
  if (!input.realPr || input.realPr.kind !== 'real-holdout' || input.realPr.gtCount < 8) {
    reasons.push('실사 전수 정답 P/R 미측정');
  }
  return { adopt: false, reasons };
}
