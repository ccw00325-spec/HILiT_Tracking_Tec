/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·31c06536 @license @preserve */
import { clamp01, type TrackingPoint } from '@hilit/shared-types';
import { refineTrajectory, auditProductionProfile, type ProductionProfile, applyProductionProfile, shouldApplyProductionProfile } from '@hilit/tracking-core';
import {
  inferBackwardFromForward,
  refineOfflineTrajectory,
  mapPipelineStateToLifecycle,
  gateReacquisitions,
  REACQUIRE_TRAJECTORY_GATE_ENABLED,
  TRAJECTORY_GATE_POLICY,
} from '@hilit/vision';
import type { DoubtSpan, PocMeta, PocResult, TrackingRun } from './web-tracking-engine';

/**
 * 추적기(pipeline.js) 결과 → 편집기 궤적(TrackingRun). WebTrackingEngine.track 이 추적 뒤에 부른다.
 *
 * 2026-09-28 엔진 안에서 꺼냈다 — 측정 도구(follow-playback-diag)가 앱과 **같은 후처리**(의심 구간 강등 ·
 * 오프라인 다듬기 · 재획득 게이트 · 운영 설정)를 거친 궤적으로 카메라를 재야 해서다. 이 후처리를 빼고 재면
 * 「상자는 맞는데 재생하면 안 따라간다」가 보이지 않았다. 동작은 옮기기 전과 같다.
 */
export function postprocessPocResult(result: PocResult, meta: PocMeta, profile: ProductionProfile | null): TrackingRun {
  const points: TrackingPoint[] = result.trajectory.map((point) => {
    const width = point.box.w ?? point.box.width ?? 0;
    const height = point.box.h ?? point.box.height ?? 0;
    const placeholder = !(width > 2 && height > 2)
      || ![point.box.x, point.box.y, width, height].every(Number.isFinite);
    const mapped = {
      timestamp: point.t,
      bbox: { x: clamp01(point.box.x / meta.width), y: clamp01(point.box.y / meta.height), width: clamp01(width / meta.width), height: clamp01(height / meta.height) },
      confidence: placeholder ? 0 : clamp01(point.confidence ?? 0),
      tracking_health: placeholder ? 0 : clamp01(point.health ?? 0),
      reid_similarity: clamp01(point.reid ?? 0),
      state: placeholder ? 'TARGET_LOST' : normalizeState(point.state),
      ...(point.engineAbsent === true ? { engineAbsent: true } : {}),
      identityLifecycle: placeholder
        ? 'LOST_UNCERTAIN'
        : (point.identityLifecycle ?? mapPipelineStateToLifecycle(point.state)),
      nearbyBoxes: Array.isArray(point.nearbyBoxes)
        ? point.nearbyBoxes.map((box) => ({
            x: clamp01(box.x / meta.width),
            y: clamp01(box.y / meta.height),
            width: clamp01(box.width / meta.width),
            height: clamp01(box.height / meta.height),
          }))
        : undefined,
    } satisfies TrackingPoint;
    return mapped;
  });
  /* 궤적을 여기서 한 번 다듬는다.
   *
   * 추적은 끝났고 렌더는 아직이다. 즉 미래를 이미 알고 있으므로
   * 지연 없는 평활과 가림 구간 보간이 가능하다. 실시간에서는 못 하는
   * 것들이다. 미리보기와 내보내기가 모두 이 결과를 쓰므로 화면에서
   * 본 것과 저장된 것이 같다. */
  /* 파이프라인이 "고르긴 했지만 가를 근거가 없었다" 고 표시한 시각의
   * 신뢰도를 낮춘다.
   *
   * 그 순간의 추적 점수는 높아 보일 수 있다 — 옆 사람을 잡고도
   * 자신 있다는 뜻이라 그대로 두면 사용자는 틀렸다는 걸 알 수 없다.
   * 여기서 낮춰두면 findTrackingGaps 가 그 구간을 잡아내고 4단계에서
   * "여기 있어요 / 여기엔 제가 없어요" 로 물어본다.
   *
   * 추적이 끝난 뒤에 손댄다. 추적 중에 상태를 바꾸면 상태 기계와
   * Re-ID 주기까지 달라져 추적 자체가 나빠졌다 — 실제로 확인 지점
   * 일치가 6개에서 3개로 떨어졌다. */
  /* 예전에는 의심 시각 주위 ±0.22초 / ±0.35초 프레임만 표시했다.
   *
   * 그게 사용자가 지적한 증상의 직접 원인이었다. 표시가 4프레임짜리
   * 섬으로 흩어지고 그 사이는 TRACKING_OK 로 남는다. 실제로는 2초 내내
   * 다른 사람을 따라가는데 화면에는 점 네 개만 깜빡였다.
   *
   * 이제 파이프라인이 구간(doubtSpans)과 프레임별 미확인 표시
   * (unverified)를 직접 준다. 시간 창으로 추측하지 않는다.
   *
   *   resolved: false  끝까지 확인되지 않았다 -> TARGET_LOST, 반드시 묻는다
   *   resolved: true   자동으로 다시 확인됐다 -> TRACKING_WARNING, 알려만 준다 */
  const doubtSpans: DoubtSpan[] = (result.doubtSpans ?? []).map((span) => ({
    start: span.start, end: span.end, reason: span.reason,
    resolved: span.resolved !== false,
    /* 등급이 없는 예전 결과는 전부 위험으로 본다(안전한 쪽). */
    level: span.level === 'watch' ? 'watch' : 'risk',
  }));
  /* 🔴 사용자에게 보여줄 구간은 **위험 등급만**이다.
   *
   * 사용자 지적: "현재는 잘 된 부분에 대해서도 놓친 것 같다고 시간과
   * 의견을 제시한다." 실측에서 잘 따라가던 확인점 18개 중 14개가
   * "확인 필요" 로 칠해져 있었다. 원인은 가림·검출 실패처럼 **자리는
   * 아는데 잠깐 못 본** 구간까지 같은 등급으로 묶었기 때문이다.
   *
   * 이제 파이프라인이 등급을 준다.
   *   watch  가려짐 · 검출 실패 · 남을 거절함 -> 자리는 안다. 묻지 않는다
   *   risk   외형 어긋남 · 남이 더 닮음 · 복구 모호 -> 묻는다
   *
   * watch 구간도 목록에는 남긴다(타임라인에 옅게 표시할 수 있다).
   * 다만 신뢰도를 깎거나 TARGET_LOST 로 바꾸지 않는다. */
  const risky = doubtSpans.filter((span) => span.level === 'risk');
  const unresolved = risky.filter((span) => !span.resolved);
  const inSpan = (spans: DoubtSpan[], t: number) =>
    spans.some((span) => t >= span.start - 1e-6 && t <= span.end + 1e-6);

  /* 🔴 2026-09-28 사용자: 「추적 상자는 맞는데 재생하면 나를 전혀 따라가지 못한다」.
   * 확인 안 된 의심 구간은 놓침(TARGET_LOST)으로 두어 **묻는다**. 그런데 카메라도 같은 상태를 보고 마지막 자리에
   * 멈춰, 의심이 영상 끝까지 이어지면(래치) 그 뒤 내내 서 있었다(빙상장 9616: 361점 중 165점, 카메라 이동이 사람
   * 이동의 17%). 의심이 생긴 뒤에도 추적이 **한 번도 끊기지 않고** 이어진 동안은 추적기가 실제로 잰 상자이므로
   * 카메라가 따라간다(doubtFollow). 한 번 끊기면(놓침 · 사용자 확인 대기 · 재획득 · 0.3초 넘는 가림) 그 뒤는 옆
   * 사람으로 옮겨 갔을 수 있어 예전처럼 붙잡는다 — 빙상장 0155 는 7.0초 가림 중에 옆 사람으로 옮겨 갔다(사람 검수 정답). */
  const DOUBT_BREAK_OCCLUDED_SEC = 0.3;
  const followable = new Array<boolean>(points.length).fill(false);
  for (const span of unresolved) {
    let broken = false;
    let occludedSince: number | null = null;
    for (let index = 0; index < points.length; index += 1) {
      const t = points[index].timestamp;
      if (t < span.start - 1e-6 || t > span.end + 1e-6) continue;
      const rawState = String(result.trajectory[index]?.state ?? '').toUpperCase();
      if (/LOST|ASK|USER|CONFIRM|REACQUI/.test(rawState)) broken = true;
      if (rawState.includes('OCCLU')) {
        if (occludedSince === null) occludedSince = t;
        if (t - occludedSince >= DOUBT_BREAK_OCCLUDED_SEC) broken = true;
      } else occludedSince = null;
      const box = points[index].bbox;
      if (!broken && box.width > 0.002 && box.height > 0.002) followable[index] = true;
    }
  }

  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const flagged = result.trajectory[index]?.unverified === true;
    const lost = inSpan(unresolved, point.timestamp);
    if (!flagged && !lost && !inSpan(risky, point.timestamp)) continue;
    point.confidence = Math.min(point.confidence, lost ? 0.30 : 0.42);
    point.tracking_health = Math.min(point.tracking_health, lost ? 0.32 : 0.45);
    if (lost) {
      point.state = 'TARGET_LOST';
      if (followable[index]) point.doubtFollow = true;
    }
    else if (point.state === 'TRACKING_OK') point.state = 'TRACKING_WARNING';
  }

  const forward = points.map((p) => ({
    t: p.timestamp,
    x: p.bbox.x,
    y: p.bbox.y,
    width: p.bbox.width,
    height: p.bbox.height,
    observed: p.state !== 'TARGET_LOST' && p.bbox.width > 0.002,
  }));
  const offline = refineOfflineTrajectory({
    forward,
    backward: inferBackwardFromForward(forward),
    doubt: unresolved.map((s) => ({ start: s.start, end: s.end, reason: s.reason })),
  });
  for (let i = 0; i < points.length && i < offline.length; i += 1) {
    const row = offline[i];
    if (row.state === 'lost') {
      points[i].state = 'TARGET_LOST';
      points[i].confidence = Math.min(points[i].confidence, 0.30);
      points[i].tracking_health = Math.min(points[i].tracking_health, 0.32);
    } else if (row.state === 'occluded' && points[i].state === 'TRACKING_OK') {
      points[i].state = 'OCCLUDED';
    } else if (row.state === 'warning' && points[i].state === 'TRACKING_OK') {
      points[i].state = 'TRACKING_WARNING';
    }
  }

  /* 끊겼다 다시 붙은 구간을 곧바로 확정하지 않는다.
   *
   * 지금까지는 추적이 다시 붙는 순간부터 같은 사람으로 취급했다. 다른
   * 사람을 잡았어도 화면에는 정상 추적으로 보여서, 사용자가 틀렸다는 것을
   * 알 방법이 없었다. 여기서는 최소 관측 수와 최소 확인 시간을 채울
   * 때까지 잠정으로 두고 신뢰도를 낮춘다. 따라가는 것은 멈추지 않는다.
   *
   * 자동으로 "같은 사람이다" 라고 올리지는 않는다. 확신을 미룰 뿐이다.
   * 잘 따라가는 구간까지 묻지 않도록, 공백이 길고 경쟁자가 있을 때만
   * risk 로 올리고 나머지는 watch 로 둔다. */
  let gateMetrics: Record<string, number | null> = {};
  /* 연결 추적(linked-v1)은 다시 붙일 때 이미 「나간 뒤 새로 들어온 사람만, 영상 끝까지 비교」로 확인했다 —
   * 여기서 다시 잠정으로 내리면 같은 재등장을 또 묻는다(2026-10-20). */
  const linked = result.engine === 'linked-v1';
  if (REACQUIRE_TRAJECTORY_GATE_ENABLED && !linked) {
    const gate = gateReacquisitions(points.map((p, i) => ({
      timestamp: p.timestamp,
      observed: p.state !== 'TARGET_LOST' && p.state !== 'OCCLUDED'
        && p.bbox.width > 0.002 && p.bbox.height > 0.002,
      competingCount: result.trajectory[i]?.nearbyBoxes?.length ?? 0,
    })));
    for (const mark of gate.marks) {
      const point = points[mark.index];
      if (!point) continue;
      point.confidence = Math.min(point.confidence, TRAJECTORY_GATE_POLICY.tentativeConfidenceCap);
      point.tracking_health = Math.min(
        point.tracking_health, TRAJECTORY_GATE_POLICY.tentativeConfidenceCap,
      );
      if (mark.lifecycle) point.identityLifecycle = mark.lifecycle;
      if (point.state === 'TRACKING_OK' && mark.hardScene) point.state = 'TRACKING_WARNING';
    }
    for (const span of gate.spans) {
      doubtSpans.push({
        start: span.start, end: span.end, reason: span.reason,
        resolved: span.level !== 'risk', level: span.level,
      });
    }
    gateMetrics = {
      reacquireGateSpans: gate.reacquisitions,
      reacquireGateTentativeFrames: gate.marks.length,
      reacquireGateAsked: gate.askedCount,
    };
  }

  /* 🔴 2026-09-28 사용자 결정 — 연구실 운영 설정은 **상태를 바꾸지 않는다.** 카메라·확인 구간·궤적 다듬기는
   * 추적기 자신의 판단만 본다. 연구실 판정기가 추적기와 얼마나 다르게 봤는지는 아래 metrics 에 세어 둔다
   * (production-profile.ts 머리 주석). rawPoints 는 연구실 검수가 판정기를 학습·평가하는 입력이다. */
  /* 2026-10-03 — 봉인 시험을 통과한 판정기(sealedPass)만 상태를 다시 매긴다. 아니면 9-28 결정대로 기록만. */
  const audit = auditProductionProfile(points, profile);
  const judged = shouldApplyProductionProfile(profile) ? applyProductionProfile(points, profile) : points;
  const refined = refineTrajectory(judged);
  return {
    points: refined.points,
    rawPoints: points,
    reviews: result.reviews, events: result.events, causes: result.causes,
    verified: result.verified === false ? false : result.verified,
    autoRecovery: result.autoRecovery,
    detector: result.detector,
    detectorReason: result.detectorReason,
    doubtSpans,
    ...(result.engine ? { engine: result.engine } : {}),
    stoppedForAsk: result.stoppedForAsk && Number.isFinite(result.stoppedForAsk.t) ? {
      t: result.stoppedForAsk.t,
      reason: result.stoppedForAsk.reason ?? 'ask-user',
      lastBox: result.stoppedForAsk.lastBox ? {
        x: clamp01(result.stoppedForAsk.lastBox.x / meta.width),
        y: clamp01(result.stoppedForAsk.lastBox.y / meta.height),
        width: clamp01(result.stoppedForAsk.lastBox.width / meta.width),
        height: clamp01(result.stoppedForAsk.lastBox.height / meta.height),
      } : null,
      proposal: result.stoppedForAsk.proposal?.box && Number.isFinite(result.stoppedForAsk.proposal.t) ? {
        t: result.stoppedForAsk.proposal.t,
        box: {
          x: clamp01(result.stoppedForAsk.proposal.box.x / meta.width),
          y: clamp01(result.stoppedForAsk.proposal.box.y / meta.height),
          width: clamp01(result.stoppedForAsk.proposal.box.width / meta.width),
          height: clamp01(result.stoppedForAsk.proposal.box.height / meta.height),
        },
      } : null,
    } : null,
    metrics: {
      ...result.metrics,
      uncertainFrames: (result.uncertainAt ?? []).length,
      reviewPoints: result.reviews.length,
      doubtSpanCount: doubtSpans.length,
      /* 등급별로 따로 센다 — 사용자를 귀찮게 한 횟수가 riskySpanCount 다. */
      riskySpanCount: risky.length,
      watchSpanCount: doubtSpans.length - risky.length,
      unresolvedSpanCount: unresolved.length,
      bridgedFrames: refined.bridgedFrames,
      repairedFrames: refined.repairedFrames,
      ...gateMetrics,
      /* 받은 운영 추적 설정 버전과, 그 판정기가 추적기와 다르게 본 점 수(기록만 — 상태는 바꾸지 않았다). */
      productionProfileVersion: profile?.version ?? null,
      productionProfileJudged: audit?.judged ?? null,
      productionProfileAgree: audit?.agree ?? null,
      productionProfileToOk: audit?.toOk ?? null,
      productionProfileToWarning: audit?.toWarning ?? null,
      productionProfileToLost: audit?.toLost ?? null,
    },
    limits: result.limits,
  };
}

export function normalizeState(state: string): TrackingPoint['state'] {
  const value = String(state || '').toUpperCase();
  if (value.includes('WARNING')) return 'TRACKING_WARNING';
  if (value.includes('OCCLU')) return 'OCCLUDED';
  if (value.includes('LOST') || value.includes('ASK')
      || value.includes('USER') || value.includes('CONFIRM')) return 'TARGET_LOST';
  if (value.includes('REACQUI')) return 'REACQUIRING';
  if (value.includes('SERVER')) return 'SERVER_RECOVERY';
  return 'TRACKING_OK';
}
