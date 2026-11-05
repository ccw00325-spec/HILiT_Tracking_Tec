/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·f30ad74d @license @preserve */
/* HILiT 자체 사람 검출 데이터 권리 게이트.

문서나 주석이 아니라 학습·평가 입구에서 실제로 거절한다.
항상 true를 돌려주는 함수는 두지 않는다. 실사 파일이 0개면 BLOCKED다.

외부 데이터셋 이름(MSMT17, Market-1501, COCO pretrained 등)을
통과 조건으로 쓰지 않는다. 권리 칸이 비어 있으면 격리한다.
*/

export const PERSONNET_RIGHTS_VERSION = 'hilit-personnet-rights-v0';

export type ConsentType =
  | 'owner_self'
  | 'written_talent'
  | 'cc0'
  | 'public_domain'
  | 'withdrawn'
  | 'unknown';

export type AnnotationStatus = 'human_reviewed' | 'auto_estimated' | 'unlabeled';

export type PersonNetSplit = 'train' | 'validation' | 'holdout' | 'quarantine';

export type GatePurpose = 'train' | 'eval' | 'holdout';

export const REQUIRED_ASSET_FIELDS = [
  'assetId',
  'sha256',
  'owner',
  'capturedAt',
  'consentType',
  'allowedPurposes',
  'trainingAllowed',
  'evaluationAllowed',
  'commercialUseAllowed',
  'containsMinors',
  'retentionUntil',
  'withdrawalContact',
  'split',
  'sourceVideoId',
  'annotationStatus',
] as const;

export interface PersonNetAsset {
  assetId: string;
  sha256: string;
  owner: string;
  capturedAt: string;
  consentType: ConsentType;
  allowedPurposes: string[];
  trainingAllowed: boolean;
  evaluationAllowed: boolean;
  commercialUseAllowed: boolean;
  containsMinors: boolean;
  retentionUntil: string;
  withdrawalContact: string;
  split: PersonNetSplit;
  sourceVideoId: string;
  annotationStatus: AnnotationStatus;
  withdrawn?: boolean;
  withdrawnAt?: string | null;
  filePath?: string;
  frameIndex?: number;
}

export interface PersonNetRightsManifest {
  version: string;
  clips: PersonNetAsset[];
}

export interface GateIssue {
  assetId: string | null;
  code: string;
  message: string;
}

export interface AssetGateResult {
  ok: boolean;
  isolated: boolean;
  issues: GateIssue[];
}

export interface ManifestGateResult {
  status: 'ok' | 'BLOCKED';
  purpose: GatePurpose;
  admitted: PersonNetAsset[];
  isolated: PersonNetAsset[];
  rejected: PersonNetAsset[];
  unprovenancedFiles: string[];
  issues: GateIssue[];
  trainAssetCount: number;
  validationAssetCount: number;
  holdoutAssetCount: number;
}

const SHA_RE = /^[a-f0-9]{64}$/;
const CONSENT: readonly ConsentType[] = [
  'owner_self',
  'written_talent',
  'cc0',
  'public_domain',
  'withdrawn',
  'unknown',
];
const ANNOTATION: readonly AnnotationStatus[] = ['human_reviewed', 'auto_estimated', 'unlabeled'];
const SPLITS: readonly PersonNetSplit[] = ['train', 'validation', 'holdout', 'quarantine'];

function issue(assetId: string | null, code: string, message: string): GateIssue {
  return { assetId, code, message };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function parseDay(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function emptyPersonNetRightsManifest(): PersonNetRightsManifest {
  return { version: PERSONNET_RIGHTS_VERSION, clips: [] };
}

export function isPersonNetAsset(raw: unknown): raw is PersonNetAsset {
  if (!raw || typeof raw !== 'object') return false;
  const row = raw as Record<string, unknown>;
  return REQUIRED_ASSET_FIELDS.every((key) => key in row);
}

export function inspectAssetRecord(raw: unknown): GateIssue[] {
  const issues: GateIssue[] = [];
  if (!raw || typeof raw !== 'object') {
    return [issue(null, 'not-object', '권리 레코드가 객체가 아닙니다.')];
  }
  const row = raw as Record<string, unknown>;
  const assetId = isNonEmptyString(row.assetId) ? row.assetId : null;
  for (const key of REQUIRED_ASSET_FIELDS) {
    if (!(key in row)) {
      issues.push(issue(assetId, 'missing-field', `${key} 칸이 없습니다.`));
    }
  }
  if (!isNonEmptyString(row.assetId)) issues.push(issue(assetId, 'assetId', 'assetId가 비어 있습니다.'));
  if (!isNonEmptyString(row.sha256) || !SHA_RE.test(row.sha256.toLowerCase())) {
    issues.push(issue(assetId, 'sha256', 'sha256은 64자리 소문자 hex여야 합니다.'));
  }
  if (!isNonEmptyString(row.owner)) issues.push(issue(assetId, 'owner', '소유자가 없습니다.'));
  if (!isNonEmptyString(row.capturedAt) || parseDay(row.capturedAt) == null) {
    issues.push(issue(assetId, 'capturedAt', '촬영 시각이 없습니다.'));
  }
  if (!CONSENT.includes(row.consentType as ConsentType)) {
    issues.push(issue(assetId, 'consentType', '동의 종류가 허용 목록 밖입니다.'));
  }
  if (!Array.isArray(row.allowedPurposes) || row.allowedPurposes.some((p) => !isNonEmptyString(p))) {
    issues.push(issue(assetId, 'allowedPurposes', 'allowedPurposes는 문자열 배열이어야 합니다.'));
  }
  for (const flag of ['trainingAllowed', 'evaluationAllowed', 'commercialUseAllowed', 'containsMinors'] as const) {
    if (typeof row[flag] !== 'boolean') {
      issues.push(issue(assetId, flag, `${flag}는 true/false여야 합니다.`));
    }
  }
  if (!isNonEmptyString(row.retentionUntil) || parseDay(row.retentionUntil) == null) {
    issues.push(issue(assetId, 'retentionUntil', '보관 기한이 없습니다.'));
  }
  if (!isNonEmptyString(row.withdrawalContact)) {
    issues.push(issue(assetId, 'withdrawalContact', '철회 연락처가 없습니다.'));
  }
  if (!SPLITS.includes(row.split as PersonNetSplit)) {
    issues.push(issue(assetId, 'split', 'split은 train|validation|holdout|quarantine이어야 합니다.'));
  }
  if (!isNonEmptyString(row.sourceVideoId)) {
    issues.push(issue(assetId, 'sourceVideoId', '원본 영상 ID가 없습니다.'));
  }
  if (!ANNOTATION.includes(row.annotationStatus as AnnotationStatus)) {
    issues.push(issue(assetId, 'annotationStatus', '사람 검수와 자동 추정 라벨을 구분해야 합니다.'));
  }
  return issues;
}

export function gateAsset(
  raw: unknown,
  actualSha256: string | null,
  purpose: GatePurpose,
  nowMs: number = Date.now(),
): AssetGateResult {
  const issues = inspectAssetRecord(raw);
  if (issues.length) {
    return { ok: false, isolated: !isPersonNetAsset(raw), issues };
  }
  const asset = raw as PersonNetAsset;
  const extra: GateIssue[] = [];
  if (asset.withdrawn === true || asset.consentType === 'withdrawn' || isNonEmptyString(asset.withdrawnAt)) {
    extra.push(issue(asset.assetId, 'withdrawn', '철회된 데이터는 다음 학습·평가 run부터 제외합니다.'));
  }
  if (asset.consentType === 'unknown') {
    extra.push(issue(asset.assetId, 'consent-unknown', '동의 종류가 unknown이면 통과시키지 않습니다.'));
  }
  if (actualSha256 == null || actualSha256.length === 0) {
    extra.push(issue(asset.assetId, 'hash-missing', '실제 파일 해시가 없어 거절합니다.'));
  } else if (actualSha256.toLowerCase() !== asset.sha256.toLowerCase()) {
    extra.push(issue(asset.assetId, 'hash-mismatch', 'manifest SHA-256과 파일 해시가 다릅니다.'));
  }
  const until = parseDay(asset.retentionUntil);
  if (until != null && until < nowMs) {
    extra.push(issue(asset.assetId, 'retention-expired', '보관 기한이 지나 학습·평가에 쓰지 않습니다.'));
  }
  if (asset.containsMinors) {
    extra.push(issue(asset.assetId, 'contains-minors', '미성년자가 포함된 자료는 이 검출기 학습·평가에 넣지 않습니다.'));
  }
  if (purpose === 'train') {
    if (asset.trainingAllowed !== true) {
      extra.push(issue(asset.assetId, 'training-forbidden', '학습 동의가 없으면 학습할 수 없습니다.'));
    }
    if (asset.commercialUseAllowed !== true) {
      extra.push(issue(asset.assetId, 'commercial-forbidden', '상업 이용 동의가 없으면 학습할 수 없습니다.'));
    }
    if (!asset.allowedPurposes.includes('training')) {
      extra.push(issue(asset.assetId, 'purpose-training', 'allowedPurposes에 training이 없습니다.'));
    }
    if (asset.annotationStatus !== 'human_reviewed') {
      extra.push(issue(asset.assetId, 'label-not-human', '자동 추정 라벨은 학습 정답이 아닙니다.'));
    }
    if (asset.split !== 'train') {
      extra.push(issue(asset.assetId, 'split-train', '학습 목적에는 split=train만 받습니다.'));
    }
  }
  if (purpose === 'eval' || purpose === 'holdout') {
    if (asset.evaluationAllowed !== true) {
      extra.push(issue(asset.assetId, 'eval-forbidden', '평가 동의가 없으면 평가할 수 없습니다.'));
    }
    if (!asset.allowedPurposes.includes('evaluation')) {
      extra.push(issue(asset.assetId, 'purpose-eval', 'allowedPurposes에 evaluation이 없습니다.'));
    }
    if (asset.annotationStatus !== 'human_reviewed') {
      extra.push(issue(asset.assetId, 'label-not-human', '자동 추정 라벨은 공식 평가 정답이 아닙니다.'));
    }
    const want = purpose === 'holdout' ? 'holdout' : 'validation';
    if (asset.split !== want && !(purpose === 'eval' && (asset.split === 'validation' || asset.split === 'holdout'))) {
      extra.push(issue(asset.assetId, 'split-eval', `평가 목적에는 ${want} 분할이 필요합니다.`));
    }
  }
  const all = [...issues, ...extra];
  return { ok: all.length === 0, isolated: false, issues: all };
}

function sameVideoLeak(admitted: PersonNetAsset[]): GateIssue[] {
  const byVideo = new Map<string, PersonNetAsset[]>();
  for (const clip of admitted) {
    const list = byVideo.get(clip.sourceVideoId) ?? [];
    list.push(clip);
    byVideo.set(clip.sourceVideoId, list);
  }
  const issues: GateIssue[] = [];
  for (const [videoId, rows] of byVideo) {
    const splits = new Set(rows.map((r) => r.split));
    const learn = splits.has('train');
    const evalish = splits.has('validation') || splits.has('holdout');
    if (learn && evalish) {
      issues.push(issue(rows[0].assetId, 'source-split-leak', `같은 sourceVideoId(${videoId})를 train과 eval에 나누지 않습니다.`));
    }
    const indexed = rows.filter((r) => typeof r.frameIndex === 'number');
    for (let i = 0; i < indexed.length; i += 1) {
      for (let j = i + 1; j < indexed.length; j += 1) {
        const a = indexed[i];
        const b = indexed[j];
        if (a.split === b.split) continue;
        if (Math.abs((a.frameIndex ?? 0) - (b.frameIndex ?? 0)) <= 5) {
          issues.push(issue(a.assetId, 'adjacent-frame-leak', '같은 영상의 인접 프레임을 train과 eval에 나누지 않습니다.'));
        }
      }
    }
  }
  return issues;
}

export const FORBIDDEN_DATASET_TOKENS = [
  'coco',
  'msmt17',
  'market-1501',
  'market1501',
  'dukemtmc',
  'sportsmot',
  'soccernet',
  'imagenet',
  'crowdhuman',
  'objects365',
  'got-10k',
  'lasot',
  'youtube-bb',
] as const;

export function scanForbiddenDatasetText(text: string): string[] {
  const lower = text.toLowerCase();
  return FORBIDDEN_DATASET_TOKENS.filter((token) => lower.includes(token));
}

export function isolateUnprovenanced(
  fileNames: readonly string[],
  manifest: PersonNetRightsManifest,
): { admittedNames: string[]; isolatedNames: string[] } {
  const known = new Set(
    manifest.clips
      .map((c) => (c.filePath ? c.filePath.replaceAll('\\', '/') : ''))
      .filter(Boolean),
  );
  const ids = new Set(manifest.clips.map((c) => c.assetId));
  const admittedNames: string[] = [];
  const isolatedNames: string[] = [];
  for (const name of fileNames) {
    const norm = name.replaceAll('\\', '/');
    const base = norm.split('/').pop() ?? norm;
    if (known.has(norm) || known.has(base) || ids.has(base) || ids.has(norm)) {
      admittedNames.push(name);
    } else {
      isolatedNames.push(name);
    }
  }
  return { admittedNames, isolatedNames };
}

export function gateManifest(
  manifest: PersonNetRightsManifest | null | undefined,
  hashes: Readonly<Record<string, string | null>>,
  purpose: GatePurpose,
  looseFiles: readonly string[] = [],
  nowMs: number = Date.now(),
): ManifestGateResult {
  const issues: GateIssue[] = [];
  if (!manifest || manifest.version !== PERSONNET_RIGHTS_VERSION) {
    issues.push(issue(null, 'manifest-version', `manifest version은 ${PERSONNET_RIGHTS_VERSION}이어야 합니다.`));
  }
  const clips = manifest?.clips ?? [];
  const admitted: PersonNetAsset[] = [];
  const rejected: PersonNetAsset[] = [];
  const isolated: PersonNetAsset[] = [];
  for (const clip of clips) {
    const hash = hashes[clip.assetId] ?? hashes[clip.filePath ?? ''] ?? null;
    const result = gateAsset(clip, hash, purpose, nowMs);
    if (result.isolated) isolated.push(clip);
    else if (result.ok) admitted.push(clip);
    else rejected.push(clip);
    issues.push(...result.issues);
  }
  const { isolatedNames } = isolateUnprovenanced(looseFiles, manifest ?? emptyPersonNetRightsManifest());
  for (const name of isolatedNames) {
    issues.push(issue(null, 'unprovenanced-file', `권리 정보가 없는 파일은 격리합니다: ${name}`));
  }
  issues.push(...sameVideoLeak(clips.filter((c) => c.split === 'train' || c.split === 'validation' || c.split === 'holdout')));
  for (const clip of clips) {
    const blob = [clip.assetId, clip.filePath ?? '', clip.sourceVideoId, clip.owner].join(' ');
    const forbidden = scanForbiddenDatasetText(blob);
    if (forbidden.length) {
      issues.push(issue(clip.assetId, 'forbidden-dataset-token',
        `상업 위험이 있는 외부 데이터 이름이 보입니다: ${forbidden.join(', ')}`));
    }
  }
  const leak = issues.some((row) => row.code === 'source-split-leak' || row.code === 'adjacent-frame-leak' || row.code === 'forbidden-dataset-token');
  const finalAdmitted = leak ? [] : admitted;
  if (leak) {
    rejected.push(...admitted);
  }
  const trainAssetCount = (manifest?.clips ?? []).filter((c) => c.split === 'train').length;
  const validationAssetCount = (manifest?.clips ?? []).filter((c) => c.split === 'validation').length;
  const holdoutAssetCount = (manifest?.clips ?? []).filter((c) => c.split === 'holdout').length;
  if (finalAdmitted.length === 0) {
    issues.push(issue(null, 'empty-admitted', '통과한 권리 확인 자료가 0편입니다. 학습·제품 승격은 BLOCKED입니다.'));
  }
  return {
    status: finalAdmitted.length > 0 ? 'ok' : 'BLOCKED',
    purpose,
    admitted: finalAdmitted,
    isolated,
    rejected,
    unprovenancedFiles: isolatedNames,
    issues,
    trainAssetCount,
    validationAssetCount,
    holdoutAssetCount,
  };
}
