/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·f140c599 @license @preserve */
/* 위치 추적 코어 선택과 크기 잠금 묶음.
 *
 * 편집기 기본 경로(BrowserPipeline.trackLegacy)가 어느 위치 추적기를 쓰는지,
 * 그리고 그 위에 얹는 크기 잠금을 얼마나 조일지를 한 곳에서 정한다.
 * track(box, { trackerCore, sizeLock }) 로 호출마다 바꿀 수 있다.
 *
 *   motion  HilitMotionTracker — 피라미드 SAD + LK 점 추적 (2026-09 이전 기본)
 *   dcf     HilitDcfTracker    — 커널 상관필터(KCF 계열) 자체 구현
 *
 * 측정과 결정 근거: docs/tracking-research/2026-09-25-dcf-tracker-core.md
 */

export const TRACKER_CORES = Object.freeze(['motion', 'dcf']);

export const DEFAULT_TRACKER_CORE = 'dcf';

/* 크기 잠금 세 겹.
 *   refMin/refMax     기준 크기(sizeRef)가 사용자가 고른 상자에서 벗어날 수 있는 폭
 *   bandLow/bandHigh  상자가 기준 크기에서 벗어날 수 있는 폭 (limitToSizeBand)
 *   scalePerSecond    1초에 바뀔 수 있는 배율 (limitScale)
 * strict 는 2026-09-24 감사 때의 값 그대로다. */
export const SIZE_LOCK_PROFILES = Object.freeze({
  strict: Object.freeze({ refMin: 0.7, refMax: 1.5, bandLow: 0.6, bandHigh: 1.7, scalePerSecond: 1.6 }),
  relaxed: Object.freeze({ refMin: 0.25, refMax: 2.5, bandLow: 0.6, bandHigh: 1.7, scalePerSecond: 1.6 }),
  open: Object.freeze({ refMin: 0.2, refMax: 3, bandLow: 0.3, bandHigh: 3, scalePerSecond: 2.5 }),
});

/** 코어마다 기본 크기 잠금. */
export const DEFAULT_SIZE_LOCK = Object.freeze({ motion: 'strict', dcf: 'strict' });

export function resolveTrackerCore(value) {
  return TRACKER_CORES.includes(value) ? value : DEFAULT_TRACKER_CORE;
}

/** 이름이나 객체를 받아 완성된 크기 잠금을 돌려준다. 모르는 값은 코어 기본값. */
export function resolveSizeLock(value, core) {
  const fallback = SIZE_LOCK_PROFILES[DEFAULT_SIZE_LOCK[core] ?? 'strict'];
  if (typeof value === 'string' && SIZE_LOCK_PROFILES[value]) {
    return { name: value, ...SIZE_LOCK_PROFILES[value] };
  }
  if (value && typeof value === 'object') {
    const merged = { ...fallback };
    for (const key of Object.keys(fallback)) {
      const n = Number(value[key]);
      if (Number.isFinite(n) && n > 0) merged[key] = n;
    }
    return { name: 'custom', ...merged };
  }
  return { name: DEFAULT_SIZE_LOCK[core] ?? 'strict', ...fallback };
}
