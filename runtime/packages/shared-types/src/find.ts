/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·09831dee @license @preserve */
/* HILIT FIND — Scene 검색 규격.
 *
 * Phase 1은 자연어·LLM이 아니다. 나중에 문장이 이 쿼리로 바뀔
 * **계약**만 둔다. 필드가 있다고 해서 지금 영상에서 그 조건으로
 * 찾을 수 있는 것은 아니다. 지원 수준은 FieldSupport 를 본다.
 *
 * Phase 0: Action 분류·Scene 표·품질 점수는 MISSING.
 *          있는 것은 구간 시각(start/end)과 세션 추적, 그리고
 *          연결되지 않은 highlight score 계산 함수다.
 */

export type FieldSupport = 'SUPPORTED' | 'FUTURE' | 'UNAVAILABLE';

/**
 * V1 Action 목록.
 *
 * 앱 종목은 농구·풋살·클라이밍·피겨·러닝·일상이다 (types.ts SPORTS).
 * 팀 카테고리는 그보다 넓다. 지금 코드에는 슛/패스 분류기가 없다.
 *
 * 종목 말은 별칭으로 이 칸에 붙인다. 자세 가문은 poseFamily 로 나눈다.
 * score 는 highlightScore 와 헷갈려서 넣지 않는다.
 */
export const FIND_ACTIONS = [
  'shot',
  'goal',
  'pass',
  'run',
  'jump',
  'highlight',
  'unknown',
] as const;

export type FindAction = (typeof FIND_ACTIONS)[number];

/** 로컬 자세 분류기가 고르는 가문. 스파이럴과 악셀을 같은 칸에 두지 않기 위함이다. */
export const POSE_FAMILIES = [
  'jump',
  'spin',
  'hold',
  'shot',
  'pass',
  'run',
  'unknown',
] as const;

export type PoseFamily = (typeof POSE_FAMILIES)[number];

export type FindTargetPerson = 'self' | 'any';

export type FindSortBy = 'time' | 'score';

export const SCENE_SEARCH_FIELD_SUPPORT = {
  targetPerson: 'SUPPORTED',
  personId: 'UNAVAILABLE',
  action: 'FUTURE',
  poseFamily: 'SUPPORTED',
  startTime: 'SUPPORTED',
  endTime: 'SUPPORTED',
  minQuality: 'UNAVAILABLE',
  minHighlightScore: 'FUTURE',
  sortBy: 'SUPPORTED',
  limit: 'SUPPORTED',
  specificSkill: 'FUTURE',
} as const satisfies Record<string, FieldSupport>;

export type SceneSearchField = keyof typeof SCENE_SEARCH_FIELD_SUPPORT;

export type SceneMatchKind =
  | 'exact'
  | 'approximate'
  | 'unsupported'
  | 'insufficient_evidence'
  | 'no_results';

export type SubjectLinkStatus = 'confirmed' | 'uncertain' | 'unknown';
export type SceneObservation = 'observed' | 'empty' | 'out_of_range' | 'invalid' | 'insufficient';
export type SceneLabelSource = 'catalog' | 'rule-heuristic' | 'none';
export type SceneClassifierKind = 'rule-heuristic' | 'catalog-label' | 'unlabeled-peak';

export const SCENE_ANALYSIS_VERSION = 'scene-analysis-0.74';

/** 검색 명령. 자연어가 아니라 이미 쪼개진 조건이다. */
export interface SceneSearchQuery {
  targetPerson: FindTargetPerson;
  /** 다른 사람. 지금 신원 저장소가 없어 쓰면 무시된다. */
  personId: string | null;
  /** null 이면 액션으로 거르지 않는다. */
  action: FindAction | null;
  /** 자세 가문. null 이면 자세로 거르지 않는다. */
  poseFamily: PoseFamily | null;
  /** 악셀·러츠처럼 가문보다 가는 말. 가문 일치만으로는 정확 매칭이 아니다. */
  specificSkill: string | null;
  /** 초. null 이면 시작 제한 없음. */
  startTime: number | null;
  /** 초. null 이면 끝 제한 없음. */
  endTime: number | null;
  minQuality: number | null;
  minHighlightScore: number | null;
  sortBy: FindSortBy;
  limit: number;
}

export type SceneSearchQueryInput = Partial<SceneSearchQuery>;

export interface SceneSearchResult {
  sceneId: string;
  videoId: string;
  /** 원본 영상 기준 시작(초). */
  startTime: number;
  /** 원본 영상 기준 종료(초). */
  endTime: number;
  thumbnail: string | null;
  action: FindAction;
  poseFamily: PoseFamily | null;
  score: number;
  matchKind?: SceneMatchKind;
  matchReason?: string;
  subjectLink?: SubjectLinkStatus;
  observation?: SceneObservation;
  labelSource?: SceneLabelSource;
  classifierKind?: SceneClassifierKind;
  analysisVersion?: string;
  personIds?: string[] | null;
  trackId?: string | null;
}

export interface SceneRecord extends SceneSearchResult {
  targetPerson: FindTargetPerson;
  personId: string | null;
}

export type SearchNoteField = SceneSearchField | 'match' | 'identity' | 'skill' | 'observation';

export interface SearchNote {
  field: SearchNoteField;
  support: FieldSupport;
  effect: 'applied' | 'ignored' | 'unavailable';
  reason: string;
}

export interface SceneSearchResponse {
  query: SceneSearchQuery;
  results: SceneSearchResult[];
  notes: SearchNote[];
  status: SceneMatchKind;
  needsConfirm: boolean;
  analysisVersion: string;
}

/**
 * 장면이 어디서 왔는지. 액션 분류가 아니다.
 * highlight = HighlightCandidate (움직임·소리 점수 후보)
 * segment = EditorSegment (손 자른 구간이 타임라인에 들어간 것)
 * trim = TrimRange (손 자른 구간)
 */
export type SceneSource = 'highlight' | 'segment' | 'trim';

/**
 * 이 SceneMetadata 인스턴스에 실제로 값이 있는지.
 * 필드가 타입에 있다고 데이터가 있는 것이 아니다.
 */
export interface SceneFieldCapabilities {
  videoId: boolean;
  personIds: boolean;
  action: boolean;
  poseFamily: boolean;
  actionConfidence: boolean;
  qualityScore: boolean;
  highlightScore: boolean;
  thumbnailUrl: boolean;
  peakTime: boolean;
}

/**
 * FIND가 검색하는 공통 장면.
 *
 * Phase 0에 없는 값은 만들지 않는다. null + capabilities.
 * 세션 메모리의 Highlight / Segment / Trim 을 어댑터가 이 모양으로 옮긴다.
 */
export interface SceneMetadata {
  sceneId: string;
  videoId: string | null;
  startTime: number;
  endTime: number;
  /** HighlightCandidate.timestamp. 구간 안의 봉우리. 없으면 null. */
  peakTime: number | null;
  source: SceneSource;
  /** 사람 신원 목록. 지금 저장소가 없어 항상 null. */
  personIds: string[] | null;
  /** 종목 액션. catalog 라벨만 확정으로 쓴다. 거친 분류기 출력은 넣지 않는다. */
  action: FindAction | null;
  /** 자세 가문. 스파이럴=hold, 악셀=jump. 확인된 기술명이 아니다. */
  poseFamily: PoseFamily | null;
  /** 내부 점수. 검증된 정확도·동일인 확률이 아니다. */
  poseConfidence: number | null;
  labelSource?: SceneLabelSource | null;
  specificSkill?: string | null;
  observation?: SceneObservation | null;
  subjectLink?: SubjectLinkStatus | null;
  trackId?: string | null;
  actionConfidence: number | null;
  qualityScore: number | null;
  /** HighlightCandidate.score. 세그먼트·트림에는 없음. */
  highlightScore: number | null;
  thumbnailUrl: string | null;
  /** HighlightCandidate.reason. 신호 설명이지 슛/패스가 아니다. */
  reasons: string[];
  /** EditorSegment.label. */
  label: string | null;
  selected: boolean | null;
  capabilities: SceneFieldCapabilities;
}

/** TrimStage.TrimRange 와 같은 칸. UI 파일을 가져오지 않기 위한 입력. */
export interface FindTrimRange {
  id: string;
  start: number;
  end: number;
}

/** 원본 객체에 없는, 세션에서 같이 넘길 수 있는 값만. 액션·점수는 받지 않는다. */
export interface SceneAdapterContext {
  videoId?: string | null;
  trackId?: string | null;
}
