/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·32e9ef6b @license @preserve */
import type { FindAction, PoseFamily } from './find';

export type Orientation = 'landscape' | 'portrait' | 'square';

export interface NormalizedBBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TrackingPoint {
  timestamp: number;
  bbox: NormalizedBBox;
  confidence: number;
  tracking_health: number;
  reid_similarity: number;
  state: 'TRACKING_OK' | 'TRACKING_WARNING' | 'OCCLUDED' | 'TARGET_LOST' | 'REACQUIRING' | 'SERVER_RECOVERY' | string;
  /** 부재·불확실을 정상으로 두는 신원 상태. 위치 상태와 한 칸에 넣지 않는다. */
  identityLifecycle?:
    | 'TRACKING'
    | 'OCCLUDED'
    | 'OUT_OF_VIEW'
    | 'LOST_UNCERTAIN'
    | 'REENTRY_CANDIDATE'
    | 'VERIFYING'
    | 'REACQUIRED_PROVISIONAL'
    | 'NEEDS_USER_CONFIRMATION';
  /**
   * 사람이 직접 짚은 자리인가.
   *
   * 자동 추적이 틀렸을 때 사용자가 수동으로 고친 구간을 표시한다
   * (`applyManualKeyframes`). 두 가지에 쓴다.
   *
   *   1. 화면이 "여기는 직접 고친 구간" 으로 보여준다
   *   2. 다시 추적하거나 궤적을 다듬을 때 이 구간을 덮어쓰지 않는다 —
   *      사람이 준 사실이 기계 추정보다 위다
   */
  manual?: boolean;
  /** 같은 프레임의 다른 사람 상자. 크롭을 넓힐 때만 쓴다. 신원이 아니다. */
  nearbyBoxes?: NormalizedBBox[];
  /**
   * 따라가기 카메라가 이 점의 상자를 따라가지 않고 마지막으로 믿은 자리를 붙잡는다(2026-09-28).
   * 재추적을 건너뛴 구간에서 외형 점수가 낮아 다른 사람일 수 있는 점에 붙인다(presence-check skippedFraming).
   * 신원 판정이 아니다 — 카메라가 따라갈지 말지만 정한다.
   */
  cameraHold?: boolean;
  /**
   * 상태는 확인 안 된 의심 때문에 놓침(TARGET_LOST)으로 내렸지만, 상자는 추적기가 이 프레임에서 실제로 잰 것이다
   * (2026-09-28, tracking-postprocess). 확인 단계는 이 점을 여전히 묻고, 따라가기 카메라는 이 상자를 따라간다.
   * 신원 판정이 아니다.
   */
  doubtFollow?: boolean;
  /**
   * 녹화 편집 실험이 이 재등장 사건을 이미 처리했다.
   * 제품 기본 점에는 붙지 않는다. 정상 추적(TRACKING_OK·TRACKING_WARNING)을
   * 이 값만으로 면제하지 않는다.
   */
  editSpanResolved?: boolean;
  /**
   * 검출 연결 추적(linked-v1, 2026-10-20)이 「대상이 지금 화면에 없다」고 근거를 갖고 판단한 점.
   * 대상의 줄이 화면 밖으로 나가거나 가려져 끝났고, 그 뒤 들어온 사람 중 대상과 닮은 사람이 아직 없다.
   * 확인 단계는 이 점을 묻지 않는다(없는 사람을 「어디 있나요」로 묻지 않는다). 신원 판정이 아니다.
   */
  engineAbsent?: boolean;
}

export interface VideoMetadata {
  name: string;
  duration: number;
  width: number;
  height: number;
  orientation: Orientation;
  size: number;
  mimeType: string;
}

export interface VideoFeaturePoint {
  timestamp: number;
  motion: number;
  audioEnergy: number;
  sceneChange: number;
  trackingConfidence: number;
  subjectVisibility: number;

  /* 추적된 "그 사람" 에게서 직접 나오는 신호.
   *
   * motion 만으로는 카메라가 흔들린 것과 선수가 뛴 것을 구분하지 못한다.
   * 아래 값들은 궤적에서 계산하므로 대상 본인의 움직임만 본다.
   * 옛 호출부와 호환되도록 전부 선택 항목이다. */
  subjectSpeed?: number;      // 화면 대각선 대비 초당 이동량
  subjectAccel?: number;      // 속도 변화량 — 급출발·급정지
  sizeChange?: number;        // 박스 크기 변화 — 점프·카메라 접근
  directionChange?: number;   // 진행 방향 전환 — 드리블 방향 바꾸기
  trackingHealth?: number;    // 이 구간을 믿어도 되는가
  subjectVy?: number;         // 아래가 +, 화면 높이 대비 초당 이동
  upperMotion?: number;       // 화면 위쪽 변화 — 팔·상체
  lowerMotion?: number;       // 화면 아래쪽 변화 — 발·하체
  overlapOthers?: number;     // 다른 사람과 겹친 비율. 하이라이트 감점
  jerseyReadable?: boolean;   // 등번호가 읽힌 순간. 확정이 아니다
  identityHold?: boolean;     // 신원을 보류 중인 구간
  identityPresence?: 'observed_confirmed' | 'provisional' | 'uncertain' | 'absent' | 'needs_user';
  cameraShake?: number;       // 전역 흔들림. 대상 속도가 없으면 쓰지 않는다
}

export interface HighlightCandidate {
  id: string;
  timestamp: number;
  start: number;
  end: number;
  score: number;
  reason: string[];
  selected: boolean;
  action?: FindAction | null;
  poseFamily?: PoseFamily | null;
  /** 내부 점수. 검증된 정확도가 아니다. */
  poseConfidence?: number | null;
  labelSource?: 'catalog' | 'rule-heuristic' | 'none';
  observation?: 'observed' | 'empty' | 'out_of_range' | 'invalid' | 'insufficient';
  trackId?: string | null;
}

export interface EditorSegment {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  label: string;
}

export interface EditorProject {
  version: 1;
  video: VideoMetadata;
  tracking: TrackingPoint[];
  highlights: HighlightCandidate[];
  segments: EditorSegment[];
  outputAspect: 'source' | 'portrait' | 'landscape';
  updatedAt: string;
}

export {
  FIND_ACTIONS,
  POSE_FAMILIES,
  SCENE_SEARCH_FIELD_SUPPORT,
  SCENE_ANALYSIS_VERSION,
  type FieldSupport,
  type FindAction,
  type PoseFamily,
  type FindTargetPerson,
  type FindSortBy,
  type SceneSearchField,
  type SceneMatchKind,
  type SubjectLinkStatus,
  type SceneObservation,
  type SceneLabelSource,
  type SceneClassifierKind,
  type SearchNoteField,
  type SceneSearchQuery,
  type SceneSearchQueryInput,
  type SceneSearchResult,
  type SceneRecord,
  type SearchNote,
  type SceneSearchResponse,
  type SceneSource,
  type SceneFieldCapabilities,
  type SceneMetadata,
  type FindTrimRange,
  type SceneAdapterContext,
} from './find';

export {
  LOCAL_SHIP_VERSION,
  LOCAL_SHIP_FEATURES,
  localShipById,
  localShipIds,
  localShipContract,
  adviseLocalShip,
} from './local-ship';
export type {
  LocalShipLevel,
  LocalShipRuntime,
  LocalShipFeature,
  LocalShipId,
  LocalShipAdvice,
} from './local-ship';

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function isNormalizedBBox(box: NormalizedBBox): boolean {
  return [box.x, box.y, box.width, box.height].every(Number.isFinite)
    && box.x >= 0 && box.y >= 0 && box.width > 0 && box.height > 0
    && box.x + box.width <= 1.0001 && box.y + box.height <= 1.0001;
}
