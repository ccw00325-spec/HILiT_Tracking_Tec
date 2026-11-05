/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·3782e0d2 @license @preserve */
/* 외곽선 시뮬레이션 채점. 합성 정답으로만 잰다 — 실사 지표가 아니다.

단일 대상 추적이므로 HOTA 는 정답 트랙 하나·예측 트랙 하나의 경우다.
이때 AssA 는 DetA 와 같아져 HOTA_α = DetA_α 이고, α(IoU 문턱)를 0.05~0.95 로
평균한다. 다중 객체 HOTA 와 같은 숫자로 읽지 않는다.
*/

import type { ClipRun, FrameLog } from './tracker';
import { SIM_FPS } from './scene';
import { boxIoU } from './detections';

export interface ClipMetrics {
  frames: number;
  observable: number;
  idtp: number;
  idfp: number;
  idfn: number;
  idf1: number | null;
  hota: number | null;
  idSwitches: number;
  fragmentation: number;
  trackBreaks: number;
  falseReacquire: number;
  correctReacquire: number;
  missedReacquire: number;
  postReacquireSwitches: number;
  crowdMisconfirm: number;
  cascadeChains: number;
  cascadeSeconds: number;
  galleryStored: number;
  galleryContaminated: number;
  heavyCalls: number;
  describeCalls: number;
  skippedByContour: number;
  requestedByContour: number;
  virtualSkip: number;
  virtualRequest: number;
  gatedCandidates: number;
  demotedCandidates: number;
  demotedTarget: number;
  resolvedByCached: number;
  shadowReacquireCorrect: number;
  shadowReacquireFalse: number;
  lostFrames: number;
}

function matchedIsTarget(r: FrameLog, targetId: number): boolean {
  return r.assigned != null && r.matchedId === targetId;
}

export function scoreClip(run: ClipRun, targetId = 0): ClipMetrics {
  const rows = run.frames;
  let idtp = 0;
  let idfp = 0;
  let idfn = 0;
  let observable = 0;
  const alphas: number[] = [];
  for (let a = 0.05; a < 0.96; a += 0.05) alphas.push(a);
  const tpA = new Array(alphas.length).fill(0);
  let assignedN = 0;
  for (const r of rows) {
    if (r.targetObservable) observable += 1;
    if (r.assigned) assignedN += 1;
    if (matchedIsTarget(r, targetId)) idtp += 1;
    else if (r.assigned) idfp += 1;
    if (r.targetObservable && !matchedIsTarget(r, targetId)) idfn += 1;
    if (r.assigned && r.targetBox && r.targetObservable) {
      const iou = boxIoU(r.assigned, r.targetBox);
      alphas.forEach((a, i) => {
        if (iou >= a) tpA[i] += 1;
      });
    }
  }
  const idf1 = 2 * idtp + idfp + idfn > 0 ? (2 * idtp) / (2 * idtp + idfp + idfn) : null;
  let hotaSum = 0;
  alphas.forEach((_, i) => {
    const tp = tpA[i];
    const fn = observable - tp;
    const fp = assignedN - tp;
    hotaSum += tp + fn + fp > 0 ? tp / (tp + fn + fp) : 0;
  });
  const hota = observable + assignedN > 0 ? hotaSum / alphas.length : null;

  // ID switch: 배정된 프레임에서 맞춘 사람이 바뀐 횟수 (-1 = 아무도 아님은 건너뛴다)
  const switches: number[] = [];
  let lastId: number | null = null;
  for (const r of rows) {
    if (!r.assigned || r.matchedId == null || r.matchedId < 0) continue;
    if (lastId != null && r.matchedId !== lastId) switches.push(r.f);
    lastId = r.matchedId;
  }

  // 단절·재획득
  let fragmentation = 0;
  let trackBreaks = 0;
  let falseReacquire = 0;
  let correctReacquire = 0;
  let missedReacquire = 0;
  let postReacquireSwitches = 0;
  let inTargetSeg = false;
  let segments = 0;
  const reacqFrames: number[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const onTarget = matchedIsTarget(r, targetId);
    if (onTarget && !inTargetSeg) segments += 1;
    inTargetSeg = onTarget;
    const prev = rows[i - 1];
    if (prev && prev.assigned && !r.assigned && r.targetObservable) trackBreaks += 1;
    if (r.assigned && r.gapBefore > 0) {
      reacqFrames.push(r.f);
      if (onTarget) correctReacquire += 1;
      else falseReacquire += 1;
    }
  }
  fragmentation = Math.max(0, segments - 1);
  // LOST 가 된 뒤 대상이 5프레임 이상 보였는데 끝까지 못 붙은 경우
  const lostAt = rows.findIndex((r) => r.state === 'lost');
  if (lostAt >= 0) {
    const visibleAfter = rows.slice(lostAt).filter((r) => r.targetObservable).length;
    if (visibleAfter >= 5) missedReacquire += 1;
  }
  for (const s of switches) {
    if (reacqFrames.some((f) => s > f && s - f <= 2 * SIM_FPS)) postReacquireSwitches += 1;
  }

  // 군중 교차 직후 오확정: 대상 → 다른 사람 전환이 군중 상태 또는 그 1초 안에서
  let crowdMisconfirm = 0;
  let lastCrowd = -1e9;
  let prevId: number | null = null;
  for (const r of rows) {
    if (r.crowd) lastCrowd = r.f;
    if (!r.assigned || r.matchedId == null || r.matchedId < 0) continue;
    if (prevId === targetId && r.matchedId !== targetId && r.f - lastCrowd <= SIM_FPS) crowdMisconfirm += 1;
    prevId = r.matchedId;
  }

  // 연쇄 ID switch: 2초 안에 이어지는 전환 묶음(2회 이상)
  let cascadeChains = 0;
  let cascadeSeconds = 0;
  for (let i = 0; i < switches.length;) {
    let j = i;
    while (j + 1 < switches.length && switches[j + 1] - switches[j] <= 2 * SIM_FPS) j += 1;
    if (j > i) {
      cascadeChains += 1;
      cascadeSeconds += (switches[j] - switches[i]) / SIM_FPS;
    }
    i = j + 1;
  }

  const sum = (k: keyof FrameLog) => rows.reduce((a, r) => a + (r[k] ? 1 : 0), 0);
  return {
    frames: rows.length,
    observable,
    idtp,
    idfp,
    idfn,
    idf1,
    hota,
    idSwitches: switches.length,
    fragmentation,
    trackBreaks,
    falseReacquire,
    correctReacquire,
    missedReacquire,
    postReacquireSwitches,
    crowdMisconfirm,
    cascadeChains,
    cascadeSeconds,
    galleryStored: sum('galleryStored'),
    galleryContaminated: sum('galleryContaminated'),
    heavyCalls: sum('extracted'),
    describeCalls: rows.reduce((a, r) => a + r.describeCalls, 0),
    skippedByContour: sum('skippedByContour'),
    requestedByContour: sum('requestedByContour'),
    virtualSkip: sum('virtualSkip'),
    virtualRequest: sum('virtualRequest'),
    gatedCandidates: rows.reduce((a, r) => a + r.gated, 0),
    demotedCandidates: rows.reduce((a, r) => a + r.demoted, 0),
    demotedTarget: sum('demotedTarget'),
    resolvedByCached: sum('resolvedByCached'),
    shadowReacquireCorrect: rows.filter((r) => r.shadowReacquire === 'correct').length,
    shadowReacquireFalse: rows.filter((r) => r.shadowReacquire === 'false').length,
    lostFrames: rows.filter((r) => r.state === 'lost').length,
  };
}

export interface PairedDiff {
  /** 이 모드가 틀리고 기준선은 맞은 프레임 */
  wrongIntroduced: number;
  /** 이 모드가 맞고 기준선은 틀린 프레임 */
  wrongPrevented: number;
  /** 기준선은 추출했는데 이 모드는 안 한 프레임 중 이 모드가 맞은 수 */
  skippedStillCorrect: number;
  /** 기준선은 추출했는데 이 모드는 안 했고, 이 모드만 틀린 프레임 */
  skippedCausedError: number;
  identicalDecisions: boolean;
}

export function pairedAgainstBaseline(run: ClipRun, base: ClipRun, targetId = 0): PairedDiff {
  const bmap = new Map(base.frames.map((r) => [r.f, r]));
  let intro = 0;
  let prevented = 0;
  let skipOk = 0;
  let skipErr = 0;
  let identical = run.frames.length === base.frames.length;
  for (const r of run.frames) {
    const b = bmap.get(r.f);
    if (!b) {
      identical = false;
      continue;
    }
    const okR = r.targetObservable ? matchedIsTarget(r, targetId) : r.assigned == null || r.matchedId === targetId;
    const okB = b.targetObservable ? matchedIsTarget(b, targetId) : b.assigned == null || b.matchedId === targetId;
    if (!okR && okB) intro += 1;
    if (okR && !okB) prevented += 1;
    if (b.extracted && !r.extracted) {
      if (okR) skipOk += 1;
      else if (okB) skipErr += 1;
    }
    const sameBox = (r.assigned == null && b.assigned == null)
      || (r.assigned != null && b.assigned != null
        && r.assigned.x === b.assigned.x && r.assigned.y === b.assigned.y
        && r.assigned.width === b.assigned.width && r.assigned.height === b.assigned.height);
    if (!sameBox || r.extracted !== b.extracted || r.galleryStored !== b.galleryStored) identical = false;
  }
  return { wrongIntroduced: intro, wrongPrevented: prevented, skippedStillCorrect: skipOk, skippedCausedError: skipErr, identicalDecisions: identical };
}

export function sumMetrics(list: readonly ClipMetrics[]): ClipMetrics & { clips: number } {
  const keys = Object.keys(list[0] ?? {}) as Array<keyof ClipMetrics>;
  const out: Record<string, number | null> = {};
  for (const k of keys) {
    if (k === 'idf1' || k === 'hota') continue;
    out[k] = list.reduce((a, m) => a + ((m[k] as number) ?? 0), 0);
  }
  const idtp = out.idtp as number;
  const idfp = out.idfp as number;
  const idfn = out.idfn as number;
  out.idf1 = 2 * idtp + idfp + idfn > 0 ? (2 * idtp) / (2 * idtp + idfp + idfn) : null;
  const hs = list.map((m) => m.hota).filter((v): v is number => v != null);
  out.hota = hs.length ? hs.reduce((a, b) => a + b, 0) / hs.length : null;
  return { ...(out as unknown as ClipMetrics), clips: list.length };
}
