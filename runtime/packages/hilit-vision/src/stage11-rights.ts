/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·6190c245 @license @preserve */
/**
 * 11단계 실사 평가 권리. CC BY-SA·출처 불명은 제품 수치에 쓰지 않는다.
 * 사람이 확인하지 않은 상자를 정답으로 올리지 않는다.
 */

export const STAGE11_MANIFEST_VERSION = 'hilit-stage11-eval-v1';

export const REAL_EVAL_RIGHTS = ['hilit-owned', 'user-consented-eval', 'cc0', 'public-domain'] as const;
export type RealEvalRight = (typeof REAL_EVAL_RIGHTS)[number];

export const PRODUCT_FORBIDDEN_RIGHTS = ['cc-by', 'cc-by-sa', 'unknown', 'commons-unreviewed'] as const;

export type ReviewState = 'none' | 'draft-auto' | 'human' | 'rejected';

export type Stage11Clip = {
  assetId: string;
  sha256: string;
  owner: string;
  shooter: string;
  peopleConsent: 'yes-written' | 'yes-self' | 'pending' | 'no';
  consentEdit: boolean;
  consentEval: boolean;
  consentTrain: boolean;
  evalOnly: boolean;
  storage: string;
  deleteBy: string | null;
  sport: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  difficulty: string[];
  split: 'train' | 'validation' | 'test';
  subjectId: string;
  review: {
    boxes: ReviewState;
    subjectId: ReviewState;
    occlusion: ReviewState;
    exit: ReviewState;
    actions: ReviewState;
  };
  right: RealEvalRight | (typeof PRODUCT_FORBIDDEN_RIGHTS)[number];
};

export type Stage11Manifest = {
  schemaVersion: typeof STAGE11_MANIFEST_VERSION;
  clips: Stage11Clip[];
};

export const PROMOTION_MIN_REVIEWED_CLIPS = 8;
export const PROMOTION_MIN_HUMAN_BOX_CLIPS = 8;

export function clipAdmittedForRealMetrics(clip: Stage11Clip): { ok: true } | { ok: false; reason: string } {
  if ((PRODUCT_FORBIDDEN_RIGHTS as readonly string[]).includes(clip.right)) {
    return { ok: false, reason: `${clip.assetId}: ${clip.right} 자료는 제품 실사 수치에 쓰지 않습니다.` };
  }
  if (!(REAL_EVAL_RIGHTS as readonly string[]).includes(clip.right)) {
    return { ok: false, reason: `${clip.assetId}: 권리 종류가 허용 목록에 없습니다.` };
  }
  if (clip.peopleConsent === 'pending' || clip.peopleConsent === 'no') {
    return { ok: false, reason: `${clip.assetId}: 등장인물 동의가 끝나지 않았습니다.` };
  }
  if (!clip.consentEval) {
    return { ok: false, reason: `${clip.assetId}: 평가 사용 동의가 없습니다.` };
  }
  if (clip.review.boxes !== 'human' || clip.review.subjectId !== 'human') {
    return { ok: false, reason: `${clip.assetId}: 사람 상자·subjectId를 사람이 확인하지 않았습니다.` };
  }
  if (!/^[0-9a-f]{64}$/.test(clip.sha256)) {
    return { ok: false, reason: `${clip.assetId}: SHA-256이 없습니다.` };
  }
  return { ok: true };
}

export function promotionGate(manifest: Stage11Manifest): {
  promoteDetector: false;
  promoteAutoReacquire: false;
  reason: string;
  admitted: number;
} {
  const admitted = manifest.clips.filter((clip) => clipAdmittedForRealMetrics(clip).ok);
  const trainIds = new Set(admitted.filter((c) => c.split === 'train').map((c) => c.subjectId));
  const valIds = admitted.filter((c) => c.split === 'validation').map((c) => c.subjectId);
  const testIds = admitted.filter((c) => c.split === 'test').map((c) => c.subjectId);
  const overlap = [...valIds, ...testIds].some((id) => trainIds.has(id));
  if (overlap) {
    return {
      promoteDetector: false,
      promoteAutoReacquire: false,
      reason: '학습·검증·시험 영상의 인물(subjectId)이 겹칩니다.',
      admitted: admitted.length,
    };
  }
  if (admitted.length < PROMOTION_MIN_REVIEWED_CLIPS) {
    return {
      promoteDetector: false,
      promoteAutoReacquire: false,
      reason: `검수 정답이 있는 실사 ${PROMOTION_MIN_REVIEWED_CLIPS}편이 필요합니다. 지금 ${admitted.length}편입니다.`,
      admitted: admitted.length,
    };
  }
  return {
    promoteDetector: false,
    promoteAutoReacquire: false,
    reason: '실사 수치가 아직 기준을 통과하지 못해 검출기 승격과 자동 재획득을 닫습니다.',
    admitted: admitted.length,
  };
}

export function emptyStage11Manifest(): Stage11Manifest {
  return { schemaVersion: STAGE11_MANIFEST_VERSION, clips: [] };
}
