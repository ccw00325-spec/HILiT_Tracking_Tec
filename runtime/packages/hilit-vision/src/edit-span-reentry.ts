/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·222bd1bb @license @preserve */
/* 녹화 편집 실험 — 놓친 뒤 선택 구간 끝까지 후보를 본다.

제품 기본 추적, 라이브 카메라, 최종 내보내기 기본값은 바꾸지 않는다.
2초는 먼저 보는 순서일 뿐, 탐색을 끝내는 조건이 아니다.
외형 점수는 신원 확률이 아니다. H0는 부재·미확인, H1/H2는 후보 가설이다.
잠정 후보를 사용자가 확인한 기준점에 넣지 않는다.
*/

import type { TrackingPoint } from '@hilit/shared-types';
import { boxIou } from './hilit-grid-net';
import { motionTolerance } from './reentry-match';
import { LOOKAHEAD_BUDGET_SEC, planLookahead } from './provisional-reacquire';

export const EDIT_SPAN_REENTRY_EXPERIMENT = 'editSpanReentryExperiment';
export const EDIT_SPAN_REENTRY_DEFAULT = false;

/** 처리 순서. 정확도 한계나 자동 종료가 아니다. */
export const EDIT_SPAN_FAST_SEC = 2;
export const EDIT_SPAN_MID_SEC = 10;

/** 실험 전에 고정. 결과 보고 바꾸지 않는다. */
export const EDIT_SPAN_MEASUREMENT = Object.freeze({
  inclusionIou: 0.5,
  detectorScoreMin: 0.2,
  detectorScoreMax: 1,
  delayBucketsSec: Object.freeze([2, 5, 10, 30] as const),
  seekToleranceSec: 0.05,
  agreeIou: 0.5,
  note: '검출 점수 하한은 재획득 후보 문턱(DETECTOR_SCORE_MIN.reacquireCandidates)과 같다. 신원 확률이 아니다.',
});

export const EDIT_SPAN_CAPS = Object.freeze({
  chunkSamples: 4,
  maxResidentFrames: 8,
  maxDecodedFrames: 2400,
  maxWallMs: 120_000,
  maxLedgerBytes: 32 * 1024 * 1024,
  maxReverseDecodedFrames: 480,
});

/** 제품 기본값을 켜는 출시 기준. 충족해도 에이전트가 켜지 않는다. */
export const PRODUCT_DEFAULT_RELEASE_GATES = Object.freeze({
  frozenBeforeMeasurement: true,
  humanDualReentryEventsMin: 97,
  wrongConfirmUpper95Max: 0.02,
  autoConfirmLower95Min: 0.7,
  questionsPerEventMax: 1,
  repeatQuestionsMax: 0,
  wrongNormalVisibleFrameUpper95Max: 0.012,
  exportUnconfirmedOtherLinksMax: 0,
  seekDecisionMismatchMax: 0,
  androidDeviceCheckRequired: true,
  agentMayEnableProductDefault: false,
});

const ABS_APPEARANCE = 0.82;
const ABS_APPEARANCE_STRONG = 0.9;
const MARGIN = 0.12;
const MARGIN_AFTER_CUT = 0.2;
const MIN_OBSERVATIONS = 3;
const MIN_OBSERVATIONS_AFTER_CUT = 4;
const MIN_SPAN_SEC = 0.4;
const MIN_SPAN_WITH_RIVALS_SEC = 0.8;
const MAX_APPEARANCE_RANGE = 0.16;
const MIN_GAIN_OVER_H0 = 0.28;
const LONG_GAP_SEC = 2;

export type SearchBand = 'fast-0-2' | 'mid-2-10' | 'rest' | 'reverse';
export type Visibility = 'visible' | 'partial' | 'full-occluded' | 'absent' | 'unknown';

export interface SpanBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SearchCandidate {
  id: string;
  box: SpanBox;
  detectorScore: number | null;
  /** 사용자 확인 기준점과의 외형 유사도. 신원 확률이 아니다. */
  appearance: number | null;
  confirmedOtherSimilarity: number | null;
  knownOtherConflict: boolean;
  visibility: Visibility;
}

export interface SearchFrame {
  requestedTSec: number;
  reportedTSec: number;
  candidates: SearchCandidate[];
  sceneCut: boolean;
  cameraReset: boolean;
}

export interface ChunkRequest {
  band: SearchBand;
  start: number;
  end: number;
  times: number[];
}

export interface SearchChunk {
  frames: SearchFrame[];
  decodedFrames: number;
  bytes: number;
}

export interface EditSpanQuestion {
  eventId: string;
  representativeTSec: number;
  candidate1: { id: string; tSec: number; box: SpanBox; appearance: number | null } | null;
  candidate2: { id: string; tSec: number; box: SpanBox; appearance: number | null } | null;
  noneLabel: '해당 없음/아직 보이지 않음';
  questionsForEvent: 1;
  repeatOfSameEvent: number;
}

export interface EditSpanLink {
  tSec: number;
  box: SpanBox | null;
  state: 'PROVISIONAL_LINK' | 'TARGET_LOST';
  reason: string;
  visibility: Visibility;
}

export interface EditSpanResult {
  status: 'auto-provisional' | 'needs-question' | 'cancelled' | 'stale' | 'resource-cap' | 'no-span' | 'reproducibility-failure';
  experiment: typeof EDIT_SPAN_REENTRY_EXPERIMENT;
  productDefaultChanged: false;
  identityConfirmed: false;
  anchorUpdates: 0;
  learnedFromProvisional: false;
  bandsVisited: SearchBand[];
  searchEndT: number;
  horizonSec: number | null;
  links: EditSpanLink[];
  question: EditSpanQuestion | null;
  ledger: EditSpanLedgerEntry[];
  sightings: Sighting[];
  cost: EditSpanCost;
  exportGate: { ok: boolean; reason: string };
  failureReason: string | null;
  progressMessage: string;
}

export interface EditSpanLedgerEntry {
  tSec: number;
  candidateId: string | null;
  action: 'provisional' | 'reject' | 'ambiguous' | 'absent' | 'seek-unstable';
  reason: string;
  appearance: number | null;
  margin: number | null;
  sceneCut: boolean;
  scoreIsProbability: false;
}

export interface Sighting {
  tSec: number;
  box: SpanBox;
  detectorScore: number | null;
  seekStable: boolean;
  candidateId: string;
}

export interface EditSpanCost {
  decodedFrames: number;
  reverseDecodedFrames: number;
  peakResidentFrames: number;
  peakLedgerBytes: number;
  wallMs: number;
  candidateCount: number;
  cancelled: boolean;
  resumedFromT: number | null;
}

export interface EditSpanSearchInput {
  lostT: number;
  editEnd: number;
  lastCertainT: number;
  lastCertainBox: SpanBox;
  frameWidth: number;
  frameHeight: number;
  generation: number;
  readGeneration: () => number;
  signal?: { aborted?: boolean };
  /** 호출자가 소유한다. 이 함수는 길이를 바꾸지 않는다. */
  anchors: readonly unknown[];
  pullChunk: (request: ChunkRequest) => Promise<SearchChunk | 'cancelled'>;
  now?: () => number;
  /** null 이면 편집 구간 끝. 숫자면 그 초에서 탐색만 끊는다(기존 2초 경로 비교용). */
  horizonSec?: number | null;
  resumeFromT?: number | null;
  eventId?: string;
  priorQuestionsForEvent?: number;
  caps?: Partial<typeof EDIT_SPAN_CAPS>;
}

interface Sample {
  t: number;
  box: SpanBox;
  appearance: number | null;
  detectorScore: number | null;
  visibility: Visibility;
  sceneCut: boolean;
  enteredFromEdge: boolean;
  rivalAppearance: number | null;
  knownOtherConflict: boolean;
  seekStable: boolean;
  candidateId: string;
}

interface Chain {
  id: string;
  samples: Sample[];
  closed: boolean;
}

type ChainClass = 'auto' | 'ambiguous' | 'reject';

function finiteBox(box: SpanBox | null | undefined): box is SpanBox {
  return !!box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0;
}

function centerBodies(a: SpanBox, b: SpanBox): number {
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.hypot(ax - bx, ay - by) / Math.max(1, Math.min(a.height, b.height));
}

function sizeRatio(a: SpanBox, b: SpanBox): number {
  return Math.max(
    a.width / Math.max(1e-6, b.width),
    b.width / Math.max(1e-6, a.width),
    a.height / Math.max(1e-6, b.height),
    b.height / Math.max(1e-6, a.height),
  );
}

export function bandProgressMessage(band: SearchBand): string {
  if (band === 'fast-0-2') return '처음 2초를 먼저 살펴보는 중입니다. 놓친 지점부터 순서대로 봅니다.';
  if (band === 'mid-2-10') return '2초에서 10초 사이를 이어서 살펴보는 중입니다. 여기까지 못 찾았다고 끝내지 않습니다.';
  if (band === 'rest') return '남은 편집 구간을 이어서 살펴보는 중입니다. 영상이 길면 시간이 더 걸릴 수 있습니다. 취소할 수 있습니다.';
  return '나중에 찾은 후보를 기준으로 앞 구간을 작은 조각으로 다시 읽고 있습니다.';
}

export function planEditSpanBands(lostT: number, editEnd: number): Array<{ band: SearchBand; start: number; end: number }> {
  if (!(editEnd > lostT)) return [];
  const fastEnd = Math.min(editEnd, lostT + EDIT_SPAN_FAST_SEC);
  const midEnd = Math.min(editEnd, lostT + EDIT_SPAN_MID_SEC);
  const bands: Array<{ band: SearchBand; start: number; end: number }> = [
    { band: 'fast-0-2', start: lostT, end: fastEnd },
  ];
  if (midEnd > fastEnd + 1e-6) bands.push({ band: 'mid-2-10', start: fastEnd, end: midEnd });
  if (editEnd > midEnd + 1e-6) bands.push({ band: 'rest', start: midEnd, end: editEnd });
  return bands;
}

export function oldLookaheadEnd(lostT: number, editEnd: number, lowPower = false): number {
  return planLookahead({ nowSec: lostT, videoEndSec: editEnd, lowPower }).end;
}

export function enteredFromEdge(box: SpanBox, frameWidth: number, frameHeight: number): boolean {
  const mx = frameWidth * 0.08;
  const my = frameHeight * 0.08;
  return box.x <= mx || box.y <= my || box.x + box.width >= frameWidth - mx || box.y + box.height >= frameHeight - my;
}

function sampleTimes(start: number, end: number, step: number): number[] {
  const times: number[] = [];
  if (!(end > start) || !(step > 0)) return times;
  for (let t = start; t < end - 1e-6; t += step) times.push(Number(t.toFixed(3)));
  return times;
}

function chunkTimes(times: number[], size: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < times.length; i += size) out.push(times.slice(i, i + size));
  return out;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function classifyChain(chain: Chain, lastCertainT: number, lastCertainBox: SpanBox): { klass: ChainClass; reason: string; appearance: number | null; margin: number | null } {
  const usable = chain.samples.filter((s) => s.seekStable && (s.visibility === 'visible' || s.visibility === 'partial') && finiteBox(s.box));
  const appearances = usable.map((s) => s.appearance).filter((v): v is number => v != null && Number.isFinite(v));
  const appearance = appearances.length ? Math.min(...appearances) : null;
  const rivals = usable.map((s) => s.rivalAppearance).filter((v): v is number => v != null && Number.isFinite(v));
  const margin = appearance == null || !rivals.length ? null : appearance - Math.max(...rivals);
  if (usable.some((s) => s.knownOtherConflict)) {
    return { klass: 'reject', reason: 'confirmed-other-conflict', appearance, margin };
  }
  if (appearance == null) return { klass: 'reject', reason: 'appearance-unmeasured', appearance, margin };
  const times = usable.map((s) => s.t);
  const span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
  const sceneCut = usable.some((s) => s.sceneCut);
  const longGap = times.length > 0 && times[0] - lastCertainT > LONG_GAP_SEC;
  const needAppearance = sceneCut || longGap ? ABS_APPEARANCE_STRONG : ABS_APPEARANCE;
  const needN = sceneCut ? MIN_OBSERVATIONS_AFTER_CUT : MIN_OBSERVATIONS;
  const needSpan = rivals.length ? MIN_SPAN_WITH_RIVALS_SEC : MIN_SPAN_SEC;
  const range = appearances.length ? Math.max(...appearances) - appearance : 0;
  const h0 = 0.08 + (1 - appearance) * 0.64;
  const gain = appearance - h0;
  const first = usable[0];
  const motion = first
    ? (() => {
      const dt = Math.max(1e-3, first.t - lastCertainT);
      if (dt > LONG_GAP_SEC || sceneCut) return false;
      const tol = motionTolerance({ dtSec: dt, boxHeight: lastCertainBox.height, cameraMoving: false });
      return centerBodies(lastCertainBox, first.box) <= tol.maxCenterBodies && sizeRatio(lastCertainBox, first.box) <= tol.maxSizeRatio;
    })()
    : false;
  const edge = usable.some((s) => s.enteredFromEdge);
  if (appearance < 0.7) return { klass: 'reject', reason: 'appearance-low', appearance, margin };
  if (range > MAX_APPEARANCE_RANGE) return { klass: 'ambiguous', reason: 'appearance-inconsistent', appearance, margin };
  if (gain < MIN_GAIN_OVER_H0) return { klass: 'ambiguous', reason: 'h1-not-above-h0', appearance, margin };
  if (usable.length < needN || span + 1e-9 < needSpan) return { klass: 'ambiguous', reason: 'need-longer-observation', appearance, margin };
  if (appearance < needAppearance) return { klass: 'ambiguous', reason: 'appearance-below-bar', appearance, margin };
  if (margin != null && margin < (sceneCut ? MARGIN_AFTER_CUT : MARGIN)) return { klass: 'ambiguous', reason: 'rivals-too-close', appearance, margin };
  if (!sceneCut && !longGap && motion) return { klass: 'auto', reason: 'short-gap-motion-and-appearance', appearance, margin };
  if ((sceneCut || longGap) && edge && appearance >= ABS_APPEARANCE_STRONG && (margin == null || margin >= (sceneCut ? MARGIN_AFTER_CUT : MARGIN))) {
    return { klass: 'auto', reason: sceneCut ? 'scene-cut-strong-evidence' : 'late-edge-reentry', appearance, margin };
  }
  return { klass: 'ambiguous', reason: 'not-enough-to-link', appearance, margin };
}

function consecutiveAgree(samples: Sample[]): Sample[] {
  const visible = samples.filter((s) => s.seekStable && (s.visibility === 'visible' || s.visibility === 'partial') && finiteBox(s.box));
  if (!visible.length) return [];
  const kept: Sample[] = [visible[0]];
  for (let i = 1; i < visible.length; i += 1) {
    const prev = kept[kept.length - 1];
    if (boxIou(prev.box, visible[i].box) < EDIT_SPAN_MEASUREMENT.agreeIou) break;
    kept.push(visible[i]);
  }
  return kept;
}

function reverseAgree(samples: Sample[]): Sample[] {
  const visible = samples.filter((s) => s.seekStable && (s.visibility === 'visible' || s.visibility === 'partial') && finiteBox(s.box));
  if (!visible.length) return [];
  const kept: Sample[] = [visible[visible.length - 1]];
  for (let i = visible.length - 2; i >= 0; i -= 1) {
    const later = kept[0];
    if (boxIou(visible[i].box, later.box) < EDIT_SPAN_MEASUREMENT.agreeIou) break;
    kept.unshift(visible[i]);
  }
  return kept;
}

function mutualSamples(samples: Sample[]): Sample[] {
  const forward = new Set(consecutiveAgree(samples).map((s) => s.t.toFixed(3)));
  return reverseAgree(samples).filter((s) => forward.has(s.t.toFixed(3)));
}

function emptyCost(resumedFromT: number | null): EditSpanCost {
  return {
    decodedFrames: 0,
    reverseDecodedFrames: 0,
    peakResidentFrames: 0,
    peakLedgerBytes: 0,
    wallMs: 0,
    candidateCount: 0,
    cancelled: false,
    resumedFromT,
  };
}

function ledgerBytes(sightings: Sighting[], ledger: EditSpanLedgerEntry[]): number {
  return (sightings.length + ledger.length) * 96;
}

export function exportGateForLinks(links: readonly EditSpanLink[], points?: readonly TrackingPoint[]): { ok: boolean; reason: string } {
  const badPoint = (points ?? []).find((p) => (
    (p.state === 'TRACKING_OK' || p.state === 'TRACKING_WARNING')
    && p.editSpanResolved === true
    && p.manual !== true
  ));
  if (badPoint) return { ok: false, reason: 'export-would-keep-unconfirmed-normal-track' };
  const invented = links.find((link) => (
    (link.visibility === 'absent' || link.visibility === 'full-occluded')
    && link.state !== 'TARGET_LOST'
  ));
  if (invented) return { ok: false, reason: 'absent-frame-marked-linked' };
  return { ok: true, reason: 'no-unconfirmed-other-in-export' };
}

function baseResult(partial: Omit<EditSpanResult, 'experiment' | 'productDefaultChanged' | 'identityConfirmed' | 'anchorUpdates' | 'learnedFromProvisional'>): EditSpanResult {
  return {
    ...partial,
    experiment: EDIT_SPAN_REENTRY_EXPERIMENT,
    productDefaultChanged: false,
    identityConfirmed: false,
    anchorUpdates: 0,
    learnedFromProvisional: false,
  };
}

export async function runEditSpanSearch(input: EditSpanSearchInput): Promise<EditSpanResult> {
  const now = input.now ?? Date.now;
  const caps = { ...EDIT_SPAN_CAPS, ...input.caps };
  const started = now();
  const anchorLength = input.anchors.length;
  const resumeFromT = input.resumeFromT ?? null;
  const cost = emptyCost(resumeFromT);
  const sightings: Sighting[] = [];
  const ledger: EditSpanLedgerEntry[] = [];
  const bandsVisited: SearchBand[] = [];
  const searchEnd = input.horizonSec == null
    ? input.editEnd
    : Math.min(input.editEnd, input.lostT + input.horizonSec);
  const fail = (status: EditSpanResult['status'], reason: string, message: string): EditSpanResult => {
    if (input.anchors.length !== anchorLength) throw new Error('anchor-mutated');
    const exportGate = exportGateForLinks([]);
    return baseResult({
      status,
      bandsVisited,
      searchEndT: searchEnd,
      horizonSec: input.horizonSec ?? null,
      links: [],
      question: null,
      ledger,
      sightings,
      cost: { ...cost, wallMs: Math.max(0, now() - started) },
      exportGate,
      failureReason: reason,
      progressMessage: message,
    });
  };

  if (!(searchEnd > input.lostT)) return fail('no-span', 'empty-edit-span', '살펴볼 편집 구간이 없습니다.');
  if (input.readGeneration() !== input.generation) return fail('stale', 'generation-mismatch', '이전 탐색 결과는 반영하지 않습니다.');
  if (input.signal?.aborted) return fail('cancelled', 'aborted', '탐색을 취소했습니다.');

  const bands = planEditSpanBands(input.lostT, searchEnd)
    .filter((band) => resumeFromT == null || band.end > resumeFromT + 1e-6);
  const chains: Chain[] = [];
  let chainSeq = 0;
  let stopReason: string | null = null;

  const fold = (frame: SearchFrame) => {
    const seekStable = Number.isFinite(frame.reportedTSec)
      && Math.abs(frame.reportedTSec - frame.requestedTSec) <= EDIT_SPAN_MEASUREMENT.seekToleranceSec;
    if (!seekStable) {
      ledger.push({
        tSec: frame.requestedTSec, candidateId: null, action: 'seek-unstable', reason: 'seek-time-mismatch',
        appearance: null, margin: null, sceneCut: frame.sceneCut, scoreIsProbability: false,
      });
    }
    for (const candidate of frame.candidates) {
      sightings.push({
        tSec: frame.requestedTSec,
        box: candidate.box,
        detectorScore: candidate.detectorScore,
        seekStable,
        candidateId: candidate.id,
      });
    }
    cost.candidateCount = sightings.length;
    const reset = frame.sceneCut || frame.cameraReset;
    if (reset) for (const chain of chains) chain.closed = true;
    const used = new Set<number>();
    if (!reset) {
      for (const chain of chains) {
        if (chain.closed) continue;
        let best = -1;
        let bestIou = 0.3;
        frame.candidates.forEach((candidate, index) => {
          if (used.has(index)) return;
          const iou = boxIou(chain.samples[chain.samples.length - 1].box, candidate.box);
          if (iou >= bestIou) { bestIou = iou; best = index; }
        });
        if (best >= 0) used.add(best);
        else if (frame.requestedTSec - chain.samples[chain.samples.length - 1].t > 0.5) chain.closed = true;
        if (best >= 0) {
          const candidate = frame.candidates[best];
          const rivals = frame.candidates.filter((_, index) => index !== best).map((row) => row.appearance).filter((v): v is number => v != null);
          chain.samples.push({
            t: frame.requestedTSec,
            box: candidate.box,
            appearance: candidate.appearance,
            detectorScore: candidate.detectorScore,
            visibility: candidate.visibility,
            sceneCut: false,
            enteredFromEdge: enteredFromEdge(candidate.box, input.frameWidth, input.frameHeight),
            rivalAppearance: rivals.length ? Math.max(...rivals) : null,
            knownOtherConflict: candidate.knownOtherConflict,
            seekStable,
            candidateId: candidate.id,
          });
        }
      }
    }
    frame.candidates.forEach((candidate, index) => {
      if (used.has(index)) return;
      const rivals = frame.candidates.filter((_, other) => other !== index).map((row) => row.appearance).filter((v): v is number => v != null);
      const chain: Chain = { id: `chain-${chainSeq += 1}`, closed: false, samples: [] };
      chain.samples.push({
        t: frame.requestedTSec,
        box: candidate.box,
        appearance: candidate.appearance,
        detectorScore: candidate.detectorScore,
        visibility: candidate.visibility,
        sceneCut: reset,
        enteredFromEdge: enteredFromEdge(candidate.box, input.frameWidth, input.frameHeight),
        rivalAppearance: rivals.length ? Math.max(...rivals) : null,
        knownOtherConflict: candidate.knownOtherConflict,
        seekStable,
        candidateId: candidate.id,
      });
      chains.push(chain);
    });
  };

  for (const band of bands) {
    bandsVisited.push(band.band);
    const step = band.band === 'fast-0-2' ? 0.2 : 0.5;
    const start = resumeFromT != null ? Math.max(band.start, resumeFromT) : band.start;
    const times = sampleTimes(start, band.end, step);
    for (const group of chunkTimes(times, caps.chunkSamples)) {
      if (input.signal?.aborted) return fail('cancelled', 'aborted', '탐색을 취소했습니다.');
      if (input.readGeneration() !== input.generation) return fail('stale', 'generation-mismatch', '이전 탐색 결과는 반영하지 않습니다.');
      if (now() - started > caps.maxWallMs) { stopReason = 'wall-cap'; break; }
      if (cost.decodedFrames >= caps.maxDecodedFrames) { stopReason = 'frame-cap'; break; }
      const chunk = await input.pullChunk({ band: band.band, start: group[0], end: group[group.length - 1] + step, times: group });
      if (chunk === 'cancelled' || input.signal?.aborted) return fail('cancelled', 'aborted', '탐색을 취소했습니다.');
      const resident = chunk.frames.length;
      cost.peakResidentFrames = Math.max(cost.peakResidentFrames, resident);
      if (resident > caps.maxResidentFrames) return fail('resource-cap', 'resident-frames', '한 번에 올리는 프레임이 상한을 넘었습니다.');
      cost.decodedFrames += chunk.decodedFrames;
      cost.peakLedgerBytes = Math.max(cost.peakLedgerBytes, ledgerBytes(sightings, ledger) + chunk.bytes);
      if (cost.peakLedgerBytes > caps.maxLedgerBytes) { stopReason = 'memory-cap'; break; }
      const byTime = new Map(chunk.frames.map((frame) => [frame.requestedTSec.toFixed(3), frame]));
      for (const t of group) {
        const frame = byTime.get(t.toFixed(3));
        if (frame) fold(frame);
        else ledger.push({
          tSec: t, candidateId: null, action: 'absent', reason: 'no-frame',
          appearance: null, margin: null, sceneCut: false, scoreIsProbability: false,
        });
      }
    }
    if (stopReason) break;
  }

  const ranked = chains.map((chain) => ({ chain, ...classifyChain(chain, input.lastCertainT, input.lastCertainBox) }))
    .sort((a, b) => (b.appearance ?? -1) - (a.appearance ?? -1));
  for (const row of ranked) {
    ledger.push({
      tSec: row.chain.samples[0]?.t ?? input.lostT,
      candidateId: row.chain.id,
      action: row.klass === 'auto' ? 'provisional' : row.klass,
      reason: row.reason,
      appearance: row.appearance,
      margin: row.margin,
      sceneCut: row.chain.samples.some((s) => s.sceneCut),
      scoreIsProbability: false,
    });
  }

  const autos = ranked.filter((row) => row.klass === 'auto');
  const ambiguous = ranked.filter((row) => row.klass === 'ambiguous');
  const closeRival = autos.length === 1 && ambiguous.some((row) => (
    row.appearance != null && autos[0].appearance != null && Math.abs(autos[0].appearance - row.appearance) < MARGIN
  ));
  let chosen = autos.length === 1 && !closeRival ? autos[0] : null;
  if (autos.length > 1) chosen = null;

  let mutual: Sample[] = [];
  if (chosen) {
    const samples = chosen.chain.samples;
    const end = samples[samples.length - 1].t;
    const begin = samples[0].t;
    bandsVisited.push('reverse');
    let reverseFrames = 0;
    for (let cursor = end; cursor >= begin - 1e-6 && reverseFrames < caps.maxReverseDecodedFrames;) {
      const group = sampleTimes(Math.max(begin, cursor - 0.8), cursor + 0.001, 0.2);
      if (!group.length) break;
      if (input.signal?.aborted) return fail('cancelled', 'aborted', '탐색을 취소했습니다.');
      const chunk = await input.pullChunk({ band: 'reverse', start: group[0], end: cursor + 0.2, times: group });
      if (chunk === 'cancelled') return fail('cancelled', 'aborted', '탐색을 취소했습니다.');
      cost.peakResidentFrames = Math.max(cost.peakResidentFrames, chunk.frames.length);
      if (chunk.frames.length > caps.maxResidentFrames) return fail('resource-cap', 'resident-frames', '한 번에 올리는 프레임이 상한을 넘었습니다.');
      reverseFrames += chunk.decodedFrames;
      cost.reverseDecodedFrames += chunk.decodedFrames;
      const unstable = chunk.frames.some((frame) => Math.abs(frame.reportedTSec - frame.requestedTSec) > EDIT_SPAN_MEASUREMENT.seekToleranceSec);
      if (unstable) {
        return fail('reproducibility-failure', 'reverse-seek-unstable', '같은 시각을 다시 읽었더니 프레임 시각이 어긋났습니다. 이 사건은 확정하지 않습니다.');
      }
      cursor = group[0] - 0.2;
    }
    mutual = mutualSamples(samples);
    if (mutual.length < MIN_OBSERVATIONS) chosen = null;
  }

  const eventId = input.eventId ?? `edit-span-${input.lostT.toFixed(3)}`;
  const prior = input.priorQuestionsForEvent ?? 0;
  const questionFrom = (rows: typeof ranked): EditSpanQuestion => {
    const pool = rows.filter((row) => row.klass !== 'reject');
    const top = (pool.length ? pool : rows).slice(0, 2);
    const rep = top[0]?.chain.samples.filter((s) => s.visibility === 'visible').at(-1) ?? top[0]?.chain.samples.at(-1);
    return {
      eventId,
      representativeTSec: rep?.t ?? input.lostT,
      candidate1: top[0] ? {
        id: top[0].chain.id,
        tSec: rep?.t ?? top[0].chain.samples[0].t,
        box: (rep ?? top[0].chain.samples[0]).box,
        appearance: top[0].appearance,
      } : null,
      candidate2: top[1] ? {
        id: top[1].chain.id,
        tSec: top[1].chain.samples.at(-1)?.t ?? top[1].chain.samples[0].t,
        box: (top[1].chain.samples.at(-1) ?? top[1].chain.samples[0]).box,
        appearance: top[1].appearance,
      } : null,
      noneLabel: '해당 없음/아직 보이지 않음',
      questionsForEvent: 1,
      repeatOfSameEvent: prior,
    };
  };

  if (input.anchors.length !== anchorLength) throw new Error('anchor-mutated');
  cost.wallMs = Math.max(0, now() - started);
  cost.peakLedgerBytes = Math.max(cost.peakLedgerBytes, ledgerBytes(sightings, ledger));

  if (chosen && mutual.length) {
    const supported = new Set(mutual.map((s) => s.t.toFixed(3)));
    const links: EditSpanLink[] = [];
    const seen = new Set<string>();
    for (const sample of chosen.chain.samples) {
      const key = sample.t.toFixed(3);
      if (seen.has(key)) continue;
      seen.add(key);
      if (supported.has(key)) {
        links.push({ tSec: sample.t, box: sample.box, state: 'PROVISIONAL_LINK', reason: chosen.reason, visibility: sample.visibility });
      } else {
        links.push({
          tSec: sample.t,
          box: null,
          state: 'TARGET_LOST',
          reason: sample.visibility === 'full-occluded' || sample.visibility === 'absent' ? 'no-invented-box' : 'directions-disagree',
          visibility: sample.visibility,
        });
      }
    }
    const exportGate = exportGateForLinks(links);
    return baseResult({
      status: 'auto-provisional',
      bandsVisited,
      searchEndT: searchEnd,
      horizonSec: input.horizonSec ?? null,
      links,
      question: null,
      ledger,
      sightings,
      cost,
      exportGate,
      failureReason: stopReason,
      progressMessage: '충분한 근거가 있는 보이는 구간만 잠정으로 연결했습니다. 기준점은 바꾸지 않았습니다.',
    });
  }

  const question = questionFrom(ranked);
  const status: EditSpanResult['status'] = stopReason ? 'resource-cap' : 'needs-question';
  return baseResult({
    status,
    bandsVisited,
    searchEndT: searchEnd,
    horizonSec: input.horizonSec ?? null,
    links: [],
    question,
    ledger,
    sightings,
    cost,
    exportGate: exportGateForLinks([]),
    failureReason: stopReason ?? (ranked.length ? 'ambiguous-or-insufficient' : 'no-candidate'),
    progressMessage: stopReason
      ? '시간 또는 자원 상한에 도달했습니다. 이 사건만 한 번 묻습니다. 취소할 수 있습니다.'
      : '구간 끝까지 봤지만 한 사람으로 정하지 못했습니다. 이 사건만 한 번 묻습니다.',
  });
}

export function reviseTrackingPoints(original: readonly TrackingPoint[], result: EditSpanResult, lostT: number, editEnd: number): TrackingPoint[] {
  const gate = exportGateForLinks(result.links, original);
  if (!gate.ok || result.status === 'cancelled' || result.status === 'stale' || result.status === 'reproducibility-failure') {
    return original.map((point) => ({ ...point }));
  }
  const byTime = new Map(result.links.map((link) => [link.tSec.toFixed(3), link]));
  return original.map((point) => {
    if (point.timestamp < lostT - 1e-6 || point.timestamp > editEnd + 1e-6) return { ...point };
    let link: EditSpanLink | undefined;
    let best = 0.16;
    for (const row of result.links) {
      const gap = Math.abs(row.tSec - point.timestamp);
      if (gap < best) { best = gap; link = row; }
    }
    if (!link && result.status !== 'auto-provisional') return { ...point };
    if (result.status === 'auto-provisional' && !link) {
      return {
        ...point,
        state: 'TARGET_LOST',
        identityLifecycle: 'LOST_UNCERTAIN',
        editSpanResolved: true,
        cameraHold: true,
        bbox: { x: 0, y: 0, width: 0, height: 0 },
        confidence: 0,
        reid_similarity: 0,
      };
    }
    if (!link) return { ...point };
    if (link.state === 'PROVISIONAL_LINK' && link.box) {
      return {
        ...point,
        bbox: { ...link.box },
        state: 'PROVISIONAL_LINK',
        identityLifecycle: 'REACQUIRED_PROVISIONAL',
        editSpanResolved: true,
        cameraHold: false,
        confidence: 0.5,
        reid_similarity: 0,
        manual: false,
      };
    }
    return {
      ...point,
      state: 'TARGET_LOST',
      identityLifecycle: link.visibility === 'absent' ? 'OUT_OF_VIEW' : 'LOST_UNCERTAIN',
      editSpanResolved: true,
      cameraHold: true,
      bbox: { x: 0, y: 0, width: 0, height: 0 },
      confidence: 0,
      reid_similarity: 0,
    };
  });
}

export function applyEditSpanChoice(input: {
  result: EditSpanResult;
  choice: 'candidate-1' | 'candidate-2' | 'none';
  original: readonly TrackingPoint[];
  lostT: number;
  editEnd: number;
}): { points: TrackingPoint[]; anchorUpdates: 0; learnedFromChoice: false; questionsForEvent: 1 } {
  const question = input.result.question;
  const picked = input.choice === 'candidate-1' ? question?.candidate1 : input.choice === 'candidate-2' ? question?.candidate2 : null;
  if (!picked || input.choice === 'none') {
    const points = input.original.map((point) => {
      if (point.timestamp < input.lostT - 1e-6 || point.timestamp > input.editEnd + 1e-6) return { ...point };
      return {
        ...point,
        state: 'TARGET_LOST',
        identityLifecycle: 'OUT_OF_VIEW' as const,
        editSpanResolved: true,
        cameraHold: true,
        bbox: { x: 0, y: 0, width: 0, height: 0 },
        confidence: 0,
        reid_similarity: 0,
      };
    });
    return { points, anchorUpdates: 0, learnedFromChoice: false, questionsForEvent: 1 };
  }
  const points = input.original.map((point) => {
    if (Math.abs(point.timestamp - picked.tSec) > 0.25) {
      if (point.timestamp < input.lostT - 1e-6 || point.timestamp > input.editEnd + 1e-6) return { ...point };
      if (point.state === 'TRACKING_OK' || point.state === 'TRACKING_WARNING') {
        return {
          ...point,
          state: 'TARGET_LOST',
          identityLifecycle: 'LOST_UNCERTAIN' as const,
          editSpanResolved: true,
          cameraHold: true,
          confidence: 0,
        };
      }
      return { ...point, editSpanResolved: true };
    }
    return {
      ...point,
      bbox: { ...picked.box },
      state: 'PROVISIONAL_LINK',
      identityLifecycle: 'REACQUIRED_PROVISIONAL' as const,
      editSpanResolved: true,
      manual: false,
      confidence: 0.5,
      reid_similarity: 0,
    };
  });
  return { points, anchorUpdates: 0, learnedFromChoice: false, questionsForEvent: 1 };
}

export function sameEventQuestion(first: EditSpanQuestion, second: EditSpanQuestion): boolean {
  return first.eventId === second.eventId && second.questionsForEvent === 1;
}

export interface ReentryEventLabel {
  eventId: string;
  grade: 'synthetic' | 'model-reviewed' | 'human-single' | 'human-dual' | 'sealed';
  reappearT: number | null;
  editEnd: number;
  truthBox: SpanBox | null;
  neverReturns: boolean;
}

export interface RateReport {
  value: number | null;
  successes: number | null;
  total: number | null;
  wilson95: { low: number; high: number } | null;
  status: 'measured' | '미측정';
}

export function wilsonInterval95(successes: number, total: number): { low: number; high: number } | null {
  if (!Number.isInteger(total) || total <= 0 || successes < 0 || successes > total) return null;
  const z = 1.96;
  const n = total;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return {
    low: Math.max(0, (centre - margin) / denom),
    high: Math.min(1, (centre + margin) / denom),
  };
}

export function rateReport(successes: number | null, total: number | null): RateReport {
  if (successes == null || total == null || total <= 0) {
    return { value: null, successes: null, total: total ?? null, wilson95: null, status: '미측정' };
  }
  return {
    value: successes / total,
    successes,
    total,
    wilson95: wilsonInterval95(successes, total),
    status: 'measured',
  };
}

function scoreInRange(score: number | null): boolean {
  return score != null && score >= EDIT_SPAN_MEASUREMENT.detectorScoreMin && score <= EDIT_SPAN_MEASUREMENT.detectorScoreMax;
}

export function inclusionForEvent(label: ReentryEventLabel, sightings: readonly Sighting[], windowSec: number | null): boolean | null {
  if (label.grade === 'sealed' || label.neverReturns || label.reappearT == null || !finiteBox(label.truthBox)) return null;
  const end = windowSec == null ? label.editEnd : label.reappearT + windowSec;
  return sightings.some((row) => (
    row.seekStable
    && row.tSec + 1e-6 >= label.reappearT!
    && row.tSec <= end + 1e-6
    && scoreInRange(row.detectorScore)
    && boxIou(row.box, label.truthBox!) >= EDIT_SPAN_MEASUREMENT.inclusionIou
  ));
}

export function firstCandidateDelaySec(label: ReentryEventLabel, sightings: readonly Sighting[]): number | null {
  if (label.neverReturns || label.reappearT == null || !finiteBox(label.truthBox)) return null;
  const hits = sightings.filter((row) => (
    row.seekStable
    && row.tSec + 1e-6 >= label.reappearT!
    && scoreInRange(row.detectorScore)
    && boxIou(row.box, label.truthBox!) >= EDIT_SPAN_MEASUREMENT.inclusionIou
  )).map((row) => row.tSec - label.reappearT!);
  if (!hits.length) return null;
  return Math.min(...hits);
}

export interface PathScore {
  autoCorrect: boolean | null;
  wrongConfirm: boolean | null;
  wrongNormalSeconds: number | null;
  recoveredVisibleIou: number | null;
  unconfirmedFrameRatio: number | null;
  questions: number;
  repeatQuestions: number;
  decisionMissDespiteCandidate: boolean | null;
}

export function scorePath(label: ReentryEventLabel, result: EditSpanResult, points: readonly TrackingPoint[]): PathScore {
  const included = inclusionForEvent(label, result.sightings, null);
  const linked = result.status === 'auto-provisional';
  const linkedWrong = linked && !!label.truthBox && result.links.some((link) => (
    link.state === 'PROVISIONAL_LINK' && link.box && boxIou(link.box, label.truthBox!) < EDIT_SPAN_MEASUREMENT.inclusionIou
  ));
  const linkedRight = linked && !!label.truthBox && result.links.some((link) => (
    link.state === 'PROVISIONAL_LINK' && link.box && boxIou(link.box, label.truthBox!) >= EDIT_SPAN_MEASUREMENT.inclusionIou
  ));
  const autoCorrect = label.neverReturns ? !linked : linkedRight && !linkedWrong;
  const wrongConfirm = label.neverReturns ? linked : linkedWrong;
  let wrongNormal = 0;
  let visible = 0;
  let recoveredHit = 0;
  let recovered = 0;
  let unconfirmed = 0;
  let spanFrames = 0;
  for (const point of points) {
    if (!Number.isFinite(point.timestamp)) continue;
    spanFrames += 1;
    const normal = point.state === 'TRACKING_OK' || point.state === 'TRACKING_WARNING';
    if (label.neverReturns || !label.truthBox) {
      if (normal) wrongNormal += 0.2;
    } else if (normal && boxIou(point.bbox, label.truthBox) < EDIT_SPAN_MEASUREMENT.inclusionIou) {
      wrongNormal += 0.2;
      visible += 1;
    } else if (label.truthBox) {
      visible += 1;
    }
    if (point.state === 'PROVISIONAL_LINK' && label.truthBox && finiteBox(point.bbox)) {
      recovered += 1;
      if (boxIou(point.bbox, label.truthBox) >= EDIT_SPAN_MEASUREMENT.inclusionIou) recoveredHit += 1;
    }
    if (point.editSpanResolved === true && point.state !== 'PROVISIONAL_LINK') unconfirmed += 1;
  }
  return {
    autoCorrect: label.grade === 'sealed' ? null : autoCorrect,
    wrongConfirm: label.grade === 'sealed' ? null : wrongConfirm,
    wrongNormalSeconds: label.grade === 'sealed' ? null : wrongNormal,
    recoveredVisibleIou: recovered > 0 ? recoveredHit / recovered : null,
    unconfirmedFrameRatio: spanFrames > 0 ? unconfirmed / spanFrames : null,
    questions: result.question ? 1 : 0,
    repeatQuestions: result.question?.repeatOfSameEvent ?? 0,
    decisionMissDespiteCandidate: included == null ? null : included && !linkedRight,
  };
}

export interface DevFrameSpec {
  t: number;
  reportedT?: number;
  sceneCut?: boolean;
  cameraReset?: boolean;
  candidates: SearchCandidate[];
}

export function pullFromSpecs(specs: readonly DevFrameSpec[]) {
  const log: ChunkRequest[] = [];
  let peak = 0;
  const pullChunk = async (request: ChunkRequest): Promise<SearchChunk> => {
    log.push(request);
    const frames: SearchFrame[] = request.times.map((t) => {
      const spec = specs.find((row) => Math.abs(row.t - t) < 0.051);
      return {
        requestedTSec: t,
        reportedTSec: spec?.reportedT ?? t,
        candidates: spec?.candidates ?? [],
        sceneCut: spec?.sceneCut === true,
        cameraReset: spec?.cameraReset === true,
      };
    });
    peak = Math.max(peak, frames.length);
    return { frames, decodedFrames: frames.length, bytes: frames.length * 128 };
  };
  return { pullChunk, log, peak: () => peak };
}

const person = (id: string, box: SpanBox, appearance: number, score = 0.7, visibility: Visibility = 'visible'): SearchCandidate => ({
  id, box, appearance, detectorScore: score, confirmedOtherSimilarity: null, knownOtherConflict: false, visibility,
});

function grid(from: number, to: number, step: number, make: (t: number) => DevFrameSpec): DevFrameSpec[] {
  const rows: DevFrameSpec[] = [];
  for (let t = from; t <= to + 1e-6; t += step) rows.push(make(Number(t.toFixed(3))));
  return rows;
}

export interface DevCase {
  id: string;
  label: ReentryEventLabel;
  frames: DevFrameSpec[];
  lastCertainBox: SpanBox;
  lostT: number;
  editEnd: number;
  note: string;
}

const targetBox: SpanBox = { x: 100, y: 40, width: 80, height: 200 };
const edgeBox: SpanBox = { x: 4, y: 40, width: 80, height: 200 };
const otherBox: SpanBox = { x: 420, y: 50, width: 80, height: 200 };

export function devReentryCases(): DevCase[] {
  return [
    {
      id: 'late-return',
      note: '8초 뒤에 가장자리에서 다시 보임. 2초 창 밖.',
      lostT: 1,
      editEnd: 20,
      lastCertainBox: targetBox,
      label: { eventId: 'late-return', grade: 'synthetic', reappearT: 9, editEnd: 20, truthBox: edgeBox, neverReturns: false },
      frames: grid(9, 11.5, 0.5, (t) => ({ t, candidates: [person('true', edgeBox, 0.93)] })),
    },
    {
      id: 'never-returns',
      note: '다시 나오지 않음.',
      lostT: 1,
      editEnd: 12,
      lastCertainBox: targetBox,
      label: { eventId: 'never-returns', grade: 'synthetic', reappearT: null, editEnd: 12, truthBox: null, neverReturns: true },
      frames: [],
    },
    {
      id: 'others-only',
      note: '다른 사람만 있고 외형이 기준에 못 미침.',
      lostT: 1,
      editEnd: 12,
      lastCertainBox: targetBox,
      label: { eventId: 'others-only', grade: 'synthetic', reappearT: null, editEnd: 12, truthBox: null, neverReturns: true },
      frames: grid(3, 4, 0.2, (t) => ({ t, candidates: [person('other', otherBox, 0.62)] })),
    },
    {
      id: 'similar-clothes',
      note: '비슷한 외형 두 명. 차이만으로 정하지 않음.',
      lostT: 1,
      editEnd: 16,
      lastCertainBox: targetBox,
      label: { eventId: 'similar-clothes', grade: 'synthetic', reappearT: 6, editEnd: 16, truthBox: edgeBox, neverReturns: false },
      frames: grid(6, 7.2, 0.2, (t) => ({
        t,
        candidates: [person('true', edgeBox, 0.91), person('other', otherBox, 0.88)],
      })),
    },
    {
      id: 'early-wrong-then-true',
      note: '처음 후보는 자리·시간이 부족하고, 나중 후보가 가장자리에서 길게 보임.',
      lostT: 1,
      editEnd: 20,
      lastCertainBox: targetBox,
      label: { eventId: 'early-wrong-then-true', grade: 'synthetic', reappearT: 12, editEnd: 20, truthBox: edgeBox, neverReturns: false },
      frames: [
        ...grid(1.2, 1.4, 0.2, (t) => ({ t, candidates: [person('wrong', otherBox, 0.74)] })),
        ...grid(12, 14, 0.5, (t) => ({ t, candidates: [person('true', edgeBox, 0.93)] })),
      ],
    },
    {
      id: 'same-place-lookalike',
      note: '같은 자리에서 옷이 비슷하면 아직 가리지 못함.',
      lostT: 1,
      editEnd: 6,
      lastCertainBox: targetBox,
      label: { eventId: 'same-place-lookalike', grade: 'synthetic', reappearT: 1.2, editEnd: 6, truthBox: { x: 40, y: 40, width: 70, height: 180 }, neverReturns: false },
      frames: grid(1.2, 2.2, 0.2, (t) => ({ t, candidates: [person('lookalike', targetBox, 0.91)] })),
    },
    {
      id: 'scene-cut',
      note: '장면 전환 뒤 속도 연속성을 쓰지 않음.',
      lostT: 1,
      editEnd: 14,
      lastCertainBox: targetBox,
      label: { eventId: 'scene-cut', grade: 'synthetic', reappearT: 8, editEnd: 14, truthBox: edgeBox, neverReturns: false },
      frames: grid(8, 8.6, 0.2, (t) => ({ t, sceneCut: t === 8, candidates: [person('true', edgeBox, 0.84)] })),
    },
    {
      id: 'occlusion-gap',
      note: '완전 가림 구간에는 상자를 만들지 않음.',
      lostT: 1,
      editEnd: 8,
      lastCertainBox: targetBox,
      label: { eventId: 'occlusion-gap', grade: 'synthetic', reappearT: 1.2, editEnd: 8, truthBox: targetBox, neverReturns: false },
      frames: [
        ...grid(1.2, 2.0, 0.2, (t) => ({ t, candidates: [person('true', targetBox, 0.93)] })),
        { t: 2.2, candidates: [person('true', targetBox, 0.93, 0.7, 'full-occluded')] },
        ...grid(2.4, 3.2, 0.2, (t) => ({ t, candidates: [person('true', targetBox, 0.93)] })),
      ],
    },
  ];
}

export async function runOneDevCase(devCase: DevCase, horizonSec: number | null, reportedShift = 0) {
  const specs = devCase.frames.map((frame) => ({ ...frame, reportedT: (frame.reportedT ?? frame.t) + reportedShift }));
  const source = pullFromSpecs(specs);
  const anchors = Object.freeze([{ id: 'user-confirmed' }]);
  const result = await runEditSpanSearch({
    lostT: devCase.lostT,
    editEnd: devCase.editEnd,
    lastCertainT: devCase.lostT - 0.2,
    lastCertainBox: devCase.lastCertainBox,
    frameWidth: 640,
    frameHeight: 360,
    generation: 1,
    readGeneration: () => 1,
    anchors,
    pullChunk: source.pullChunk,
    horizonSec,
    eventId: devCase.id,
    now: () => 1_000,
  });
  const original: TrackingPoint[] = [];
  for (let t = devCase.lostT; t <= devCase.editEnd; t += 0.2) {
    original.push({
      timestamp: Number(t.toFixed(3)),
      bbox: { ...otherBox },
      confidence: 0.9,
      tracking_health: 0.9,
      reid_similarity: 0.9,
      state: 'TRACKING_OK',
    });
  }
  const points = result.status === 'auto-provisional' ? reviseTrackingPoints(original, result, devCase.lostT, devCase.editEnd) : original;
  return { result, points, requests: source.log, anchors, peak: source.peak() };
}

export async function runDevReentryDiagnostic() {
  const cases = [];
  for (const devCase of devReentryCases()) {
    const next = await runOneDevCase(devCase, null);
    const previous = await runOneDevCase(devCase, LOOKAHEAD_BUDGET_SEC);
    cases.push({
      id: devCase.id,
      note: devCase.note,
      grade: devCase.label.grade,
      next: scorePath(devCase.label, next.result, next.points),
      previous: scorePath(devCase.label, previous.result, previous.points),
      nextStatus: next.result.status,
      previousStatus: previous.result.status,
      inclusion: {
        sec2: inclusionForEvent(devCase.label, next.result.sightings, 2),
        sec5: inclusionForEvent(devCase.label, next.result.sightings, 5),
        sec10: inclusionForEvent(devCase.label, next.result.sightings, 10),
        sec30: inclusionForEvent(devCase.label, next.result.sightings, 30),
        editEnd: inclusionForEvent(devCase.label, next.result.sightings, null),
      },
      firstDelaySec: firstCandidateDelaySec(devCase.label, next.result.sightings),
      questions: next.result.question ? 1 : 0,
      cost: next.result.cost,
      exportOk: next.result.exportGate.ok,
    });
  }
  const counted = cases.filter((row) => row.next.autoCorrect != null);
  const autoHits = counted.filter((row) => row.next.autoCorrect).length;
  const wrongHits = counted.filter((row) => row.next.wrongConfirm).length;
  return {
    kind: 'synthetic-dev-diagnostic',
    notSealedAudit: true,
    notPitchDeck: true,
    measurement: EDIT_SPAN_MEASUREMENT,
    gates: PRODUCT_DEFAULT_RELEASE_GATES,
    cases,
    aggregate: {
      autoCorrect: rateReport(autoHits, counted.length),
      wrongConfirm: rateReport(wrongHits, counted.length),
      realFootage: '미측정' as const,
      modelReviewed: '미측정' as const,
      humanReviewed: '미측정' as const,
      sealed: '미측정' as const,
    },
  };
}

export function releaseGateTable(input: {
  humanDualEvents: number | null;
  wrongConfirm: RateReport;
  autoConfirm: RateReport;
  questionsPerEvent: number | null;
  repeatQuestions: number | null;
  wrongNormalFrameRate: RateReport;
  exportFailures: number | null;
  seekMismatches: number | null;
  androidDeviceChecked: boolean;
}): { met: boolean; agentMayEnable: false; rows: Array<{ gate: string; required: string; observed: string; met: boolean }> } {
  const rows = [
    { gate: '사람 검수 재등장 사건', required: `>= ${PRODUCT_DEFAULT_RELEASE_GATES.humanDualReentryEventsMin}`, observed: input.humanDualEvents == null ? '미측정' : String(input.humanDualEvents), met: (input.humanDualEvents ?? 0) >= PRODUCT_DEFAULT_RELEASE_GATES.humanDualReentryEventsMin },
    { gate: '잘못된 확정 상한', required: `95% 상한 <= ${PRODUCT_DEFAULT_RELEASE_GATES.wrongConfirmUpper95Max}`, observed: input.wrongConfirm.status === '미측정' ? '미측정' : String(input.wrongConfirm.wilson95?.high ?? ''), met: input.wrongConfirm.wilson95 != null && input.wrongConfirm.wilson95.high <= PRODUCT_DEFAULT_RELEASE_GATES.wrongConfirmUpper95Max },
    { gate: '자동 연결 하한', required: `95% 하한 >= ${PRODUCT_DEFAULT_RELEASE_GATES.autoConfirmLower95Min}`, observed: input.autoConfirm.status === '미측정' ? '미측정' : String(input.autoConfirm.wilson95?.low ?? ''), met: input.autoConfirm.wilson95 != null && input.autoConfirm.wilson95.low >= PRODUCT_DEFAULT_RELEASE_GATES.autoConfirmLower95Min },
    { gate: '사건당 질문', required: `<= ${PRODUCT_DEFAULT_RELEASE_GATES.questionsPerEventMax}`, observed: input.questionsPerEvent == null ? '미측정' : String(input.questionsPerEvent), met: input.questionsPerEvent != null && input.questionsPerEvent <= PRODUCT_DEFAULT_RELEASE_GATES.questionsPerEventMax },
    { gate: '같은 사건 반복 질문', required: `<= ${PRODUCT_DEFAULT_RELEASE_GATES.repeatQuestionsMax}`, observed: input.repeatQuestions == null ? '미측정' : String(input.repeatQuestions), met: input.repeatQuestions != null && input.repeatQuestions <= PRODUCT_DEFAULT_RELEASE_GATES.repeatQuestionsMax },
    { gate: '보이는 프레임의 틀린 정상', required: `95% 상한 <= ${PRODUCT_DEFAULT_RELEASE_GATES.wrongNormalVisibleFrameUpper95Max}`, observed: input.wrongNormalFrameRate.status === '미측정' ? '미측정' : String(input.wrongNormalFrameRate.wilson95?.high ?? ''), met: input.wrongNormalFrameRate.wilson95 != null && input.wrongNormalFrameRate.wilson95.high <= PRODUCT_DEFAULT_RELEASE_GATES.wrongNormalVisibleFrameUpper95Max },
    { gate: '내보내기 미확정 연결', required: `${PRODUCT_DEFAULT_RELEASE_GATES.exportUnconfirmedOtherLinksMax}`, observed: input.exportFailures == null ? '미측정' : String(input.exportFailures), met: input.exportFailures === 0 },
    { gate: '반복 실행 결정 불일치', required: `${PRODUCT_DEFAULT_RELEASE_GATES.seekDecisionMismatchMax}`, observed: input.seekMismatches == null ? '미측정' : String(input.seekMismatches), met: input.seekMismatches === 0 },
    { gate: 'Android 실기기', required: '기록된 실기기 확인', observed: input.androidDeviceChecked ? '확인' : '미측정', met: input.androidDeviceChecked },
  ];
  return { met: rows.every((row) => row.met), agentMayEnable: false, rows };
}
