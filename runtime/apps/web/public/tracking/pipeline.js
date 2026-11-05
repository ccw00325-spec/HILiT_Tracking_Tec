/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·4c744db7 @license @preserve */
/* 브라우저 단독 추적 파이프라인. 서버가 없다.
 *
 * 아키텍처상 달라지는 점 하나를 분명히 해둔다.
 *
 *   Lv1  모션 예측          그대로 된다
 *   Lv2  자체 검출기 후보    후보는 만들 수 있다. 기본은 진단·선택 보조만.
 *                           자동 재획득은 끄고 시작한다.
 *   Lv3  Cutie 정밀 복구     불가능 — PyTorch 134MB + 백본 143MB
 *   Lv4  사용자 확인         그대로 된다
 *
 * Cutie 를 브라우저에 올릴 수 없으므로 Lv3 가 빠지고, 원래 Lv3 로 갔을
 * 구간이 Lv4(사용자 확인)로 넘어간다. 정확도는 떨어지지만 4단계 우선순위가
 * 이미 Lv4 폴백을 갖고 있어서 구조는 유지된다.
 *
 * 카메라 이동 보정(sparse LK 광류)은 아직 이식하지 않았다. 없으면 카메라
 * Pan 을 사람의 이상 이동으로 오판할 수 있다. 미구현임을 화면에 표시한다.
 */
import { CONFIG } from './config.generated.js';
import { CameraMotion } from './camera-motion.js';
import { applyAffineToBox } from './affine-gmc.js';
import { TrackletGraph, JerseyLock, readJerseyNumber, gateSportsIdentity, describeTeam, decideTeamCue, estimateCourtHint, courtFootDistance } from './sports-track.js';
/* 마지막 방어선. 외형·검출·재식별이 전부 실패해도 살아 있는 규칙들이다 —
 * 사람은 화면 밖으로 순간이동하지 않고, 한 걸음에 옆 사람 자리로
 * 건너뛰지 않는다. 정본은 packages/hilit-vision/src/frame-guard.ts. */
import { clampToFrame, hasEscaped, visibleRatio, isStationary,
         judgeStep, limitStep, limitScale, limitToSizeBand,
         discountByVisibility, MIN_VISIBLE }
  from './hilit-frame-guard.js';

/* 사용자가 고른 박스에 더할 여유 비율. 아래 track() 의 설명 참조. */
const CONFIG_TARGET_PAD = 0.15;
/* 같은 사람의 흔들림이 남과의 거리보다 이만큼은 앞서야 Re-ID 를 신뢰한다.
 * 값은 두 영상의 실측으로 정한다 — 진단 출력의 selfMin / strangerBest 참조.
 *
 * 모듈 스코프에 둔다. 원래 track() 안에서 선언했는데 쓰는 곳(구분력 측정)이
 * 선언보다 128행 앞이었다. const 는 hoisting 되지 않으므로 TDZ
 * ReferenceError 가 났고, 그 측정을 감싼 try/catch 가 그걸 삼켰다.
 * 결과: appearanceWeak 판정이 항상 false 로 죽어 있었고 strangerColorBest
 * 는 늘 null 이었다. 지표의 separabilityError 에 그대로 남아 있었다. */
const APPEARANCE_MARGIN = 0.12;

/* --- 색 불일치 감시 -------------------------------------------------
 *
 * 실측이 이 신호를 고르게 만들었다. 사용자 영상에서 추적 중인 박스의
 * 앵커 색 유사도를 66회 측정하니 이렇게 갈렸다.
 *
 *   정상 추적(46회)      중앙 0.72,  p10 0.62
 *   확인된 오연관(15.6초~) 0.42 ~ 0.52
 *   그때 진짜 대상       0.73 ~ 0.78
 *
 * 중요한 건 절대값이 아니라 **격차**다. 대상이 팔을 벌리거나 몸을 돌리면
 * 정상인데도 색이 0.40 까지 떨어진다(t=2.08 실측). 그래서 절대 임계값은
 * 오발동한다. 반면 "다른 검출이 내 대상 색에 이만큼 더 가깝다" 는 정상
 * 구간에서 거의 일어나지 않는다.
 *
 * 격차 0.24 / 연속 2회로 두면 t=7.33, 14.33, 15.83 에서 발동한다. 셋 다
 * 실제로 틀렸거나 흔들린 구간이고(7.33 은 t=8.5 기준점 실패 구간,
 * 15.83 은 눈으로 확인한 전환), 확인된 정상 구간에서는 한 번도 발동하지
 * 않는다.
 *
 * 앞선 시도가 색으로 실패한 이유와 구분해 둔다. 그때는 색을 후보 점수에
 * 가중 0.6 으로 섞었다 — 진짜 대상이 후보에 아예 없는 프레임에서 색이
 * 잡음으로 작동해 결과가 나빠졌다. 여기서는 점수에 섞지 않는다.
 * "지금 잡고 있는 게 대상처럼 보이는가" 만 묻고, 아니라고 하면 판단을
 * 내리지 않고 기존 복구 경로(Lv2)로 넘긴다. 신호의 용도가 다르다. */
const COLOR_DISAGREE_GAP = 0.24;
const COLOR_DISAGREE_RUN = 2;
/* 🔴 "남이 더 닮았다" 만으로는 경보를 울리지 않는다 — 지금 잡고 있는
 *    것이 **대상처럼 안 보일 때**만 울린다.
 *
 * 이걸 빠뜨려서 사용자 불만 7번이 생겼다. 겹침 영상에는 **똑같은 옷차림
 * (파란 헬멧 · 검은 재킷 · 흰 줄)이 셋** 있다. 그러면 "남이 나보다 조금
 * 더 닮았다" 가 계속 성립한다 — 같은 옷이니 당연하다. 그때마다 경보가
 * 울려서, 잘 따라가고 있는 6초 구간이 세 번이나 "확인 필요" 로 칠해졌다.
 *
 * 원래 이 감시가 잡으려던 것은 다른 상황이다. 예전 영상에서 우리는
 * **검은 옷 · 주황 헬멧**을 잡고 있었고(색 0.468) 진짜 대상(회색 상의 ·
 * 파란 헬멧)이 0.729 였다. 즉 우리가 잡은 것이 대상과 전혀 다르게
 * 보였다. 그 상황만 잡으면 된다.
 *
 * 처음에는 고정값 0.62 로 뒀다가 되돌렸다 — 겹침 영상에서 **제대로 잡고
 * 있을 때의 색 점수 평균이 0.56** 이었다(대상이 작고 배경이 흰 얼음이라
 * 낮게 나온다). 고정값은 영상마다 맞지 않는다.
 *
 * 그래서 기준을 **우리 자신에게서** 얻는다. 확인된 프레임에서 "지금 잡고
 * 있는 것의 색 점수" 를 천천히 평균 내고(selfColorLevel), 그 수준에서
 * 뚜렷하게 떨어질 때만 경보를 울린다. 같은 옷 세 명이 있어도 우리 점수는
 * 평소 수준을 유지하므로 조용하고, 진짜로 딴 사람을 잡으면 점수가
 * 무너지므로 울린다. */
const COLOR_SELF_DROP = 0.08;
/** 넓힌 복구에서 색 점수가 이 값을 넘기면, selfColorLevel 이 더 높아도
 *  그 이상은 요구하지 않는다.
 *
 *  실측(밝은 날 산책): 초반 selfColorLevel 0.847 → 상대 기준은 0.767.
 *  대상이 그늘·카메라 쪽으로 몇 걸음 옮기자 같은 옷이 그 아래로 떨어져
 *  후보가 0이 됐다. 겹침 영상에서 제대로 잡고 있을 때 평균은 0.56 이라
 *  그때는 min(0.48, 이 값) = 0.48 로 지금과 같다. */
const COLOR_WIDE_NEED_CAP = 0.72;
/** 복구가 이만큼(몸 너비 배수) 건너뛰어 받아들이면 "주인이 바뀐 순간"
 *  으로 보고 사용자에게 보여준다. 1.0 이면 옆 사람 자리로 옮긴 정도다. */
const REACQUIRE_JUMP_BODIES = 1.0;
/** 제자리에 있던 대상의 "자리가 답이다" 판정 반경 — 몸 너비 배수.
 *  사람 둘이 몸 하나 안쪽에 같이 설 수는 없다. */
const REST_POSITION_BODIES = 0.8;
/* 사용자가 지정한 직후 "그 자리를 정답으로 믿는" 시간과 반경.
 * 2.5초 · 몸 1.2배 — 사람이 그 안에 두 명 설 수는 없다. */
const USER_ANCHOR_SECONDS = 2.5;
const USER_ANCHOR_BODIES = 1.2;
/** 기준이 설 만큼 표본이 모이기 전에는 이 감시를 쓰지 않는다. */
const COLOR_SELF_MIN_SAMPLES = 8;
/* 색을 재는 후보 수 상한. jerseyColor 는 박스마다 getImageData 3회라
 * 검출 전부에 돌리면 추적 시간이 45초에서 57초로 늘었다(실측). */
const COLOR_SCAN_MAX = 8;

/* --- 복구에서 "모호" 를 뒤집는 조건 -----------------------------------
 *
 * rankCandidates 는 1·2등 종합점수 차가 CANDIDATE_AMBIGUOUS_MARGIN(0.06)
 * 미만이면 아무도 고르지 않고 사용자 확인으로 넘긴다. 안전한 기본값이다.
 *
 * 그런데 사용자 영상에서는 그 규칙이 정답을 버렸다. 복구가 부른 5번의
 * 판정에서 1등은 매번 진짜 대상이었는데 점수 차가 0.011~0.052 였다.
 *
 *   t=15.83  1등 cx=0.557 reid 0.792   (실제 0.548)  차 0.051  -> 버려짐
 *   t=16.83  1등 cx=0.475 reid 0.810   (실제 0.472)  차 0.042  -> 버려짐
 *
 * 그동안 추적기는 4등(reid 0.621)에 앉아 있었다. 정답을 계산해 놓고
 * 버린 뒤 틀린 사람을 계속 따라간 것이다.
 *
 * 그래서 종합점수 차가 작아도 Re-ID 증거가 뚜렷하면 받는다. 기준은
 * 절대값이 아니라 **이 영상에서 실측한 낯선 사람 최고값**이다
 * (strangerBest, 앵커 프레임에서 주변 8명과 직접 비교한 값). 그 위로
 * 확실히 올라오고 2등보다도 앞서면 그건 잡음이 아니다.
 *
 * 절대 임계값을 쓰지 않는 이유는 이 파일 다른 곳과 같다 — 같은 사람도
 * 17초 뒤에는 0.48 까지 내려가고 낯선 사람 최고값 0.715 와 겹친다. */
const REACQUIRE_REID_MARGIN = 0.03;   // 낯선 사람 최고값 위로 이만큼
const REACQUIRE_REID_LEAD = 0.05;     // 2등보다 이만큼 앞서야
import { HilitMotionTracker, HilitAppearance, cosine, iou } from './models.js?v=063';
import { HilitDcfTracker } from './hilit-dcf-tracker.js';
import { HilitDcfGpuTracker } from './hilit-dcf-gpu-tracker.js';
import { DEFAULT_TRACKER_CORE, resolveTrackerCore, resolveSizeLock } from './tracker-core.js';
import { HilitPersonDetector, decideDetectorReacquire } from './hilit-person-detector.js';
import { buildPersonNetDiagnoseResult } from './hilit-person-net-diagnose.js';
import { nextAnchorDrift, decideAppearanceMatch } from './hilit-appearance.js?v=063';
import { planDetectorSearch, productMayApplyIdentity, buildReacquireEvidence, mayUpdateAppearanceMemory, composeTrackReport } from './detector-stage2.js';
import { fillProposalOthers, pickBestByAppearance } from './identity-stage4.js';
import { MultiViewReid } from './multiview-reid.js';
import { mapPipelineStateToLifecycle, experimentMayApplyIdentity } from './identity-lifecycle.js';
import { judgeReentry, temporalReady } from './generated/reentry-match.js';
import { refineProvisional } from './generated/provisional-reacquire.js';
import { buildIdentityApplyVerification } from './generated/identity-recovery-experiment.js';
import { reverseTrackVerify } from './generated/reverse-track.js';
import { rgbaToGray } from './generated/motion-tracker.js';
import { assignCandidatesToTracklets } from './generated/candidate-identity.js';
import { scoreIdentityAgainstMemories } from './generated/identity-descriptor.js';
import { IdentityHypothesisTracker } from './generated/identity-hypothesis.js';
import { rankReentryCandidates } from './generated/reentry-rank.js';
import { StableViewSampler } from './generated/stable-view-sampler.js';
import { AppearanceGallery } from './generated/appearance-gallery.js';
import { ReidScheduler, REID_SCHEDULER_POLICY } from './generated/reid-scheduler.js';
/* FrameFeatureCache 는 frame-feature-cache.ts 에 있다. 생성기가 파일을 1:1 로
   옮기므로 reid-scheduler.js 에는 없다. 여기서 잘못 가져오고 있었고, ES 모듈은
   없는 이름을 import 하면 **모듈 전체가 링크에 실패한다** — pipeline.js 가 통째로
   안 뜨고 편집기 첫 화면의 영상 선택이 아무 반응도 하지 않았다. */
import { FrameFeatureCache } from './generated/frame-feature-cache.js';
import { anchorDecision, anchorDue, anchorMissStep, crossingStep, DETECTION_ANCHOR } from './detection-anchor.js';
import { edgeAbsenceStep, EDGE_ABSENCE_EXPERIMENT_DEFAULT } from './stage3-honesty.js';
import {
  backgroundStickStep, reattachAllowed, templateUpdateAllowed, CONTINUITY_EXPERIMENT_DEFAULT,
} from './stage6-continuity.js';
import { sportSoftProfile, isKnownSport } from './generated/sport-soft-profile.js';
import { JaccardNeighborCache } from './generated/k-reciprocal-rerank.js';
import { detectorObservationTrust } from './generated/detector-observation.js';
import { browserCameraToQuality } from './generated/spatial-quality.js';
import {
  createConfirmedOtherGallery, fillFromAnchorFrame, judgeAgainstConfirmedOthers, addUserRejected,
  iou as galleryIoU, CONFIRMED_OTHER_POLICY,
} from './generated/confirmed-other-gallery.js';
import { scoreIdentityPair } from './generated/identity-descriptor.js';
import { TrackRegionPredictor } from './generated/track-region-prediction.js';
import { loadPoseRuntime, sharedPoseRuntime } from './generated/pose-runtime.js';
import { predictionRejectOnly } from './generated/prediction-identity-firewall.js';
import { DETECTOR_SCORE_MIN } from './generated/detector-thresholds.js';

/* 자세 추정 가중치. 우리가 학습한 것만 싣는다.
 * 없으면 관절 없이 간다 — 상자에서 가상 관절을 만들지 않는다. */
const POSE_MODEL_ID = 'hilit-pose-synth-v0';
/* 자세 추정을 몇 프레임마다 돌릴지.
 *
 * 1 로 시작한다 — 실측 근거가 있다. 이 모듈은 crop 하나에 호스트
 * (i5-10210U) p95 7.7ms 이고, S24 공개 GB6 단일코어 비율에 지속 감쇠
 * 0.7 을 얹어 환산하면 p95 6.3ms 로 분석 프레임 예산(50ms)의 12.7% 다
 * (`scripts/bench-hilit-posenet.mjs`).
 *
 * 다만 그 환산은 **가정**이다. 그래서 고정하지 않고 실제로 걸린 시간을
 * 보며 기기가 스스로 간격을 늘리고 줄인다. 느린 기기에서 내 가정이
 * 틀려도 화면이 먼저 무너지지는 않는다. */
/* 🟢 2026-09-21 — 재획득에서 화면을 조각내어 확대해 본다.
 *
 * 격자는 64×96 을 8×12 칸으로 본다. 한 칸이 8화소이고, 백본이 8배로
 * 줄이고 나면 작은 사람은 특징 지도에서 점 하나도 안 된다. 그래서 키가
 * 화면 높이의 40% 밑인 사람을 통째로 놓쳤다 — 실측에서 16·24·30px 구간
 * 검출률이 0% 였다.
 *
 * 조각을 다시 64×96 으로 늘려 보면 그 사람이 커진다. 재학습이 필요 없고
 * 값이 크게 달라진다.
 *
 *     키 16px   0.0% → 65.0%
 *     키 24px   0.0% → 80.0%
 *     키 30px   0.0% → 100.0%
 *     키 40px  77.5% →  82.5%
 *
 * 대가는 검출 호출이 조각 수만큼 는다는 것이다. 그래서 **재획득할 때만**
 * 켠다 — 평소 추적은 추적기가 자리를 알고 있어 조각이 필요 없다. */
function slicedOptions(focusBox, prediction) {
  /* 예측이 믿을 만하면 그 자리를 본다. 이전 상자는 마지막으로 **본** 곳이고
   * 예측은 지금 있을 **것 같은** 곳이다 — 가림이 길수록 뒤쪽이 맞다.
   *
   * 그 조각은 kind 가 'accept' 로 적힌다. 나중에 "이 후보가 관측에서
   * 나왔나, 짐작에서 나왔나" 를 구별하기 위해서다. 🔴 이름이 accept 라고
   * 그 후보의 신원이 올라가지는 않는다 — 예측은 거절만 한다. */
  const fromPrediction = prediction && prediction.usable && prediction.box
    && prediction.box.width > 0 && prediction.box.height > 0;
  const box = fromPrediction ? prediction.box : focusBox;
  if (!box || !(box.height > 0)) return { sliced: true, forceSlice: true, maxSlices: 3 };
  return {
    sliced: true,
    forceSlice: true,
    maxSlices: 3,
    focus: { x: box.x, y: box.y, width: box.width, height: box.height },
    focusFromPrediction: Boolean(fromPrediction),
  };
}

const POSE_EVERY_N_MIN = 1;
const POSE_EVERY_N_MAX = 4;
/** 자세 추정이 프레임 예산에서 가져가도 되는 몫. */
const POSE_BUDGET_SHARE = 0.25;
async function loadPoseWeights() {
  try {
    const url = new URL('./hilit-pose-synth-v0.json', import.meta.url);
    const res = await fetch(url);
    if (!res.ok) return null;
    const weights = await res.json();
    return weights?.modelId === POSE_MODEL_ID ? weights : null;
  } catch {
    return null;
  }
}
import { dropNanotrackCaches } from './drop-nanotrack-cache.js';
import { dropNanodetCaches } from './drop-nanodet-cache.js';
if (typeof window !== 'undefined') window.__HILIT_ANCHOR_DRIFT = '0.63';

/* =====================================================================
 * 검출기가 없다 — 2026-09-16
 * =====================================================================
 *
 * NanoDet 을 가중치까지 지웠다(패치노트 0.56). 지금 기본 추적은
 * HilitMotionTracker 다. 자체 검출기는 후보만 모은다. 상자를
 * 자동으로 바꾸지 않는다. 예전 NanoDet 자리는 넷이었다.
 *
 *   1. candidatesAt()   화면의 사람들을 박스로 제안
 *   2. 앵커 분리도       옆 사람들과 비교해 Re-ID 를 믿을지 판정
 *   3. 연관 검사         추적이 옆 사람으로 흘렀는지 주기적으로 확인
 *   4. Lv2 재획득        놓친 대상을 다시 잡기
 *
 * 🔴 **네 자리를 "빈 배열" 하나로 때우지 않았다.**
 *
 * 그렇게 하면 파이프라인은 아무 일 없다는 듯 끝까지 돌고 "추적했다" 를
 * 돌려준다. 그런데 3번이 죽었으므로 그 궤적은 옆 사람으로 흘러가 있어도
 * 아무도 모른다. 고장을 정상으로 보고하는 것이고, 그건 사용자가 그 결과로
 * 영상을 만든 다음에야 드러난다.
 *
 * 그래서 자리마다 다르게 물러난다.
 *
 *   1 → 후보를 만들지 않고 `detectorAvailable:false` 를 함께 돌려준다.
 *       화면은 사용자가 직접 감싸는 길로 보낸다
 *   2 → 분리도를 "못 쟀다" 로 남기고, 그 값에 기대던 판단은 보수적으로
 *   3 → 돌지 않는다. 그래서 어떤 프레임도 `confirmed` 로 올리지 않는다
 *   4 → 후보는 주변→확장→전체로 모은다. 상자는 안 바꾸고 ASK_USER.
 *
 * 결과 전체에 `detector:'absent'` 와 `autoRecovery:'disabled'` 가 찍힌다.
 * 부르는 쪽은 그것을 보고 "확인된 추적" 이라고 말하지 않는다.
 */
const DETECTOR_ABSENT = {
  available: false,
  /** 왜 없나. 화면 문구와 로그가 같은 말을 쓰게 한 곳에서 정한다. */
  reason: 'detector-removed',
  since: '2026-09-16',
};
import {
  State, Cause, TrackingHealth, OcclusionMemory, IdentityMemory,
  SwitchGuard, rankCandidates, jerseyColor, colorSim, classifyFailure,
  rememberRejectedAsOthers, rivalsLookAlike,
  associationIdentityOk, clothingHardVeto, CONFIG_COLOR_STRONG,
} from './tracking.js';

/* 화면이 숨었나(앱을 뒤로 보냈거나 다른 탭). 문서가 없는 환경(시험)에서는 보인다고 본다. */
function pageHidden() {
  if (typeof document === 'undefined') return false;
  if (document.visibilityState === 'hidden') return true;
  /* 앱(WebView)이 「뒤로 갔다」고 알려 준 값 — Android 에서 웹 문서의 visibilitychange 가 늘 오지는 않았다
   * (에뮬레이터 실측, 2026-09-28). lib/tracking-job-bridge.ts 가 앱의 visibility 메시지로 채운다. */
  return typeof window !== 'undefined' && window.__hilitAppBackground === true;
}

export class BrowserPipeline {
  constructor({ weightsBase = 'weights/', onProgress = () => {} } = {}) {
    this.base = weightsBase;
    this.onProgress = onProgress;
    this.models = null;
    this.disposed = false;
    this.cancelOpen = null;
  }

  /** 준비물을 갖춘다.
   *
   * 🔴 이제 **내려받는 모델이 하나도 없다.** 위치 추적기도 외형 서술자도
   *    가중치가 없는 자체 구현이고, 검출기는 2026-09-16 에 지웠다.
   *
   * 그래서 이 함수는 네트워크를 타지 않는다. 남은 일은 예전 모델 파일이
   * 사용자 브라우저 캐시에 남아 있으면 지우는 것뿐이다 — 서버에서 파일을
   * 없애도 캐시는 자기 사본을 계속 내주기 때문이다.
   *
   * `preferWebgpu` 는 받기만 하고 쓰지 않는다. 부르는 쪽을 함께 고치는
   * 대신 여기서 조용히 무시한다 — 다음 자체 모델이 들어오면 다시 쓴다. */
  async loadModels() {
    if (this.models) return this.models;
    await Promise.all([dropNanotrackCaches(), dropNanodetCaches()]);
    this.onProgress({ phase: 'models', message: '준비 중' });
    const [tracker, reid, personDetector] = await Promise.all([
      HilitMotionTracker.load(),
      HilitAppearance.load(),
      HilitPersonDetector.load(),
    ]);
    const poseWeights = await loadPoseWeights();
    if (poseWeights) {
      try { loadPoseRuntime(poseWeights); } catch { /* 관절 없이 간다 */ }
    }
    this.models = { tracker, reid, personDetector, poseRuntime: sharedPoseRuntime() };
    this.onProgress({ phase: 'models', message: '준비 완료' });
    return this.models;
  }

  /** 영상 파일 -> 첫 프레임 + 사람 후보. */
  async openVideo(file) {
    if (this.disposed) throw openAbortError();
    if (!file || !Number.isFinite(file.size) || file.size <= 0) {
      throw new Error('빈 영상 파일은 열 수 없습니다. 다른 영상을 골라 주세요.');
    }
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    video.setAttribute('muted', '');
    video.setAttribute('playsinline', '');

    /* 화면 밖이지만 "그려지는" 상태로 DOM 에 붙인다.
     *
     * requestVideoFrameCallback 은 프레임이 실제로 표시될 때만 불린다.
     * 분리된 엘리먼트나 display:none 이면 표시가 일어나지 않아 콜백이
     * 영영 오지 않는다 — 순차 디코딩이 그대로 멈춘다.
     * 그래서 안 보이게 하되 렌더 트리에는 남긴다. */
    video.style.cssText =
      'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;' +
      'pointer-events:none;z-index:-1;';
    document.body.appendChild(video);
    /* 열리는 동안에도 dispose()가 이 엘리먼트를 찾을 수 있어야 한다.
     * 예전에는 메타데이터를 다 읽은 뒤에야 this.video에 넣었다. React가
     * 화면을 정리하는 순간과 겹치면 dispose()는 아무것도 정리하지 못하고
     * openVideo()는 끝없이 이벤트를 기다릴 수 있었다. */
    this.video = video;
    this.url = url;

    try {
      await new Promise((res, rej) => {
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          video.removeEventListener('loadedmetadata', ready);
          video.removeEventListener('error', failed);
          if (this.cancelOpen === cancel) this.cancelOpen = null;
          if (error) rej(error); else res();
        };
        const ready = () => finish();
        const failed = () => finish(new Error('영상을 열 수 없습니다. MP4(H.264)를 권장합니다.'));
        const cancel = () => finish(openAbortError());
        const timer = setTimeout(() => finish(new Error(
          '영상 정보를 20초 안에 읽지 못했습니다. 파일을 다시 선택하거나 MP4(H.264)로 변환해 주세요.',
        )), 20_000);
        this.cancelOpen = cancel;
        video.addEventListener('loadedmetadata', ready, { once: true });
        video.addEventListener('error', failed, { once: true });
        video.src = url;
        video.load();
      });
      if (this.disposed) throw openAbortError();

      const srcW = video.videoWidth, srcH = video.videoHeight;
      if (!srcW || !srcH) throw new Error('영상 크기를 읽을 수 없습니다.');
      if (!Number.isFinite(video.duration) || video.duration <= 0) {
        throw new Error('영상 재생 시간을 읽을 수 없습니다. 파일이 손상되지 않았는지 확인해 주세요.');
      }

      // 분석용 프록시 크기. 짧은 변을 PROXY_RESOLUTION 으로 맞춘다.
      // Orientation 은 보존한다 — 가로를 세로로 억지로 자르지 않는다.
      const short = Math.min(srcW, srcH);
      const scale = short > CONFIG.PROXY_RESOLUTION ? CONFIG.PROXY_RESOLUTION / short : 1;
      const w = Math.max(2, Math.round(srcW * scale / 2) * 2);
      const h = Math.max(2, Math.round(srcH * scale / 2) * 2);

      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('영상 분석 화면을 만들 수 없습니다. 브라우저를 다시 시작해 주세요.');

      this.ctx = ctx;
      this.meta = {
        srcWidth: srcW, srcHeight: srcH,
        width: w, height: h,
        duration: video.duration,
        scale,
        orientation: srcW >= srcH ? 'landscape' : 'portrait',
        // 브라우저는 컨테이너 fps 를 직접 주지 않는다. 분석 fps 로 샘플링한다.
        analysisFps: CONFIG.PROXY_FPS,
      };
      return this.meta;
    } catch (cause) {
      if (this.video === video) {
        try { video.pause(); video.removeAttribute('src'); video.load(); } catch { /* noop */ }
        if (video.parentNode) video.parentNode.removeChild(video);
        URL.revokeObjectURL(url);
        this.video = null; this.url = null; this.ctx = null; this.meta = null;
      }
      throw cause;
    }
  }

  /* 임의 시각으로 이동해서 한 장 그린다.
   *
   * 랜덤 접근이 필요한 곳에만 쓴다 — 첫 프레임, 스크러버, 사용자 확인.
   * 추적 루프에서는 쓰지 않는다. 프레임마다 seek 하면 디코더가 매번
   * 키프레임으로 되감아서 압도적으로 느리다 (실측: 141프레임 11.4초.
   * 모델 추론은 5초 남짓이고 나머지가 seek 대기였다). */
  /* 임의 시각으로 이동해서 한 장 그린다.
   *
   * 'seeked' 만 기다리면 안 된다. 그 이벤트는 "탐색이 끝났다" 는 뜻이고
   * "그 프레임이 그릴 수 있게 준비됐다" 는 뜻이 아니다. 실측으로 확인한
   * 증상:
   *
   *   - 큰 점프(1.5초 -> 3.0초)에서 drawImage 가 **이전 프레임**을 그렸다.
   *     프레임 해시를 찍어보니 두 시각이 완전히 동일했다.
   *   - 같은 영상을 네 번 추적했더니 확인 지점 일치가 3/6~6/6 으로 튀었다.
   *     분석 시각과 프레임 수는 매번 같았으므로 원인은 프레임 내용이다.
   *
   * requestVideoFrameCallback 은 "이 프레임이 표시됐다" 를 알려주므로
   * 그때까지 기다린다. 없거나 안 오는 브라우저를 위해 rAF 두 번 +
   * 타임아웃으로 떨어진다 — 기다리다 멈추는 것보다 한 장 어긋나는 게 낫다. */
  async seekDraw(t) {
    const v = this.video;
    /* 🔴 화면이 숨은 동안은 seek 하지 않고 기다린다(2026-09-28, Android 에뮬레이터 API 36 실측).
     *
     * 숨은 WebView 에서는 <video> seek 가 끝나지 않는다 — 'seeking' 은 32번 오고 'seeked' 는 0번, readyState 1.
     * 그러면 아래 예비 타이머(1.5초)가 대신 끝내고 **멈춘 옛 프레임**을 그려, 틀린 궤적이 조용히 쌓였다.
     * 숨은 동안은 기다렸다가 돌아오면 그 시각으로 다시 seek 한다. seek 도중에 숨어 버렸으면 그 결과는 버리고
     * 다시 한다. 보이는 동안은 예전과 똑같다(예비 타이머가 끝내도 그린다 — 기다리다 멈추는 것보다 낫다). */
    const target = Math.min(t, Math.max(0, v.duration - 1e-3));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await this._whileHidden();
      /* 시각이 이미 같아도 아직 그릴 프레임이 없으면(readyState < 2) 같은 시각으로 다시 옮긴다(연구 PR #66).
       * 새로 연 영상에서 곧바로 seekDraw(0) 을 부르면 빈 캔버스를 그려, 추적기·외형 기준이 빈 화면에서 시작했다
       * (001744649: 외형 0.5 미만 프레임 0 ↔ 269 — 앞에 후보 검출을 돌렸는지에 따라 갈렸다). */
      const needSeek = Math.abs(v.currentTime - target) > 1e-3 || v.readyState < 2;
      if (!needSeek) break;
      const seeked = await new Promise((res) => {
        let done = false;
        const finish = (ok) => { if (done) return; done = true; v.removeEventListener('seeked', onSeeked); res(ok); };
        const onSeeked = () => finish(true);
        v.addEventListener('seeked', onSeeked);
        setTimeout(() => finish(false), 1500);
        v.currentTime = target;
      });
      if (!pageHidden()) {
        if (seeked || attempt === 0 || v.readyState >= 2) { await this._framePresented(); break; }
      }
      /* 숨은 채로 끝났거나(옛 프레임) 돌아온 뒤에도 준비가 안 됐다 — 보일 때까지 기다렸다 다시 seek 한다. */
    }
    this.ctx.drawImage(v, 0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
    return this.ctx;
  }

  /** 화면이 보일 때까지 기다린다. 보이면 바로 끝난다. */
  _whileHidden() {
    if (!pageHidden()) return Promise.resolve();
    return new Promise((res) => {
      const on = () => {
        if (pageHidden()) return;
        document.removeEventListener('visibilitychange', on);
        if (typeof window !== 'undefined') window.removeEventListener('hilit-app-visibility', on);
        res();
      };
      document.addEventListener('visibilitychange', on);
      if (typeof window !== 'undefined') window.addEventListener('hilit-app-visibility', on);
    });
  }

  /** 새 프레임이 실제로 표시될 때까지 기다린다. */
  _framePresented() {
    const v = this.video;
    /* 🔴 화면이 숨으면(앱을 뒤로 보냈거나 다른 탭) 프레임 표시 신호(rVFC·rAF)가 오지 않고, 타이머는 1초 단위로
     * 늦춰진다 — 기다리면 한 프레임에 1초가 걸린다(2026-09-28 백그라운드 찾기). 숨었을 때는 'seeked' 로 이미
     * 디코딩된 프레임을 바로 그린다. 보이는 동안은 예전과 같다. */
    if (pageHidden()) return Promise.resolve();
    return new Promise((res) => {
      let done = false;
      const finish = () => { if (done) return; done = true; res(); };
      if (typeof v.requestVideoFrameCallback === 'function') {
        v.requestVideoFrameCallback(() => finish());
      } else {
        requestAnimationFrame(() => requestAnimationFrame(finish));
      }
      setTimeout(finish, 45);       // 안 오면 그냥 그린다
    });
  }

  /* ---------- 순차 디코딩 ----------
   *
   * 영상을 재생시켜 두고 화면에 나가는 프레임을 받아쓴다. seek 이 없으니
   * 디코더가 앞으로만 간다.
   *
   * requestVideoFrameCallback 은 "이 프레임이 표시됐다" 를 mediaTime 과 함께
   * 알려준다. 콜백을 한 번에 하나만 등록하므로 분석하는 동안 지나간 프레임은
   * 자연히 건너뛴다 — 그게 곧 backpressure 다.
   *
   * 건너뛰기가 많아지면 추적 연속성이 깨진다. 그래서 재생 속도를 조절한다.
   * 벽시계 시간 = 남은 길이 / 재생속도. */

  get _hasRvfc() {
    return typeof this.video?.requestVideoFrameCallback === 'function';
  }

  /* 다음 표시 프레임을 기다린다.
   *
   * 반드시 시간 제한을 둔다. 재생이 시작되지 않거나 프레임 표시가 멈추면
   * (자동 재생 차단, 백그라운드 탭, 렌더 트리 밖) 콜백이 영영 오지 않아
   * 추적이 그대로 멈춰버린다. 실제로 그렇게 10분을 매달린 적이 있다.
   * 시간이 지나면 null 을 돌려주고, 호출부가 seek 방식으로 되돌아간다. */
  _nextFrame(timeoutMs = 700) {
    const v = this.video;
    return new Promise((res) => {
      let done = false;
      const finish = (val) => { if (!done) { done = true; res(val); } };
      const timer = setTimeout(() => finish(null), timeoutMs);
      const ok = (t) => { clearTimeout(timer); finish(t); };
      if (this._hasRvfc) v.requestVideoFrameCallback((_n, meta) => ok(meta.mediaTime));
      else requestAnimationFrame(() => ok(v.currentTime));
    });
  }

  async _startPlayback(startTime, rate) {
    const v = this.video;
    v.muted = true;                 // 자동 재생 정책을 통과하려면 필요하다
    v.playbackRate = rate;
    if (Math.abs(v.currentTime - startTime) > 1e-3) {
      await new Promise((res) => {
        const done = () => { v.removeEventListener('seeked', done); res(); };
        v.addEventListener('seeked', done);
        v.currentTime = Math.min(startTime, Math.max(0, v.duration - 1e-3));
      });
    }
    try { await v.play(); } catch { /* 막히면 rAF 폴백으로 돈다 */ }
  }

  _stopPlayback() {
    try { this.video.pause(); this.video.playbackRate = 1; } catch { /* noop */ }
  }

  /** 그 시각의 사람 후보. 중복은 이미 병합된 상태로 나온다.
   *
   * firstFrameCandidates 는 0초만 본다. 사용자는 본인이 있는 장면으로
   * 옮긴 뒤 "여기서 나 찾기" 를 누르므로, 지금 프레임을 봐야 한다.
   * 검출·seekDraw 는 이미 있는 것을 그대로 쓴다. */
  async candidatesAt(time = 0) {
    await this.loadModels();
    const t = Math.max(0, Number(time) || 0);
    const ctx = await this.seekDraw(t);
    const det = this.models.personDetector;
    let run;
    try {
      /* 사용자에게 보여 줄 후보. 헛것이 많으면 고르기 어렵다 — F1 최대. */
      run = det.proposeFromCanvas(ctx.canvas, {
        timestamp: t,
        scoreMin: DETECTOR_SCORE_MIN.userFacingProposals,
      });
    } catch {
      return {
        candidates: [],
        detectorAvailable: false,
        detectorReason: 'detector-error',
        detectorOutcome: 'error',
        frame: ctx.canvas.toDataURL('image/jpeg', 0.85),
        time: t,
      };
    }
    const available = run.availability === 'ready';
    const proposalCount = (run.proposals || []).length;
    return {
      candidates: (run.proposals || []).map((p) => ({
        box: { x: p.x, y: p.y, width: p.width, height: p.height },
        score: p.detectorScore,
        source: p.source,
        candidateId: p.candidateId,
      })),
      detectorAvailable: available,
      detectorReason: run.reason,
      detectorOutcome: run.outcome,
      detectorModel: run.modelId,
      detectorQuality: run.qualityStatus,
      detectorElapsedMs: run.elapsedMs,
      detectorScoreKind: 'model-score-not-identity',
      identityState: proposalCount ? 'person_detected' : 'detect_failed',
      appliedToTracker: false,
      frame: ctx.canvas.toDataURL('image/jpeg', 0.85),
      time: t,
    };
  }

  /** 첫 프레임의 사람 후보. 중복은 이미 병합된 상태로 나온다. */
  async firstFrameCandidates() {
    return this.candidatesAt(0);
  }

  /** 본격 추적.
   *
   * box     사용자가 고른 대상 (프록시 좌표계, width/height 또는 w/h)
   * startTime  대상을 고른 시각. 사용자가 처음 프레임에 없을 수 있으므로
   *            0 이 아닐 수 있다.
   * endTime    여기까지만 추적한다. 생략하면 영상 끝까지.
   *
   * endTime 이 왜 필요한가 — AI 컷으로 5분 영상에서 10초를 골라도 추적은
   * 5분 전체를 돌고 있었다. 20fps 로 6,000프레임을 처리하고 그중 200프레임만
   * 쓴다. 모바일에서 "안 돌아간다" 고 느껴지던 원인이 대부분 이것이다.
   * 쓰지 않을 구간을 처리하지 않는 것은 알고리즘을 바꾸는 것이 아니라
   * 범위를 좁히는 것이다 — 같은 프레임에 같은 계산이 그대로 돈다.
   */
  async track(rawBox, options = {}) {
    if (options.engine === 'observation-v1') {
      const { trackObserved } = await import('./observation-tracker.js');
      return trackObserved(this, rawBox, options);
    }
    /* 2026-10-20 기본 경로: 검출 연결 추적(linked-tracker.js). 사람 검출기를 쓸 수 없거나 고른 상자를 검출로
     * 확인하지 못하면 null 이 오고, 그때만 예전 경로(trackLegacy)로 간다. engine:'legacy' 로 예전 경로를 고를 수 있다. */
    if (options.engine !== 'legacy' && typeof options.personProbe === 'function') {
      const { trackLinked } = await import('./linked-tracker.js');
      await this.loadModels();
      const linked = await trackLinked(this, rawBox, options);
      if (linked) return linked;
    }
    return this.trackLegacy(rawBox, options);
  }

  async trackLegacy(rawBox, { nLevel = CONFIG.N_LEVEL, reidThreshold = CONFIG.REID_THRESHOLD,
                       startTime = 0, endTime = null,
                       adaptiveFps = null, targetRatio = 1.0,
                       signal, identityDiag = false,
                       detectorDiagnose = false, detectorReacquire = false,
                       videoId = null, subjectId = null, confirmedViews = [],
                       /* 사용자가 "여긴 내가 없어요"·다시 고르기로 아니라고 한 상자(2026-10-03). [{ time, box }] 분석 캔버스 화소.
                        * 이 영상 안에서만 확정 타인으로 기억한다(confirmed-other-gallery addUserRejected). */
                       rejectedViews = [],
                       identityRecoveryExperiment = false,
                       ownerId = 'anon:local', runId = null,
                       persistAppearance = null, restoreAppearance = null,
                       originalAccessible = true,
                       reidScheduleMode = 'selective',
                       trackerCore = DEFAULT_TRACKER_CORE, sizeLock = null, dcfParams = null,
                       stopOnAsk = false, askRearmSec = 1.5, askNotBefore = null, followThrough = false,
                       /* 추적 중 사람 검출로 상자를 바로잡는다(detection-anchor.js). async (canvas) => [{x,y,width,height,score}] 캔버스 화소. */
                       personProbe = null, anchorOptions = null,
                       /* 3단계 실험. 기본 꺼짐. 화면 밖으로 나간 빈 상자만 묻는다. */
                       absenceEdgeExperiment = EDGE_ABSENCE_EXPERIMENT_DEFAULT,
                       /* 6단계 실험. 기본 꺼짐. 배경에 붙은 상자를 정상으로 두지 않는다. */
                       continuityExperiment = CONTINUITY_EXPERIMENT_DEFAULT,
                       /* 위치 추적기 수치 계산을 어디서 돌릴지(2026-10-12). 'cpu'(기본) | 'gpu'. 아래 coreKind 주석. */
                       computeBackend = 'cpu' } = {}) {
    /* 박스 키 이름을 여기서 한 번 정규화한다.
     *
     * 호출자가 {x,y,w,h} 로 넘기는 일이 실제로 있었다 (Hilit 웹 어댑터).
     * 그러면 box.width 가 undefined 가 되어 추적 전체가 조용히 NaN 이 된다.
     * 예외도 안 나고 화면에는 "평균 건강도 NaN" 만 찍힌다. 계약을 느슨하게
     * 받아주고, 대신 유효하지 않으면 즉시 던진다. */
    const box = {
      x: Number(rawBox?.x),
      y: Number(rawBox?.y),
      width: Number(rawBox?.width ?? rawBox?.w),
      height: Number(rawBox?.height ?? rawBox?.h),
    };
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite)
        || box.width < 1 || box.height < 1) {
      throw new Error(
        `추적 대상 박스가 유효하지 않습니다: ${JSON.stringify(rawBox)} ` +
        '(x, y, width/w, height/h 가 모두 유한한 값이어야 합니다)');
    }

    /* 사용자가 그린 박스를 조금 넓힌다.
     *
     * 사람은 대개 몸에 딱 맞게 그린다. 그러면 팔을 뻗거나 몸을 틀 때
     * 템플릿 밖으로 나가는 부분이 생겨 유사도가 떨어진다.
     *
     * 더 중요한 건 탐색 영역이다. 자체 추적기도 박스에 비례해 주변을
     * 본다. 박스가 커지면 한 프레임에 대상이 이동할 수 있는 범위도 커진다.
     *
     * 어댑터가 아니라 여기서 한다. 그래야 어느 경로로 들어와도 같은
     * 동작이고, 나중에 다른 플랫폼에 이식할 때도 함께 따라간다.
     *
     * 너무 키우면 배경이 템플릿을 오염시켜 반대로 나빠진다. 15% 는
     * 사람 몸 주변의 여유 정도이고 배경을 크게 끌어들이지 않는다. */
    {
      const padX = box.width * CONFIG_TARGET_PAD / 2;
      const padY = box.height * CONFIG_TARGET_PAD / 2;
      box.x = Math.max(0, box.x - padX);
      box.y = Math.max(0, box.y - padY);
      box.width = Math.min(box.width * (1 + CONFIG_TARGET_PAD), this.meta.width - box.x);
      box.height = Math.min(box.height * (1 + CONFIG_TARGET_PAD), this.meta.height - box.y);
    }

    await this.loadModels();
    const { reid, personDetector } = this.models;
    /* 위치 추적 코어. 상관필터 코어는 호출마다 새로 만든다 — 모델 상태가
     * 대상마다 다르다. 둘 다 같은 모양(init·update·reposition·refreshTemplate)이다. */
    const coreKind = resolveTrackerCore(trackerCore);
    /* computeBackend: 'gpu' 면 상관필터의 수치 계산을 GPU(WebGPU)로 돌린다(hilit-dcf-gpu-tracker.js, 2026-10-12).
     * 판단 규칙은 같은 정본이고 계산만 32비트 GPU 로 옮긴 것이라, 결과는 CPU 판과 아주 가깝지만 같지는 않다.
     * GPU 를 쓸 수 없으면 조용히 CPU 판으로 돌아가고, 무엇을 썼는지는 metrics.computeBackend 에 남긴다. */
    const gpuCompute = { requested: computeBackend === 'gpu', used: false, reason: null, adapter: null };
    let tracker = coreKind === 'dcf' ? null : this.models.tracker;
    if (coreKind === 'dcf' && gpuCompute.requested) {
      try {
        const got = await HilitDcfGpuTracker.create(dcfParams ?? {});
        if (got.tracker) { tracker = got.tracker; gpuCompute.used = true; gpuCompute.adapter = got.adapter; }
        else gpuCompute.reason = got.reason;
      } catch (cause) {
        gpuCompute.reason = `create-failed: ${String(cause?.message ?? cause)}`;
      }
    }
    if (!tracker) tracker = new HilitDcfTracker(dcfParams ?? {});
    const lock = resolveSizeLock(sizeLock, coreKind);
    const m = this.meta;

    /* 분석 프레임률을 기기 속도에 맞춘다.
     *
     * 모델 비용은 기기마다 크게 다르다 (실측, Edge 152 / 8코어):
     *   NanoTrack  29.3 ms/frame     OSNet 165.3 ms/call
     * 저사양 기기나 모바일에서는 이 값이 몇 배가 된다. 고정 20fps 로 두면
     * 7초 영상에 20초 넘게 걸리는 일이 생긴다.
     *
     * 그래서 첫 몇 프레임으로 실제 처리 속도를 재고, "분석이 영상 길이의
     * targetRatio 배 안에 끝나도록" 프레임률을 낮춘다. 빠진 프레임은
     * 궤적 선형 보간으로 메운다 — 20fps 간격(50ms)에서 사람의 이동은
     * 선형에 가깝다.
     *
     * 낮출 때 Re-ID 간격도 같이 줄여 **시간 간격을 유지한다.**
     * 프레임 단위로만 두면 12fps 에서 Re-ID 가 1.67초에 한 번이 되어
     * 농구처럼 빠른 장면에서 신원 확인이 늦어진다. */
    let analysisFps = adaptiveFps ?? m.analysisFps;
    const dtOf = (fps) => 1 / fps;
    let dt = dtOf(analysisFps);
    const reidSecondsNormal = CONFIG.REID_INTERVAL_NORMAL / m.analysisFps;
    const anchorTime = Math.max(0, Math.min(startTime, Math.max(0, m.duration - dt)));
    /* 추적을 멈출 시각. 앵커보다 앞이면 무시한다 — 잘못 들어온 값 때문에
     * 앵커 한 장만 남기고 끝나는 것이 더 나쁘다. */
    const requestedEnd = Number(endTime);
    const stopTime = Number.isFinite(requestedEnd) && requestedEnd > anchorTime + dt
      ? Math.min(m.duration, requestedEnd)
      : m.duration;
    /* 돌 프레임 수.
     *
     * analysisFps 로 센다. m.analysisFps(원래 20)로 세면 안 된다 —
     * 아래에서 기기 속도에 맞춰 fps 를 낮추면 한 프레임이 덮는 시간이
     * 늘어나 실제로 도는 프레임 수가 줄어드는데, 이 값은 그대로 남는다.
     *
     * 그러면 진행률이 끝까지 차지 않는다. 107초 영상을 20fps 기준
     * 2140프레임으로 잡고 12fps 로 내려가면 1284프레임에서 영상이 끝나고,
     * 화면에는 **58% 에서 멈춘 뒤 다음 단계로 넘어간다.** 추적은 끝까지
     * 돌았는데 사용자에게는 "되다가 만다" 로 보인다 — 실측으로 확인했다
     * (1283 좌표 / 107초 = 12.0fps, 진행률 58%).
     *
     * let 으로 두고 fps 가 바뀔 때 함께 고친다. 이 값은 반복 상한이기도
     * 하므로 dt 와 어긋나면 범위 자체가 틀어진다. */
    let total = Math.max(1, Math.floor((stopTime - anchorTime) * analysisFps));
    const diag = Math.sqrt(m.width ** 2 + m.height ** 2);

    const health = new TrackingHealth(reidThreshold);
    const occl = new OcclusionMemory();
    const anchors = new IdentityMemory();
    const guard = new SwitchGuard();

    // 앵커 프레임. 사용자가 직접 고른 시각이므로 confirmedByUser 다.
    /* seek 직후 한 장은 이전 프레임일 수 있다(seekDraw 주석). 그래서
     * 같은 시각을 두 번 그린 다음 그 캔버스로 추적기를 연다. 첫 장으로
     * init 하면 빈 화면을 참조로 붙잡고 pointsUsed 0 이 영구히 간다. */
    let ctx = await this.seekDraw(anchorTime);
    ctx = await this.seekDraw(anchorTime);
    await tracker.init(ctx, box, anchorTime);
    let anchorEmb = await reid.embed(ctx, box);
    if (!anchorEmb) {
      ctx = await this.seekDraw(anchorTime);
      anchorEmb = await reid.embed(ctx, box);
    }
    anchors.add(anchorEmb, jerseyColor(ctx, box), { confirmedByUser: true });

    /* 확정 타인 갤러리 — 사용자가 자기를 감싼 **그 프레임**에서 만든다.
     *
     * 추적은 늘 같은 방식으로 시작한다. 사용자가 한 장면에서 자기 상자를
     * 직접 그린다. 그 순간 같은 프레임의 다른 사람 상자는 사용자가 아니다.
     * 사람은 같은 시각에 두 자리에 있을 수 없으므로 추론이 아니라 사실이고,
     * 사용자에게 더 물어볼 것도 없다.
     *
     * 그동안 이 갤러리는 비어 있었다 — "이 사람은 내가 아니다" 를 하나도
     * 모르는 상태다. 비어 있으면 판단이 늘 절대값 비교가 되어, 자세가
     * 바뀐 진짜 대상과 옆 사람이 같은 점수대에 겹친다. */
    const confirmedOthers = createConfirmedOtherGallery({
      videoId: videoId ?? 'session-video',
      projectId: subjectId ?? 'session',
      anchorTSec: anchorTime,
      userBox: { ...box },
    });
    let anchorOtherRun = null;
    try {
      /* 갤러리는 정밀도 우선이다. 배경 조각을 "나 아님" 으로 외우면
       * 나중에 진짜 사용자가 그 조각과 닮았다는 이유로 거절당한다. */
      anchorOtherRun = personDetector
        ? personDetector.proposeFromCanvas(ctx.canvas, {
          timestamp: anchorTime,
          scoreMin: DETECTOR_SCORE_MIN.confirmedOtherGallery,
        })
        : null;
    } catch { anchorOtherRun = null; }
    {
      const anchorProposals = [];
      for (const proposal of (anchorOtherRun?.proposals || [])) {
        const pbox = {
          x: proposal.x, y: proposal.y, width: proposal.width, height: proposal.height,
        };
        if (!(pbox.width > 0) || !(pbox.height > 0)) continue;
        /* 사용자 상자와 겹치면 임베딩을 뽑기 전에 버린다 — 사용자
         * 자신을 타인으로 외우는 것이 이 갤러리의 유일한 치명상이다. */
        if (galleryIoU(pbox, box) > CONFIRMED_OTHER_POLICY.maxIoUWithUser) continue;
        let otherEmb = null;
        try { otherEmb = await reid.embed(ctx, pbox); } catch { otherEmb = null; }
        anchorProposals.push({
          id: String(proposal.candidateId ?? ('anchor-other-' + anchorProposals.length)),
          box: pbox,
          quality: otherEmb?.identityDescriptor?.quality?.score ?? null,
          descriptor: otherEmb?.identityDescriptor ?? null,
          embedding: otherEmb ?? null,
        });
      }
      fillFromAnchorFrame(confirmedOthers, anchorProposals, {
        detectorAvailable: anchorOtherRun?.availability === 'ready',
      });
      for (const entry of confirmedOthers.entries) anchors.addDistractor(entry.embedding);
    }
    /* 사용자가 직접 아니라고 한 상자 — 검출기가 없어도 넣는다(사용자 답이 근거). 최대 6개, 영상 길이 안의 것만. */
    let userRejectedAdded = 0;
    for (const [i, rej] of (Array.isArray(rejectedViews) ? rejectedViews.slice(-6) : []).entries()) {
      const rb = rej?.box;
      if (!Number.isFinite(rej?.time) || rej.time < 0 || rej.time >= m.duration) continue;
      if (!rb || ![rb.x, rb.y, rb.width, rb.height].every(Number.isFinite) || rb.width <= 1 || rb.height <= 1) continue;
      try {
        const rejCtx = await this.seekDraw(rej.time);
        const rejEmb = await reid.embed(rejCtx, rb);
        const added = addUserRejected(confirmedOthers, {
          id: 'user-rejected-' + i, box: { ...rb }, tSec: rej.time,
          quality: rejEmb?.identityDescriptor?.quality?.score ?? null,
          descriptor: rejEmb?.identityDescriptor ?? null, embedding: rejEmb ?? null,
        });
        if (added && rejEmb) { anchors.addDistractor(rejEmb); userRejectedAdded += 1; }
      } catch { /* 그 장면을 못 읽으면 넣지 않는다 */ }
    }
    if (userRejectedAdded) ctx = await this.seekDraw(anchorTime);
    // Session-local memory. View orientation is unknown until explicitly labelled.
    const reentryMemory = new MultiViewReid();
    const appearanceGallery = new AppearanceGallery({
      ownerId: ownerId || 'anon:local',
      videoId: videoId || 'unknown-video',
      subjectId: subjectId || 'manual-box',
      runId: runId || ('run:' + Date.now().toString(36)),
    });
    if (typeof persistAppearance !== 'function') appearanceGallery.setPersistMode('ram-only');
    let appearanceRecoveryKind = 'missing';
    if (typeof restoreAppearance === 'function') {
      try {
        const rec = await restoreAppearance({ originalAccessible: originalAccessible !== false });
        if (rec && rec.kind) appearanceRecoveryKind = rec.kind;
        if (rec?.kind === 'feature-reuse' && rec.snapshot) {
          appearanceGallery.hydrateFromCheckpoint(rec.snapshot);
        }
        if (rec?.kind === 'ram-only' || rec?.persistAvailable === false) {
          appearanceGallery.setPersistMode('ram-only');
        }
      } catch {
        appearanceGallery.setPersistMode('ram-only');
        appearanceRecoveryKind = 'ram-only';
      }
    }
    let persistInFlight = false;
    let persistQueued = false;
    const requestAppearanceCheckpoint = (force) => {
      if (typeof persistAppearance !== 'function') return;
      if (appearanceGallery.persist === 'ram-only') return;
      const now = performance.now();
      if (!appearanceGallery.checkpointDue(now, force === true)) return;
      if (persistInFlight) { persistQueued = true; return; }
      persistInFlight = true;
      const snap = appearanceGallery.checkpointSnapshot();
      appearanceGallery.consumeDirty(now);
      const tSave = performance.now();
      Promise.resolve(persistAppearance(snap)).then((res) => {
        persistInFlight = false;
        appearanceGallery.recordSaveLatency(performance.now() - tSave, snap.estimatedBytes);
        if (res && res.ok === false) appearanceGallery.markPersistFailed();
        if (persistQueued) { persistQueued = false; requestAppearanceCheckpoint(true); }
      }).catch(() => {
        persistInFlight = false;
        appearanceGallery.markPersistFailed();
      });
    };
    const candidateTracklets = [];
    const identityHypotheses = new IdentityHypothesisTracker();
    /* 추적 영역 예측 — 사용자가 고른 대상 하나의 위치·크기·가시성만
     * 시간축으로 내다본다. 누구인지는 만들지 않는다.
     *
     * 🔴 지금은 **기록만 한다.** 여기서 나온 상자로 제품 궤적을 바꾸지
     *    않는다. 실사 영상으로 예측 오차를 재기 전에 화면을 맡기면,
     *    틀린 예측이 사용자에게 그대로 보인다. 먼저 재고 나서 연다. */
    let poseEveryN = POSE_EVERY_N_MIN;
    const poseMs = [];
    let posePeakMs = 0;
    const regionPredictor = new TrackRegionPredictor();
    regionPredictor.start(box, anchorTime);
    let lastRegionPrediction = null;
    const reverseGrayBuf = [];
    const forwardBoxAt = [];
    const identityMemoryDescs = anchorEmb?.identityDescriptor ? [anchorEmb.identityDescriptor] : [];
    if (anchorEmb?.identityDescriptor?.color) {
      appearanceGallery.rememberUserAnchor({
        tSec: anchorTime,
        trackId: 'subject',
        quality: anchorEmb.identityDescriptor.quality?.score ?? 0.9,
        visibility: [true, true, true],
        view: 'unknown',
        box,
        overlapOthers: false,
        cameraOk: true,
        gmcOk: true,
        descriptor: anchorEmb.identityDescriptor.color,
      });
    }
    if (anchorEmb?.partObservation) reentryMemory.remember(anchorEmb.partObservation, true);
    // Caller supplies explicit user selections in analysis-canvas pixel coordinates.
    // Never infer front/side/back from a moving rectangle.
    for (const selected of (Array.isArray(confirmedViews) ? confirmedViews.slice(0, 12) : [])) {
      if (selected?.userConfirmed !== true || !Number.isFinite(selected.time)
        || selected.time < 0 || selected.time >= m.duration
        || !['front','side','back','unknown'].includes(selected.view)) continue;
      const b = selected.box;
      if (!b || ![b.x,b.y,b.width,b.height].every(Number.isFinite) || b.width <= 0 || b.height <= 0) continue;
      try {
        const selectedCtx = await this.seekDraw(selected.time);
        const selectedEmb = await reid.embed(selectedCtx, b);
        if (selectedEmb?.partObservation) reentryMemory.remember({ ...selectedEmb.partObservation, view:selected.view }, true);
        if (selectedEmb?.identityDescriptor) identityMemoryDescs.push(selectedEmb.identityDescriptor);
        if (selectedEmb?.identityDescriptor?.color) {
          appearanceGallery.rememberUserAnchor({
            tSec: selected.time,
            trackId: 'subject',
            quality: selectedEmb.identityDescriptor.quality?.score ?? 0.9,
            visibility: [true, true, true],
            view: selected.view,
            box: b,
            overlapOthers: false,
            cameraOk: true,
            gmcOk: true,
            descriptor: selectedEmb.identityDescriptor.color,
          });
        }
      } catch { /* Invalid or unavailable views do not enter identity memory. */ }
    }
    ctx = await this.seekDraw(anchorTime);
    let driftAttempts = 0;
    let driftNullEmbeds = 0;
    /* 바로 묻기 무장 전이라 얼리지 않고 넘긴 외형 어긋남 수(진단용). */
    let driftIgnoredBeforeArm = 0;
    let driftLastSelf = null;
    let driftLastMatch = null;

    const trajectory = [{ frame: 0, t: anchorTime, box: { ...box }, state: State.OK,
                          health: 1, reid: 1, confidence: 1 }];
    const events = [];
    const reviews = [];      // Lv4 — 사용자에게 물어볼 구간
    let prevBox = { ...box };
    let reidCalls = 0, detectorCalls = 0, reacquireTried = 0, reacquireOk = 0;
    let detectorReacquireTried = 0;
    const anchorCfg = { ...DETECTION_ANCHOR, ...(anchorOptions || {}) };
    let lastAnchorT = Number.NaN, anchorProbes = 0, anchorCorrections = 0, anchorAsks = 0;
    let anchorMiss = { run: 0, seen: 0 };
    /* 가로지름 확인(detection-anchor.js crossingConflict) — 받아들인 사람 자리 최근 셋 · 걸린 횟수 · 묻기 사유. */
    const anchorTrail = [];
    let anchorCrossings = 0, anchorCrossHolds = 0;
    let anchorAskCause = null;
    let edgeAbsence = { run: 0 };
    let edgeAbsenceAsks = 0;
    let continuityStick = { run: 0 };
    let continuityAsks = 0;
    let suspendTemplateLearn = false;
    const anchorReasons = {};
    const anchorLog = [];
    let lastDetectorRun = null;
    let lastPersonNetDiagnose = buildPersonNetDiagnoseResult({
      mode: 'diagnose',
      weightsPresent: false,
      reason: 'personnet-weights-not-shipped-in-browser',
    });
    let lastDetectorObservationTrust = detectorObservationTrust({
      connected: false,
      weightsPresent: false,
      claimedPersonDetection: false,
      cropValid: false,
    });
    const causes = {};

    /* --- 외형이 이 영상에서 쓸 만한가 --------------------------------
     *
     * Re-ID 를 무조건 믿으면 안 된다. 화면에 있는 다른 사람들이 앵커와
     * 비슷한 점수를 받으면 그 신호는 정보가 아니라 잡음이다.
     *
     * 그래서 앵커 프레임에서 다른 사람들과의 유사도를 직접 재본다.
     * 실측(아이스링크 영상): 낯선 사람 8명이 0.52~0.64. 임계값 0.6 이라
     * 절반이 통과한다 -> 구분력 없음.
     * 반면 농구 영상에서는 대상 0.85 대 다른 사람 0.6 근처로 벌어진다.
     *
     * 구분력이 없다고 판단되면 후보를 고를 때 Re-ID 를 쓰지 않고 운동
     * 연속성만 쓴다. 근거 없는 신호로 고르는 것이 안 쓰는 것보다 나쁘다. */
    let appearanceWeak = false;
    /* 외형이 거짓말을 하기 시작한 시각. null 이면 끝까지 쓸 만했다.
     *
     * 앵커에서 한 번 재고 끝내면 "처음에는 가르던 신호" 가 나중에 못
     * 가르게 되는 것을 못 본다. 실측에서 정확히 그랬다 — 17초 뒤 진짜
     * 대상이 0.470, 낯선 사람 최고값이 0.671 이었다. */
    let appearanceWentWeakAt = null;
    let appearanceLieRun = 0;
    /* 사용자 앵커와 지금 상자의 외형이 보류/거절인 연속 횟수.
     * 검출기·낯선사람 갤러리가 없어도, 배경으로 잠긴 추적을 맞는 것처럼
     * 이어 가지 않기 위해 쓴다. 다른 상자로 옮기지 않는다. */
    let anchorDriftRun = 0;
    let framesSinceDrift = 0;
    let appearanceAskedAt = null;
    let frozenAskBox = null;
    /* 헷갈리면 그 자리에서 멈추고 묻기(stopOnAsk, 2026-09-28 사용자 요청).
     *
     * 예전에는 외형이 어긋나 「사용자 확인」이 필요해진 뒤에도 상자를 그 자리에 얼린 채 영상 끝까지
     * 돌았다 — 그 뒤 프레임은 전부 쓸 수 없는 궤적이었고, 사용자는 추적이 다 끝난 뒤에야 물음을 받았다.
     * stopOnAsk 면 (1) 외형 어긋남으로 확인이 필요해진 순간, 또는 (2) 사용자 확인 상태가
     * STOP_ASK_SECONDS 이상 이어진 순간 멈추고 그 시각을 돌려준다. 편집기가 바로 묻고, 사용자가
     * 고른 상자로 그 시각부터 다시 추적한다. 끄면(기본) 예전과 같다. */
    const STOP_ASK_SECONDS = 1.0;
    /* 🔴 다시 묻기 전에 **한 번은 확실히 잡혀 있어야** 한다(2026-09-28 사용자 요청: 「너무 촘촘하게, 같은 지점을
     * 다시 묻는 느낌」). 사용자가 고른 직후의 몇 프레임은 추적기가 아직 자리를 잡는 중이라 확인 상태가 잠깐 이어지기
     * 쉽다 — 예전에는 그 0.2초 뒤에 또 멈춰 방금 답한 자리를 다시 물었다. 이제 이 추적(시작 시각부터)에서 상태 정상이
     * askRearmSec 이상 **이어진 뒤에야** 멈춤 판정을 켠다(무장). 한 번도 무장하지 못하고 끝까지 가면 멈추지 않고,
     * 그 구간은 끝난 뒤 확인 단계(askableGaps)가 한 번에 모아 묻는다. */
    let askArmedAt = null;
    let askOkSince = null;
    let askRunStart = null;
    let stoppedForAsk = null;
    let lastReidSim = 1;
    /* 자기 유사도가 남보다 낮아져 복구를 부른 횟수. "지금 잡고 있는 것이
     * 대상이 아니다" 경보가 몇 번 울렸는지다. */
    let switchAlarms = 0;
    /* 각도 앵커를 추가한 횟수. 턴·회전을 몇 번 "같은 사람" 으로
     * 알아봤는지다. */
    let viewAdds = 0;
    /* 제자리에 있던 대상이 갑자기 움직여 즉시 확인한 횟수. */
    let surpriseChecks = 0;
    /* 마지막 확인 자리를 검색 중심으로 쓴 횟수. */
    let confirmedAnchorUses = 0;
    /* 확인 자리를 믿는 기한(초). 이보다 오래되면 대상이 정말 이동했을 수
     * 있으므로 필터 예측으로 돌아간다. */
    const CONFIRMED_ANCHOR_SECONDS = 3;
    /* 제자리였던 사람이 한 걸음에 이만큼(몸 너비 배수) 움직이면 확인한다.
     * 0.4 는 실측에서 가림꾼이 끌고 간 속도(0.75몸)의 절반이다 —
     * 진짜로 출발하는 사람도 이 값을 넘지만, 넘으면 막는 것이 아니라
     * 재는 것이므로 대가가 거의 없다(외형 측정 1회). */
    const SURPRISE_BODIES = 0.4;
    /* 진짜 대상이 낯선 사람 최고값보다 이만큼 위에 있어야 "가른다" 로 본다. */
    const APPEARANCE_LIE_MARGIN = 0.02;
    /* 한 번으로 뒤집지 않는다 — 자세가 잠깐 틀어져도 한 프레임은 낮다. */
    const APPEARANCE_LIE_RUN = 3;
    let strangerBest = null;
    let selfMin = null;
    let separabilityError = null;
    let strangerColorBest = null;
    const anchorColor = jerseyColor(ctx, box);

    /* 🔴 외형 분리도를 잴 수 없다 — 2026-09-16
     *
     * 여기서 앵커 프레임의 **낯선 사람들**과 대상을 비교해, 이 영상에서
     * 외형 신호(옷 색·서술자)로 사람을 가를 수 있는지를 쟀다. 그 비교에는
     * 화면의 다른 사람들을 찾아 주는 검출기가 필요하고, 지금은 없다.
     *
     * 그래서 `strangerBest`·`selfMin`·`strangerColorBest` 는 전부 null 로
     * 남는다. **0 이나 1 같은 그럴듯한 값을 채워 넣지 않는다** — 그러면
     * 아래 판단들이 재 본 적 없는 숫자를 근거로 삼는다.
     *
     * 대신 `appearanceWeak` 를 **켠 채로** 시작한다. 이건 비관이 아니라
     * 사실이다. 외형이 사람을 가른다는 증거가 하나도 없는 상태이므로,
     * 그 신호로 사람을 고르면 안 된다. 켜 두면 파이프라인은 위치 연속성에
     * 기대고 애매할 때 사용자에게 묻는다 — 지금 상태에서 맞는 태도다.
     *
     * 낯선 사람 갤러리(anchors.addDistractor)도 비어 있다. 즉 "이 사람은
     * 내가 아니다" 라고 미리 배운 것이 없다. */
    /* 🟢 2026-09-21 — 앵커 프레임 확정 타인 갤러리로 분리도를 잰다.
     *
     * 예전 주석은 "검출기가 없어 못 잰다" 였다. 지금은 앵커 프레임에서
     * 사용자가 아닌 상자들을 모아 두므로, 이 영상에서 외형 신호가 사람을
     * 가르는지 실제로 비교할 수 있다.
     *
     * 다만 잰 결과로 appearanceWeak 를 끄지는 않는다. 자체 검출기가
     * 아직 합성 막대로만 학습돼 실사 후보 수율이 검증되지 않았고,
     * 못 미더운 상자로 잰 분리도를 믿고 외형으로 사람을 고르면 그게
     * 바로 강제 매칭이다. 값은 남기고 판단은 보수적으로 둔다. */
    if (confirmedOthers.entries.length && anchorEmb) {
      let best = null;
      let colorBest = null;
      for (const entry of confirmedOthers.entries) {
        const v = anchors.scoreSelf(entry.embedding);
        if (v !== null && (best === null || v > best)) best = v;
        const c = entry.box ? colorSim(anchorColor, jerseyColor(ctx, entry.box)) : null;
        if (c !== null && (colorBest === null || c > colorBest)) colorBest = c;
      }
      strangerBest = best;
      strangerColorBest = colorBest;
      selfMin = anchors.scoreSelf(anchorEmb);
      separabilityError = null;
    } else {
      separabilityError = anchorOtherRun?.availability === 'ready'
        ? 'no-confirmed-other-in-anchor-frame'
        : DETECTOR_ABSENT.reason;
    }
    appearanceWeak = true;

    /* 🔴 문구를 바꿨다. 예전에는 "옷·체형이 비슷한 분이 많아" 였는데,
     *    그건 실제로 재 봤을 때 할 수 있는 말이다. 지금은 재지 못했으므로
     *    같은 말을 하면 거짓이 된다. 사용자에게는 **우리가 무엇을 못 하는지**
     *    를 말한다. */
    this.onProgress({ phase: 'track', frame: 0, total: 1, percent: 0,
      message: '자동으로 다시 찾는 기능이 꺼져 있습니다. 놓치면 직접 다시 지정해 주세요' });

    const t0 = performance.now();

    /* 순차 디코딩 준비. 여기서 seek 은 딱 한 번이다. */
    let rate = 1.0;
    let seen = 0, skipped = 0, lastT = anchorTime;
    /* 순차 디코딩(재생 + requestVideoFrameCallback)은 기본으로 끈다.
     *
     * 프레임마다 seek 하는 게 느릴 거라 가정하고 만들었는데, 실측이
     * 그 가정을 뒤집었다 (Edge 152 / 720x334 / 8코어):
     *
     *   seek 1회            16.4 ms
     *   rVFC 프레임 간격     45.0 ms   <- 영상 고유 속도(23.72fps)에 묶인다
     *
     * 재생 속도를 3배로 올려야 겨우 seek 과 비슷해진다. 대신 프레임을
     * 건너뛰어 추적 연속성이 깨진다. 이득이 없다.
     *
     * 진짜 병목은 디코딩이 아니라 모델이었다.
     *   NanoTrack  29.3 ms/frame
     *   OSNet     165.3 ms/call  (4스레드. 단일 스레드일 때는 277 ms)
     *   NanoDet    93.3 ms/call
     *
     * 코드는 남겨둔다 — 모바일은 seek 비용이 훨씬 클 수 있어서 기기별로
     * 다시 재봐야 한다. HILIT_SEQUENTIAL_DECODE 로 켤 수 있다. */
    const camera = CONFIG.CAMERA_MOTION_COMPENSATION ? new CameraMotion() : null;
    let cameraDrift = { dx: 0, dy: 0, confidence: 0, affine: null, usable: false };
    const tracklets = new TrackletGraph();
    const jerseyLock = new JerseyLock();
    let jerseyLockedOnce = false;
    let teamSelf = null;
    let lastFoot = null;
    const applyCameraBox = (box) => {
      if (!box || !cameraDrift) return box;
      if (cameraDrift.affine && cameraDrift.usable !== false && cameraDrift.confidence > 0) {
        return applyAffineToBox(box, cameraDrift.affine);
      }
      if (cameraDrift.confidence > 0) {
        return { ...box, x: box.x + (cameraDrift.dx || 0), y: box.y + (cameraDrift.dy || 0) };
      }
      return box;
    };
    let templateGap = 1e9;    // 마지막 템플릿 갱신 이후 지난 프레임
    let templateRefreshes = 0;
    /* 템플릿 갱신 조건. 자세히는 아래 갱신 지점의 설명 참조. */
    const TEMPLATE_MIN_GAP = 30;
    const TEMPLATE_MIN_CONF = 0.90;
    const TEMPLATE_REID_MARGIN = 0.12;
    let assocGap = 1e9;       // 마지막 연결 검증 이후 지난 프레임
    let switchStreak = 0;     // 사람 위가 아닌 프레임이 몇 번 이어졌나
    let assocChecks = 0, assocFixes = 0, assocAmbiguous = 0;
    /* 정상 추적 중에도 주기적으로 화면 전체를 본다.
     *
     * NanoTrack 은 "template 과 비슷한 것" 을 찾는다. 누구인지는 모른다.
     * 두 사람이 겹쳤다 갈라지면 옆 사람을 잡고도 confidence 를 높게 준다.
     * 그 상태로 Re-ID 주기(20프레임)를 기다리면 이미 늦다 — 교차는
     * 10~20프레임이면 끝난다.
     *
     * 그래서 검출을 주기적으로 돌려 "지금 잡고 있는 게 실제 사람 위인가,
     * 그리고 그 사람이 나인가" 를 확인한다. 15프레임이면 20fps 기준
     * 0.75초마다다. NanoDet 93ms 를 15로 나누면 프레임당 6ms 정도다. */
    /* 실측으로 15프레임은 너무 드물다는 게 드러났다.
     *
     * 사용자 영상(아이스링크, 17.8초, 사람 9명)에서 대상은 1초 안에
     * 놓쳤는데 NanoTrack conf 는 1.0 이었다. 15프레임 간격이면 이미
     * 다른 사람 위에 안착한 뒤에 확인하게 된다.
     *
     * 3프레임으로 줄인다. NanoDet 93ms / 3 = 프레임당 31ms 추가.
     * 12fps 분석에서 0.25초마다 화면 전체를 다시 본다. */
    /* 1등과 2등 후보의 거리 차이가 반경의 이 비율을 넘으면 위치로 결정한다.
     * 그만큼 벌어졌으면 외형을 물어볼 이유가 없다. */
    const POSITION_CLEAR_SHARE = 0.35;

    const ASSOC_INTERVAL = 3;
    const ASSOC_MIN_IOU = 0.25;
    const ASSOC_CONFIDENT_IOU = 0.55;

    /* --- 검출 기반 추적 (SORT 방식) --------------------------------
     *
     * 이 영상에서 무엇이 안 되는지 하나씩 측정해서 얻은 구조다.
     *
     * 1) Re-ID 를 못 믿는다
     *    앵커 프레임에서 낯선 사람 최고 유사도 0.715 (임계값 0.6).
     *    아이스링크에서 모두 검은 레깅스에 헬멧을 쓰고, 사람 크기가
     *    55~130px 이고, 흰 얼음 위에 모션 블러가 있으면 임베딩이
     *    무너진다. OSNet 은 보행자 데이터셋(Market-1501)으로 학습됐고
     *    이 화면은 학습 분포 밖이다.
     *
     * 2) NanoTrack 도 못 믿는다
     *    t=1초에 추적기는 cx=0.493 을 conf 0.941 로 가리켰지만 대상은
     *    0.583 에 있었다. 115px 을 자신 있게 틀렸다. template 매칭은
     *    "비슷한 것" 을 찾고, 흰 얼음 위 작은 사람은 주변 무늬와
     *    구분되지 않는다.
     *
     * 3) 옷 색도 결정에 쓰기엔 흔들린다
     *    후보 간 상대 비교로 가중 0.6 을 줬더니 맞는 지점이 4개에서
     *    2개로 줄었다. 팔을 벌리거나 몸을 돌리면 상의 히스토그램이
     *    크게 변한다.
     *
     * 남는 것은 **검출기 + 운동 연속성**이다. 사람은 한 프레임에 링크를
     * 가로지르지 못한다. 조명·옷·자세와 무관하게 성립하는 제약이다.
     *
     * 그래서 등속 칼만 필터를 둔다. 매 프레임 예측하고, 검출이 오면
     * 보정한다. 보정이 있으니 예측이 멀리 흘러가지 않는다 — 앞서
     * 직접 만든 속도 EMA 는 보정이 없어서 방향 전환 순간에 51px 을
     * 앞질러 갔고, 그것 때문에 우측 사람을 골랐다.
     *
     * SORT (Bewley et al. 2016) 가 쓰는 것과 같은 구조다. 외형 없이
     * 위치·속도만으로 다중 객체를 추적하는 방법이고, 지금 상황처럼
     * 외형이 무너진 화면에 정확히 맞는다. */
    const kf = {
      x: box.x + box.width / 2, y: box.y + box.height / 2,
      vx: 0, vy: 0,
      w: box.width, h: box.height,
      since: 0,            // 마지막 검출 보정 이후 지난 프레임
      misses: 0,           // 게이트를 통과한 검출이 없던 연속 검사 횟수
    };
    /* 보정 이득. 1.0 이면 검출을 그대로 믿고(잡음까지), 0 이면 무시한다.
     * 검출 박스는 프레임마다 조금씩 흔들리므로 0.7 로 둔다. */
    const KF_POS_GAIN = 0.7;
    /* 속도 이득은 낮게 둔다. 높으면 검출 잡음이 속도로 증폭돼 예측이
     * 튀고, 그게 앞서 우측 사람을 고른 원인이었다. */
    const KF_VEL_GAIN = 0.25;
    /* 크기는 더 천천히 따라간다 — 자세에 따라 검출 박스 높이가 크게 변한다. */
    const KF_SIZE_GAIN = 0.3;
    /* 속도 상한(프레임당 픽셀, 박스 긴 변 기준 비율).
     * 실측 최대 9px/frame. 상한이 없으면 한 번의 오연관이 속도를 오염시켜
     * 다음 예측을 멀리 보내고, 그게 연쇄된다. */
    const KF_MAX_SPEED_SHARE = 0.12;

    /** 이번 검사에서 검출을 붙일 수 있는 반경. */
    const gateRadius = () => {
      const dim = Math.max(8, Math.max(kf.w, kf.h));
      /* 고정분: 검출 박스와 필터 위치의 상시 어긋남.
       * 증가분: 보정 없이 지난 프레임 수만큼 불확실해진다. */
      return Math.min(GATE_FIXED_SHARE * Math.max(8, kf.w) + GATE_GROW * dim * kf.since,
                      GATE_MAX_SHARE * Math.max(8, kf.w));
    };
    const GATE_FIXED_SHARE = 0.70;
    const GATE_GROW = 0.10;

    /** 분석 프레임 크기. 경계 판정이 전부 이걸 기준으로 돈다. */
    const FRAME = { width: m.width, height: m.height };

    /* 최근 **확인된** 중심들. "제자리에 있는가" 를 판단하는 재료다.
     *
     * 예측으로만 흘러간 자리는 넣지 않는다 — 예측은 자기가 만든 값이라,
     * 그것으로 "안 움직였다" 고 판단하면 폭주하는 동안에도 계속
     * "제자리" 라고 말한다. */
    const recentCentres = [];
    const rememberCentre = (b, at) => {
      recentCentres.push({ x: b.x + b.width / 2, y: b.y + b.height / 2, t: at });
      if (recentCentres.length > 8) recentCentres.shift();
    };
    rememberCentre(box, anchorTime);

    /** 지금 대상이 제자리에 있는가. 턴 · 점프가 여기 들어온다. */
    const stationaryNow = () => isStationary(recentCentres, Math.max(8, kf.w));

    /** 대상이 **방금까지** 제자리에 있었나 — 그 근거가 신선한가.
     *
     * 🔴 이 함수가 있어야 하는 이유.
     *
     * `stationaryNow()` 는 "우리가 받아들인 관측들이 한자리에 모여 있다"
     * 를 본다. 놓친 뒤에는 그 기록이 얼어붙으므로, 그것만 보고 "제자리"
     * 라고 하면 우리가 못 찾는 것을 대상이 안 움직이는 것으로 착각한다.
     * 그래서 복구 경로에서는 `kf.since <= 2`(0.17초) 를 붙여 막아 뒀다.
     *
     * 그런데 그 조건이 너무 짧아서 반대 사고가 났다. 실측(겹침 영상 9.5초):
     * 대상이 8초 동안 제자리에 서 있었는데, 놓친 직후 검출 간격 때문에
     * `kf.since` 가 2를 넘어 "제자리 아님" 으로 판정됐다. 그래서 복구
     * 반경이 몸 3.5배까지 넓어지고, 그 안에 있던 **오른쪽 아이들**을
     * 대상으로 받아들였다(cx 0.83 -> 0.95). 그 뒤 32초까지 못 돌아왔다.
     *
     * 올바른 질문은 "지금 제자리인가" 가 아니라 **"방금까지 제자리였고,
     * 그 기록이 신선한가"** 다. 그래서 시간을 본다.
     *
     *   - 마지막으로 받아들인 관측이 1.5초 안쪽이어야 한다(신선함)
     *   - 기록이 0.8초 이상을 덮어야 한다(한두 프레임으로 단정하지 않는다)
     *
     * 이러면 8초 서 있던 사람은 놓친 직후에도 "제자리였다" 로 남고,
     * 원래 달리던 사람은 그렇게 판정되지 않는다.
     */
    const RESTING_FRESH_SECONDS = 1.5;
    const RESTING_SPAN_SECONDS = 0.8;
    const restingRecently = (now) => {
      if (recentCentres.length < 3) return false;
      const last = recentCentres[recentCentres.length - 1];
      const first = recentCentres[0];
      if (now - last.t > RESTING_FRESH_SECONDS) return false;
      if (last.t - first.t < RESTING_SPAN_SECONDS) return false;
      return isStationary(recentCentres, Math.max(8, kf.w));
    };

    /* 화면 밖으로 달아난 것을 몇 번 되돌렸나. 지표로 남긴다 —
     * 이 숫자가 0 이 아니면 어딘가에서 폭주가 시작된 것이다. */
    let escapeClamps = 0;
    let teleportVetoes = 0;
    /* 상자가 한 번에 너무 커지거나 작아지려는 것을 몇 번 되돌렸나. */
    let scaleLimits = 0;
    let bandLimits = 0;
    /* 걸음 상한을 연속으로 몇 번 건드렸나(끌려가는 중인가), 그래서 몇 번
     * 멈춰 섰나. 아래 "끌려가기를 끊는다" 설명 참조. */
    let dragRun = 0;
    let dragHolds = 0;
    /* 알던 자리를 지킨 프레임 수. 아래 "모르는 동안에는" 설명 참조. */
    let restHolds = 0;
    /* 🔴 어디에 시간을 쓰는지 잰다. 모바일 최적화는 추측으로 하면
     * 안 되는 일이다 — 가장 큰 덩어리를 모르면 엉뚱한 곳을 줄인다. */
    const spent = { decode: 0, tracker: 0, detector: 0, reid: 0, color: 0, cheapQuality: 0 };
    const clockStart = () => performance.now();
    const clockEnd = (key, from) => { spent[key] += performance.now() - from; };
    const reidScheduler = new ReidScheduler({
      mode: reidScheduleMode === 'fixed-period' ? 'fixed-period' : 'selective',
    });
    const sportProfile = isKnownSport(CONFIG.SPORT) ? sportSoftProfile(CONFIG.SPORT) : null;
    const detectorIntervalFrames = Math.max(2, Math.round((CONFIG.DETECTOR_MIN_GAP_FRAMES || 8) * (sportProfile?.detectorIntervalScale ?? 1)));
    const detectorRoiWiden = sportProfile?.roiWiden ?? 1;
    const featureCache = new FrameFeatureCache();
    const neighborCache = new JaccardNeighborCache();
    let lastReidDecision = null;
    const embedCached = async (drawCtx, boxNow, tSec) => {
      featureCache.beginFrame(tSec);
      const hit = featureCache.get(boxNow);
      if (hit) {
        reidScheduler.noteCacheHit();
        return hit.embedding;
      }
      reidScheduler.noteCacheMiss();
      const reidClock = clockStart();
      let emb = null;
      try { emb = await reid.embed(drawCtx, boxNow); } catch { emb = null; }
      clockEnd('reid', reidClock);
      reidScheduler.noteExtract(performance.now() - reidClock);
      if (boxNow) featureCache.put(boxNow, emb);
      reidCalls += 1;
      return emb;
    };

    let wideSearches = 0;     // 조각을 늘려 넓게 훑은 횟수
    let wideColorVetoes = 0;  // 넓힌 프레임에서 색이 어긋나 뺀 후보 수
    let wideColorFallbacks = 0; // 색이 전원 탈락해 Re-ID 에게 다시 맡긴 횟수
    const REST_HOLD_SECONDS = 2.5;

    /* 복구를 확정하기까지 요구하는 연승 횟수. 44분 원본 표본으로 골랐다
     * (training/appearance/streak.py · 기술 기록 13장). */
    const REACQUIRE_CONFIRM = 3;
    /* 연승으로 세려면 같은 자리여야 한다 — 몸 너비 배수와 시간 상한. */
    const REACQUIRE_STREAK_BODIES = 1.2;
    const REACQUIRE_STREAK_SECONDS = 1.0;
    let reacquireStreak = 0;
    let reacquireLast = null;
    let reacquireUnconfirmed = 0;

    let holdRun = 0;
    let dragStartStationary = false;
    const DRAG_HOLD_AFTER = 3;
    const MAX_HOLD_FRAMES = 24;   // 12fps 에서 2초

    /* 🔴 크기의 절대 기준.
     *
     * 출발점은 **사용자가 직접 고른 상자**다. 우리가 가진 가장 믿을 만한
     * 정답이고, 그 사람의 크기가 어느 정도인지를 알려 준다.
     *
     * 이 기준은 확인된 프레임에서만, 아주 천천히 따라간다. 사람이
     * 카메라 쪽으로 다가오는 진짜 변화는 몇 초에 걸쳐 일어나므로 기준이
     * 따라잡는다. 반면 상자가 옆 사람을 삼키며 부푸는 가짜 변화는 몇
     * 프레임짜리라 따라잡지 못하고, 그래서 잘린다. */
    const origin = { width: box.width, height: box.height };
    const sizeRef = { width: box.width, height: box.height };
    const SIZE_REF_ALPHA = 0.02;   // 12fps 에서 시간상수 약 4초
    /* 기준이 원본에서 벗어날 수 있는 한계. 사람이 카메라 쪽으로 걸어와
     * 커지는 것은 이 안에서 소화되고, 옆 사람을 삼켜 부푸는 것은 여기서
     * 막힌다. */
    /* 값은 크기 잠금 묶음(tracker-core.js)에서 온다. strict 가 원래의 0.7 / 1.5 다. */
    const SIZE_REF_MIN = lock.refMin;
    const SIZE_REF_MAX = lock.refMax;
    /* 사람 검출이 뒷받침한 크기까지는 기준이 원본에서 벗어날 수 있다(detection-anchor, 2026-09-28). */
    let refFloorW = SIZE_REF_MIN, refFloorH = SIZE_REF_MIN, refCeilW = SIZE_REF_MAX, refCeilH = SIZE_REF_MAX;

    /** 매 프레임 예측. 카메라 이동은 대상의 움직임이 아니라 화면의 움직임이다. */
    const kfPredict = () => {
      /* 🔴 관측이 없으면 속도를 죽여 간다.
       *
       * 예전에는 검출이 하나도 안 붙어도 속도를 그대로 더하며 나아갔다.
       * 실측(아이스링크 영상 17.75~18.08초)에서 그것이 이렇게 보였다.
       *
       *     cx 0.845 -> 0.882 -> 0.918 -> 0.954 -> 0.991 (화면 밖)
       *     상자 크기는 0.049 로 **고정** — 검출이 한 번도 안 붙었다
       *
       * 카메라 앞을 지나가는 큰 사람이 추적기를 훔쳐 갔고, 필터는 그
       * 속도를 관성으로 계속 밀어 화면 밖까지 데려갔다. 관측이 없다는
       * 것은 "그 방향이 맞다" 가 아니라 **"모른다"** 인데, 등속 예측은
       * 모르는 상태를 확신으로 바꾼다.
       *
       * `OcclusionMemory` 는 같은 이유로 감쇠(PREDICTION_DECAY)를 갖고
       * 있는데, 그건 confidence 가 떨어졌을 때만 도는 경로였다. 가림꾼을
       * 따라가는 동안 confidence 는 1.000 이었다 — 그래서 그 경로가
       * 아예 안 돌았다.
       *
       * 사람이 제자리에 있었으면 더 빨리 죽인다. 가만히 있던 사람이
       * 갑자기 등속으로 밀려가는 것은 대상의 움직임이 아니다. */
      if (kf.since > 0) {
        const decay = stationaryNow()
          ? Math.pow(CONFIG.PREDICTION_DECAY, kf.since * 3)
          : Math.pow(CONFIG.PREDICTION_DECAY, kf.since);
        kf.vx *= decay; kf.vy *= decay;
      }
      kf.x += kf.vx; kf.y += kf.vy; kf.since += 1;
      if (camera && cameraDrift.confidence > 0) {
        const moved = applyCameraBox({ x: kf.x - kf.w / 2, y: kf.y - kf.h / 2, width: kf.w, height: kf.h });
        kf.x = moved.x + moved.width / 2;
        kf.y = moved.y + moved.height / 2;
        kf.w = moved.width;
        kf.h = moved.height;
      }

      /* 🔴 화면 밖으로 나가면 되돌린다. 그리고 속도를 죽인다.
       *
       * 이 세 줄이 없어서 실제 사용자 영상에서 40초 중 마지막 22초를
       * 화면 밖 허공에서 보냈다(신뢰도 1.000 으로). 예측이 한 방향으로
       * 조금씩 앞서고, 그 자리에서 잘라낸 조각은 전부 가장자리 화소라
       * 상관값이 높게 나오고, 높으니 "잘 찾고 있다" 며 계속 나아간다.
       * 되돌아올 방법이 없다.
       *
       * 속도를 함께 죽이는 것이 중요하다. 위치만 되돌리면 다음 프레임에
       * 같은 속도로 또 나가고, 매 프레임 경계에 붙어 떠는 상태가 된다. */
      const bx = { x: kf.x - kf.w / 2, y: kf.y - kf.h / 2, width: kf.w, height: kf.h };
      if (hasEscaped(bx, FRAME)) {
        const back = clampToFrame(bx, FRAME);
        kf.x = back.x + back.width / 2;
        kf.y = back.y + back.height / 2;
        kf.vx = 0; kf.vy = 0;
        escapeClamps += 1;
      }
    };

    /** 검출로 보정. */
    const kfUpdate = (b) => {
      const mx = b.x + b.width / 2, my = b.y + b.height / 2;
      const ex = mx - kf.x, ey = my - kf.y;
      const frames = Math.max(1, kf.since);
      kf.x += KF_POS_GAIN * ex;
      kf.y += KF_POS_GAIN * ey;
      kf.vx += KF_VEL_GAIN * ex / frames;
      kf.vy += KF_VEL_GAIN * ey / frames;
      const cap = KF_MAX_SPEED_SHARE * Math.max(8, Math.max(kf.w, kf.h));
      const sp = Math.hypot(kf.vx, kf.vy);
      if (sp > cap) { kf.vx = kf.vx / sp * cap; kf.vy = kf.vy / sp * cap; }
      kf.w += KF_SIZE_GAIN * (b.width - kf.w);
      kf.h += KF_SIZE_GAIN * (b.height - kf.h);
      kf.since = 0; kf.misses = 0;
    };

    /** 필터 상태를 박스로. */
    const kfBox = () => ({ x: kf.x - kf.w / 2, y: kf.y - kf.h / 2, width: kf.w, height: kf.h });

    const centerDist = (b, pt) =>
      Math.hypot(b.x + b.width / 2 - pt.x, b.y + b.height / 2 - pt.y);

    /* 게이트를 통과한 검출이 이만큼 연속으로 없으면 진짜 놓친 것으로 본다. */
    const NO_ASSOC_LOST = 4;
    /* 아무리 오래 못 찾아도 이 거리를 넘지 않는다. */
    const GATE_MAX_SHARE = 3.0;
    let gateRejects = 0, gateAccepts = 0, gateAmbiguous = 0;
    /* 진단용. HILIT_GATE_TRACE 를 켜면 게이트가 무엇을 보고 무엇을
     * 골랐는지 남긴다. 기본은 꺼짐 — 긴 영상에서 메모리를 먹는다. */
    const gateTrace = [];
    const identityEvents = [];
    const noteIdentity = (ev) => {
      if (!identityDiag || identityEvents.length >= 250) return;
      identityEvents.push(ev);
    };
    let undecided = 0;      // 후보가 여럿인데 가를 근거가 없던 횟수
    const uncertainAt = [];  // 그 시각들 — 추적 뒤에 신뢰도를 낮춘다
    let occludedRun = 0;      // 가림이 몇 프레임째 이어지는가
    /* 색이 "지금 잡고 있는 건 대상이 아니다" 라고 몇 번 연속 말했나. */
    let colorDisagreeRun = 0;
    let colorVetoes = 0;      // 그 신호로 복구를 부른 횟수
    /* 지금 잡고 있는 상자가 대상 색과 얼마나 닮았나 — 평균. 임계값
     * (COLOR_SELF_FLOOR)을 숫자로 고르기 위한 계측이다. */
    let colorPickSum = 0, colorPickCount = 0;
    let reacquireJumps = 0;   // 복구가 몸 하나 이상 건너뛴 횟수
    let restOverrides = 0;    // 모호 판정을 "자리" 로 뒤집은 횟수
    let anchorOverrides = 0;  // 사용자가 지정한 자리로 뒤집은 횟수
    /* 확인된 프레임에서 잰 "우리 자신의 색 점수" 수준. 색 감시의 기준선
     * 이다(COLOR_SELF_DROP 설명 참조). 확인된 프레임에서만 배운다 —
     * 의심 중에 배우면 잘못 잡은 상자의 색을 정상으로 학습한다. */
    let selfColorLevel = 0, selfColorSamples = 0;
    let reacquireOverrides = 0;  // 모호 판정을 증거로 뒤집은 횟수
    let slicedReacquires = 0;    // 조각 검출로 재획득을 시도한 횟수
    let reweaveFrames = 0;       // 가림 구간을 되그린 프레임 수
    /* 마지막으로 **근거를 갖고** 대상이라고 확인한 자리.
     *
     * 가림 구간을 되그릴 때(ORU) 출발점이 된다. 추적기의 마지막 위치가
     * 아니라 확인된 위치여야 한다 — 추적기는 놓친 뒤에도 계속 어딘가를
     * 가리키고 있고, 그 자리는 이미 틀렸을 수 있다. */
    let lastConfirmed = { t: anchorTime, box: { ...box } };

    /* 가림 구간을 **실제로 일어난 일**로 되그린다 (OC-SORT 의 ORU 착상).
     *
     * ## 왜 필요한가
     *
     * 가림 동안 궤적에는 예측값이 들어간다. 예측은 매 걸음 조금씩
     * 틀리고 오차가 쌓인다. 그런데 다시 찾은 순간 우리는 두 가지 사실을
     * 갖는다 — **사라진 자리**와 **다시 나타난 자리**. 그 사이를 두 점
     * 보간으로 채우면 예측 누적보다 훨씬 정확하다.
     *
     * 사실 두 개 사이의 보간이 짐작의 누적보다 낫다.
     *
     * ## 사용자에게 무엇이 달라지나
     *
     * 내보낸 영상에서 카메라가 가림 구간에 엉뚱한 데를 보다가 사람을
     * 찾는 순간 홱 돌아오는 일이 없어진다. 그 구간이 직선으로 이어진다.
     *
     * 🔴 상태(state)는 건드리지 않는다. 그 구간이 불확실했다는 사실은
     *    그대로 남아야 한다 — 자리를 고쳐 그렸을 뿐 "확인했다" 가 된
     *    것은 아니다. 4단계에서 사용자에게 계속 물어본다.
     */
    const reweaveGap = (from, toT, toBox) => {
      const span = toT - from.t;
      if (span <= 1e-6) return 0;
      let changed = 0;
      for (let k = trajectory.length - 1; k >= 0; k -= 1) {
        const point = trajectory[k];
        if (point.t <= from.t + 1e-6) break;
        if (point.t >= toT - 1e-6) continue;
        const u = (point.t - from.t) / span;
        /* 크기는 선형이 아니라 조화 보간이다. 사람이 멀어졌다 가까워지는
         * 동안 화면 크기는 거리의 역수로 변하므로, 선형으로 이으면
         * 중간 구간이 늘 실제보다 크게 잡힌다. */
        const harmonic = (a, b) => 1 / ((1 - u) / Math.max(1e-3, a) + u / Math.max(1e-3, b));
        const w = harmonic(from.box.width, toBox.width);
        const h = harmonic(from.box.height, toBox.height);
        const cx = (from.box.x + from.box.width / 2)
          + ((toBox.x + toBox.width / 2) - (from.box.x + from.box.width / 2)) * u;
        const cy = (from.box.y + from.box.height / 2)
          + ((toBox.y + toBox.height / 2) - (from.box.y + from.box.height / 2)) * u;
        point.box = { x: cx - w / 2, y: cy - h / 2, width: w, height: h };
        point.reweaved = true;
        changed += 1;
      }
      return changed;
    };
    /* --- 의심 래치 -------------------------------------------------
     *
     * 사용자가 정확히 이 문제를 지적했다. "놓쳤는데도 놓쳤는지를 모른다."
     *
     * 원인은 의심이 **점**으로만 남았다는 것이다. 확인이 필요한 프레임에서
     * ASK_USER 를 띄우고, 다음 프레임에는 상태 기계가 OK 로 돌아갔다.
     * 실측(수정 전): 15.83 / 16.83 / 17.08 / 17.81 네 순간만 표시되고
     * 그 사이는 전부 TRACKING_OK 였다. 화면은 정상으로 보이는데 실제로는
     * 2초 내내 다른 사람을 따라가고 있었다.
     *
     * 그래서 래치로 바꾼다. 한번 의심이 생기면 **다시 확인될 때까지**
     * 유지된다. 확인이 끝까지 안 되면 구간은 영상 끝까지 이어진다.
     * 이러면 "여기부터 확신이 없습니다" 를 시각이 아니라 구간으로 말할 수
     * 있다.
     *
     * 해제 조건은 근거가 있을 때만이다.
     *   복구가 후보를 받아들였다        OSNet·비대상 기억·위치가 동의
     *   주기 Re-ID 가 낯선 사람 최고값 위로 확실히 올라왔다
     *
     * 시간이 지났다는 것은 해제 조건이 아니다 — 그게 원래 버그였다. */
    /* 🔴 의심에는 **두 등급**이 있다. 이걸 하나로 묶어 두었던 것이
     *    사용자 불만의 정체다.
     *
     * > 현재는 잘 된 부분에 대해서도 사용자에게 놓친 것 같다고 시간과
     * > 의견을 제시한다.
     *
     * 실측(겹침 영상): 정답과 오차 0.016 으로 잘 따라가고 있는 18개 확인점
     * 중 **14개에서 "확인 필요" 라고 말했다.** 이유는 이렇다. 대상이
     * 제자리에 서 있고 검출기가 잠깐 놓치면, 우리는 옆 사람 후보를 물리
     * 법칙으로 거절한다(teleport_rejected). 그건 방어선이 **제대로 일한**
     * 것인데, 그 사실이 "확신 없음" 으로 기록됐다.
     *
     * 그래서 등급을 나눈다.
     *
     *   watch (지켜봄)  지금 안 보이지만 **어디 있는지는 안다**.
     *                   가림 · 검출 실패 · 남을 거절함. 알던 자리를 지키는
     *                   중이다. 사용자에게 묻지 않는다.
     *   risk  (위험)    **다른 사람일 수 있다**. 외형이 어긋남 · 남이 더
     *                   닮음 · 복구가 후보를 못 가림 · 끌려감 · 오래 확인
     *                   불가. 사용자에게 보여주고 묻는다.
     *
     * watch 가 길어지면(WATCH_GRACE) risk 로 올린다 — 오래 못 봤으면
     * 정말로 모르는 것이다. 시간이 지났다는 것은 해제 조건이 아니지만,
     * **승급** 조건은 된다. */
    let doubtSince = null;      // 의심이 시작된 시각. null 이면 확인된 상태
    let doubtReason = null;
    let doubtLevel = null;      // 'watch' | 'risk'
    const WATCH_GRACE_SECONDS = 2;
    const doubtSpans = [];      // {start, end, reason, level} — 화면에 보여줄 구간
    const openDoubt = (time, reason, level = 'risk') => {
      if (doubtSince === null) {
        doubtSince = time; doubtReason = reason; doubtLevel = level;
        return;
      }
      /* 이미 열려 있는데 더 심한 이유가 왔으면 등급만 올린다. */
      if (level === 'risk' && doubtLevel === 'watch') {
        doubtLevel = 'risk'; doubtReason = reason;
      }
    };
    const closeDoubt = (time) => {
      if (doubtSince === null) return;
      doubtSpans.push({ start: +doubtSince.toFixed(3), end: +time.toFixed(3),
                        reason: doubtReason, level: doubtLevel, resolved: true });
      doubtSince = null; doubtReason = null; doubtLevel = null;
    };
    let detectorGap = 1e9;    // 검출기를 마지막으로 부른 뒤 지난 프레임
    /* 가림이 이만큼 이어지면 검출로 확인한다.
     * 짧게 잡으면 사람이 스쳐 지나갈 때마다 검출이 돌아 느려지고,
     * 길게 잡으면 놓친 걸 모른 채 시간이 흐른다. 20fps 기준 0.4초다. */
    const OCCLUSION_VERIFY_AFTER = 8;
    let fpsChecks = 0;
    let riskyGapFloor = CONFIG.REID_INTERVAL_WARNING;
    let sequential = globalThis.HILIT_SEQUENTIAL_DECODE === true;
    if (sequential) await this._startPlayback(anchorTime, rate);

    for (let i = 1; i < total; i++) {
      if (signal?.aborted) break;

      /* 다음 프레임을 얻는다.
       *
       * 순차 디코딩이 정상이면 표시된 프레임을 받아쓴다 (seek 없음).
       * 재생이 안 되면 seek 방식으로 내려간다 — 느리지만 멈추지는 않는다. */
      let t = lastT + dt;
      if (sequential) {
        let got = null, guardCount = 0;
        while (!signal?.aborted) {
          got = await this._nextFrame();
          if (got === null) break;                       // 시간 초과
          seen += 1;
          if (this.video.ended || got >= m.duration - 1e-3) break;
          if (got >= stopTime - 1e-3) break;
          if (got - lastT >= dt * 0.9) break;
          skipped += 1;
          if (++guardCount > 240) break;
        }
        if (got === null) {
          // 재생이 프레임을 내주지 않는다. 한 번만 알리고 seek 으로 전환한다.
          sequential = false;
          this._stopPlayback();
          this.onProgress({
            phase: 'track', frame: i, total,
            percent: Math.round((i / total) * 100),
            message: '순차 재생이 막혀 프레임 단위 탐색으로 전환합니다 (느려집니다)',
          });
        } else {
          t = got;
        }
      }
      if (signal?.aborted) break;
      if (!sequential) {
        t = Math.min(anchorTime + i * dt, m.duration - 1e-3);
        const c0 = clockStart();
        await this.seekDraw(t);
        clockEnd('decode', c0);
      }
      /* 고른 구간을 지났다. total 로도 걸리지만 순차 디코딩은 프레임을
       * 받아쓰므로 t 가 계산과 어긋날 수 있어 여기서도 본다. */
      if (t > stopTime + 1e-3) break;
      lastT = t;

      /* 분석이 재생을 못 따라가면 속도를 낮춘다. 여유가 있으면 올린다.
       * 건너뛴 프레임이 많다는 건 추적 연속성이 깨진다는 뜻이다. */
      if (sequential && i % 15 === 0) {
        const skipRatio = skipped / Math.max(seen, 1);
        /* 🔴 프레임을 **건너뛰지 않는 쪽**으로 맞춘다.
         *
         * 예전 값(0.45 / 3.0배)은 "빠르게 끝내기" 를 노렸다. 그런데
         * 건너뛴 프레임은 곧 추적 연속성이고, 연속성이 깨지면 정확도가
         * 떨어진다 — 실측(겹침 영상): 순차 재생 3배 허용에서 391프레임이
         * 84프레임으로 줄고 정답이 15/18 -> 7/18 이 됐다.
         *
         * 그래서 조금만 건너뛰어도 속도를 낮추고, 최대 배속을 1.0 으로
         * 묶는다. 재생이 우리 분석 속도를 기다리게 만드는 것이다. */
        if (skipRatio > 0.12) rate = Math.max(0.2, rate * 0.7);
        else if (skipRatio < 0.03) rate = Math.min(1.0, rate * 1.1);
        this.video.playbackRate = rate;
        seen = 0; skipped = 0;
      }

      /* 실제 처리 속도를 보고 분석 프레임률을 맞춘다.
       *
       * 두 번 잰다. 앞부분은 대체로 쉬워서 빠르고, 사람이 겹치거나 화면이
       * 어려워지는 뒷부분에서 갑자기 느려진다. 한 번만 재면 그 변화를
       * 놓쳐 "처음엔 괜찮다가 갑자기 오래 걸리는" 상태가 된다.
       *
       * 프레임률 하한을 12로 둔다. 더 낮추면 프레임 간격이 벌어져
       * NanoTrack 의 탐색 범위를 벗어나기 시작한다 — 빨라지는 대신
       * 놓치면 의미가 없다. */
      if (fpsChecks < 2 && (i === 12 || i === 55)) {
        fpsChecks += 1;
        const msPerFrame = (performance.now() - t0) / i;
        const remaining = Math.max(0.1, stopTime - lastT);
        const affordable = Math.max(1, Math.floor(remaining * targetRatio * 1000 / msPerFrame));
        const wantFps = affordable / remaining;
        const chosen = Math.max(12, Math.min(m.analysisFps, Math.round(wantFps)));

        /* 느린 기기에서는 Re-ID 확인 간격도 함께 넓힌다.
         * 위험 구간에서 5프레임마다 OSNet 을 부르면(165ms/회) 그것만으로
         * 초당 1초를 쓴다. 확인이 늦어지는 대신 전체가 끝난다. */
        if (msPerFrame > 90) riskyGapFloor = 9;
        else if (msPerFrame > 65) riskyGapFloor = 7;

        if (chosen < analysisFps) {
          analysisFps = chosen;
          dt = dtOf(analysisFps);
          /* 남은 구간을 새 간격으로 다시 센다. 이미 돈 i 프레임에 앞으로
           * 돌 프레임을 더한다 — total 을 그대로 두면 진행률이 끝까지
           * 차지 않고, 반복 상한도 dt 와 어긋난다. */
          total = i + Math.max(1, Math.ceil(Math.max(0, stopTime - lastT) / dt));
          this.onProgress({
            phase: 'track', frame: i, total,
            percent: Math.round((i / total) * 100),
            message: `이 기기 속도에 맞춰 분석을 ${analysisFps}fps 로 조정했습니다`,
          });
        }
      }

      if (sequential) {
        this.ctx.drawImage(this.video, 0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
      }
      ctx = this.ctx;

      /* 외형이 사용자 앵커와 오래 어긋나면 더 따라가지 않는다.
       * 틀린 자리(컨테이너·수풀)를 궤적에 계속 쓰면 편집이 그 자리를 자른다. */
      if (appearanceAskedAt !== null && frozenAskBox) {
        trajectory.push({
          frame: i, t, box: { ...frozenAskBox }, state: State.ASK_USER,
          health: 0, reid: lastReidSim, confidence: 0,
          badRatio: 0, measured: false,
          trackerStatus: 'ask_user', trackerReason: 'anchor-appearance-drift',
          pointsKept: 0, pointsUsed: 0, observed: false,
          unverified: true, watching: false,
          identityLifecycle: 'NEEDS_USER_CONFIRMATION',
        });
        prevBox = frozenAskBox;
        if (i % 5 === 0 || i === total - 1) {
          this.onProgress({
            phase: 'track', frame: i, total,
            percent: Math.round((i / total) * 100),
            state: State.ASK_USER, health: 0, reid: lastReidSim,
            fps: i / ((performance.now() - t0) / 1000),
            playbackRate: rate, t, box: frozenAskBox,
          });
        }
        if ((sequential && this.video.ended) || lastT >= m.duration - dt * 0.5) break;
        continue;
      }

      /* 이 프레임 직전에 제자리에 있었는가. up.box 로 recentCentres 가
       * 바뀌기 전에 읽어야 한다. */
      const wasStationary = stationaryNow();

      const trackerClock = clockStart();
      const up = await tracker.update(ctx, t, continuityExperiment === true && suspendTemplateLearn ? { learn: false } : undefined);
      clockEnd('tracker', trackerClock);
      reidScheduler.noteMotion(performance.now() - trackerClock);
      if (identityRecoveryExperiment) {
        try {
          const img = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
          reverseGrayBuf.push({ videoTSec: t, gray: rgbaToGray(img.data, img.width, img.height) });
          while (reverseGrayBuf.length > 48) reverseGrayBuf.shift();
          while (reverseGrayBuf.length && t - reverseGrayBuf[0].videoTSec > 2.05) reverseGrayBuf.shift();
        } catch { /* seek 경쟁·디코드 실패는 역추적을 건너뛴다 */ }
      }
      if (prevBox && Number.isFinite(t)) {
        forwardBoxAt.push({ tSec: t, box: { x: prevBox.x, y: prevBox.y, width: prevBox.width, height: prevBox.height } });
        while (forwardBoxAt.length && t - forwardBoxAt[0].tSec > 2.05) forwardBoxAt.shift();
      }
      /* Phase 1: 초기화 실패·1×1 상자를 정상 관측처럼 쓰지 않는다.
       * 이전 확정 상자를 유지하고 관측 아님으로 표시한다. */
      if (prevBox && (up.reason === 'not_initialized' || (up.box && up.box.width <= 2 && up.box.height <= 2))) {
        up.box = { ...prevBox };
        up.observed = false;
        if (up.reason === 'not_initialized') up.confidence = 0;
      }

      /* 검출 기준 보정(2026-09-28) — 0.5초(영상 시간)마다, 추적 상자와 이미 겹치는 사람이 하나로 분명하면
       * 그 사람 쪽으로 당기고 추적기를 그 자리에서 다시 배우게 한다. 겹치지 않는 사람으로는 옮기지 않는다. */
      let anchorAskNow = false;
      if (personProbe && appearanceAskedAt === null && up.box && up.observed !== false
          && anchorDue(lastAnchorT, t, anchorCfg.intervalSec)) {
        lastAnchorT = t;
        anchorProbes += 1;
        let hits = null;
        try { hits = await personProbe(ctx.canvas); } catch { hits = null; }
        if (hits) {
          let decision = anchorDecision(up.box, hits, anchorCfg);
          /* 가로지름 확인(2026-09-29) — 겹침이 가장 큰 사람이 앞선 움직임과 어긋나고, 내다본 자리에 다른 분명한 사람이
           * 있으면 옮기지도 다시 배우지도 않고 묻는다(detection-anchor.js crossingStep). 내다본 자리의 사람으로 옮기지도 않는다. */
          const crossStep = crossingStep(anchorTrail, t, decision, hits, up.box, anchorCfg);
          const crossing = crossStep?.kind === 'conflict' ? crossStep : null;
          if (crossStep?.kind === 'far') anchorCrossHolds += 1;
          if (crossing) {
            decision = { action: 'keep', reason: 'crossing-conflict', iou: decision.iou };
            anchorCrossings += 1;
            if (followThrough || (stopOnAsk && askArmedAt === null)) {
              /* 묻기를 건너뛰었거나, 사용자가 고른 직후라 아직 무장 전이다 — 외형 어긋남과 같이 얼리지 않고 의심만 남긴다. */
              openDoubt(t, 'detector_crossing_conflict');
            } else if (appearanceAskedAt === null) {
              anchorAskNow = true; anchorAskCause = 'detector-crossing-conflict'; anchorAsks += 1;
            }
          }
          const why = decision.action === 'correct' ? `correct-${decision.via}` : decision.reason;
          anchorReasons[why] = (anchorReasons[why] || 0) + 1;
          /* 사람이 딴 자리에 보이는데 상자와 겹치는 사람은 없다 — 이어지면 상자가 배경에 붙은 것이다(detection-anchor.js anchorMissStep). */
          if (!crossing) {
            anchorMiss = anchorMissStep(anchorMiss, decision, hits, up.box, anchorCfg);
            if (anchorMiss.ask) { anchorAskNow = true; anchorAskCause = 'detector-person-elsewhere'; anchorAsks += 1; }
          }
          if (continuityExperiment === true && !anchorAskNow) {
            continuityStick = backgroundStickStep(continuityStick, {
              experiment: true,
              hits,
              box: up.box,
              prevBox,
              camera: cameraDrift,
              trackerConfidence: up.confidence,
            });
            suspendTemplateLearn = continuityStick.learn === false;
            if (continuityStick.ask && appearanceAskedAt === null && !(followThrough || (stopOnAsk && askArmedAt === null))) {
              anchorAskNow = true;
              anchorAskCause = 'background-stick-experiment';
              anchorAsks += 1;
              continuityAsks += 1;
              continuityStick = { run: 0 };
            }
          }
          if (absenceEdgeExperiment === true && !anchorAskNow) {
            edgeAbsence = edgeAbsenceStep(edgeAbsence, {
              experiment: true,
              hits,
              box: up.box,
              frame: FRAME,
            });
            if (edgeAbsence.ask && appearanceAskedAt === null && !(followThrough || (stopOnAsk && askArmedAt === null))) {
              anchorAskNow = true;
              anchorAskCause = 'edge-absence-experiment';
              anchorAsks += 1;
              edgeAbsenceAsks += 1;
              edgeAbsence = { run: 0 };
            }
          }
          if (anchorCfg.debug) anchorLog.push({ t, box: { ...up.box }, why, ...(crossStep ? { crossing: crossStep } : {}), hits: hits.slice(0, 4).map((h) => [h.x, h.y, h.width, h.height, h.score].map((v) => Math.round(v * 100) / 100)) });
          const reattach = continuityExperiment === true
            ? reattachAllowed({
              experiment: true,
              personOverlap: true,
              motionAgrees: !crossing,
              appearanceAgrees: null,
            })
            : { allow: true, reason: 'experiment-off' };
          if (decision.action === 'correct' && reattach.allow && templateUpdateAllowed({
            experiment: continuityExperiment === true,
            backgroundStick: suspendTemplateLearn,
            occluded: false,
            provisional: false,
          })) {
            up.box = { x: Math.round(decision.box.x), y: Math.round(decision.box.y),
              width: Math.round(decision.box.width), height: Math.round(decision.box.height) };
            try { await tracker.refreshTemplate(ctx, up.box, t); } catch { /* 다음 프레임부터 */ }
            /* 크기는 필터(kf)와 크기 기준(sizeRef)이 들고 있어 up.box 만 바꾸면 다음 프레임에 되돌아간다.
             * 사람 검출이 뒷받침한 크기이므로 여기서만 둘을 그 크기로 옮기고, 기준이 원본에서 벗어날 수 있는
             * 범위도 그 크기까지 넓힌다(증거 없이 스스로 줄거나 커지는 깔쭉이는 여전히 막힌다). */
            kf.x = up.box.x + up.box.width / 2; kf.y = up.box.y + up.box.height / 2;
            kf.w = up.box.width; kf.h = up.box.height;
            const ratioW = up.box.width / origin.width, ratioH = up.box.height / origin.height;
            refFloorW = Math.min(refFloorW, Math.max(0.2, ratioW * 0.9));
            refFloorH = Math.min(refFloorH, Math.max(0.2, ratioH * 0.9));
            refCeilW = Math.max(refCeilW, Math.min(3, ratioW * 1.1));
            refCeilH = Math.max(refCeilH, Math.min(3, ratioH * 1.1));
            sizeRef.width = up.box.width; sizeRef.height = up.box.height;
            anchorCorrections += 1;
          }
        }
      }

      /* 🔴 추적기가 말한 신뢰도를 그대로 쓰지 않는다.
       *
       * 상자가 화면을 벗어나면 잘라낸 조각이 전부 가장자리 화소라 서로
       * 비슷해진다. 비슷하면 상관값이 높고, 추적기는 "잘 찾고 있다" 고
       * 말한다. **신호가 사라진 것을 신호가 좋아진 것으로 읽는다.**
       *
       * 실측(아이스링크 영상): 상자가 화면 밖으로 나간 뒤 22초 동안
       * 신뢰도 1.000 을 유지했다. 그 22초는 빈 공간을 추적한 시간이다.
       *
       * 보이는 비율을 곱해서 아래 전부에 같은 값을 쓴다 — 하락 추세,
       * 상태 판정, 템플릿 갱신, 궤적 기록. 한 곳이라도 원래 값을 쓰면
       * 그 경로로 거짓말이 새어 들어온다. */
      const visible = visibleRatio(up.box, FRAME);
      const trackerConfidence = discountByVisibility(up.confidence, up.box, FRAME);

      health.trend.update(trackerConfidence);
      health.framesSinceReid += 1;
      detectorGap += 1;
      if (personDetector && detectorDiagnose === true) {
        const plan = planDetectorSearch({
          trigger: trackerConfidence < 0.45 ? 'degraded' : 'interval',
          framesSinceDetector: detectorGap,
          intervalFrames: detectorIntervalFrames,
          lastBox: prevBox,
          frameW: FRAME.width,
          frameH: FRAME.height,
          stdX: regionPredictor.spatialCovariance?.()?.stdX ?? null,
          stdY: regionPredictor.spatialCovariance?.()?.stdY ?? null,
          roiWiden: detectorRoiWiden,
          subjectHeightPx: prevBox ? prevBox.height : null,
        });
        if (plan.run) {
          const detClock = clockStart();
          try {
            lastDetectorRun = personDetector.proposeFromCanvas(ctx.canvas, { timestamp: t });
            lastPersonNetDiagnose = buildPersonNetDiagnoseResult({
              mode: 'diagnose',
              frameTimestamp: t,
              inferenceMs: 0,
              weightsPresent: false,
              reason: 'personnet-weights-not-shipped-in-browser',
            });
            detectorCalls += 1;
            detectorGap = 0;
            lastDetectorObservationTrust = detectorObservationTrust({
              connected: true,
              weightsPresent: false,
              claimedPersonDetection: false,
              source: 'heuristic_not_person',
              cropValid: true,
            });
          } catch {
            /* 진단 실패는 추적을 멈추지 않는다 */
          }
          clockEnd('detector', detClock);
          const detScope = plan.scope === 'full' ? 'full'
            : (String(plan.scope).includes('region') || String(plan.scope).includes('near') ? 'region' : 'full');
          reidScheduler.noteDetect(performance.now() - detClock, detScope);
        }
      }
      assocGap += 1;
      templateGap += 1;

      /* 🔴 가만히 있던 사람이 갑자기 달리기 시작했다 — 확인한다.
       *
       * 실측(아이스링크 영상): 대상이 17초 동안 cx 0.75~0.81 에 머물다가
       * 17.75초부터 매 프레임 허용치 최대 속도로 오른쪽으로 밀려갔다.
       * 카메라 앞을 지나간 큰 스케이터가 추적기를 훔쳐 간 것이다.
       *
       * 이것을 "대상이 움직이기 시작했다" 와 겉으로 구분할 수 없다.
       * 사람은 실제로 서 있다가 달리기도 한다. 그래서 막지 않고
       * **확인한다** — 지금 잡고 있는 자리의 외형을 즉시 재서, 그게
       * 우리가 아니면 그때 복구로 넘긴다.
       *
       * 주기(20프레임)를 기다리면 그 사이에 화면 밖까지 끌려간다.
       * 실측에서 끌려가는 데 걸린 시간이 0.4초, 주기는 1.7초였다. */
      const surpriseMove = prevBox && recentCentres.length >= 3 && wasStationary
        && Math.hypot(
          (up.box.x + up.box.width / 2) - (prevBox.x + prevBox.width / 2),
          (up.box.y + up.box.height / 2) - (prevBox.y + prevBox.height / 2),
        ) > Math.max(8, prevBox.width) * SURPRISE_BODIES;
      if (surpriseMove) {
        health.framesSinceReid = 1e9;   // 이번 프레임에 반드시 잰다
        surpriseChecks += 1;
      }

      // Adaptive Re-ID
      let sim = health.lastReid;
      let measured = false;
      /* 이 프레임에서 잰 "지금 잡고 있는 것의 색 점수". 확인되면 기준선에
       * 반영한다. */
      let pickColorNow = null;
      // 프레임률을 낮췄으면 Re-ID 간격도 줄여 시간 간격을 유지한다.
      const reidEvery = Math.max(2, Math.round(reidSecondsNormal * analysisFps));
      let lastEmbedding = null;
      /* 내 유사도가 남보다 낮아졌고, 위치가 그것을 보증하지 못했다.
       * 상태 판정은 아래에서 한다 — 여기서는 사실만 남긴다. */
      let selfBelowStranger = false;
      /* 이번 프레임의 이동이 **증거를 갖춘** 것인가.
       *
       * 🔴 복구(Lv2)는 "놓쳤다 -> 찾았다" 이므로 멀리 뛰는 것이 정상이다.
       *    물리 상한을 거기까지 걸었더니 복구가 성공해도 그 자리로 갈 수
       *    없어 147번 시도에 7번만 붙었다. 막는 것과 못 돌아오게 하는
       *    것은 다르다. */
      let evidenceJump = false;
      /* Re-ID 에 구분력이 없다고 측정되면 아예 부르지 않는다.
       *
       * 결정에 안 쓰는 신호를 상태 기계에는 계속 먹이고 있었다. 그래서
       * 기기 속도에 따라 달라지는 Re-ID 주기(riskyGapFloor 는 측정된
       * ms/frame 으로 정해진다)가 LOST 판정을 흔들었고, 같은 영상을
       * 네 번 돌렸을 때 확인 지점 일치가 3/6~6/6 으로 튀었다.
       *
       * 근거 없는 숫자를 상태 판단에서 빼면 결과가 안정되고, OSNet
       * 호출(165ms x 30회)도 줄어든다. */
      /* 주기 측정은 화면에 보여줄 지표와 "확신 없는 구간" 표시용으로만
       * 남긴다. 상태 판단에는 위와 같이 쓰지 않는다. */
      /* 🔴 여기 조건을 풀어 봤다가 되돌렸다 — 재면서 알게 된 것을 적는다.
       *
       * "외형이 약하다고 외형을 꺼 버리면 되돌아올 길이 없다" 는 생각으로
       * `!appearanceWeak` 를 빼고 항상 재도록 해 봤다. 두 영상에서 잰
       * 결과가 정반대였다.
       *
       *                              끄고(현재)   항상 켜고
       *   사용자 영상(정답 17개)        10          9
       *   턴 영상(정확도)              97.7%      39.9%
       *
       * 턴 영상이 무너진 이유가 중요하다. 그 장면에는 파란 헬멧에 검은
       * 옷을 입은 사람이 열여덟 명이다. 그런 장면에서 약한 외형 점수는
       * 방향을 알려 주는 대신 **옆 사람 쪽으로 끌어당긴다**. 즉 약한
       * 신호는 없는 신호보다 나쁠 수 있다.
       *
       * 그래서 판정을 유지한다. 다만 이건 "외형을 안 쓴다" 가 아니다 —
       * 복구(재포착) 경로에서는 약하든 아니든 외형으로 후보를 고른다.
       * 여기서 끄는 것은 **매 프레임 돌아가는 자동 보정**뿐이다.
       *
       * 주기 외형·앵커 이탈·후보 재탐색·표본 수집은 같은 crop 을
       * 두 번 추출하지 않는다. 표본 검사 0.75s 가 고비용 추출을 강제하지
       * 않는다. 가림·흐림·무효 crop 에서는 추출과 갤러리 갱신을 건너뛴다. */
      featureCache.beginFrame(t);
      const fpsNow = Number.isFinite(analysisFps) && analysisFps > 0 ? analysisFps : 12;
      const driftEvery = Math.max(2, Math.round(REID_SCHEDULER_POLICY.driftInspectIntervalSec * fpsNow));
      const driftInspectDue = appearanceAskedAt === null && (framesSinceDrift + 1) >= driftEvery;
      const cropValid = !!(up.box
        && Math.min(up.box.width, up.box.height) >= REID_SCHEDULER_POLICY.minCropPx);
      const occludedNow = visible < REID_SCHEDULER_POLICY.fullOcclusionVisible;
      const residualBodies = prevBox && up.box
        ? Math.hypot(
          (up.box.x + up.box.width / 2) - (prevBox.x + prevBox.width / 2),
          (up.box.y + up.box.height / 2) - (prevBox.y + prevBox.height / 2),
        ) / Math.max(1, prevBox.height)
        : null;
      let rivalNearby = false;
      if (lastDetectorRun?.proposals?.length) {
        for (const p of lastDetectorRun.proposals) {
          if (up.box && iou(p, up.box) > 0.2) { rivalNearby = true; break; }
        }
      }
      const cheapClock = clockStart();
      const reidDecision = reidScheduler.decide({
        videoTSec: t,
        box: up.box,
        visibleRatio: visible,
        trackerConfidence,
        appearanceWeak,
        surpriseMove: !!surpriseMove,
        rivalNearby,
        rankCompetition: false,
        predictionResidualBodies: residualBodies,
        trackLostSuspect: health.trend.dropped === true
          || health.state === State.WARNING || health.state === State.LOST,
        sustainedAppearanceChange: appearanceLieRun >= 2,
        occluded: occludedNow,
        blurSevere: trackerConfidence < 0.18 && visible > 0.35,
        cropValid,
        userConfirm: false,
        reentryAfterOcclusion: false,
        candidateCount: lastDetectorRun?.proposals?.length || 0,
        gallerySampleCount: appearanceGallery.gallery().length,
        galleryDistinct: appearanceGallery.gallery().length,
        galleryVersion: appearanceGallery.version,
        reidIntervalSec: reidSecondsNormal,
        reidIntervalFrames: reidEvery,
        framesSinceReid: health.framesSinceReid,
        driftInspectDue,
      });
      clockEnd('cheapQuality', cheapClock);
      reidScheduler.noteCheap(performance.now() - cheapClock);
      lastReidDecision = reidDecision;
      if (reidDecision.extract) {
        const e = await embedCached(ctx, up.box, t);
        lastEmbedding = e;
        /* 확인 앵커만으로 잰 값. 적응의 **관문**으로 쓴다. */
        const confirmed = e
          ? Math.max(...anchors.embeddings.map((a) => cosine(a, e) ?? -1)) : null;
        /* 건강도에 먹이는 값은 적응 앵커까지 포함해서 잰다.
         *
         * 🔴 이게 "17초 뒤 같은 사람이 0.48" 문제의 해결이다. 확인 앵커
         *    하나로만 재면 조명·자세가 바뀐 진짜 대상이 낯선 사람보다
         *    낮은 점수를 받는다. */
        const s = e ? anchors.scoreSelf(e) : null;
        if (s !== null) { sim = s; health.lastReid = s; measured = true; }

        /* 🔴 자기 유사도가 낯선 사람 최고값 아래로 내려갔다 = **상자가
         *    엉뚱한 것을 보고 있다**는 뜻이다. 외형이 나쁜 것이 아니다.
         *
         * 처음에는 이 상황에서 외형을 꺼 버렸다(appearanceWeak = true).
         * 측정해 보니 정반대였다. 같은 아이스링크 영상에서 **상자를
         * 대상에 고정하고** 잰 값이다(measure_separability.py).
         *
         *      시각    같은 사람   다른 사람 최고(18~19명 중)
         *      0.5s      1.000        0.701
         *     12.0s      0.951        0.598
         *     20.0s      0.986        0.706
         *     24.0s      0.976        0.703
         *
         * 파란 헬멧에 검은 옷을 입은 사람이 열여덟 명 있어도 서술자는
         * 0.25~0.35 차이로 가른다. 추적 중에 0.470 이 나왔던 것은 그때
         * **상자가 이미 다른 사람 위에 있었기** 때문이다.
         *
         * 즉 이 신호는 "외형을 믿지 마라" 가 아니라 **"지금 잡고 있는
         * 것이 대상이 아니다"** 라는 경보다. 끄는 것이 아니라 찾아야
         * 한다 — 그리고 찾을 때 쓸 수 있는 가장 좋은 신호가 바로 이
         * 외형이다. 꺼 버리면 되돌아올 방법을 스스로 없앤다.
         *
         * 한 번으로 뒤집지 않는다. 자세가 잠깐 틀어져도 한 프레임은
         * 낮게 나온다. */
        if (s !== null && strangerBest !== null) {
          if (s < strangerBest + APPEARANCE_LIE_MARGIN) appearanceLieRun += 1;
          else appearanceLieRun = 0;

          if (appearanceLieRun >= APPEARANCE_LIE_RUN) {
            appearanceLieRun = 0;

            /* 🔴 여기서 두 가지를 갈라야 한다 — 같은 값이 두 가지 다른
             *    사실을 뜻하기 때문이다.
             *
             *      돌았다      같은 사람인데 앞->뒤로 바뀌었다
             *      갈아탔다    상자가 이미 남 위에 있다
             *
             * 외형만 보면 둘이 똑같이 보인다. 둘 다 "내 유사도가 남보다
             * 낮다" 다. 가르는 것은 **위치**다.
             *
             *   제자리에 있었고 + 방금 그 자리에 검출이 붙었다
             *     -> 우리는 사람 위에 있고 순간이동은 없었다
             *     -> 그 사람은 우리다. 달라진 것은 각도뿐이다
             *
             * 이 조건 없이 각도를 추가하면 그게 Identity Poisoning 이다.
             * 반대로 이 조건이 참인데 복구를 돌리면, 복구는 "가장 닮은
             * 사람" 을 고르므로 **진짜 남**을 집는다 — 사용자가 본
             * "턴을 도는데 카메라가 옆 사람으로 간다" 가 그 경로다. */
            const positionVouches = stationaryNow() && kf.since <= 2;

            if (positionVouches && lastEmbedding) {
              anchors.addView(lastEmbedding);
              viewAdds += 1;
              /* 상태를 내리지 않는다. 돈 것은 실패가 아니다. */
            } else {
              switchAlarms += 1;
              if (appearanceWentWeakAt === null) appearanceWentWeakAt = +t.toFixed(2);
              /* 상태는 아래에서 정해진다(stateOut 은 아직 선언 전이다).
               * 여기서는 사실만 남기고 판단은 그 자리에서 한다. */
              selfBelowStranger = true;
              causes[Cause.SIMILAR_APPEARANCE] = (causes[Cause.SIMILAR_APPEARANCE] || 0) + 1;
              openDoubt(t, 'self_below_stranger');
            }
          }
        }

        /* 최근 모습을 조금 반영한다 — 근거가 확실할 때만.
         *
         * 🔴 관문은 **확인 앵커 기준**이다. 적응 앵커로 판단하면 적응
         *    앵커가 자기 드리프트를 스스로 승인하는 고리가 생기고, 그
         *    고리는 몇 초 만에 옆 사람까지 "나" 로 만든다.
         *
         * 의심이 열려 있는 동안에는 갱신하지 않는다. 지금 잡고 있는 것이
         * 대상인지 아직 모르는 상태이고, 그때의 모습을 앵커에 섞는 것이
         * 정확히 Identity Poisoning 이다. */
        if (e && confirmed !== null && mayUpdateAppearanceMemory({
          trackState: appearanceAskedAt ? 'lost' : 'ok',
          identityState: appearanceAskedAt ? 'needs_reselect' : 'user_anchor',
          doubtOpen: doubtSince !== null,
        })) {
          const floor = Math.max(reidThreshold,
            (strangerBest === null ? 0 : strangerBest) + REACQUIRE_REID_MARGIN);
          anchors.adapt(e, { self: confirmed, other: anchors.scoreOther(e), floor });
        }
        if (reidDecision.admitInspect && appearanceGallery && e?.identityDescriptor?.color && confirmed !== null && mayUpdateAppearanceMemory({
          trackState: appearanceAskedAt ? 'lost' : 'ok',
          identityState: appearanceAskedAt ? 'needs_reselect' : 'user_anchor',
          doubtOpen: doubtSince !== null,
        })) {
          const vis = e.identityDescriptor.region?.visible;
          const obs = {
            tSec: t,
            trackId: 'subject',
            descriptor: e.identityDescriptor.color,
            quality: e.identityDescriptor.quality?.score ?? 0,
            visibility: Array.isArray(vis) && vis.length === 3 ? vis : [true, true, true],
            box: { ...up.box },
            overlapOthers: false,
            crossing: false,
            appearanceJump: false,
            trajectoryBreak: false,
            knownOtherConflict: false,
            cameraOk: cameraDrift?.status !== 'scene_cut' && cameraDrift?.status !== 'inconsistent',
            gmcOk: cameraDrift?.usable !== false,
            trackingLost: false,
            rivalSimilarity: strangerBest,
          };
          const step = appearanceGallery.observe(obs, performance.now());
          if (step.kind === 'state-change') requestAppearanceCheckpoint(true);
          else requestAppearanceCheckpoint(false);
        }
        health.framesSinceReid = 0;
      }

      /* 사용자 앵커 이탈 — 검출기·낯선사람 갤러리가 없어도 돈다.
       *
       * 예전에는 appearanceWeak 이면 외형을 아예 안 재서, 분홍 선수 대신
       * 청록 컨테이너를 잡아도 TRACKING_WARNING 으로 끝까지 갔다.
       * 옆 사람으로 **끌어당기는** 주기 Re-ID 는 그대로 끈다. 여기서는
       * 지금 상자가 처음 고른 옷색과 보류/거절인지만 보고, 세 번 이어지면
       * 사용자에게 묻는다. 문턱 0.62 는 낮추지 않는다. 기억은 안 갱신한다. */
      framesSinceDrift += 1;
      let appearanceDriftAsk = false;
      if (appearanceAskedAt === null && framesSinceDrift >= driftEvery) {
        framesSinceDrift = 0;
        const driftEmb = lastEmbedding;
        if (!driftEmb) {
          /* 이번 프레임에서 추출하지 않았으면 과거 벡터로 이탈을 재지 않는다. */
        } else {
          driftAttempts += 1;
          if (!anchorEmb && (t - anchorTime) <= 1) {
            /* t=0 캔버스가 비어 서술자를 못 만든 경우. 1초 안에는 아직
             * 사용자가 고른 자리이므로 그 첫 성공을 앵커로 쓴다. */
            anchorEmb = driftEmb;
            anchors.add(anchorEmb, jerseyColor(ctx, up.box), { confirmedByUser: true });
          }
          if (!anchorEmb) {
            driftNullEmbeds += 1;
          } else {
            const userSelf = cosine(anchorEmb, driftEmb);
            const drift = nextAnchorDrift({
              self: userSelf,
              samples: driftEmb.samples ?? 0,
              trust: typeof driftEmb.trust === 'number' ? driftEmb.trust : 1,
              run: anchorDriftRun,
              elapsedSec: t - anchorTime,
            });
            anchorDriftRun = drift.run;
            driftLastSelf = userSelf;
            driftLastMatch = drift.match;
            sim = userSelf;
            lastReidSim = userSelf;
            health.lastReid = userSelf;
            measured = true;
            if (drift.action === 'ask_user' && (followThrough || (stopOnAsk && askArmedAt === null))) {
              /* 바로 묻기(stopOnAsk)에서 사용자가 고른 직후 — 아직 한 번도 확실히 잡히지 않았다(무장 전).
               * 여기서 얼리면 멈추지도 못하고(얼린 프레임은 아래 멈춤 검사까지 오지 않는다) 끝까지 얼린 상자로
               * 돌아, 카메라가 그 자리에 선다. 얼리지 않고 그대로 따라간다 — 무장한 뒤 다시 어긋나면 그때 멈춰 묻는다.
               * (2026-09-28 사용자: 「고른 뒤 재추적하고, 다시 놓친 곳에서만 물어라」)
               * followThrough — 사용자가 묻기를 건너뛰었다(「나머지는 기술로」). 얼리지 않고 끝까지 따라간다. */
              driftIgnoredBeforeArm += 1;
              /* 얼리지는 않되 흔적은 남긴다 — 의심 구간이 되어 끝난 뒤 확인 단계가 한 번에 묻는다(ask-cadence). */
              openDoubt(t, 'anchor_appearance_drift');
            } else if (drift.action === 'ask_user') {
              appearanceDriftAsk = true;
              appearanceAskedAt = t;
              frozenAskBox = { ...prevBox };
            }
          }
        }
      }

      /* 카메라가 움직인 만큼은 대상의 이동이 아니다.
       * 보정하지 않으면 Pan 을 "사람이 갑자기 크게 움직였다" 로 읽어
       * bad frame 이 쌓이고 결국 LOST 로 넘어간다. */
      if (camera) cameraDrift = camera.update(this.ctx.canvas, prevBox || null);
      if (lastDetectorRun?.proposals?.length >= 2) {
        tracklets.update({
          t,
          detections: lastDetectorRun.proposals,
          affine: cameraDrift?.affine || null,
          subject: prevBox,
        });
      }
      if (!jerseyLockedOnce && (prevBox || up.box) && this.ctx?.canvas) {
        const seed = prevBox || up.box;
        try {
          const x = Math.max(0, Math.floor(seed.x));
          const y = Math.max(0, Math.floor(seed.y));
          const w = Math.max(8, Math.floor(seed.width));
          const h = Math.max(12, Math.floor(seed.height));
          const pix = this.ctx.getImageData(x, y, Math.min(w, this.ctx.canvas.width - x), Math.min(h, this.ctx.canvas.height - y));
          jerseyLock.remember(readJerseyNumber(pix.data, pix.width, pix.height), true);
          teamSelf = describeTeam(pix.data, pix.width, pix.height);
        } catch { /* 등번호가 안 읽히면 잠그지 않는다 */ }
        jerseyLockedOnce = true;
      }
      if (prevBox && up.observed && up.box) {
        const tracklet = tracklets.decideSwitch(up.box);
        let jersey = null;
        let team = null;
        let courtFar = null;
        try {
          const x = Math.max(0, Math.floor(up.box.x));
          const y = Math.max(0, Math.floor(up.box.y));
          const w = Math.max(8, Math.floor(up.box.width));
          const h = Math.max(12, Math.floor(up.box.height));
          const pix = this.ctx.getImageData(x, y, Math.min(w, this.ctx.canvas.width - x), Math.min(h, this.ctx.canvas.height - y));
          jersey = jerseyLock.decide(readJerseyNumber(pix.data, pix.width, pix.height));
          if (teamSelf) team = decideTeamCue(teamSelf, describeTeam(pix.data, pix.width, pix.height));
        } catch { /* 읽기 실패는 보류일 뿐 */ }
        try {
          if (i % 5 === 0 && this.ctx?.canvas) {
            const cw = 160, ch = 96;
            const tmp = this.courtHintCanvas || (this.courtHintCanvas = document.createElement('canvas'));
            tmp.width = cw; tmp.height = ch;
            tmp.getContext('2d').drawImage(this.ctx.canvas, 0, 0, cw, ch);
            const small = tmp.getContext('2d').getImageData(0, 0, cw, ch);
            const hint = estimateCourtHint(small.data, cw, ch, {
              x: (up.box.x / this.ctx.canvas.width) * cw,
              y: (up.box.y / this.ctx.canvas.height) * ch,
              width: (up.box.width / this.ctx.canvas.width) * cw,
              height: (up.box.height / this.ctx.canvas.height) * ch,
            });
            if (hint.usable && hint.foot) {
              if (lastFoot) {
                const dist = courtFootDistance(lastFoot, hint.foot, ch);
                courtFar = dist != null && dist > 0.35;
              }
              lastFoot = hint.foot;
            }
          }
        } catch { /* 코트 힌트는 실패가 기본값 */ }
        const gated = gateSportsIdentity({
          tracklet,
          jersey,
          team,
          courtFar,
          gapSeconds: kf.since / Math.max(1, analysisFps),
        });
        if (gated.action === 'reject-switch') {
          up.observed = false;
          up.box = { ...prevBox };
          openDoubt(t, 'sports_identity_block', 'watch');
        }
      }
      const cameraUsable = camera && cameraDrift && cameraDrift.usable !== false && cameraDrift.confidence > 0;
      const compensatedPrev = (prevBox && cameraUsable)
        ? applyCameraBox(prevBox)
        : prevBox;

      /* 깎은 신뢰도로 판정한다. 그래야 밖으로 나간 순간 health 가
       * 떨어지고, 떨어져야 복구가 돈다. */
      /* 관측이 살아 있는 동안 conf<0.35 만으로 가림·검출 복구에 넘기지 않는다.
       * 자체 엔진 품질 숫자는 점 개수라 축구에서 거의 매 프레임 0.35 아래가 되고,
       * 그때마다 검출이 사용자 선택을 덮었다. lost·미관측·화면 밖만 가림으로 본다. */
      const motionHolding = up.observed && up.status !== 'lost'
        && visible >= MIN_VISIBLE && up.box && up.box.width > 8 && up.box.height > 8;
      const occluded = motionHolding
        ? false
        : trackerConfidence < CONFIG.OCCLUSION_ENTER_CONFIDENCE;
      const sig = {
        frameIndex: i, timestamp: t, box: up.box, prevBox: compensatedPrev,
        trackerConfidence,
        /* Re-ID 로 LOST 를 판정하지 않는다.
         *
         * OSNet 은 **동시에 놓인 후보 둘 중 누가 더 닮았나** 에는 쓸 만하다.
         * 반면 **시간이 지난 뒤에도 같은 사람인가** 를 절대 임계값으로
         * 묻는 데는 못 쓴다 — 실측(아이스링크): 앵커 ±0.35초에서 같은
         * 사람끼리 0.898 이지만, 17초 동안 같은 사람이 0.48 까지 내려간다.
         * 낯선 사람 최고값 0.715 와 완전히 겹친다.
         *
         * 그 숫자로 임계값(0.6)을 대면 맞게 따라가는 중에도 LOST 가 뜬다.
         * 실제로 그랬다 — 6/6 으로 정확히 따라가는 동안 재획득이 39번
         * 시도되고 OSNet 이 176번 불렸다. 17.8초 영상에 51초가 걸린 이유다.
         *
         * 놓쳤는지는 의미 있는 신호로 판단한다: 추적기 신뢰도와, 갈 수
         * 있는 거리 안에 사람이 없는 상황(게이트 실패). Re-ID 는 후보를
         * 가르는 데만 쓴다. */
        reidSimilarity: 1,
        reidMeasured: false,
        trackerDropped: health.trend.dropped,
        frameWidth: m.width, frameHeight: m.height,
        occluded, predicted: false,
      };

      let res = health.evaluate(sig);
      let step = health.push(res, nLevel);
      let finalBox = up.box;
      let stateOut = step.state;

      /* ── 자세 추정 → 몸통 속도 ─────────────────────────────────────
       *
       * 상자 중심은 팔다리에 흔들린다. 골반·어깨는 덜 흔들린다. 그래서
       * 관절이 잡히면 몸통 중심의 이동으로 속도를 한 갈래 더 잰다.
       *
       * 가중치가 없거나 관절이 안 잡히면 그냥 안 쓴다 — 없는 관절을
       * 상자에서 만들어 채우지 않는다. */
      let frameJoints = null;
      const poseRuntime = this.models.poseRuntime;
      if (poseRuntime?.loaded && up.box && i % poseEveryN === 0) {
        const poseStarted = performance.now();
        try {
          const sx = Math.max(0, Math.floor(up.box.x));
          const sy = Math.max(0, Math.floor(up.box.y));
          const sw = Math.min(m.width - sx, Math.ceil(up.box.width));
          const sh = Math.min(m.height - sy, Math.ceil(up.box.height));
          if (sw > 8 && sh > 16) {
            const crop = ctx.getImageData(sx, sy, sw, sh);
            const decoded = poseRuntime.estimate(crop.data, sw, sh);
            if (decoded) {
              const usable = decoded.filter((j) => j.found && j.x != null && j.y != null);
              if (usable.length) {
                frameJoints = usable.map((j) => ({
                  name: j.name, x: sx + j.x * sw, y: sy + j.y * sh, score: j.score,
                }));
              }
            }
          }
        } catch { frameJoints = null; }
        /* 실제로 걸린 시간을 보고 간격을 고친다. 환산이 틀려도
         * 여기서 잡힌다. */
        poseMs.push(performance.now() - poseStarted);
        if (poseMs.length > 20) poseMs.shift();
        if (poseMs.length >= 8) {
          const sorted = poseMs.slice().sort((a, b) => a - b);
          const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
          const budget = dt * 1000 * POSE_BUDGET_SHARE;
          if (p95 > budget && poseEveryN < POSE_EVERY_N_MAX) {
            poseEveryN += 1;
            poseMs.length = 0;
          } else if (p95 < budget * 0.4 && poseEveryN > POSE_EVERY_N_MIN) {
            poseEveryN -= 1;
            poseMs.length = 0;
          }
          posePeakMs = Math.max(posePeakMs, p95);
        }
      }

      /* 추적 영역 예측. 관측을 넣고 다음 자리를 받아 둔다. */
      try {
        lastRegionPrediction = regionPredictor.observe({
          tSec: t,
          center: null,
          box: measured && up.box ? { ...up.box } : null,
          flowVelocity: null,
          joints: frameJoints,
          detectionConfidence: Number.isFinite(trackerConfidence) ? trackerConfidence : null,
          occlusion: occluded ? 'occluded' : (measured ? 'visible' : 'unknown'),
          frame: { width: m.width, height: m.height },
        }, { horizonSec: dt });
      } catch { lastRegionPrediction = null; }
      /* 외형이 "지금 잡고 있는 것은 내가 아니다" 라고 말했다. 복구로
       * 넘긴다 — 거기서 검출 후보를 외형으로 다시 줄 세운다. */
      if (selfBelowStranger) stateOut = State.LOST;

      /* 🔴 연관 검사를 하지 않는다 — 2026-09-16
       *
       * 여기서 주기적으로 검출을 돌려 "지금 잡고 있는 것이 실제 사람
       * 위인가, 그리고 그 사람이 나인가" 를 확인했다. 이게 **추적이 옆
       * 사람으로 흘러가는 것을 잡아내던 유일한 장치**다. 추적기 자신은
       * 자기가 누구를 잡고 있는지 모르기 때문이다.
       *
       * 검출기가 없으니 이 검사가 돌지 않는다. 그 말은 이제 우리가
       * **추적이 맞는지 틀린지 알 수 없다**는 뜻이다.
       *
       * 그래서 프레임마다 `unverified` 를 찍는다. 아래 doubtSpan 계산과
       * 결과 요약이 이 표시를 보고, 어떤 구간도 "확인됨" 으로 올리지
       * 않는다. 사용자 화면에는 확인되지 않은 구간으로 나온다.
       *
       * 🔴 이 표시를 지우고 싶어지면, 먼저 검출기를 되살려야 한다.
       *    표시만 지우면 틀린 추적이 맞는 추적처럼 보인다. */
      kfPredict();

      /* 검출기가 없을 때는 관측된 자체 추적 상자가 보정이다.
       * 예전에는 검출이 올 때만 kfUpdate 를 불렀다. 검출을 지운 뒤에도
       * 예측만 돌리면 속도 0 인 필터가 처음 자리를 끝까지 붙잡고,
       * 추적기가 옮겨도 화면 상자는 안 움직인다. */
      if (motionHolding) kfUpdate(up.box);

      /* 위치는 필터가 정한다. 추적기는 검출 사이를 메우는 역할이라
       * 필터를 따라오게 다시 맞춘다 — 그래야 탐색 창이 대상 주변에
       * 머문다. 크기는 필터가 들고 있으므로 여기서 바꾸지 않는다. */
      finalBox = kfBox();
      if (kf.since === 0) tracker.reposition(finalBox, { trustSize: true });

      /* --- Re-ID 가 "저 사람이 더 가깝다" 고 하면 즉시 교정한다 ---------
       *
       * 유사도가 낮은 것과 "다른 사람이 더 닮았다" 는 다른 이야기다.
       * 앞은 자세가 바뀐 것일 수 있지만, 뒤는 대상이 바뀐 것이다. */
      if (measured && lastEmbedding && anchors.distractors.length) {
        const v = anchors.verdict(lastEmbedding, reidThreshold, jerseyColor(ctx, up.box));
        if (!v.isSelf) {
          stateOut = State.LOST;
          causes[Cause.SIMILAR_APPEARANCE] = (causes[Cause.SIMILAR_APPEARANCE] || 0) + 1;
          uncertainAt.push(+t.toFixed(3));
          openDoubt(t, 'other_is_closer');
        } else if (v.self !== null
                   && v.self >= (strangerBest === null ? reidThreshold : strangerBest)
                                 + REACQUIRE_REID_MARGIN) {
          /* 낯선 사람 최고값 위로 확실히 올라왔다. 이건 근거 있는 확인이다. */
          closeDoubt(t);
        }
      }

      /* --- 템플릿 갱신 -------------------------------------------------
       *
       * NanoTrack 은 처음 잡은 모습 하나로 끝까지 간다. 사람이 몸을 돌리고
       * 자세가 바뀌면 그 template 과 점점 멀어지고, 결국 놓친다.
       *
       * 그래서 갱신한다. 다만 아무 때나 갱신하면 틀린 대상을 template 으로
       * 삼는 순간 그때부터 계속 틀린다 — 되돌릴 방법이 없다.
       *
       * 조건을 넷 다 만족할 때만 한다.
       *   추적 신뢰도가 아주 높다        지금 잡은 게 확실하다
       *   Re-ID 가 기준 + 여유를 넘는다  그게 나라는 게 확실하다
       *   최근에 갱신하지 않았다          한 방향으로 조금씩 흘러가는 걸 막는다
       *   상태가 정상이다                가림·복구 중에는 하지 않는다
       *
       * 이러면 몇 초에 한 번 정도만 갱신된다. 그 정도면 자세 변화를
       * 따라가기에 충분하고, 잘못 갱신될 위험은 거의 없다. */
      if (stateOut === State.OK && !occluded
          && templateGap >= TEMPLATE_MIN_GAP
          && trackerConfidence >= TEMPLATE_MIN_CONF
          /* 🔴 화면 밖 조각으로 템플릿을 갱신하면 추적기가 영구히
           *    오염된다 — 가장자리 화소를 "대상의 모습" 으로 배운다. */
          && visible >= 0.9
          && sim !== null && sim >= reidThreshold + TEMPLATE_REID_MARGIN) {
        await tracker.refreshTemplate(ctx, finalBox, t);
        templateGap = 0;
        templateRefreshes += 1;
      }

      /* --- Lv1 : 가림이면 모션 예측으로 버틴다 --------------------------
       *
       * 단, 오래 버티지 않는다.
       *
       * 실측에서 conf 0.081(사실상 아무것도 못 찾음)이 15프레임 이어졌는데
       * 상태가 OCCLUDED 에 머물러 NanoDet 을 한 번도 부르지 않았다.
       * OCCLUSION_MAX_FRAMES(30) 에 닿기 전에 영상이 끝나 복구 시도 자체가
       * 없었다 — detectorCalls 0, 재획득 0/0.
       *
       * 가림과 놓침은 겉으로 같아 보인다. 둘 다 confidence 가 떨어진다.
       * 구분하려면 화면 전체를 봐야 한다. 가려진 거면 다른 곳에도 우리
       * 대상이 없고, 놓친 거면 어딘가에 있다.
       *
       * 그래서 일정 프레임 이상 이어지면 검출로 확인한다. 확인 비용은
       * NanoDet 1회(93ms)뿐이고, 놓친 채로 남는 대가보다 훨씬 싸다. */
      if (occluded) {
        occludedRun += 1;
        /* 🟢 2026-09-21 — 가림 예측을 추적 영역 예측기로 바꿨다.
         *
         * 예전에는 최근 몇 프레임 속도의 **이동평균**으로 밀었다. 급정지와
         * 방향 전환에서 그대로 지나쳐 갔다. 지금은 칼만·관측차분·관절
         * 속도를 섞은 예측기가 같은 일을 하고, 신뢰가 낮거나 공백이
         * 길면 스스로 손을 든다(mayFillGap=false).
         *
         * 예측기가 손을 들면 예전 방식으로 물러난다 — 갑자기 아무것도
         * 못 하게 되는 것보다 낫다. */
        let pred = (lastRegionPrediction && lastRegionPrediction.mayFillGap)
          ? {
            x: Math.round(lastRegionPrediction.box.x),
            y: Math.round(lastRegionPrediction.box.y),
            width: Math.round(lastRegionPrediction.box.width),
            height: Math.round(lastRegionPrediction.box.height),
          }
          : occl.predict();
        // 가려진 동안 카메라가 움직였다면 예측 위치도 같이 옮겨야 한다.
        if (pred && camera && cameraDrift.confidence > 0) {
          pred = applyCameraBox(pred);
        }
        if (pred) {
          finalBox = pred;
          tracker.reposition(pred);
          sig.box = pred; sig.predicted = true;
          res = health.evaluate(sig);
          stateOut = State.OCCLUDED;
        } else {
          stateOut = State.LOST;      // 30프레임 초과 -> 포기
        }
        /* 가림이 길어지면 예측으로 버티지 말고 확인한다.
         * 아래 재탐색은 후보만 모으고 ASK_USER 로 간다. NanoDet 는 부르지 않는다. */
        if (occludedRun >= OCCLUSION_VERIFY_AFTER && detectorGap >= CONFIG.DETECTOR_MIN_GAP_FRAMES) {
          stateOut = State.LOST;
        }
      } else {
        occludedRun = 0;
        occl.observe(up.box);
      }

      /* --- 놓쳤다 : 자동 재획득은 하지 않는다 -------------------------
       *
       * 🔴 2026-09-16. 여기에 Lv2 재획득이 있었다. 놓치면 화면을 조각으로
       *    잘라 검출을 돌리고, 나온 후보를 외형·위치·색으로 줄 세워 하나를
       *    골라 추적을 이어 붙였다. 450줄짜리 경로였다.
       *
       * 검출기를 지웠으니 후보가 0개다. 그리고 **후보 없는 재획득은
       * 만들 수 없다.** 여기서 추적기 혼자 다시 찾게 두면 그건 "비슷한
       * 무늬" 를 찾는 것이라 옆 사람을 잡고도 이어 붙인다. 우리가 가장
       * 피해야 할 결과가 그것이다 — 남을 나로 알고 따라가는 것.
       *
       * 그래서 자동으로 잇지 않는다. 놓친 자리에서 멈추고 사용자에게
       * 묻는다. 0.52 에서 잰 숫자가 이 판단의 근거다 — 축구 16초에서
       * 재획득이 161/166 이었고, 그 161번을 검출기가 해 주고 있었다.
       *
       * 사용자가 다시 지정하면 그 자리부터 이어서 추적한다. 지금까지
       * 따라온 구간과 사용자가 고른 구간은 그대로 남는다. */
      if (stateOut === State.LOST) {
        const cause = classifyFailure(res, sig, 0);
        causes[cause] = (causes[cause] || 0) + 1;

        /* 관측이 살아 있으면 사용자에게 넘기지 않는다. 숫자만 낮아
         * LOST 로 올라간 것이고, 상자는 움직이고 있다. */
        if (motionHolding) {
          stateOut = State.WARNING;
        } else if (i <= 3 && (up.reason === 'too_few_points' || up.reason === 'duplicate_frame')) {
          stateOut = State.WARNING;
        } else if (detectorReacquire === true && personDetector) {
          detectorReacquireTried += 1;
          const plan = planDetectorSearch({
            trigger: 'lost',
            framesSinceDetector: detectorGap,
            lastBox: prevBox,
            frameW: FRAME.width,
            frameH: FRAME.height,
            stdX: regionPredictor.spatialCovariance?.()?.stdX ?? null,
            stdY: regionPredictor.spatialCovariance?.()?.stdY ?? null,
            roiWiden: detectorRoiWiden,
            subjectHeightPx: prevBox ? prevBox.height : null,
          });
          let run = null;
          let searchScope = plan.scope;
          try {
            if (detectorGap === 0 && lastDetectorRun) {
              run = lastDetectorRun;
              searchScope = 'reuse-this-frame';
            } else if (plan.scope === 'near-then-expand-then-full' && (plan.near || plan.region)) {
              run = personDetector.proposeFromCanvas(ctx.canvas, {
                scoreMin: DETECTOR_SCORE_MIN.reacquireCandidates,
                timestamp: t, region: plan.near || plan.region,
              });
              detectorCalls += 1;
              if (!run?.proposals?.length && plan.region) {
                run = personDetector.proposeFromCanvas(ctx.canvas, {
                  timestamp: t, region: plan.region,
                  scoreMin: DETECTOR_SCORE_MIN.reacquireCandidates,
                });
                detectorCalls += 1;
                searchScope = 'expand-after-near-empty';
              }
              if (!run?.proposals?.length) {
                run = personDetector.proposeFromCanvas(ctx.canvas, {
                  timestamp: t, scoreMin: DETECTOR_SCORE_MIN.reacquireCandidates,
                  ...slicedOptions(prevBox, lastRegionPrediction),
                });
                detectorCalls += 1;
                searchScope = 'full-after-region-empty';
              }
              lastDetectorRun = run;
              detectorGap = 0;
            } else if (plan.scope === 'region-then-full' && plan.region) {
              run = personDetector.proposeFromCanvas(ctx.canvas, {
                timestamp: t, region: plan.region,
                scoreMin: DETECTOR_SCORE_MIN.reacquireCandidates,
              });
              detectorCalls += 1;
              if (!run?.proposals?.length) {
                run = personDetector.proposeFromCanvas(ctx.canvas, {
                  timestamp: t, scoreMin: DETECTOR_SCORE_MIN.reacquireCandidates,
                  ...slicedOptions(prevBox, lastRegionPrediction),
                });
                detectorCalls += 1;
                searchScope = 'full-after-region-empty';
              }
              lastDetectorRun = run;
              detectorGap = 0;
            } else if (plan.run) {
              run = personDetector.proposeFromCanvas(ctx.canvas, {
                timestamp: t, scoreMin: DETECTOR_SCORE_MIN.reacquireCandidates,
                ...slicedOptions(prevBox, lastRegionPrediction),
              });
              detectorCalls += 1;
              lastDetectorRun = run;
              detectorGap = 0;
            }
          } catch { run = null; }
          lastDetectorRun = run || lastDetectorRun;
          lastPersonNetDiagnose = buildPersonNetDiagnoseResult({
            mode: 'diagnose',
            frameTimestamp: t,
            inferenceMs: 0,
            weightsPresent: false,
            reason: 'personnet-weights-not-shipped-in-browser',
          });
          const props = [];
          const reentryCandidates = [];
          const fixtureLike = (run?.proposals || []).map((p, i) => ({
            id: `det-${t.toFixed(3)}-${i}`,
            box: { x: p.x, y: p.y, width: p.width, height: p.height },
            score: p.detectorScore ?? null,
            source: 'heuristic_not_person',
          }));
          const assigned = assignCandidatesToTracklets(candidateTracklets, fixtureLike, t).assigned;
          const skipCandEmbed = lastReidDecision?.holdJudgment === true;
          for (const p of (run?.proposals || [])) {
            let appearanceSelf = null;
            let samples = 0;
            let trust = 0;
            const persistent = assigned.find((a) => Math.abs(a.box.x - p.x) < 0.5 && Math.abs(a.box.y - p.y) < 0.5) || assigned[props.length];
            const candBox = { x: p.x, y: p.y, width: p.width, height: p.height };
            const cropOk = Math.min(p.width, p.height) >= REID_SCHEDULER_POLICY.minCropPx;
            lastDetectorObservationTrust = detectorObservationTrust({
              connected: !!personDetector,
              weightsPresent: false,
              claimedPersonDetection: false,
              source: 'heuristic_not_person',
              score: p.detectorScore ?? null,
              cropValid: cropOk,
              assignedToTracklet: persistent?.assignedTrackletId != null,
            });
            try {
              if (!skipCandEmbed && cropOk) {
                const emb = await embedCached(ctx, candBox, t);
                appearanceSelf = cosine(anchorEmb, emb);
                if (emb?.partObservation) {
                  const overlaps = (run?.proposals || []).some(other => other !== p && iou(p, other) > 0.2);
                  reentryCandidates.push({ ...emb.partObservation, quality: overlaps ? 0 : emb.partObservation.quality,
                    id: persistent?.id || `cand-${t.toFixed(3)}-${props.length}`,
                    box: candBox,
                    identityDescriptor: emb.identityDescriptor || null,
                    embedding: emb,
                    enteredFromEdge: persistent?.enteredFromEdge === true,
                    assignedTrackletId: persistent?.assignedTrackletId || null,
                    trackletHits: persistent?.trackletHits || 0 });
                }
                samples = reid.lastEmbedDiag?.samples ?? 0;
                trust = reid.lastEmbedDiag?.trust ?? 0;
              }
            } catch { appearanceSelf = null; }
            const cx = p.x + p.width / 2, cy = p.y + p.height / 2;
            const px = prevBox.x + prevBox.width / 2, py = prevBox.y + prevBox.height / 2;
            props.push({
              detectorScore: p.detectorScore,
              appearanceSelf,
              appearanceOther: null,
              motionErrorBodies: Math.hypot(cx - px, cy - py) / Math.max(1, prevBox.height),
              box: p,
              samples,
              trust,
              candidateId: persistent?.id || null,
            });
          }
          const withOthers = fillProposalOthers(props);
          // A failed descriptor must not disappear and make another person unique.
          const reentryResult = reentryMemory.observe(
            reentryCandidates.length === props.length ? reentryCandidates : [], t);
          props.splice(0, props.length, ...withOthers);
          const selves = props.map((p) => p.appearanceSelf).filter((v) => v != null).sort((a, b) => b - a);
          const uniqueMargin = selves.length >= 2 ? selves[0] - selves[1] : 0;
          const best = pickBestByAppearance(props) || props[0] || null;
          const appearanceDecision = decideAppearanceMatch({
            self: best?.appearanceSelf ?? null,
            other: best?.appearanceOther ?? null,
            samples: best?.samples ?? 0,
            trust: best?.trust ?? 0,
          });
          const decision = decideDetectorReacquire({
            mode: 'reacquire',
            proposals: props,
            appearanceDecision,
            gapSeconds: Math.max(0, t - anchorTime),
            uniqueMargin,
          });
          const evidence = buildReacquireEvidence({
            outcome: run?.outcome || 'error',
            proposalCount: props.length,
            searchScope,
            gapSeconds: Math.max(0, t - anchorTime),
            motionErrorBodies: best?.motionErrorBodies ?? null,
            appearanceSelf: best?.appearanceSelf ?? null,
            appearanceDecision,
            uniqueMargin,
            decision,
          });
          reviews.push({
            frame: i, t, cause,
            reason: decision.reason,
            candidates: run?.proposals || [],
            lastBox: { ...prevBox },
            detectorDecision: decision.action,
            multiViewReentry: reentryResult,
            identityState: evidence.identityState,
            searchScope,
            appliedToTracker: productMayApplyIdentity(evidence.identityState)
              || false,
            report: composeTrackReport({
              videoId,
              subjectId,
              timestampSec: t,
              box: best?.box || null,
              trackState: 'searching',
              identityState: evidence.identityState === 'identity_confirmed'
                ? 'target_candidate'
                : (evidence.identityState || 'needs_reselect'),
              failureCause: evidence.identityState === 'detect_failed'
                ? 'detector_miss'
                : 'candidate_without_identity',
              evidence: [decision.reason, `scope:${searchScope}`],
            }),
          });
          events.push({
            frame: i, t, level: 4, ok: false, cause,
            candidates: props.length, decision: decision.action,
            identityState: evidence.identityState,
          });
          /* confirm 이 나와도 제품 상자를 바꾸지 않는다. 검출 ≠ 동일인.
           * 로컬 실험 플래그가 켜진 호출만 잠정 상자를 시험한다. 앵커는 안 바꾼다. */
          const scored = [];
          if (identityMemoryDescs.length) {
            for (const c of reentryCandidates) {
              if (!c.identityDescriptor) continue;
              const pair = scoreIdentityAgainstMemories(identityMemoryDescs, c.identityDescriptor);
              if (!pair) continue;
              pair.evidence.exitEntryPlausible = c.enteredFromEdge === true;
              pair.evidence.trackletContinuous = c.trackletHits >= 3;
              const selfSimilarity = anchors.scoreSelf(c.embedding);
              const trackletConflict = tracklets.decideSwitch(c.box);
              /* 앵커 프레임에서 모은 확정 타인과 직접 견준다. 갤러리가
               * 비어 있으면 conflict 는 false 로 남는다 — "타인이 아니다"
               * 가 아니라 "그 말을 할 근거가 없다" 이다. */
              const otherVerdict = judgeAgainstConfirmedOthers({
                gallery: confirmedOthers,
                selfSimilarity,
                similarity: (entry) => (entry.descriptor && c.identityDescriptor
                  ? scoreIdentityPair(entry.descriptor, c.identityDescriptor).combined
                  : null),
              });
              const galleryOther = anchors.scoreOther(c.embedding);
              const otherSimilarity = otherVerdict.bestSimilarity ?? galleryOther;
              pair.evidence.confirmedOtherSimilarity = otherSimilarity;
              pair.evidence.knownOtherConflict = otherVerdict.conflict
                || (galleryOther != null
                  && selfSimilarity != null
                  && galleryOther >= selfSimilarity + 0.08);
              pair.evidence.simultaneousPresenceConflict = trackletConflict.action === 'block-switch';
              scored.push({
                id: c.id, box: c.box, tSec: t, quality: c.quality ?? c.identityDescriptor.quality.score,
                evidence: pair.evidence, combined: pair.combined,
              });
            }
          }
          for (const row of scored) {
            const tr = candidateTracklets.find((x) => x.id === row.id);
            if (tr?.times?.length) row.observationTimes = tr.times.slice();
          }
          /* 🔴 예측은 **거절만** 한다.
           *
           * 예측 자리에 가까운 후보를 올려 주면 H0/H1/H2 를 통째로
           * 우회한다 — 그 자리에는 누구든 서 있을 수 있기 때문이다.
           * 그래서 "너무 멀다" 만 받고, 거리·점수는 증거 칸에 넣지 않는다. */
          const beforeFirewall = scored.length;
          const useSoftRank = identityRecoveryExperiment === true;
          let survived = scored;
          if (!useSoftRank) {
            survived = scored.filter(
              (row) => !predictionRejectOnly(lastRegionPrediction, row.box),
            );
          }
          const firewallRejected = beforeFirewall - survived.length;
          scored.length = 0;
          if (useSoftRank) {
            const cov = typeof regionPredictor.spatialCovariance === 'function'
              ? regionPredictor.spatialCovariance()
              : null;
            const descMap = new Map();
            for (const c of reentryCandidates) {
              if (c.identityDescriptor?.color) descMap.set(c.id, c.identityDescriptor.color);
            }
            const ranked = rankReentryCandidates({
              candidates: survived,
              descriptors: descMap,
              gallery: (appearanceGallery.gallery() || []).map((s) => ({
                id: `${s.source}:${s.tSec}`,
                descriptor: s.descriptor,
                source: s.source === 'user_anchor' ? 'user_anchor' : 'verified_auto',
                trackId: s.trackId,
                tSec: s.tSec,
                hash: s.hash,
              })),
              enableNeighborRerank: true,
              galleryVersion: appearanceGallery.version,
              neighborCache,
              fusionMode: 'weighted',
              spatialQuality: {
                camera: browserCameraToQuality(cameraDrift),
                covariance: cov,
                predictionUsable: Boolean(lastRegionPrediction?.usable),
                sceneCut: false,
              },
              spatialRef: lastRegionPrediction?.box ? {
                pred: lastRegionPrediction.box,
                stdX: cov?.stdX ?? lastRegionPrediction.uncertaintyPx ?? 24,
                stdY: cov?.stdY ?? lastRegionPrediction.uncertaintyPx ?? 24,
                cameraDx: cameraDrift?.dx || 0,
                cameraDy: cameraDrift?.dy || 0,
                prev: prevBox ? { x: prevBox.x + prevBox.width / 2, y: prevBox.y + prevBox.height / 2 } : null,
                dtSec: dt,
                turning: false,
                zoomLikely: Math.abs((cameraDrift?.scale || 1) - 1) > 0.08,
              } : null,
            });
            scored.push(...ranked);
            if (reviews.length) {
              reviews[reviews.length - 1].rankFusion = ranked[0] ? {
                reason: ranked[0].rankReason,
                rankScore: ranked[0].rankScore,
                appearanceScore: ranked[0].appearanceScore,
                spaceScore: ranked[0].spaceScore,
                fusionHold: ranked[0].fusionHold,
              } : null;
            }
          } else {
            scored.push(...survived);
          }
          if (reviews.length) reviews[reviews.length - 1].predictionFirewallRejected = firewallRejected;
          const hypothesisFrame = identityHypotheses.observe(t, scored);
          const judged = scored.length
            ? judgeReentry({ candidates: scored, sceneCut: false, hypotheses: hypothesisFrame })
            : { action: 'waiting', candidateId: null, reason: 'no-descriptor-candidates', score: null, margin: null, identityConfirmed: false, eligibleForProductAutoReacquire: false, scoreIsProbability: false };
          if (reviews.length) reviews[reviews.length - 1].identityHypotheses = hypothesisFrame;
          const chosenId = judged.candidateId;
          const chosen = reentryCandidates.find((c) => String(c.id) === String(chosenId));
          let reverse = null;
          if (judged.action === 'provisional' && chosen && reverseGrayBuf.length >= 3) {
            reverse = reverseTrackVerify({
              frames: reverseGrayBuf,
              startBox: chosen.box,
              startVideoTSec: t,
              forwardAt: forwardBoxAt,
            });
          }
          const provisional = refineProvisional({
            decision: judged,
            candidateId: judged.candidateId,
            appearanceStillHolds: judged.action === 'provisional' && hypothesisFrame.h1?.futureVerified === true,
            reverseTrack: reverse,
            forward: (hypothesisFrame.h1?.samples || []).map((sample) => ({
              tSec: sample.tSec,
              box: sample.box,
            })),
          });
          const chosenTimes = hypothesisFrame.h1?.samples.map((sample) => sample.tSec) || [];
          const time = temporalReady(chosenTimes);
          const verification = buildIdentityApplyVerification({
            decision: judged,
            provisional,
            expectedCandidateId: judged.candidateId,
            timeReady: time.ready && hypothesisFrame.h1?.futureVerified === true,
            reverseTrackVerified: reverse ? reverse.status === 'verified' : 'not-required',
            sceneCut: false,
          });
          const mayApply = experimentMayApplyIdentity({
            experimentEnabled: identityRecoveryExperiment,
            decision: judged,
            provisional,
            verification,
          });
          if (mayApply && chosen?.box) {
            finalBox = { x: chosen.box.x, y: chosen.box.y, width: chosen.box.width, height: chosen.box.height };
            stateOut = 'REACQUIRED_PROVISIONAL';
            try { tracker.reposition(finalBox, { trustSize: true }); } catch { /* 위치만 맞춘다 */ }
            try { await tracker.refreshTemplate(ctx, finalBox, t); } catch { /* 다음 프레임부터 새 상자 */ }
          } else {
            stateOut = State.ASK_USER;
          }
        } else if (reviews.length === 0) {
          reviews.push({
            frame: i, t, cause,
            reason: personDetector ? (personDetector.reason || 'ask-user-no-auto-reacquire') : DETECTOR_ABSENT.reason,
            candidates: [],
            lastBox: { ...prevBox },
          });
          events.push({ frame: i, t, level: 4, ok: false, cause, candidates: 0 });
          stateOut = State.ASK_USER;
        } else {
          stateOut = State.ASK_USER;
        }
      }

      /* 🔴 마지막 방어선 — 여기가 유일한 길목이다.
       *
       * 상자를 정하는 경로가 여럿이다(추적기 · 필터 · 검출 연관 · 복구 ·
       * 가림 예측). 경로마다 검사를 붙이면 언젠가 하나를 빠뜨리고, 그
       * 하나로 전부 새어 나간다. 실제로 그랬다 — 게이트에만 상한을
       * 걸었더니 다른 경로로 화면을 벗어났다.
       *
       * 그래서 **궤적에 들어가기 직전** 한 곳에서 물리 법칙을 적용한다.
       * 어떤 경로로 정해졌든 여기를 지나야 한다.
       *
       *   1. 한 걸음에 갈 수 있는 거리까지만 인정한다(방향은 남긴다)
       *   2. 화면 밖 좌표는 경계로 되돌린다
       *
       * 궤적은 카메라가 읽는 값이다. 여기 화면 밖 좌표나 순간이동이
       * 들어가면 카메라가 그쪽으로 밀려나고, 사용자에게는 "화면이 갑자기
       * 옆으로 돌아가 다른 사람을 쫓는다" 로 보인다 — 실제 신고가 그것이다. */
      /* 🔴 모르는 동안에는 **알던 자리를 지킨다**.
       *
       * ## 왜 필요한가 — 겹침 영상에서 잡은 결함
       *
       * 대상이 8초 동안 제자리에 서 있었다. 그런데 검출기가 한두 프레임
       * 놓치자 이런 일이 벌어졌다.
       *
       *   2.3초  대상 검출이 없다 -> 게이트가 옆 사람(cx 0.864)을 고른다
       *   3.3초  놓친 시간이 길어져 반경이 넓어진다(82px -> 160px)
       *   4.3초  복구가 오른쪽 아이들(cx 0.90)을 "재획득" 한다
       *   10초~  cx 0.94 에 정착. 재식별이 꺼져 있어 돌아올 길이 없다
       *
       * 핵심은 **예측이 계속 나아간다**는 점이다. 관측이 없는데도 필터는
       * 앞으로 가고, 그 사이 반경이 넓어져 남을 주워 온다.
       *
       * ## 규칙
       *
       * 방금까지 제자리에 있던 대상을 놓쳤다면, 예측으로 나아가지 않고
       * **마지막으로 확인된 자리에 머문다.** 제자리에 있던 사람은 아직
       * 거기 있을 가능성이 가장 높다 — 그게 가장 좋은 추정이다.
       *
       * 근거가 오래되면(2.5초) 이 규칙을 놓는다. 그때는 정말 이동했을
       * 수 있으므로 예측과 넓은 복구에 맡긴다. */
      if (stateOut !== 'REACQUIRED_PROVISIONAL' && !motionHolding && !evidenceJump && restingRecently(t)
          && (stateOut !== State.OK || doubtSince !== null)
          && t - lastConfirmed.t <= REST_HOLD_SECONDS) {
        finalBox = { ...lastConfirmed.box };
        /* 필터도 그 자리로 되돌린다. 위치만 고치고 속도를 남기면 다음
         * 프레임에 같은 방향으로 또 나아간다. */
        kf.x = finalBox.x + finalBox.width / 2;
        kf.y = finalBox.y + finalBox.height / 2;
        kf.vx = 0; kf.vy = 0;
        restHolds += 1;
      }

      /* 🔴 크기부터 붙잡는다 — 순서가 중요하다.
       *
       * 아래 걸음 상한이 "몸 너비의 몇 배" 로 재기 때문에, 상자가 부푼
       * 상태로 들어오면 상한도 함께 부푼다. 실측에서 상자가 대상 너비의
       * 3.2배(0.031 -> 0.099)가 됐고, 그 뒤로 한 걸음에 0.051씩 끌려가
       * 다시 화면 끝까지 갔다. **상자가 스스로 안전장치를 풀었다.**
       *
       * 크기를 먼저 되돌리면 그 아래 규칙들이 제 값으로 돈다. */
      if (prevBox) {
        const scaled = limitScale(prevBox, finalBox, dt, lock.scalePerSecond);
        if (scaled !== finalBox) { finalBox = scaled; scaleLimits += 1; }
      }
      let bandedNow = false;
      {
        /* 속도 상한은 "한 프레임에 얼마나" 만 본다. 3초에 걸쳐 조금씩
         * 부푸는 것은 프레임마다 전부 합법이어서 통과한다 — 실측이
         * 그랬다(0.034 -> 0.087). 그래서 절대 기준으로 한 번 더 자른다. */
        const banded = limitToSizeBand(finalBox, sizeRef, lock.bandLow, lock.bandHigh);
        if (banded !== finalBox) { finalBox = banded; bandLimits += 1; bandedNow = true; }
      }
      if (prevBox && !evidenceJump) {
        const limited = limitStep(prevBox, finalBox, {
          dt, bodyWidth: Math.max(8, prevBox.width),
          /* 여기서도 "제자리" 는 잘 따라가고 있을 때만이다. 놓친 상태의
           * 정지는 대상이 안 움직인 것이 아니라 우리가 못 찾은 것이다. */
          stationary: stationaryNow() && kf.since <= 2,
          appearanceDiscriminative: !appearanceWeak,
        });
        if (limited !== finalBox) {
          teleportVetoes += 1;
          finalBox = limited;
          if (dragRun === 0) {
            /* 끌려가기가 시작된 순간에 대상이 제자리에 있었나. 아래
             * 멈춤 판단에 쓴다 — 이것이 "끌려간다" 와 "뒤처졌다" 를
             * 가르는 신호다. */
            dragStartStationary = stationaryNow();
          }
          dragRun += 1;
          /* 물리적으로 불가능한 이동을 줄였다는 것은 지금 잡고 있는 것이
           * 대상이 아닐 수 있다는 뜻이다. 조용히 넘어가지 않는다. */
          if (stateOut === State.OK) stateOut = State.WARNING;
          openDoubt(t, 'teleport_limited', 'watch');
        } else {
          /* 상한을 건드리지 않았다 = 세상이 우리와 다시 합의했다. */
          dragRun = 0;
          holdRun = 0;
        }

        /* 🔴 끌려가기(drag)를 끊는다.
         *
         * 한 프레임씩 보면 전부 합법이다. 그런데 실측에서 상자는 **상한에
         * 딱 붙은 속도로 다섯 프레임 연속** 오른쪽으로 밀려갔다
         * (0.777 -> 1.000, 0.33초). 걸음 상한은 한 걸음만 보기 때문에
         * 이런 "느린 순간이동" 을 막지 못한다. 그리고 그동안 무늬 점수는
         * 0.72~0.85 로 높았다 — 오른쪽 사람도 검은 옷에 파란 헬멧이라
         * 무늬가 우리를 구해 주지 못한다.
         *
         * 그래서 **횟수**를 본다. 상한을 연속으로 건드린다는 것은 추적기가
         * 계속 "저쪽으로 가야 한다" 고 우기고 물리가 계속 거절하고 있다는
         * 뜻이다. 이 다툼이 세 프레임 이어지면 우기는 쪽이 틀렸다고 보고
         * **아예 멈춘다**. 멈춘 자리에서 다시 찾는다.
         *
         * 멈춰 서는 것이 왜 나은가 — 잘못 끌려가면 화면이 엉뚱한 사람을
         * 크게 비추며 흘러간다. 멈추면 화면은 그 자리에 머문다. 사용자
         * 눈에 전자는 "고장", 후자는 "잠깐 기다림" 이다.
         *
         * 풀려나는 길은 둘이다. 요구가 상한 안으로 돌아오거나(위의 else),
         * 근거를 갖춘 재포착이 들어오거나(evidenceJump 는 이 블록을
         * 건너뛴다). 그래서 영영 얼어붙지 않는다. */
        /* 🔴 멈추는 조건이 하나 더 있다 — **제자리에 있던 대상이었을 때만**
         *    멈춘다.
         *
         * 이걸 빠뜨렸다가 다른 영상을 망가뜨렸다. 빠르게 이동하는 사람을
         * 찍은 clip 에서는 추적기가 맞게 따라가는데도 상한에 계속 걸린다
         * (뒤처져 있으니 매 프레임 "저만큼 가야 한다" 가 상한을 넘는다).
         * 거기서 멈춰 버리면 영영 못 따라잡는다 — 실측에서 17초 내내
         * 한 자리에 얼어붙어 17개 확인점 중 5개만 맞았다.
         *
         * 두 상황은 겉보기에 똑같다(매 프레임 상한에 걸림). 가르는 것은
         * **끌려가기가 시작된 순간에 대상이 제자리에 있었는가** 다.
         * 제자리에 있던 사람은 갑자기 다섯 걸음을 갈 수 없다 — 그러니
         * 우기는 쪽이 틀렸다. 원래 움직이던 사람이면 우리가 뒤처진
         * 것이고, 그때는 따라가야 한다.
         *
         * 멈춤에는 시한도 둔다. 판단이 틀렸을 때 영영 얼어붙지 않도록
         * 2초(24프레임)가 지나면 풀고 다시 따라가 본다. */
        if (dragRun >= DRAG_HOLD_AFTER && dragStartStationary
            && holdRun < MAX_HOLD_FRAMES) {
          finalBox = prevBox;
          dragHolds += 1;
          holdRun += 1;
          stateOut = State.WARNING;
          openDoubt(t, 'dragged');
          /* 멈춘 채로 가만히 있으면 안 된다. 다음 프레임에 다시 찾도록
           * Re-ID 를 강제로 깨운다. */
          health.framesSinceReid = 1e9;
        } else if (holdRun >= MAX_HOLD_FRAMES) {
          /* 시한이 지났다. 한 번 풀어 주고 처음부터 다시 센다. */
          holdRun = 0;
          dragRun = 0;
        }
      } else if (evidenceJump) {
        dragRun = 0;
      }
      if (hasEscaped(finalBox, FRAME)) {
        finalBox = clampToFrame(finalBox, FRAME);
        escapeClamps += 1;
      }

      /* 🔴 지켜봄이 길어지면 위험으로 올린다.
       *
       * "지금 안 보이지만 어디 있는지는 안다" 는 주장은 시간이 지나면
       * 약해진다. 2초 넘게 아무 확인도 없었다면 그건 정말로 모르는
       * 것이고, 그때는 사용자에게 말해야 한다. */
      if (doubtSince !== null && doubtLevel === 'watch'
          && t - doubtSince > WATCH_GRACE_SECONDS) {
        doubtLevel = 'risk';
      }

      let askCause = 'anchor-appearance-drift';
      if (anchorAskNow && !appearanceDriftAsk && appearanceAskedAt === null && prevBox) {
        appearanceDriftAsk = true;
        appearanceAskedAt = t;
        frozenAskBox = { ...prevBox };
        askCause = anchorAskCause || 'detector-person-elsewhere';
      }
      if (appearanceDriftAsk) {
        stateOut = State.ASK_USER;
        if (frozenAskBox) {
          finalBox = { ...frozenAskBox };
          try { tracker.reposition(finalBox); } catch { /* 위치만 되돌린다 */ }
        }
        if (reviews.length === 0
            || reviews[reviews.length - 1].reason !== askCause) {
          reviews.push({
            frame: i, t, cause: askCause,
            reason: askCause,
            candidates: [],
            lastBox: { ...prevBox },
          });
          events.push({
            frame: i, t, level: 4, ok: false,
            cause: askCause, candidates: 0,
          });
        }
        openDoubt(t, askCause.replace(/-/g, '_'));
      }

      trajectory.push({
        frame: i, t, box: finalBox, state: stateOut,
        /* 가림 구간을 메울 때만 상자에 쓰인다(mayFillGap). 신원 판정에는
         * 어떤 경로로도 들어가지 않는다 — prediction-identity-firewall 참조. */
        regionPrediction: lastRegionPrediction && {
          center: lastRegionPrediction.center,
          box: lastRegionPrediction.box,
          framing: lastRegionPrediction.framing,
          velocity: lastRegionPrediction.velocity,
          speedBodies: lastRegionPrediction.speedBodies,
          visibility: lastRegionPrediction.visibility,
          uncertaintyPx: lastRegionPrediction.uncertaintyPx,
          usable: lastRegionPrediction.usable,
          reason: lastRegionPrediction.reason,
          widenFactor: lastRegionPrediction.widenFactor,
          reconciling: lastRegionPrediction.reconciling,
          mayFillGap: lastRegionPrediction.mayFillGap,
          poseJoints: frameJoints ? frameJoints.length : 0,
          appliedToTrajectory: Boolean(occluded && lastRegionPrediction.mayFillGap),
          identityClaim: false,
        },
        health: res.health, reid: sim, confidence: trackerConfidence,
        badRatio: step.badRatio, measured,
        trackerStatus: up.status, trackerReason: up.reason,
        pointsKept: up.pointsKept, pointsUsed: up.pointsUsed,
        observed: up.observed,
        /* 이 프레임이 "사용자에게 확인을 받아야 하는" 상태인가.
         *
         * 원래 규칙은 "등급이 risk 일 때만 참" 이었다. watch(가려져 있지만
         * 자리는 안다)는 알려 주기만 하고 묻지 않았다 — 사용자 요청 7번.
         *
         * 🔴 2026-09-16 부터 **모든 프레임이 참이다.**
         *
         * 이 판정을 만들던 근거가 연관 검사였다. 검출을 돌려 "지금 잡고
         * 있는 것이 정말 나인가" 를 확인하고, 그 결과로 의심을 열고
         * 닫았다. 검출기를 지웠으니 그 근거가 없다 — 지금은 어떤 프레임도
         * 확인된 적이 없다.
         *
         * 재 본 적 없는 것을 "확인됨" 으로 두면 사용자는 그 궤적을 믿고
         * 영상을 만든다. 옆 사람을 따라간 궤적이어도 알 길이 없다. */
        unverified: true,
        watching: doubtSince !== null && doubtLevel === 'watch',
        identityLifecycle: mapPipelineStateToLifecycle(stateOut, stateOut !== State.OK),
        nearbyBoxes: (lastDetectorRun?.proposals || [])
          .filter((p) => p !== up.box)
          .slice(0, 8)
          .map((p) => ({ x: p.x, y: p.y, width: p.width, height: p.height })),
      });

      if (stopOnAsk) {
        if (askArmedAt === null) {
          /* 의심 래치(doubtSince)는 무장 조건에 넣지 않는다 — 초반에 열린 의심이 끝까지 이어지면 한 번도 무장하지
           * 못해, 옆 사람으로 옮겨 간 순간(빙상장 0155, 7.6초)에도 묻지 않았다(2026-09-28 흉내 측정). */
          if (stateOut === State.OK) {
            if (askOkSince === null) askOkSince = t;
            /* askNotBefore — 사용자가 「여기 없어요」라고 한 구간 안에서는 다시 묻지 않는다(그 끝부터 무장한다). */
            if (t - askOkSince >= askRearmSec && (askNotBefore === null || t >= askNotBefore)) askArmedAt = t;
          } else askOkSince = null;
        }
        if (stateOut === State.ASK_USER) { if (askRunStart === null) askRunStart = t; }
        else askRunStart = null;
        /* 무장 전에 생긴 외형 어긋남 · 확인 상태는 같은 헷갈림의 연장이다 — 멈추지 않는다. */
        const drift = askArmedAt !== null && appearanceDriftAsk && appearanceAskedAt !== null && appearanceAskedAt >= askArmedAt;
        const askRun = askArmedAt !== null && askRunStart !== null && askRunStart >= askArmedAt
          && t - askRunStart >= STOP_ASK_SECONDS;
        if (drift || askRun) {
          stoppedForAsk = {
            t: drift ? appearanceAskedAt : askRunStart,
            reason: drift ? 'anchor-appearance-drift' : 'ask-user',
            /* 무엇이 헷갈림을 알렸나(진단용). reason 은 편집기 화면 문구가 쓰므로 예전 값을 그대로 둔다. */
            cause: drift ? askCause : 'ask-user',
            /* 마지막으로 근거를 갖고 확인한 자리 — 사람 후보를 고를 때 가까운 쪽을 먼저 보여 준다. */
            lastBox: lastConfirmed ? { ...lastConfirmed.box } : (prevBox ? { ...prevBox } : null),
          };
          break;
        }
      }

      /* 근거를 갖고 확인된 프레임만 되그리기의 출발점이 된다.
       *
       * 조건이 셋이다 — 상태가 정상이고, 의심이 열려 있지 않고, 이
       * 프레임에서 실제로 무언가를 **측정했다**(Re-ID 또는 검출 연결).
       * 예측만으로 흘러간 프레임을 출발점으로 삼으면 되그리기가
       * 짐작에서 출발하게 되고, 그러면 고치는 의미가 없다. */
      if (stateOut === State.OK && doubtSince === null && (measured || detectorGap === 0)) {
        lastConfirmed = { t, box: { ...finalBox } };
        /* 색 기준선은 여기서만 배운다. "확인된 프레임에서 우리 자신이 보통
         * 어느 정도로 닮아 보이는가" 가 기준이어야 하기 때문이다. */
        if (pickColorNow !== null) {
          selfColorSamples += 1;
          const alpha = selfColorSamples <= COLOR_SELF_MIN_SAMPLES
            ? 1 / selfColorSamples    // 초반에는 단순 평균으로 빠르게 세운다
            : 0.05;                   // 그 뒤에는 천천히 따라간다
          selfColorLevel += (pickColorNow - selfColorLevel) * alpha;
        }
      }

      /* 기준 크기를 배우는 자리.
       *
       * 조건이 둘이다 — **검출을 실제로 이어 붙였고**(또는 확인된
       * 프레임이고), **이 프레임에서 크기를 자르지 않았다**.
       *
       * 신원 의심이 열려 있어도 크기는 배운다. 크기와 신원은 다른
       * 문제다. 의심이 몇 초씩 열려 있는 영상에서 기준을 얼려 두면,
       * 카메라 쪽으로 다가와 실제로 커진 사람을 계속 작게 잘라내게 된다
       * — 실측에서 그 영상이 여기서 다시 대상을 놓쳤다.
       *
       * 🔴 잘린 프레임에서는 배우지 않는다. 이걸 빠뜨렸다가 **깔쭉이
       *    (ratchet)** 를 만들었다 — 상자가 띠 위쪽 끝(1.7배)에 붙으면
       *    기준이 그쪽으로 2%씩 따라가고, 기준이 커지면 띠도 같이
       *    커져서 상자가 또 끝에 붙는다. 잘린 프레임은 "우리가 거절한
       *    크기" 이므로 배울 값이 아니다. */
      if (!bandedNow && stateOut === State.OK && doubtSince === null
          && (measured || detectorGap === 0)) {
        sizeRef.width += (finalBox.width - sizeRef.width) * SIZE_REF_ALPHA;
        sizeRef.height += (finalBox.height - sizeRef.height) * SIZE_REF_ALPHA;
        /* 기준도 원본에서 너무 멀어지지 못한다.
         *
         * 잘린 프레임을 빼도 느린 깔쭉이가 남는다 — 상자가 띠 안쪽
         * 가장자리(1.6배쯤)에 계속 머물면 기준이 조금씩 그쪽으로 가고,
         * 기준이 가면 띠도 간다. 실측에서 상자가 사용자가 고른 크기의
         * 2.3배까지 자랐다. 사용자가 고른 상자가 우리가 가진 가장 좋은
         * 정답이므로, 기준은 그 둘레를 벗어나지 않는다. */
        sizeRef.width = Math.min(origin.width * refCeilW,
          Math.max(origin.width * refFloorW, sizeRef.width));
        sizeRef.height = Math.min(origin.height * refCeilH,
          Math.max(origin.height * refFloorH, sizeRef.height));
      }
      prevBox = finalBox;

      if (i % 5 === 0 || i === total - 1) {
        this.onProgress({
          phase: 'track', frame: i, total,
          percent: Math.round((i / total) * 100),
          state: stateOut, health: res.health, reid: sim,
          fps: i / ((performance.now() - t0) / 1000),
          playbackRate: rate,
          /* 지금 따라가고 있는 자리.
           *
           * 이걸 안 보내면 화면은 진행률 숫자만 받는다. 그러면 추적이
           * 도는 내내 정지 화면을 보게 되고, 사용자는 자기가 제대로
           * 잡히고 있는지 알 수 없다 — 몇 분을 기다린 뒤 결과를 보고서야
           * 안다. 좌표는 이미 여기 있으므로 실어 보내는 값이 거의 없다.
           *
           * 원본 픽셀 좌표다. 정규화는 받는 쪽이 한다 — 여기서 나누면
           * 파이프라인이 화면의 표현 방식을 알게 된다. */
          t, box: finalBox,
        });
      }

      // 영상이 끝나면 루프 카운터와 무관하게 멈춘다. 순차 디코딩에서는
      // 실제 프레임 수가 예상치와 다를 수 있다.
      if ((sequential && this.video.ended) || lastT >= m.duration - dt * 0.5) break;
    }

    this._stopPlayback();

    /* 끝까지 확인되지 않은 의심은 조용히 사라지면 안 된다.
     * 영상 끝까지 이어지는 미해결 구간으로 남겨 사용자에게 보여준다. */
    if (doubtSince !== null) {
      doubtSpans.push({
        start: +doubtSince.toFixed(3),
        end: +lastT.toFixed(3),
        reason: doubtReason,
        level: doubtLevel,
        resolved: false,
      });
    }
    /* 너무 짧은 구간은 묻지 않는다 — 잠깐 흔들린 것까지 물으면 번거롭다.
     * 다만 미해결 구간은 길이와 무관하게 남긴다. */
    const minSpan = 2 / Math.max(1, analysisFps);
    const spans = doubtSpans.filter((d) => !d.resolved || (d.end - d.start) >= minSpan);

    requestAppearanceCheckpoint(true);
    /* GPU 계산판은 대상마다 GPU 버퍼를 쥔다. 다 돌았으면 돌려준다(중간에 던진 경우는 가비지 수집이 거둔다). */
    if (gpuCompute.used) { try { tracker.dispose?.(); } catch { /* 정리 실패는 결과를 바꾸지 않는다 */ } }

    const elapsed = (performance.now() - t0) / 1000;
    const reidVals = trajectory.filter((p) => p.reid !== null && p.reid !== undefined)
                               .map((p) => p.reid);
    return {
      meta: m,
      trajectory, events, reviews, causes, uncertainAt,
      /* stopOnAsk 로 멈췄으면 그 시각·사유(아니면 null). 궤적은 그 시각 직후까지만 있다. */
      stoppedForAsk,
      /* 확인이 안 된 구간. 시각 목록(uncertainAt)과 달리 시작·끝이 있고,
       * resolved:false 면 영상 끝까지 확인되지 않았다는 뜻이다. */
      doubtSpans: spans,
      /* 🔴 이 결과가 어떤 상태에서 나왔는가 — 2026-09-16
       *
       * 부르는 쪽이 이 칸을 보고 "확인된 추적" 이라고 말하지 않게 한다.
       * 숫자만 돌려주면 화면은 예전과 똑같이 그리고, 사용자는 예전과
       * 똑같이 믿는다. 무엇이 꺼져 있는지는 결과 안에 있어야 한다.
       *
       * `verified: false` 는 "틀렸다" 가 아니라 **"맞는지 확인한 적이
       * 없다"** 는 뜻이다. 둘은 다르고, 사용자에게도 그렇게 말해야 한다. */
      detector: personDetector?.weights?.modelId
        ?? (personDetector ? 'hilit-stand-energy-v0' : 'absent'),
      poseEstimator: this.models.poseRuntime?.loaded
        ? this.models.poseRuntime.modelId
        : 'absent',
      poseEveryN,
      posePeakMs: Number.isFinite(posePeakMs) ? Math.round(posePeakMs * 100) / 100 : null,
      detectorScoreMin: {
        confirmedOtherGallery: DETECTOR_SCORE_MIN.confirmedOtherGallery,
        reacquireCandidates: DETECTOR_SCORE_MIN.reacquireCandidates,
        userFacingProposals: DETECTOR_SCORE_MIN.userFacingProposals,
      },
      detectorReason: personDetector?.reason || (personDetector ? null : DETECTOR_ABSENT.reason),
      detectorSince: DETECTOR_ABSENT.since,
      personNetDiagnose: lastPersonNetDiagnose,
      autoRecovery: detectorReacquire === true ? 'gated-ask-user' : 'disabled',
      verified: false,
      metrics: {
        frames: trajectory.length,
        analysisSeconds: elapsed,
        analysisFps: trajectory.length / Math.max(elapsed, 1e-6),
        chosenAnalysisFps: analysisFps,
        riskyReidGap: riskyGapFloor,
        reidCalls, detectorCalls,
        reacquireTried, reacquireOk, detectorReacquireTried,
        detectionAnchor: personProbe ? { probes: anchorProbes, corrections: anchorCorrections, asks: anchorAsks, crossings: anchorCrossings, crossHolds: anchorCrossHolds, reasons: anchorReasons, ...(anchorCfg.debug ? { log: anchorLog } : {}) } : null,
        absenceEdgeExperiment: absenceEdgeExperiment === true,
        edgeAbsenceAsks,
        continuityExperiment: continuityExperiment === true,
        continuityAsks,
        /* 조각 검출을 몇 번 썼고, 가림 구간을 몇 프레임 되그렸나.
         * 개선이 실제로 도는지 이 두 숫자로 확인한다. */
        slicedReacquires, reweaveFrames, anchorAdapts: anchors.adaptCount,
        /* 마지막 방어선이 몇 번 일했나. 0 이 아니면 어딘가에서 폭주가
         * 시작됐다는 뜻이고, 그 자체가 진단이다. */
        escapeClamps, teleportVetoes, scaleLimits, bandLimits, dragHolds, restHolds,
        switchAlarms, viewAdds,
        surpriseChecks, confirmedAnchorUses,
        viewAnchors: anchors.viewCount, appearanceWentWeakAt,
        gateAccepts, gateRejects, gateAmbiguous, undecided, gateTrace,
        appearanceWeak, strangerBest, selfMin, strangerColorBest, separabilityError,
        ...(identityDiag ? { identityEvents } : {}),
        askUser: reviews.length,
        appearanceDriftWired: typeof nextAnchorDrift === 'function',
        appearanceAnchorOk: !!anchorEmb,
        appearanceDriftAttempts: driftAttempts,
        appearanceDriftNulls: driftNullEmbeds,
        appearanceDriftIgnoredBeforeArm: driftIgnoredBeforeArm,
        /* 바로 묻기가 무장한 시각(진단용). null 이면 끝까지 무장하지 못했다 — 그 찾기에서는 멈춰 묻지 않았다. */
        askArmedAt,
        appearanceDriftLastSelf: driftLastSelf,
        appearanceDriftLastMatch: driftLastMatch,
        appearanceAskedAt,
        appearanceEmbedDiag: reid.lastEmbedDiag || null,
        appearancePersistMode: appearanceGallery.persist,
        appearanceRecoveryKind,
        appearanceGalleryBytes: appearanceGallery.estimatedBytes(),
        appearanceGalleryVersion: appearanceGallery.version,
        appearanceTentativeRamOnly: appearanceGallery.tentativeCount,
        appearanceSaveP50: appearanceGallery.percentile(appearanceGallery.saveLatencies, 50),
        appearanceSaveP95: appearanceGallery.percentile(appearanceGallery.saveLatencies, 95),
        serverCalls: 0,          // 브라우저 단독 — 서버를 부르지 않는다
        gpuCostKrw: 0,
        reidMean: reidVals.length ? reidVals.reduce((a, b) => a + b, 0) / reidVals.length : null,
        reidMin: reidVals.length ? Math.min(...reidVals) : null,
        // ?? 는 NaN 을 잡지 못한다. 유한한 값만 평균에 넣고, 버린 개수를
        // 따로 남겨서 조용히 틀리지 않게 한다.
        healthMean: (() => {
          const v = trajectory.map((p) => p.health).filter(Number.isFinite);
          return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
        })(),
        nonFiniteHealthFrames:
          trajectory.filter((p) => !Number.isFinite(p.health)).length,
        lostFrames: trajectory.filter((p) => p.state === State.LOST
                                         || p.state === State.ASK_USER).length,
        nLevel, reidThreshold,
        trackerCore: coreKind,
        computeBackend: gpuCompute,
        sizeLock: lock.name,
        // 추적이 실제로 덮은 구간. 사용자가 고른 시각부터 끝까지다.
        trackedStart: anchorTime,
        trackedEnd: trajectory.length ? trajectory[trajectory.length - 1].t : anchorTime,
        decodeMode: sequential
          ? (this._hasRvfc ? 'sequential-rvfc' : 'sequential-raf')
          : 'seek-fallback',
        finalPlaybackRate: rate,
        cameraCompensation: !!camera,
        anchorCount: anchors.embeddings.length,
        distractorCount: anchors.distractors.length,
        confirmedOtherGallery: {
          entries: confirmedOthers.entries.length,
          userRejected: userRejectedAdded,
          rejected: confirmedOthers.rejected.length,
          detectorAvailable: confirmedOthers.detectorAvailable,
          basis: 'anchor-frame-simultaneous',
          userConfirmed: false,
        },
        assocChecks, assocFixes, assocAmbiguous, templateRefreshes,
        colorVetoes, reacquireOverrides, reacquireJumps, restOverrides, anchorOverrides, reacquireUnconfirmed,
        wideSearches, wideColorVetoes, wideColorFallbacks,
        spentDecodeMs: Math.round(spent.decode), spentTrackerMs: Math.round(spent.tracker),
        spentDetectorMs: Math.round(spent.detector), spentReidMs: Math.round(spent.reid),
        spentColorMs: Math.round(spent.color),
        spentCheapQualityMs: Math.round(spent.cheapQuality),
        reidScheduleMode: reidScheduler.mode,
        reidScheduler: reidScheduler.metrics(),
        featureCacheHits: featureCache.hits,
        featureCacheMisses: featureCache.misses,
        jaccardCacheHits: neighborCache.hits,
        detectorObservationTrust: lastDetectorObservationTrust,
        colorPickMean: colorPickCount ? +(colorPickSum / colorPickCount).toFixed(3) : null,
        selfColorLevel: selfColorSamples ? +selfColorLevel.toFixed(3) : null,
        doubtSpanCount: spans.length,
        unresolvedSpanCount: spans.filter((d) => !d.resolved).length,
        unverifiedFrames: trajectory.filter((pt) => pt.unverified).length,
      },
      limits: {
        cutieRecovery: false,          // Lv3 없음
        cameraMotionCompensation: false, // 미이식
      },
    };
  }

  /** 사용자가 Lv4 구간을 확인해 주면 그 프레임을 앵커로 삼고 이어서 간다. */
  async confirm(result, frameIndex, box, anchors, reidModel) {
    const t = frameIndex / this.meta.analysisFps;
    const ctx = await this.seekDraw(t);
    const e = await reidModel.embed(ctx, box);
    anchors.add(e, jerseyColor(ctx, box), { confirmedByUser: true });
    return { ok: true, frame: frameIndex, box };
  }

  dispose() {
    this.disposed = true;
    this.cancelOpen?.();
    this.cancelOpen = null;
    this._stopPlayback();
    try { this.video?.removeAttribute('src'); this.video?.load(); } catch { /* noop */ }
    if (this.video?.parentNode) this.video.parentNode.removeChild(this.video);
    if (this.url) URL.revokeObjectURL(this.url);
    this.video = null; this.url = null; this.ctx = null;
  }
}

function openAbortError() {
  const error = new Error('영상 열기를 취소했습니다.');
  error.name = 'AbortError';
  return error;
}

export { State, Cause };
