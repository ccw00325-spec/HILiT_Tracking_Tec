/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·198ee0c7 @license @preserve */
/**
 * 운영 추적 설정 적용 — 연구실(연구실)의 판정 문턱·학습된 판정기로 추적 상태를 다시 매긴다 (0079, 2026-09-26).
 *
 * 사용자 결정(A-1): 가중치 담당자가 연구실에서 「운영에 적용」을 누르면 웹·APK 의 판정이 바로 바뀐다.
 * 웹과 APK 는 추적이 끝날 때 /api/tracking/profile 로 켜진 설정을 받아 이 함수로 상태만 다시 매긴다.
 *
 * 🔴 2026-10-03 사용자 결정 — **봉인 시험을 통과한 판정기(sealedPass)만** 운영에서 상태를 다시 매긴다. 실시간 학습은 하지 않고,
 *    연구실이 매일 학습한 판정기를 봉인 holdout 에서 지금 제품과 견줘 문턱(틀린 정상 −20% 이상, 맞게 따라감 −5%p 이내)을
 *    넘을 때만 gates.sealed.pass=true 로 운영에 올린다. 통과하지 못한 판정기는 아래 9-28 결정대로 기록만 한다.
 *
 * 🔴 2026-09-28 사용자 결정 — **운영에서는 상태를 다시 매기지 않는다.** 연구실은 추적·외형 확인이 얼마나 정확한지
 *    재는 곳이어야 하고, 카메라 움직임(사용자가 보는 화면)에 영향을 주면 안 된다. 상태를 바꾸면 궤적 다듬기·따라가기
 *    카메라·확인 구간이 모두 달라진다(실측: v3 을 실사 23편에 적용하자 「주의」 584점이 「정상」이 되고, 정답 기준 틀린
 *    정상이 21→36). 그래서 운영 경로는 auditProductionProfile 로 **판정 결과를 세어 기록만** 한다.
 *    applyProductionProfile 은 연구실 평가·시험(같은 규칙인지 대조)에만 쓴다.
 *
 * 무엇을 바꾸나
 *   - 상자 위치(bbox)·시각·신호 값은 그대로 둔다. 상태(state)만 바꾼다. 연구실이 평가하는 방식과 같다.
 *   - 대상은 추적기가 "정상 추적 중"(TRACKING_OK · TRACKING_WARNING)이라고 한 순간뿐이다.
 *     가림·놓침·재획득·사용자 확인·사람이 직접 고친 순간은 추적기의 판단을 그대로 둔다.
 *   - 판정기(quality_head)가 있으면 p_ok 로, 없으면 판정 문턱으로 매긴다.
 *     정상 → TRACKING_OK, 애매 → TRACKING_WARNING, 놓침 → TARGET_LOST.
 *
 * 🔴 특징 계산(featuresAt)과 판정 규칙은 연구실 코드(연구실: lib/research/quality-features.ts ·
 *    quality-head.ts · decision-eval.ts)와 **같아야 한다.** 다르면 연구실에서 평가한 판정기가 운영에서 다른
 *    입력을 받는다. 안드로이드 사본(ProductionProfile.java)과는 같은 시험 자료
 *    (apps/android/app/src/test/resources/production-profile-fixture.json)로 결과가 같은지 대조한다.
 */
import type { NormalizedBBox, TrackingPoint } from '@hilit/shared-types';

export const PRODUCTION_PROFILE_VERSION = 'production-profile-v1';

export interface ProductionThresholds {
  okMinHealth: number;
  okMinConfidence: number;
  okMinReid: number | null;
  uncertainMinHealth: number;
  pOkMin: number;
  pUncertainMin: number;
}

export interface ProductionQualityHead {
  version: string;
  featureVersion: string;
  mean: number[];
  std: number[];
  weights: number[];
  bias: number;
}

export interface ProductionProfile {
  version: number;
  mode: 'thresholds' | 'quality-head';
  thresholds: ProductionThresholds;
  qualityHead: ProductionQualityHead | null;
  /** 봉인 시험을 통과했나(서버 gates.sealed.pass). true 일 때만 운영에서 상태를 다시 매긴다. */
  sealedPass: boolean;
}

/** 운영에서 상태를 다시 매겨도 되나 — 봉인 시험을 통과한 판정기만(2026-10-03). */
export function shouldApplyProductionProfile(profile: ProductionProfile | null): boolean {
  return Boolean(profile && profile.sealedPass && profile.mode === 'quality-head' && profile.qualityHead);
}

/** 궤적의 몇 점에 대한 특징(qf-v1). 사용자 정정 기록이 연구실과 같은 숫자를 보내려고 쓴다. 그림은 쓰지 않는다. */
export function trajectoryFeatures(points: readonly TrackingPoint[], indices: readonly number[]): number[][] {
  const traj: Pt[] = points.map((p) => ({
    t: p.timestamp, state: String(p.state), box: p.bbox,
    confidence: num(p.confidence), health: num(p.tracking_health), reid: num(p.reid_similarity),
    nearbyBoxes: (p as { nearbyBoxes?: NormalizedBBox[] }).nearbyBoxes,
  }));
  return indices.filter((i) => i >= 0 && i < traj.length).map((i) => featuresAt(traj, i));
}

/** 연구실 quality-features.ts 와 같은 순서·이름(qf-v1). */
export const PRODUCTION_FEATURES = [
  'confidence', 'health', 'reid', 'reidMissing', 'reidDropFromStart',
  'healthDrop05', 'areaRatioToStart', 'areaChange05', 'centerSpeed',
  'sizeFrozenSec', 'secSinceStart', 'secInState', 'edgeDistance', 'aspect',
  'nearestOtherDist', 'stateOk', 'stateUncertain',
] as const;
export const PRODUCTION_FEATURE_VERSION = 'qf-v1';

type StateClass = 'OK' | 'UNCERTAIN' | 'LOST';

/** 연구실 review-schema.stateClassOf 와 같다. */
export function stateClassOf(state: string): StateClass {
  if (state === 'TRACKING_OK' || state === 'TRACKING_WARNING') return 'OK';
  if (state === 'TARGET_LOST') return 'LOST';
  return 'UNCERTAIN';
}

interface Pt { t: number; state: string; confidence: number | null; health: number | null; reid: number | null; box: NormalizedBBox; nearbyBoxes?: NormalizedBBox[] }

const area = (b: NormalizedBBox) => Math.max(1e-6, b.width * b.height);
const center = (b: NormalizedBBox) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function indexBefore(traj: readonly Pt[], i: number, dt: number): number {
  let j = i;
  while (j > 0 && traj[i].t - traj[j - 1].t <= dt + 1e-9) j -= 1;
  return j;
}

/** 연구실 quality-features.featuresAt 와 한 줄씩 같다. */
export function featuresAt(traj: readonly Pt[], i: number): number[] {
  const p = traj[i];
  const first = traj[0];
  const back = traj[indexBefore(traj, i, 0.5)];
  const dt = Math.max(1e-3, p.t - back.t);
  const firstReid = traj.find((q) => q.reid !== null && Number.isFinite(q.reid))?.reid ?? null;
  let frozen = 0;
  for (let j = i; j > 0; j -= 1) {
    if (Math.abs(Math.log(area(traj[j].box) / area(traj[j - 1].box))) > 0.02) break;
    frozen = p.t - traj[j - 1].t;
  }
  let inState = 0;
  const cls = stateClassOf(p.state);
  for (let j = i; j > 0; j -= 1) {
    if (stateClassOf(traj[j - 1].state) !== cls) break;
    inState = p.t - traj[j - 1].t;
  }
  const c = center(p.box);
  const cb = center(back.box);
  let nearest = 1;
  for (const o of p.nearbyBoxes ?? []) {
    const oc = center(o);
    nearest = Math.min(nearest, Math.hypot(oc.x - c.x, oc.y - c.y));
  }
  const f: Record<(typeof PRODUCTION_FEATURES)[number], number> = {
    confidence: p.confidence ?? 0,
    health: p.health ?? 0,
    reid: p.reid ?? 0,
    reidMissing: p.reid === null || !Number.isFinite(p.reid) ? 1 : 0,
    reidDropFromStart: firstReid !== null && p.reid !== null ? firstReid - p.reid : 0,
    healthDrop05: (back.health ?? 0) - (p.health ?? 0),
    areaRatioToStart: Math.log(area(p.box) / area(first.box)),
    areaChange05: Math.abs(Math.log(area(p.box) / area(back.box))),
    centerSpeed: Math.hypot(c.x - cb.x, c.y - cb.y) / dt,
    sizeFrozenSec: frozen,
    secSinceStart: p.t - first.t,
    secInState: inState,
    edgeDistance: Math.min(p.box.x, p.box.y, 1 - p.box.x - p.box.width, 1 - p.box.y - p.box.height),
    aspect: p.box.height / Math.max(1e-6, p.box.width),
    nearestOtherDist: nearest,
    stateOk: cls === 'OK' ? 1 : 0,
    stateUncertain: cls === 'UNCERTAIN' ? 1 : 0,
  };
  return PRODUCTION_FEATURES.map((k) => f[k]);
}

const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

/** 연구실 quality-head.predict 와 같다. */
export function predictOk(head: ProductionQualityHead, x: readonly number[]): number {
  let z = head.bias;
  for (let j = 0; j < x.length; j += 1) z += head.weights[j] * ((x[j] - head.mean[j]) / (head.std[j] || 1));
  return sigmoid(z);
}

/** 연구실 decision-eval.decideByThresholds 와 같다. */
export function decideByThresholds(p: { health: number | null; confidence: number | null; reid: number | null }, th: ProductionThresholds): StateClass {
  const h = p.health ?? 0;
  const c = p.confidence ?? 0;
  const reidOk = th.okMinReid === null || p.reid === null || p.reid >= th.okMinReid;
  if (h >= th.okMinHealth && c >= th.okMinConfidence && reidOk) return 'OK';
  if (h >= th.uncertainMinHealth) return 'UNCERTAIN';
  return 'LOST';
}

/** 연구실 decision-eval.decideByQualityHead 와 같다. */
export function decideByQualityHead(pOk: number, th: ProductionThresholds): StateClass {
  if (pOk >= th.pOkMin) return 'OK';
  if (pOk >= th.pUncertainMin) return 'UNCERTAIN';
  return 'LOST';
}

const STATE_OF: Record<StateClass, string> = { OK: 'TRACKING_OK', UNCERTAIN: 'TRACKING_WARNING', LOST: 'TARGET_LOST' };

/** 서버 JSON 을 검사한다. 모양이 틀리면 null — 그때는 추적기 판단을 그대로 쓴다. */
export function parseProductionProfile(raw: unknown): ProductionProfile | null {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  const th = o.thresholds as Record<string, unknown> | undefined;
  const need = ['okMinHealth', 'okMinConfidence', 'uncertainMinHealth', 'pOkMin', 'pUncertainMin'];
  if (!th || need.some((k) => num(th[k]) === null)) return null;
  const thresholds: ProductionThresholds = {
    okMinHealth: num(th.okMinHealth)!, okMinConfidence: num(th.okMinConfidence)!, okMinReid: num(th.okMinReid),
    uncertainMinHealth: num(th.uncertainMinHealth)!, pOkMin: num(th.pOkMin)!, pUncertainMin: num(th.pUncertainMin)!,
  };
  let qualityHead: ProductionQualityHead | null = null;
  const q = (o.qualityHead ?? o.quality_head) as Record<string, unknown> | null | undefined;
  if (q && typeof q === 'object') {
    const arr = (v: unknown) => (Array.isArray(v) && v.length === PRODUCTION_FEATURES.length && v.every((x) => num(x) !== null) ? (v as number[]) : null);
    const mean = arr(q.mean); const std = arr(q.std); const weights = arr(q.weights);
    if (!mean || !std || !weights || num(q.bias) === null || q.featureVersion !== PRODUCTION_FEATURE_VERSION) return null;
    qualityHead = { version: String(q.version ?? ''), featureVersion: PRODUCTION_FEATURE_VERSION, mean, std, weights, bias: num(q.bias)! };
  }
  const mode = o.mode === 'quality-head' && qualityHead ? 'quality-head' : 'thresholds';
  return { version: num(o.version) ?? 0, mode, thresholds, qualityHead: mode === 'quality-head' ? qualityHead : null, sealedPass: o.sealedPass === true };
}

/**
 * 운영 설정으로 상태를 다시 매긴 새 점 목록. 원본은 바꾸지 않는다.
 * 특징은 추적기가 낸 원래 상태로 계산한다(연구실이 판정기를 학습·평가한 입력과 같게).
 */
export interface ProductionProfileAudit {
  /** 판정한 점(추적기가 정상·주의라 한 점). */
  judged: number;
  /** 추적기 상태와 같게 매긴 점. */
  agree: number;
  toOk: number;
  toWarning: number;
  toLost: number;
}

/**
 * 운영 경로용 — 점은 바꾸지 않고, 연구실 판정기가 추적기와 얼마나 다르게 봤는지만 센다(2026-09-28).
 * 이 수치는 기록일 뿐 카메라·확인 구간·궤적 어디에도 들어가지 않는다.
 */
export function auditProductionProfile(points: readonly TrackingPoint[], profile: ProductionProfile | null): ProductionProfileAudit | null {
  if (!profile || !points.length) return null;
  const judged = applyProductionProfile(points, profile);
  const audit: ProductionProfileAudit = { judged: 0, agree: 0, toOk: 0, toWarning: 0, toLost: 0 };
  points.forEach((p, i) => {
    if (p.state !== 'TRACKING_OK' && p.state !== 'TRACKING_WARNING') return;
    if ((p as { manual?: boolean }).manual) return;
    audit.judged += 1;
    const next = judged[i].state;
    if (next === p.state) audit.agree += 1;
    else if (next === 'TRACKING_OK') audit.toOk += 1;
    else if (next === 'TRACKING_WARNING') audit.toWarning += 1;
    else audit.toLost += 1;
  });
  return audit;
}

/** 연구실 평가·시험 전용 — 운영 경로(웹 후처리·APK)에서 부르지 않는다(위 🔴 2026-09-28). */
export function applyProductionProfile<T extends TrackingPoint>(points: readonly T[], profile: ProductionProfile | null): T[] {
  if (!profile || !points.length) return [...points];
  const traj: Pt[] = points.map((p) => ({
    t: p.timestamp, state: String(p.state), box: p.bbox,
    confidence: num(p.confidence), health: num(p.tracking_health), reid: num(p.reid_similarity),
    nearbyBoxes: (p as { nearbyBoxes?: NormalizedBBox[] }).nearbyBoxes,
  }));
  return points.map((p, i) => {
    if (p.state !== 'TRACKING_OK' && p.state !== 'TRACKING_WARNING') return p;
    if ((p as { manual?: boolean }).manual) return p;
    const cls = profile.mode === 'quality-head' && profile.qualityHead
      ? decideByQualityHead(predictOk(profile.qualityHead, featuresAt(traj, i)), profile.thresholds)
      : decideByThresholds(traj[i], profile.thresholds);
    const next = STATE_OF[cls];
    return next === p.state ? p : { ...p, state: next };
  });
}
