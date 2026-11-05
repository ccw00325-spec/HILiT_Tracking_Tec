/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·8dc79772 @license @preserve */
/* 추적 영역 예측 — 사용자가 고른 사람이 다음에 어디 있을지.

HILiT 은 외형 속성으로 데이터베이스의 후보를 재식별하는 시스템이 아니다.
**사용자가 고른 대상 하나**의 검출 좌표·포즈·운동 상태·가시성을 시간축으로
예측해 자동 프레이밍과 추적을 하는 시스템이다. 이 파일이 그 예측을 맡는다.

## 무엇을 예측하고, 무엇을 예측하지 않나

예측한다 — 위치(중심), 크기(상자), 가시성(얼마나 보일지), 그리고 그
결과로 나오는 프레이밍·크롭 영역.

예측하지 않는다 — **누구인지**. 이 모듈은 신원을 만들지도 바꾸지도
않는다. 여기서 나온 상자는 "대상이 여기 있을 것 같다" 이지 "여기 있는
사람이 대상이다" 가 아니다. 그 둘을 섞는 순간 예측이 강제 매칭이 된다.

## 왜 여러 방법을 섞나

하나만 쓰면 각자의 방식으로 무너진다.

  칼만(등속)   부드럽지만 급정지·방향 전환에서 오버슈트한다
  EMA          튀지 않지만 늘 한 박자 늦는다
  광학 흐름    실제 화소를 보지만 가림·모션블러에서 엉뚱한 값을 낸다
  포즈 속도    몸통 기준이라 팔다리에 안 흔들리지만 추정기가 있어야 한다

그래서 **속도를 여러 갈래로 재고, 믿을 수 있는 것만 무게를 실어 섞는다.**
못 잰 갈래는 0으로 채우지 않는다 — 분모에서 뺀다. 이 파일 전체가 그
규칙을 따른다.

## 포즈 속도는 지금 돌지 않는다

`pose-runtime.ts` 가 아직 껍데기다(추정기 없음). 그래서 `joints` 는 늘
비어서 들어오고 `sources.pose` 는 false 다. 코드를 미리 둔 이유는,
추정기가 붙는 날 이 파일을 다시 설계하지 않기 위해서다. 없는 관절로
가상 좌표를 만들지는 않는다.
*/

export interface PredictionPoint {
  x: number;
  y: number;
}

export interface PredictionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type OcclusionState = 'visible' | 'partial' | 'occluded' | 'unknown';

export interface PredictionJoint {
  name: string;
  x: number;
  y: number;
  /** 관절 관측 점수. 정확도가 아니다. */
  score: number;
}

export interface TrackRegionObservation {
  tSec: number;
  /** 지금 관측된 사람 중심. 못 봤으면 null. */
  center: PredictionPoint | null;
  /** 지금 관측된 상자. 못 봤으면 null. */
  box: PredictionBox | null;
  /** 이전 위치. 넘기지 않으면 예측기가 들고 있던 값을 쓴다. */
  previousCenter?: PredictionPoint | null;
  /** 광학 흐름 등으로 따로 잰 속도(px/초). 못 쟀으면 null. */
  flowVelocity?: { vx: number; vy: number } | null;
  /** 관절 좌표. 추정기가 없으면 빈 배열이다. 가상 관절을 만들지 않는다. */
  joints?: readonly PredictionJoint[] | null;
  /** 검출 신뢰도 0~1. 동일인 확률이 아니다. 못 쟀으면 null. */
  detectionConfidence: number | null;
  occlusion: OcclusionState;
  frame: { width: number; height: number };
}

export interface TrackRegionPrediction {
  tSec: number;
  /** 몇 초 뒤를 내다봤는지. */
  horizonSec: number;
  center: PredictionPoint;
  box: PredictionBox;
  /** 대상이 가운데 오도록 잡은 영역. 출력 비율 적용 전이다. */
  framing: PredictionBox;
  /** 출력 비율까지 맞춘 크롭 좌표. 카메라가 갈 자리다. */
  crop: PredictionBox;
  velocity: { vx: number; vy: number };
  /** 몸 높이 배수로 잰 속도. 화면 해상도에 안 흔들린다. */
  speedBodies: number;
  visibility: {
    predicted: OcclusionState;
    /** 다음 프레임에 이만큼 믿을 만하다. 확률이 아니다. */
    confidence: number;
  };
  /** 예측이 흔들릴 수 있는 폭(픽셀). 가림이 길수록 커진다. */
  uncertaintyPx: number;
  sources: { kalman: boolean; ema: boolean; flow: boolean; pose: boolean };
  /** 불확실해서 프레이밍을 넓힌 배수. 1이면 안 넓혔다. */
  widenFactor: number;
  /** 되돌리는 중인가. 속도 한계에 걸려 아직 목표에 못 닿았다는 뜻이다. */
  reconciling: boolean;
  /** 이 예측으로 검출 공백을 메워도 되는가. 신원 판정과는 무관하다. */
  mayFillGap: boolean;
  /** 이 예측을 써도 되는지. false 면 사용자에게 다시 물어야 한다. */
  usable: boolean;
  reason: string;
  /** 이 상자는 위치 예측이지 동일인 판정이 아니다. */
  identityClaim: false;
}

/* 관측이 이만큼 끊겼다 가면, 그동안 쌓인 예측 오차를 버리고
 * 사라지기 직전 관측과 지금 관측을 직선으로 이어 속도를 다시 만든다.
 * HilitMotion 이 하던 관측 중심 갱신(OCM)을 이쪽으로 옮겼다. */
export const OBSERVATION_CENTRIC_GAP_SEC = 0.4;

export const TRACK_REGION_POLICY = Object.freeze({
  /** 기본 예측 구간. 20fps 한 프레임. */
  horizonSec: 0.05,
  /** 관측 없이 버티는 한계. 넘으면 usable=false 로 사용자에게 넘긴다. */
  maxCoastSec: 1.2,
  /** 사람이 한 프레임에 갈 수 있는 거리(몸 높이 배수/초). */
  maxSpeedBodies: 6,
  /** 속도 EMA 계수. 클수록 새 관측을 빨리 따른다. */
  emaAlpha: 0.45,
  /** 칼만 처리잡음(가속 표준편차, px/s²). 사람은 등속이 아니다. */
  processAccel: 900,
  /** 관측잡음 바닥(px). 검출 신뢰도가 1이어도 이만큼은 틀린다고 본다. */
  measureNoisePx: 3,
  /** 가림일 때 관측잡음 배수. */
  occludedNoiseScale: 8,
  /** 가림 중 속도 감쇠(초당). */
  coastDecayPerSec: 0.6,
  /** 프레이밍에서 대상이 차지할 높이 비율. */
  subjectShare: 0.42,
  /** 진행 방향으로 앞서 보는 한도(프레이밍 폭 대비). */
  leadRoom: 0.12,
  /** 크기 갱신 이득. 잘린 상자가 크기를 망치므로 위치보다 느리게 따른다. */
  sizeGain: 0.25,
  /* ── 예측이 틀려도 화면이 끊기지 않게 하는 값들 ──────────────────
   *
   * 예측은 **자신 있게** 틀린다. 급정지·방향 전환에서 특히 그렇다.
   * 틀렸다는 걸 알았을 때 화면을 한 번에 되돌리면 그게 "끊김" 이다.
   * 그래서 둘을 쓴다.
   *
   *   1) 불확실할수록 **넓게 잡는다.** 틀려도 대상이 화면 안에 남는다.
   *      방송 카메라가 하는 일과 같다 — 확신이 없으면 당기지 않는다.
   *   2) 되돌릴 때 **속도 한계 안에서** 되돌린다. 순간이동이 없다. */
  /** 불확실성이 이만큼(몸 높이 배수)이면 최대로 넓힌다. */
  uncertaintyFullBodies: 1.2,
  /** 최대로 넓혔을 때 프레이밍이 커지는 배수. */
  maxWiden: 1.65,
  /** 프레이밍이 한 초에 움직일 수 있는 거리(프레이밍 폭 배수). */
  maxFramingSpeed: 2.2,
  /** 프레이밍 크기가 한 초에 바뀔 수 있는 비율. */
  maxFramingZoomRate: 1.1,
  /** 예측 신뢰가 이 밑이면 예측을 상자에 쓰지 않는다(보간 금지). */
  minFillConfidence: 0.35,
  /** 예측으로 메울 수 있는 최대 공백. 이보다 길면 사용자에게 넘긴다. */
  maxFillSec: 0.4,
});

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** 축 하나짜리 등속 칼만. 상태는 [위치, 속도]다. */
class Axis1D {
  pos = 0;
  vel = 0;
  /** 공분산 [[pp, pv], [pv, vv]]. */
  private pp = 1e4;
  private pv = 0;
  private vv = 1e4;
  private started = false;

  start(pos: number): void {
    this.pos = pos;
    this.vel = 0;
    this.pp = 1e3;
    this.pv = 0;
    this.vv = 1e4;
    this.started = true;
  }

  get ready(): boolean {
    return this.started;
  }

  /** 시간만 흐른다. 관측은 없다. */
  predict(dt: number, accelStd: number): void {
    if (!this.started || dt <= 0) return;
    this.pos += this.vel * dt;
    const q = accelStd * accelStd;
    const dt2 = dt * dt;
    const dt3 = dt2 * dt;
    const dt4 = dt2 * dt2;
    this.pp += 2 * this.pv * dt + this.vv * dt2 + (q * dt4) / 4;
    this.pv += this.vv * dt + (q * dt3) / 2;
    this.vv += q * dt2;
  }

  /** 관측이 들어왔다. r 은 관측잡음 분산이다. */
  update(measurement: number, r: number): void {
    if (!this.started) {
      this.start(measurement);
      return;
    }
    const s = this.pp + r;
    if (!(s > 0)) return;
    const kp = this.pp / s;
    const kv = this.pv / s;
    const innovation = measurement - this.pos;
    this.pos += kp * innovation;
    this.vel += kv * innovation;
    const pp = this.pp;
    const pv = this.pv;
    this.pp = pp - kp * pp;
    this.pv = pv - kp * pv;
    this.vv -= kv * pv;
    if (this.vv < 1e-6) this.vv = 1e-6;
    if (this.pp < 1e-6) this.pp = 1e-6;
  }

  /** 속도만 밖에서 고쳐 넣는다(광학 흐름·포즈 융합 결과). */
  setVelocity(v: number): void {
    this.vel = v;
  }

  get positionStd(): number {
    return Math.sqrt(Math.max(0, this.pp));
  }
}

/** 몸통 관절로 속도를 잰다. 팔다리는 쓰지 않는다 — 몸보다 빨리 움직인다. */
export function poseVelocity(
  previous: readonly PredictionJoint[] | null | undefined,
  current: readonly PredictionJoint[] | null | undefined,
  dtSec: number,
): { vx: number; vy: number } | null {
  if (!previous?.length || !current?.length || !(dtSec > 0)) return null;
  const TORSO = ['l_hip', 'r_hip', 'l_shoulder', 'r_shoulder'];
  const pick = (joints: readonly PredictionJoint[]) => {
    const used = joints.filter((j) => TORSO.includes(j.name) && j.score >= 0.3);
    if (used.length < 2) return null;
    let x = 0;
    let y = 0;
    for (const j of used) {
      x += j.x;
      y += j.y;
    }
    return { x: x / used.length, y: y / used.length };
  };
  const a = pick(previous);
  const b = pick(current);
  if (!a || !b) return null;
  return { vx: (b.x - a.x) / dtSec, vy: (b.y - a.y) / dtSec };
}

interface VelocitySource {
  vx: number;
  vy: number;
  weight: number;
}

/** 잰 갈래만 무게를 실어 섞는다. 못 잰 갈래는 분모에서도 뺀다. */
export function fuseVelocity(sources: readonly VelocitySource[]): { vx: number; vy: number } | null {
  let vx = 0;
  let vy = 0;
  let weight = 0;
  for (const source of sources) {
    if (!Number.isFinite(source.vx) || !Number.isFinite(source.vy)) continue;
    if (!(source.weight > 0)) continue;
    vx += source.vx * source.weight;
    vy += source.vy * source.weight;
    weight += source.weight;
  }
  return weight > 0 ? { vx: vx / weight, vy: vy / weight } : null;
}

export class TrackRegionPredictor {
  private readonly ax = new Axis1D();
  private readonly ay = new Axis1D();
  private width = 0;
  private height = 0;
  private lastTSec: number | null = null;
  private lastObservedTSec: number | null = null;
  private lastCenter: PredictionPoint | null = null;
  private lastJoints: readonly PredictionJoint[] | null = null;
  private emaVx = 0;
  private emaVy = 0;
  private emaReady = false;
  /** 최근 관측들. 방향을 시간 창으로 재는 데 쓴다. */
  private history: Array<{ at: number; x: number; y: number }> = [];
  /** 화면에 실제로 내보낸 프레이밍. 여기서 속도 한계를 건다. */
  private smoothed: { x: number; y: number; w: number; h: number } | null = null;
  private observationCentricCount = 0;
  /** 마지막 프레임 간격. 프레이밍 속도 한계를 시간 기준으로 걸기 위해 둔다. */
  private lastFrameDt = 0.05;

  /** 사용자가 대상을 고른 순간. 속도는 아직 모른다 — 관측으로 배운다. */
  start(box: PredictionBox, tSec: number): void {
    this.ax.start(box.x + box.width / 2);
    this.ay.start(box.y + box.height / 2);
    this.width = box.width;
    this.height = box.height;
    this.lastTSec = tSec;
    this.lastObservedTSec = tSec;
    this.lastCenter = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    this.lastJoints = null;
    this.emaVx = 0;
    this.emaVy = 0;
    this.emaReady = false;
    this.history = [{ at: tSec, x: this.ax.pos, y: this.ay.pos }];
    this.smoothed = null;
    this.observationCentricCount = 0;
  }

  reset(): void {
    this.lastTSec = null;
    this.lastObservedTSec = null;
    this.lastCenter = null;
    this.lastJoints = null;
    this.emaReady = false;
  }

  get started(): boolean {
    return this.ax.ready;
  }

  /** 마할라노비스용 축별 표준편차. 동일인 점수가 아니다. */
  spatialCovariance(): {
    stdX: number;
    stdY: number;
    bodyHeight: number;
    coastSec: number;
  } | null {
    if (!this.ax.ready || !this.ay.ready || this.lastTSec == null) return null;
    const coast = this.lastObservedTSec == null ? 0 : Math.max(0, this.lastTSec - this.lastObservedTSec);
    return {
      stdX: this.ax.positionStd,
      stdY: this.ay.positionStd,
      bodyHeight: Math.max(1, this.height),
      coastSec: coast,
    };
  }

  /**
   * 관측 하나를 넣고 다음 자리를 받는다.
   *
   * 관측이 없으면(가림) 예측만 하고 불확실성을 키운다. 일정 시간을
   * 넘기면 `usable=false` 로 돌려준다 — 그때는 계속 짐작하지 말고
   * 사용자에게 다시 물어야 한다.
   */
  observe(
    input: TrackRegionObservation,
    opts?: { horizonSec?: number; outputAspect?: number | null },
  ): TrackRegionPrediction {
    const P = TRACK_REGION_POLICY;
    const horizon = opts?.horizonSec ?? P.horizonSec;

    if (!this.ax.ready) {
      if (input.box) this.start(input.box, input.tSec);
      else {
        return this.compose(input, horizon, opts?.outputAspect ?? null, {
          kalman: false, ema: false, flow: false, pose: false,
        }, false, 'not-started');
      }
    }

    const dt = this.lastTSec == null ? 0 : Math.max(0, input.tSec - this.lastTSec);
    if (dt > 0) {
      this.ax.predict(dt, P.processAccel);
      this.ay.predict(dt, P.processAccel);
    }

    const sources = { kalman: true, ema: false, flow: false, pose: false };
    const measured = input.center
      ?? (input.box ? { x: input.box.x + input.box.width / 2, y: input.box.y + input.box.height / 2 } : null);

    if (measured) {
      const trust = input.detectionConfidence == null || !Number.isFinite(input.detectionConfidence)
        ? 0.5
        : clamp(input.detectionConfidence, 0, 1);
      /* 확신이 낮을수록 관측잡음을 키운다. 버리지는 않는다 —
       * 버리면 가림 중에 아무 정보도 안 들어온다. */
      const occScale = input.occlusion === 'occluded'
        ? P.occludedNoiseScale
        : input.occlusion === 'partial' ? 3 : 1;
      const noise = P.measureNoisePx * occScale * (1 + 3 * (1 - trust));
      const r = noise * noise;
      this.ax.update(measured.x, r);
      this.ay.update(measured.y, r);

      /* 속도를 여러 갈래로 재고 믿을 수 있는 것만 섞는다. */
      const previous = input.previousCenter ?? this.lastCenter;
      const gap = this.lastObservedTSec == null ? dt : input.tSec - this.lastObservedTSec;

      /* 🔴 관측 중심 갱신(OCM).
       *
       * 오래 못 보다가 관측이 돌아왔다. 그동안의 예측은 매 걸음 조금씩
       * 틀렸고 그 오차가 쌓였다. 여기서 그걸 **버린다** — 사라지기 직전
       * 관측과 지금 관측을 직선으로 이어 그 사이 실제 속도로 바꾼다.
       *
       * 경기 중 사람은 등속으로 안 움직인다. 급정지하고 방향을 바꾼다.
       * 등속 가정으로 길게 예측하면 반드시 틀리고, 그 틀린 자리를 기준
       * 삼으면 다음 판단이 전부 거기서 출발한다. */
      if (previous && gap >= OBSERVATION_CENTRIC_GAP_SEC) {
        const ocmVx = (measured.x - previous.x) / gap;
        const ocmVy = (measured.y - previous.y) / gap;
        this.emaVx = ocmVx;
        this.emaVy = ocmVy;
        this.emaReady = true;
        this.ax.setVelocity(ocmVx);
        this.ay.setVelocity(ocmVy);
        this.observationCentricCount += 1;
      }

      const list: VelocitySource[] = [
        { vx: this.ax.vel, vy: this.ay.vel, weight: 1 },
      ];
      if (previous && gap > 1e-3) {
        list.push({
          vx: (measured.x - previous.x) / gap,
          vy: (measured.y - previous.y) / gap,
          weight: 0.8 * trust,
        });
      }
      if (input.flowVelocity
        && Number.isFinite(input.flowVelocity.vx)
        && Number.isFinite(input.flowVelocity.vy)) {
        /* 광학 흐름은 가림·모션블러에서 엉뚱한 값을 낸다. 가릴수록 뺀다. */
        const flowWeight = input.occlusion === 'occluded' ? 0 : input.occlusion === 'partial' ? 0.3 : 0.9;
        if (flowWeight > 0) {
          list.push({ vx: input.flowVelocity.vx, vy: input.flowVelocity.vy, weight: flowWeight });
          sources.flow = true;
        }
      }
      const pose = poseVelocity(this.lastJoints, input.joints, Math.max(1e-3, gap));
      if (pose) {
        list.push({ vx: pose.vx, vy: pose.vy, weight: 1.1 });
        sources.pose = true;
      }
      const fused = fuseVelocity(list);
      if (fused) {
        if (this.emaReady) {
          this.emaVx = this.emaVx * (1 - P.emaAlpha) + fused.vx * P.emaAlpha;
          this.emaVy = this.emaVy * (1 - P.emaAlpha) + fused.vy * P.emaAlpha;
        } else {
          this.emaVx = fused.vx;
          this.emaVy = fused.vy;
          this.emaReady = true;
        }
        sources.ema = true;
        /* 사람이 갈 수 있는 속도로 자른다. 상한이 없으면 한 번 튄
         * 관측이 예측을 화면 밖으로 던진다. */
        const cap = P.maxSpeedBodies * Math.max(1, this.height);
        const speed = Math.hypot(this.emaVx, this.emaVy);
        if (speed > cap && speed > 0) {
          this.emaVx *= cap / speed;
          this.emaVy *= cap / speed;
        }
        this.ax.setVelocity(this.emaVx);
        this.ay.setVelocity(this.emaVy);
      }

      if (input.box) {
        this.width += (input.box.width - this.width) * P.sizeGain;
        this.height += (input.box.height - this.height) * P.sizeGain;
      }
      this.lastCenter = { x: measured.x, y: measured.y };
      this.lastObservedTSec = input.tSec;
      this.history.push({ at: input.tSec, x: measured.x, y: measured.y });
      this.history = this.history.filter((h) => input.tSec - h.at <= 1.5).slice(-24);
      if (input.joints?.length) this.lastJoints = input.joints.slice();
    } else if (dt > 0) {
      /* 관측이 없다. 속도를 줄인다 — 오래 못 본 상태에서 멀리까지
       * 예측하면 그 예측이 해롭다. */
      const decay = Math.pow(P.coastDecayPerSec, dt);
      this.emaVx *= decay;
      this.emaVy *= decay;
      this.ax.setVelocity(this.emaVx);
      this.ay.setVelocity(this.emaVy);
    }

    if (dt > 0) this.lastFrameDt = dt;
    this.lastTSec = input.tSec;

    const coastSec = this.lastObservedTSec == null ? 0 : input.tSec - this.lastObservedTSec;
    const usable = coastSec <= P.maxCoastSec;
    const reason = usable
      ? (measured ? 'observed' : 'coasting')
      : 'coast-limit-exceeded';
    return this.compose(input, horizon, opts?.outputAspect ?? null, sources, usable, reason);
  }

  private compose(
    input: TrackRegionObservation,
    horizon: number,
    outputAspect: number | null,
    sources: TrackRegionPrediction['sources'],
    usable: boolean,
    reason: string,
  ): TrackRegionPrediction {
    const P = TRACK_REGION_POLICY;
    const frame = input.frame;
    const height = Math.max(1, this.height);
    const width = Math.max(1, this.width);
    const vx = this.ax.ready ? this.ax.vel : 0;
    const vy = this.ay.ready ? this.ay.vel : 0;
    const cx = clamp((this.ax.ready ? this.ax.pos : frame.width / 2) + vx * horizon, 0, frame.width);
    const cy = clamp((this.ay.ready ? this.ay.pos : frame.height / 2) + vy * horizon, 0, frame.height);

    const box: PredictionBox = {
      x: cx - width / 2,
      y: cy - height / 2,
      width,
      height,
    };

    /* 자동 프레이밍 — 대상이 화면에서 subjectShare 만큼 차지하게 잡고,
     * 진행 방향으로 leadRoom 안에서만 앞서 본다. 그 이상 앞서면
     * "따라가는 카메라" 가 아니라 "혼자 달려가는 카메라" 가 된다. */
    const framingHeight = clamp(height / P.subjectShare, height, frame.height);
    const framingWidth = clamp(
      outputAspect && outputAspect > 0 ? framingHeight * outputAspect : framingHeight * (frame.width / Math.max(1, frame.height)),
      width,
      frame.width,
    );
    const coastSec = this.lastObservedTSec == null || this.lastTSec == null
      ? 0
      : Math.max(0, this.lastTSec - this.lastObservedTSec);
    /* 오래 못 봤으면 앞서 보지 않는다. 틀린 방향으로 달려가면
     * 사용자가 화면에서 대상을 잃는다. */
    const leadScale = coastSec > 0 ? Math.max(0, 1 - coastSec / P.maxCoastSec) : 1;
    const leadX = clamp(vx * horizon * 4, -framingWidth * P.leadRoom, framingWidth * P.leadRoom) * leadScale;
    const leadY = clamp(vy * horizon * 4, -framingHeight * P.leadRoom, framingHeight * P.leadRoom) * leadScale;
    /* 🔴 불확실할수록 넓게 잡는다.
     *
     * 예측이 틀렸을 때 화면이 끊겨 보이는 진짜 이유는 "틀린 자리를 꽉
     * 채워서" 다. 확신이 없을 때 조금 넓게 잡아 두면, 예측이 반 몸쯤
     * 틀려도 대상이 화면 안에 남는다. 방송 카메라가 하는 일과 같다. */
    const uncertaintyBodies = Number.isFinite(this.ax.positionStd)
      ? Math.hypot(this.ax.positionStd, this.ay.positionStd) / Math.max(1, height)
      : P.uncertaintyFullBodies;
    const widen = 1 + (P.maxWiden - 1)
      * clamp(uncertaintyBodies / P.uncertaintyFullBodies, 0, 1);
    const wantWidth = clamp(framingWidth * widen, width, frame.width);
    const wantHeight = clamp(framingHeight * widen, height, frame.height);
    const target = {
      x: clamp(cx + leadX - wantWidth / 2, 0, Math.max(0, frame.width - wantWidth)),
      y: clamp(cy + leadY - wantHeight / 2, 0, Math.max(0, frame.height - wantHeight)),
      w: wantWidth,
      h: wantHeight,
    };

    /* 🔴 되돌릴 때는 속도 한계 안에서 되돌린다.
     *
     * 관측이 돌아와 "예측이 틀렸다" 는 걸 알아도, 화면을 한 번에
     * 옮기면 그게 끊김이다. 한 프레임에 갈 수 있는 거리까지만 간다. */
    const step = Math.max(1e-3, this.lastFrameDt);
    let reconciling = false;
    if (!this.smoothed) {
      this.smoothed = { ...target };
    } else {
      const maxMove = P.maxFramingSpeed * this.smoothed.w * step;
      const dx = target.x - this.smoothed.x;
      const dy = target.y - this.smoothed.y;
      const dist = Math.hypot(dx, dy);
      if (dist > maxMove && dist > 0) {
        this.smoothed.x += (dx / dist) * maxMove;
        this.smoothed.y += (dy / dist) * maxMove;
        reconciling = true;
      } else {
        this.smoothed.x = target.x;
        this.smoothed.y = target.y;
      }
      const zoomCap = Math.pow(1 + P.maxFramingZoomRate, step);
      const applyZoom = (now: number, want: number) => clamp(want, now / zoomCap, now * zoomCap);
      const nextW = applyZoom(this.smoothed.w, target.w);
      const nextH = applyZoom(this.smoothed.h, target.h);
      if (Math.abs(nextW - target.w) > 1e-6) reconciling = true;
      this.smoothed.w = nextW;
      this.smoothed.h = nextH;
    }
    const framing: PredictionBox = {
      x: clamp(this.smoothed.x, 0, Math.max(0, frame.width - this.smoothed.w)),
      y: clamp(this.smoothed.y, 0, Math.max(0, frame.height - this.smoothed.h)),
      width: this.smoothed.w,
      height: this.smoothed.h,
    };

    /* 크롭은 프레이밍에 출력 비율을 맞춘 것이다. 비율이 없으면 같다. */
    let crop: PredictionBox = { ...framing };
    if (outputAspect && outputAspect > 0) {
      const wanted = framing.height * outputAspect;
      const cropWidth = clamp(wanted, 1, frame.width);
      const cropHeight = clamp(cropWidth / outputAspect, 1, frame.height);
      crop = {
        x: clamp(cx + leadX - cropWidth / 2, 0, Math.max(0, frame.width - cropWidth)),
        y: clamp(cy + leadY - cropHeight / 2, 0, Math.max(0, frame.height - cropHeight)),
        width: cropWidth,
        height: cropHeight,
      };
    }

    /* 가시성 예측. 지금 상태에서 다음 프레임이 어떨지만 말한다. */
    const detect = input.detectionConfidence == null ? 0.5 : clamp(input.detectionConfidence, 0, 1);
    let predicted: OcclusionState = input.occlusion;
    let confidence = detect;
    if (coastSec > 0) {
      predicted = coastSec > P.maxCoastSec ? 'unknown' : 'occluded';
      confidence = clamp(detect * Math.max(0, 1 - coastSec / P.maxCoastSec), 0, 1);
    } else if (input.occlusion === 'unknown') {
      confidence = clamp(detect * 0.6, 0, 1);
    }

    const speed = Math.hypot(vx, vy);
    /* 검출 공백을 예측으로 메워도 되는 조건. 신원과는 무관하다 —
     * "여기 있을 것 같다" 일 뿐 "여기 있는 사람이 대상이다" 가 아니다. */
    const mayFillGap = usable
      && coastSec > 0
      && coastSec <= P.maxFillSec
      && confidence >= P.minFillConfidence;
    return {
      tSec: input.tSec,
      horizonSec: horizon,
      center: { x: cx, y: cy },
      box,
      framing,
      crop,
      velocity: { vx, vy },
      speedBodies: speed / Math.max(1, height),
      visibility: { predicted, confidence },
      uncertaintyPx: this.ax.ready
        ? Math.hypot(this.ax.positionStd, this.ay.positionStd)
        : Number.POSITIVE_INFINITY,
      sources,
      widenFactor: widen,
      reconciling,
      mayFillGap,
      usable,
      reason,
      identityClaim: false,
    };
  }

  /* ── HilitMotion 에서 옮겨온 것들 ──────────────────────────────────
   *
   * 예전에는 운동 모델이 두 벌이었다. `HilitMotion` 은 잘 만들어 두고
   * 시험에서만 돌았고, 실제 제품은 이동평균으로 버텼다. 한 벌로 합친다. */

  /** 그 시각의 예상 중심. 버틸 수 있는 한계를 넘으면 null. */
  predictAt(tSec: number): PredictionPoint | null {
    if (!this.ax.ready || this.lastTSec == null) return null;
    const coast = this.lastObservedTSec == null ? 0 : tSec - this.lastObservedTSec;
    if (coast > TRACK_REGION_POLICY.maxCoastSec) return null;
    const dt = tSec - this.lastTSec;
    return { x: this.ax.pos + this.ax.vel * dt, y: this.ay.pos + this.ay.vel * dt };
  }

  /** 예상 자리에서 얼마나 벗어났나 — 몸 높이 배수. */
  errorOf(center: PredictionPoint, tSec: number): number {
    const guess = this.predictAt(tSec);
    if (!guess) return Number.POSITIVE_INFINITY;
    return Math.hypot(center.x - guess.x, center.y - guess.y) / Math.max(1, this.height);
  }

  /** 가림 동안 대상이 지났을 법한 자리. 관측이 아니다. */
  virtualPath(tSec: number, steps: number): Array<{ tSec: number; center: PredictionPoint }> {
    const out: Array<{ tSec: number; center: PredictionPoint }> = [];
    if (this.lastTSec == null) return out;
    for (let i = 1; i <= steps; i += 1) {
      const at = this.lastTSec + ((tSec - this.lastTSec) * i) / steps;
      const guess = this.predictAt(at);
      if (!guess) break;
      out.push({ tSec: at, center: guess });
    }
    return out;
  }

  /** 관측으로 잰 이동 방향. 한 프레임 차이가 아니라 시간 창으로 잰다. */
  heading(windowSec = 0.3): PredictionPoint | null {
    if (this.history.length < 2) return null;
    const last = this.history[this.history.length - 1];
    let first = this.history[0];
    for (let i = this.history.length - 1; i >= 0; i -= 1) {
      if (last.at - this.history[i].at >= windowSec) { first = this.history[i]; break; }
    }
    const dx = last.x - first.x;
    const dy = last.y - first.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) return null;
    return { x: dx / len, y: dy / len };
  }

  /** 지금 알고 있는 운동 상태. 아직 시작 전이면 null.
   *
   * `motion.ts` 의 HilitMotion 이 이 값을 읽어 간다 — 운동 상태를
   * 두 곳에서 따로 들고 있지 않기 위해서다. */
  motionState(): {
    cx: number; cy: number; width: number; height: number; vx: number; vy: number;
  } | null {
    if (!this.ax.ready) return null;
    return {
      cx: this.ax.pos, cy: this.ay.pos,
      width: this.width, height: this.height,
      vx: this.ax.vel, vy: this.ay.vel,
    };
  }

  /** 마지막으로 진짜 관측을 본 시각. 없으면 null. */
  get lastObservationAt(): number | null {
    return this.lastObservedTSec;
  }

  /** 관측 중심 갱신이 몇 번 돌았나. 가림에서 되돌아온 횟수다. */
  get observationCentricUpdates(): number {
    return this.observationCentricCount;
  }
}
