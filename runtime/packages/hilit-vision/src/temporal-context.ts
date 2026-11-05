/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·9994858f @license @preserve */
/** 어려운 녹화 구간의 실제 관측 비교. 학습된 Attention/VLM 또는 신원 인증이 아니다. */
export const TEMPORAL_CONTEXT_VERSION = 'hilit-context-observations-v1';
export const TEMPORAL_CONTEXT_POLICY = Object.freeze({
  preSec: 2, postSec: 4, expansionsSec: [8, 16] as readonly number[], stepSec: 0.25,
  maxReads: 160, maxWallMs: 60_000, maxCandidatesPerFrame: 32,
  seekToleranceSec: 0.05, appearanceMin: 0.86, rivalMarginMin: 0.12,
  minObservations: 3, minSpanSec: 0.5, associationIouMin: 0.3, reverseIouMin: 0.5,
  defaultEnabled: false, learnedAttentionReady: false, multimodalReady: false,
});

export interface ContextBox { x: number; y: number; width: number; height: number }
/** 실제 추적 상태가 어려워진 사건만 모은다. 장면 수를 정확도 분모로 쓰지 않는다. */
export function planContextEvents(points: readonly { timestamp: number; state: string }[],
  spans: readonly { start: number; end: number; level?: string }[], start: number, end: number): number[] {
  const times = [...points.filter((p) => /LOST|OCCLUDED|PROVISIONAL/.test(p.state)).map((p) => p.timestamp),
    ...spans.filter((s) => s.level === 'risk').map((s) => s.start)]
    .filter((t) => Number.isFinite(t) && t >= start && t < end).sort((a,b) => a-b);
  const events: number[] = [];
  for (const t of times) if (!events.length || t - events.at(-1)! > 6) events.push(t);
  return events.slice(0, 2);
}
export interface ContextCandidate {
  id: string; box: ContextBox; detectorScore: number; appearance: number | null;
  knownOtherConflict: boolean;
}
export interface ContextFrame {
  requestedTime: number;
  /** 실제 디코딩 시각. 알 수 없으면 null. 요청 시각으로 대신 채우지 않는다. */
  decodedTime: number | null;
  detector: 'ok' | 'unavailable' | 'error';
  candidates: readonly ContextCandidate[];
  /** 실제 공간 패치 입력에서 계산한 변화량. 동일인 점수/학습된 임베딩이 아니다. */
  patchFeatures: Float32Array | null;
  patchCount: number;
}
export interface ContextLedger {
  time: number; direction: 'forward' | 'reverse'; decodedTime: number | null;
  state: 'observed' | 'no-candidate' | 'unknown' | 'seek-mismatch' | 'scene-cut';
  candidateCount: number; patchCount: number;
}
export interface ContextObservation { time: number; candidateId: string; box: ContextBox; appearance: number }
export interface TemporalContextResult {
  version: typeof TEMPORAL_CONTEXT_VERSION;
  status: 'provisional' | 'needs-review' | 'not-observed' | 'unknown' | 'cancelled' | 'stale' | 'budget';
  reason: string;
  windows: Array<{ start: number; end: number }>;
  observations: ContextObservation[];
  reverseObservations: ContextObservation[];
  ledger: ContextLedger[];
  cost: { reads: number; decoded: number; reverseReads: number; wallMs: number; peakResidentFrames: number };
  productChanged: false; identityConfirmed: false; anchorsUpdated: 0;
  learnedAttentionReady: false; multimodalReady: false; scoreIsProbability: false;
  absenceConfirmed: false;
}
export interface TemporalContextInput {
  eventTime: number; editStart: number; editEnd: number;
  referenceTime: number; referenceBox: ContextBox;
  generation: number; readGeneration: () => number; signal?: { readonly aborted: boolean };
  /** 반드시 같은 영상의 새 관측을 반환. 역방향은 앞의 상자 배열을 뒤집어 반환하면 안 된다. */
  readFrame: (time: number, direction: 'forward' | 'reverse') => Promise<ContextFrame>;
  now?: () => number;
  setupCost?: { reads: number; decoded: number; wallMs: number };
  onProgress?: (done: number, max: number, direction: 'forward' | 'reverse') => void;
}

export function contextIou(a: ContextBox, b: ContextBox): number {
  const inter = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const union = a.width * a.height + b.width * b.height - inter;
  return union > 0 ? inter / union : 0;
}
function validBox(b: ContextBox): boolean {
  return [b.x, b.y, b.width, b.height].every(Number.isFinite) && b.width > 0 && b.height > 0
    && b.x >= 0 && b.y >= 0 && b.x + b.width <= 1.001 && b.y + b.height <= 1.001;
}
function validCandidate(c: ContextCandidate): boolean {
  return validBox(c.box) && Number.isFinite(c.detectorScore) && c.detectorScore >= 0.2 && c.detectorScore <= 1
    && c.appearance != null && Number.isFinite(c.appearance) && c.appearance >= 0 && c.appearance <= 1;
}
function patchChange(a: Float32Array | null, b: Float32Array | null): number | null {
  if (!a || !b || a.length !== b.length || !a.length) return null;
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

/** 16×16 픽셀 공간 패치의 RGB·명암 변화 입력. 학습된 선형 투영은 수행하지 않는다. */
export function patchObservations(rgba: Uint8ClampedArray, width: number, height: number): { features: Float32Array; count: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
      || width > 256 || height > 256 || rgba.length !== width * height * 4) throw new Error('invalid-patch-input');
  const cols = Math.ceil(width / 16), rows = Math.ceil(height / 16);
  const features = new Float32Array(cols * rows * 3);
  for (let py = 0; py < rows; py += 1) for (let px = 0; px < cols; px += 1) {
    const sums = [0, 0, 0]; let n = 0;
    for (let y = py * 16; y < Math.min(height, (py + 1) * 16); y += 1)
      for (let x = px * 16; x < Math.min(width, (px + 1) * 16); x += 1) {
        const offset = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) sums[channel] += rgba[offset + channel];
        n += 1;
      }
    const i = (py * cols + px) * 3;
    for (let channel = 0; channel < 3; channel += 1) features[i + channel] = sums[channel] / n / 255;
  }
  return { features, count: cols * rows };
}

export async function runTemporalContext(input: TemporalContextInput): Promise<TemporalContextResult> {
  const policy = TEMPORAL_CONTEXT_POLICY;
  const now = input.now ?? Date.now;
  const setup = input.setupCost ?? { reads: 0, decoded: 0, wallMs: 0 };
  const started = now() - setup.wallMs;
  const result: TemporalContextResult = {
    version: TEMPORAL_CONTEXT_VERSION, status: 'unknown', reason: 'insufficient-evidence', windows: [],
    observations: [], reverseObservations: [], ledger: [],
    cost: { reads: setup.reads, decoded: setup.decoded, reverseReads: 0, wallMs: 0, peakResidentFrames: 0 },
    productChanged: false, identityConfirmed: false, anchorsUpdated: 0, learnedAttentionReady: false,
    multimodalReady: false, scoreIsProbability: false, absenceConfirmed: false,
  };
  const finish = (status: TemporalContextResult['status'], reason: string) => {
    result.status = status; result.reason = reason; result.cost.wallMs = Math.max(0, now() - started); return result;
  };
  const interruption = (): TemporalContextResult['status'] | null => input.signal?.aborted ? 'cancelled'
    : input.readGeneration() !== input.generation ? 'stale'
    : result.cost.reads >= policy.maxReads || now() - started >= policy.maxWallMs ? 'budget' : null;
  if (![input.eventTime, input.editStart, input.editEnd, input.referenceTime].every(Number.isFinite)
    || ![setup.reads, setup.decoded, setup.wallMs].every((v) => Number.isFinite(v) && v >= 0)
    || input.editEnd <= input.editStart || input.eventTime < input.editStart || input.eventTime > input.editEnd
    || input.referenceTime < input.editStart || input.referenceTime > input.eventTime || !validBox(input.referenceBox))
    return finish('unknown', 'invalid-input');

  type Chain = { rows: ContextObservation[]; ambiguous: boolean };
  const chains: Chain[] = [];
  let prevPatch: Float32Array | null = null;
  let unknown = false, sceneCut = false, referenceSeen = false;
  const read = async (time: number, direction: 'forward' | 'reverse'): Promise<ContextFrame | null> => {
    const stop = interruption(); if (stop) { result.status = stop; return null; }
    result.cost.reads += 1;
    if (direction === 'reverse') result.cost.reverseReads += 1;
    let frame: ContextFrame;
    try { frame = await input.readFrame(time, direction); }
    catch { frame = { requestedTime: time, decodedTime: null, detector: 'error', candidates: [], patchFeatures: null, patchCount: 0 }; }
    const after = interruption(); if (after && after !== 'budget') { result.status = after; return null; }
    const stable = frame.decodedTime != null && Number.isFinite(frame.decodedTime)
      && Math.abs(frame.decodedTime - time) <= policy.seekToleranceSec
      && Number.isFinite(frame.requestedTime) && Math.abs(frame.requestedTime - time) <= 1e-6;
    if (frame.decodedTime != null) result.cost.decoded += 1;
    // 직전 패치 벡터 한 장 + 현재 한 장. 원본 프레임을 배열로 보관하지 않는다.
    result.cost.peakResidentFrames = Math.max(result.cost.peakResidentFrames, 2);
    const cut = direction === 'forward' && stable && (patchChange(prevPatch, frame.patchFeatures) ?? 0) > 0.35;
    if (direction === 'forward' && stable) prevPatch = frame.patchFeatures?.slice() ?? null;
    if (cut) { sceneCut = true; chains.length = 0; }
    const state = !stable ? 'seek-mismatch' : frame.detector !== 'ok' ? 'unknown'
      : cut ? 'scene-cut' : frame.candidates.length ? 'observed' : 'no-candidate';
    result.ledger.push({ time, direction, decodedTime: frame.decodedTime, state, candidateCount: frame.candidates.length, patchCount: frame.patchCount });
    input.onProgress?.(result.cost.reads, policy.maxReads, direction);
    if (!stable || frame.detector !== 'ok' || frame.candidates.length > policy.maxCandidatesPerFrame) { unknown = true; return null; }
    return frame;
  };

  // 영상 시작에서 사용자가 직접 고른 모습은 참조 자료. 모델의 높은 점수로 새 기준점을 만들지 않는다.
  const reference = await read(input.referenceTime, 'forward');
  if (interruption() && result.status !== 'unknown') return finish(result.status, result.status);
  if (!reference) return finish('unknown', 'reference-frame-unavailable');
  referenceSeen = reference.candidates.some((c) => validCandidate(c) && !c.knownOtherConflict
    && contextIou(c.box, input.referenceBox) >= policy.reverseIouMin && c.appearance! >= policy.appearanceMin);
  if (!referenceSeen) return finish('needs-review', 'reference-not-detected');
  prevPatch = null;

  const processed = new Set<number>();
  const start = Math.max(input.editStart, input.eventTime - policy.preSec);
  const select = (frame: ContextFrame, near?: ContextBox): ContextCandidate | null => {
    const candidates = frame.candidates.filter(validCandidate).sort((a, b) => b.appearance! - a.appearance!);
    const top = candidates[0];
    if (!top || top.knownOtherConflict || top.appearance! < policy.appearanceMin) return null;
    if (candidates[1] && top.appearance! - candidates[1].appearance! < policy.rivalMarginMin) return null;
    if (near && contextIou(top.box, near) < policy.associationIouMin) return null;
    return top;
  };
  let chosen: Chain | null = null;
  for (const post of [policy.postSec, ...policy.expansionsSec, Math.max(16, input.editEnd - input.eventTime)]) {
    const end = Math.min(input.editEnd, input.eventTime + post);
    result.windows.push({ start, end });
    const times = new Set<number>([start, end]);
    for (let t = start; t < end; t += policy.stepSec) times.add(Number(t.toFixed(6)));
    for (const time of [...times].sort((a, b) => a - b)) {
      if (processed.has(time)) continue;
      processed.add(time);
      const stop = interruption(); if (stop) return finish(stop, stop);
      const frame = await read(time, 'forward');
      if (result.status === 'cancelled' || result.status === 'stale') return finish(result.status, result.status);
      if (!frame) continue;
      const top = select(frame);
      if (!top) { for (const c of chains) if (c.rows.at(-1)!.time >= time - policy.stepSec * 1.5) c.ambiguous = true; continue; }
      const row: ContextObservation = { time, candidateId: top.id, box: { ...top.box }, appearance: top.appearance! };
      const active = chains.filter((c) => time - c.rows.at(-1)!.time <= policy.stepSec * 1.5
        && contextIou(c.rows.at(-1)!.box, top.box) >= policy.associationIouMin);
      if (active.length === 1 && !active[0].ambiguous) active[0].rows.push(row);
      else chains.push({ rows: [row], ambiguous: active.length > 1 });
    }
    const viable = chains.filter((c) => !c.ambiguous && c.rows.filter((r) => r.time >= input.eventTime).length >= policy.minObservations
      && c.rows.at(-1)!.time - Math.max(c.rows[0].time, input.eventTime) >= policy.minSpanSec);
    if (viable.length === 1) { chosen = viable[0]; break; }
    if (end >= input.editEnd) break;
  }
  const forwardStop = interruption(); if (forwardStop) return finish(forwardStop, forwardStop);
  if (!chosen) return finish(unknown ? 'unknown' : result.ledger.some((r) => r.state === 'observed' && r.time >= input.eventTime)
    ? 'needs-review' : 'not-observed', unknown ? 'incomplete-observation' : 'no-unique-continuous-candidate');
  result.observations = chosen.rows.map((r) => ({ ...r, box: { ...r.box } }));

  // 새로 디코딩하고 새 검출을 진행하며, 마지막 후보에서 역방향으로 따로 연결한다.
  let reverseBox: ContextBox | undefined;
  for (const forward of [...chosen.rows].reverse()) {
    const stop = interruption(); if (stop) return finish(stop, stop);
    const frame = await read(forward.time, 'reverse');
    if (result.status === 'cancelled' || result.status === 'stale') return finish(result.status, result.status);
    if (!frame) return finish('unknown', 'reverse-observation-unavailable');
    const candidate = select(frame, reverseBox);
    if (!candidate || contextIou(forward.box, candidate.box) < policy.reverseIouMin)
      return finish('needs-review', 'independent-reverse-disagrees');
    reverseBox = candidate.box;
    result.reverseObservations.push({ time: forward.time, candidateId: candidate.id, box: { ...candidate.box }, appearance: candidate.appearance! });
  }
  const stop = interruption(); if (stop) return finish(stop, stop);
  if (sceneCut || unknown) return finish(sceneCut ? 'needs-review' : 'unknown', sceneCut ? 'scene-cut-needs-confirmation' : 'incomplete-observation');
  return finish('provisional', 'fresh-forward-reverse-agree-not-identity-confirmation');
}
