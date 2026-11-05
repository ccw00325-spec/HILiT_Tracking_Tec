/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·d906134c @license @preserve */
import { type TrackingPoint } from '@hilit/shared-types';
import { OneEuroPoint } from './one-euro';

/* 추적 대상을 따라가는 카메라.
 *
 * 왜 공용 모듈인가
 * ----------------
 * 미리보기와 실제 내보내기가 각자 크롭을 계산하면 화면에서 본 것과 저장된
 * 영상이 달라진다. 실제로 그런 상태였다 — 미리보기는 따라가는데
 * 내보내기는 원본을 그대로 그렸다.
 *
 *   video-export.ts (수정 전)
 *     if (aspect === 'source') { ctx.drawImage(video, 0, 0, w, h); return; }
 *
 * 기본 비율이 'source' 라서 저장한 영상에는 추적이 한 번도 반영되지 않았다.
 * 그래서 크롭 계산을 여기 한 곳에 모으고 두 경로가 같이 쓴다.
 *
 * 설계
 * ----
 * - 위치는 **보간**한다. 분석은 20fps 인데 출력은 30fps 라 가장 가까운
 *   점만 쓰면 카메라가 계단처럼 튄다.
 * - 확대율은 대상 크기에 맞춘다. 사람이 작게 찍혔으면 더 당긴다.
 *   고정 배율은 멀리 있는 사람을 점으로 만든다.
 * - 데드존을 둔다. 대상이 중앙 근처에서 미세하게 흔들릴 때 카메라가
 *   같이 떨면 보기 어렵다.
 * - 고른 사람을 주인공처럼 가운데에 둔다(구도 v2, 2026-09-27). 멈춰 있으면 가로 50%,
 *   달려도 진행 방향 앞을 조금만(크롭 너비의 5%) 비워 45% 부근에 둔다. v1 은 35~40% 로
 *   밀어서 사람이 한쪽에 붙어 보였다.
 * - 몸의 세로 중심을 화면 가운데 조금 아래(52%)에 둔다. 머리 위가 발 아래보다 조금 넓다.
 *   v1 은 눈을 위 1/3 에 고정해서 사람이 크게 잡힐수록 발이 아래 끝으로 밀렸다.
 * - 멈춘 장면과 움직이는 장면의 목표 크기를 따로 둔다(stillShare · subjectShare).
 * - 놓친 구간(TARGET_LOST·REACQUIRING·빈 상자)은 그 상자를 따라가지 않는다. 마지막으로 본
 *   자리를 붙잡고 조금씩 넓힌다. 놓친 상자는 다른 사람이거나 화면 구석(0,0)의 빈 값일 수 있다.
 * 측정: docs/tracking-research/2026-09-27-follow-composition-v2.md
 */

/* 크롭이 원본의 이 비율을 넘지 않는다.
 *
 * 남는 여백이 곧 카메라가 움직일 수 있는 거리다. 1.0 이면 크롭이 화면
 * 전체가 될 수 있고, 그러면 팔로우캠이 따라가지 않는다.
 *
 * 화면에 표시하는 해상도 계산(lib/quality.ts)도 이 값을 써야 한다.
 * 두 곳에서 따로 정의하면 표시값과 실제가 어긋난다 — 실제로 어긋났다. */
export const MAX_CROP_SHARE = 0.82;

/* 화면 크기를 우선할 때의 바닥 배율.
 *
 * 사용자가 "가깝게" 를 끝까지 밀어도 이보다 더 늘리지는 않는다. 2.6배면
 * 1280p 출력에서 크롭이 약 492px 이고, 그 아래로 내려가면 CAS 로도
 * 살릴 것이 없다 — 화소 몇 개를 화면 가득 늘린 그림이 된다.
 *
 * 화면에 표시하는 해상도 계산(lib/quality.ts)도 이 값을 써야 한다. */
export const HARD_MAX_UPSCALE = 2.6;

/* 「화면 크기」의 기본값 — 움직이는 장면에서 대상이 출력 높이에서 차지할 목표 비율.
 * 대상 크기를 모를 때 이 값이 "예전 그대로" 의 기준이 된다 — 여기서는 크롭이 maxCropShare 와 같아진다.
 * 값은 실제 영상 측정으로 골랐다(연구 기록 2026-09-27-follow-composition-v2). 업계 표준이 아니라
 * HILiT 의 임시 평가 목표다. v1 은 0.42 였다. */
export const DEFAULT_SUBJECT_SHARE = 0.46;
/* 멈춘 장면(미디엄 숏)의 목표 비율 — 움직일 때보다 조금 당긴다.
 * v1 은 미디엄 배율 0.82 로 0.42 / 0.82 ≈ 0.51 이었다. */
export const DEFAULT_STILL_SHARE = 0.52;

export type OutputAspect = 'source' | 'portrait' | 'landscape';
export type ShotKind = 'full' | 'medium';
export type HighlightWindow = { start: number; end: number };

export interface CropRect { sx: number; sy: number; sw: number; sh: number }

/** 정지일 때 대상의 가로 위치. 달리면 이 값에서 리드룸만큼 뒤로 간다. */
export const GOLDEN_X_STILL = 0.50;
/** 달릴 때 대상이 앉는 자리. v1 은 0.375(진행 반대쪽 35~40%)였고 사람이 한쪽에 밀려 보였다. */
export const GOLDEN_X_RUN = 0.45;
/** 눈/상체를 화면 위에서부터 두는 비율 — 구도 시험(subjectInCrop)의 눈 높이에만 쓴다. */
export const GOLDEN_Y_EYE = 0.33;
/** 몸(추적 상자)의 세로 중심을 둘 자리. 0.5 보다 조금 아래라 머리 위가 발 아래보다 넓다. */
export const BODY_CENTRE_Y = 0.52;
/** 놓친 구간에서 마지막 자리를 붙잡은 채 1.2초에 걸쳐 이만큼까지 넓힌다. */
export const LOST_HOLD_WIDEN = 1.25;

/**
 * 카메라 계획이 실제로 낸 구도 — 화면에 그대로 적는다(목표가 아니라 달성값).
 * 놓친 구간은 빼고 센다. 대상 비율은 **추적 상자 기준**이다(정확도가 아니다).
 */
export interface PlanStats {
  /** 추적 상자가 출력 높이에서 차지한 비율 — 중앙값 · 하위 10% */
  subjectShareMedian: number;
  subjectShareP10: number;
  /** 원본을 늘린 배율 — 중앙값 · 최대 */
  upscaleMedian: number;
  upscaleMax: number;
  /** 원본에서 실제로 쓴 세로 화소(출력 높이를 넘지 않게) — 가장 낮은 값 */
  effectiveHeightMin: number;
  /** 놓친 구간이라 마지막 자리를 붙잡은 점 수 */
  heldPoints: number;
}

export interface FollowCameraOptions {
  sourceWidth: number;
  sourceHeight: number;
  aspect?: OutputAspect;
  /** 대상이 출력 화면 높이에서 차지할 목표 비율(움직이는 장면·「화면 크기」). 0.45 면 화면의 절반 조금 아래. */
  subjectShare?: number;
  /**
   * 멈춘 장면(미디엄 숏)의 목표 비율. 안 주면 subjectShare × (DEFAULT_STILL_SHARE / DEFAULT_SUBJECT_SHARE) —
   * 「화면 크기」를 움직이면 두 값이 같은 비율로 따라간다.
   */
  stillShare?: number;
  /** 몸의 세로 중심을 둘 자리(크롭 위에서부터 비율). 기본 BODY_CENTRE_Y. */
  bodyCentreY?: number;
  /**
   * 앞뒤 이동에 따른 줌 경로(plan 전용, 초 단위 — 프레임률과 무관).
   * 3D 거리를 재는 것이 아니다. 화면 속 인물 상자 높이의 **지속된** 변화에 크롭을 맞춘다.
   *   zoomPersistSec  이보다 짧은 크기 변화는 무시(중앙값 창 길이)
   *   zoomDeadband    목표가 지금 크기에서 이 비율 안이면 바꾸지 않는다
   *   zoomInTau       멀어져 작아질 때 당기는 반응 시간상수(느리게)
   *   zoomOutTau      가까워져 커질 때 푸는 반응 시간상수(빠르게)
   *   zoomLeadSec     푸는 쪽은 이만큼 앞서 시작한다 — 머리·발이 잘리기 전에
   */
  zoomPersistSec?: number;
  zoomDeadband?: number;
  zoomInTau?: number;
  zoomOutTau?: number;
  zoomLeadSec?: number;
  /** 확대 한계. 너무 당기면 맥락이 사라지고 너무 풀면 대상이 작아진다. */
  minCropShare?: number;
  maxCropShare?: number;
  /** 카메라 추종 속도 (0~1). 클수록 빠르게 붙는다. */
  follow?: number;
  /** 진행 방향 예측 시간(초). */
  lookAhead?: number;
  /**
   * 앞을 비워 두는 양의 상한 — 크롭 크기 비율.
   *
   * ## 왜 상한이 필요한가
   *
   * 진행 방향으로 미리 보는 것(lookAhead)은 맞는 생각이다. 뒤따라가면
   * 대상이 프레임 뒤쪽 가장자리에 붙는다. 그런데 예측량이 **속도에
   * 비례해서 무한정 커진다**는 게 문제다.
   *
   *   빠른 스포츠에서 초속 0.9(화면 너비 기준)로 달리는 사람
   *   lookAhead 0.22초 -> 0.198  = 크롭 너비의 40% 를 앞질러 본다
   *   결과: 대상이 프레임 반대쪽 가장자리로 밀린다. 심하면 밖으로 나간다
   *
   * 방송 촬영의 리드룸(lead room)은 화면의 10~15% 정도다. 그 이상
   * 앞서면 "따라가는 카메라" 가 아니라 "혼자 달려가는 카메라" 가 된다.
   *
   * 그래서 예측은 그대로 두고 **결과에만 상한**을 둔다. 느릴 때는
   * 예전과 똑같이 동작하고, 빠를 때만 붙잡는다.
   */
  leadRoom?: number;
  /** Maximum horizontal offset from the subject, as a share of crop width. */
  centerTolerance?: number;
  /**
   * 빠르게 움직일 때 얼마나 넓게 볼 것인가 (0 이면 예전 동작).
   *
   * ## 왜 — "사람이 중심에 나오면서도 움직임을 놓치지 않게"
   *
   * 이 둘은 원래 서로 반대다. 당기면 사람이 크게 보이지만 조금만 빠르게
   * 움직여도 프레임을 벗어나고, 풀면 안 벗어나지만 사람이 작아진다.
   *
   * 고정 배율은 둘 중 하나를 늘 포기한다. 그런데 **언제 무엇을 포기해야
   * 하는지는 대상의 속도가 알려준다.**
   *
   *   멈춰 있다   놓칠 위험이 없다        -> 당긴다. 사람이 크게 보인다
   *   달린다      놓칠 위험이 크다        -> 조금 푼다. 움직임이 들어온다
   *
   * 실제 촬영자가 하는 일과 같다. 줌인해 놓고 선수가 뛰기 시작하면
   * 줌아웃한다.
   *
   * 상한을 둔다(1.35배). 그 이상 풀면 "따라가지 않는 것" 처럼 보인다.
   */
  speedZoom?: number;
  /**
   * 눈/상체를 화면 위에서부터 이 비율에 둔다. 0.33 이면 상단 1/3.
   * 정중앙(0.5)에 두면 스포츠가 답답해 보인다.
   */
  headAnchor?: number;
  /** 추적 상자 위에서부터 눈까지의 비율. 전신 상자면 대략 0.13. */
  eyeFromTop?: number;
  /**
   * 발 아래 최소 여백. 작게 잡을수록 아래에서 올려다보는 느낌이다.
   * 머리를 자르지는 않는다.
   */
  bottomSlack?: number;
  /**
   * 정지·클립 앞뒤·클라이맥스는 미디엄, 플레이 중은 전신.
   * 끄면 화면 크기 슬라이더와 속도 줌만 쓴다.
   */
  autoShot?: boolean;
  /**
   * 대상을 화면 가운데보다 이만큼 위에 둔다 — 예전 호출부 호환.
   * headAnchor 가 있으면 이쪽은 쓰지 않는다.
   */
  headroom?: number;
  /**
   * 화면 크기(subjectShare)를 화질 하한보다 우선하는가.
   *
   * ## 왜 필요한가 — 슬라이더가 죽어 있었다
   *
   * 아래 화질 하한은 "출력 높이 / 허용 배율" 만큼은 잘라내라고 강제한다.
   * 흔한 조합에서 그 하한이 **가능한 범위 전체를 삼킨다.**
   *
   *   1080p 원본 · 9:16 출력(1280) · maxUpscale 1.15
   *     하한   1280 / 1.15 = 1113px
   *     여유   1080 × 0.82 =  886px
   *     -> 크롭 높이가 언제나 886px 로 고정된다
   *
   * 크롭이 고정이면 subjectShare 를 아무리 움직여도 화면이 그대로다.
   * 1080p 는 가장 흔한 입력이므로 **사실상 모든 사용자에게** 화면 크기
   * 슬라이더가 아무 일도 하지 않았다.
   *
   * ## 어떻게 고치는가
   *
   * 사용자가 화면 크기를 직접 움직였다면 그건 "화질을 좀 내주더라도
   * 당겨서 보고 싶다" 는 뜻이다. 그때는 화질 하한을 사용자 뜻 아래에
   * 둔다. 대신 **결과 화질을 숨기지 않는다** — quality() 가 실제 배율을
   * 그대로 돌려주고, 화면이 그 숫자를 적는다.
   *
   * 바닥은 남긴다(HARD_MAX_UPSCALE). 무한히 당기면 화소 몇 개를 화면
   * 가득 늘리게 되고, 그건 아무도 원하지 않는 결과다.
   *
   * 기본값은 false 다 — 이 값을 켜지 않은 호출부(테스트 포함)의 동작이
   * 바뀌면 안 된다.
   */
  zoomFirst?: boolean;
  /* 허용할 최대 업스케일 배율.
   *
   * 잘라낸 영역을 출력 크기로 늘릴 때의 배율이다. 1.0 이면 원본 화소를
   * 그대로 쓴다는 뜻이고, 2.0 이면 화소를 두 배로 늘린다는 뜻이다.
   *
   * 이 값이 화질을 직접 결정한다. 1080p 영상에서 멀리 있는 사람(화면
   * 높이의 12%)을 크게 잡으려면 crop 이 341px 까지 내려가고, 그걸 720p
   * 로 늘리면 2.1배다 — 실질 화질이 340p 가 된다.
   *
   * 그래서 "얼마나 크게" 가 아니라 "화질을 얼마나 포기할지" 로 다룬다.
   * 사용자가 이 값을 직접 고르고, 화면에는 그 결과 해상도를 보여준다. */
  maxUpscale?: number;
  /**
   * 원본 가장자리 고정(2026-09-28 사용자 결정). 사람이 원본 화면 끝에 걸려 가운데에 둘 수 없으면
   * 크롭을 그 끝에 붙여 둔다. 겨누는 자리가 끝에서 크롭 폭의 edgePinIn 안으로 들어오면 끝에 붙이고,
   * edgePinOut 밖으로 나가야 뗀다(두 문턱 — 끝 근처에서 크롭이 조금씩 들락거리지 않게).
   * 0 이면 끈다. edgePinOut 은 centerTolerance(0.08) 이하여야 사람 쪽 제약과 싸우지 않는다.
   */
  edgePinIn?: number;
  edgePinOut?: number;
  /**
   * 가장자리 확대(2026-09-28 실험 — **기본 꺼짐**, 사용자 결정 전). 사람이 원본 끝에 가까워 가운데에 둘 수 없으면
   * 화질 하한(확대 한계)까지만 크롭을 줄여, 사람이 크롭 가운데 ±이 값(크롭 너비 비율) 안에 오게 한다.
   * 0 이면 끈다(지금 기본 — 원본 가장자리 고정 결정대로 끝에 붙인다).
   */
  edgeZoomTolerance?: number;
}

/**
 * 겨누는 자리(크롭 중심 x)를 원본 끝에 붙인다 — 두 문턱(hysteresis). 제자리에서 고친다.
 * 끝 쪽으로만 옮긴다 — 이미 원본 밖을 겨누는 값은 그대로 둔다(그 값이 경로를 끝으로 더 세게 민다).
 * 장면 경계·컷(broken)에서는 붙임 상태를 새로 시작한다.
 */
export function edgePin(aimX: number[], cropW: readonly number[], sw: number, broken: readonly boolean[],
  pinIn = 0.05, pinOut = 0.08): void {
  if (!(pinIn > 0)) return;
  const out = Math.max(pinIn, pinOut);
  let side: -1 | 0 | 1 = 0;
  for (let i = 0; i < aimX.length; i += 1) {
    if (broken[i]) side = 0;
    const w = Math.min(sw, cropW[i]);
    const leftGap = (aimX[i] - w / 2) / w;
    const rightGap = (sw - (aimX[i] + w / 2)) / w;
    if (side === -1 && leftGap > out) side = 0;
    if (side === 1 && rightGap > out) side = 0;
    if (side === 0) side = leftGap < pinIn ? -1 : rightGap < pinIn ? 1 : 0;
    if (side === -1) aimX[i] = Math.min(aimX[i], w / 2);
    else if (side === 1) aimX[i] = Math.max(aimX[i], sw - w / 2);
  }
}

/**
 * 단조 3차 보간(Fritsch–Carlson PCHIP)에서 점 i 의 기울기. 고르지 않은 시간 간격을 그대로 쓴다.
 * 이웃 기울기의 부호가 다르거나 한쪽이 0 이면 0 — 그래서 곡선이 이웃 점 값 밖으로 넘치지 않는다.
 */
function pchipSlope(t: readonly number[], v: readonly number[], i: number): number {
  const n = v.length;
  if (n < 2) return 0;
  const d = (a: number) => (v[a + 1] - v[a]) / Math.max(1e-6, t[a + 1] - t[a]);
  if (i <= 0) return n > 2 && Math.sign(d(0)) === Math.sign(d(1)) ? d(0) : (n > 2 ? 0 : d(0));
  if (i >= n - 1) return n > 2 && Math.sign(d(n - 2)) === Math.sign(d(n - 3)) ? d(n - 2) : (n > 2 ? 0 : d(n - 2));
  const d0 = d(i - 1), d1 = d(i);
  if (d0 === 0 || d1 === 0 || Math.sign(d0) !== Math.sign(d1)) return 0;
  const h0 = t[i] - t[i - 1], h1 = t[i + 1] - t[i];
  const w1 = 2 * h1 + h0, w2 = h1 + 2 * h0;
  return (w1 + w2) / (w1 / d0 + w2 / d1);
}

/** 계획 점 lo·hi 사이 시각 t 의 값 — 단조 3차 에르미트. lo === hi 면 그 점 값. */
export function pchipAt(t: readonly number[], v: readonly number[], lo: number, hi: number, at: number): number {
  if (hi === lo) return v[lo];
  const h = Math.max(1e-6, t[hi] - t[lo]);
  const s = Math.max(0, Math.min(1, (at - t[lo]) / h));
  const s2 = s * s, s3 = s2 * s;
  const m0 = pchipSlope(t, v, lo) * h, m1 = pchipSlope(t, v, hi) * h;
  return (2 * s3 - 3 * s2 + 1) * v[lo] + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * v[hi] + (s3 - s2) * m1;
}

/**
 * 겨누는 자리 데드존(hysteresis). 붙잡은 자리에서 band[i] 안이면 그대로 두고, 벗어나면 벗어난 만큼만
 * 따라간다 — 끈에 묶인 고리처럼. 컷(broken)에서는 새로 잡는다.
 *
 * 한 방향으로만 돌리면 꾸준히 움직이는 대상을 늘 band 만큼 뒤따라가 앞 비움이 사라진다(시험
 * 「앞을 조금만 비운다」). 앞에서 한 번·뒤에서 한 번 돌려 평균한다 — 등속 이동에서는 두 뒤처짐이
 * 서로 지워져 겨누는 자리 그대로 가고, band 안의 제자리 흔들림은 두 방향 모두 붙잡혀 멈춘다.
 */
export function holdAim(aim: readonly number[], band: readonly number[], broken: readonly boolean[]): number[] {
  const n = aim.length;
  const pass = (order: number[]) => {
    const out = new Array<number>(n);
    let held = aim[order[0]];
    for (let k = 0; k < n; k += 1) {
      const i = order[k];
      /* 컷은 i 에서 시작하는 새 구간이다 — 앞 방향은 i 에서, 뒤 방향은 i-1 에서 새로 잡는다. */
      const fresh = k === 0 || (order[0] === 0 ? broken[i] : broken[i + 1] === true);
      if (fresh) { held = aim[i]; out[i] = held; continue; }
      const d = aim[i] - held;
      if (d > band[i]) held = aim[i] - band[i];
      else if (d < -band[i]) held = aim[i] + band[i];
      out[i] = held;
    }
    return out;
  };
  const idx = Array.from({ length: n }, (_, i) => i);
  const fwd = pass(idx);
  const bwd = pass(idx.slice().reverse());
  return fwd.map((v, i) => (v + bwd[i]) / 2);
}

/**
 * 몸 가로 중심의 이동 중앙값(창 win 초). 팔을 뻗고 접을 때 상자 가운데가 출렁이는 것을 걸러,
 * 묶음(centerTolerance)이 안무 손짓이 아니라 몸의 자리를 따르게 한다. win 0 이면 그대로.
 */
export function steadyCentreX(times: readonly number[], cx: readonly number[], broken: readonly boolean[], win: number): number[] {
  if (!(win > 0)) return cx.slice();
  const n = cx.length, half = win / 2;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    const w: number[] = [cx[i]];
    for (let j = i - 1; j >= 0 && !broken[j + 1] && times[i] - times[j] <= half + 1e-9; j -= 1) w.push(cx[j]);
    for (let j = i + 1; j < n && !broken[j] && times[j] - times[i] <= half + 1e-9; j += 1) w.push(cx[j]);
    w.sort((a, b) => a - b);
    out[i] = w[w.length >> 1];
  }
  return out;
}

/** 시간축 가우시안 평활(σ 초). 컷(broken)을 넘지 않는다. 점 간격이 고르지 않아도 된다. */
export function gaussianInTime(times: readonly number[], v: readonly number[], broken: readonly boolean[], sigma: number): number[] {
  const n = v.length;
  const seg: number[] = new Array(n);
  for (let i = 0, s = 0; i < n; i += 1) { if (broken[i]) s += 1; seg[i] = s; }
  const out = new Array<number>(n);
  const reach = 3 * sigma;
  for (let i = 0; i < n; i += 1) {
    let sw = 0, sv = 0;
    for (let j = i; j >= 0 && seg[j] === seg[i] && times[i] - times[j] <= reach; j -= 1) {
      const w = Math.exp(-0.5 * ((times[i] - times[j]) / sigma) ** 2); sw += w; sv += w * v[j];
    }
    for (let j = i + 1; j < n && seg[j] === seg[i] && times[j] - times[i] <= reach; j += 1) {
      const w = Math.exp(-0.5 * ((times[j] - times[i]) / sigma) ** 2); sw += w; sv += w * v[j];
    }
    out[i] = sw > 0 ? sv / sw : v[i];
  }
  return out;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * 크롭 높이 경로 — 앞뒤 이동에 따른 줌(구도 v2).
 *
 * @param target  점마다 원하는 크롭 높이(= 원본 속 인물 높이 ÷ 목표 비율, 속도·놓침 넓힘 포함)
 * @param floor   전신(머리·발 여유 포함)을 담는 최소 크롭 높이 — 마지막에 반드시 지킨다
 * @param lowTrust 가림·경고·놓침 — 이 순간의 "작아짐" 은 믿지 않는다(줌인 보류, 줌아웃은 허용)
 * @param resets  여기서 줌 상태를 새로 시작한다(장면 경계·재획득 컷)
 */
export function planZoomPath(
  times: readonly number[], target: readonly number[], floor: readonly number[],
  lowTrust: readonly boolean[], resets: readonly boolean[],
  o: { persistSec: number; deadband: number; zoomInTau: number; zoomOutTau: number; leadSec: number; aspects?: readonly number[] },
): number[] {
  const n = times.length;
  if (!n) return [];
  const segStart = (i: number) => i === 0 || resets[i];
  /* 1. 지속 시간 — 앞뒤 persistSec/2 창의 중앙값. 한두 프레임의 상자 튐(검출 흔들림)은 목표를 못 바꾼다.
   *    장면 경계를 넘어 섞지 않는다. */
  const half = Math.max(0, o.persistSec) / 2;
  const seg: number[] = []; let sid = 0;
  for (let i = 0; i < n; i += 1) { if (i > 0 && resets[i]) sid += 1; seg.push(sid); }
  const med = target.map((_, i) => {
    const win: number[] = [];
    for (let j = i; j >= 0 && seg[j] === seg[i] && times[i] - times[j] <= half + 1e-9; j -= 1) win.push(target[j]);
    for (let j = i + 1; j < n && seg[j] === seg[i] && times[j] - times[i] <= half + 1e-9; j += 1) win.push(target[j]);
    win.sort((a, b) => a - b);
    return win[win.length >> 1];
  });
  /* 2. 믿기 어려운 줌인 보류 — 가림·경고·놓침이거나, 상자 모양(높이/폭)이 1초 중앙값에서 25% 넘게 달라졌을 때
   *    (웅크림·점프·회전·부분 가림은 상자 높이를 바꾸지만 앞뒤 이동이 아니다). 그때는 작아진 목표를 받지 않는다. */
  const aspects = o.aspects;
  const shapeOdd = (i: number) => {
    if (!aspects) return false;
    const win: number[] = [];
    for (let j = i; j >= 0 && seg[j] === seg[i] && times[i] - times[j] <= 1; j -= 1) win.push(aspects[j]);
    win.sort((a, b) => a - b);
    const m = win[win.length >> 1];
    return m > 0 && Math.abs(aspects[i] / m - 1) > 0.25;
  };
  /* 3. 데드밴드 + 4. 비대칭 반응(시간 간격 기반) */
  const out = new Array<number>(n);
  let held = med[0], cur = med[0];
  for (let i = 0; i < n; i += 1) {
    let want = med[i];
    if (segStart(i)) { held = want; cur = want; out[i] = cur; continue; }
    if (want < held && (lowTrust[i] || shapeOdd(i))) want = held;          // 줌인 보류
    if (Math.abs(want / Math.max(1e-6, held) - 1) > o.deadband) held = want;
    const dt = Math.max(0, times[i] - times[i - 1]);
    const tau = held < cur ? o.zoomInTau : o.zoomOutTau;
    cur += (held - cur) * (1 - Math.exp(-dt / Math.max(1e-3, tau)));
    out[i] = cur;
  }
  /* 5. 줌아웃은 앞서 — 앞으로 leadSec 안에서 필요한 가장 넓은 크롭(반응 결과와 전신 하한)을 지금부터 쓴다.
   *    다음 장면 것은 보지 않는다. */
  const need = out.map((v, i) => Math.max(v, floor[i]));
  const lead = need.slice();
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n && seg[j] === seg[i] && times[j] - times[i] <= o.leadSec + 1e-9; j += 1) {
      if (need[j] > lead[i]) lead[i] = need[j];
    }
  }
  /* 앞서 보기로 생긴 계단을 부드럽게 — 오르는 쪽은 zoomOutTau, 내려오는 쪽은 zoomInTau. 그 뒤 전신 하한을 다시 강제한다. */
  const res = lead.slice();
  for (let i = n - 2; i >= 0; i -= 1) {
    if (segStart(i + 1)) continue;
    const dt = Math.max(0, times[i + 1] - times[i]);
    if (res[i] < res[i + 1]) res[i] = res[i + 1] + (res[i] - res[i + 1]) * (1 - Math.exp(-dt / Math.max(1e-3, o.zoomOutTau)));
  }
  for (let i = 1; i < n; i += 1) {
    if (segStart(i)) continue;
    const dt = Math.max(0, times[i] - times[i - 1]);
    if (res[i] < res[i - 1]) res[i] = res[i - 1] + (res[i] - res[i - 1]) * (1 - Math.exp(-dt / Math.max(1e-3, o.zoomInTau)));
  }
  return res.map((v, i) => Math.max(v, floor[i]));
}

function nearestOther(
  subject: { x: number; y: number; width: number; height: number },
  others: readonly { x: number; y: number; width: number; height: number }[],
): { x: number; y: number; width: number; height: number } | null {
  const sx = subject.x + subject.width / 2;
  const sy = subject.y + subject.height / 2;
  let best: { x: number; y: number; width: number; height: number } | null = null;
  let bestD = Infinity;
  for (const other of others) {
    const dx = other.x + other.width / 2 - sx;
    const dy = other.y + other.height / 2 - sy;
    const d = Math.hypot(dx, dy);
    if (d > 1e-4 && d < bestD) { best = other; bestD = d; }
  }
  return best;
}

interface Sample {
  cx: number; cy: number; h: number; vx: number; vy: number;
  bbox?: { x: number; y: number; width: number; height: number };
  nearbyBoxes?: { x: number; y: number; width: number; height: number }[];
}

/** 두 점 사이를 시간으로 보간한다. 가장 가까운 점만 쓰면 계단이 생긴다. */
function sampleAt(points: TrackingPoint[], t: number): Sample | null {
  if (!points.length) return null;
  if (points.length === 1 || t <= points[0].timestamp) {
    const p = points[0];
    return {
      cx: p.bbox.x + p.bbox.width / 2, cy: p.bbox.y + p.bbox.height / 2, h: p.bbox.height, vx: 0, vy: 0,
      bbox: p.bbox, nearbyBoxes: p.nearbyBoxes,
    };
  }
  const last = points[points.length - 1];
  if (t >= last.timestamp) {
    return {
      cx: last.bbox.x + last.bbox.width / 2, cy: last.bbox.y + last.bbox.height / 2, h: last.bbox.height, vx: 0, vy: 0,
      bbox: last.bbox, nearbyBoxes: last.nearbyBoxes,
    };
  }

  // 정렬돼 있다고 가정하고 이분 탐색한다. 내보내기는 프레임마다 부른다.
  let lo = 0; let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].timestamp <= t) lo = mid; else hi = mid;
  }
  const a = points[lo]; const b = points[hi];
  const span = Math.max(1e-6, b.timestamp - a.timestamp);
  const k = Math.max(0, Math.min(1, (t - a.timestamp) / span));

  const ax = a.bbox.x + a.bbox.width / 2, ay = a.bbox.y + a.bbox.height / 2;
  const bx = b.bbox.x + b.bbox.width / 2, by = b.bbox.y + b.bbox.height / 2;
  return {
    cx: ax + (bx - ax) * k,
    cy: ay + (by - ay) * k,
    h: a.bbox.height + (b.bbox.height - a.bbox.height) * k,
    vx: (bx - ax) / span,
    vy: (by - ay) / span,
    bbox: a.bbox,
    nearbyBoxes: a.nearbyBoxes,
  };
}

export class FollowCamera {
  private readonly o: Required<FollowCameraOptions>;
  private cam: { x: number; y: number; crop: number } | null = null;
  private euro: OneEuroPoint;
  private holdAt: { x: number; y: number } | null = null;
  private holdUntil: number | null = null;
  private holdMap: Array<{ from: number; to: number }> = [];
  private release: { x: number; y: number; startedAt: number } | null = null;
  private windows: HighlightWindow[] = [];
  private climaxTimes: number[] = [];
  /** maxUpscale 을 호출부가 직접 줬나 — zoomFirst 에서 상한으로 쓸지 정한다(upscaleLimit). */
  private explicitUpscale = false;

  constructor(options: FollowCameraOptions) {
    this.o = {
      aspect: 'source',
      /* 대상이 출력 화면 높이에서 차지할 목표 비율.
       *
       * 0.62 로 뒀더니 사람만 꽉 차서 무슨 상황인지 안 보였다. 경기 영상은
       * 주변이 있어야 읽힌다 — 공이 어디 있고 누가 붙었는지.
       *
       * ME 를 고른 건 "누구를 따라갈지" 를 알려준 것이지 "얼마나 당겨서
       * 보여줄지" 를 정한 게 아니다. 그건 사용자가 고를 문제라서
       * 화면에 슬라이더로 노출한다. 여기 값은 그 기본값이다. */
      subjectShare: DEFAULT_SUBJECT_SHARE,
      minCropShare: 0.24,
      /* 기본 1.15배. 눈에 띄는 열화 없이 확대할 수 있는 선이다.
       * 더 크게 보고 싶으면 사용자가 올린다 — 대신 화질을 내준다. */
      maxUpscale: 1.15,
      /* 최대 크롭을 1.0 미만으로 둔다. 그래야 어떤 경우에도 화면이 대상을
       * 따라 움직인다. 1.0 이면 크롭이 원본 전체가 되어 카메라가 갈 곳이
       * 없고, 사용자 눈에는 추적이 아예 안 걸린 것으로 보인다. */
      maxCropShare: MAX_CROP_SHARE,
      follow: 0.12,
      lookAhead: 0.22,
      /* 달릴 때 앞을 비우는 상한. 0.05 면 정중앙에서 5% 밀린다(45%).
       * v1 의 0.125(35~40%)는 사람이 한쪽에 붙어 보였다 — 구도 v2 측정. */
      leadRoom: 0.05,
      /* 계획 경로가 사람에게서 벗어날 수 있는 가로 폭(크롭 너비 비율). v1 0.16. */
      centerTolerance: 0.08,
      edgePinIn: 0.05,
      edgePinOut: 0.08,
      edgeZoomTolerance: 0,
      /* 빠를 때 얼마나 풀 것인가. 0.15 면 전력 질주에서 크롭이 1.15배 넓어진다.
       * v1 은 0.35 였다. 구도 v2 의 줌 경로에서 0.35 는 이동 장면 인물을 0.41 까지 줄였고,
       * 전신 이탈은 plan() 의 전신 하한·위치 제약이 이미 막는다(실측: 0.15 와 0 모두 전신 포함률 같음). */
      speedZoom: 0.15,
      headAnchor: GOLDEN_Y_EYE,
      bodyCentreY: BODY_CENTRE_Y,
      zoomPersistSec: 0.3,
      zoomDeadband: 0.08,
      zoomInTau: 1.0,
      zoomOutTau: 0.4,
      zoomLeadSec: 0.3,
      eyeFromTop: 0.13,
      bottomSlack: 0.05,
      autoShot: true,
      headroom: 0.04,
      /* 기본은 예전 그대로다. 켜는 곳(편집 5단계·미리보기·내보내기)만
       * 화면 크기를 화질 하한보다 우선한다. */
      zoomFirst: false,
      ...options,
    } as Required<FollowCameraOptions>;
    this.explicitUpscale = typeof options.maxUpscale === 'number' && Number.isFinite(options.maxUpscale);
    if (options.stillShare == null) {
      this.o.stillShare = this.o.subjectShare * (DEFAULT_STILL_SHARE / DEFAULT_SUBJECT_SHARE);
    }

    /* 짐벌처럼 늦게 따라가게. minCutoff 를 더 낮추면 정지는 더 고요하고,
     * beta 를 낮추면 급출발에 카메라가 한 박자 뒤에 붙는다. */
    this.euro = new OneEuroPoint({ minCutoff: 0.55, beta: 0.012, dCutoff: 1.0 });
  }

  /** 미리보기·내보내기의 클립 구간. 앞뒤 미디엄 줌과 시작 연출의 기준이다. */
  setHighlightWindows(windows: readonly HighlightWindow[]) {
    this.windows = windows.filter((w) => w.end > w.start).map((w) => ({
      start: w.start, end: w.end,
    }));
  }

  /* --- 오프라인 카메라 경로 계획 -------------------------------------
   *
   * 지금까지 카메라 위치는 프레임마다 One Euro 로 필터링해서 정했다.
   * 그건 **실시간** 필터다. 미래를 모르는 상태에서 최선을 다하는 방식이라,
   * 흔들림을 줄이면 지연이 생기고 지연을 줄이면 흔들림이 남는다.
   *
   * 그런데 미리보기와 내보내기는 추적이 끝난 뒤에 돈다. 궤적 전체가
   * 이미 손에 있다. 실시간 필터를 쓸 이유가 없다.
   *
   * 그래서 경로를 한 번에 계획한다. 핵심은 **평활을 제약과 함께** 푸는
   * 것이다.
   *
   *   제약 없는 평활   대상을 놓칠까 무서워 약하게 걸어야 한다
   *   제약 있는 평활   "대상이 안전 영역 안" 만 지키면 얼마든 세게 걸어도 된다
   *
   * 프레임마다 카메라 중심이 있어도 되는 구간 [lo, hi] 를 먼저 구한다
   * (대상이 크롭 안전 영역에 들어오고 크롭이 화면을 벗어나지 않는 범위).
   * 그 다음 "세게 평활 -> 구간으로 되돌리기" 를 번갈아 반복한다.
   *
   * 수렴 결과는 제약이 느슨한 곳에서는 거의 직선이고, 제약이 팽팽한
   * 곳에서만 그 경계를 따라 움직인다. 실제 촬영자가 하는 것과 같다 —
   * 대상이 프레임 안에 있으면 카메라를 가만히 두고, 나가려 할 때만 민다.
   *
   * Grundmann et al. (2011) 의 L1 최적 경로가 같은 문제를 선형계획법으로
   * 푼다. 거기서도 결과는 정지·등속·등가속 구간의 조합이다. 여기서는
   * 교대 투영으로 근사했다 — O(n) 이고 의존성이 없다.
   * https://research.google/pubs/auto-directed-video-stabilization-with-robust-l1-optimal-camera-paths/
   */
  private path: {
    times: number[]; x: number[]; y: number[]; cropH: number[];
  } | null = null;

  /** 계획한 경로가 대상을 안전 영역 안에 담은 비율. 0~1. 진단용이다. */
  planInsideRate = 0;
  /** Actual output constraints; source-edge conflicts are counted, not hidden. */
  planClippedFrames = 0;
  planCenterErrorP95 = 0;
  /** 놓친 구간이라 마지막 자리를 붙잡은 점 수. */
  planHeldPoints = 0;
  /** 계획이 실제로 낸 구도 — 화면의 「인물 약 N% · 배율」 표시가 이 값을 쓴다. 계획이 없으면 null. */
  planStats: PlanStats | null = null;

  /**
   * 궤적 전체로 카메라 경로를 미리 계산한다.
   * 부르면 frameAt 이 실시간 필터 대신 이 경로를 쓴다.
   */
  plan(points: TrackingPoint[], {
    /* 대상이 크롭 경계에서 이만큼(크롭 크기 비율) 안쪽에 있어야 한다.
     * 여백이 곧 평활에 쓸 수 있는 자유도다. 0.10 이면 좌우 각각 10%. */
    safeMargin = 0.10,
    /* 평활 계수. 낮을수록 세게 걸린다. 제약이 대상을 지켜주므로
     * 실시간 필터보다 훨씬 낮게 잡을 수 있다. v1 0.08 — 구도 v2 는 되당김(fidelity)과 함께 0.2
     * (실영상 24편: 가로 오차 P95 0.16→0.055, 카메라 저크 약 1.8배). */
    alpha = 0.2,
    /* 교대 투영 횟수. 20 회면 실측에서 충분히 수렴했다. */
    iterations = 24,
    /* 최종 경로를 겨누는 자리로 되당기는 비율(반복마다). 0 이면 v1 과 같다. */
    fidelity = 0.3,
    /* 직캠 구도(2026-10-28, 실사 22편 궤적으로 고름 — 연구 저장소 2026-10-28 기록).
     *   deadZone        겨누는 자리를 크롭 너비의 이 비율 안 흔들림만큼은 붙잡는다(세로는 1.5배).
     *                   제자리 안무·몸 흔들림에 카메라가 따라 출렁이지 않게. 0 이면 끈다.
     *   settleSec       마지막에 시간 기준 가우시안(σ 초)으로 펴고 안전 구간으로 되돌린다. 0 이면 끈다.
     *                   0.25 는 클립 끝 숏 전환 근처에서 달리는 사람을 뒤따라가 앞 비움을 깨서 0.2 로 뒀다.
     *   tetherMedianSec 가운데 묶음(centerTolerance)의 기준을 상자 가운데의 이 길이 중앙값으로 —
     *                   팔을 뻗고 접을 때 상자 가운데가 출렁이는 것을 몸의 자리로 바꾼다. 0 이면 끈다.
     * 셋을 모두 0 으로 두면 2026-10-27 까지의 경로와 같다(보간만 3차 곡선). */
    deadZone = 0.04,
    settleSec = 0.2,
    tetherMedianSec = 0.4,
  } = {}): boolean {
    const { sourceWidth: sw, sourceHeight: sh } = this.o;
    if (points.length < 3) { this.clearPlan(); return false; }

    const raw = points.slice().sort((a, b) => a.timestamp - b.timestamp);
    const n = raw.length;
    /* 🔴 놓친 점의 상자를 따라가지 않는다(구도 v2).
     *
     * TARGET_LOST·REACQUIRING 의 상자는 대상이 아니다 — 추적기가 옮겨 간 다른 사람이거나,
     * 빈 상자(폭 0, 화면 구석 0,0)다. v1 은 그 상자로 크롭을 옮겨 카메라가 다른 사람에게
     * 가거나 구석·가운데로 튀었다. 여기서는 마지막으로 믿은 상자를 붙잡고(앞에 없으면 다음 것)
     * 1.2초에 걸쳐 LOST_HOLD_WIDEN 배까지 넓힌다. 다시 찾은 자리가 멀면 그 순간에 끊는다(컷). */
    /* 의심으로 놓침에 내렸어도 추적기가 실제로 잰 상자(doubtFollow)는 따라간다(2026-09-28) — 확인 안 된 의심이
     * 영상 끝까지 이어지면 카메라가 그 뒤 내내 멈춰 「상자는 맞는데 재생하면 안 따라간다」가 됐다. */
    const reliable = raw.map((p) => (p.state !== 'TARGET_LOST' && p.state !== 'REACQUIRING' || p.doubtFollow === true)
      && !p.cameraHold && p.bbox.width > 0.002 && p.bbox.height > 0.002);
    /* 놓치기 직전의 경고·가림 상자도 믿지 않는다(0.6초까지). 실측(빙상장 0155, 6.75~7.0초):
     * 놓치기 전 세 점이 경고 → 가림 → 경고로 한 번에 12px 씩 밀려났고 정답은 제자리였다.
     * 그 상자를 붙잡으면 카메라가 밀려난 쪽에 멈춘다. 마지막 정상(TRACKING_OK) 상자를 붙잡는다. */
    for (let i = 1; i < n; i += 1) {
      if (reliable[i] || !reliable[i - 1]) continue;
      for (let j = i - 1; j >= 0 && reliable[j] && raw[j].state !== 'TRACKING_OK'
        && raw[i].timestamp - raw[j].timestamp <= 0.6; j -= 1) reliable[j] = false;
    }
    if (!reliable.some(Boolean)) { this.clearPlan(); return false; }
    const holdWiden = raw.map(() => 1);
    const sorted = raw.slice();
    {
      let last = -1;
      for (let i = 0; i < n; i += 1) {
        if (reliable[i]) { last = i; continue; }
        let src = last;
        if (src < 0) { src = i + 1; while (src < n && !reliable[src]) src += 1; }
        sorted[i] = { ...raw[i], bbox: { ...raw[src].bbox }, nearbyBoxes: undefined };
        const since = last >= 0 ? raw[i].timestamp - raw[last].timestamp : 0;
        holdWiden[i] = 1 + (LOST_HOLD_WIDEN - 1) * smoothstep(0, 1.2, since);
      }
    }
    this.planHeldPoints = reliable.filter((r) => !r).length;
    const times = sorted.map((p) => p.timestamp);
    const cropW: number[] = [], cropH: number[] = [];
    const loX: number[] = [], hiX: number[] = [], loY: number[] = [], hiY: number[] = [];
    const wantX: number[] = [], wantY: number[] = [];
    const samples: Sample[] = [];
    const speeds: number[] = [];

    for (let i = 0; i < n; i += 1) {
      const b = sorted[i].bbox;

      /* 그 시각의 속도. 앞뒤 점으로 잰다 — 궤적 전체가 손에 있으므로
       * 실시간 필터처럼 뒤만 볼 이유가 없다. 양쪽을 쓰면 잡음이 절반이다. */
      const prev = sorted[Math.max(0, i - 1)];
      const next = sorted[Math.min(n - 1, i + 1)];
      const span = Math.max(1e-3, next.timestamp - prev.timestamp);
      const sample: Sample = {
        cx: b.x + b.width / 2,
        cy: b.y + b.height / 2,
        h: b.height,
        vx: ((next.bbox.x + next.bbox.width / 2) - (prev.bbox.x + prev.bbox.width / 2)) / span,
        vy: ((next.bbox.y + next.bbox.height / 2) - (prev.bbox.y + prev.bbox.height / 2)) / span,
        bbox: b,
        nearbyBoxes: sorted[i].nearbyBoxes,
      };
      samples.push(sample);
      speeds.push(this.speedOf(sample));
    }
    /* 속도도 0.3초 중앙값으로 — 한 프레임 상자 튐이 앞뒤 점의 속도를 키워 숏(미디엄↔전신)과
     * speedZoom 을 흔들면 그것만으로 줌이 출렁인다(구도 v2 회귀 시험). */
    {
      const half = Math.max(0, this.o.zoomPersistSec) / 2;
      const rawSpeeds = speeds.slice();
      for (let i = 0; i < n; i += 1) {
        const win: number[] = [];
        for (let j = i; j >= 0 && times[i] - times[j] <= half + 1e-9; j -= 1) win.push(rawSpeeds[j]);
        for (let j = i + 1; j < n && times[j] - times[i] <= half + 1e-9; j += 1) win.push(rawSpeeds[j]);
        win.sort((a, b) => a - b);
        speeds[i] = win[win.length >> 1];
      }
    }
    this.markClimax(times, speeds);

    for (let i = 0; i < n; i += 1) {
      const b = sorted[i].bbox;
      const sample = samples[i];
      const size = this.edgeZoom(this.cropSizeFor(
        b.height, speeds[i], holdWiden[i], this.shotKind(speeds[i], times[i]),
      ), sample.cx * sw);
      cropW.push(size.cropW); cropH.push(size.cropH);

      const x0 = b.x * sw, x1 = (b.x + b.width) * sw;
      const y0 = b.y * sh, y1 = (b.y + b.height) * sh;
      /* 노리는 자리는 frameAt 과 같은 식으로 구한다. 다르면 미리보기와
       * 저장된 영상의 구도가 갈라진다. */
      const aim = this.aimFor(sample, size.cropW, size.cropH);
      wantX.push(aim.x); wantY.push(aim.y);

      /* 대상이 안전 영역에 들어오려면 카메라 중심이 이 안에 있어야 한다.
       *   중심 - 여유 <= 대상왼쪽   그리고   대상오른쪽 <= 중심 + 여유 */
      const freeX = size.cropW * (0.5 - safeMargin);
      const freeY = size.cropH * (0.5 - safeMargin);
      let lx = x1 - freeX, hx = x0 + freeX;
      let ly = y1 - freeY, hy = y0 + freeY;
      // 대상이 안전 영역보다 크면 중심을 맞추는 것 말고 할 수 있는 게 없다.
      if (lx > hx) { const m = (x0 + x1) / 2; lx = m; hx = m; }
      if (ly > hy) { const m = (y0 + y1) / 2; ly = m; hy = m; }

      // 크롭이 화면을 벗어나면 안 된다. 이쪽이 더 강한 제약이다.
      const fLoX = size.cropW / 2, fHiX = sw - size.cropW / 2;
      const fLoY = size.cropH / 2, fHiY = sh - size.cropH / 2;
      lx = Math.max(lx, fLoX); hx = Math.min(hx, fHiX);
      ly = Math.max(ly, fLoY); hy = Math.min(hy, fHiY);
      // 화면 제약과 대상 제약이 부딪히면 화면 제약이 이긴다 — 검은 여백은 낼 수 없다.
      if (lx > hx) { const m = Math.max(fLoX, Math.min(fHiX, (x0 + x1) / 2)); lx = m; hx = m; }
      if (ly > hy) { const m = Math.max(fLoY, Math.min(fHiY, (y0 + y1) / 2)); ly = m; hy = m; }

      loX.push(lx); hiX.push(hx); loY.push(ly); hiY.push(hy);
    }

    /* 평활을 끊는 자리 — 붙잡고 있던 자리에서 다시 찾은 자리가 멀 때(컷).
     * 가까우면 이어서 부드럽게 옮긴다. 붙잡는 동안에는 끊지 않는다 — 자리가 그대로라 튈 것이 없다. */
    /* 장면(클립 구간)이 바뀌는 첫 점 — 앞 장면의 위치·줌이 다음 장면으로 흘러가지 않게 끊는다. */
    const resets = times.map((t, i) => i > 0 && this.windows.some((w) => times[i - 1] < w.start - 1e-6 && t >= w.start - 1e-6));
    const broken = sorted.map((p, i) => {
      if (resets[i]) return true;
      if (i === 0 || !reliable[i] || reliable[i - 1]) return false;
      const a = sorted[i - 1].bbox, b = p.bbox;
      const d = Math.hypot((a.x + a.width / 2) - (b.x + b.width / 2), (a.y + a.height / 2) - (b.y + b.height / 2));
      return d > Math.max(0.04, 0.6 * Math.max(a.height, b.height));
    });
    const clampInto = (v: number[], lo: number[], hi: number[]) => {
      for (let i = 0; i < v.length; i += 1) {
        if (v[i] < lo[i]) v[i] = lo[i];
        else if (v[i] > hi[i]) v[i] = hi[i];
      }
    };
    const smooth = (v: number[], a: number) => {
      // 정방향·역방향 각각 한 번. 위상 지연이 상쇄되어 제자리에 남는다.
      // 놓친 구간은 옆 사람과 잇지 않는다.
      const f = v.slice();
      for (let i = 1; i < f.length; i += 1) {
        if (broken[i]) continue;
        f[i] = f[i - 1] + a * (f[i] - f[i - 1]);
      }
      for (let i = f.length - 2; i >= 0; i -= 1) {
        if (broken[i + 1]) continue;
        f[i] = f[i + 1] + a * (f[i] - f[i + 1]);
      }
      return f;
    };

    let px = wantX.slice(), py = wantY.slice();
    clampInto(px, loX, hiX); clampInto(py, loY, hiY);
    for (let k = 0; k < iterations; k += 1) {
      px = smooth(px, alpha); clampInto(px, loX, hiX);
      py = smooth(py, alpha); clampInto(py, loY, hiY);
    }
    // Plan zoom before projecting position. The old position bounds used the
    // unsmoothed size, so a later zoom-in silently cut off heads and feet.
    const ratio = this.ratio(), maxH = Math.min(sh, sw / ratio);
    const margin = Math.max(0, Math.min(0.3, safeMargin));
    const top = Math.max(margin, 0.10);
    const bottom = Math.max(margin, this.o.bottomSlack);
    const floor = sorted.map((p) => Math.min(maxH, Math.max(
      p.bbox.height * sh / (1 - top - bottom),
      p.bbox.width * sw / (ratio * (1 - 2 * margin)),
    )));
    /* 줌 경로(구도 v2). v1 은 크롭 높이를 두 번 평활한 뒤 앞뒤로 초당 exp(-0.45) 봉투를 씌웠다 —
     * 줌인이 약 2.2초 시간상수로 느렸고, 줌아웃은 몇 초 앞부터 미리 풀렸다. 여기서는
     *   목표(= 원본 속 인물 높이 ÷ 목표 비율) → 0.3초 중앙값(순간 흔들림 무시) → 믿기 어려운 순간은 줌인 보류
     *   → 데드밴드 → 비대칭 반응(줌인 느리게·줌아웃 빠르게) → 줌아웃 0.3초 앞서 보기 → 전신 하한
     * 으로 간다. 모두 초 단위라 분석 프레임률과 무관하다. 장면(클립 구간) 경계에서는 줌 상태를 새로 시작한다. */
    const lowTrust = sorted.map((p, i) => !reliable[i] || p.state === 'OCCLUDED' || p.state === 'TRACKING_WARNING'
      || raw[i].doubtFollow === true);
    const pc = planZoomPath(times, cropH, floor, lowTrust, broken, {
      persistSec: this.o.zoomPersistSec, deadband: this.o.zoomDeadband,
      zoomInTau: this.o.zoomInTau, zoomOutTau: this.o.zoomOutTau, leadSec: this.o.zoomLeadSec,
      aspects: sorted.map((p) => p.bbox.height / Math.max(1e-4, p.bbox.width)),
    }).map((v) => Math.min(maxH, v));
    const bodyX = steadyCentreX(times, sorted.map((p) => p.bbox.x + p.bbox.width / 2), broken, tetherMedianSec);
    for (let i = 0; i < n; i++) {
      const b = sorted[i].bbox, h = pc[i], w = h * ratio;
      const cx = bodyX[i] * sw, cy = (b.y + b.height / 2) * sh;
      const tether = Math.max(this.o.leadRoom, this.o.centerTolerance) * w;
      let lx = Math.max((b.x + b.width) * sw - w * (0.5 - margin), cx - tether, w / 2);
      let hx = Math.min(b.x * sw + w * (0.5 - margin), cx + tether, sw - w / 2);
      let ly = Math.max((b.y + b.height) * sh - h * (0.5 - bottom), h / 2);
      let hy = Math.min(b.y * sh + h * (0.5 - top), sh - h / 2);
      if (lx > hx) lx = hx = Math.max(w / 2, Math.min(sw - w / 2, cx));
      if (ly > hy) ly = hy = Math.max(h / 2, Math.min(sh - h / 2, cy));
      loX[i] = lx; hiX[i] = hx; loY[i] = ly; hiY[i] = hy;
    }
    /* 겨누는 자리를 최종 크롭 크기로 다시 구하고, 평활할 때마다 그쪽으로 조금 되당긴다(fidelity).
     * 되당김이 없으면 평활이 직선만 좋아해서, 화면을 가로지르는 사람에게 카메라가 늘 가로 폭
     * 제약(centerTolerance)의 끝까지 뒤처졌다 — 실측 가로 오차 P95 가 제약값 0.08 에 붙어 있었다(구도 v2). */
    const aimX: number[] = [], aimY: number[] = [];
    for (let i = 0; i < n; i += 1) {
      const a = this.aimFor(samples[i], pc[i] * ratio, pc[i]);
      aimX.push(a.x); aimY.push(a.y);
    }
    edgePin(aimX, pc.map((h) => h * ratio), sw, broken, this.o.edgePinIn, this.o.edgePinOut);
    /* 직캠 데드존 — 겨누는 자리를 제자리 흔들림만큼은 붙잡아 둔다(holdAim). */
    /* 달리는 사람에게는 데드존을 걸지 않는다 — 걸면 카메라가 그 폭만큼 뒤처져 앞 비움(리드룸)이
     * 사라진다(시험 「앞을 조금만 비운다」). 움직임 판정은 aimFor 와 같은 식(몸 0.22~1.05개/초)이다. */
    const dz = Math.max(0, deadZone);
    const still = speeds.map((s) => 1 - smoothstep(0.22, 1.05, s));
    const heldX = dz > 0 ? holdAim(aimX, pc.map((h, i) => h * ratio * dz * still[i]), broken) : aimX;
    const heldY = dz > 0 ? holdAim(aimY, pc.map((h, i) => h * dz * 1.5 * still[i]), broken) : aimY;
    const pull = (v: number[], a: number[]) => v.map((x, i) => x + fidelity * (a[i] - x));
    for (let k = 0; k < iterations; k++) {
      px = pull(smooth(px, alpha), heldX); clampInto(px, loX, hiX);
      py = pull(smooth(py, alpha), heldY); clampInto(py, loY, hiY);
    }
    /* 시간 기준 마무리 다듬기 — 가우시안(σ = settleSec)으로 펴고 안전 구간으로 되돌리기를 반복한다.
     * 위 평활은 점마다 같은 비율이라 분석 프레임률이 바뀌면 세기가 바뀌고, 되당김이 겨누는 자리의
     * 잔떨림을 그대로 살린다. 직캠·무대 카메라는 등속 팬과 부드러운 가감속만 보인다. */
    if (settleSec > 0) {
      for (let k = 0; k < 6; k += 1) {
        px = gaussianInTime(times, px, broken, settleSec); clampInto(px, loX, hiX);
        py = gaussianInTime(times, py, broken, settleSec); clampInto(py, loY, hiY);
      }
    }

    let inside = 0, clipped = 0;
    const centerErrors: number[] = [];
    const shares: number[] = [], ups: number[] = [];
    const outH = this.outputSize().height;
    let effMin = Infinity, counted = 0;
    for (let i = 0; i < n; i += 1) {
      /* 붙잡은 점은 대상 상자가 아니다 — 구도 수치에 넣지 않는다. */
      if (!reliable[i]) continue;
      counted += 1;
      const b = sorted[i].bbox, h = pc[i], w = h * ratio;
      shares.push(b.height * sh / h);
      ups.push(outH / h);
      effMin = Math.min(effMin, Math.min(h, outH));
      const left = b.x * sw - (px[i] - w / 2), right = px[i] + w / 2 - (b.x + b.width) * sw;
      const above = b.y * sh - (py[i] - h / 2), below = py[i] + h / 2 - (b.y + b.height) * sh;
      if (left >= margin * w - 0.5 && right >= margin * w - 0.5
          && above >= top * h - 0.5 && below >= bottom * h - 0.5) inside++;
      if (Math.min(left, right, above, below) < -0.5) clipped++;
      centerErrors.push(Math.abs((b.x + b.width / 2) * sw - px[i]) / w);
    }
    this.planInsideRate = counted ? inside / counted : 0;
    this.planClippedFrames = clipped;
    centerErrors.sort((a, b) => a - b);
    this.planCenterErrorP95 = centerErrors[Math.min(centerErrors.length - 1, Math.floor(centerErrors.length * 0.95))] ?? 0;
    const at = (v: number[], p: number) => { const s = v.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))] ?? 0; };
    this.planStats = {
      subjectShareMedian: at(shares, 0.5), subjectShareP10: at(shares, 0.1),
      upscaleMedian: at(ups, 0.5), upscaleMax: ups.length ? Math.max(...ups) : 0,
      effectiveHeightMin: Number.isFinite(effMin) ? Math.round(effMin) : 0,
      heldPoints: this.planHeldPoints,
    };
    this.path = { times, x: px, y: py, cropH: pc };
    return true;
  }

  /** 계획한 경로에서 그 시각의 크롭을 뽑는다. 계획이 없으면 null. */
  private sampleplan(t: number): CropRect | null {
    const path = this.path;
    if (!path) return null;
    const { sourceWidth: sw, sourceHeight: sh } = this.o;
    const ratio = this.ratio();
    const { times } = path;

    let lo = 0, hi = times.length - 1;
    if (t <= times[0]) { lo = 0; hi = 0; }
    else if (t >= times[hi]) { lo = hi; }
    else {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= t) lo = mid; else hi = mid;
      }
    }
    /* 점 사이는 단조 3차 곡선(PCHIP)으로 잇는다(2026-10-28). 계획 점은 분석 프레임률(약 10fps)이라
     * 직선으로 이으면 0.1초마다 카메라 속도가 꺾여, 30fps 저장본에서 팬이 「툭툭」 끊겨 보였다.
     * 단조 곡선은 점을 그대로 지나고 이웃 두 점 사이를 넘어가지 않는다 — 계획이 지킨 안전 구간을
     * 보간이 깨지 않는다. */
    const cx = pchipAt(times, path.x, lo, hi, t);
    const cy = pchipAt(times, path.y, lo, hi, t);
    const ch = pchipAt(times, path.cropH, lo, hi, t);

    const outH = Math.max(16, Math.min(sh, ch));
    const outW = Math.min(sw, outH * ratio);
    return {
      sx: Math.max(0, Math.min(sw - outW, cx - outW / 2)),
      sy: Math.max(0, Math.min(sh - outH, cy - outH / 2)),
      sw: outW, sh: outH,
    };
  }

  /** 계획을 버린다. 궤적이 바뀌면 반드시 불러야 한다. */
  clearPlan() {
    this.path = null; this.planInsideRate = 0; this.planClippedFrames = 0; this.planCenterErrorP95 = 0;
    this.planHeldPoints = 0; this.planStats = null;
  }

  /** 카메라가 멈춰 있어야 할 구간을 알려준다 (trajectory.holdSegments 결과). */
  setHoldSegments(points: TrackingPoint[], hold: boolean[]) {
    this.holdMap = [];
    let i = 0;
    while (i < hold.length) {
      if (!hold[i]) { i++; continue; }
      let j = i;
      while (j < hold.length && hold[j]) j++;
      this.holdMap.push({ from: points[i].timestamp, to: points[j - 1].timestamp });
      i = j;
    }
  }

  /**
   * 지금 설정으로 나올 실질 해상도와 배율.
   *
   * 화면에 그대로 보여준다 — 사용자가 교환 관계를 눈으로 봐야 한다.
   *
   * @param subjectHeight 대상이 원본 높이에서 차지하는 비율. 주면 **실제로
   *   잘리는 크기**로 계산한다(zoomFirst 를 켠 화면이 이걸 쓴다). 안 주면
   *   대상과 무관한 상한만 계산한다 — 예전 동작 그대로다.
   */
  quality(subjectHeight?: number | null): {
    sourceHeight: number; outputHeight: number; upscale: number;
  } {
    const out = this.outputSize();
    /* frameAt() 과 같은 식이어야 한다. 다르면 화면의 숫자가 거짓이 된다.
     *
     * 대상 크기를 받았으면 cropSizeFor 를 그대로 쓴다 — 식이 한 곳에만
     * 있어야 두 값이 갈라지지 않는다. */
    const cropH = subjectHeight != null
      ? this.cropSizeFor(
          subjectHeight, 0, 1, this.shotKind(0, 0),
        ).cropH
      : Math.min(
          out.height / Math.max(1, this.upscaleLimit()),
          /* 🔴 원본 높이 × maxCropShare 가 아니라 **실제로 자를 높이**와 견준다.
           *
           * 대상 크기를 모를 때도 「화면 크기」가 크롭을 좁힌다(cropSizeFor).
           * 여기서 그 사실을 빼면 화면에 적힌 해상도가 실제 크롭과 어긋난다 —
           * 이 파일이 줄곧 지켜 온 약속(숫자가 거짓이 되면 안 된다)이다. */
          this.cropSizeFor(null).cropH,
        );
    /* 배율도 반올림한 높이로 낸다.
     * 안 그러면 "886p · 1.45배" 처럼 두 숫자가 서로 안 맞는다.
     * 화면에 나란히 적히는 값이라 같은 기준이어야 한다. */
    const shown = Math.round(cropH);
    return {
      sourceHeight: shown,
      outputHeight: out.height,
      upscale: +(out.height / Math.max(1, shown)).toFixed(2),
    };
  }

  /** 되감기·구간 이동 후에는 반드시 부른다. 안 부르면 카메라가 천천히 흘러간다. */
  reset() {
    this.cam = null;
    this.euro.reset();
    this.holdAt = null;
    this.holdUntil = null;
    this.release = null;
  }

  /** 출력 캔버스 크기. 원본 비율은 유지하고 긴 변을 1280 으로 맞춘다. */
  outputSize(): { width: number; height: number } {
    const { sourceWidth: sw, sourceHeight: sh, aspect } = this.o;
    if (aspect === 'portrait') return { width: 720, height: 1280 };
    if (aspect === 'landscape') return { width: 1280, height: 720 };
    const scale = Math.min(1, 1280 / Math.max(sw, sh));
    const even = (v: number) => Math.max(2, Math.round(v / 2) * 2);
    return { width: even(sw * scale), height: even(sh * scale) };
  }

  private ratio(): number {
    const { sourceWidth: sw, sourceHeight: sh, aspect } = this.o;
    if (aspect === 'portrait') return 9 / 16;
    if (aspect === 'landscape') return 16 / 9;
    return sw / sh;
  }

  /* 대상 크기에 맞춘 크롭 크기.
   *
   * frameAt 과 오프라인 경로 계획(plan)이 **같은 식**을 써야 한다.
   * 달라지면 화면에 적힌 해상도가 거짓이 되고, 계획한 경로와 실제로
   * 잘리는 영역이 어긋난다. 그래서 한 곳으로 뽑아 둔다. */
  private occlusionWiden(
    subject: { x: number; y: number; width: number; height: number } | null,
    others?: readonly { x: number; y: number; width: number; height: number }[],
  ): number {
    if (!subject || !others?.length) return 1;
    let best = 0;
    for (const other of others) {
      const x1 = Math.max(subject.x, other.x);
      const y1 = Math.max(subject.y, other.y);
      const x2 = Math.min(subject.x + subject.width, other.x + other.width);
      const y2 = Math.min(subject.y + subject.height, other.y + other.height);
      const w = x2 - x1;
      const h = y2 - y1;
      if (w <= 0 || h <= 0) continue;
      const inter = w * h;
      const union = subject.width * subject.height + other.width * other.height - inter;
      const iou = union <= 0 ? 0 : inter / union;
      if (iou > best) best = iou;
    }
    if (best <= 0.22) return 1;
    const t = Math.min(1, (best - 0.22) / 0.45);
    return 1 + 0.32 * t;
  }

  /**
   * 실제로 허용하는 최대 확대 배율.
   *
   * 🔴 v1 은 zoomFirst 면 maxUpscale 을 버리고 늘 HARD_MAX_UPSCALE(2.6)을 썼다. 그래서 편집 화면의
   *    「확대 한계」 슬라이더(maxUpscale)는 크롭에 아무 일도 하지 않았다 — 조절값과 실제 제한이
   *    서로 다른 뜻이었다(구도 v2 점검). 이제 zoomFirst 에서도 **넘겨준 maxUpscale 을 상한으로** 쓰고,
   *    바닥(HARD_MAX_UPSCALE)만 남긴다. 값을 넘기지 않은 zoomFirst 호출부는 예전처럼 바닥을 쓴다.
   */
  private upscaleLimit(): number {
    if (!this.o.zoomFirst) return this.o.maxUpscale;
    if (!this.explicitUpscale) return HARD_MAX_UPSCALE;
    return Math.max(1, Math.min(HARD_MAX_UPSCALE, this.o.maxUpscale));
  }

  private cropSizeFor(
    subjectHeight: number | null, speedBodies = 0, extraWiden = 1,
    shot: ShotKind = 'full',
  ): { cropW: number; cropH: number } {
    const { sourceWidth: sw, sourceHeight: sh } = this.o;
    const ratio = this.ratio();

    /* 확대율을 대상 크기에 맞춘다.
     * 사람이 화면 높이의 20% 로 찍혔고 목표가 45% 라면 크롭 높이를
     * 20/45 = 0.44 배로 줄여야 한다. 고정 배율을 쓰면 멀리 있는 사람은
     * 계속 점으로 남는다. */
    /* 🔴 대상 크기를 모를 때도 「화면 크기」는 들어야 한다.
     *
     * 예전에는 여기서 그냥 maxCropShare 로 두고 끝냈다. 그래서 추적이
     * 대상 높이를 내주지 못한 영상(추적을 건너뛴 편집, 궤적이 비거나
     * 상자 높이가 0 인 경우)에서는 슬라이더를 끝까지 밀어도 화면이 한
     * 픽셀도 바뀌지 않았다 — 실제로 "조절해도 위 화면에 아무 반영이
     * 안 된다" 는 말을 들었다.
     *
     * 대상이 없으면 화면 가운데를 그만큼 잘라 준다. 기본값(0.42)에서는
     * 예전과 **똑같은 크롭**이 나오게 맞춰서, 쓰던 화면이 바뀌지 않는다.
     * 당길수록 좁게 자르고, 넓히는 쪽은 원본 전체가 한계다. */
    let cropShare = subjectHeight === null || subjectHeight <= 1e-4
      ? this.o.maxCropShare * (DEFAULT_SUBJECT_SHARE / Math.max(1e-3, this.o.subjectShare))
      : this.o.maxCropShare;
    if (subjectHeight !== null && subjectHeight > 1e-4) {
      /* 빠르게 움직이면 조금 푼다.
       *
       * 속도는 **자기 몸 몇 개**로 잰다. 화면 비율로 재면 멀리 있는
       * 작은 사람은 아무리 뛰어도 느린 것으로 나오고, 가까운 사람은
       * 걷기만 해도 빠른 것으로 나온다. 몸 기준이면 둘이 같은 자로
       * 재진다 — HilitMotion 의 속도 상한도 같은 이유로 몸 기준이다.
       *
       * 기준 속도는 초당 몸 2개다. 그쯤이면 달리는 것이고, 거기서
       * 상한(speedZoom)에 닿는다. */
      const fast = Math.min(1, Math.max(0, speedBodies) / 2);
      const widen = 1 + Math.max(0, this.o.speedZoom) * fast;
      /* 미디엄(정지·클립 앞뒤)은 stillShare, 전신(플레이 중)은 subjectShare 를 목표로 한다.
       * 추적 상자를 자르지는 않는다 — plan() 의 여유 하한이 머리·발을 크롭 안에 둔다.
       * v1 은 미디엄 배율 0.82 를 곱했다(= subjectShare / 0.82). */
      const target = shot === 'medium' ? this.o.stillShare : this.o.subjectShare;
      cropShare = (subjectHeight / Math.max(1e-3, target)) * widen * Math.max(1, extraWiden);
    }
    cropShare = Math.max(this.o.minCropShare, Math.min(this.o.maxCropShare, cropShare));

    let cropH = sh * cropShare;

    /* 화질 하한.
     *
     * 잘라낸 높이가 출력 높이보다 작으면 그만큼 늘려야 한다. 그게 곧
     * 화질 손실이다. 허용 배율을 넘지 않도록 crop 을 다시 키운다.
     *
     * 이 한 줄이 "확대했더니 360p 가 됐다" 를 막는다. 대신 멀리 있는
     * 사람은 덜 커진다 — 그 교환을 사용자가 슬라이더로 정한다. */
    const out = this.outputSize();
    /* 단, 이 하한이 카메라의 이동 여유를 먹으면 안 된다.
     *
     * maxCropShare 는 "크롭이 원본의 이만큼을 넘지 않는다" 는 약속이고,
     * 그 남는 여백이 곧 카메라가 움직일 수 있는 거리다. 화질 하한을
     * 상한 없이 적용하면 이 약속을 덮어쓴다.
     *
     * 실제로 그랬다 — 1080p 세로 출력에서
     *   minCropH = 1280 / 1.15 = 1113 > 원본 높이 1080
     *   -> 크롭이 원본 전체 높이로 고정 -> 세로로 전혀 못 움직인다
     * 1080p 는 가장 흔한 입력이다.
     *
     * 둘이 부딪히면 추종이 이긴다. 화질 손실은 화면에 숫자로 알려줄 수
     * 있지만, 따라가지 않는 팔로우캠은 기능이 없는 것이다. */
    const room = sh * this.o.maxCropShare;
    /* zoomFirst 면 화질 하한을 사용자 뜻 아래에 둔다.
     *
     * 안 그러면 흔한 조합에서 하한이 가능한 범위 전체를 삼켜 화면 크기
     * 슬라이더가 아무 일도 하지 않는다(옵션 주석에 실측을 적어 뒀다).
     * 바닥은 남긴다 — 무한히 당기면 화소 몇 개를 화면 가득 늘리게 된다. */
    const limit = this.upscaleLimit();
    const minCropH = Math.min(out.height / Math.max(1, limit), room);
    if (cropH < minCropH) cropH = minCropH;

    let cropW = cropH * ratio;
    if (cropW > sw) { cropW = sw; cropH = cropW / ratio; }
    if (cropH > sh) { cropH = sh; cropW = cropH * ratio; }
    return { cropW, cropH };
  }

  /** 가장자리 확대(edgeZoomTolerance, 기본 꺼짐) — 사람 중심 cx(원본 px)가 원본 끝에 가까우면 크롭을 줄인다.
   *  화질 하한(cropSizeFor 의 minCropH)보다 좁히지 않는다. 전신 하한은 plan() 의 줌 경로가 지킨다. */
  private edgeZoom(size: { cropW: number; cropH: number }, cx: number): { cropW: number; cropH: number } {
    const tol = this.o.edgeZoomTolerance ?? 0;
    if (!(tol > 0 && tol < 0.5)) return size;
    const { sourceWidth: sw, sourceHeight: sh } = this.o;
    const ratio = this.ratio();
    const capW = Math.max(0, Math.min(cx, sw - cx)) / (0.5 - tol);
    if (capW >= size.cropW) return size;
    const minCropH = Math.min(this.outputSize().height / Math.max(1, this.upscaleLimit()), sh * this.o.maxCropShare);
    const cropH = Math.max(minCropH, capW / ratio);
    if (cropH >= size.cropH) return size;
    return { cropW: cropH * ratio, cropH };
  }

  /**
   * 카메라가 노려야 할 자리 — 원본 픽셀.
   *
   * frameAt(실시간)과 plan(오프라인)이 **같은 식**을 써야 한다. 다르면
   * 미리보기와 저장된 영상의 구도가 달라진다.
   *
   *   1. 정지면 가로 50%. 달리면 진행 반대쪽 35~40%(리드룸)
   *   2. 눈/상체를 화면 상단 1/3 에 둔다(로우 앵글)
   *   3. 옆에 다른 상자가 가깝면 살짝 무게중심을 섞는다. 공은 아직 없다.
   */
  private aimFor(s: Sample, cropW: number, cropH: number): { x: number; y: number } {
    const { sourceWidth: sw, sourceHeight: sh } = this.o;
    const speed = this.speedOf(s);
    const moving = smoothstep(0.22, 1.05, speed);

    let cx = s.cx;
    const cy = s.cy;
    if (s.bbox && s.nearbyBoxes?.length && moving > 0.35) {
      const other = nearestOther(s.bbox, s.nearbyBoxes);
      if (other) {
        const ncx = other.x + other.width / 2;
        const ncy = other.y + other.height / 2;
        const dist = Math.hypot(ncx - s.cx, ncy - s.cy);
        if (dist > 0.04 && dist < 0.38) {
          /* 가로로만, 조금만 섞는다(구도 v2). v1 은 0.18 을 가로·세로 둘 다 섞어서 고른 사람이
           * 가운데에서 밀렸다 — 주인공은 고른 사람이다. */
          const mix = 0.06 * moving;
          cx = s.cx * (1 - mix) + ((s.cx + ncx) / 2) * mix;
        }
      }
    }

    const dir = Math.abs(s.vx) < 1e-5 ? 0 : (s.vx > 0 ? 1 : -1);
    const lead = Math.min(this.o.leadRoom, GOLDEN_X_STILL - GOLDEN_X_RUN) * moving;
    const frameX = GOLDEN_X_STILL - dir * lead;
    const x = cx * sw + (0.5 - frameX) * cropW;

    /* 몸의 세로 중심을 bodyCentreY 에 둔다(구도 v2). v1 은 눈을 headAnchor(위 1/3)에 고정해서
     * 사람이 크게 잡힐수록 몸이 아래로 내려가 발이 끝에 붙었다(대상 비율 0.8 이면 몸 중심 0.63).
     * 머리·발 여백은 plan() 의 하한이 따로 지킨다. */
    const y = cy * sh - (this.o.bodyCentreY - 0.5) * cropH;
    return { x, y };
  }

  /** 대상의 속도 — **자기 몸 몇 개**인가. 화면 비율로 재면 안 된다. */
  private speedOf(s: Sample): number {
    const size = Math.max(0.01, s.h);
    return Math.hypot(s.vx, s.vy) / size;
  }

  private clipPhase(t: number): 'open' | 'play' | 'close' | 'none' {
    const w = this.windows.find((win) => t >= win.start - 1e-3 && t <= win.end + 1e-3);
    if (!w) return this.windows.length ? 'none' : 'play';
    if (t - w.start < 1.15) return 'open';
    if (w.end - t < 0.85) return 'close';
    return 'play';
  }

  private markClimax(times: number[], speeds: number[]) {
    this.climaxTimes = [];
    for (let i = 2; i < speeds.length - 2; i += 1) {
      if (speeds[i] > 1.15
          && speeds[i] >= speeds[i - 1] && speeds[i] >= speeds[i + 1]
          && speeds[i] > speeds[i - 2] && speeds[i] > speeds[i + 2]) {
        this.climaxTimes.push(times[i]);
      }
    }
  }

  private shotKind(speedBodies: number, t: number): ShotKind {
    if (!this.o.autoShot) return 'full';
    const phase = this.clipPhase(t);
    if (phase === 'open' || phase === 'close') return 'medium';
    if (this.climaxTimes.some((c) => Math.abs(c - t) < 0.28)) return 'medium';
    if (speedBodies < 0.38) return 'medium';
    return 'full';
  }

  /**
   * 대상이 크롭 안에서 어디에 앉았는가. 0~1. 구도 시험용이다.
   * frameAt 을 부르므로 실시간 필터 상태가 앞으로 간다.
   */
  subjectInCrop(points: TrackingPoint[], t: number): { x: number; y: number; eyeY: number } | null {
    const r = this.frameAt(points, t);
    const s = sampleAt(points, t);
    if (!s) return null;
    const { sourceWidth: sw, sourceHeight: sh } = this.o;
    const cx = s.cx * sw;
    const eyeY = (s.cy - 0.5 * s.h + this.o.eyeFromTop * s.h) * sh;
    return {
      x: (cx - r.sx) / Math.max(1e-6, r.sw),
      y: (s.cy * sh - r.sy) / Math.max(1e-6, r.sh),
      eyeY: (eyeY - r.sy) / Math.max(1e-6, r.sh),
    };
  }

  /** 주어진 시각의 크롭 영역. 원본 픽셀 좌표다. */
  frameAt(points: TrackingPoint[], t: number): CropRect {
    const planned = this.sampleplan(t);
    if (planned) return planned;

    const { sourceWidth: sw, sourceHeight: sh } = this.o;
    const ratio = this.ratio();
    const s = sampleAt(points, t);
    const speed = s ? this.speedOf(s) : 0;
    const size = this.cropSizeFor(
      s ? s.h : null,
      speed,
      s ? this.occlusionWiden(s.bbox ?? null, s.nearbyBoxes) : 1,
      s ? this.shotKind(speed, t) : 'full',
    );
    let cropH = size.cropH;

    // 대상이 없으면 화면 중앙을 본다.
    const aim = s ? this.aimFor(s, size.cropW, size.cropH) : { x: 0.5 * sw, y: 0.5 * sh };
    const targetX = aim.x;
    const targetY = aim.y;

    // 고정 구간에 들어가면 그 시점의 위치를 붙잡아 둔다.
    const seg = this.holdMap.find((h) => t >= h.from && t <= h.to);
    if (seg) {
      if (this.holdUntil !== seg.to) {
        this.holdUntil = seg.to;
        this.holdAt = null;
        this.release = null;
      }
    } else {
      // The filter keeps advancing during a hold. Jumping straight to that
      // hidden value at the boundary creates a visible camera snap, so leave
      // the hold with a zero-velocity/zero-acceleration blend.
      if (this.holdUntil !== null && this.holdAt) {
        this.release = { x: this.holdAt.x, y: this.holdAt.y, startedAt: t };
      }
      this.holdUntil = null;
      this.holdAt = null;
    }

    if (!this.cam) this.cam = { x: targetX, y: targetY, crop: cropH };
    const cam = this.cam;

    /* 예전에는 데드존을 썼다. 문턱을 넘기 전까지 가만히 있다가 넘는 순간
     * 왈칵 움직이는 방식이다. 그게 오히려 "정지 -> 튐 -> 정지" 를 만들어
     * 화면이 끊기게 흔들렸다 (실측: 평균 저크 0.00706 > 평균 속도 0.00473).
     *
     * One Euro Filter 로 바꿨다. 속도에 따라 차단 주파수를 조절해서
     * 느릴 때는 세게, 빠를 때는 약하게 거른다. 문턱이 없으니 튐도 없다. */
    const filtered = this.euro.filter(targetX, targetY, t);
    cam.x = filtered.x;
    cam.y = filtered.y;

    /* 고정 구간에서는 아예 붙잡아 둔다.
     * 사람은 서 있어도 미세하게 움직인다. 그걸 따라가면 화면이 계속
     * 미끄러지고, 보는 사람은 그걸 흔들림으로 느낀다. 실제 촬영에서
     * 카메라는 고정하거나 확실히 패닝하거나 둘 중 하나다. */
    if (this.holdUntil !== null && t <= this.holdUntil && this.holdAt) {
      cam.x = this.holdAt.x;
      cam.y = this.holdAt.y;
    } else if (this.release) {
      const u = Math.max(0, Math.min(1, (t - this.release.startedAt) / 0.62));
      const smooth = u * u * u * (u * (u * 6 - 15) + 10);
      cam.x = this.release.x + (filtered.x - this.release.x) * smooth;
      cam.y = this.release.y + (filtered.y - this.release.y) * smooth;
      if (u >= 1) this.release = null;
    }

    // 확대율은 더 천천히 움직인다. 급하게 바꾸면 화면이 울렁인다.
    cam.crop += (cropH - cam.crop) * 0.04;

    if (this.holdUntil !== null && !this.holdAt) this.holdAt = { x: cam.x, y: cam.y };

    const outH = Math.max(16, Math.min(sh, cam.crop));
    const outW = Math.min(sw, outH * ratio);
    const sx = Math.max(0, Math.min(sw - outW, cam.x - outW / 2));
    const sy = Math.max(0, Math.min(sh - outH, cam.y - outH / 2));
    return { sx, sy, sw: outW, sh: outH };
  }
}
