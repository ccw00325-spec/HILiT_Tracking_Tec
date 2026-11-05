/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·124cc196 @license @preserve */
/* HDR 영상을 SDR 로 맞춘다(톤매핑).
 *
 * ## 왜 직접 하나
 *
 * 요즘 휴대폰은 HDR(HLG 또는 PQ)로 찍는다. 그 영상을 2D 캔버스에 그리면 브라우저가
 * 알아서 SDR 로 바꾸는데, 두 가지가 문제였다(2026-10-11~12, Chrome 154 실측).
 *
 *   - 저장 중 화면이 멈춘다. 2D 캔버스 경로로 만든 저장본에서 바로 앞과 같은 프레임이
 *     HLG 20장(최장 14장 연속), PQ 36장(최장 34장 연속) 나왔다. WebGL 경로는 0장이다.
 *   - PQ 는 약 500 nit 위가 1.0 에서 잘린다(보정 패턴). 브라우저·기기마다 변환도 다를 수 있다.
 *
 * 🔴 10-11 기록의 "Chrome 이 HDR 을 어둡고 누렇게 만든다"는 ffmpeg 로 만든 가짜 HLG 시험
 * 영상 탓이었다(신호가 낮게 들어갔다). 실제 아이폰 HLG 영상(10-12)에서는 브라우저 변환도
 * 누렇지 않았다(흰 빙판 (R+G)/2-B 0.6~0.9). 그 근거로 기준 흰색을 1.0 에 두었더니 실제 영상이
 * 허옇게 떴다 — 10-12 에 아래 2번으로 고쳤다.
 *
 * ## 무엇을 하나
 *
 * Chrome 은 HDR 영상을 WebGL 부동소수점 텍스처(RGBA16F)로 올리면 **변환하지 않은 원본
 * 신호**(BT.2020 원색, HLG·PQ 부호값)를 그대로 넘긴다. 신호값을 아는 보정 패턴으로 확인했다.
 * 그래서 브라우저 변환을 건너뛰고 셰이더에서 직접 바꾼다.
 *
 *   1. 선형광으로 — PQ 는 SMPTE ST 2084 EOTF, HLG 는 BT.2100 역 OETF + OOTF
 *      (화면 최대 1000 nit, 감마 1.2). 결과는 nit 단위다.
 *   2. SDR 화면 최대(1.0)를 406 nit, 곧 기준 흰색(203 nit, BT.2408)의 두 배로 둔다. 기준 흰색은
 *      선형 0.5(sRGB 0.73)에 온다. Chrome 2D 캔버스가 두는 자리와 같고(보정 패턴: PQ 203 nit →
 *      0.734, HLG 75% → 0.774), 기준 흰색보다 밝은 부분(빙판·하늘·흰 옷)에 여유가 남는다.
 *   3. 밝기(BT.2020 휘도)에만 곡선을 건다. 0.75 까지는 그대로, 그 위는 1.0 으로 천천히
 *      눕힌다(무릎에서 기울기 1 이 이어지는 유리함수 a/(1+a)). 1000 nit 는 0.968 이다.
 *      세 채널을 같은 비율로 곱하므로 색조가 돌지 않는다.
 *   4. BT.2020 → BT.709 원색 행렬. 밖으로 나간 색은 자르지 않고 같은 밝기의
 *      회색 쪽으로 채도만 줄여 안으로 들인다 — 자르면 색조가 틀어진다.
 *   5. sRGB 부호화.
 *
 * 수식은 모두 공개 표준(ITU-R BT.2100·BT.2408, SMPTE ST 2084)에서 직접 옮겼다.
 * 다른 사람의 코드를 가져오지 않았다.
 *
 * ## 한계
 *
 * - 원본 신호를 넘겨주는 동작은 Chromium 에서 확인했다. 다른 엔진은 확인하지
 *   못해 켜지 않는다(브라우저 변환 그대로, 화면이 알린다).
 * - PQ 영상의 실제 최대 밝기(MaxCLL)는 브라우저가 알려 주지 않는다. 곡선이
 *   1.0 에 점근하므로 어떤 값이 와도 넘치지는 않는다.
 * - HLG 의 검정 들어올림(Lb)은 0 으로 둔다.
 * - 실제 휴대폰 영상으로 잰 것은 아이폰 HLG 한 편이다. 삼성 HDR10+(PQ)는 아직 없다.
 */

export type HdrTransfer = 'hlg' | 'pq';

/** 기준 흰색(nit). BT.2408 의 HDR 기준 흰색이다. */
export const HDR_REFERENCE_WHITE_NITS = 203;
/** SDR 화면 최대(1.0)로 보는 밝기(nit). 기준 흰색의 두 배다 — 위 2번. */
export const SDR_PEAK_NITS = 2 * HDR_REFERENCE_WHITE_NITS;
/** HLG 를 화면 밝기로 풀 때 쓰는 화면 최대 밝기(nit). BT.2100 기준 화면이다. */
export const HLG_DISPLAY_PEAK_NITS = 1000;
/** 이 밝기(SDR 최대=1)까지는 곡선을 걸지 않는다. */
export const TONE_KNEE = 0.75;

const PQ = {
  m1: 2610 / 16384,
  m2: (2523 / 4096) * 128,
  c1: 3424 / 4096,
  c2: (2413 / 4096) * 32,
  c3: (2392 / 4096) * 32,
};
const HLG = { a: 0.17883277, b: 0.28466892, c: 0.55991073 };
const LUMA_2020: readonly [number, number, number] = [0.2627, 0.678, 0.0593];
const LUMA_709: readonly [number, number, number] = [0.2126, 0.7152, 0.0722];
/** BT.2020 선형 → BT.709 선형 (BT.2087). 행 우선. */
const BT2020_TO_709 = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187],
] as const;

type Rgb = [number, number, number];

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** PQ 부호값(0~1) → nit. */
export function pqToNits(e: number): number {
  const p = Math.pow(Math.max(e, 0), 1 / PQ.m2);
  return 10000 * Math.pow(Math.max(p - PQ.c1, 0) / (PQ.c2 - PQ.c3 * p), 1 / PQ.m1);
}

/** HLG 부호값(0~1) → 장면 선형(0~1). BT.2100 역 OETF. */
export function hlgToScene(e: number): number {
  const v = Math.max(e, 0);
  return v <= 0.5 ? (v * v) / 3 : (Math.exp((v - HLG.c) / HLG.a) + HLG.b) / 12;
}

/** 신호(BT.2020 원색) → 선형광, SDR 최대(406 nit) = 1. */
export function signalToRelativeLinear(rgb: Rgb, transfer: HdrTransfer): Rgb {
  if (transfer === 'pq') {
    return rgb.map((c) => pqToNits(c) / SDR_PEAK_NITS) as Rgb;
  }
  const scene = rgb.map(hlgToScene) as Rgb;
  const ys = Math.max(dot(LUMA_2020, scene), 0);
  /* OOTF: Fd = Lw · Ys^(γ-1) · E. γ = 1.2 (1000 nit 화면). */
  const gain = (HLG_DISPLAY_PEAK_NITS * Math.pow(ys, 0.2)) / SDR_PEAK_NITS;
  return scene.map((c) => c * gain) as Rgb;
}

/** 밝기 곡선. 무릎(0.75)까지 그대로, 그 위는 1.0 으로 눕힌다. 기울기가 끊기지 않는다. */
export function toneCurve(y: number): number {
  if (y <= TONE_KNEE) return Math.max(y, 0);
  const span = 1 - TONE_KNEE;
  const a = (y - TONE_KNEE) / span;
  return TONE_KNEE + span * (a / (1 + a));
}

/** 같은 밝기의 회색 쪽으로 채도만 줄여 0~1 안에 들인다. */
export function fitGamut(rgb: Rgb): Rgb {
  const y = Math.min(Math.max(dot(LUMA_709, rgb), 0), 1);
  let out = rgb.slice() as Rgb;
  const lo = Math.min(...out);
  if (lo < 0) {
    const t = y / Math.max(y - lo, 1e-9);
    out = out.map((c) => y + (c - y) * t) as Rgb;
  }
  const hi = Math.max(...out);
  if (hi > 1) {
    const t = (1 - y) / Math.max(hi - y, 1e-9);
    out = out.map((c) => y + (c - y) * t) as Rgb;
  }
  return out.map((c) => Math.min(Math.max(c, 0), 1)) as Rgb;
}

export function srgbEncode(c: number): number {
  const v = Math.min(Math.max(c, 0), 1);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/**
 * HDR 신호 한 화소 → sRGB 부호값(0~1). 셰이더(HDR_TONEMAP_GLSL)와 같은 식이다.
 * 시험이 이 함수로 셰이더의 식을 검증한다 — 한쪽을 고치면 다른 쪽도 고친다.
 */
export function toneMapSignal(rgb: Rgb, transfer: HdrTransfer): Rgb {
  const lin = signalToRelativeLinear(rgb, transfer);
  const y = dot(LUMA_2020, lin);
  const scale = y > 1e-6 ? toneCurve(y) / y : 0;
  const mapped = lin.map((c) => c * scale) as Rgb;
  const rgb709 = BT2020_TO_709.map((row) => dot(row, mapped)) as Rgb;
  return fitGamut(rgb709).map(srgbEncode) as Rgb;
}

/**
 * 셰이더 조각. `vec3 hdrToneMap(vec3 signal)` 을 정의한다.
 * `uHdrTransfer` 가 1 이면 HLG, 2 면 PQ 다. GLSL ES 1.0 이라 WebGL1·2 모두에서 컴파일된다.
 */
export const HDR_TONEMAP_GLSL = `
uniform int uHdrTransfer;
const float PQ_M1 = ${PQ.m1.toFixed(10)};
const float PQ_M2 = ${PQ.m2.toFixed(10)};
const float PQ_C1 = ${PQ.c1.toFixed(10)};
const float PQ_C2 = ${PQ.c2.toFixed(10)};
const float PQ_C3 = ${PQ.c3.toFixed(10)};
const vec3 LUMA2020 = vec3(${LUMA_2020.join(', ')});
const vec3 LUMA709 = vec3(${LUMA_709.join(', ')});
float pqToNits(float e) {
  float p = pow(max(e, 0.0), 1.0 / PQ_M2);
  return 10000.0 * pow(max(p - PQ_C1, 0.0) / (PQ_C2 - PQ_C3 * p), 1.0 / PQ_M1);
}
float hlgToScene(float e) {
  float v = max(e, 0.0);
  return v <= 0.5 ? v * v / 3.0 : (exp((v - ${HLG.c}) / ${HLG.a}) + ${HLG.b}) / 12.0;
}
float toneCurve(float y) {
  if (y <= ${TONE_KNEE.toFixed(4)}) return max(y, 0.0);
  float span = ${(1 - TONE_KNEE).toFixed(4)};
  float a = (y - ${TONE_KNEE.toFixed(4)}) / span;
  return ${TONE_KNEE.toFixed(4)} + span * (a / (1.0 + a));
}
float srgbEnc(float c) {
  float v = clamp(c, 0.0, 1.0);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}
vec3 hdrToneMap(vec3 s) {
  vec3 lin;
  if (uHdrTransfer == 2) {
    lin = vec3(pqToNits(s.r), pqToNits(s.g), pqToNits(s.b)) / ${SDR_PEAK_NITS.toFixed(1)};
  } else {
    vec3 scene = vec3(hlgToScene(s.r), hlgToScene(s.g), hlgToScene(s.b));
    float ys = max(dot(LUMA2020, scene), 0.0);
    lin = scene * (${HLG_DISPLAY_PEAK_NITS.toFixed(1)} * pow(ys, 0.2) / ${SDR_PEAK_NITS.toFixed(1)});
  }
  float y = dot(LUMA2020, lin);
  lin *= y > 1e-6 ? toneCurve(y) / y : 0.0;
  vec3 c = vec3(
    dot(vec3(${BT2020_TO_709[0].join(', ')}), lin),
    dot(vec3(${BT2020_TO_709[1].join(', ')}), lin),
    dot(vec3(${BT2020_TO_709[2].join(', ')}), lin));
  float y709 = clamp(dot(LUMA709, c), 0.0, 1.0);
  float lo = min(min(c.r, c.g), c.b);
  if (lo < 0.0) c = y709 + (c - y709) * (y709 / max(y709 - lo, 1e-9));
  float hi = max(max(c.r, c.g), c.b);
  if (hi > 1.0) c = y709 + (c - y709) * ((1.0 - y709) / max(hi - y709, 1e-9));
  c = clamp(c, 0.0, 1.0);
  return vec3(srgbEnc(c.r), srgbEnc(c.g), srgbEnc(c.b));
}
`;

/**
 * 이 영상이 HDR 인가. 모르면 null 이다(오래된 브라우저, 아직 프레임이 없음).
 *
 * VideoFrame 의 colorSpace 로 본다. 파일 머리를 읽지 않아도 되고, 브라우저가
 * 실제로 해석한 값이라 디코더와 어긋나지 않는다.
 */
export function detectHdrTransfer(video: HTMLVideoElement): HdrTransfer | null {
  const probe = probeHdrTransfer(video);
  return probe === 'hlg' || probe === 'pq' ? probe : null;
}

/**
 * detectHdrTransfer 와 같지만 「SDR 이다」와 「아직 모른다」를 가른다.
 *
 * 🔴 2026-10-28 실측(Chrome 156, 실제 아이폰 HLG): 첫 프레임이 화면에 올라오기 전(loadeddata·canplay,
 * readyState 4)에는 `new VideoFrame(video)` 가 InvalidStateError 를 던진다. 첫 seek·재생 뒤에야
 * transfer 'hlg' 가 나온다. 예전에는 이 오류를 「HDR 아님」으로 읽고 영상 내내 기억했다 — 같은 HDR 영상이
 * 여는 때에 따라 우리 톤매핑과 브라우저 변환 중 하나로 갈려, 색이 그때그때 달라졌다.
 */
export function probeHdrTransfer(video: HTMLVideoElement): HdrTransfer | 'sdr' | 'unknown' {
  const Frame = (globalThis as { VideoFrame?: new (src: CanvasImageSource) => {
    colorSpace?: { transfer?: string | null }; close(): void } }).VideoFrame;
  /* VideoFrame 이 없는 브라우저는 앞으로도 알 길이 없다 — SDR 로 본다(예전과 같다). */
  if (!Frame) return 'sdr';
  if (video.readyState < 2 || !video.videoWidth) return 'unknown';
  try {
    const frame = new Frame(video);
    const transfer = frame.colorSpace?.transfer ?? null;
    frame.close();
    if (transfer === 'hlg') return 'hlg';
    if (transfer === 'pq') return 'pq';
    return 'sdr';
  } catch {
    return 'unknown';
  }
}

/**
 * 원본 신호를 넘겨주는 엔진인가. Chromium 계열에서만 확인했다(2026-10-11).
 * 다른 엔진에서 같은 셰이더를 돌리면 이미 바뀐 색을 한 번 더 바꿀 수 있어 켜지 않는다.
 */
export function rawHdrUploadKnown(nav: Navigator | undefined = globalThis.navigator): boolean {
  if (!nav) return false;
  const brands = (nav as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } })
    .userAgentData?.brands;
  if (brands?.some((b) => /chromium/i.test(b.brand))) return true;
  const ua = nav.userAgent ?? '';
  return /Chrome\/\d+/.test(ua) && !/Firefox|FxiOS|CriOS/.test(ua);
}
