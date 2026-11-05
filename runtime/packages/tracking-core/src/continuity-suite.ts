/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·a4e8148f @license @preserve */
/**
 * 2026-09-24 감사와 같은 판정 이름으로 추적 수율을 다시 센다.
 *
 * 이 모듈은 영상을 만들지 않고, 이미 있는 판정 행만 집계한다.
 * 합성 행으로 실사 수율을 대신하지 않는다. 분모·정답 등급·분할이 없으면 비율은 null 이다.
 *
 * 5·3·8초 생존은 감사 스크립트와 같이 Kaplan–Meier 이고,
 * 실패는 「hit 또는 loose 가 아닌 보이는 지점」이다. IoU 0.5 만으로 끊는 생존은 strictSurvival 이다.
 */

export type LabelGrade = 'human-dual' | 'human-single' | 'model-reviewed' | 'synthetic' | 'unknown';
export type FootageSplit = 'tune' | 'sealed' | 'unknown';

export type FailureClass =
  | 'background-stick'
  | 'identity-switch'
  | 'detection-miss'
  | 'start-box'
  | 'camera-motion'
  | 'occlusion'
  | 'subject-exit'
  | 'reentry'
  | 'export-framing'
  | 'absent-false-present'
  | 'honest-loss'
  | 'unspecified';

export interface AuditCheckpoint {
  t: number;
  verdict: string;
  iou?: number;
  state?: string;
  /** 있으면 verdict 이름보다 이 분류를 쓴다. */
  failure?: FailureClass;
}

export interface AuditClipInput {
  id: string;
  /** 「시작-끝」초. 예: 0-12 */
  span: string;
  rows: AuditCheckpoint[];
  labelGrade: LabelGrade;
  sessionId: string;
  split: FootageSplit;
  userAsks?: number | null;
  exportOk?: boolean | null;
  /** 호스트에서 잰 프레임당 ms. 휴대폰 값이 아니다. */
  hostMsPerFrame?: number | null;
  /** 클립 길이(초). 있으면 질문 횟수를 분당으로도 낸다. */
  durationSec?: number | null;
  /** 자동 구도에서 대상이 잘리거나 화면 밖인 지점 비율. 없으면 미측정. */
  framingMiss?: number | null;
  /** 미리보기와 내보낸 구도가 같은가. 없으면 미측정. */
  previewMatchesExport?: boolean | null;
  /** 타인으로 바뀐 뒤 그 상자를 유지한 초. 없으면 미측정. */
  switchHoldSec?: number | null;
}

export interface ContinuityReport {
  clips: number;
  visiblePoints: number;
  absentPoints: number;
  /** 보이는 지점 중 verdict === hit. 상태 OK/WARNING 이고 IoU≥0.5 인 감사 정의. */
  iou50: number | null;
  loose: number | null;
  /** 보이는 지점 중 DRIFT·SWITCH. */
  wrongWhileClaiming: number | null;
  honestLossWhileVisible: number | null;
  /** 대상이 없는 지점 중 ABSENT-CLAIMED·ABSENT-ON-OTHER. */
  absentFalsePresent: number | null;
  identitySwitches: number;
  survivalLoose: { sec3: number | null; sec5: number | null; sec8: number | null };
  survivalIou50: { sec3: number | null; sec5: number | null; sec8: number | null };
  userAsks: number | null;
  exportableRatio: number | null;
  hostMsPerFrame: number | null;
  asksPerMinute: number | null;
  framingMiss: number | null;
  previewExportMatch: number | null;
  switchHoldSec: number | null;
  /** 목표 기기 발열·배터리는 이 모듈이 재지 않는다. */
  deviceThermal: null;
  deviceBattery: null;
  devicePeakMemoryMb: null;
  /** 같은 촬영 세션이 조정과 봉인에 같이 있으면 평가를 실패로 본다. */
  sessionSplitOk: boolean;
  failures: Record<FailureClass, number>;
  labelGrades: LabelGrade[];
  splits: FootageSplit[];
  /** 사람 두 명의 독립 검수 봉인만 실사 수율로 말할 수 있다. */
  realYieldClaimAllowed: boolean;
  notes: string[];
}

const FAILURES: FailureClass[] = [
  'background-stick', 'identity-switch', 'detection-miss', 'start-box', 'camera-motion',
  'occlusion', 'subject-exit', 'reentry', 'export-framing', 'absent-false-present',
  'honest-loss', 'unspecified',
];

function emptyFailures(): Record<FailureClass, number> {
  return Object.fromEntries(FAILURES.map((key) => [key, 0])) as Record<FailureClass, number>;
}

function isAbsent(verdict: string): boolean {
  return /absent|ABSENT/.test(verdict);
}

function isHit(verdict: string): boolean {
  return verdict === 'hit';
}

function isLooseOk(verdict: string): boolean {
  return verdict === 'hit' || verdict === 'loose';
}

function spanStart(span: string): number {
  const n = Number(span.split('-')[0]);
  return Number.isFinite(n) ? n : 0;
}

function coarseFailure(row: AuditCheckpoint, clipStart: number): FailureClass {
  if (row.failure) return row.failure;
  if (row.verdict === 'SWITCH') {
    return row.t - clipStart <= 0.5 ? 'start-box' : 'identity-switch';
  }
  if (row.verdict === 'DRIFT') {
    return row.t - clipStart <= 0.5 ? 'start-box' : 'background-stick';
  }
  if (row.verdict === 'ABSENT-CLAIMED' || row.verdict === 'ABSENT-ON-OTHER') return 'absent-false-present';
  if (row.verdict === 'honest-lost') return 'honest-loss';
  return 'unspecified';
}

/** 감사 compare.mjs 와 같은 Kaplan–Meier. 대상이 0이면 null. */
export function kaplanMeier(events: { t: number; failed: boolean }[], atSec: number): number | null {
  if (!events.length) return null;
  const ordered = [...events].sort((a, b) => a.t - b.t);
  let survival = 1;
  let atRisk = ordered.length;
  for (const event of ordered) {
    if (event.t > atSec) break;
    if (event.failed) survival *= (atRisk - 1) / atRisk;
    atRisk -= 1;
  }
  return survival;
}

function survivalEvents(clip: AuditClipInput, strict: boolean): { t: number; failed: boolean } {
  const t0 = spanStart(clip.span);
  const visible = clip.rows.filter((row) => !isAbsent(row.verdict));
  const fail = visible.find((row) => (strict ? !isHit(row.verdict) : !isLooseOk(row.verdict)));
  const last = visible.length ? visible[visible.length - 1].t - t0 : 0;
  return { t: fail ? fail.t - t0 : last, failed: Boolean(fail) };
}

/** 같은 촬영 세션이 조정(tune)과 봉인(sealed)에 같이 있으면 실패다. */
export function assertSeparatedSessions(clips: readonly AuditClipInput[]): { ok: boolean; reason: string } {
  const tune = new Set(clips.filter((clip) => clip.split === 'tune').map((clip) => clip.sessionId));
  const sealed = new Set(clips.filter((clip) => clip.split === 'sealed').map((clip) => clip.sessionId));
  const shared = [...tune].filter((id) => sealed.has(id));
  if (shared.length) {
    return { ok: false, reason: `같은 촬영 세션이 조정과 봉인에 함께 있습니다: ${shared.join(', ')}` };
  }
  return { ok: true, reason: '' };
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

export function scoreContinuitySuite(clips: readonly AuditClipInput[]): ContinuityReport {
  const notes: string[] = [];
  const failures = emptyFailures();
  let visiblePoints = 0;
  let absentPoints = 0;
  let hits = 0;
  let loose = 0;
  let wrong = 0;
  let honest = 0;
  let falseAbsent = 0;
  let switches = 0;
  const asks: number[] = [];
  const durations: number[] = [];
  const exports: boolean[] = [];
  const times: number[] = [];
  const framing: number[] = [];
  const preview: boolean[] = [];
  const holds: number[] = [];

  for (const clip of clips) {
    const t0 = spanStart(clip.span);
    for (const row of clip.rows) {
      if (isAbsent(row.verdict)) {
        absentPoints += 1;
        if (row.verdict === 'ABSENT-CLAIMED' || row.verdict === 'ABSENT-ON-OTHER') falseAbsent += 1;
      } else {
        visiblePoints += 1;
        if (isHit(row.verdict)) hits += 1;
        if (isLooseOk(row.verdict)) loose += 1;
        if (row.verdict === 'DRIFT' || row.verdict === 'SWITCH') wrong += 1;
        if (row.verdict === 'honest-lost') honest += 1;
        if (row.verdict === 'SWITCH') switches += 1;
      }
      const kind = coarseFailure(row, t0);
      if (kind !== 'unspecified') failures[kind] += 1;
    }
    if (typeof clip.userAsks === 'number') asks.push(clip.userAsks);
    if (typeof clip.durationSec === 'number') durations.push(clip.durationSec);
    if (typeof clip.exportOk === 'boolean') exports.push(clip.exportOk);
    if (typeof clip.hostMsPerFrame === 'number') times.push(clip.hostMsPerFrame);
    if (typeof clip.framingMiss === 'number') framing.push(clip.framingMiss);
    if (typeof clip.previewMatchesExport === 'boolean') preview.push(clip.previewMatchesExport);
    if (typeof clip.switchHoldSec === 'number') holds.push(clip.switchHoldSec);
  }

  if (!clips.length) notes.push('입력 클립이 없어 실사 수율은 미측정이다.');
  if (clips.some((clip) => clip.labelGrade !== 'human-dual')) {
    notes.push('사람 두 명의 독립 검수가 아닌 클립이 있어 실사 수율로 말하지 않는다.');
  }
  if (clips.some((clip) => clip.split !== 'sealed')) {
    notes.push('봉인 분할이 아닌 클립이 섞여 있다. 학습·조정에 쓴 세션과 나뉘었는지 이 표만으로 확인하지 않는다.');
  }
  if (asks.length !== clips.length) notes.push('사용자 질문 횟수가 모든 클립에 없어 합계는 미측정이다.');
  if (exports.length !== clips.length) notes.push('끝까지 사용 가능한 결과 여부가 모든 클립에 없어 비율은 미측정이다.');
  notes.push('목표 기기 처리 시간·발열·배터리는 이 집계에 없다.');

  const looseEvents = clips.map((clip) => survivalEvents(clip, false));
  const strictEvents = clips.map((clip) => survivalEvents(clip, true));
  const grades = [...new Set(clips.map((clip) => clip.labelGrade))];
  const splits = [...new Set(clips.map((clip) => clip.split))];
  const sessionSplit = assertSeparatedSessions(clips);
  if (!sessionSplit.ok) notes.push(sessionSplit.reason);
  const askSum = asks.length === clips.length && clips.length ? asks.reduce((a, b) => a + b, 0) : null;
  const durationSum = durations.length === clips.length && clips.length ? durations.reduce((a, b) => a + b, 0) : null;

  return {
    clips: clips.length,
    visiblePoints,
    absentPoints,
    iou50: ratio(hits, visiblePoints),
    loose: ratio(loose, visiblePoints),
    wrongWhileClaiming: ratio(wrong, visiblePoints),
    honestLossWhileVisible: ratio(honest, visiblePoints),
    absentFalsePresent: ratio(falseAbsent, absentPoints),
    identitySwitches: switches,
    survivalLoose: {
      sec3: kaplanMeier(looseEvents, 3),
      sec5: kaplanMeier(looseEvents, 5),
      sec8: kaplanMeier(looseEvents, 8),
    },
    survivalIou50: {
      sec3: kaplanMeier(strictEvents, 3),
      sec5: kaplanMeier(strictEvents, 5),
      sec8: kaplanMeier(strictEvents, 8),
    },
    userAsks: askSum,
    asksPerMinute: askSum != null && durationSum != null && durationSum > 0 ? askSum / (durationSum / 60) : null,
    exportableRatio: exports.length === clips.length && clips.length
      ? exports.filter(Boolean).length / exports.length
      : null,
    framingMiss: framing.length === clips.length && clips.length
      ? framing.reduce((a, b) => a + b, 0) / framing.length
      : null,
    previewExportMatch: preview.length === clips.length && clips.length
      ? preview.filter(Boolean).length / preview.length
      : null,
    switchHoldSec: holds.length ? holds.reduce((a, b) => a + b, 0) : null,
    hostMsPerFrame: times.length === clips.length && clips.length
      ? times.reduce((a, b) => a + b, 0) / times.length
      : null,
    deviceThermal: null,
    deviceBattery: null,
    devicePeakMemoryMb: null,
    sessionSplitOk: sessionSplit.ok,
    failures,
    labelGrades: grades,
    splits,
    realYieldClaimAllowed: clips.length > 0
      && sessionSplit.ok
      && clips.every((clip) => clip.labelGrade === 'human-dual' && clip.split === 'sealed'),
    notes,
  };
}
