/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·107b54e9 @license @preserve */
/* 평가용 최소 정답 형식.

사람 상자 문서(hilit-person-boxes-v1)를 재사용하고,
동작 구간·신원 상태·영상 해시·검수 이력을 같은 파일에 둔다.
모델 예측을 사람 정답으로 올리지 않는다.
화면 밖·판별 불가 신원에 상자를 정답처럼 두지 않는다.
*/

import {
  validatePersonLabels,
  type LabelIssue,
  type LabelTrust,
  type Occlusion,
  type PersonLabelDocument,
  type RightsStatus,
  type SplitName,
} from './person-labels';

export const EVAL_ANNOTATION_SCHEMA = 'hilit-eval-annotation-v1';

export type IdentityPresence = 'on_screen' | 'off_screen' | 'unidentifiable';
export type AnnotationSplit = SplitName;

export interface EvalBox {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: 'person';
  occlusion: Occlusion;
  truncated: boolean;
  small: boolean;
  identityId: string | null;
  presence: IdentityPresence;
}

export interface EvalFrame {
  frameId: string;
  timestampSec: number;
  width: number;
  height: number;
  boxes: EvalBox[];
}

export interface EvalActionSpan {
  id: string;
  identityId: string | null;
  label: string;
  startSec: number;
  endSec: number;
  reviewed: boolean;
}

export interface EvalReviewEvent {
  at: string;
  field: string;
  from: string;
  to: string;
}

export interface EvalAnnotationDocument {
  schema: typeof EVAL_ANNOTATION_SCHEMA;
  videoId: string;
  sessionId: string;
  clipId: string;
  datasetId: string;
  split: AnnotationSplit;
  rightsStatus: RightsStatus;
  labelTrust: LabelTrust;
  source: string;
  sourceHash: string | null;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  sport: string | null;
  people: Array<{
    identityId: string;
    presence: IdentityPresence;
  }>;
  frames: EvalFrame[];
  actions: EvalActionSpan[];
  review: {
    reviewed: boolean;
    reviewedAt: string | null;
    history: EvalReviewEvent[];
  };
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function push(issues: LabelIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

export function validateEvalAnnotation(
  raw: unknown,
  options: { expectedHash?: string | null; purpose?: 'train' | 'eval' } = {},
): LabelIssue[] {
  const purpose = options.purpose ?? 'eval';
  const issues: LabelIssue[] = [];
  if (!raw || typeof raw !== 'object') return [{ path: '$', message: '객체가 아닙니다' }];
  const doc = raw as Record<string, unknown>;
  if (doc.schema !== EVAL_ANNOTATION_SCHEMA) {
    push(issues, 'schema', `스키마는 ${EVAL_ANNOTATION_SCHEMA} 이어야 합니다`);
  }
  for (const key of ['videoId', 'sessionId', 'clipId', 'datasetId', 'source'] as const) {
    if (!doc[key] || typeof doc[key] !== 'string') push(issues, key, '비어 있지 않은 문자열이어야 합니다');
  }
  if (!['train', 'val', 'test'].includes(String(doc.split))) push(issues, 'split', 'train | val | test');
  if (!['ALLOW', 'REVIEW', 'DO_NOT_USE_FOR_TRAINING'].includes(String(doc.rightsStatus))) {
    push(issues, 'rightsStatus', 'ALLOW | REVIEW | DO_NOT_USE_FOR_TRAINING');
  }
  if (!['inspected', 'unchecked', 'machine-proposed'].includes(String(doc.labelTrust))) {
    push(issues, 'labelTrust', '검수되지 않은 라벨은 정답으로 쓰지 않습니다');
  }
  if (purpose === 'eval') {
    if (doc.split === 'train') push(issues, 'split', '평가 문서는 val 또는 test 여야 합니다');
    if (doc.labelTrust !== 'inspected') push(issues, 'labelTrust', '검수되지 않은 라벨은 정답으로 쓰지 않습니다');
  } else if (doc.rightsStatus !== 'ALLOW' || doc.labelTrust !== 'inspected') {
    push(issues, 'labelTrust', '학습 입력은 권리 ALLOW 와 사람 검수만 받습니다');
  }
  if (doc.sourceHash != null && typeof doc.sourceHash !== 'string') {
    push(issues, 'sourceHash', '문자열이거나 null');
  }
  if (options.expectedHash && doc.sourceHash && options.expectedHash !== doc.sourceHash) {
    push(issues, 'sourceHash', '라벨 파일의 영상 해시와 원본 파일이 다릅니다');
  }
  if (doc.durationSec != null && (!num(doc.durationSec) || doc.durationSec <= 0)) {
    push(issues, 'durationSec', '양수이거나 null');
  }
  for (const key of ['width', 'height', 'fps'] as const) {
    if (doc[key] != null && (!num(doc[key]) || Number(doc[key]) <= 0)) {
      push(issues, key, '양수이거나 null');
    }
  }

  const people = Array.isArray(doc.people) ? doc.people : null;
  if (!people) {
    push(issues, 'people', '배열이어야 합니다');
  } else {
    const ids = new Set<string>();
    people.forEach((row, i) => {
      if (!row || typeof row !== 'object') {
        push(issues, `people[${i}]`, '객체가 아닙니다');
        return;
      }
      const person = row as Record<string, unknown>;
      if (typeof person.identityId !== 'string' || !person.identityId) {
        push(issues, `people[${i}].identityId`, '필요합니다');
      } else if (ids.has(person.identityId)) {
        push(issues, `people[${i}].identityId`, '같은 인물 ID가 두 번 있습니다');
      } else {
        ids.add(person.identityId);
      }
      if (!['on_screen', 'off_screen', 'unidentifiable'].includes(String(person.presence))) {
        push(issues, `people[${i}].presence`, 'on_screen | off_screen | unidentifiable');
      }
    });
  }

  const knownIds = new Set(
    (people ?? [])
      .filter((row): row is { identityId: string; presence: IdentityPresence } => (
        Boolean(row && typeof row === 'object' && typeof (row as { identityId?: unknown }).identityId === 'string')
      ))
      .map((row) => row.identityId),
  );
  const duration = num(doc.durationSec) ? doc.durationSec : null;

  if (!Array.isArray(doc.frames)) {
    push(issues, 'frames', '배열이어야 합니다');
  } else {
    doc.frames.forEach((frame, i) => {
      const p = `frames[${i}]`;
      if (!frame || typeof frame !== 'object') {
        push(issues, p, '객체가 아닙니다');
        return;
      }
      const f = frame as Record<string, unknown>;
      if (typeof f.frameId !== 'string' || !f.frameId) push(issues, `${p}.frameId`, '필요합니다');
      if (!num(f.timestampSec) || f.timestampSec < 0) push(issues, `${p}.timestampSec`, '0 이상');
      if (duration != null && num(f.timestampSec) && f.timestampSec > duration + 0.05) {
        push(issues, `${p}.timestampSec`, '영상 길이를 넘어갑니다');
      }
      if (!num(f.width) || f.width < 8) push(issues, `${p}.width`, '너무 작습니다');
      if (!num(f.height) || f.height < 8) push(issues, `${p}.height`, '너무 작습니다');
      if (!Array.isArray(f.boxes)) {
        push(issues, `${p}.boxes`, '배열이어야 합니다');
        return;
      }
      f.boxes.forEach((box, j) => {
        const bp = `${p}.boxes[${j}]`;
        if (!box || typeof box !== 'object') {
          push(issues, bp, '객체가 아닙니다');
          return;
        }
        const b = box as Record<string, unknown>;
        if (b.kind !== 'person') push(issues, `${bp}.kind`, 'person 만 허용');
        if (!['on_screen', 'off_screen', 'unidentifiable'].includes(String(b.presence))) {
          push(issues, `${bp}.presence`, 'on_screen | off_screen | unidentifiable');
        }
        if (b.presence === 'off_screen') {
          push(issues, bp, '화면 밖 인물에는 정답 상자를 두지 않습니다');
        }
        if (b.presence === 'unidentifiable' && b.identityId) {
          push(issues, `${bp}.identityId`, '판별 불가 신원을 정답 ID로 두지 않습니다');
        }
        if (b.identityId != null && typeof b.identityId !== 'string') {
          push(issues, `${bp}.identityId`, '문자열이거나 null');
        }
        if (typeof b.identityId === 'string' && knownIds.size && !knownIds.has(b.identityId)) {
          push(issues, `${bp}.identityId`, 'people 목록에 없는 인물 ID입니다');
        }
        for (const k of ['x', 'y', 'width', 'height'] as const) {
          if (!num(b[k])) push(issues, `${bp}.${k}`, '숫자');
        }
        if (num(b.width) && b.width < 2) push(issues, `${bp}.width`, '2px 미만은 상자가 아닙니다');
        if (num(b.height) && b.height < 2) push(issues, `${bp}.height`, '2px 미만은 상자가 아닙니다');
        if (num(b.x) && b.x < -1) push(issues, `${bp}.x`, '좌표가 프레임 왼쪽 밖입니다');
        if (num(b.y) && b.y < -1) push(issues, `${bp}.y`, '좌표가 프레임 위쪽 밖입니다');
        if (num(b.x) && num(b.width) && num(f.width) && b.x + b.width > Number(f.width) + 1) {
          push(issues, bp, '프레임 너비를 넘어갑니다');
        }
        if (num(b.y) && num(b.height) && num(f.height) && b.y + b.height > Number(f.height) + 1) {
          push(issues, bp, '프레임 높이를 넘어갑니다');
        }
        if (!['none', 'partial', 'full'].includes(String(b.occlusion))) {
          push(issues, `${bp}.occlusion`, 'none | partial | full');
        }
        if (typeof b.truncated !== 'boolean') push(issues, `${bp}.truncated`, 'boolean');
        if (typeof b.small !== 'boolean') push(issues, `${bp}.small`, 'boolean');
      });
    });
  }

  if (!Array.isArray(doc.actions)) {
    push(issues, 'actions', '배열이어야 합니다');
  } else {
    doc.actions.forEach((row, i) => {
      const p = `actions[${i}]`;
      if (!row || typeof row !== 'object') {
        push(issues, p, '객체가 아닙니다');
        return;
      }
      const action = row as Record<string, unknown>;
      if (typeof action.id !== 'string' || !action.id) push(issues, `${p}.id`, '필요합니다');
      if (typeof action.label !== 'string' || !action.label.trim()) push(issues, `${p}.label`, '필요합니다');
      if (!num(action.startSec) || action.startSec < 0) push(issues, `${p}.startSec`, '0 이상');
      if (!num(action.endSec)) push(issues, `${p}.endSec`, '숫자');
      if (num(action.startSec) && num(action.endSec) && action.endSec <= action.startSec) {
        push(issues, `${p}.endSec`, '시작보다 빠른 종료는 안 됩니다');
      }
      if (duration != null && num(action.endSec) && action.endSec > duration + 0.05) {
        push(issues, `${p}.endSec`, '영상 길이를 넘어갑니다');
      }
      if (action.identityId != null && typeof action.identityId !== 'string') {
        push(issues, `${p}.identityId`, '문자열이거나 null');
      }
      if (typeof action.identityId === 'string' && knownIds.size && !knownIds.has(action.identityId)) {
        push(issues, `${p}.identityId`, 'people 목록에 없는 인물 ID입니다');
      }
      if (typeof action.reviewed !== 'boolean') push(issues, `${p}.reviewed`, 'boolean');
      if (doc.labelTrust === 'machine-proposed' && action.reviewed === true) {
        push(issues, `${p}.reviewed`, '자동 제안은 사람 검수 전까지 미검수입니다');
      }
    });
  }

  if (!doc.review || typeof doc.review !== 'object') {
    push(issues, 'review', '객체가 필요합니다');
  } else {
    const review = doc.review as Record<string, unknown>;
    if (typeof review.reviewed !== 'boolean') push(issues, 'review.reviewed', 'boolean');
    if (review.reviewedAt != null && typeof review.reviewedAt !== 'string') {
      push(issues, 'review.reviewedAt', '문자열이거나 null');
    }
    if (!Array.isArray(review.history)) push(issues, 'review.history', '배열이어야 합니다');
    if (doc.labelTrust === 'inspected' && review.reviewed !== true) {
      push(issues, 'review.reviewed', '검수됨으로 표시된 문서는 review.reviewed 가 true 여야 합니다');
    }
  }
  return issues;
}

/** 같은 촬영 세션을 학습과 평가에 동시에 넣지 않는다. 인접 프레임 분할 금지. */
export function assertSessionSplit(
  docs: ReadonlyArray<{ sessionId?: string; clipId?: string; split?: string }>,
): LabelIssue[] {
  const issues: LabelIssue[] = [];
  const bySession = new Map<string, Set<string>>();
  docs.forEach((doc, i) => {
    const session = typeof doc.sessionId === 'string' ? doc.sessionId : '';
    const split = typeof doc.split === 'string' ? doc.split : '';
    if (!session || !split) return;
    const bucket = bySession.get(session) ?? new Set<string>();
    bucket.add(split);
    bySession.set(session, bucket);
    void i;
  });
  for (const [sessionId, splits] of bySession) {
    const train = splits.has('train');
    const evalSplit = splits.has('val') || splits.has('test') || splits.has('eval');
    if (train && evalSplit) {
      issues.push({
        path: `sessionId:${sessionId}`,
        message: '같은 촬영 세션을 학습과 평가에 함께 넣지 않습니다. 클립 전체가 한쪽에만 있어야 합니다.',
      });
    }
  }
  return issues;
}

export function personLabelsToEvalAnnotation(
  doc: PersonLabelDocument,
  extra: {
    videoId: string;
    sourceHash?: string | null;
    durationSec?: number | null;
    fps?: number | null;
    sport?: string | null;
  },
): EvalAnnotationDocument {
  const people = new Map<string, IdentityPresence>();
  for (const frame of doc.frames) {
    if (frame.identityId) people.set(frame.identityId, 'on_screen');
  }
  return {
    schema: EVAL_ANNOTATION_SCHEMA,
    videoId: extra.videoId,
    sessionId: doc.sessionId,
    clipId: doc.clipId,
    datasetId: doc.datasetId,
    split: doc.split,
    rightsStatus: doc.rightsStatus,
    labelTrust: doc.labelTrust,
    source: doc.source,
    sourceHash: extra.sourceHash ?? null,
    durationSec: extra.durationSec ?? null,
    width: doc.frames[0]?.width ?? null,
    height: doc.frames[0]?.height ?? null,
    fps: extra.fps ?? null,
    sport: extra.sport ?? null,
    people: [...people.entries()].map(([identityId, presence]) => ({ identityId, presence })),
    frames: doc.frames.map((frame) => ({
      frameId: frame.frameId,
      timestampSec: frame.timestampSec,
      width: frame.width,
      height: frame.height,
      boxes: frame.boxes.map((box) => ({
        ...box,
        identityId: frame.identityId,
        presence: 'on_screen' as const,
      })),
    })),
    actions: [],
    review: {
      reviewed: doc.labelTrust === 'inspected',
      reviewedAt: null,
      history: [],
    },
  };
}

export function personLabelIssuesForEval(raw: unknown): LabelIssue[] {
  return validatePersonLabels(raw, { purpose: 'eval' });
}
