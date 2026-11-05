/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·3069ee08 @license @preserve */
/* 카메라 변환을 적용해도 되는지 판정한다.

무엇이 문제였나. 기존 GMC 는 잔차가 작으면 변환을 채택했다. 그런데 **틀린
대응들도 서로 일관된 움직임을 만든다.** 그러면 잔차는 작고 인라이어는 많은데
변환은 틀린 상태가 된다. 화면에는 정상으로 보인다.

2026-09-22 합성 시험(315쌍)에서 제품 추정기는 208쌍을 채택했고 그중 **111쌍이
틀린 변환**이었다. 잘못된 카메라 변환은 상자를 엉뚱한 자리로 밀어 옆 사람과
IoU 를 만든다. 안 쓰는 것보다 나쁘다.

그래서 여기서는 두 가지를 본다.

1. **한 프레임의 근거** — 잔차만이 아니라 인라이어 비율·화면 분포·경쟁 변환의
   지지도까지 본다.
2. **시간을 건 일관성** — 직전 프레임만 보면 조금씩 어긋나는 것을 못 잡는다.
   검증된 키프레임에서 현재 프레임으로 **따로 추정한 변환**과, 프레임마다
   누적한 변환을 맞춰 본다. 둘이 어긋나면 보류한다.

독립 검증은 SIFT 가 아니다. 제품에는 OpenCV·SIFT 가 없다. 넣으면 APK 크기·ABI·
초기화 비용·라이선스를 새로 져야 한다. 여기서 쓰는 독립 검증은 **기준 프레임을
바꿔 다시 추정하는 것**이고, 프레임 연쇄와 독립이라는 성질은 같다. SIFT 경로는
실험으로만 남는다(docs/tracking-research/2026-09-22-sift-flann-gmc-simulation.md).

이 판정은 카메라 움직임에 대한 것이다. **같은 사람인지에 대한 판정이 아니다.**
GMC 가 확정돼도 추적 중인 사람이 그 사람이라는 뜻은 아니다.
*/

import {
  IDENTITY_AFFINE, type Affine2D, type AffineGmcResult, type GmcDiagnostics,
  GMC_GRID_W, GMC_GRID_H,
} from './affine-gmc';

export type GmcState =
  /** 프레임 간 추정이 근거를 모두 통과했고 아직 독립 검증 차례가 아니다. */
  | 'STABLE_LK'
  /** 근거가 모자라거나 모순된다. 독립 검증 전에는 적용하지 않는다. */
  | 'LK_SUSPICIOUS'
  /** 독립 검증을 요청한 상태. 검증 입력이 오기 전에는 적용하지 않는다. */
  | 'INDEPENDENT_VERIFYING'
  /** 근거와 일관성을 모두 통과했다. 적용한다. */
  | 'GMC_CONFIRMED'
  /** 검증에서 떨어졌다. 항등 변환을 쓴다. */
  | 'GMC_REJECTED'
  /** 장면이 바뀌었다. 키프레임과 누적을 버린다. */
  | 'SCENE_CUT'
  /** 배경이 모자라 카메라 움직임을 읽을 수 없다. */
  | 'INSUFFICIENT_BACKGROUND'
  /** 열 때문에 검증 주기를 늘린 상태. 위험 구간의 최소 검증은 유지한다. */
  | 'THERMAL_LIMITED';

export type ThermalLevel = 'nominal' | 'limited';

export interface GmcVerifyPolicy {
  /* --- 한 프레임의 근거 (합성 보정 집합 seed 101~103 에서 고름) --- */
  /** 인라이어 재투영 오차 p90 상한(축소 80×48 좌표계 px). */
  maxResidualP90: number;
  /** 인라이어가 들어 있어야 하는 최소 격자 칸 수(전체 12칸). */
  minGridCells: number;
  /** RANSAC 인라이어 / 후보 대응 비율 하한. */
  minInlierRatio: number;
  /** 최소 인라이어 수. */
  minInlierCount: number;
  /** 배경 화소 비율 하한. */
  minBackgroundShare: number;
  /** 다른 변환인데 비슷한 지지를 받은 후보의 지지 비율 상한. */
  maxRivalSupportRatio: number;

  /* --- 시간을 건 일관성 --- */
  /** 누적 변환과 키프레임 재추정 변환의 격자 차이 상한(축소 좌표계 px). */
  maxKeyframeGapPx: number;
  /** 직전 확정 변환 대비 이동 변화량 상한(축소 좌표계 px/초). */
  maxTranslationRatePx: number;

  /* --- 독립 검증 주기 --- */
  stableVerifySec: number;
  riskyVerifySec: number;
  thermalVerifySec: number;

  /* --- 키프레임 --- */
  /** 키프레임 교체를 검토하는 최소 간격(초). 오래됐다는 이유만으로 버리지 않는다. */
  keyframeReviewSec: number;
  /** 키프레임 교체에 요구하는 최소 근거 품질. */
  keyframeMinQuality: number;
}

/* 잔차·비율·경쟁자 셋은 합성 보정 집합(seed 101~103)에서 고르고 104~105 에서
   확인했다: 오변환 47→6, 정답 37→29.

   격자칸은 2026-09-23 실사 23편(1447쌍, 클립 단위로 보정 12편·검증 11편)에서
   10→9 로 내렸다. 합성은 그대로(보정 47/6, 검증 29/6)이고 실사 적용률만
   24.2%→30.1% 로 오른다. 참조 구현(OpenCV SIFT, 960x540)과 10px 넘게 어긋난
   적용은 두 값 모두 0건, 최대 어긋남 4.91px.

   실사에 맞춰 잔차를 0.25 까지 열면 실사 적용률은 43.8% 까지 오르지만 합성
   오변환이 검증에서 6→17 로 늘어 채택하지 않았다. 자세한 것은
   docs/tracking-research/2026-09-23-real-footage-gmc-recalibration.md. */
export const GMC_VERIFY_POLICY: Readonly<GmcVerifyPolicy> = Object.freeze({
  maxResidualP90: 0.08,
  minGridCells: 9,
  minInlierRatio: 0.9,
  minInlierCount: 12,
  minBackgroundShare: 0.42,
  maxRivalSupportRatio: 0.6,
  maxKeyframeGapPx: 2.5,
  maxTranslationRatePx: 240,
  stableVerifySec: 1,
  riskyVerifySec: 0.2,
  thermalVerifySec: 2.5,
  keyframeReviewSec: 1.5,
  keyframeMinQuality: 0.5,
});

/** 이 판정은 카메라 변환에 대한 것이지 동일인 판정이 아니다. */
export const GMC_IS_NOT_IDENTITY = true;

export type GmcRejectReason =
  | 'not-usable'
  | 'background-low'
  | 'residual-high'
  | 'grid-sparse'
  | 'inlier-ratio-low'
  | 'inlier-count-low'
  | 'rival-transform'
  | 'keyframe-mismatch'
  | 'translation-rate'
  | 'verification-due'
  | 'scene-cut';

export interface GmcEvidenceVerdict {
  /** 한 프레임의 근거만으로 통과했는가. */
  evidenceOk: boolean;
  reasons: GmcRejectReason[];
}

/**
 * 한 프레임의 근거만 본다. 시간·키프레임은 보지 않는다.
 *
 * 잔차가 작다는 것만으로 통과시키지 않는다 — 이 함수가 존재하는 이유다.
 */
export function assessGmcEvidence(
  result: Pick<AffineGmcResult, 'usable'> & { diagnostics: GmcDiagnostics },
  policy: GmcVerifyPolicy = GMC_VERIFY_POLICY,
): GmcEvidenceVerdict {
  const reasons: GmcRejectReason[] = [];
  if (!result.usable) reasons.push('not-usable');
  const d = result.diagnostics;
  if (d.backgroundShare < policy.minBackgroundShare) reasons.push('background-low');
  if (!(d.residualP90 <= policy.maxResidualP90)) reasons.push('residual-high');
  if (d.gridCells < policy.minGridCells) reasons.push('grid-sparse');
  if (d.inlierRatio < policy.minInlierRatio) reasons.push('inlier-ratio-low');
  if (d.inlierCount < policy.minInlierCount) reasons.push('inlier-count-low');
  if (d.rivalSupportRatio > policy.maxRivalSupportRatio) reasons.push('rival-transform');
  return { evidenceOk: reasons.length === 0, reasons };
}

/** 격자 9점에서 두 변환의 예측 차이(축소 좌표계 px). */
export function affineGapPx(a: Affine2D, b: Affine2D): number {
  let worst = 0;
  for (let gy = 0; gy < 3; gy += 1) {
    for (let gx = 0; gx < 3; gx += 1) {
      const x = (GMC_GRID_W * (gx + 0.5)) / 3;
      const y = (GMC_GRID_H * (gy + 0.5)) / 3;
      const px = a.a * x + a.b * y + a.tx;
      const py = a.c * x + a.d * y + a.ty;
      const qx = b.a * x + b.b * y + b.tx;
      const qy = b.c * x + b.d * y + b.ty;
      worst = Math.max(worst, Math.hypot(px - qx, py - qy));
    }
  }
  return worst;
}

/** A 다음에 B 를 적용한 합성 변환. */
export function composeAffine(first: Affine2D, second: Affine2D): Affine2D {
  return {
    a: second.a * first.a + second.b * first.c,
    b: second.a * first.b + second.b * first.d,
    tx: second.a * first.tx + second.b * first.ty + second.tx,
    c: second.c * first.a + second.d * first.c,
    d: second.c * first.b + second.d * first.d,
    ty: second.c * first.tx + second.d * first.ty + second.ty,
  };
}

export interface GmcVerifyInput {
  tSec: number;
  /** 직전 프레임 → 현재 프레임 추정. */
  frameEstimate: AffineGmcResult;
  /**
   * 키프레임 → 현재 프레임을 **따로** 추정한 결과. 부르는 쪽이 검증 차례일 때만
   * 계산해 넣는다. 없으면 null.
   */
  keyframeEstimate?: AffineGmcResult | null;
  thermal?: ThermalLevel;
  /** 프레임 간격이 비정상적으로 벌어졌는가(드롭·탐색). */
  frameGapSec?: number;
}

export interface GmcVerifyOutput {
  state: GmcState;
  /** 이 변환을 적용해도 되는가. false 면 affine 은 항등이다. */
  apply: boolean;
  affine: Affine2D;
  reasons: GmcRejectReason[];
  /** 부르는 쪽이 다음 프레임에 키프레임 재추정을 계산해 넣어야 하는가. */
  wantsIndependentCheck: boolean;
  /** 누적 변환과 키프레임 재추정의 격자 차이. 검증한 프레임에서만 채워진다. */
  keyframeGapPx: number | null;
  /** 이 값은 카메라 변환 근거이지 신원 확률이 아니다. */
  identityClaim: false;
}

/**
 * 한 추적 세션의 GMC 확정을 관리한다.
 *
 * 영상 한 편 안에서만 산다. 다른 영상과 아무것도 공유하지 않는다.
 */
export class GmcVerifier {
  private readonly policy: GmcVerifyPolicy;

  private state: GmcState = 'STABLE_LK';

  /** 키프레임에서 지금까지 누적한 변환. 키프레임이 없으면 null. */
  private accumulated: Affine2D | null = null;

  private keyframeTSec: number | null = null;

  private lastVerifiedTSec = -Infinity;

  private lastConfirmed: Affine2D | null = null;

  private lastConfirmedTSec: number | null = null;

  private consecutiveSuspicious = 0;

  constructor(policy: Partial<GmcVerifyPolicy> = {}) {
    this.policy = { ...GMC_VERIFY_POLICY, ...policy };
  }

  get currentState(): GmcState { return this.state; }

  get hasKeyframe(): boolean { return this.accumulated != null; }

  /** 현재 키프레임의 시각. 부르는 쪽이 그 프레임을 들고 있어야 재추정할 수 있다. */
  get keyframeTime(): number | null { return this.keyframeTSec; }

  /** 장면이 바뀌었다. 키프레임과 누적을 버린다. */
  resetScene(tSec: number): void {
    this.accumulated = null;
    this.keyframeTSec = null;
    this.lastVerifiedTSec = -Infinity;
    this.lastConfirmed = null;
    this.lastConfirmedTSec = null;
    this.consecutiveSuspicious = 0;
    this.state = 'SCENE_CUT';
    void tSec;
  }

  /** 지금 독립 검증이 필요한가. 부르는 쪽이 키프레임 재추정 비용을 낼지 정한다. */
  needsIndependentCheck(tSec: number, thermal: ThermalLevel = 'nominal'): boolean {
    if (this.accumulated == null) return false;
    const risky = this.state === 'LK_SUSPICIOUS' || this.state === 'INDEPENDENT_VERIFYING';
    /* 열이 나빠도 위험 구간의 최소 검증은 유지한다. 검증을 건너뛴 채
       낮은 품질의 변환을 확정하지 않는다. */
    const interval = risky
      ? this.policy.riskyVerifySec
      : (thermal === 'limited' ? this.policy.thermalVerifySec : this.policy.stableVerifySec);
    return tSec - this.lastVerifiedTSec >= interval;
  }

  accept(input: GmcVerifyInput): GmcVerifyOutput {
    const { tSec, frameEstimate } = input;
    const thermal = input.thermal ?? 'nominal';
    const hold = (state: GmcState, reasons: GmcRejectReason[], gap: number | null = null): GmcVerifyOutput => {
      this.state = state;
      return {
        state,
        apply: false,
        affine: IDENTITY_AFFINE,
        reasons,
        wantsIndependentCheck: this.needsIndependentCheck(tSec, thermal),
        keyframeGapPx: gap,
        identityClaim: false,
      };
    };

    /* 배경이 모자라면 카메라 움직임을 읽을 수 없다. 억지로 쓰지 않는다. */
    if (frameEstimate.diagnostics.backgroundShare < this.policy.minBackgroundShare) {
      this.consecutiveSuspicious += 1;
      return hold('INSUFFICIENT_BACKGROUND', ['background-low']);
    }

    const verdict = assessGmcEvidence(frameEstimate, this.policy);

    /* 프레임 간격이 크게 벌어졌으면 누적을 믿지 않는다. */
    const gappy = (input.frameGapSec ?? 0) > this.policy.stableVerifySec;

    /* 이동 속도가 물리적으로 말이 안 되면 근거와 무관하게 보류한다. */
    if (this.lastConfirmed && this.lastConfirmedTSec != null) {
      const dt = Math.max(1e-3, tSec - this.lastConfirmedTSec);
      const ratePx = affineGapPx(IDENTITY_AFFINE, frameEstimate.affine) / dt;
      if (ratePx > this.policy.maxTranslationRatePx) {
        this.consecutiveSuspicious += 1;
        return hold('LK_SUSPICIOUS', [...verdict.reasons, 'translation-rate']);
      }
    }

    if (!verdict.evidenceOk) {
      this.consecutiveSuspicious += 1;
      /* 근거가 모자라면 독립 검증 결과가 있을 때만 살릴 수 있다. */
      if (!input.keyframeEstimate) {
        return hold('LK_SUSPICIOUS', verdict.reasons);
      }
    }

    /* 검증 차례인데 키프레임 재추정이 오지 않았으면 적용하지 않는다.
       "정상으로 보인다" 를 근거로 검증을 건너뛰지 않는다. */
    const due = this.needsIndependentCheck(tSec, thermal);
    if (this.accumulated != null && due && !input.keyframeEstimate) {
      return hold('INDEPENDENT_VERIFYING', [...verdict.reasons, 'verification-due']);
    }

    /* 독립 검증이 왔으면 누적과 맞춰 본다. */
    let gap: number | null = null;
    if (input.keyframeEstimate && this.accumulated != null) {
      const kf = input.keyframeEstimate;
      if (!kf.usable) {
        /* 키프레임에서 현재 프레임이 아예 안 잡히면 장면이 바뀐 쪽을 의심한다. */
        this.resetScene(tSec);
        return {
          state: 'SCENE_CUT',
          apply: false,
          affine: IDENTITY_AFFINE,
          reasons: ['scene-cut'],
          wantsIndependentCheck: false,
          keyframeGapPx: null,
          identityClaim: false,
        };
      }
      const chain = composeAffine(this.accumulated, frameEstimate.affine);
      gap = affineGapPx(chain, kf.affine);
      this.lastVerifiedTSec = tSec;
      if (gap > this.policy.maxKeyframeGapPx) {
        this.consecutiveSuspicious += 1;
        /* 확신도를 평균 내지 않는다. 모순이면 보류한다. */
        return hold('GMC_REJECTED', [...verdict.reasons, 'keyframe-mismatch'], gap);
      }
      /* 검증을 통과했으니 누적을 독립 추정으로 다시 맞춘다 — 드리프트가 쌓이지
         않게 한다. */
      this.accumulated = kf.affine;
      this.consecutiveSuspicious = 0;
      this.lastConfirmed = frameEstimate.affine;
      this.lastConfirmedTSec = tSec;
      this.state = thermal === 'limited' ? 'THERMAL_LIMITED' : 'GMC_CONFIRMED';
      return {
        state: this.state,
        apply: true,
        affine: frameEstimate.affine,
        reasons: [],
        wantsIndependentCheck: false,
        keyframeGapPx: gap,
        identityClaim: false,
      };
    }

    if (!verdict.evidenceOk) {
      this.consecutiveSuspicious += 1;
      return hold('LK_SUSPICIOUS', verdict.reasons);
    }

    /* 근거를 통과했고 검증 차례도 아니다. 적용하고 누적에 더한다. */
    if (this.accumulated == null || gappy) {
      /* 키프레임을 세운다. 품질이 낮으면 세우지 않는다. */
      if (frameEstimate.quality >= this.policy.keyframeMinQuality) {
        this.accumulated = { ...IDENTITY_AFFINE };
        this.keyframeTSec = tSec;
        this.lastVerifiedTSec = tSec;
      }
    }
    if (this.accumulated != null) {
      this.accumulated = composeAffine(this.accumulated, frameEstimate.affine);
    }
    this.consecutiveSuspicious = 0;
    this.lastConfirmed = frameEstimate.affine;
    this.lastConfirmedTSec = tSec;
    this.state = thermal === 'limited' ? 'THERMAL_LIMITED' : 'STABLE_LK';
    return {
      state: this.state,
      apply: true,
      affine: frameEstimate.affine,
      reasons: [],
      wantsIndependentCheck: this.needsIndependentCheck(tSec, thermal),
      keyframeGapPx: null,
      identityClaim: false,
    };
  }

  /** 키프레임을 지금 프레임으로 바꿔도 되는가. 오래됐다는 이유만으로는 바꾸지 않는다. */
  mayReplaceKeyframe(tSec: number, candidate: AffineGmcResult): boolean {
    if (this.state === 'LK_SUSPICIOUS' || this.state === 'GMC_REJECTED') return false;
    if (candidate.quality < this.policy.keyframeMinQuality) return false;
    if (!assessGmcEvidence(candidate, this.policy).evidenceOk) return false;
    if (this.keyframeTSec == null) return true;
    return tSec - this.keyframeTSec >= this.policy.keyframeReviewSec;
  }
}
