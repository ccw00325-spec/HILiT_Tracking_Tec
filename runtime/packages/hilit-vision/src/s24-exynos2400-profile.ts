/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·b64959a4 @license @preserve */
/* 한국 Galaxy S24 (SM-S921N) · 엑시노스 2400 가상 프로파일.

실측이 아니다. 사용자가 준 표 + 공개 벤치 범위를 코드에 고정해
APK 추적 경로를 이 칩에 맞춰 스케일할 때 쓴다.

probe-android-device 가 adb 없이 NOT_MEASURED 를 내는 규칙을 깨지 않는다.
여기 숫자로 S24 실측을 대체하지 않는다.
*/

export const S24_PROFILE_ID = 'galaxy-s24-kr-exynos2400';
export const S24_PROFILE_KIND = 'VIRTUAL' as const;
export const S24_MEASUREMENT_STATUS = 'NOT_MEASURED' as const;

/** 미리보기 목표. 분석 fps 가 아니다. 재생 크롭 예산. */
export const PREVIEW_TARGET_FPS = 24;
export const PREVIEW_BUDGET_MS = 1000 / PREVIEW_TARGET_FPS;

/** NativeTrackingEngine 이 짧은 변을 이 값으로 맞춘다. */
export const APK_ANALYSIS_SHORT_SIDE = 720;
/** NativeTrackingEngine.track 의 analysisFps. */
export const APK_ANALYSIS_FPS = 20;
export const APK_ANALYSIS_BUDGET_MS = 1000 / APK_ANALYSIS_FPS;
/** 웹 파이프라인이 기기가 느리면 내리는 바닥. */
export const WEB_ADAPTIVE_FLOOR_FPS = 12;
export const WEB_ADAPTIVE_BUDGET_MS = 1000 / WEB_ADAPTIVE_FLOOR_FPS;

export const S24_KR_USER_TABLE = {
  soc: '삼성 엑시노스 2400',
  process: '4nm',
  cpu: '10코어',
  peakClockGhz: 3.2,
  gpu: 'Xclipse 940',
  gpuArch: 'AMD RDNA 3 기반',
  ai: '내장 NPU',
  ram: 'LPDDR5X RAM 8GB',
  storage: '256GB 또는 512GB',
  osAtLaunch: 'Android 14 / One UI 6.1',
} as const;

/** GSMArena 2024-01-17 클러스터. 사용자 표의 「10코어 · 3.2GHz」를 연다. */
export const EXYNOS_2400_CLUSTER = {
  little: { count: 4, name: 'Cortex-A520', ghz: { min: 1.95, max: 2.0 } },
  mid: { count: 3, name: 'Cortex-A720', ghz: 2.6 },
  big: { count: 2, name: 'Cortex-A720', ghz: 2.9 },
  prime: { count: 1, name: 'Cortex-X4', ghz: 3.2 },
  totalCores: 10,
  processNote: 'Samsung Foundry SF4P 4nm. 「4nm」만으로는 노드 세부가 안 열린다.',
} as const;

export const S24_KR_DEVICE = {
  marketingName: 'Galaxy S24',
  region: 'KR',
  modelIds: ['SM-S921N'] as const,
  display: { width: 1080, height: 2340, hz: 120 },
  ramGb: 8,
  storageGb: [256, 512] as const,
  ufs: 'UFS 4.0',
  lpddr: 'LPDDR5X',
  /** 공개 대역. 공식 TOPS 가 없어 단정하지 않는다. */
  memoryBandwidthGBs: { min: 67.2, max: 68.3 },
} as const;

/**
 * 스케일에 쓰는 가상 단일코어. S24 8GB Notebookcheck GB6.7 = 2045,
 * 초기 리뷰 2046~2131 의 가운데에 가깝게 둔다. 범위는 따로 둔다.
 */
export const S24_GB6_SINGLE_VIRTUAL = 2060;
export const S24_GB6_SINGLE_RANGE = {
  typicalMin: 2045,
  typicalMax: 2131,
  userSubmitMin: 1837,
  userSubmitMax: 2187,
} as const;
export const S24_GB6_MULTI_RANGE = {
  typicalMin: 6456,
  typicalMax: 6785,
  userSubmitMin: 6130,
  userSubmitMax: 6936,
} as const;

export const S24_ANTUTU10_RANGE = {
  s24_8gb_notebookcheck: 1_616_403,
  typicalMin: 1_546_699,
  typicalMax: 1_781_862,
} as const;
export const S24_ANTUTU11_AVG = 2_029_835;

/** GPU 점수는 추적기가 안 쓰므로 참고만. TFLOPS 공개값이 갈려 고르지 않는다. */
export const S24_GPU_SCORES_NOTE = {
  xclipse940: 'Xclipse 940 · RDNA 3',
  geekbench6Gpu: { typicalMin: 15_292, typicalMax: 18_256 },
  wildlifeExtremeEarlyReview: { score: 4304, fps: 25.78, source: 'Beebom 2024 S24+ hands-on' },
  officialTflops: null,
} as const;

export const S24_NPU_NOTE = {
  samsungClaim: '17K MAC, Exynos 2200 대비 14.7× (삼성 발표)',
  officialTops: null,
  usedByHilitTracker: false,
} as const;

export const S24_SOURCES = [
  { id: 'user-table', what: '한국 S24 구성 표 (사용자 제공)' },
  { id: 'gsmarena-2024-01-17', what: 'Exynos 2400 1+2+3+4 클러스터' },
  { id: 'notebookcheck-exynos-2400', what: 'S24 8GB GB6.7 single 2045 / multi 6456, AnTuTu10 1,616,403' },
  { id: 'beebom-exynos-vs-8g3', what: 'GB6 2046/6687, AnTuTu10 1,781,862, CPU throttle 언급, Wildlife Extreme 4304' },
  { id: 'geekbench-browser-s24-exynos', what: '사용자 제출 GB6 단일 분포' },
  { id: 'nanoreview-s24-exynos', what: 'AnTuTu 11 평균 2,029,835, GB6 제출 1837~2187' },
  { id: 'geekbench-sm-s921n-2026-09-22', what: 'Geekbench 6.2.2 SM-S921N 단일 2065 / 다중 6331 (browser.geekbench.com/v6/cpu/4075780). 가상 중심 2060을 바꾸지 않음' },
] as const;

/**
 * 호스트 GB6 를 모를 때. 높게 잡아 S24 ms 를 과대(보수)로 본다.
 * time_s24 = time_host * (host_score / s24_score)
 */
export const UNKNOWN_HOST_GB6_SINGLE = 2800;

export function inferHostGeekbench6Single(cpuModel: string): { score: number; basis: string } {
  const m = cpuModel.toLowerCase();
  const rows: Array<{ test: RegExp; score: number; basis: string }> = [
    { test: /i5-10210u/, score: 1190, basis: 'geekbench6-i5-10210u-typical' },
    { test: /ultra\s*9|core ultra 9/, score: 2800, basis: 'published-band-core-ultra-9' },
    { test: /ultra\s*7|core ultra 7/, score: 2600, basis: 'published-band-core-ultra-7' },
    { test: /i9-14|i9 14/, score: 3100, basis: 'published-band-i9-14' },
    { test: /i9-13|i9 13/, score: 3000, basis: 'published-band-i9-13' },
    { test: /i7-14|i7 14/, score: 2900, basis: 'published-band-i7-14' },
    { test: /i7-13|i7 13/, score: 2700, basis: 'published-band-i7-13' },
    { test: /i7-12|i7 12/, score: 2400, basis: 'published-band-i7-12' },
    { test: /i7-11\d{3}u|i7-10\d{3}u/, score: 1400, basis: 'published-band-i7-10u' },
    { test: /i5-13|i5 13/, score: 2400, basis: 'published-band-i5-13' },
    { test: /i5-12|i5 12/, score: 2200, basis: 'published-band-i5-12' },
    { test: /i5-11\d{3}u|i5-10\d{3}u/, score: 1180, basis: 'published-band-i5-10u' },
    { test: /ryzen 9/, score: 2900, basis: 'published-band-ryzen-9' },
    { test: /ryzen 7/, score: 2700, basis: 'published-band-ryzen-7' },
    { test: /ryzen 5/, score: 2400, basis: 'published-band-ryzen-5' },
  ];
  for (const row of rows) {
    if (row.test.test(m)) return { score: row.score, basis: row.basis };
  }
  return { score: UNKNOWN_HOST_GB6_SINGLE, basis: 'unknown-host-conservative-high' };
}

export type VirtualTrackPath = 'apk-java' | 'webview-js';

/** ART 는 Node 와 비슷한데 Bitmap.getPixels 가 한 번 더 든다. */
export const APK_JAVA_RUNTIME_FACTOR = 1.2;
/** 모바일 Chromium 은 데스크톱 Node 보다 같은 JS 가 더 느리다. */
export const WEBVIEW_JS_RUNTIME_FACTOR = 2.8;
/** 엑시노스 2400 지속 부하에서 CPU 스로틀이 공개 리뷰에 나온다. */
export const SUSTAINED_THERMAL_FACTOR = 1.22;

/**
 * MediaMetadataRetriever.getFrameAtTime(OPTION_CLOSEST).
 * 하드웨어 4K 디코드 능력과 이 API 비용은 다르다. 시크가 잦다.
 * 실측 아님.
 */
export const S24_DECODE_MS_ESTIMATE = {
  optimistic: 12,
  typical: 22,
  pessimistic: 40,
  measured: false,
} as const;

export type VirtualBudgetBand =
  | 'VIRTUAL_LIKELY_OK'
  | 'VIRTUAL_MARGINAL'
  | 'VIRTUAL_SLOW'
  | 'VIRTUAL_OVER_BUDGET';

export function scaleHostMsToS24(hostMs: number, input: {
  hostGb6Single: number;
  path: VirtualTrackPath;
  sustained: boolean;
  /** 기본 2060. 공개 제출 대역으로 민감도를 볼 때만 바꾼다. */
  s24Gb6Single?: number;
}): {
  virtualMs: number;
  computeMs: number;
  runtimeFactor: number;
  thermalFactor: number;
  gb6Ratio: number;
  s24Gb6Single: number;
} {
  const host = Math.max(800, input.hostGb6Single);
  const s24Gb6Single = Math.max(800, input.s24Gb6Single ?? S24_GB6_SINGLE_VIRTUAL);
  const gb6Ratio = host / s24Gb6Single;
  const computeMs = hostMs * gb6Ratio;
  const runtimeFactor = input.path === 'apk-java' ? APK_JAVA_RUNTIME_FACTOR : WEBVIEW_JS_RUNTIME_FACTOR;
  const thermalFactor = input.sustained ? SUSTAINED_THERMAL_FACTOR : 1;
  return {
    virtualMs: computeMs * runtimeFactor * thermalFactor,
    computeMs,
    runtimeFactor,
    thermalFactor,
    gb6Ratio,
    s24Gb6Single,
  };
}

export function bandForAnalysisMs(msPerFrame: number): VirtualBudgetBand {
  if (msPerFrame <= APK_ANALYSIS_BUDGET_MS) return 'VIRTUAL_LIKELY_OK';
  if (msPerFrame <= WEB_ADAPTIVE_BUDGET_MS) return 'VIRTUAL_MARGINAL';
  if (msPerFrame <= 140) return 'VIRTUAL_SLOW';
  return 'VIRTUAL_OVER_BUDGET';
}

export function tenMinuteFrameCount(fps: number): number {
  return Math.floor(600 * fps);
}

export function trackingHeapMbEstimate(width: number, height: number): {
  argbFrameMb: number;
  peakMb: number;
  fits8gb: boolean;
} {
  const argbFrameMb = (width * height * 4) / (1024 * 1024);
  const peakMb = argbFrameMb * 3 + 48;
  return { argbFrameMb, peakMb, fits8gb: peakMb < 512 };
}

export const S24_KR_EXYNOS2400_PROFILE = {
  id: S24_PROFILE_ID,
  kind: S24_PROFILE_KIND,
  measurementStatus: S24_MEASUREMENT_STATUS,
  userTable: S24_KR_USER_TABLE,
  cluster: EXYNOS_2400_CLUSTER,
  device: S24_KR_DEVICE,
  apk: {
    analysisShortSide: APK_ANALYSIS_SHORT_SIDE,
    analysisFps: APK_ANALYSIS_FPS,
    analysisBudgetMs: APK_ANALYSIS_BUDGET_MS,
    usesOnnx: false,
    usesNpu: false,
    usesGpuCompute: false,
    autoReacquire: 'off' as const,
  },
  preview: { targetFps: PREVIEW_TARGET_FPS, budgetMs: PREVIEW_BUDGET_MS },
  virtualScale: {
    gb6Single: S24_GB6_SINGLE_VIRTUAL,
    gb6SingleRange: S24_GB6_SINGLE_RANGE,
    apkJavaRuntimeFactor: APK_JAVA_RUNTIME_FACTOR,
    webviewJsRuntimeFactor: WEBVIEW_JS_RUNTIME_FACTOR,
    sustainedThermalFactor: SUSTAINED_THERMAL_FACTOR,
  },
  published: {
    gb6MultiRange: S24_GB6_MULTI_RANGE,
    antutu10: S24_ANTUTU10_RANGE,
    antutu11Avg: S24_ANTUTU11_AVG,
    gpu: S24_GPU_SCORES_NOTE,
    npu: S24_NPU_NOTE,
  },
  sources: S24_SOURCES,
} as const;
