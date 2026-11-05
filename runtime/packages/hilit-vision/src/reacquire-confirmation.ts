/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·79ea02c6 @license @preserve */
/* 재획득 후보와 확정 ID 를 분리하는 상태 기계.

이 모듈이 막으려는 것은 하나다. 가림이나 화면 이탈 동안 임시로 고른 후보가
그대로 "확정 대상" 이 되어, 다음 프레임의 근거(마지막 상자·갤러리·궤적)를
오염시키고 연쇄 ID 전환을 일으키는 일이다.

원칙
- 후보(CANDIDATE)와 검증 중(TENTATIVE)과 확정(CONFIRMED)은 다른 상태다.
- TENTATIVE 동안 확정 자산(사용자 anchor, 확정 갤러리, 안정 궤적)을 건드리지
  않는다. 이 모듈은 그 자산을 바꾸지 않고, 바꿔도 되는지 여부만 알려준다.
- 시간이 지났다는 것만으로 확정하지 않는다. 실제로 새로 관측된 프레임의
  증거 수를 센다. 예측만으로 만든 프레임은 관측 증거가 아니다.
- 자동 확정은 기본 꺼짐이다. 켜지 않으면 최대 USER_REVIEW 까지만 간다.
  출시 게이트(docs 참조)를 통과하기 전에는 기본값을 바꾸지 않는다.

여기서 나오는 점수는 순위 근거(ranking evidence)지 신원 확률이 아니다.
*/

export type TrackState =
  | 'TRACKED'
  | 'WARNING'
  | 'OCCLUDED'
  | 'LOST'
  | 'CANDIDATE'
  | 'TENTATIVE'
  | 'CONFIRMED'
  | 'REJECTED'
  | 'USER_REVIEW';

/** 확정을 막은 이유. 게이트마다 하나씩 대응한다. */
export type ConfirmBlockReason =
  | 'auto-confirm-disabled'
  | 'absolute-score-low'
  | 'margin-low'
  | 'too-few-observations'
  | 'too-short'
  | 'conflicts-stable-track'
  | 'spatially-implausible'
  | 'gallery-contradiction'
  | 'evidence-collapsed'
  | 'duplicate-slice'
  | 'candidate-expired'
  | 'stale-track';

export interface ReacquireConfirmPolicy {
  /** 기본 꺼짐. 켜면 CONFIRMED 로 승격한다. 출시 게이트 전에는 false 를 유지한다. */
  autoConfirm: boolean;
  /** 1위 후보의 절대 점수 하한. calibration 전 초기 가설값이다. */
  absoluteScoreMin: number;
  /** 1위와 2위의 점수 차 하한. calibration 전 초기 가설값이다. */
  top1Top2Margin: number;
  /** 확정에 필요한 최소 실관측 프레임 수. 예측만의 프레임은 세지 않는다. */
  minObservations: number;
  /** 단순한 짧은 가림 뒤 최소 확인 시간(초). */
  minConfirmSec: number;
  /** 군중 교차·유사 유니폼·화면 재진입 뒤 최소 확인 시간(초). */
  minConfirmSecHard: number;
  /** 후보가 갱신되지 않고 이 시간이 지나면 폐기한다(초). */
  candidateExpirySec: number;
  /** 마지막 확정 관측이 이보다 오래되면 그 트랙을 재사용하지 않는다(초). */
  staleTrackSec: number;
}

/* 대부분 calibration 전 초기 가설이다. 논문이 보장한 최적값이 아니다.

   absoluteScoreMin 만 2026-09-23 실사 23편에서 재고 고쳤다(0.62 -> 0.80).
   신원 정답은 없지만 기하로 확실한 짝은 만들 수 있다 — 같은 프레임의 서로
   다른 상자는 확실히 다른 대상이다. 그 짝에서 외형 점수를 재 보니:

       문턱   양성 통과   확실한 음성 통과
       0.62   99.8%      42.8%   <- 예전 값
       0.75   97.9%      19.5%
       0.80   96.0%      13.0%   <- 지금 값
       0.90   84.8%       4.2%

   0.62 는 "확실히 다른 사람" 짝의 절반 가까이를 통과시킨다. 외형 점수 하나로
   신원을 정하지는 않지만, 절대 문턱이 이 정도로 헐거우면 관문 노릇을 못 한다.

   합성 holdout 은 이 값을 재지 못한다. 자동 확정이 꺼져 있어 확정 관문까지
   가지 않기 때문이다(v2 평가기의 abs-0.50/0.70/0.80/0.90 네 줄이 전부 같은
   값으로 나온다).

   그리고 **이 변경은 지금 아무 동작도 바꾸지 않는다.** 웹·앱 런타임은 아직 이
   상태기계를 쓰지 않는다 — 웹은 gateReacquisitions(궤적 게이트), 앱은
   HilitReacquireGate 를 쓴다. 이 파일을 실제로 부르는 것은 평가기
   (holdout-eval-v2.ts)와 시험뿐이다. 런타임에 이 상태기계를 붙이고 자동
   확정을 켜는 날 효력이 생긴다. 그날 0.62 로 켜지 않으려고 미리 고쳐 둔다.

   주의: 위 양성 짝에는 배경 조각이 이어진 사슬도 섞여 있다. 배경은 프레임이
   지나도 거의 그대로라 양성 통과율이 실제 사람보다 높게 나온다. 자세한 것은
   docs/tracking-research/2026-09-23-real-footage-gmc-recalibration.md 12장. */
export const REACQUIRE_CONFIRM_POLICY: Readonly<ReacquireConfirmPolicy> = Object.freeze({
  autoConfirm: false,
  absoluteScoreMin: 0.80,
  top1Top2Margin: 0.08,
  minObservations: 3,
  minConfirmSec: 0.4,
  minConfirmSecHard: 0.8,
  candidateExpirySec: 1.5,
  staleTrackSec: 10,
});

/** 제품 기본값이 꺼짐인지 테스트로 확인하기 위한 상수. */
export const AUTO_REACQUIRE_DEFAULT_ON = false;

export interface RankedCandidate {
  id: string;
  /** 0~1 순위 근거 점수. 신원 확률이 아니다. */
  score: number;
  /** 같은 프레임의 조각 검출이 만든 중복 산출물로 판정됐는가. */
  duplicateSlice?: boolean;
  /** 예측 상자만으로 만든 후보인가. 관측 증거로 세지 않는다. */
  predictionOnly?: boolean;
}

export interface ConfirmContext {
  tSec: number;
  /** 이 프레임에서 대상이 실제로 관측 가능한 상태인가(가림·이탈이 아닌가). */
  observable: boolean;
  /** 군중 교차, 유사 유니폼, 화면 재진입 중 하나라도 해당하는가. */
  hardScene: boolean;
  /** 후보가 기존의 다른 안정 트랙과 충돌하는가. */
  conflictsStableTrack?: boolean;
  /** 공간적으로 이동 가능한 위치인가. false 면 확정하지 않는다. */
  spatiallyPlausible?: boolean;
  /** 검증된 갤러리 표본과 심하게 모순되는가. */
  galleryContradiction?: boolean;
  /** 검출과 운동 근거가 모두 무너졌는가. */
  evidenceCollapsed?: boolean;
  /** 대상이 마지막으로 확정 관측된 시각(초). null 이면 없음. */
  lastConfirmedTSec?: number | null;
}

export interface ConfirmDecision {
  state: TrackState;
  /** CONFIRMED 일 때만 채워진다. 그 외에는 null. */
  confirmedId: string | null;
  /** 검증 중인 후보. TENTATIVE·USER_REVIEW 에서 채워진다. */
  tentativeId: string | null;
  blocked: ConfirmBlockReason[];
  observations: number;
  elapsedSec: number;
  /** 확정 자산(anchor·확정 갤러리·안정 궤적)을 갱신해도 되는가. */
  mayUpdateConfirmedAssets: boolean;
  /** 이 점수는 순위 근거이지 신원 확률이 아니다. */
  scoreIsRankingEvidence: true;
}

interface Pending {
  id: string;
  firstTSec: number;
  lastTSec: number;
  observations: number;
  bestScore: number;
}

/**
 * 한 추적 세션의 재획득 확정을 관리한다.
 *
 * 영상 한 편 안에서만 산다. 다른 영상·다른 사용자와 아무것도 공유하지 않는다.
 */
export class ReacquireConfirmer {
  private readonly policy: ReacquireConfirmPolicy;

  private pending: Pending | null = null;

  private state: TrackState = 'TRACKED';

  private confirmedId: string | null;

  constructor(subjectId: string, policy: Partial<ReacquireConfirmPolicy> = {}) {
    this.policy = { ...REACQUIRE_CONFIRM_POLICY, ...policy };
    this.confirmedId = subjectId;
  }

  get currentState(): TrackState { return this.state; }

  get confirmed(): string | null { return this.confirmedId; }

  /** 가림·이탈로 관측이 끊겼음을 알린다. 확정 ID 는 유지한다. */
  markLost(kind: 'OCCLUDED' | 'LOST' | 'WARNING'): void {
    this.state = kind;
    this.pending = null;
  }

  /** 정상 추적으로 돌아왔음을 알린다. */
  markTracked(): void {
    this.state = 'TRACKED';
    this.pending = null;
  }

  /**
   * 한 프레임의 후보 순위를 받아 상태를 갱신한다.
   *
   * candidates 는 점수 내림차순일 필요가 없다. 내부에서 정렬한다.
   */
  offer(candidates: readonly RankedCandidate[], ctx: ConfirmContext): ConfirmDecision {
    const ranked = candidates.slice().sort((a, b) => b.score - a.score);
    const top = ranked[0] ?? null;
    const second = ranked[1] ?? null;
    const blocked: ConfirmBlockReason[] = [];

    if (this.pending && ctx.tSec - this.pending.lastTSec > this.policy.candidateExpirySec) {
      this.pending = null;
      blocked.push('candidate-expired');
    }

    if (!top) {
      this.state = this.state === 'TRACKED' ? 'WARNING' : this.state;
      return this.decision(blocked, null);
    }

    /* 예측만으로 만든 후보는 관측 증거가 아니다. 상태를 올리지 않는다. */
    if (top.predictionOnly || !ctx.observable) {
      this.state = this.state === 'TRACKED' ? 'WARNING' : this.state;
      return this.decision(blocked, null);
    }

    if (top.duplicateSlice) blocked.push('duplicate-slice');

    if (this.pending && this.pending.id !== top.id) this.pending = null;
    if (!this.pending) {
      this.pending = {
        id: top.id, firstTSec: ctx.tSec, lastTSec: ctx.tSec, observations: 0, bestScore: 0,
      };
    }
    this.pending.lastTSec = ctx.tSec;
    this.pending.observations += 1;
    this.pending.bestScore = Math.max(this.pending.bestScore, top.score);

    const elapsed = ctx.tSec - this.pending.firstTSec;
    const needSec = ctx.hardScene ? this.policy.minConfirmSecHard : this.policy.minConfirmSec;
    const margin = second ? top.score - second.score : Number.POSITIVE_INFINITY;

    if (top.score < this.policy.absoluteScoreMin) blocked.push('absolute-score-low');
    if (margin < this.policy.top1Top2Margin) blocked.push('margin-low');
    if (this.pending.observations < this.policy.minObservations) blocked.push('too-few-observations');
    if (elapsed < needSec) blocked.push('too-short');
    if (ctx.conflictsStableTrack) blocked.push('conflicts-stable-track');
    if (ctx.spatiallyPlausible === false) blocked.push('spatially-implausible');
    if (ctx.galleryContradiction) blocked.push('gallery-contradiction');
    if (ctx.evidenceCollapsed) blocked.push('evidence-collapsed');
    if (ctx.lastConfirmedTSec != null
      && ctx.tSec - ctx.lastConfirmedTSec > this.policy.staleTrackSec) blocked.push('stale-track');

    if (blocked.length > 0) {
      this.state = this.pending.observations >= 2 ? 'TENTATIVE' : 'CANDIDATE';
      return this.decision(blocked, this.pending.id);
    }

    if (!this.policy.autoConfirm) {
      blocked.push('auto-confirm-disabled');
      this.state = 'USER_REVIEW';
      return this.decision(blocked, this.pending.id);
    }

    this.state = 'CONFIRMED';
    this.confirmedId = this.pending.id;
    const id = this.pending.id;
    this.pending = null;
    return {
      state: 'CONFIRMED',
      confirmedId: id,
      tentativeId: null,
      blocked,
      observations: this.policy.minObservations,
      elapsedSec: elapsed,
      mayUpdateConfirmedAssets: true,
      scoreIsRankingEvidence: true,
    };
  }

  private decision(blocked: ConfirmBlockReason[], tentativeId: string | null): ConfirmDecision {
    return {
      state: this.state,
      confirmedId: this.state === 'CONFIRMED' ? this.confirmedId : null,
      tentativeId,
      blocked,
      observations: this.pending?.observations ?? 0,
      elapsedSec: this.pending ? this.pending.lastTSec - this.pending.firstTSec : 0,
      mayUpdateConfirmedAssets: false,
      scoreIsRankingEvidence: true,
    };
  }
}
