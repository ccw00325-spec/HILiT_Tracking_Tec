/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·bf70108f @license @preserve */
/* 비싼 GMC 재검증을 **언제** 부를지 정한다.

무엇으로 검증할지와 언제 검증할지를 분리한다. 언제 부를지는 지금 쓰는 근거만으로
정할 수 있고, 무엇으로 검증할지는 나중에 바뀔 수 있다.

지금 이 판정이 부르는 것은 **키프레임 재추정**이다([[gmc-verification]] 의
GmcVerifier). SIFT+BF 나 LightGlue 같은 무거운 매처는 제품에 없다. 그것들을
넣으려면 OpenCV·추론 런타임·모델 파일이 APK 와 웹 번들에 더해지고, 라이선스
검토가 끝나야 한다(docs/licenses/LICENSE_MANIFEST.json).

그래서 backend 는 설정으로 두되 기본값은 `keyframe` 이다. LightGlue 는
`enableLightGlueGmc = false` 로 꺼져 있고, 켜더라도 `shadowMode = true` 인 동안은
결과를 기록만 하고 추적 결정에 넣지 않는다.

이 판정은 카메라 움직임에 대한 것이다. 동일인 판정이 아니다.
*/

import type { GmcDiagnostics } from './affine-gmc';
import { GMC_VERIFY_POLICY, type GmcRejectReason, type ThermalLevel } from './gmc-verification';

/** 무엇으로 재검증할 것인가. 제품에 실제로 있는 것은 `keyframe` 뿐이다. */
export type HighCostVerifyBackend =
  /** 키프레임에서 현재 프레임으로 다시 추정한다. 지금 제품에 있는 유일한 수단. */
  | 'keyframe'
  /** SIFT + BFMatcher 재매칭. 제품에 OpenCV 가 없어 아직 쓸 수 없다. */
  | 'sift-bf'
  /** SIFT + LightGlue. 실험 전용. 라이선스 NEEDS_REVIEW 2건이 열려 있다. */
  | 'sift-lightglue';

export type HighCostTriggerMode =
  /** 위험 신호가 있을 때만. */
  | 'risk-only'
  /** 위험 신호 + 주기적 독립 검증. */
  | 'risk-and-periodic'
  /** 끈다. */
  | 'off';

export interface HighCostVerifyConfig {
  /* --- 실행 여부 --- */
  enableLightGlueGmc: boolean;
  /** 켜져 있어도 결과를 기록만 하고 추적 결정에 반영하지 않는다. */
  shadowMode: boolean;
  /** 고비용 검증이 실패하면 기존 경로로 돌아간다. */
  fallbackToSiftBf: boolean;
  backend: HighCostVerifyBackend;
  triggerMode: HighCostTriggerMode;

  /* --- 호출 빈도 --- */
  /** 같은 이유로 다시 부르기 전 최소 간격(ms). */
  cooldownMs: number;
  /** 연속 호출 상한. 넘으면 쉬게 한다. */
  maxConsecutiveRuns: number;
  /** 주기적 독립 검증 간격(ms). */
  keyframeValidationIntervalMs: number;

  /* --- 위험 판단 문턱 --- */
  minInlierCount: number;
  minInlierRatio: number;
  minCoverageRatio: number;
  maxReprojectionError: number;
  /** 다른 변환인데 비슷한 지지를 받은 후보의 지지 비율 상한. */
  maxRivalSupportRatio: number;

  /* --- 실패했을 때 --- */
  holdPreviousGmcOnFailure: boolean;
  maxPreviousGmcReuseMs: number;

  /* --- LightGlue 를 켤 때만 쓰는 값 (지금은 쓰이지 않는다) --- */
  lightGlueMaxKeypoints: number;
  lightGlueMinMatchConfidence: number;
  lightGluePrecision: 'fp32' | 'fp16';
}

/* 기본값은 요청서 13절을 따른다. 문턱은 합성 보정 집합에서 고른 초기 가설이다. */
export const HIGH_COST_VERIFY_CONFIG: Readonly<HighCostVerifyConfig> = Object.freeze({
  enableLightGlueGmc: false,
  shadowMode: true,
  fallbackToSiftBf: true,
  backend: 'keyframe',
  triggerMode: 'risk-and-periodic',
  cooldownMs: 300,
  maxConsecutiveRuns: 3,
  keyframeValidationIntervalMs: 1000,
  minInlierCount: GMC_VERIFY_POLICY.minInlierCount,
  minInlierRatio: GMC_VERIFY_POLICY.minInlierRatio,
  minCoverageRatio: 10 / 12,
  maxReprojectionError: GMC_VERIFY_POLICY.maxResidualP90,
  maxRivalSupportRatio: GMC_VERIFY_POLICY.maxRivalSupportRatio,
  holdPreviousGmcOnFailure: true,
  maxPreviousGmcReuseMs: 400,
  lightGlueMaxKeypoints: 512,
  lightGlueMinMatchConfidence: 0.2,
  lightGluePrecision: 'fp32',
});

/** LightGlue 가 제품 기본값으로 켜져 있는가. 테스트가 이 값을 지킨다. */
export const LIGHTGLUE_DEFAULT_ON = false;

export type HighCostTriggerReason =
  | 'few-inliers'
  | 'low-inlier-ratio'
  | 'poor-coverage'
  | 'high-reprojection'
  | 'rival-transform'
  | 'background-scarce'
  | 'transform-jump'
  | 'keyframe-disagreement'
  | 'periodic-check'
  | 'previous-gmc-unstable';

export interface HighCostTriggerInput {
  tSec: number;
  diagnostics: GmcDiagnostics;
  /** 직전 프레임 판정에서 나온 보류 사유들. */
  lastRejectReasons?: readonly GmcRejectReason[];
  /** 직전 확정 변환 대비 급변이 감지됐는가. */
  transformJump?: boolean;
  /** 키프레임 검증에서 이미 불일치가 났는가. */
  keyframeDisagreement?: boolean;
  /** 마지막으로 고비용 검증을 부른 시각(초). 없으면 null. */
  lastRunTSec?: number | null;
  /** 최근 연속 호출 횟수. */
  consecutiveRuns?: number;
  /** 마지막 독립 검증 시각(초). */
  lastPeriodicTSec?: number | null;
  thermal?: ThermalLevel;
}

export interface HighCostTriggerDecision {
  run: boolean;
  reasons: HighCostTriggerReason[];
  /** 무엇으로 검증할 것인가. 설정이 허락하지 않으면 keyframe 으로 내려간다. */
  backend: HighCostVerifyBackend;
  /** 결과를 실제 결정에 넣어도 되는가. shadow 모드면 false. */
  mayAffectTracking: boolean;
  /** 부르지 않았다면 왜인지. */
  skipped: 'cooldown' | 'too-many-runs' | 'trigger-off' | null;
}

/**
 * 지금 비싼 재검증을 부를지 정한다.
 *
 * 부르는 쪽이 비용을 내기 전에 물어보는 함수다. 실제 검증은 하지 않는다.
 */
export function shouldRunHighCostVerify(
  input: HighCostTriggerInput,
  config: HighCostVerifyConfig = HIGH_COST_VERIFY_CONFIG,
): HighCostTriggerDecision {
  const reasons: HighCostTriggerReason[] = [];
  const d = input.diagnostics;

  /* 백엔드 결정. 제품에 없는 것을 고르면 keyframe 으로 내려간다. */
  let backend: HighCostVerifyBackend = 'keyframe';
  if (config.backend === 'sift-lightglue' && config.enableLightGlueGmc) {
    backend = 'sift-lightglue';
  } else if (config.backend === 'sift-bf') {
    backend = 'sift-bf';
  }
  /* shadow 모드이거나 LightGlue 가 꺼져 있으면 추적 결정에 넣지 않는다. */
  const mayAffectTracking = !(config.shadowMode
    || (backend === 'sift-lightglue' && !config.enableLightGlueGmc));

  const off = (skipped: HighCostTriggerDecision['skipped']): HighCostTriggerDecision => ({
    run: false, reasons, backend, mayAffectTracking, skipped,
  });

  if (config.triggerMode === 'off') return off('trigger-off');

  /* 위험 신호 */
  if (d.inlierCount < config.minInlierCount) reasons.push('few-inliers');
  if (d.inlierRatio < config.minInlierRatio) reasons.push('low-inlier-ratio');
  if (d.gridCells / Math.max(1, d.gridCellsTotal) < config.minCoverageRatio) reasons.push('poor-coverage');
  if (!(d.residualP90 <= config.maxReprojectionError)) reasons.push('high-reprojection');
  if (d.rivalSupportRatio > config.maxRivalSupportRatio) reasons.push('rival-transform');
  if (d.backgroundShare < GMC_VERIFY_POLICY.minBackgroundShare) reasons.push('background-scarce');
  if (input.transformJump) reasons.push('transform-jump');
  if (input.keyframeDisagreement) reasons.push('keyframe-disagreement');
  if ((input.lastRejectReasons?.length ?? 0) > 0) reasons.push('previous-gmc-unstable');

  /* 주기적 독립 검증 */
  if (config.triggerMode === 'risk-and-periodic') {
    const interval = config.keyframeValidationIntervalMs / 1000;
    const last = input.lastPeriodicTSec;
    if (last == null || input.tSec - last >= interval) reasons.push('periodic-check');
  }

  if (reasons.length === 0) return off(null);

  /* 위험 신호가 있어도 너무 자주 부르지 않는다.
     다만 **키프레임 불일치와 급변은 쉬지 않는다** — 그때가 제일 위험하다. */
  const urgent = reasons.includes('keyframe-disagreement') || reasons.includes('transform-jump');
  if (!urgent) {
    const last = input.lastRunTSec;
    if (last != null && (input.tSec - last) * 1000 < config.cooldownMs) return off('cooldown');
    if ((input.consecutiveRuns ?? 0) >= config.maxConsecutiveRuns) return off('too-many-runs');
  }

  return { run: true, reasons, backend, mayAffectTracking, skipped: null };
}

/**
 * shadow 결과가 추적 결정에 새어 들어가지 않게 막는다.
 *
 * 부르는 쪽이 실수로 shadow 결과를 쓰려고 하면 여기서 걸린다. 설정 하나로
 * 안전을 보장하는 것보다, 값을 꺼내는 길목에서 막는 쪽이 낫다.
 */
export function takeVerifyResult<T>(
  decision: HighCostTriggerDecision,
  result: T,
): { usable: T | null; shadowOnly: boolean } {
  if (!decision.mayAffectTracking) return { usable: null, shadowOnly: true };
  return { usable: result, shadowOnly: false };
}
