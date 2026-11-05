/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·6cff1a45 @license @preserve */
/** 공식 AI Hub 표/수신 원문과 대조한 이름만 표시합니다. 이름 사전은 인식 성능의 증거가 아닙니다. */
export const SCOUT_ACTION_TERMS:Readonly<Record<string,Readonly<Record<string,string>>>>={
  '52':{'1':'아이솔레이션 머리','2':'아이솔레이션 어깨','3':'아이솔레이션 가슴','4':'아이솔레이션 골반','5':'웨이브 팔','6':'웨이브 몸통','7':'웨이브 엉덩이','8':'문워크','9':'바운스','10':'라이닝 수평','11':'라이닝 수직','12':'라이닝 대각','13':'스텝 앞·뒤','14':'스텝 옆','15':'롤','16':'점프','17':'펀치','18':'클랩','19':'스톱앤고(브레이크)','20':'팝'},
  '65':{setup:'셋업',adress:'어드레스',takeback:'테이크백',backswing:'백스윙',backswingtop:'백스윙탑',downswing:'다운스윙',impact:'임팩트',follow:'팔로우',finish:'피니쉬',putt:'퍼팅'},
  '66':{dribble:'드리블',pass:'패스',shoot:'슛',defense:'수비',steal:'스틸',blockshoot:'블록슛',rebound:'리바운드',boxout:'박스아웃',foul:'파울'},
  '67':{dribble:'드리블',pass:'패스',shoot:'슛',defense:'수비',steal:'스틸',cornerkick:'코너킥',freekick:'프리킥',sliding:'슬라이딩',foul:'파울'},
  '71422':{'air-squat':'에어 스쿼트','front-squat':'프런트 스쿼트','overhead-squat':'오버헤드 스쿼트','shoulder-press':'숄더 프레스','push-press':'푸시 프레스','jerk-press':'저크 프레스',deadlift:'데드리프트','sumo-deadlift-high-pull':'스모 데드리프트 하이 풀','medicine-ball-clean':'메디신볼 클린'},
};
export const SCOUT_ACTION_TERM_SOURCES=[
  'https://aihub.or.kr/file/down.do?fileSn=7733&dataMnlFileSn=7733&dataSetSn=52',
  ...['65','66','67','71422'].map(id=>`https://aihub.or.kr/aihubdata/data/view.do?dataSetSn=${id}`),
] as const;
export function verifiedScoutActionName(label:string):string|null {
  const match=/^aihub\.(\d+)\.([a-z0-9-]+)$/.exec(label);
  return match?SCOUT_ACTION_TERMS[match[1]]?.[match[2]]??null:null;
}
export function scoutActionDisplayName(label:string|null):string {
  return label===null||label==='종류 미확인'?'종류 미확인':verifiedScoutActionName(label)??'동작명 미확인';
}
