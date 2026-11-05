/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·78707316 @license @preserve */
/* 여러 후보를 함께 본다. 한 점수로 동일인을 정하지 않는다.

같은 검출을 두 subjectId 에 동시에 확정하지 않는다.
오래 못 보면 위치 예측을 덜 믿는다. 근거가 없으면 추측하지 않는다.
*/

import { decideAppearanceMatch, refineDecisionWithTexture, type ReidDecision } from './appearance-memory';

export const IDENTITY_ACCEPT = 0.62;
export const IDENTITY_MARGIN = 0.08;
export const MOTION_DECAY_GAP_SEC = 8;

export interface IdentityEvidence {
  appearanceSelf: number | null;
  appearanceRecent: number | null;
  appearanceOther: number | null;
  appearanceTrust: number;
  texture?: number | null;
  samples: number;
  motionErrorBodies: number | null;
  sizeScore: number | null;
  gapSeconds: number;
}

export interface IdentityCandidate {
  detectionId: string;
  box: { x: number; y: number; width: number; height: number };
  evidence: IdentityEvidence;
}

export interface SubjectJudgeInput {
  subjectId: string;
  candidates: readonly IdentityCandidate[];
}

export interface IdentityJudgeResult {
  subjectId: string;
  decision: ReidDecision;
  chosenDetectionId: string | null;
  reason: string;
  score: number | null;
  margin: number;
  motionTrusted: boolean;
}

export interface AssignmentRow {
  subjectId: string;
  detectionId: string | null;
  decision: ReidDecision;
  reason: string;
}

function motionWeight(gapSeconds: number, motionError: number | null): number {
  if (motionError == null || !Number.isFinite(motionError)) return 0;
  if (gapSeconds >= MOTION_DECAY_GAP_SEC) return 0;
  const decay = 1 - Math.min(1, Math.max(0, gapSeconds) / MOTION_DECAY_GAP_SEC);
  const closeness = 1 / (1 + motionError * motionError);
  return decay * closeness;
}

function gapLong(ev: IdentityEvidence): boolean {
  return ev.gapSeconds >= MOTION_DECAY_GAP_SEC;
}

export function composeIdentityScore(ev: IdentityEvidence): {
  score: number | null;
  motionTrusted: boolean;
  distinguishable: boolean;
} {
  const self = ev.appearanceSelf;
  if (self == null) return { score: null, motionTrusted: false, distinguishable: false };
  const other = ev.appearanceOther;
  const recent = ev.appearanceRecent;
  const mw = motionWeight(ev.gapSeconds, ev.motionErrorBodies);
  const size = ev.sizeScore == null ? 0.5 : ev.sizeScore;
  const trust = Math.max(0, Math.min(1, ev.appearanceTrust));
  const appearance = recent == null ? self : Math.max(self, recent * 0.92);
  const motionTrusted = mw > 0.25 && ev.gapSeconds < MOTION_DECAY_GAP_SEC;
  const distinguishable = other == null || appearance >= other + IDENTITY_MARGIN;
  const blended = appearance * (0.72 + 0.08 * trust)
    + (motionTrusted ? mw * 0.12 : 0)
    + size * 0.08;
  return {
    score: Math.max(0, Math.min(1, blended)),
    motionTrusted,
    distinguishable,
  };
}

export function judgeSubjectCandidates(input: SubjectJudgeInput): IdentityJudgeResult {
  const ranked = input.candidates.map((c) => {
    const composed = composeIdentityScore(c.evidence);
    const raw = decideAppearanceMatch({
      self: c.evidence.appearanceSelf,
      other: c.evidence.appearanceOther,
      samples: c.evidence.samples,
      trust: c.evidence.appearanceTrust,
      threshold: IDENTITY_ACCEPT,
      distractorMargin: IDENTITY_MARGIN,
    });
    const match = c.evidence.texture == null
      ? raw
      : refineDecisionWithTexture({
        color: c.evidence.appearanceSelf ?? 0,
        texture: c.evidence.texture,
        decision: raw,
      });
    return { candidate: c, composed, match };
  }).sort((a, b) => (b.composed.score ?? -1) - (a.composed.score ?? -1));

  if (!ranked.length) {
    return {
      subjectId: input.subjectId,
      decision: 'hold',
      chosenDetectionId: null,
      reason: 'no-candidate',
      score: null,
      margin: 0,
      motionTrusted: false,
    };
  }

  const first = ranked[0];
  const rival = ranked[1];
  const firstScore = first.composed.score;
  const rivalScore = rival?.composed.score ?? null;
  const margin = firstScore == null ? 0 : firstScore - (rivalScore ?? 0);

  if (firstScore == null || first.match === 'hold') {
    return {
      subjectId: input.subjectId,
      decision: 'hold',
      chosenDetectionId: null,
      reason: first.match === 'hold' ? 'appearance-hold' : 'no-score',
      score: firstScore,
      margin,
      motionTrusted: first.composed.motionTrusted,
    };
  }
  if (first.match === 'reject' || !first.composed.distinguishable) {
    return {
      subjectId: input.subjectId,
      decision: first.match === 'reject' ? 'reject' : 'hold',
      chosenDetectionId: null,
      reason: first.match === 'reject' ? 'appearance-reject' : 'not-unique',
      score: firstScore,
      margin,
      motionTrusted: first.composed.motionTrusted,
    };
  }
  if (rival && rivalScore != null && margin < IDENTITY_MARGIN) {
    return {
      subjectId: input.subjectId,
      decision: 'hold',
      chosenDetectionId: null,
      reason: 'close-rivals',
      score: firstScore,
      margin,
      motionTrusted: first.composed.motionTrusted,
    };
  }
  if (input.candidates.length === 1 && !first.composed.motionTrusted && gapLong(first.candidate.evidence)) {
    return {
      subjectId: input.subjectId,
      decision: 'hold',
      chosenDetectionId: null,
      reason: 'single-after-long-gap',
      score: firstScore,
      margin,
      motionTrusted: false,
    };
  }
  return {
    subjectId: input.subjectId,
    decision: 'accept',
    chosenDetectionId: first.candidate.detectionId,
    reason: 'unique-accept',
    score: firstScore,
    margin,
    motionTrusted: first.composed.motionTrusted,
  };
}

export function assignDetectionsToSubjects(
  subjects: readonly SubjectJudgeInput[],
): AssignmentRow[] {
  const judged = subjects.map((row) => judgeSubjectCandidates(row));
  const claimed = new Map<string, IdentityJudgeResult[]>();
  for (const row of judged) {
    if (!row.chosenDetectionId || row.decision !== 'accept') continue;
    const list = claimed.get(row.chosenDetectionId) ?? [];
    list.push(row);
    claimed.set(row.chosenDetectionId, list);
  }
  const blocked = new Set<string>();
  for (const [det, owners] of claimed) {
    if (owners.length <= 1) continue;
    owners.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const lead = owners[0];
    const second = owners[1];
    const gap = (lead.score ?? 0) - (second.score ?? 0);
    if (gap < IDENTITY_MARGIN) {
      blocked.add(det);
    } else {
      for (const extra of owners.slice(1)) blocked.add(`${extra.subjectId}:${det}`);
    }
  }
  return judged.map((row) => {
    if (row.decision !== 'accept' || !row.chosenDetectionId) {
      return {
        subjectId: row.subjectId,
        detectionId: null,
        decision: row.decision,
        reason: row.reason,
      };
    }
    if (blocked.has(row.chosenDetectionId) || blocked.has(`${row.subjectId}:${row.chosenDetectionId}`)) {
      return {
        subjectId: row.subjectId,
        detectionId: null,
        decision: 'hold',
        reason: 'duplicate-subject-claim',
      };
    }
    return {
      subjectId: row.subjectId,
      detectionId: row.chosenDetectionId,
      decision: 'accept',
      reason: row.reason,
    };
  });
}

export function fillProposalOthers<T extends { appearanceSelf: number | null }>(
  proposals: readonly T[],
): Array<T & { appearanceOther: number | null }> {
  return proposals.map((row, i) => {
    let other: number | null = null;
    proposals.forEach((peer, j) => {
      if (i === j || peer.appearanceSelf == null) return;
      if (other == null || peer.appearanceSelf > other) other = peer.appearanceSelf;
    });
    return { ...row, appearanceOther: other };
  });
}

export function pickBestByAppearance<T extends { appearanceSelf: number | null }>(
  proposals: readonly T[],
): T | null {
  let best: T | null = null;
  let score = -1;
  for (const row of proposals) {
    const self = row.appearanceSelf;
    if (self == null) continue;
    if (self > score) {
      score = self;
      best = row;
    }
  }
  return best;
}

export interface IdentityEvent {
  tSec: number;
  subjectId: string;
  decision: ReidDecision | 'ask_user';
  detectionIds: string[];
}

export interface IdentityQuestionSpan {
  subjectId: string;
  startSec: number;
  endSec: number;
  decision: 'hold' | 'ask_user';
  detectionIds: string[];
  frames: number;
}

/** 같은 문제를 매 프레임 묻지 않는다. 구간으로 묶는다. */
export function bundleIdentityQuestions(
  events: readonly IdentityEvent[],
  gapSec = 1.5,
): IdentityQuestionSpan[] {
  const pending = events
    .filter((e) => e.decision === 'hold' || e.decision === 'ask_user')
    .slice()
    .sort((a, b) => a.subjectId.localeCompare(b.subjectId) || a.tSec - b.tSec);
  const out: IdentityQuestionSpan[] = [];
  for (const ev of pending) {
    const last = out[out.length - 1];
    const same = last
      && last.subjectId === ev.subjectId
      && ev.tSec - last.endSec <= gapSec
      && last.decision === (ev.decision === 'ask_user' ? 'ask_user' : 'hold');
    if (same && last) {
      last.endSec = ev.tSec;
      last.frames += 1;
      for (const id of ev.detectionIds) {
        if (!last.detectionIds.includes(id)) last.detectionIds.push(id);
      }
    } else {
      out.push({
        subjectId: ev.subjectId,
        startSec: ev.tSec,
        endSec: ev.tSec,
        decision: ev.decision === 'ask_user' ? 'ask_user' : 'hold',
        detectionIds: [...ev.detectionIds],
        frames: 1,
      });
    }
  }
  return out;
}
