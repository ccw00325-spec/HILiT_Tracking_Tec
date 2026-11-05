/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·e12e271e @license @preserve */
/**
 * 사람 상자를 "추적기가 붙잡을 수 있게, 사용자는 자기라고 알아볼 수 있게" 맞춘다.
 *
 * 편집 2단계(나 지정)에서 쓰는 순수 계산만 여기 둔다. 검출기(MediaPipe)를
 * 부르는 쪽은 `mediapipe-person-detector.ts` 다. 여기에는 브라우저 API 가 없어
 * 시험으로 못 박을 수 있다.
 *
 * ## 왜 상자를 다시 맞추나
 *
 * 위치 추적기(HilitMotionTracker)는 상자 가장자리 16%를 버리고 안쪽에서
 * 특징점을 고른다. 12개 이상 살아남아야 품질 만점이고 6개 밑이면 놓친 것으로
 * 본다. 상자가 옆으로 헐거우면 그 안쪽에 배경 점이 섞이고, 카메라가 움직일 때
 * 배경을 따라간다.
 *
 * 2026-09-24 실사 184장(정답 166상자, model-reviewed)에서 MediaPipe
 * EfficientDet-Lite0 상자를 정답과 대 보니 높이는 거의 맞았다(중앙값 0.98).
 * 폭은 흔들렸다 — 4개 중 1개가 16% 넘게 넓었다. 그래서 **폭만** 줄인다.
 * 머리와 발은 사용자가 "나" 를 알아보는 단서라 자르지 않는다.
 *
 * 자세한 측정: docs/tracking-research/2026-09-24-mediapipe-person-proposals.md
 */

export interface PxBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScoredPxBox extends PxBox {
  score: number;
}

/* ------------------------------------------------------------------ 문턱
 * 아래 값은 고른 것이 아니라 잰 것이다(실사 184장, IoU 0.5, Lite0 int8).
 *
 *   문턱  정밀도  재현율   F1    상자/프레임
 *   0.2   59.9%   81.9%  0.692   1.24
 *   0.3   74.4%   71.7%  0.730   0.87   ← F1 최대
 *   0.4   87.4%   58.4%  0.700   0.60
 *   0.5   93.8%   45.2%  0.610   0.43
 *
 * 사용자에게 보여 줄 후보라 F1 최대를 쓴다. 놓친 사람은 눌러서 다시 찾는다.
 */
export const PERSON_SCORE_MIN = 0.3;
/** 누른 자리를 확대해 다시 볼 때. 사용자가 이미 "여기 사람" 이라고 짚었으므로 낮춘다. */
export const TAP_SCORE_MIN = 0.1;
/** 누른 자리 둘레를 화면 짧은 변의 이 비율만큼 잘라 확대한다. 작은 사람·큰 사람 둘 다 잡으려고 두 번 본다. */
export const TAP_CROP_FRACTIONS = [0.45, 0.75] as const;
/** 잘라 낸 조각을 이 크기로 늘려 검출기에 넣는다. */
export const TAP_CROP_INPUT = 640;
/** 한 화면에 띄우는 상자 수. 더 많으면 고르기보다 헤매게 된다. */
export const MAX_PERSON_PROPOSALS = 8;
/** 화면 높이 대비 이보다 작은 사람은 상자를 띄우지 않는다 — 추적기가 점을 못 고른다. */
export const MIN_PERSON_HEIGHT_FRAC = 0.06;

/* ------------------------------------------------------------ 폭 맞추기 */

/** 한쪽에서 최대 이만큼(폭 대비)까지만 줄인다. 잘못 줄여도 몸통은 남는다. */
export const MAX_SIDE_TRIM = 0.12;
/** 이 비율보다 사람 색이 적은 세로줄은 배경으로 본다. */
export const COLUMN_FG_MIN = 0.3;

function bin(r: number, g: number, b: number): number {
  return ((r >> 6) << 4) | ((g >> 6) << 2) | (b >> 6);
}

export interface TrimResult {
  box: PxBox;
  trimmedLeft: number;
  trimmedRight: number;
  /** 배경 표본이 모자라 줄이지 않았을 때 그 이유. */
  skipped: null | 'no-background' | 'too-small';
}

/**
 * 상자 좌우의 배경 띠와 상자 가운데 몸통 띠의 색을 비교해, 가장자리 세로줄
 * 가운데 배경 색이 대부분인 줄을 걷어 낸다. 위아래는 건드리지 않는다.
 */
export function trimBoxWidth(
  rgba: Uint8ClampedArray | Uint8Array,
  frameW: number,
  frameH: number,
  box: PxBox,
): TrimResult {
  const x0 = Math.max(0, Math.round(box.x));
  const x1 = Math.min(frameW, Math.round(box.x + box.width));
  const y0 = Math.max(0, Math.round(box.y + box.height * 0.15));
  const y1 = Math.min(frameH, Math.round(box.y + box.height * 0.85));
  const w = x1 - x0;
  const unchanged = (skipped: TrimResult['skipped']): TrimResult => ({
    box: { ...box }, trimmedLeft: 0, trimmedRight: 0, skipped,
  });
  if (w < 12 || y1 - y0 < 12) return unchanged('too-small');

  const rowStep = Math.max(1, Math.floor((y1 - y0) / 48));
  const fg = new Float64Array(64);
  const bg = new Float64Array(64);
  let fgN = 0;
  let bgN = 0;

  const cx = (x0 + x1) / 2;
  const fx0 = Math.round(cx - w * 0.15);
  const fx1 = Math.round(cx + w * 0.15);
  const ring = Math.max(4, Math.round(w * 0.2));
  for (let y = y0; y < y1; y += rowStep) {
    const row = y * frameW;
    for (let x = fx0; x < fx1; x += 1) {
      const p = (row + x) * 4;
      fg[bin(rgba[p], rgba[p + 1], rgba[p + 2])] += 1; fgN += 1;
    }
    for (let x = Math.max(0, x0 - ring); x < x0; x += 1) {
      const p = (row + x) * 4;
      bg[bin(rgba[p], rgba[p + 1], rgba[p + 2])] += 1; bgN += 1;
    }
    for (let x = x1; x < Math.min(frameW, x1 + ring); x += 1) {
      const p = (row + x) * 4;
      bg[bin(rgba[p], rgba[p + 1], rgba[p + 2])] += 1; bgN += 1;
    }
  }
  /* 상자가 화면 양옆을 꽉 채우면 배경을 볼 곳이 없다. 모르면 줄이지 않는다. */
  if (bgN < 30 || fgN < 30) return unchanged('no-background');

  const isFg = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) {
    const pf = (fg[i] + 0.5) / (fgN + 32);
    const pb = (bg[i] + 0.5) / (bgN + 32);
    isFg[i] = pf > pb ? 1 : 0;
  }

  const columnFg = (x: number): number => {
    let hit = 0;
    let n = 0;
    for (let y = y0; y < y1; y += rowStep) {
      const p = (y * frameW + x) * 4;
      hit += isFg[bin(rgba[p], rgba[p + 1], rgba[p + 2])];
      n += 1;
    }
    return n ? hit / n : 1;
  };

  const maxTrim = Math.floor(w * MAX_SIDE_TRIM);
  let left = 0;
  while (left < maxTrim && columnFg(x0 + left) < COLUMN_FG_MIN) left += 1;
  let right = 0;
  while (right < maxTrim && columnFg(x1 - 1 - right) < COLUMN_FG_MIN) right += 1;

  return {
    box: { x: x0 + left, y: box.y, width: w - left - right, height: box.height },
    trimmedLeft: left,
    trimmedRight: right,
    skipped: null,
  };
}

/* ------------------------------------------------------- 누른 자리 확대 */

export interface TapCrop {
  sx: number;
  sy: number;
  side: number;
}

/** 누른 점을 가운데에 두는 정사각 조각. 화면 밖으로 나가면 안으로 민다. */
export function tapCrop(frameW: number, frameH: number, tap: { x: number; y: number }, fraction: number): TapCrop {
  const side = Math.max(16, Math.round(Math.min(frameW, frameH) * fraction));
  return {
    side,
    sx: Math.max(0, Math.min(frameW - side, Math.round(tap.x - side / 2))),
    sy: Math.max(0, Math.min(frameH - side, Math.round(tap.y - side / 2))),
  };
}

/** 조각 안의 검출 상자를 원래 화면 좌표로 되돌린다. */
export function fromCrop(box: ScoredPxBox, crop: TapCrop, inputSize = TAP_CROP_INPUT): ScoredPxBox {
  const k = crop.side / inputSize;
  return {
    x: crop.sx + box.x * k,
    y: crop.sy + box.y * k,
    width: box.width * k,
    height: box.height * k,
    score: box.score,
  };
}

function contains(box: PxBox, p: { x: number; y: number }): boolean {
  return p.x >= box.x && p.x <= box.x + box.width && p.y >= box.y && p.y <= box.y + box.height;
}

/** 누른 점을 품은 상자 가운데 점수가 가장 높은 것. 없으면 null. */
export function pickTapHit(hits: readonly ScoredPxBox[], tap: { x: number; y: number }): ScoredPxBox | null {
  let best: ScoredPxBox | null = null;
  for (const h of hits) {
    if (h.score < TAP_SCORE_MIN || !contains(h, tap)) continue;
    if (!best || h.score > best.score) best = h;
  }
  return best;
}

/**
 * 검출기가 아무것도 못 줬을 때 누른 자리에 놓는 기본 상자.
 * 사람이 대개 서 있으므로 세로로 긴 비율로, 누른 곳이 가슴께가 되게 둔다.
 * 사용자가 손잡이로 고쳐 쓰는 출발점이다.
 */
export function tapFallbackBox(frameW: number, frameH: number, tap: { x: number; y: number }): PxBox {
  const height = frameH * 0.5;
  const width = height * 0.38;
  const x = Math.max(0, Math.min(frameW - width, tap.x - width / 2));
  const y = Math.max(0, Math.min(frameH - height, tap.y - height * 0.35));
  return { x, y, width, height };
}

/* ------------------------------------------------------ 후보 고르기 */

function iou(a: PxBox, b: PxBox): number {
  const ix0 = Math.max(a.x, b.x);
  const iy0 = Math.max(a.y, b.y);
  const ix1 = Math.min(a.x + a.width, b.x + b.width);
  const iy1 = Math.min(a.y + a.height, b.y + b.height);
  if (ix1 <= ix0 || iy1 <= iy0) return 0;
  const inter = (ix1 - ix0) * (iy1 - iy0);
  return inter / (a.width * a.height + b.width * b.height - inter);
}

/**
 * 같은 사람에게 겹친 상자를 걷어 낸 뒤 8개를 고른다.
 * 기본값은 꺼져 있다. 문턱은 그대로다 — 점수를 낮춰 재현율만 올리지 않는다.
 * 겹침이 큰 두 사람은 낮은 점수 쪽이 빠질 수 있다. 봉인 실사로 재기 전에는 켜지 않는다.
 */
export const DISTINCT_PERSON_PROPOSALS = false;
/** 이보다 많이 겹치면 같은 상자로 보고 점수 높은 쪽만 남긴다. */
export const PROPOSAL_OVERLAP_MAX = 0.5;

function eligibleProposals(hits: readonly ScoredPxBox[], frameH: number): ScoredPxBox[] {
  return hits
    .filter((h) => h.score >= PERSON_SCORE_MIN && h.height >= frameH * MIN_PERSON_HEIGHT_FRAC)
    .sort((a, b) => b.score - a.score);
}

/** 점수 높은 상자부터 남기고, 그와 많이 겹치는 낮은 상자는 뺀다. */
export function suppressOverlappingProposals(
  hits: readonly ScoredPxBox[],
  overlapMax = PROPOSAL_OVERLAP_MAX,
): ScoredPxBox[] {
  const kept: ScoredPxBox[] = [];
  for (const hit of [...hits].sort((a, b) => b.score - a.score)) {
    if (kept.some((row) => iou(row, hit) >= overlapMax)) continue;
    kept.push(hit);
  }
  return kept;
}

/** 화면에 띄울 사람 상자. 너무 작은 것을 빼고, 점수 순으로 상한까지. */
export function selectProposals(hits: readonly ScoredPxBox[], frameH: number): ScoredPxBox[] {
  return eligibleProposals(hits, frameH).slice(0, MAX_PERSON_PROPOSALS);
}

/*
 * 타임라인 바에서 사람을 고를 때의 후보(2026-11-03 사용자 지적: 「사람에 맞춰서 박스가 안 뜬다」).
 * 또렷한 사람도 프레임에 따라 점수가 0.17~0.26 으로 떨어져 0.3 문턱에서 상자가 하나도 안 떴다(18초 영상 15장 중 5장).
 * 전역 문턱은 그대로 두고, 이 화면에서만 사람 모양인 낮은 점수 상자를 함께 보인다. 사용자가 눌러 고르는 후보라
 * 잘못 뜬 상자의 비용이 놓친 비용보다 작다. 추적 쪽 검출도 같은 0.15 를 쓴다(detectPeopleForCheck).
 */
export const PICKER_SCORE_MIN = 0.15;
/** 낮은 점수 상자는 이만큼은 커야 한다. 멀리 있는 표지판 같은 작은 상자를 거른다. */
export const PICKER_MIN_HEIGHT_FRAC = 0.12;
/** 세로/가로 비. 사람은 서 있거나 화면 끝에 잘려도 세로로 길다. 화면을 덮는 상자도 사람이 아니다. */
export const PICKER_MIN_TALL = 1.2;
export const PICKER_MAX_HEIGHT_FRAC = 0.98;

export function selectPickerProposals(hits: readonly ScoredPxBox[], frameH: number): ScoredPxBox[] {
  const strict = eligibleProposals(hits, frameH);
  const extra = hits
    .filter((h) => h.score >= PICKER_SCORE_MIN && h.score < PERSON_SCORE_MIN
      && h.height >= frameH * PICKER_MIN_HEIGHT_FRAC && h.height <= frameH * PICKER_MAX_HEIGHT_FRAC
      && h.height / Math.max(1, h.width) >= PICKER_MIN_TALL)
    .sort((a, b) => b.score - a.score);
  return suppressOverlappingProposals([...strict, ...extra]).slice(0, MAX_PERSON_PROPOSALS);
}

/** 실험: 겹친 상자를 먼저 걷어 내 8칸을 서로 다른 사람에게 쓴다. */
export function selectDistinctProposals(hits: readonly ScoredPxBox[], frameH: number): ScoredPxBox[] {
  return suppressOverlappingProposals(eligibleProposals(hits, frameH)).slice(0, MAX_PERSON_PROPOSALS);
}

/** 누른 자리에서 새로 찾은 상자가 이미 띄운 상자와 같은 사람인지. */
export function sameProposal(a: PxBox, b: PxBox): boolean {
  return iou(a, b) >= 0.5;
}

/* ------------------------------------------------ 적합성 시험은 뺐다
 *
 * 처음에는 후보 상자 셋(폭 맞춤·원래·더 좁힘)으로 0.5초를 따라가 보고
 * 추적기 품질이 가장 높은 것을 고르려 했다. 실사 94쌍에서 재 보니
 * 오히려 나빴다(1초 뒤 같은 사람 위: 폭 맞춤 90.4% · 스스로 고름 86.2%).
 * 그 품질 점수가 낮았던 쌍이 도리어 100% 붙어 있어 "따라가기 어려운
 * 장면" 경고로도 못 쓴다. 그래서 늘 폭 맞춤 상자를 쓴다.
 * 비교는 scripts/tracking-data/eval-person-box-fit.mjs 가 다시 잰다.
 */

/**
 * 사용자가 알아보도록 보여 줄 확대 사진의 영역. 상자보다 넉넉히 잡는다 —
 * 추적용 상자는 좁게, 알아보는 사진은 넓게. 두 목표를 나눠 맡긴다.
 */
export function recognitionCrop(box: PxBox, frameW: number, frameH: number): PxBox {
  const padX = box.width * 0.35;
  const padY = box.height * 0.12;
  const x = Math.max(0, box.x - padX);
  const y = Math.max(0, box.y - padY);
  return {
    x,
    y,
    width: Math.min(frameW, box.x + box.width + padX) - x,
    height: Math.min(frameH, box.y + box.height + padY) - y,
  };
}
