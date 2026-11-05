#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
/**
 * 웹과 Android 네이티브 추적 상수가 갈라졌는지 본다.
 *
 *   node scripts/check-android-tracking-parity.mjs
 *   node scripts/check-android-tracking-parity.mjs --self-test
 *
 * 왜 필요한가: 같은 규칙을 두 언어로 적어 두면 한쪽만 고치는 일이 반드시
 * 생긴다. 그러면 같은 영상에서 웹과 앱이 다른 결과를 내고, 사용자는 그걸
 * "앱이 이상하다" 로 겪는다. 그런데 이 저장소에는 JDK 가 없어 Java 를
 * 컴파일해 볼 수 없다 — 그래서 **숫자만이라도** 기계로 맞춰 둔다.
 *
 * 값을 바꿀 때는 두 파일을 같이 고치고 이 검사를 돌린다.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime');
const selfTest = process.argv.includes('--self-test');

function read(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/** `name: 0.42,` 또는 `name = 0.42;` 에서 숫자를 뽑는다. */
function num(text, pattern, label) {
  const match = text.match(pattern);
  if (!match) throw new Error(`찾지 못했습니다: ${label}`);
  const value = Number(match[1]);
  if (!Number.isFinite(value)) throw new Error(`숫자가 아닙니다: ${label} = ${match[1]}`);
  return value;
}

const ts = {
  predict: read('packages/hilit-vision/src/track-region-prediction.ts'),
  firewall: read('packages/hilit-vision/src/prediction-identity-firewall.ts'),
  thresholds: read('packages/hilit-vision/src/detector-thresholds.ts'),
  scheduler: read('packages/hilit-vision/src/reid-scheduler.ts'),
  gallery: read('packages/hilit-vision/src/appearance-gallery.ts'),
  gate: read('packages/hilit-vision/src/reacquire-trajectory-gate.ts'),
  gmcVerify: read('packages/hilit-vision/src/gmc-verification.ts'),
  gmcBrowser: read('apps/web/public/tracking/affine-gmc.js'),
};
const java = {
  predict: read('apps/android/app/src/main/java/app/hilit/mobile/HilitTrackRegionPrediction.java'),
  firewall: read('apps/android/app/src/main/java/app/hilit/mobile/HilitPredictionFirewall.java'),
  thresholds: read('apps/android/app/src/main/java/app/hilit/mobile/HilitDetectorThresholds.java'),
  scheduler: read('apps/android/app/src/main/java/app/hilit/mobile/NativeReidScheduler.java'),
  gallery: read('apps/android/app/src/main/java/app/hilit/mobile/NativeAppearanceCheckpoint.java'),
  engine: read('apps/android/app/src/main/java/app/hilit/mobile/NativeTrackingEngine.java'),
  gate: read('apps/android/app/src/main/java/app/hilit/mobile/HilitReacquireGate.java'),
  gmc: read('apps/android/app/src/main/java/app/hilit/mobile/AffineGmc.java'),
};

const tsKey = (name) => new RegExp(`${name}:\\s*([0-9.]+)`);
const javaKey = (name) => new RegExp(`${name}\\s*=\\s*([0-9.]+)`);

/** `export const NAME = 0.42;` 에서 숫자를 뽑는다(브라우저 사본용). */
const jsConst = (name) => new RegExp(`${name}\\s*=\\s*([0-9.]+)`);

const checks = [
  // GMC 근거 게이트 — TS 본체 · 브라우저 사본 · 앱 세 곳이 같아야 한다
  ['GMC 잔차 상한(웹↔앱)', ts.gmcVerify, tsKey('maxResidualP90'), java.gmc, javaKey('MAX_RESIDUAL_P90')],
  ['GMC 격자 칸 하한(웹↔앱)', ts.gmcVerify, tsKey('minGridCells'), java.gmc, javaKey('MIN_GRID_CELLS')],
  ['GMC 인라이어 비율(웹↔앱)', ts.gmcVerify, tsKey('minInlierRatio'), java.gmc, javaKey('MIN_INLIER_RATIO')],
  ['GMC 인라이어 수(웹↔앱)', ts.gmcVerify, tsKey('minInlierCount'), java.gmc, javaKey('MIN_INLIER_COUNT')],
  ['GMC 경쟁 변환 상한(웹↔앱)', ts.gmcVerify, tsKey('maxRivalSupportRatio'), java.gmc, javaKey('MAX_RIVAL_SUPPORT')],
  ['GMC 배경 비율(웹↔앱)', ts.gmcVerify, tsKey('minBackgroundShare'), java.gmc, javaKey('MIN_BACKGROUND_SHARE')],
  // 같은 값을 브라우저 사본과도 맞춘다
  ['GMC 잔차 상한(본체↔브라우저)', ts.gmcVerify, tsKey('maxResidualP90'), ts.gmcBrowser, jsConst('GMC_MAX_RESIDUAL_P90')],
  ['GMC 격자 칸 하한(본체↔브라우저)', ts.gmcVerify, tsKey('minGridCells'), ts.gmcBrowser, jsConst('GMC_MIN_GRID_CELLS')],
  ['GMC 인라이어 비율(본체↔브라우저)', ts.gmcVerify, tsKey('minInlierRatio'), ts.gmcBrowser, jsConst('GMC_MIN_INLIER_RATIO')],
  ['GMC 인라이어 수(본체↔브라우저)', ts.gmcVerify, tsKey('minInlierCount'), ts.gmcBrowser, jsConst('GMC_MIN_INLIER_COUNT')],
  ['GMC 경쟁 변환 상한(본체↔브라우저)', ts.gmcVerify, tsKey('maxRivalSupportRatio'), ts.gmcBrowser, jsConst('GMC_MAX_RIVAL_SUPPORT')],
  // 재획득 확정 절차 — 웹과 앱이 같은 자리에서 같은 규칙으로 잠정 구간을 만든다
  ['재획득 최소 관측 수', ts.gate, tsKey('minObservations'), java.gate, javaKey('MIN_OBSERVATIONS')],
  ['재획득 최소 확인 시간', ts.gate, tsKey('minConfirmSec'), java.gate, javaKey('MIN_CONFIRM_SEC')],
  ['재획득 최소 확인 시간(어려움)', ts.gate, tsKey('minConfirmSecHard'), java.gate, javaKey('MIN_CONFIRM_SEC_HARD')],
  ['무시할 공백 길이', ts.gate, tsKey('ignoreGapShorterThanSec'), java.gate, javaKey('IGNORE_GAP_SHORTER_THAN_SEC')],
  ['어려운 공백 기준', ts.gate, tsKey('hardGapSec'), java.gate, javaKey('HARD_GAP_SEC')],
  ['잠정 신뢰도 상한', ts.gate, tsKey('tentativeConfidenceCap'), java.gate, javaKey('TENTATIVE_CONFIDENCE_CAP')],
  // 추적 영역 예측
  ['예측 구간', ts.predict, tsKey('horizonSec'), java.predict, javaKey('HORIZON_SEC')],
  ['가림 버티기 한계', ts.predict, tsKey('maxCoastSec'), java.predict, javaKey('MAX_COAST_SEC')],
  ['속도 상한(몸)', ts.predict, tsKey('maxSpeedBodies'), java.predict, javaKey('MAX_SPEED_BODIES')],
  ['EMA 계수', ts.predict, tsKey('emaAlpha'), java.predict, javaKey('EMA_ALPHA')],
  ['처리 잡음', ts.predict, tsKey('processAccel'), java.predict, javaKey('PROCESS_ACCEL')],
  ['관측 잡음 바닥', ts.predict, tsKey('measureNoisePx'), java.predict, javaKey('MEASURE_NOISE_PX')],
  ['가림 잡음 배수', ts.predict, tsKey('occludedNoiseScale'), java.predict, javaKey('OCCLUDED_NOISE_SCALE')],
  ['가림 감쇠', ts.predict, tsKey('coastDecayPerSec'), java.predict, javaKey('COAST_DECAY_PER_SEC')],
  ['대상 화면 점유', ts.predict, tsKey('subjectShare'), java.predict, javaKey('SUBJECT_SHARE')],
  ['리드룸', ts.predict, tsKey('leadRoom'), java.predict, javaKey('LEAD_ROOM')],
  ['크기 이득', ts.predict, tsKey('sizeGain'), java.predict, javaKey('SIZE_GAIN')],
  ['불확실 기준(몸)', ts.predict, tsKey('uncertaintyFullBodies'), java.predict, javaKey('UNCERTAINTY_FULL_BODIES')],
  ['최대 확장', ts.predict, tsKey('maxWiden'), java.predict, javaKey('MAX_WIDEN')],
  ['프레이밍 속도 상한', ts.predict, tsKey('maxFramingSpeed'), java.predict, javaKey('MAX_FRAMING_SPEED')],
  ['프레이밍 확대 속도', ts.predict, tsKey('maxFramingZoomRate'), java.predict, javaKey('MAX_FRAMING_ZOOM_RATE')],
  ['공백 메우기 최소 신뢰', ts.predict, tsKey('minFillConfidence'), java.predict, javaKey('MIN_FILL_CONFIDENCE')],
  ['공백 메우기 최대 시간', ts.predict, tsKey('maxFillSec'), java.predict, javaKey('MAX_FILL_SEC')],
  ['관측 중심 갱신 간격', ts.predict, /OBSERVATION_CENTRIC_GAP_SEC = ([0-9.]+)/, java.predict, javaKey('OBSERVATION_CENTRIC_GAP_SEC')],
  // 방화벽
  ['방화벽 반경', ts.firewall, tsKey('maxDistanceBodies'), java.firewall, javaKey('MAX_DISTANCE_BODIES')],
  ['불확실 여유', ts.firewall, tsKey('uncertaintySlackBodies'), java.firewall, javaKey('UNCERTAINTY_SLACK_BODIES')],
  ['여유 상한', ts.firewall, tsKey('maxSlackBodies'), java.firewall, javaKey('MAX_SLACK_BODIES')],
  // 검출 문턱
  ['갤러리 문턱', ts.thresholds, tsKey('confirmedOtherGallery'), java.thresholds, javaKey('CONFIRMED_OTHER_GALLERY')],
  ['재획득 문턱', ts.thresholds, tsKey('reacquireCandidates'), java.thresholds, javaKey('REACQUIRE_CANDIDATES')],
  ['사용자 제시 문턱', ts.thresholds, tsKey('userFacingProposals'), java.thresholds, javaKey('USER_FACING_PROPOSALS')],
  ['기본 문턱', ts.thresholds, tsKey('default'), java.thresholds, javaKey('DEFAULT')],
  ['안정 추출 간격', ts.scheduler, tsKey('stableExpensiveIntervalSec'), java.scheduler, javaKey('STABLE_EXPENSIVE_INTERVAL_SEC')],
  ['경고 추출 간격', ts.scheduler, tsKey('warningExpensiveIntervalSec'), java.scheduler, javaKey('WARNING_EXPENSIVE_INTERVAL_SEC')],
  ['추출 쿨다운', ts.scheduler, tsKey('cooldownAfterExpensiveSec'), java.scheduler, javaKey('COOLDOWN_AFTER_EXPENSIVE_SEC')],
  ['추출 예산', ts.scheduler, tsKey('expensiveBudgetMs'), java.scheduler, javaKey('EXPENSIVE_BUDGET_MS')],
  ['가림 가시 하한', ts.scheduler, tsKey('fullOcclusionVisible'), java.scheduler, javaKey('FULL_OCCLUSION_VISIBLE')],
  ['최소 crop', ts.scheduler, tsKey('minCropPx'), java.scheduler, javaKey('MIN_CROP_PX')],
  ['확인 표본', ts.gallery, tsKey('userConfirmed'), java.gallery, javaKey('USER_CONFIRMED')],
  ['현재 표본', ts.gallery, tsKey('current'), java.gallery, javaKey('CURRENT')],
  ['과거 표본', ts.gallery, tsKey('past'), java.gallery, javaKey('PAST')],
  ['잠정 표본', ts.gallery, tsKey('tentative'), java.gallery, javaKey('TENTATIVE')],
];

const failures = [];
for (const [label, tsText, tsPattern, javaText, javaPattern] of checks) {
  let a;
  let b;
  try {
    a = num(tsText, tsPattern, `웹 ${label}`);
    b = num(javaText, javaPattern, `앱 ${label}`);
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    continue;
  }
  if (Math.abs(a - b) > 1e-9) failures.push(`${label}: 웹 ${a} ≠ 앱 ${b}`);
}

/* 숫자보다 이게 더 중요하다 — accept 는 타입에 있어도 **반환되면 안 된다.**
 *
 * 값 자체를 금지하지 않는다. 선언해 두면 "빠진 게 아니라 일부러 안 쓴다" 가
 * 코드에 남기 때문이다. 대신 gate 가 그 값을 만들어 내는지를 본다. */
const acceptRules = [
  [!/VERDICT_ACCEPT/.test(java.firewall), '앱 방화벽에 VERDICT_ACCEPT 예약값이 없습니다.'],
  [!/assertNeverAccepts/.test(java.firewall), '앱 방화벽에 assertNeverAccepts 가 없습니다.'],
  [java.firewall.includes('new Verdict(VERDICT_ACCEPT'),
    '앱 방화벽 gate() 가 accept 를 반환합니다. 예측은 거절만 해야 합니다.'],
  [!/PREDICTION_VERDICT_ACCEPT/.test(ts.firewall), '웹 방화벽에 accept 예약값이 없습니다.'],
  [!/assertNeverAccepts/.test(ts.firewall), '웹 방화벽에 assertNeverAccepts 가 없습니다.'],
  [/verdict: 'accept'/.test(ts.firewall),
    '웹 방화벽이 accept 를 반환합니다. 예측은 거절만 해야 합니다.'],
  [!/'reject', 'neutral'/.test(ts.firewall), '웹 PRODUCIBLE_VERDICTS 가 reject/neutral 이 아닙니다.'],
  [!/VERDICT_REJECT, VERDICT_NEUTRAL/.test(java.firewall), '앱 PRODUCIBLE_VERDICTS 가 reject/neutral 이 아닙니다.'],
  [!/NativeReidScheduler/.test(java.engine), '앱 엔진에 NativeReidScheduler 가 없습니다.'],
  [/NOT_PORTED/.test(java.engine), '앱 엔진에 NOT_PORTED 가 남아 있습니다.'],
  [!/NativeAppearanceCheckpoint/.test(java.engine), '앱 엔진에 NativeAppearanceCheckpoint 가 없습니다.'],
  /* 재획득 확정 절차가 양쪽에서 실제로 불리는지 본다. 상수만 같고 안 부르면 소용없다. */
  [!/applyReacquireGate/.test(java.engine), '앱 엔진이 applyReacquireGate 를 부르지 않습니다.'],
  /* 2026-09-28 추적 후처리를 엔진에서 tracking-postprocess.ts 로 꺼냈다(엔진이 그 함수를 부른다). */
  [!/gateReacquisitions/.test(read('apps/web/src/lib/tracking-postprocess.ts'))
    || !/postprocessPocResult\(/.test(read('apps/web/src/lib/web-tracking-engine.ts')),
    '웹 엔진이 gateReacquisitions 를 부르지 않습니다.'],
  [!/REACQUIRE_TRAJECTORY_GATE_ENABLED = true/.test(ts.gate), '웹 재획득 게이트가 꺼져 있습니다.'],
  [!/REACQUIRE_TRAJECTORY_GATE_ENABLED = true/.test(java.gate), '앱 재획득 게이트가 꺼져 있습니다.'],
  /* 이 절차는 신원을 주장하지 않는다. 자동 확정은 계속 꺼져 있어야 한다. */
  [!/identityClaim/.test(ts.gate), '웹 게이트에 identityClaim 표시가 없습니다.'],
  [!/identityClaim/.test(java.gate), '앱 게이트에 identityClaim 표시가 없습니다.'],
  /* 상수만 같고 안 부르면 소용없다. 세 경로가 실제로 게이트를 통과시키는지 본다. */
  [!/assessGmcEvidence\(gmc\)/.test(read('packages/hilit-vision/src/camera-motion.ts')),
    '웹 camera-motion 이 GMC 근거 게이트를 부르지 않습니다.'],
  [!/assessGmcEvidence\(gmc\)/.test(read('apps/web/public/tracking/camera-motion.js')),
    '브라우저 camera-motion 이 GMC 근거 게이트를 부르지 않습니다.'],
  [!/AffineGmc\.evidenceOk\(gmc\)/.test(java.engine),
    '앱 엔진이 GMC 근거 게이트를 부르지 않습니다.'],
  /* GMC 는 카메라 변환이지 동일인 판정이 아니다. */
  [!/동일인 판정이 아니다|동일인 판정 근거가 아니다/.test(ts.gmcVerify),
    'GMC 검증 모듈에 "동일인 판정이 아니다" 표시가 없습니다.'],
];
for (const [broken, message] of acceptRules) if (broken) failures.push(message);
if (selfTest) {
  /* 검사기가 진짜로 잡는지 본다 — 안 잡히면 이 파일은 장식이다. */
  const broken = java.predict.replace(/MAX_COAST_SEC = 1\.2/, 'MAX_COAST_SEC = 9.9');
  const a = num(ts.predict, tsKey('maxCoastSec'), 'ts');
  const b = num(broken, javaKey('MAX_COAST_SEC'), 'java');
  if (Math.abs(a - b) < 1e-9) {
    console.error('자체 시험 실패: 값이 달라졌는데 못 잡았습니다.');
    process.exit(1);
  }
  console.log('자체 시험 통과 — 값이 갈라지면 잡아냅니다.');
}

if (failures.length) {
  console.error('웹과 앱 추적 상수가 갈라졌습니다:');
  for (const line of failures) console.error('  - ' + line);
  console.error('두 파일을 같이 고치세요.');
  process.exit(1);
}
console.log(`OK  웹·앱 추적 상수 ${checks.length}개 일치`);
