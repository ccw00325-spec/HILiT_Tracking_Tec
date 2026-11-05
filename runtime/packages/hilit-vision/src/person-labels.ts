/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·9d228302 @license @preserve */
/* 사람 상자 라벨 형식.

검출용 상자와 재식별용 동일인 ID 를 한 칸에 섞지 않는다.
자동 생성 라벨을 검수된 정답으로 올리지 않는다.
학습/검증/시험은 영상·촬영 세션 단위로만 가른다.
*/

export const LABEL_SCHEMA_VERSION = 'hilit-person-boxes-v1';

export type SplitName = 'train' | 'val' | 'test';
export type RightsStatus = 'ALLOW' | 'REVIEW' | 'DO_NOT_USE_FOR_TRAINING';
/* model-reviewed — 사람이 아니라 **다른 모델**이 그림을 보고 고친 라벨.

   machine-proposed 와 다르다. 그건 검출기가 스스로 낸 상자라 그걸로 검출기를
   재면 자기 답안을 자기가 채점하는 꼴이다. model-reviewed 는 검출기와 다른
   눈이 원본 그림을 보고 다시 그린 것이라 순환이 아니다.

   그래도 inspected 는 아니다. 사람이 확인한 적이 없다. 그래서
   **학습에는 못 쓰고**, 평가에도 부르는 쪽이 allowModelReviewed 를 명시해야
   받는다. 기본값으로는 거부된다 — 실수로 섞여 들어가는 길을 막는다. */
export type LabelTrust = 'inspected' | 'unchecked' | 'model-reviewed' | 'machine-proposed';
export type Occlusion = 'none' | 'partial' | 'full';

export interface PersonBoxLabel {
  x: number;
  y: number;
  width: number;
  height: number;
  kind: 'person';
  occlusion: Occlusion;
  truncated: boolean;
  small: boolean;
}

export interface PersonFrameLabel {
  frameId: string;
  timestampSec: number;
  width: number;
  height: number;
  boxes: PersonBoxLabel[];
  /** 재식별 평가용. 검출 학습의 정답이 아니다. 없으면 null. */
  identityId: string | null;
}

export interface PersonLabelDocument {
  schema: typeof LABEL_SCHEMA_VERSION;
  datasetId: string;
  sessionId: string;
  clipId: string;
  split: SplitName;
  rightsStatus: RightsStatus;
  labelTrust: LabelTrust;
  source: string;
  frames: PersonFrameLabel[];
}

export interface LabelIssue {
  path: string;
  message: string;
}

export interface ValidateLabelOptions {
  /** train(기본): 학습 입력. eval: 정답으로 재기만 하고 학습에는 안 넣음. */
  purpose?: 'train' | 'eval';
  /** eval 에서만. model-reviewed 라벨을 받을지. 기본은 안 받는다.
      켜서 잰 수치는 "사람 검수 정답 대비" 가 아니라는 것을 같이 적어야 한다. */
  allowModelReviewed?: boolean;
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

export function validatePersonLabels(raw: unknown, options: ValidateLabelOptions = {}): LabelIssue[] {
  const purpose = options.purpose ?? 'train';
  const issues: LabelIssue[] = [];
  if (!raw || typeof raw !== 'object') {
    return [{ path: '$', message: '객체가 아닙니다' }];
  }
  const doc = raw as Record<string, unknown>;
  if (doc.schema !== LABEL_SCHEMA_VERSION) {
    issues.push({ path: 'schema', message: `스키마는 ${LABEL_SCHEMA_VERSION} 이어야 합니다` });
  }
  for (const key of ['datasetId', 'sessionId', 'clipId', 'source'] as const) {
    if (!doc[key] || typeof doc[key] !== 'string') {
      issues.push({ path: key, message: '비어 있지 않은 문자열이어야 합니다' });
    }
  }
  if (!['train', 'val', 'test'].includes(String(doc.split))) {
    issues.push({ path: 'split', message: 'train | val | test' });
  }
  if (!['ALLOW', 'REVIEW', 'DO_NOT_USE_FOR_TRAINING'].includes(String(doc.rightsStatus))) {
    issues.push({ path: 'rightsStatus', message: 'ALLOW | REVIEW | DO_NOT_USE_FOR_TRAINING' });
  }
  if (!['inspected', 'unchecked', 'model-reviewed', 'machine-proposed'].includes(String(doc.labelTrust))) {
    issues.push({ path: 'labelTrust', message: '검수되지 않은 라벨은 정답으로 쓰지 않습니다' });
  }
  if (purpose === 'train') {
    if (doc.rightsStatus !== 'ALLOW') {
      issues.push({ path: 'rightsStatus', message: 'ALLOW 가 아니면 학습 입력으로 쓰지 않습니다' });
    }
    if (doc.labelTrust !== 'inspected') {
      issues.push({ path: 'labelTrust', message: '검수되지 않은 라벨은 정답으로 쓰지 않습니다' });
    }
  } else {
    if (doc.split === 'train') {
      issues.push({ path: 'split', message: '평가 문서는 val 또는 test 여야 합니다' });
    }
    /* model-reviewed 는 부르는 쪽이 명시로 열어야만 통과한다. 열고 잰 수치는
       사람 검수 정답 대비가 아니라는 것을 보고에 같이 적어야 한다. */
    const modelReviewedOk = doc.labelTrust === 'model-reviewed' && options.allowModelReviewed === true;
    if (doc.labelTrust !== 'inspected' && !modelReviewedOk) {
      issues.push({ path: 'labelTrust', message: '검수되지 않은 라벨은 정답으로 쓰지 않습니다' });
    }
    if (doc.labelTrust === 'machine-proposed') {
      issues.push({ path: 'labelTrust', message: '자동 생성 라벨은 검수 전까지 정답이 아닙니다' });
    }
    if (doc.labelTrust === 'model-reviewed' && !modelReviewedOk) {
      issues.push({
        path: 'labelTrust',
        message: '모델이 검수한 라벨입니다. 쓰려면 allowModelReviewed 를 명시하고 '
          + '사람 검수 정답이 아니라는 것을 결과에 적으세요',
      });
    }
  }
  if (!Array.isArray(doc.frames)) {
    issues.push({ path: 'frames', message: '배열이어야 합니다' });
    return issues;
  }
  doc.frames.forEach((frame, i) => {
    const p = `frames[${i}]`;
    if (!frame || typeof frame !== 'object') {
      issues.push({ path: p, message: '객체가 아닙니다' });
      return;
    }
    const f = frame as Record<string, unknown>;
    if (typeof f.frameId !== 'string' || !f.frameId) issues.push({ path: `${p}.frameId`, message: '필요합니다' });
    if (!num(f.timestampSec) || f.timestampSec < 0) issues.push({ path: `${p}.timestampSec`, message: '0 이상' });
    if (!num(f.width) || f.width < 8) issues.push({ path: `${p}.width`, message: '너무 작습니다' });
    if (!num(f.height) || f.height < 8) issues.push({ path: `${p}.height`, message: '너무 작습니다' });
    if (f.identityId != null && typeof f.identityId !== 'string') {
      issues.push({ path: `${p}.identityId`, message: '문자열이거나 null' });
    }
    if (!Array.isArray(f.boxes)) {
      issues.push({ path: `${p}.boxes`, message: '배열이어야 합니다' });
      return;
    }
    f.boxes.forEach((box, j) => {
      const bp = `${p}.boxes[${j}]`;
      if (!box || typeof box !== 'object') {
        issues.push({ path: bp, message: '객체가 아닙니다' });
        return;
      }
      const b = box as Record<string, unknown>;
      if (b.kind !== 'person') issues.push({ path: `${bp}.kind`, message: 'person 만 허용' });
      for (const k of ['x', 'y', 'width', 'height'] as const) {
        if (!num(b[k])) issues.push({ path: `${bp}.${k}`, message: '숫자' });
      }
      if (num(b.width) && b.width < 2) issues.push({ path: `${bp}.width`, message: '2px 미만은 상자가 아닙니다' });
      if (num(b.height) && b.height < 2) issues.push({ path: `${bp}.height`, message: '2px 미만은 상자가 아닙니다' });
      if (num(b.x) && num(b.width) && num(f.width) && b.x + b.width > Number(f.width) + 1) {
        issues.push({ path: `${bp}`, message: '프레임 너비를 넘어갑니다' });
      }
      if (num(b.y) && num(b.height) && num(f.height) && b.y + b.height > Number(f.height) + 1) {
        issues.push({ path: `${bp}`, message: '프레임 높이를 넘어갑니다' });
      }
      if (!['none', 'partial', 'full'].includes(String(b.occlusion))) {
        issues.push({ path: `${bp}.occlusion`, message: 'none | partial | full' });
      }
      if (typeof b.truncated !== 'boolean') issues.push({ path: `${bp}.truncated`, message: 'boolean' });
      if (typeof b.small !== 'boolean') issues.push({ path: `${bp}.small`, message: 'boolean' });
    });
  });
  return issues;
}

export function assertTrainable(doc: PersonLabelDocument): string[] {
  const issues = validatePersonLabels(doc);
  return issues.map((i) => `${i.path}: ${i.message}`);
}

export const EXAMPLE_SYNTH_DOCUMENT: PersonLabelDocument = {
  schema: LABEL_SCHEMA_VERSION,
  datasetId: 'hilit-synth-bars-v0',
  sessionId: 'synth-session-0',
  clipId: 'synth-clip-0',
  split: 'train',
  rightsStatus: 'ALLOW',
  labelTrust: 'inspected',
  source: 'generated-rectangles-no-photographs',
  frames: [{
    frameId: 'f0',
    timestampSec: 0,
    width: 64,
    height: 96,
    identityId: null,
    boxes: [{
      x: 20, y: 18, width: 14, height: 50,
      kind: 'person', occlusion: 'none', truncated: false, small: false,
    }],
  }],
};
