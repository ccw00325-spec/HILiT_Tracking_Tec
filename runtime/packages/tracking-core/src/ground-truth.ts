/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·b6a23f48 @license @preserve */
/* 정답 궤적(Ground Truth) 형식.
 *
 * ## 왜 형식을 먼저 정하는가
 *
 * 지금 우리에게는 "추적이 잘 됐다" 를 재는 방법이 없다. 사람이 결과
 * 영상을 눈으로 보고 판단할 뿐이고, 그래서 무엇을 고쳐도 나아졌는지
 * 알 수 없다. 두 판(V1·V2)을 비교하려면 **같은 자로 재야** 한다.
 *
 * 그 자의 눈금이 이 형식이다.
 *
 * ## 렌더링된 영상에서 역추출하지 않는다
 *
 * 기존 결과 영상에는 추적 상자가 그려져 있다. 거기서 상자를 다시 뽑아
 * 정답으로 쓸 수는 있지만(그건 legacy 변환기가 한다), **앞으로 만드는
 * 정답은 그렇게 만들지 않는다.**
 *
 * 이유: 그림에서 뽑은 값은 우리 추적기가 낸 값이다. 그걸 정답이라
 * 부르면 추적기가 자기 답안지를 채점하는 셈이 된다. 틀린 곳은 정답에서도
 * 틀려 있으므로 영원히 안 보인다.
 *
 * 앞으로는 추적을 **계산하는 단계에서** JSON 을 함께 남기고, 사람이
 * 확인한 것만 `human_verified` 로 표시한다.
 *
 * ## 좌표는 정규화한다
 *
 * 0~1 이다. 픽셀로 두면 해상도가 다른 영상끼리 비교할 수 없고,
 * 프록시 프레임(작게 줄인 것)에서 잰 값과 원본에서 잰 값이 어긋난다.
 * 앱 안의 TrackingPoint 도 같은 규칙을 쓴다.
 */

/** 정규화된 사각형. x·y 는 왼쪽 위 모서리다. */
export interface GtBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 그 시각에 대상이 어떤 상태였는가. */
export interface GtFrame {
  /** 원본 영상 기준 초. 프레임 번호가 아니다 — 가변 fps 영상이 있다. */
  timestamp: number;
  /** 대상의 자리. 안 보이면 없다. */
  bbox?: GtBox;
  /** 화면 안에 보이는가. */
  visible: boolean;
  /** 다른 것에 가려져 있는가. 보이지만 일부만 보이는 경우다. */
  occluded: boolean;
  /**
   * 이 상자가 **우리가 따라가려는 그 사람**인가.
   *
   * 한 프레임에 여러 사람이 있어도 정답은 한 명이다. false 인 상자는
   * 방해 후보(distractor)로 쓴다 — 연결 학습에 음성 표본이 된다.
   */
  target: boolean;
  /** Human-annotated identities visible at the same timestamp. Empty means
   * reviewed and no distractors; omitted means identity switches cannot be scored. */
  distractors?: Array<{ personId: string; bbox: GtBox }>;
}

/** 영상 안에서 일어난 사건. 구간별 성능을 따로 재는 데 쓴다. */
export interface GtEvent {
  kind:
    /** 컷이 바뀐 지점. 이 경계에서 속도를 이어 붙이면 안 된다. */
    | 'cutBoundary'
    /** 대상이 화면 밖으로 나갔다. */
    | 'screenExit'
    /** 대상이 다시 들어왔다. */
    | 'screenReentry'
    /** 사람이 "이건 내가 아니다" 라고 고친 지점. */
    | 'identityCorrection';
  timestamp: number;
  note?: string;
}

export interface GroundTruth {
  videoId: string;
  /**
   * 이 정답이 어디서 왔는가.
   *
   *   human_verified     사람이 보고 확인했다. 평가의 기준으로 쓸 수 있다
   *   tracker_export     추적 계산 중에 남긴 값. 아직 확인 전이다
   *   legacy_render      결과 영상에서 상자를 역추출했다. 참고용이다
   */
  source: 'human_verified' | 'tracker_export' | 'legacy_render';
  fps: number;
  /** 영상 길이(초). 잃어버린 시간의 분모다. */
  duration: number;
  frames: GtFrame[];
  events?: GtEvent[];
  /**
   * 이 영상이 어느 원본에서 나왔는가.
   *
   * 3분할 영상은 원본에서 파생된 것이다. 학습·검증을 나눌 때 원본이
   * 같은 것들이 양쪽에 흩어지면 답을 외운 모델이 좋아 보인다 —
   * 그 누수를 막으려면 파생 관계를 알고 있어야 한다.
   */
  derivedFrom?: string;
  /**
   * 학습에 써도 되는가.
   *
   * 🔴 서비스를 썼다는 사실이 학습 동의가 아니다. 별도로 받은 동의가
   *    있을 때만 true 다. 없으면 평가에만 쓴다.
   */
  trainingConsent?: boolean;
}

/** 사각형이 말이 되는가 — 0~1 안이고 넓이가 있는가. */
export function isValidBox(box: unknown): box is GtBox {
  if (!box || typeof box !== 'object') return false;
  const b = box as GtBox;
  for (const v of [b.x, b.y, b.w, b.h]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  }
  if (b.w <= 0 || b.h <= 0) return false;
  /* 화면 밖으로 조금 나간 상자는 정상이다 — 사람이 가장자리에 걸치면
   * 그렇게 된다. 완전히 밖에 있는 것만 막는다. */
  if (b.x + b.w <= 0 || b.y + b.h <= 0 || b.x >= 1 || b.y >= 1) return false;
  return true;
}

/**
 * 읽은 JSON 이 정답 형식인가 — 틀린 이유를 목록으로 돌려준다.
 *
 * 빈 배열이면 통과다. 조용히 고쳐서 통과시키지 않는다 — 정답 데이터가
 * 조금씩 어긋난 채로 쌓이면 그걸로 잰 모든 수치가 조금씩 틀린다.
 */
export function validateGroundTruth(value: unknown): string[] {
  const bad: string[] = [];
  if (!value || typeof value !== 'object') return ['정답 파일이 객체가 아닙니다'];
  const gt = value as Partial<GroundTruth>;

  if (!gt.videoId) bad.push('videoId 가 없습니다');
  if (!['human_verified', 'tracker_export', 'legacy_render'].includes(String(gt.source))) {
    bad.push(`source 가 잘못됐습니다: ${String(gt.source)}`);
  }
  if (!(typeof gt.fps === 'number' && gt.fps > 0)) bad.push('fps 가 양수가 아닙니다');
  if (!(typeof gt.duration === 'number' && gt.duration > 0)) {
    bad.push('duration 이 양수가 아닙니다');
  }
  if (!Array.isArray(gt.frames)) return [...bad, 'frames 가 배열이 아닙니다'];

  let last = -Infinity;
  gt.frames.forEach((f, i) => {
    if (typeof f?.timestamp !== 'number' || !Number.isFinite(f.timestamp)) {
      bad.push(`frames[${i}].timestamp 가 숫자가 아닙니다`);
      return;
    }
    /* 시각은 반드시 커져야 한다. 뒤섞이면 "잃어버린 시간" 계산이
     * 음수가 되고, 그 음수가 조용히 평균을 깎는다. */
    if (f.timestamp < last) bad.push(`frames[${i}] 의 시각이 앞 프레임보다 이릅니다`);
    last = f.timestamp;

    if (typeof f.visible !== 'boolean') bad.push(`frames[${i}].visible 가 boolean 이 아닙니다`);
    if (typeof f.occluded !== 'boolean') bad.push(`frames[${i}].occluded 가 boolean 이 아닙니다`);
    if (typeof f.target !== 'boolean') bad.push(`frames[${i}].target 이 boolean 이 아닙니다`);
    /* 보인다고 했으면 상자가 있어야 한다. 없으면 그 프레임은 평가에서
     * "찾아야 하는데 정답이 없는" 모순 상태가 된다. */
    if (f.visible && !isValidBox(f.bbox)) bad.push(`frames[${i}] 는 보인다는데 bbox 가 없습니다`);
    if (f.distractors !== undefined && (!Array.isArray(f.distractors)
        || f.distractors.some((d) => !d || typeof d.personId !== 'string' || !d.personId || !isValidBox(d.bbox)))) {
      bad.push(`frames[${i}].distractors 가 잘못됐습니다`);
    }
  });

  return bad;
}
