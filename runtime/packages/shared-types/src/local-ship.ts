/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·060ea467 @license @preserve */
/**
 * Local 편집 제공 기준. 상태표는 이 파일 하나다.
 *
 * 2026-09-17 r076 측정을 보기 전에 단계를 고정했다.
 * 0.77은 같은 표에 실행 계약(입력·위치·결과·과금)만 보탠다.
 * 코드가 있다고 기본 제공으로 올리지 않는다.
 */

export const LOCAL_SHIP_VERSION = 'local-ship-0.77' as const;

export type LocalShipLevel = 'ship' | 'confirm' | 'experimental' | 'unsupported';
export type LocalShipRuntime = 'local' | 'cloud';

export interface LocalShipFeature {
  id: string;
  label: string;
  level: LocalShipLevel;
  /** 평가 전에 고정한 통과 조건. 검증 근거. */
  criteria: string;
  agentRule: string;
  featureVersion: string;
  inputs: readonly string[];
  runtime: LocalShipRuntime;
  extraCredits: number;
  resultFormat: string;
  failureStates: readonly string[];
}

type ShipSeed = {
  id: string;
  label: string;
  level: LocalShipLevel;
  criteria: string;
  agentRule: string;
};

function contractOf(id: string): Pick<
  LocalShipFeature,
  'featureVersion' | 'inputs' | 'runtime' | 'extraCredits' | 'resultFormat' | 'failureStates'
> {
  const local = {
    featureVersion: LOCAL_SHIP_VERSION,
    runtime: 'local' as const,
    extraCredits: 0,
    resultFormat: 'preview-then-apply',
    failureStates: ['reject', 'unsupported', 'clarify', 'stale'] as const,
  };
  if (id === 'cloud-director-run') {
    return {
      ...local,
      runtime: 'cloud',
      extraCredits: 10,
      inputs: ['cloudReady', 'creditLedger', 'sourceVideo'],
      resultFormat: 'blocked-until-cloud',
      failureStates: ['cloud-unconfigured', 'insufficient-credits', 'blocked'],
    };
  }
  if (id === 'gpu-effect') {
    return {
      ...local,
      runtime: 'cloud',
      extraCredits: 0,
      inputs: ['gpuEffectId', 'pricedCredits', 'explicitConfirm'],
      resultFormat: 'quote-then-confirm',
      failureStates: ['unpriced', 'blocked'],
    };
  }
  if (id === 'followup-keep-selected') {
    return { ...local, inputs: ['localVideo', 'visibleScenes', 'selectedKeepIds'] };
  }
  if (id === 'followup-move-visible' || id === 'followup-drop-last') {
    return { ...local, inputs: ['localVideo', 'visibleScenes'] };
  }
  if (
    id === 'person-scenes-approx'
    || id === 'manual-target'
    || id === 'auto-track-quality'
    || id === 'auto-reacquire'
    || id === 'identity-confirm'
  ) {
    return { ...local, inputs: ['localVideo', 'targetId'] };
  }
  if (id === 'smart-trim-rest' || id === 'smart-trim-hold-keep' || id === 'gather-move') {
    return { ...local, inputs: ['localVideo', 'motionFeatures'] };
  }
  if (id === 'action-candidates-approx' || id === 'pose-family-heuristic') {
    return { ...local, inputs: ['localVideo', 'targetSignalOptional'] };
  }
  return { ...local, inputs: ['localVideo'] };
}

const LOCAL_SHIP_SEEDS = [
  {
    id: 'compound-local',
    label: 'Local 복합 편집 계획',
    level: 'ship',
    criteria: '기존 시간·장면 후속만 단계로 묶음. 없는 기능은 실행하지 않음. Cloud로 올리지 않음.',
    agentRule: '문장이 복잡하다고 유료 전송하지 않는다. 일부 실패는 전체 성공으로 표시하지 않는다.',
  },
  {
    id: 'command-interpret',
    label: '시간·취소 명령 해석',
    level: 'ship',
    criteria: 'PHASE4: keep_span / cut_prefix / undo 단위 시험 통과. 대상 추적 불필요.',
    agentRule: '시간 남기기·앞자르기·취소를 실행한다.',
  },
  {
    id: 'time-keep',
    label: '원본 구간 남기기',
    level: 'ship',
    criteria: '길이 밖은 질문, 시작>끝은 거절. ffmpeg 길이 계약이 있으면 유지.',
    agentRule: '미리보기를 만든 뒤 같은 버전에서만 적용한다.',
  },
  {
    id: 'time-cut-prefix',
    label: '편집본 앞자르기',
    level: 'ship',
    criteria: '남길 구간이 없으면 거절. 대상 불필요.',
    agentRule: '편집본 시계로 자른다. 원본 파일은 건드리지 않는다.',
  },
  {
    id: 'time-cut-suffix',
    label: '편집본 끝자르기',
    level: 'ship',
    criteria: '남길 구간이 없으면 거절. 마지막 장면 빼기와 구분.',
    agentRule: '지금 남은 영상의 끝만 자른다. 원본 파일은 건드리지 않는다.',
  },
  {
    id: 'time-split',
    label: '시각에서 나누기',
    level: 'ship',
    criteria: '구간 한가운데일 때만. 지우지 않음. 삭제·유지와 혼동 금지.',
    agentRule: '그 시각에서 클립을 둘로 나눈다. 길이는 그대로다.',
  },
  {
    id: 'undo',
    label: '방금 편집 취소',
    level: 'ship',
    criteria: '히스토리가 없으면 거절. 원본 파일 유지.',
    agentRule: '직전 스냅샷만 되돌린다.',
  },
  {
    id: 'export-plan',
    label: '내보내기 계획',
    level: 'ship',
    criteria: '구간이 있을 때만 계획. 브라우저 실파일은 별도 미검증.',
    agentRule: '계획을 넘긴다. Export 클릭을 만족으로 세지 않는다.',
  },
  {
    id: 'followup-move-visible',
    label: '보이는 장면 앞으로 옮기기',
    level: 'ship',
    criteria: '화면에 보이는 순서의 N번째를 맨 앞으로. 원본 시각은 유지. 재분석 없음.',
    agentRule: '목록이 방금 바뀌었으면 두 번째가 맞는지 묻는다. 다른 편집으로 바꾸지 않는다.',
  },
  {
    id: 'followup-drop-last',
    label: '마지막 장면 빼기',
    level: 'ship',
    criteria: '지금 목록의 마지막만 뺀다. 원본 파일 유지. 재분석 없음.',
    agentRule: '장면이 없으면 거절한다. 전체를 다시 분석하지 않는다.',
  },
  {
    id: 'followup-keep-selected',
    label: '고른 장면만 남기기',
    level: 'confirm',
    criteria: '선택된 ID가 있거나 목록이 그 개수일 때만. 모호하면 묻는다.',
    agentRule: '선택 없이 임의로 두 개를 고르지 않는다.',
  },
  {
    id: 'smart-trim-rest',
    label: '쉬는 부분 제안',
    level: 'confirm',
    criteria: '적용 전 확인. 사람 검수 휴식 라벨이 없으면 정확도를 말하지 않음.',
    agentRule: '제안을 보여 주고 확인 전에 자동 적용하지 않는다.',
  },
  {
    id: 'smart-trim-hold-keep',
    label: '쉬는 부분 제거 + 정지 자세 유지',
    level: 'confirm',
    criteria: '0.75 합성 1표본에서 REST로 자르지 않음. 실사 홀드 P/R 없음.',
    agentRule: '휴식을 빼면서 홀드는 남기려 한다. 천천히 들어가는 동작은 확인을 요청한다.',
  },
  {
    id: 'gather-move',
    label: '움직이는 구간 모으기',
    level: 'confirm',
    criteria: 'Smart Trim 제안. 슛·득점으로 바꾸지 않음.',
    agentRule: '일반 움직임 후보만 제안한다. 특정 동작으로 확정하지 않는다.',
  },
  {
    id: 'person-scenes-approx',
    label: '선택한 사람 장면',
    level: 'confirm',
    criteria: 'personIds 없으면 본인 확정 금지. 근사 후보.',
    agentRule: '확인을 요청한다. 동일인이라고 말하지 않는다.',
  },
  {
    id: 'add-chosen-candidates',
    label: '고른 후보만 넣기',
    level: 'confirm',
    criteria: '직전 후보가 있을 때만. 개수 제한을 지킨다.',
    agentRule: '확인된 목록의 앞 N개만 넣는다.',
  },
  {
    id: 'action-candidates-approx',
    label: '동작 후보 탐색',
    level: 'confirm',
    criteria: '추적 없는 전역 차분은 가문 금지(0.74). 사람 동작 라벨 없으면 exact 금지.',
    agentRule: '근사 후보다. 슛·득점으로 확정하지 않는다.',
  },
  {
    id: 'manual-target',
    label: '대상 수동 지정',
    level: 'confirm',
    criteria: '자동 복구 끔. 사용자가 짚은 자리만 시작점으로 쓴다.',
    agentRule: '다시 고르라고 안내할 수 있다. 자동으로 다른 사람을 붙이지 않는다.',
  },
  {
    id: 'pose-family-heuristic',
    label: '규칙 동작 가문',
    level: 'experimental',
    criteria: '대상 신호가 있을 때만 가문. 실사 P/R 없음. 학습 모델 아님.',
    agentRule: '실험 분류다. 성공처럼 말하지 않는다.',
  },
  {
    id: 'person-detect',
    label: '사람 검출',
    level: 'unsupported',
    criteria: '제품 검출기 없음(0.56). NanoDet 금지. 시드 IoU 목표 미달.',
    agentRule: '검출했다고 약속하지 않는다. 사용자가 대상을 짚게 한다.',
  },
  {
    id: 'auto-track-quality',
    label: '대상 자동 유지',
    level: 'unsupported',
    criteria: '축구·산책 대상 유지 미통과. 통과 전 기본 제공 금지.',
    agentRule: '끝까지 따라간다고 말하지 않는다.',
  },
  {
    id: 'identity-confirm',
    label: '동일인 확정',
    level: 'unsupported',
    criteria: 'personIds·검수 궤적 없이 확정 금지. 자동 Re-ID 미통과.',
    agentRule: '같은 사람이라고 단정하지 않는다. 확인을 요청한다.',
  },
  {
    id: 'auto-reacquire',
    label: '자동 재획득',
    level: 'unsupported',
    criteria: 'autoReacquireEnabled=false. 자동 확정 0.',
    agentRule: '놓친 시각으로 다시 감싸 달라고 안내한다.',
  },
  {
    id: 'exact-shot',
    label: '정확한 슛 인식',
    level: 'unsupported',
    criteria: '사람 검수 슛 구간 라벨 없음. 내부 점수는 정확도가 아님.',
    agentRule: '슛을 찾았다고 확정하지 않는다.',
  },
  {
    id: 'goal-search',
    label: '득점 장면 탐색',
    level: 'unsupported',
    criteria: '장면 의미 검색 미지원. 일반 움직임으로 대체 금지.',
    agentRule: '실행하지 않고, 다른 편집으로 바꾸지 않는다.',
  },
  {
    id: 'skill-only-keep',
    label: '특정 기술만 남기기',
    level: 'unsupported',
    criteria: '백플립 등을 휴식 제거로 바꾸지 않음.',
    agentRule: '미지원이라고 말하고 트림으로 바꾸지 않는다.',
  },
  {
    id: 'portrait-reframe',
    label: '세로 사람 중심',
    level: 'unsupported',
    criteria: 'REFRAME_QUALITY_VERIFIED=false.',
    agentRule: '실행하지 않는다.',
  },
  {
    id: 'cloud-director-run',
    label: 'AI Director 제작',
    level: 'unsupported',
    criteria: 'Cloud·GPU 미연결에서 전송·차감·실행 금지.',
    agentRule: '유료 실행을 시작하지 않는다.',
  },
  {
    id: 'gpu-effect',
    label: '추가 GPU 효과',
    level: 'unsupported',
    criteria: '기능별 Credits 미결정. GPU_EFFECT_UNPRICED.',
    agentRule: '가격이 없는 GPU 작업을 실행하지 않는다.',
  },
] as const satisfies readonly ShipSeed[];

export const LOCAL_SHIP_FEATURES: readonly LocalShipFeature[] = LOCAL_SHIP_SEEDS.map((row) => ({
  ...row,
  ...contractOf(row.id),
}));

export type LocalShipId = (typeof LOCAL_SHIP_SEEDS)[number]['id'];

export function localShipById(id: string): LocalShipFeature | null {
  return LOCAL_SHIP_FEATURES.find((row) => row.id === id) ?? null;
}

export function localShipIds(level: LocalShipLevel): string[] {
  return LOCAL_SHIP_FEATURES.filter((row) => row.level === level).map((row) => row.id);
}

export function localShipContract(id: string): LocalShipFeature | null {
  return localShipById(id);
}

export interface LocalShipAdvice {
  featureId: LocalShipId | 'unknown';
  level: LocalShipLevel;
  blockExecution: boolean;
  userMessage: string;
  askConfirm: boolean;
  runtime: LocalShipRuntime;
  extraCredits: number;
}

function fold(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 문장이 가리키는 제공 단계.
 * 미지원이면 다른 편집으로 바꾸라는 뜻이 아니다.
 */
export function adviseLocalShip(text: string): LocalShipAdvice {
  const raw = fold(text);
  const feature = (id: LocalShipId, extra: string): LocalShipAdvice => {
    const row = localShipById(id)!;
    const unsupported = row.level === 'unsupported';
    const paidOrCloud = row.runtime === 'cloud' || row.extraCredits > 0;
    return {
      featureId: id,
      level: row.level,
      blockExecution: unsupported || paidOrCloud,
      askConfirm: row.level === 'confirm' || row.level === 'experimental',
      userMessage: extra || row.agentRule,
      runtime: row.runtime,
      extraCredits: row.extraCredits,
    };
  };

  if (!raw) {
    return {
      featureId: 'unknown',
      level: 'confirm',
      blockExecution: false,
      askConfirm: true,
      userMessage: '무엇을 할지 한 번 더 말해 주세요.',
      runtime: 'local',
      extraCredits: 0,
    };
  }

  if (/백플립|프론트플립|악셀|러츠|덩크|레이업|스파이럴/.test(raw) && /만\s*(남겨|남기)/.test(raw)) {
    return feature('skill-only-keep', '그 기술만 남기기는 아직 확인하지 못합니다. 쉬는 부분 자르기로 바꾸지 않았습니다.');
  }
  if (/골\s*장면|득점|골만|골 넣/.test(raw) && !/골프/.test(raw)) {
    return feature('goal-search', '득점 장면 찾기는 지금 지원하지 않습니다. 일반 움직임 후보로 바꾸지 않았습니다.');
  }
  if (/세로로|사람 중심|가운데로 세로|리프레임/.test(raw) && /만들|세로/.test(raw)) {
    return feature('portrait-reframe', '선택한 사람 중심으로 세로 영상을 만드는 기능은 아직 열지 않습니다.');
  }
  if (/자동\s*(으로\s*)?(다시\s*)?(찾|붙|복구|재획득)|놓친\s*사람\s*자동/.test(raw)) {
    return feature('auto-reacquire', '놓친 사람을 자동으로 다시 붙이지 않습니다. 그 시각에서 본인을 다시 감싸 주세요.');
  }
  if (/같은\s*사람\s*(맞|인지|확정)|동일인/.test(raw) || (/제\s*장면|내\s*장면|본인\s*장면/.test(raw) && /찾|골라/.test(raw))) {
    return feature('identity-confirm', '같은 사람이라고 단정하지 않습니다. 화면을 보고 확인해 주세요.');
  }
  if (/사람\s*(검출|찾아)|누가\s*있는지\s*찾아/.test(raw)) {
    return feature('person-detect', '사람 검출기는 제품에 없습니다. 본인을 직접 짚어 주세요.');
  }
  if (/클라우드|디렉터로\s*제작|크레딧\s*으로\s*만들/.test(raw)) {
    return feature('cloud-director-run', 'Cloud가 연결되기 전에는 유료 제작을 시작하지 않습니다.');
  }
  if (/gpu|보간|프레임을\s*만들|슬로우\s*모션\s*생성/.test(raw)) {
    return feature('gpu-effect', '추가 GPU 작업은 기능별 비용이 정해지기 전에는 실행하지 않습니다.');
  }
  if (/(그리고|및)\s+|빼고\s+|자르고\s+|남기고\s+|없애고\s+|넣고\s+|붙여서\s+|찾아서\s+/.test(raw)) {
    return feature('compound-local', '문장이 길어도 Local에서 단계로 나눕니다. 없는 기능은 실행하지 않습니다.');
  }
  if (/방금 편집을 취소|방금 한 거 취소|undo/.test(raw)) {
    return feature('undo', '방금 편집만 되돌립니다. 원본 파일은 그대로입니다.');
  }
  if (/마지막\s*장면/.test(raw) && /빼|지워|없애|삭제/.test(raw)) {
    return feature('followup-drop-last', '지금 목록의 마지막 장면만 뺍니다. 원본은 그대로입니다.');
  }
  if (/선택한\s*두\s*장면만\s*남|고른\s*두\s*장면만\s*남|이\s*두\s*장면만\s*남/.test(raw)) {
    return feature('followup-keep-selected', '고르신 장면만 남깁니다. 선택이 모호하면 묻습니다.');
  }
  if (/장면/.test(raw) && /앞|앞으로|맨\s*앞|옮겨/.test(raw) && /번째|첫째|둘째|셋째/.test(raw)) {
    return feature('followup-move-visible', '화면에 보이는 그 장면을 앞으로 옮깁니다. 원본 시간은 바꾸지 않습니다.');
  }
  if (/내보내|뽑아줘|export/.test(raw)) {
    return feature('export-plan', '지금 구간 계획으로 내보내기를 준비합니다. 이 클릭만으로 만족했다고 보지 않습니다.');
  }
  if (/후보.{0,20}넣|두 개만/.test(raw)) {
    return feature('add-chosen-candidates', '확인하신 후보만 넣습니다. 슛이나 같은 사람으로 단정하지 않습니다.');
  }
  if (/선택한\s*사람|고른\s*사람/.test(raw) && /장면/.test(raw)) {
    return feature('person-scenes-approx', '고른 사람 장면 후보입니다. 본인인지 확인하고 넣어 주세요.');
  }
  if (/쉬는 부분/.test(raw) && /자세/.test(raw)) {
    return feature('smart-trim-hold-keep', '쉬는 부분은 빼되 정지 자세는 남기려 합니다. 적용 전에 확인해 주세요.');
  }
  if (/움직이(는)?\s*(구간|부분|장면).{0,8}모아|움직임을 모아/.test(raw)) {
    return feature('gather-move', '움직이는 구간 제안입니다. 슛으로 바꾸지 않았습니다. 적용 전에 확인해 주세요.');
  }
  if (/쉬는 부분|휴식/.test(raw)) {
    return feature('smart-trim-rest', '쉬는 부분 제안입니다. 적용 전에 확인해 주세요.');
  }
  if (/점프한|점프만/.test(raw) && /남겨|남기/.test(raw)) {
    return feature('pose-family-heuristic', '점프만 남기기는 확인된 동작이 아닙니다. 실행하지 않습니다.');
  }
  if (/지점.{0,8}나눠|나눠\s*줘|분할해/.test(raw)) {
    return feature('time-split', '그 시각에서 클립을 나눕니다. 지우지 않습니다.');
  }
  if (/(마지막|맨\s*뒤|끝부분).{0,12}초/.test(raw) && /삭제|자르|없애|지워|컷/.test(raw)) {
    return feature('time-cut-suffix', '지금 남은 영상의 끝을 자릅니다. 원본 파일은 그대로입니다.');
  }
  if (/원본.{0,12}남겨|초부터.{0,12}까지 남/.test(raw)) {
    return feature('time-keep', '말한 원본 시간을 남기는 미리보기입니다.');
  }
  if (/앞.{0,6}초를 잘|앞부분/.test(raw)) {
    return feature('time-cut-prefix', '편집본 앞부분을 자르는 미리보기입니다.');
  }
  if (/슛|점프 장면|하이라이트/.test(raw)) {
    return feature('action-candidates-approx', '동작 후보입니다. 정확한 슛으로 확정하지 않습니다. 확인 후 넣어 주세요.');
  }

  return {
    featureId: 'command-interpret',
    level: 'confirm',
    blockExecution: false,
    askConfirm: true,
    userMessage: '확인이 필요한 요청으로 받습니다. 없는 기능을 실행한다고 말하지 않습니다.',
    runtime: 'local',
    extraCredits: 0,
  };
}
