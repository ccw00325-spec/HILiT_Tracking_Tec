/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·998989a0 @license @preserve */
/* S24 엑시노스 2400 APK 추적 경로 가상 시뮬.

개발 PC Node 에서 실제 커널(모션·외형·GMC·Tracklet·등번호)을 재고,
공개 GB6 비율로 S24 시간을 스케일한다. 결과는 VIRTUAL 이다.
에뮬레이터·이 PC 숫자를 S24 실측으로 바꾸지 않는다.
*/

import { describe, similarity, type Descriptor } from './appearance';
import { estimateAffineGmc } from './affine-gmc';
import { HilitMotionTrackerCore, rgbaToGray, type PixelBox } from './motion-tracker';
import { JerseyLock, readJerseyNumber } from './jersey-lock';
import { TrackletGraph } from './tracklet-graph';
import { describeTeam, decideTeamCue } from './team-cue';
import { estimateCourtHint } from './court-hint';
import { applyOcclusionCrop } from './occlusion-framing';
import { gateSportsIdentity } from './sports-identity-gate';
import { refineOfflineTrajectory } from './offline-bidirectional';
import { scoreEventForMe } from './event-for-me';
import { cpus } from 'node:os';
import { decideAppearanceMatch } from './appearance-memory';
import { ReidScheduler, REID_SCHEDULER_POLICY } from './reid-scheduler';
import {
  APK_ANALYSIS_FPS,
  APK_ANALYSIS_SHORT_SIDE,
  S24_DECODE_MS_ESTIMATE,
  S24_GB6_SINGLE_RANGE,
  S24_GB6_SINGLE_VIRTUAL,
  S24_KR_EXYNOS2400_PROFILE,
  S24_MEASUREMENT_STATUS,
  S24_PROFILE_KIND,
  WEB_ADAPTIVE_FLOOR_FPS,
  bandForAnalysisMs,
  inferHostGeekbench6Single,
  scaleHostMsToS24,
  tenMinuteFrameCount,
  trackingHeapMbEstimate,
  type VirtualBudgetBand,
} from './s24-exynos2400-profile';

export interface S24SimOptions {
  frames?: number;
  warmup?: number;
  width?: number;
  height?: number;
  hostCpuModel?: string;
  hostGb6Single?: number;
}

export interface TimedMs {
  p50: number;
  p90: number;
  mean: number;
  n: number;
}

export interface S24VirtualSimReport {
  kind: typeof S24_PROFILE_KIND;
  measurementStatus: typeof S24_MEASUREMENT_STATUS;
  profileId: string;
  host: {
    platform: string;
    arch: string;
    node: string;
    cpuModel: string;
    hostGb6Single: number;
    hostGb6Basis: string;
    notGalaxyS24: true;
  };
  scene: { width: number; height: number; warmup: number; measuredFrames: number };
  hostKernelMs: {
    gray: TimedMs;
    motion: TimedMs;
    appearance: TimedMs;
    gmc: TimedMs;
    extras: TimedMs;
    apkFrame: TimedMs;
    webFrame: TimedMs;
  };
  virtualS24: {
    apkBurstMs: number;
    apkSustainedMs: number;
    apkWithDecodeTypicalMs: number;
    apkWithDecodePessimisticMs: number;
    webSustainedMs: number;
    webWithDecodeTypicalMs: number;
    decodeEstimateMs: typeof S24_DECODE_MS_ESTIMATE;
    apkBand: VirtualBudgetBand;
    webBand: VirtualBudgetBand;
    tenMin20fpsSec: number;
    tenMin12fpsSec: number;
    gb6Sensitivity: {
      center: number;
      apkWithDecodeTypicalMs: Record<string, number>;
      note: string;
    };
  };
  scheduler: {
    expensiveExtracts: number;
    expensiveRatio: number;
    stableIntervalSec: number;
    warningIntervalSec: number;
    cooldownSec: number;
    note: string;
  };
  functional: {
    trackerThrew: false;
    lastMotionStatus: string;
    appearanceCalls: number;
    gmcUsableFrames: number;
    trackletLastAction: string;
    offlinePoints: number;
    eventForMeScore: number;
    heap: ReturnType<typeof trackingHeapMbEstimate>;
    apkIncludesGmc: true;
  };
  verdict: {
    functionalOk: boolean;
    memoryOk: boolean;
    apkAnalysis: VirtualBudgetBand;
    webAnalysis: VirtualBudgetBand;
    preview24fpsPlayback: 'VIRTUAL_LIKELY_OK';
    npuUsed: false;
    gpuComputeUsed: false;
    crash10min: typeof S24_MEASUREMENT_STATUS;
    identityQuality: typeof S24_MEASUREMENT_STATUS;
    summaryKo: string;
  };
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function summarize(samples: number[]): TimedMs {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.length ? samples.reduce((s, v) => s + v, 0) / samples.length : 0;
  return { p50: percentile(sorted, 50), p90: percentile(sorted, 90), mean, n: samples.length };
}

function paintScene(frame: number, w: number, h: number): { rgba: Uint8ClampedArray; box: PixelBox; other: PixelBox } {
  const rgba = new Uint8ClampedArray(w * h * 4);
  const cam = frame * 2;
  const bw = Math.floor(w * 0.18);
  const bh = Math.floor(h * 0.36);
  const x0 = Math.max(8, Math.min(w - bw - 8, Math.floor(w * 0.36 + frame * 1.2)));
  const y0 = Math.max(8, Math.min(h - bh - 8, Math.floor(h * 0.28 + Math.sin(frame * 0.09) * 14)));
  const ox = Math.max(8, Math.min(w - bw - 8, x0 + Math.floor(w * 0.28)));
  const oy = y0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      const tex = ((x + cam) * 17 + y * 31) % 160;
      rgba[i] = 40 + (tex % 50);
      rgba[i + 1] = 90 + ((tex + y) % 70);
      rgba[i + 2] = 40 + ((x + cam) % 40);
      rgba[i + 3] = 255;
    }
  }
  const paintPerson = (px: number, py: number, r: number, g: number, b: number) => {
    for (let y = py; y < py + bh; y += 1) {
      const band = (y - py) / bh;
      for (let x = px; x < px + bw; x += 1) {
        const i = (y * w + x) * 4;
        if (band < 0.25) {
          rgba[i] = 70; rgba[i + 1] = 42; rgba[i + 2] = 30;
        } else if (band < 0.7) {
          rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b;
        } else {
          rgba[i] = 20; rgba[i + 1] = 20; rgba[i + 2] = 28;
        }
      }
    }
  };
  paintPerson(x0, y0, 200, 36, 36);
  paintPerson(ox, oy, 36, 48, 190);
  return {
    rgba,
    box: { x: x0, y: y0, width: bw, height: bh },
    other: { x: ox, y: oy, width: bw, height: bh },
  };
}

function cropRgba(
  rgba: Uint8ClampedArray, fw: number, fh: number, box: PixelBox,
): { data: Uint8ClampedArray; w: number; h: number } {
  const x0 = Math.max(0, Math.floor(box.x));
  const y0 = Math.max(0, Math.floor(box.y));
  const w = Math.max(4, Math.min(fw - x0, Math.floor(box.width)));
  const h = Math.max(8, Math.min(fh - y0, Math.floor(box.height)));
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    const src = ((y0 + y) * fw + x0) * 4;
    data.set(rgba.subarray(src, src + w * 4), y * w * 4);
  }
  return { data, w, h };
}

function toU8Gray(data: Float32Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = data[i];
  return out;
}

function nowMs(): number {
  return performance.now();
}

export function runS24ApkVirtualSimulation(options: S24SimOptions = {}): S24VirtualSimReport {
  const width = options.width ?? APK_ANALYSIS_SHORT_SIDE;
  const height = options.height ?? Math.round(APK_ANALYSIS_SHORT_SIDE * (2340 / 1080) / 2) * 2;
  const warmup = options.warmup ?? 8;
  const measured = options.frames ?? 48;
  const total = warmup + measured;
  const cpuModel = options.hostCpuModel
    ?? (typeof process !== 'undefined'
      ? (cpus()[0]?.model ?? process.env.PROCESSOR_IDENTIFIER ?? '')
      : '');
  const inferred = inferHostGeekbench6Single(cpuModel);
  const hostGb6 = options.hostGb6Single ?? inferred.score;

  const tracker = new HilitMotionTrackerCore();
  const graph = new TrackletGraph();
  const jersey = new JerseyLock();
  const reidSched = new ReidScheduler({ mode: 'selective' });
  let anchor: Descriptor | null = null;
  let prevU8: Uint8Array | null = null;
  let lastBox: PixelBox = { x: width * 0.36, y: height * 0.28, width: width * 0.18, height: height * 0.36 };
  let lastOther: PixelBox = { x: width * 0.64, y: height * 0.28, width: width * 0.18, height: height * 0.36 };
  let lastStatus = 'init';
  let appearanceCalls = 0;
  let gmcUsable = 0;
  let lastTrackletAction = 'continue';
  const forward: Array<{ t: number; x: number; y: number; width: number; height: number; observed: boolean }> = [];

  const grayMs: number[] = [];
  const motionMs: number[] = [];
  const appearMs: number[] = [];
  const gmcMs: number[] = [];
  const extraMs: number[] = [];
  const apkMs: number[] = [];
  const webMs: number[] = [];

  for (let i = 0; i < total; i += 1) {
    const scene = paintScene(i, width, height);
    lastBox = scene.box;
    lastOther = scene.other;
    const t = i / APK_ANALYSIS_FPS;

    const g0 = nowMs();
    const gray = rgbaToGray(scene.rgba, width, height);
    const g1 = nowMs();

    if (i === 0) {
      tracker.init(gray, scene.box, t);
      const crop = cropRgba(scene.rgba, width, height, scene.box);
      anchor = describe(crop.data, crop.w, crop.h, undefined, true);
      prevU8 = toU8Gray(gray.data);
      continue;
    }

    const m0 = nowMs();
    const update = tracker.update(gray, t);
    const m1 = nowMs();
    lastStatus = update.status;
    const box = update.box.width > 2 ? update.box : scene.box;

    let aCost = 0;
    const risky = update.confidence < 0.45;
    const dec = reidSched.decide({
      videoTSec: t,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      visibleRatio: 1,
      cropValid: Math.min(box.width, box.height) >= REID_SCHEDULER_POLICY.minCropPx,
      trackerConfidence: update.confidence,
      appearanceWeak: risky,
      trackLostSuspect: risky,
      rivalNearby: risky,
      rankCompetition: risky,
    });
    if (dec.extract) {
      const a0 = nowMs();
      const crop = cropRgba(scene.rgba, width, height, box);
      const desc = describe(crop.data, crop.w, crop.h, undefined, true);
      if (anchor) similarity(anchor, desc);
      appearanceCalls += 1;
      aCost = nowMs() - a0;
      reidSched.noteExtract(aCost);
    }

    const nextU8 = toU8Gray(gray.data);
    const c0 = nowMs();
    const gmc = prevU8
      ? estimateAffineGmc({
        prevGray: prevU8, nextGray: nextU8, width, height,
        excludeBoxes: [{ x: box.x, y: box.y, width: box.width, height: box.height }],
      })
      : null;
    const c1 = nowMs();
    if (gmc?.usable) gmcUsable += 1;
    prevU8 = nextU8;

    const e0 = nowMs();
    graph.update({
      t,
      detections: [
        { x: box.x, y: box.y, width: box.width, height: box.height },
        { x: lastOther.x, y: lastOther.y, width: lastOther.width, height: lastOther.height },
      ],
      affine: gmc?.usable ? gmc.affine : null,
      subject: { x: box.x, y: box.y, width: box.width, height: box.height },
    });
    const sw = graph.decideSwitch({ x: box.x, y: box.y, width: box.width, height: box.height });
    lastTrackletAction = sw.action;
    if (i % 20 === 0) {
      const crop = cropRgba(scene.rgba, width, height, box);
      const read = readJerseyNumber({ rgba: crop.data, width: crop.w, height: crop.h });
      if (i === 20) jersey.remember(read, true);
      jersey.decide(read);
      const self = describeTeam(crop.data, crop.w, crop.h);
      const otherCrop = cropRgba(scene.rgba, width, height, lastOther);
      decideTeamCue(self, describeTeam(otherCrop.data, otherCrop.w, otherCrop.h));
    }
    if (i % 5 === 0) {
      estimateCourtHint({ rgba: scene.rgba, width, height, subject: box });
    }
    applyOcclusionCrop({
      cropShare: 0.42, maxCropShare: 0.72, subject: box,
      others: [{ x: lastOther.x, y: lastOther.y, width: lastOther.width, height: lastOther.height }],
    });
    const appear = decideAppearanceMatch({
      self: 0.8,
      other: 0.45,
      samples: 200,
      trust: 1,
    });
    gateSportsIdentity({
      appearance: appear,
      tracklet: sw,
      gapSeconds: 1 / APK_ANALYSIS_FPS,
    });
    const e1 = nowMs();

    forward.push({
      t, x: box.x, y: box.y, width: box.width, height: box.height, observed: update.observed,
    });

    if (i >= warmup) {
      const gCost = g1 - g0;
      const motCost = m1 - m0;
      const gmcCost = c1 - c0;
      const extraCost = e1 - e0;
      grayMs.push(gCost);
      motionMs.push(motCost);
      if (aCost) appearMs.push(aCost);
      gmcMs.push(gmcCost);
      extraMs.push(extraCost);
      apkMs.push(gCost + motCost + gmcCost + extraCost + aCost);
      webMs.push(gCost + motCost + aCost + gmcCost + extraCost);
    }
  }

  const offline = refineOfflineTrajectory({ forward });
  const event = scoreEventForMe({
    subjectSpeed: 0.4, subjectAccel: 0.2, trackingHealth: 0.7, overlapOthers: 0.1,
  });

  const host = {
    gray: summarize(grayMs),
    motion: summarize(motionMs),
    appearance: summarize(appearMs.length ? appearMs : [0]),
    gmc: summarize(gmcMs),
    extras: summarize(extraMs),
    apkFrame: summarize(apkMs),
    webFrame: summarize(webMs),
  };

  const apkBurst = scaleHostMsToS24(host.apkFrame.p50, {
    hostGb6Single: hostGb6, path: 'apk-java', sustained: false,
  });
  const apkSus = scaleHostMsToS24(host.apkFrame.p50, {
    hostGb6Single: hostGb6, path: 'apk-java', sustained: true,
  });
  const webSus = scaleHostMsToS24(host.webFrame.p50, {
    hostGb6Single: hostGb6, path: 'webview-js', sustained: true,
  });
  const apkWithDec = apkSus.virtualMs + S24_DECODE_MS_ESTIMATE.typical;
  const apkWithDecPess = apkSus.virtualMs + S24_DECODE_MS_ESTIMATE.pessimistic;
  const webWithDec = webSus.virtualMs + S24_DECODE_MS_ESTIMATE.typical;
  const apkBand = bandForAnalysisMs(apkWithDec);
  const webBand = bandForAnalysisMs(webWithDec);
  const heap = trackingHeapMbEstimate(width, height);

  const tenMin20 = tenMinuteFrameCount(APK_ANALYSIS_FPS) * apkWithDec / 1000;
  const tenMin12 = tenMinuteFrameCount(WEB_ADAPTIVE_FLOOR_FPS) * webWithDec / 1000;
  const schedMetrics = reidSched.metrics();
  const gb6Points = {
    userLow1837: S24_GB6_SINGLE_RANGE.userSubmitMin,
    notebook2045: S24_GB6_SINGLE_RANGE.typicalMin,
    center2060: S24_GB6_SINGLE_VIRTUAL,
    typicalMax2131: S24_GB6_SINGLE_RANGE.typicalMax,
    userHigh2187: S24_GB6_SINGLE_RANGE.userSubmitMax,
  } as const;
  const apkDecodeTypicalAt = Object.fromEntries(
    Object.entries(gb6Points).map(([k, score]) => [
      k,
      Number((scaleHostMsToS24(host.apkFrame.p50, {
        hostGb6Single: hostGb6, path: 'apk-java', sustained: true, s24Gb6Single: score,
      }).virtualMs + S24_DECODE_MS_ESTIMATE.typical).toFixed(2)),
    ]),
  );

  const functionalOk = lastStatus !== 'not_initialized' && offline.length > 0;
  const memoryOk = heap.fits8gb;
  const summaryKo = summarizeKo({
    functionalOk, memoryOk, apkBand, webBand, apkWithDec, tenMin20,
  });

  return {
    kind: S24_PROFILE_KIND,
    measurementStatus: S24_MEASUREMENT_STATUS,
    profileId: S24_KR_EXYNOS2400_PROFILE.id,
    host: {
      platform: typeof process !== 'undefined' ? process.platform : 'unknown',
      arch: typeof process !== 'undefined' ? process.arch : 'unknown',
      node: typeof process !== 'undefined' ? process.version : 'unknown',
      cpuModel: cpuModel || 'unknown',
      hostGb6Single: hostGb6,
      hostGb6Basis: options.hostGb6Single ? 'caller' : inferred.basis,
      notGalaxyS24: true,
    },
    scene: { width, height, warmup, measuredFrames: measured },
    hostKernelMs: host,
    virtualS24: {
      apkBurstMs: apkBurst.virtualMs,
      apkSustainedMs: apkSus.virtualMs,
      apkWithDecodeTypicalMs: apkWithDec,
      apkWithDecodePessimisticMs: apkWithDecPess,
      webSustainedMs: webSus.virtualMs,
      webWithDecodeTypicalMs: webWithDec,
      decodeEstimateMs: S24_DECODE_MS_ESTIMATE,
      apkBand,
      webBand,
      tenMin20fpsSec: tenMin20,
      tenMin12fpsSec: tenMin12,
      gb6Sensitivity: {
        center: S24_GB6_SINGLE_VIRTUAL,
        apkWithDecodeTypicalMs: apkDecodeTypicalAt,
        note: '공개 GB6 단일 점수가 낮을수록 S24를 느리게 보고 ms가 커진다. 실측 아님.',
      },
    },
    scheduler: {
      expensiveExtracts: schedMetrics.expensiveExtracts,
      expensiveRatio: schedMetrics.expensiveRatio,
      stableIntervalSec: REID_SCHEDULER_POLICY.stableExpensiveIntervalSec,
      warningIntervalSec: REID_SCHEDULER_POLICY.warningExpensiveIntervalSec,
      cooldownSec: REID_SCHEDULER_POLICY.cooldownAfterExpensiveSec,
      note: '호출 횟수는 품질이 아니다. 옛 20/5프레임 주기가 아니다.',
    },
    functional: {
      trackerThrew: false,
      lastMotionStatus: lastStatus,
      appearanceCalls,
      gmcUsableFrames: gmcUsable,
      trackletLastAction: lastTrackletAction,
      offlinePoints: offline.length,
      eventForMeScore: event.score,
      heap,
      apkIncludesGmc: true,
    },
    verdict: {
      functionalOk,
      memoryOk,
      apkAnalysis: apkBand,
      webAnalysis: webBand,
      preview24fpsPlayback: 'VIRTUAL_LIKELY_OK',
      npuUsed: false,
      gpuComputeUsed: false,
      crash10min: S24_MEASUREMENT_STATUS,
      identityQuality: S24_MEASUREMENT_STATUS,
      summaryKo,
    },
  };
}

function summarizeKo(input: {
  functionalOk: boolean;
  memoryOk: boolean;
  apkBand: VirtualBudgetBand;
  webBand: VirtualBudgetBand;
  apkWithDec: number;
  tenMin20: number;
}): string {
  if (!input.functionalOk) {
    return '가상 시뮬에서 추적 커널이 상자를 잇지 못했다. S24 실측이 아니다.';
  }
  const waitMin = (input.tenMin20 / 60).toFixed(1);
  const ms = input.apkWithDec.toFixed(1);
  if (input.apkBand === 'VIRTUAL_LIKELY_OK') {
    return `APK Java 경로(모션+외형+추정 디코드)는 가상값으로 20fps 분석 예산(50ms) 안이다(약 ${ms}ms/프레임). 10분 영상 분석은 약 ${waitMin}분. 실측 아님.`;
  }
  if (input.apkBand === 'VIRTUAL_MARGINAL') {
    return `APK 경로는 가상값으로 20fps는 빠듯하고 12fps면 예산 안이다(약 ${ms}ms/프레임). 10분 영상은 약 ${waitMin}분. 실측 아님.`;
  }
  if (input.apkBand === 'VIRTUAL_SLOW') {
    return `APK 경로는 가상값으로 분석은 끝나지만 대기가 길다(약 ${ms}ms/프레임, 10분 영상 약 ${waitMin}분). 워커 스레드라 ANR 로 죽지는 않는 쪽으로 본다. 실측 아님.`;
  }
  return `APK 경로는 가상값으로 프레임당 ${ms}ms 라 10분 영상이 약 ${waitMin}분 걸린다. 동작은 되어도 대기 품질이 나쁘다. 실측 아님.`;
}
