/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·686b4d23 @license @preserve */
import { cosine } from './models.js';
import { planDetectorSearch, productMayApplyIdentity } from './detector-stage2.js';

const center = b => [b.x + b.width / 2, b.y + b.height / 2];
const distance = (a, b) => {
  const x = center(a), y = center(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1]) / Math.max(24, a.height, b.height);
};
const overlap = (a, b) => {
  const w = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return w * h / Math.max(1, a.width * a.height + b.width * b.height - w * h);
};

// Square recovery views preserve body proportions. Rotate through at most
// three views per scan so even panoramic inputs have bounded inference work.
export function recoveryRegions(width, height) {
  if (!(width > 0 && height > 0)) return [];
  const side = Math.min(width, height), span = Math.max(width, height) - side;
  const steps = Math.max(1, Math.ceil(span / (side * .75)));
  return Array.from({ length: span ? steps + 1 : 1 }, (_, i) => ({
    x: width >= height ? span * i / steps : 0,
    y: height > width ? span * i / steps : 0, width: side, height: side,
  }));
}

/** Observation-led experiment. The user seed is immutable. Appearance scores
 * are heuristic evidence, never calibrated identity probabilities. */
export async function trackObserved(pipe, rawBox, options = {}) {
  const m = pipe.meta;
  if (!m) throw new Error('Open a video before tracking');
  const box = { x: Number(rawBox.x), y: Number(rawBox.y),
    width: Number(rawBox.width ?? rawBox.w), height: Number(rawBox.height ?? rawBox.h) };
  if (!Object.values(box).every(Number.isFinite) || box.width < 1 || box.height < 1)
    throw new Error('Invalid tracking box');
  await pipe.loadModels();
  const { tracker, reid, personDetector } = pipe.models;
  const fps = Math.max(12, Math.min(30, options.adaptiveFps || 12));
  const start = Math.max(0, Math.min(options.startTime || 0, m.duration - .001));
  const end = options.endTime > start ? Math.min(m.duration, options.endTime) : m.duration;
  /* 0초 시작: currentTime 이 이미 0 이면 seekDraw 가 seek·프레임 대기를 건너뛰고 바로 그린다.
   * 첫 장이 아직 디코딩 전이면 빈 캔버스라 서술자가 비고, 예전에는 여기서 예외로 멈췄다
   * (2026-09-24 감사: 22편 중 16편). 기본 엔진처럼 두 번 그리고, 비면 프레임이 실제로
   * 표시될 때까지 기다렸다가 최대 3번 다시 읽는다. 추적기는 서술자를 읽은 그 캔버스로 연다. */
  let ctx = await pipe.seekDraw(start);
  ctx = await pipe.seekDraw(start);
  let seed = await reid.embed(ctx, box);
  for (let retry = 0; !seed && retry < 3; retry++) {
    if (typeof pipe._framePresented === 'function') await pipe._framePresented();
    ctx = await pipe.seekDraw(start);
    seed = await reid.embed(ctx, box);
  }
  if (!seed) throw new Error('선택 영역에서 외형을 읽을 수 없습니다. 사람 전체를 다시 선택해 주세요.');
  await tracker.init(ctx, box, start);
  let lastBox = { ...box }, lastObserved = start, lastDetection = -Infinity;
  let pending = null, streak = 0, riskStart = null, priorRisk = false;
  let lastGlobal = -Infinity, regionCursor = 0;
  const globalRegions = recoveryRegions(m.width, m.height);
  let detectorGap = 999;
  // Keep the deliberately conservative ablation available for reproducibility.
  const strictRecovery = options.recoveryPolicy === 'strict';
  const trajectory = [], doubtSpans = [], trace = [];
  let detectorCalls = 0, reidCalls = 1, corrections = 0, scaleUpdates = 0;
  const began = performance.now(), total = Math.ceil((end - start) * fps);
  for (let i = 0; i <= total; i++) {
    if (options.signal?.aborted) throw new DOMException('Tracking aborted', 'AbortError');
    const t = Math.min(start + i / fps, end - .001);
    if (i && t <= trajectory.at(-1).t) break;
    ctx = await pipe.seekDraw(t);
    const up = i ? await tracker.update(ctx, t) : { box, confidence: 1 };
    const emb = i ? await reid.embed(ctx, up.box) : seed;
    if (i) reidCalls++;
    const self = cosine(seed, emb) ?? 0;
    let chosen = { ...up.box }, verified = i === 0, ambiguous = false;
    const validLocal = self >= .68 && up.confidence >= .55;
    const recovering = priorRisk || !validLocal || t - lastObserved > 1.5;
    const trigger = recovering ? 'lost' : (validLocal ? 'interval' : 'degraded');
    const plan = planDetectorSearch({
      trigger,
      framesSinceDetector: detectorGap,
      lastBox,
      frameW: m.width,
      frameH: m.height,
    });
    if (plan.run) {
      let detections = [];
      if (personDetector?.proposeFromCanvas && ctx?.canvas) {
        const firstRegion = plan.scope === 'near-then-expand-then-full'
          ? (plan.near || plan.region)
          : plan.scope === 'region-then-full' ? plan.region : null;
        let run = personDetector.proposeFromCanvas(ctx.canvas, {
          timestamp: t,
          region: firstRegion,
        });
        detectorCalls++;
        if ((plan.scope === 'near-then-expand-then-full' || plan.scope === 'region-then-full')
            && !(run?.proposals || []).length) {
          if (plan.scope === 'near-then-expand-then-full' && plan.region) {
            run = personDetector.proposeFromCanvas(ctx.canvas, { timestamp: t, region: plan.region });
            detectorCalls++;
          }
          if (!(run?.proposals || []).length) {
            run = personDetector.proposeFromCanvas(ctx.canvas, { timestamp: t });
            detectorCalls++;
          }
        }
        detections = (run.proposals || []).map((p) => ({
          box: { x: p.x, y: p.y, width: p.width, height: p.height },
          score: p.detectorScore,
        }));
      }
      detectorGap = 0;
      lastDetection = t;
      const scored = [];
      for (const d of detections) {
        const e = await reid.embed(ctx, d.box); reidCalls++;
        const appearance = cosine(seed, e) ?? 0;
        const motion = Math.exp(-distance(lastBox, d.box) * 2);
        scored.push({ ...d, appearance,
          rank: recovering ? appearance : appearance * .82 + motion * .18 });
      }
      scored.sort((a, b) => b.rank - a.rank);
      const best = scored[0], second = scored.find(d => best && overlap(d.box, best.box) < .25);
      // Two bad matches do not imply an identity conflict. A real alternative
      // must resemble the seed before it can veto a valid local continuation.
      ambiguous = !!(best && second && best.appearance >= .66
        && second.appearance >= .60 && best.rank - second.rank < .065);
      // Low-score boxes can continue a nearby track, but cannot independently
      // trigger a distant identity transfer.
      const acceptable = best && best.appearance >= (recovering && strictRecovery ? .76 : .66) && !ambiguous
        && (best.score >= .35 || (!recovering && distance(lastBox, best.box) < .75));
      const allowApply = options.detectorReacquire === true && productMayApplyIdentity();
      if (allowApply && acceptable) {
        streak = pending && distance(pending, best.box) < .65 ? streak + 1 : 1;
        pending = best.box;
        // Two independent detector timestamps confirm relocation and scale.
        if (streak >= (recovering && strictRecovery ? 3 : 2)) {
          verified = true;
          const agrees = overlap(best.box, up.box) > .35;
          chosen = agrees ? {
            x: up.box.x * .35 + best.box.x * .65, y: up.box.y * .35 + best.box.y * .65,
            width: up.box.width * .35 + best.box.width * .65,
            height: up.box.height * .35 + best.box.height * .65,
          } : { ...best.box };
          if (!agrees) corrections++;
          // Observed full-body scale changes can exceed the initial size band.
          // Do not move the band on single-frame partial detections.
          const ratio = chosen.height / Math.max(1, tracker.h0);
          if (ratio > 1.45 || ratio < .72) {
            tracker.w0 = chosen.width; tracker.h0 = chosen.height; scaleUpdates++;
          }
          tracker.reposition(chosen, { trustSize: true });
          lastObserved = t;
        }
      } else { pending = null; streak = 0; }
      trace.push({ t, self, ambiguous, recovering, candidates: scored.slice(0, 4).map(d => ({
        box: d.box, score: d.score, appearance: d.appearance, rank: d.rank })), verified });
    } else {
      detectorGap += 1;
    }
    // A brief local continuation is allowed; it cannot renew its own identity
    // lease. An unobserved frozen/background box eventually becomes a risk.
    // Loss is latched: a background patch regaining local confidence cannot
    // restore identity. Only a new sequence of detector observations can.
    const risk = i > 0 && (ambiguous || (!verified && recovering));
    if (risk && !priorRisk) { pending = null; streak = 0; }
    if (risk && riskStart === null) riskStart = t;
    if (!risk && riskStart !== null) {
      doubtSpans.push({ start: riskStart, end: t, level: 'risk', resolved: false,
        reason: 'identity_not_verified' }); riskStart = null;
    }
    if (risk && !validLocal && !verified) chosen = { ...lastBox };
    if (!risk) lastBox = { ...chosen };
    const state = risk ? 'TRACKING_LOST' : 'TRACKING_OK';
    trajectory.push({ frame: i, t, box: chosen, state, confidence: up.confidence,
      health: risk ? Math.min(.4, self) : self, reid: self, measured: true,
      verified, unverified: risk, watching: !risk && !verified, discontinuity: risk !== priorRisk });
    priorRisk = risk;
    pipe.onProgress?.({ phase: 'track', frame: i, total, percent: Math.round(i / total * 100) });
  }
  if (riskStart !== null) doubtSpans.push({ start: riskStart, end, level: 'risk',
    resolved: false, reason: 'identity_not_verified' });
  const seconds = (performance.now() - began) / 1000;
  return { meta: m, trajectory, doubtSpans, reviews: [], events: [], causes: {},
    uncertainAt: trajectory.filter(p => p.unverified).map(p => p.t),
    metrics: { frames: trajectory.length, analysisSeconds: seconds,
      analysisFps: trajectory.length / seconds, chosenAnalysisFps: fps,
      reidCalls, detectorCalls, assocFixes: corrections, scaleUpdates,
      anchorCount: 1, anchorAdapts: 0, viewAdds: 0,
      unverifiedFrames: trajectory.filter(p => p.unverified).length,
      lostFrames: trajectory.filter(p => p.unverified).length,
      trackedStart: start, trackedEnd: trajectory.at(-1)?.t ?? start,
      healthMean: trajectory.reduce((s, p) => s + p.health, 0) / trajectory.length },
    limits: { cameraMotionCompensation: false, learnedReid: false }, observationTrace: trace };
}
