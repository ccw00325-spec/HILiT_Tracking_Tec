/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·d15d88e0 @license @preserve */
/* 판정 로직. 모델이 아니라 순수 계산이다.
 *
 * mobile/confidence/tracking_health.py, confidence_trend.py,
 * mobile/tracker/occlusion_memory.py, mobile/reid/candidate_ranking.py 의
 * 브라우저 이식본이다. 상수는 config.generated.js 에서 가져온다 —
 * 손으로 적으면 파이썬 경로와 어긋나고, 그러면 두 경로의 측정치를
 * 비교할 수 없다.
 */
import { CONFIG, badFramesRequired } from './config.generated.js';
import { iou, cosine } from './models.js';
/* 앵커를 최근 모습에 조금씩 맞춘다. 섞는 일만 하는 함수이고, 언제
 * 부를지는 IdentityMemory.adapt 가 판단한다. */
import { adaptAnchor, ADAPT_MAX_RATE } from './hilit-appearance.js';

export const State = {
  OK: 'TRACKING_OK',
  WARNING: 'TRACKING_WARNING',
  OCCLUDED: 'OCCLUDED',
  REACQUIRING: 'REACQUIRING_MOBILE',
  LOST: 'TRACKING_LOST',
  ASK_USER: 'USER_CONFIRMATION',
  FINISHED: 'FINISHED',
};

export const Cause = {
  OCCLUSION: 'occlusion',
  FAST_MOTION: 'fast_motion',
  CAMERA_MOTION: 'camera_motion',
  REID_FAILURE: 'reid_failure',
  TARGET_EXIT: 'target_exit',
  SIMILAR_APPEARANCE: 'similar_appearance',
  DETECTOR_FAILURE: 'detector_failure',
  UNKNOWN: 'unknown',
};

/* =====================================================================
 * tracker confidence 추세 — 절대값이 아니라 기준선 대비 하락률
 * ===================================================================== */

/* 실제 영상에서 confidence 가 0.917 -> 0.757 로 급락했는데 아무 신호도
 * 되지 못했다. 0.757 은 여전히 높은 값이기 때문이다. 문제는 값이 아니라
 * 떨어졌다는 사실이다.
 *
 * 기준선은 비대칭 EMA 로 갱신한다. 대칭으로 두면 하락이 기준선에 흡수되어
 * 아무것도 감지하지 못한다 (올라갈 때 0.15, 내려갈 때 0.01 — 15배 차이). */
export class ConfidenceTrend {
  constructor() { this.baseline = null; this.n = 0; this.drop = 0; this.dropped = false; }

  update(confidence) {
    this.n += 1;
    if (this.baseline === null) { this.baseline = confidence; return; }
    const alpha = confidence >= this.baseline
      ? CONFIG.TRACKER_BASELINE_ALPHA_UP
      : CONFIG.TRACKER_BASELINE_ALPHA_DOWN;
    this.baseline = alpha * confidence + (1 - alpha) * this.baseline;
    const base = Math.max(this.baseline, 1e-6);
    this.drop = Math.max(0, 1 - confidence / base);
    this.dropped = this.n >= CONFIG.TRACKER_TREND_WARMUP
                && this.drop >= CONFIG.TRACKER_DROP_RATIO;
  }
}

/* =====================================================================
 * Tracking Health — 7신호
 * ===================================================================== */

function normalizedWeights() {
  const w = CONFIG.HEALTH_WEIGHTS;
  const total = Object.values(w).reduce((a, b) => a + b, 0) || 1;
  const out = {};
  for (const [k, v] of Object.entries(w)) out[k] = v / total;
  return out;
}
const W = normalizedWeights();

/* 기억해 둘 "다른 사람" 수. 너무 많이 들고 있으면 오래된 조명·자세의
 * 임베딩이 남아 오히려 방해가 된다. */
const CONFIG_MAX_VIEWS = 6;
const CONFIG_MAX_DISTRACTORS = 6;
/* 다른 사람과의 유사도가 나보다 이만큼 높으면 그건 그 사람이다.
 * 여유를 두는 이유: 임베딩은 노이즈가 있어서 근소한 차이는 뒤집힌다. */
const CONFIG_DISTRACTOR_MARGIN = 0.06;
/* 옷 색이 이 정도로 맞으면 "확실히 내 옷" 으로 본다.
 * 히스토그램 교집합이라 0.72 면 상당히 일치하는 값이다. */
export const CONFIG_COLOR_STRONG = 0.72;
/* 색으로 살려줄 수 있는 OSNet 부족분. 너무 크게 두면 옷만 비슷한
 * 다른 사람까지 살아난다. */
const CONFIG_COLOR_RESCUE_SLACK = 0.18;
/* 이 아래면 옷 색이 명백히 다르다고 보고 거부한다.
 * 실측: 같은 사람은 조명·자세가 바뀌어도 0.7 이상을 유지했고, 상의
 * 색이 다른 사람은 0.3~0.5 에 몰렸다. 0.42 는 그 사이의 골짜기다.
 * 구제 기준(0.72)보다 크게 낮은 이유 — 색은 흔들리는 신호이므로
 * 살릴 때는 관대하게, 버릴 때는 확실할 때만 쓴다. */
export const CONFIG_COLOR_VETO = 0.42;

/* NaN 을 0 으로 떨군다.
 *
 * v < 0 / v > 1 비교만 쓰면 NaN 이 두 조건을 모두 빠져나가 그대로 반환된다
 * (NaN 비교는 항상 false). 신호 하나가 NaN 이면 health 전체가 NaN 이 되고
 * 평균까지 오염되는데, 예외는 나지 않아서 조용히 틀린다.
 *
 * 실제로 그 일이 있었다 — 앱 어댑터가 박스를 {w,h} 로 넘겼고 파이프라인은
 * {width,height} 를 읽어서 undefined -> NaN 이 됐다. 화면에는 평균 건강도가
 * NaN 으로만 찍혔고 원인은 전혀 드러나지 않았다.
 *
 * NaN 을 0 으로 만들면 "신호가 나쁘다" 로 보수적으로 읽히므로 안전한 쪽이다.
 * 단 조용히 넘기지 않기 위해 호출부에서 non-finite 여부를 note 로 남긴다. */
function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class TrackingHealth {
  constructor(reidThreshold = CONFIG.REID_THRESHOLD) {
    this.reidThreshold = reidThreshold;
    this.window = [];
    this.state = State.OK;
    this.trend = new ConfidenceTrend();
    this.lastReid = null;
    this.framesSinceReid = 1e9;
    this.history = [];
  }

  /** 신호 -> health + is_bad. 파이썬 compute() 와 같은 순서로 계산한다. */
  evaluate(sig) {
    const notes = [];
    const fw = sig.frameWidth, fh = sig.frameHeight;
    const diag = Math.sqrt(fw * fw + fh * fh);

    // A. Re-ID
    let reidScore = 1.0;
    if (sig.reidSimilarity !== null && sig.reidSimilarity !== undefined) {
      // threshold 를 0.5 로 매핑한다. 파이썬과 동일.
      reidScore = clamp01(sig.reidSimilarity / Math.max(this.reidThreshold * 2, 1e-6));
    }

    // B. tracker confidence
    const trackerScore = clamp01(sig.trackerConfidence);

    // C. 중심 이동량 (카메라 보정 후 값이 들어온다)
    let motionScore = 1.0;
    if (sig.prevBox && sig.box) {
      const dx = (sig.box.x + sig.box.width / 2) - (sig.prevBox.x + sig.prevBox.width / 2);
      const dy = (sig.box.y + sig.box.height / 2) - (sig.prevBox.y + sig.prevBox.height / 2);
      const jump = Math.sqrt(dx * dx + dy * dy) / Math.max(diag, 1e-6);
      motionScore = clamp01(1 - jump / Math.max(CONFIG.CENTROID_JUMP_RATIO, 1e-6));
      if (jump > CONFIG.CENTROID_JUMP_RATIO) notes.push('centroid_jump');
    }

    // D. 박스 면적 변화율
    let boxScore = 1.0;
    if (sig.prevBox && sig.box) {
      const a0 = Math.max(sig.prevBox.width * sig.prevBox.height, 1);
      const ratio = (sig.box.width * sig.box.height) / a0;
      if (ratio < CONFIG.BOX_CHANGE_LOW || ratio > CONFIG.BOX_CHANGE_HIGH) {
        boxScore = 0.0; notes.push('box_jump');
      }
    }

    // E. 가시성
    let visibilityScore = 1.0;
    if (sig.box) {
      const areaRatio = (sig.box.width * sig.box.height) / Math.max(fw * fh, 1);
      if (areaRatio < CONFIG.MIN_BOX_AREA_RATIO) { visibilityScore = 0.0; notes.push('too_small'); }
      const cx = sig.box.x + sig.box.width / 2, cy = sig.box.y + sig.box.height / 2;
      if (cx < 0 || cy < 0 || cx > fw || cy > fh) { visibilityScore = 0.0; notes.push('out_of_frame'); }
    } else {
      visibilityScore = 0.0; notes.push('no_box');
    }

    // F. 가림 (V3)
    const occlusionScore = sig.occluded ? 0.0 : 1.0;
    // G. 후보 애매함 (V3). 1.0 = 애매하지 않음
    const ambiguityScore = sig.ambiguity === undefined ? 1.0 : clamp01(sig.ambiguity);

    let health = W.reid * reidScore + W.tracker * trackerScore
               + W.motion * motionScore + W.box * boxScore
               + W.visibility * visibilityScore + W.occlusion * occlusionScore
               + W.ambiguity * ambiguityScore;

    // 예측 박스로 계산한 Health 에는 상한을 둔다. 없으면 가려진 동안
    // Health 가 높게 유지되어 재획득이 늦어진다.
    if (sig.predicted) health = Math.min(health, CONFIG.PREDICTED_HEALTH_CAP);

    let isBad = health < CONFIG.BAD_FRAME_HEALTH;

    // 거부권 1 — 신원 증거는 가중 합산에 묻히지 않는다.
    // 실측: Re-ID 0.52 인데 나머지 신호가 만점이라 합산이 0.83 으로 유지됐다.
    if (sig.reidSimilarity !== null && sig.reidSimilarity !== undefined
        && sig.reidSimilarity < this.reidThreshold) {
      isBad = true; notes.push('reid_veto');
    }
    // 거부권 2 — 기준선 대비 급락
    if (sig.trackerDropped) { isBad = true; notes.push('tracker_dropped'); }

    return { health, isBad, reidScore, trackerScore, motionScore,
             boxScore, visibilityScore, occlusionScore, ambiguityScore, notes };
  }

  /** 20프레임 창을 밀고 상태를 전이한다. */
  push(result, nLevel = CONFIG.N_LEVEL) {
    this.window.push(result.isBad ? 1 : 0);
    if (this.window.length > CONFIG.TRACKING_WINDOW) this.window.shift();
    const bad = this.window.reduce((a, b) => a + b, 0);
    const ratio = bad / Math.max(this.window.length, 1);

    const needed = badFramesRequired(nLevel);
    let next = this.state;
    if (bad >= needed && this.window.length >= Math.min(CONFIG.TRACKING_WINDOW, needed)) {
      next = State.LOST;
    } else if (ratio >= CONFIG.WARNING_LOST_RATIO) {
      next = State.WARNING;
    } else {
      next = State.OK;
    }
    this.state = next;
    return { state: next, badRatio: ratio, badFrames: bad, needed };
  }

  /** Adaptive Re-ID 간격. 위험하면 좁힌다. */
  reidInterval() {
    if (!CONFIG.ADAPTIVE_REID) return CONFIG.REID_INTERVAL_NORMAL;
    if (this.trend.dropped) return CONFIG.REID_MIN_GAP_ON_DROP;
    // threshold 바로 위(0.608 vs 0.60)에서 안 걸리는 문제가 실제로 있었다.
    // 여유를 둬서 경계에서도 좁힌다.
    const risky =
      this.state === State.WARNING || this.state === State.OCCLUDED
      || this.state === State.REACQUIRING
      || (this.lastReid !== null
          && this.lastReid < this.reidThreshold + CONFIG.REID_RISKY_MARGIN);
    return risky ? CONFIG.REID_INTERVAL_WARNING : CONFIG.REID_INTERVAL_NORMAL;
  }

  /** override 는 적응형 프레임률에서 시간 간격을 유지하려고 쓴다.
   *  (분석 fps 를 20 -> 12 로 낮추면 20프레임은 1.67초가 되어 너무 길다) */
  /** override      정상 상태의 확인 간격 (적응형 프레임률에서 시간 간격 유지용)
   *  riskyGapFloor 위험 상태의 최소 간격. 느린 기기에서 넓힌다 —
   *                5프레임마다 OSNet(165ms)을 부르면 그것만으로 시간을 다 쓴다. */
  shouldMeasureReid(override = null, riskyGapFloor = null) {
    const normal = override ?? this.reidInterval();
    const risky = Math.max(riskyGapFloor ?? 0, this.reidInterval());
    const interval = this.trend.dropped
      ? Math.max(CONFIG.REID_MIN_GAP_ON_DROP, riskyGapFloor ?? CONFIG.REID_MIN_GAP_ON_DROP)
      : (this.state === State.OK ? normal : risky);
    return this.framesSinceReid >= interval || this.trend.dropped;
  }
}

/* =====================================================================
 * 가림 대응 — 모션 예측 (Lv1)
 * ===================================================================== */

/* 칼만 필터를 쓰지 않는다. 칼만은 등속·선형 가정에서 잘 듣는데 농구는
 * 점프하고 급정지하고 방향을 꺾는다. 가정이 깨진 칼만은 자신 있게 틀린
 * 위치를 내놓아서 단순 이동 평균보다 나쁘다. 불확실성을 감쇠로 표현한다. */
export class OcclusionMemory {
  constructor() { this.vel = []; this.frozen = 0; this.lastBox = null; }

  observe(box) {
    if (this.lastBox) {
      this.vel.push({
        dx: (box.x + box.width / 2) - (this.lastBox.x + this.lastBox.width / 2),
        dy: (box.y + box.height / 2) - (this.lastBox.y + this.lastBox.height / 2),
      });
      if (this.vel.length > CONFIG.VELOCITY_WINDOW) this.vel.shift();
    }
    this.lastBox = { ...box };
    this.frozen = 0;
  }

  predict() {
    if (!this.lastBox) return null;
    this.frozen += 1;
    if (this.frozen > CONFIG.OCCLUSION_MAX_FRAMES) return null;   // 포기 -> LOST
    const n = this.vel.length || 1;
    let dx = 0, dy = 0;
    for (const v of this.vel) { dx += v.dx; dy += v.dy; }
    const decay = Math.pow(CONFIG.PREDICTION_DECAY, this.frozen);
    const b = this.lastBox;
    return {
      x: Math.round(b.x + (dx / n) * decay),
      y: Math.round(b.y + (dy / n) * decay),
      width: b.width, height: b.height,
    };
  }
}

/* =====================================================================
 * 후보 랭킹 (Lv2 재획득)
 * ===================================================================== */

/* 옷 색 지문.
 *
 * 예전에는 상체 평균 RGB 한 개만 봤다. 그건 사실상 아무것도 구분하지
 * 못한다 — 체육관 조명 아래에서 남색 유니폼과 검은 유니폼의 평균이
 * 비슷하게 나온다.
 *
 * 대신 **상·하체를 나눠 색상 히스토그램**을 만든다.
 *
 *   상의와 하의를 따로 본다   농구는 상의와 반바지 색이 다른 경우가 많고,
 *                             그 조합이 사람을 가른다
 *   HSV 의 색상(H)을 쓴다     밝기 변화에 덜 흔들린다. 그늘로 들어가도
 *                             색상은 유지된다
 *   채도가 낮으면 무채색으로  흰색·검은색·회색을 색상으로 다루면 노이즈다
 *
 * 이 신호가 필요한 이유: OSNet 은 사람 전체가 보여야 제 성능이 난다.
 * 일부가 가려지면 임베딩이 무너진다. 색 히스토그램은 보이는 부분만으로도
 * 동작한다. 서로 다른 실패 양상을 가진 두 신호를 함께 쓰는 게 핵심이다.
 */

const HUE_BINS = 8;
const GRAY_BINS = 3;          // 어두움 / 중간 / 밝음
const PART_DIMS = HUE_BINS + GRAY_BINS;

function rgbToHsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h, s: mx > 0 ? d / mx : 0, v: mx / 255 };
}

/** 상자 안 한 부분의 색 히스토그램. */
function partHistogram(ctx, box, fromRatio, toRatio, scratch) {
  const W = 16, H = 16;
  const c = scratch.canvas, g = scratch.ctx;
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }

  const sy = box.y + box.height * fromRatio;
  const sh = Math.max(1, box.height * (toRatio - fromRatio));
  const sx = Math.max(0, box.x);
  const sw = Math.max(1, box.width);
  try {
    g.clearRect(0, 0, W, H);
    g.drawImage(ctx.canvas, sx, sy, sw, sh, 0, 0, W, H);
  } catch { return null; }

  const px = g.getImageData(0, 0, W, H).data;
  const hist = new Float32Array(PART_DIMS);
  let total = 0;
  for (let i = 0; i < px.length; i += 4) {
    const { h, s, v } = rgbToHsv(px[i], px[i + 1], px[i + 2]);
    /* 채도가 낮으면 색상이 의미 없다. 흰 유니폼과 검은 유니폼을 색상으로
     * 구분하려 들면 노이즈만 담긴다. 밝기 구간으로 따로 센다. */
    if (s < 0.18) hist[HUE_BINS + Math.min(GRAY_BINS - 1, Math.floor(v * GRAY_BINS))] += 1;
    else hist[Math.min(HUE_BINS - 1, Math.floor(h * HUE_BINS))] += 1;
    total++;
  }
  if (!total) return null;
  for (let i = 0; i < hist.length; i++) hist[i] /= total;
  return hist;
}

let colorScratch = null;
function getColorScratch() {
  if (!colorScratch) {
    const canvas = document.createElement('canvas');
    colorScratch = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }) };
  }
  return colorScratch;
}

/** 상·하체 색 지문. 실패하면 null. */
export function jerseyColor(ctx, box) {
  if (!box || box.width < 4 || box.height < 8) return null;
  const scratch = getColorScratch();
  // 머리와 발끝은 뺀다. 배경과 바닥이 섞여 신호를 흐린다.
  const head = partHistogram(ctx, box, 0.0, 0.23, scratch);
  const upper = partHistogram(ctx, box, 0.15, 0.55, scratch);
  const lower = partHistogram(ctx, box, 0.55, 0.92, scratch);
  if (!upper || !lower) return null;
  return { head, upper, lower };
}

/* 히스토그램 교집합. 0~1 이고 1이면 같다.
 * Bhattacharyya 도 흔히 쓰지만 교집합이 더 싸고 이 용도에서는 차이가 없다. */
function histIntersect(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.min(a[i], b[i]);
  return sum;
}

function colorSim(a, b) {
  if (!a || !b) return 0.5;      // 알 수 없으면 중립
  // 상의를 더 무겁게 본다. 하의는 바닥·그림자와 섞이기 쉽다.
  const body = 0.62 * histIntersect(a.upper, b.upper)
             + 0.38 * histIntersect(a.lower, b.lower);
  // Descriptors saved before the helmet/head band remain valid.
  if (!a.head || !b.head) return body;
  return 0.22 * histIntersect(a.head, b.head)
       + 0.50 * histIntersect(a.upper, b.upper)
       + 0.28 * histIntersect(a.lower, b.lower);
}

export { colorSim };

/** 후보 여러 명 중 우리 대상 고르기.
 *
 * 수락 조건이 AND 다 — 종합 점수가 높아도 Re-ID 가 최소선 미만이면 거부한다.
 * 다른 근거로 Re-ID 를 상쇄하지 못하게 한 것이다 (reid_veto 와 같은 원칙).
 *
 * 1등과 2등 차가 작으면 찍지 않고 사용자에게 묻는다 (Lv4).
 */
export function rankCandidates(cands, ctx, anchors, prediction, prevBox, diag) {
  const cw = CONFIG.CANDIDATE_WEIGHTS;
  const wReid = cw.reid ?? 0.55, wDist = cw.distance ?? 0.2;
  const wSize = cw.size ?? 0.15, wJersey = cw.jersey ?? 0.1;
  const anchorColor = anchors.color;

  const scored = cands.map((c) => {
    const reid = c.embedding
      ? Math.max(...anchors.embeddings.map((a) => cosine(a, c.embedding) ?? -1))
      : -1;

    let dist = 0.5;
    const ref = prediction || prevBox;
    if (ref) {
      const dx = (c.box.x + c.box.width/2) - (ref.x + ref.width/2);
      const dy = (c.box.y + c.box.height/2) - (ref.y + ref.height/2);
      dist = 1 - Math.min(1, Math.sqrt(dx*dx + dy*dy) / Math.max(diag * 0.25, 1e-6));
    }

    let size = 0.5;
    if (prevBox) {
      const r = (c.box.width * c.box.height) / Math.max(prevBox.width * prevBox.height, 1);
      size = 1 - Math.min(1, Math.abs(Math.log(Math.max(r, 1e-6))) / Math.log(4));
    }

    const jersey = CONFIG.USE_JERSEY_COLOR
      ? colorSim(anchorColor, jerseyColor(ctx, c.box)) : 0.5;

    const score = wReid * Math.max(0, reid) + wDist * dist
                + wSize * size + wJersey * jersey;
    return { ...c, reid, dist, size, jersey, score };
  }).sort((a, b) => b.score - a.score);

  if (!scored.length) {
    return {
      accepted: null, ambiguous: false, cause: Cause.DETECTOR_FAILURE, scored,
      gap: null, marginComparable: false,
    };
  }

  const top = scored[0];
  /* 같은 사람의 중복 검출은 2등으로 세지 않는다. 후보가 하나이거나
   * 나머지가 전부 같은 상자면 마진은 비교 불가 — 가짜 gap=1 로
   * "분명하다"고 쓰지 않는다. */
  const rival = scored.slice(1).find((c) => iou(c.box, top.box) < 0.55) ?? null;
  const marginComparable = rival !== null;
  const gap = marginComparable ? top.score - rival.score : null;
  if (marginComparable && gap < CONFIG.CANDIDATE_AMBIGUOUS_MARGIN) {
    return {
      accepted: null, ambiguous: true, cause: Cause.SIMILAR_APPEARANCE, scored,
      gap, marginComparable,
    };
  }
  const ok = top.score >= CONFIG.REACQUIRE_ACCEPT_SCORE
          && top.reid >= CONFIG.REACQUIRE_MIN_REID;
  return {
    accepted: ok ? top : null,
    ambiguous: false,
    cause: ok ? null : Cause.REID_FAILURE,
    scored, gap, marginComparable,
  };
}

/** 확정한 대상이 있을 때만, 그와 겹치지 않는 탈락 후보를 남으로 기억한다.
 * 아무도 확정하지 못한 후보를 전부 distractor 로 넣지 않는다. */
export function rememberRejectedAsOthers(anchors, scored, accepted) {
  if (!accepted || !anchors || !scored?.length) return 0;
  const accBox = accepted.box ?? accepted.det?.box;
  let n = 0;
  for (const c of scored) {
    if (c === accepted) continue;
    const emb = c.embedding ?? c.emb;
    if (!emb) continue;
    const box = c.box ?? c.det?.box;
    if (accBox && box && iou(accBox, box) >= 0.5) continue;
    anchors.addDistractor(emb);
    n += 1;
  }
  return n;
}

/** 연관: 기준 대비 Re-ID가 있고, 상대 비교 또는 강한 옷 색이 받쳐 준다.
 * 중복 상자 rival 은 호출 쪽에서 제외한다. 가짜 gap=1 은 쓰지 않는다. */
export function associationIdentityOk(best, rival, scoreGap, reidThreshold) {
  if (!best) return false;
  if (best.self < reidThreshold - CONFIG_COLOR_RESCUE_SLACK) return false;
  if (!(best.relative >= 0.50 || (best.jersey ?? 0) >= CONFIG_COLOR_STRONG)) return false;
  if (rival && scoreGap !== null && scoreGap < 0.05) return false;
  return true;
}

/** 관측된 옷 색이 골짜기(0.42) 아래면 재획득 수락을 막는다.
 * 값을 안 쟀으면 거부하지 않는다. 같은 유니폼(높은 색)은 여기로 안 걸린다. */
export function clothingHardVeto(jersey) {
  if (jersey == null || Number.isNaN(jersey)) return false;
  return jersey < CONFIG_COLOR_VETO;
}

/** 1·2등이 옷/외형으로 거의 같으면 위치만으로 동일인을 증명할 수 없다. */
export function rivalsLookAlike(rank) {
  const a = rank?.scored?.[0];
  const b = rank?.scored?.[1];
  if (!a || !b) return false;
  const boxA = a.box ?? a.det?.box;
  const boxB = b.box ?? b.det?.box;
  if (boxA && boxB && iou(boxA, boxB) >= 0.55) return false;
  const ja = a.jersey, jb = b.jersey;
  if (ja != null && jb != null && Math.abs(ja - jb) < 0.10) return true;
  const ra = a.reid, rb = b.reid;
  if (ra != null && rb != null && Math.abs(ra - rb) < 0.08) return true;
  return false;
}

/* =====================================================================
 * 앵커 — Identity Poisoning 방지
 * ===================================================================== */

/* 가장 위험한 실패 모드다. 틀린 대상을 앵커로 저장하면 그때부터 시스템이
 * 틀린 사람을 "본인" 으로 확신한다. 그 뒤로는 정상 동작이 전부 오작동이 된다.
 *
 * 그래서 사용자가 확인한 프레임만 앵커가 될 수 있다. 자동 갱신은 기본 꺼짐. */
export class IdentityMemory {
  constructor() {
    this.embeddings = [];
    this.color = null;
    this.stable = 0;
    /* 다른 사람들의 임베딩.
     *
     * 지금까지는 "나" 만 기억했다. 그러면 판단이 항상 절대값 비교가 된다 —
     * "앵커와 0.55 니까 애매하다". 사람이 몸을 돌리거나 조명이 바뀌면
     * 진짜 나도 0.55 가 나오고, 옆 사람도 0.55 가 나온다. 구분이 안 된다.
     *
     * 옆 사람을 함께 기억하면 상대 비교가 된다.
     *   나와 0.55, 저 사람과 0.78  ->  이건 저 사람이다. 확실하다.
     *   나와 0.55, 저 사람과 0.31  ->  이건 나다. 자세가 바뀐 것뿐이다.
     *
     * DeepSORT 계열이 쓰는 방식이고, 사람이 겹쳤다 갈라지는 순간에
     * 결정적으로 작동한다. 비용은 벡터 몇 개의 내적뿐이다. */
    this.distractors = [];
    /* "최근의 나" — 조명과 자세 변화를 따라가는 앵커 하나.
     *
     * 확인 앵커(embeddings)를 지우지 않고 하나 더 두는 방식이다. 적응이
     * 잘못돼도 사용자가 확인한 사실은 그대로 남는다. */
    this.adaptive = null;
    this.adaptCount = 0;
    /* 각도 앵커 — 앞·옆·뒤. 사람은 돌면 다르게 생겼고, 앵커도 그만큼
     * 있어야 한다. 확인 앵커(embeddings)와 따로 둔다: 이쪽은 위치가
     * 보증했을 뿐 사용자가 확인한 것은 아니다. */
    this.views = [];
    this.viewCount = 0;
  }

  /** "이 사람은 내가 아니다" 를 기억한다. 재획득에서 탈락한 후보들이다. */
  addDistractor(embedding) {
    if (!embedding) return;
    if (this.distractors.length >= CONFIG_MAX_DISTRACTORS) this.distractors.shift();
    this.distractors.push(embedding);
  }

  /** 앵커 중 가장 높은 유사도. */
  scoreSelf(embedding) {
    if (!embedding || !this.embeddings.length) return null;
    let best = -1;
    for (const a of this.embeddings) { const v = cosine(a, embedding); if (v !== null && v > best) best = v; }
    /* 적응 앵커도 함께 본다.
     *
     * 사용자가 확인한 앵커는 처음 그 순간의 모습이다. 조명이 바뀌고 몸이
     * 돌아가면 진짜 대상의 유사도가 내려간다 — 실측에서 17초 뒤 같은
     * 사람이 0.48 까지 갔고, 낯선 사람 최고값 0.715 와 겹쳤다.
     *
     * 적응 앵커는 "최근의 나" 다. 확인 앵커를 지우지 않고 **하나 더**
     * 두는 방식이라, 적응이 잘못돼도 원래 앵커가 그대로 남는다. */
    if (this.adaptive) {
      const v = cosine(this.adaptive, embedding);
      if (v !== null && v > best) best = v;
    }
    /* 각도 앵커 — 앞·옆·뒤.
     *
     * 🔴 이것이 "턴을 돌면 놓친다" 의 해결이다. 실측에서 같은 사람이
     *    뒤로 돌자 유사도가 0.367 까지 떨어졌고, 그때 낯선 사람 최고값이
     *    0.682 였다. 앞모습 하나만 들고 있으면 뒷모습은 남보다도 안 닮는다.
     *
     * 가장 닮은 각도 하나로 판정한다(최댓값). 평균을 쓰면 각도가 늘수록
     * 모든 판정이 흐려진다 — 우리가 묻는 것은 "이 사람이 내가 아는
     * 어떤 모습과 같은가" 이지 "평균적으로 비슷한가" 가 아니다. */
    for (const v0 of this.views) {
      const v = cosine(v0, embedding);
      if (v !== null && v > best) best = v;
    }
    return best;
  }

  /**
   * "이것도 나다" — 새 각도를 앵커로 추가한다.
   *
   * ## 왜 필요한가 — 턴을 돌면 같은 사람이 남보다 안 닮는다
   *
   * 아이스링크 영상에서 대상의 상자를 **고정해 놓고** 잰 값이다
   * (training/appearance/measure_separability.py).
   *
   *     시각    같은 사람   다른 사람 최고(18~20명 중)
   *     0.5s      1.000        0.701     가른다
   *    20.0s      0.986        0.706     가른다
   *    24.0s      0.976        0.703     가른다
   *    32.0s      0.367        0.682     🔴 못 가른다
   *    36.0s      0.530        0.680     🔴 못 가른다
   *
   * 32초에 사람이 바뀐 것이 아니다. **그 사람이 뒤로 돌았다.** 앞모습
   * 하나를 앵커로 들고 있으면 뒷모습은 남보다도 안 닮는다.
   *
   * 그 순간 시스템은 "다른 사람이 더 닮았다" 고 판단하고 복구를 돌려
   * 진짜 남을 고른다. 사용자가 말한 "제자리에서 턴을 도는데 카메라가
   * 갑자기 다른 사람을 쫓아간다" 가 정확히 이 경로다.
   *
   * ## 그래서 각도를 모은다
   *
   * 사람은 앞·옆·뒤가 다르게 생겼다. 앵커도 그만큼 있어야 한다.
   *
   * ## 🔴 언제 추가해도 되는가 — 위치가 보증할 때만
   *
   * 외형이 떨어졌다는 사실만으로는 "돌았다" 와 "남을 잡았다" 를 못
   * 가른다. 가르는 것은 **위치**다.
   *
   *   제자리에 있었고 + 그 자리에 검출이 있었다
   *     -> 우리는 여전히 사람 위에 있고, 순간이동은 없었다
   *     -> 그 사람은 우리다. 달라진 것은 각도다
   *
   * 이 조건 없이 추가하면 그것이 Identity Poisoning 이다.
   */
  addView(embedding) {
    if (!embedding) return false;
    if (this.views.length >= CONFIG_MAX_VIEWS) this.views.shift();
    this.views.push(embedding);
    this.viewCount += 1;
    return true;
  }

  /**
   * 최근 모습을 조금 반영한다 — 근거가 확실할 때만.
   *
   * 🔴 여기가 Identity Poisoning 을 막는 자리다. 세 조건을 **모두**
   *    만족해야 한다.
   *
   *   1. 확인 앵커와 충분히 닮았다        안 닮았으면 갱신 대상이 아니라
   *                                       다른 사람일 가능성이다
   *   2. 낯선 사람들보다 확실히 더 닮았다  옆 사람을 잡고 있는 프레임에서
   *                                       갱신하면 되돌릴 수 없다
   *   3. 이 영상에서 외형이 쓸 만하다      appearanceWeak 면 부르지 않는다
   *      (부르는 쪽이 판단한다)
   *
   * 갱신량은 여유(margin)에 비례한다. 문턱을 갓 넘은 프레임이 앵커를
   * 크게 흔들면 안 된다 — 문턱 근처가 바로 헷갈리는 자리다.
   */
  adapt(embedding, { self, other, floor }) {
    if (!embedding || self === null || self === undefined) return false;
    if (self < floor) return false;
    if (other !== null && other !== undefined && self - other < CONFIG_DISTRACTOR_MARGIN) {
      return false;
    }
    const margin = Math.min(1, Math.max(0, (self - floor) / Math.max(1e-6, 1 - floor)));
    const rate = ADAPT_MAX_RATE * margin;
    if (rate <= 1e-4) return false;

    this.adaptive = this.adaptive
      ? adaptAnchor(this.adaptive, embedding, rate)
      : embedding;
    this.adaptCount += 1;
    return true;
  }

  /** 다른 사람 중 가장 높은 유사도. 없으면 null. */
  scoreOther(embedding) {
    if (!embedding || !this.distractors.length) return null;
    let best = -1;
    for (const d of this.distractors) { const v = cosine(d, embedding); if (v !== null && v > best) best = v; }
    return best;
  }

  /* 이 사람이 "나" 인지 판정한다.
   *
   * 두 가지를 함께 본다. 서로 다른 상황에서 무너지기 때문이다.
   *   OSNet  사람 전체가 보여야 제 성능이 난다. 일부가 가려지면 무너진다.
   *   옷 색  보이는 부분만으로도 동작한다. 대신 같은 팀 유니폼은 못 가른다.
   *
   * 그래서 한쪽이 애매할 때 다른 쪽이 결정한다.
   *
   * 절대값만 보지 않는다는 원칙은 그대로다 — 다른 사람과 더 닮았으면
   * 나와의 유사도가 얼마든 그건 내가 아니다. */
  verdict(embedding, threshold, color = null) {
    const self = this.scoreSelf(embedding);
    const other = this.scoreOther(embedding);
    const colorScore = (color && this.color) ? colorSim(this.color, color) : null;

    if (self === null) {
      return { isSelf: true, self: null, other, color: colorScore, reason: 'no_anchor' };
    }
    if (other !== null && other > self + CONFIG_DISTRACTOR_MARGIN) {
      /* 웹 Re-ID(HilitAppearance)가 이미 색 분포다. 남이 더 닮았는데
       * 옷 색으로 다시 살리면 같은 유니폼 동료를 나로 확정한다. */
      return { isSelf: false, self, other, color: colorScore, reason: 'other_is_closer' };
    }
    if (self >= threshold) {
      return { isSelf: true, self, other, color: colorScore, reason: 'ok' };
    }
    /* 절대값이 기준 아래일 때만 색으로 보완한다. 남이 더 닮은 경우는
     * 위에서 이미 거절했다. 색과 서술자가 같은 신호라 구제 폭은 좁다. */
    if (colorScore !== null && colorScore >= CONFIG_COLOR_STRONG
        && self >= threshold - CONFIG_COLOR_RESCUE_SLACK
        && (other === null || self >= other)) {
      return { isSelf: true, self, other, color: colorScore, reason: 'color_rescued' };
    }
    return { isSelf: false, self, other, color: colorScore, reason: 'below_threshold' };
  }

  add(embedding, color, { confirmedByUser = false } = {}) {
    if (!confirmedByUser) {
      throw new Error('앵커는 사용자가 확인한 프레임만 될 수 있습니다 (Identity Poisoning 방지)');
    }
    if (!embedding) return false;
    if (this.embeddings.length >= CONFIG.AUTO_ANCHOR_MAX_COUNT) this.embeddings.shift();
    this.embeddings.push(embedding);
    if (color) this.color = color;
    return true;
  }

  /** 자동 갱신. 기본으로 꺼져 있고, 켜도 조건 넷을 다 넘어야 한다. */
  maybeAutoUpdate(embedding, color, sig, neighbors) {
    if (!CONFIG.AUTO_ANCHOR_UPDATE) return false;
    if (sig.trackerConfidence < CONFIG.AUTO_ANCHOR_MIN_TRACKER_CONF) { this.stable = 0; return false; }
    if ((sig.reidSimilarity ?? 0) < CONFIG.AUTO_ANCHOR_MIN_REID) { this.stable = 0; return false; }
    // 다른 사람과 겹친 상태에서는 confidence 가 아무리 높아도 앵커로 삼지 않는다.
    for (const nb of neighbors || []) {
      if (iou(sig.box, nb) > CONFIG.AUTO_ANCHOR_MAX_NEIGHBOR_IOU) { this.stable = 0; return false; }
    }
    this.stable += 1;
    if (this.stable < CONFIG.AUTO_ANCHOR_STABLE_FRAMES) return false;
    this.stable = 0;
    if (this.embeddings.length >= CONFIG.AUTO_ANCHOR_MAX_COUNT) this.embeddings.shift();
    this.embeddings.push(embedding);
    if (color) this.color = color;
    return true;
  }
}

/* =====================================================================
 * ID Switch Hysteresis
 * ===================================================================== */

export class SwitchGuard {
  constructor() { this.streak = 0; }
  /** 한 프레임 신호로 대상을 갈아타지 않는다. 3프레임 연속 + 마진 0.12. */
  consider(candidateReid, currentReid) {
    if (candidateReid > currentReid + CONFIG.REID_SWITCH_MARGIN) this.streak += 1;
    else this.streak = 0;
    if (this.streak >= CONFIG.SWITCH_CONFIRM_FRAMES) { this.streak = 0; return true; }
    return false;
  }
}

/** 실패 원인 분류. threshold 를 낮춰 넘기는 대응을 막기 위한 것이다 —
 *  실패하면 원인을 남겨야 한다. */
export function classifyFailure(result, sig, candCount) {
  if (sig.occluded) return Cause.OCCLUSION;
  if (result.notes.includes('out_of_frame') || result.notes.includes('no_box')) return Cause.TARGET_EXIT;
  if (candCount === 0) return Cause.DETECTOR_FAILURE;
  if (result.notes.includes('centroid_jump')) return Cause.FAST_MOTION;
  if (result.notes.includes('reid_veto')) return Cause.REID_FAILURE;
  if (result.ambiguityScore < 0.5) return Cause.SIMILAR_APPEARANCE;
  return Cause.UNKNOWN;
}
