/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·04106f3d @license @preserve */
/* 브라우저에서 도는 추적·외형.
 *
 * 위치 추적은 HilitMotionTracker (가중치 없음). 외형은 자체 서술자
 * (가중치 없음). **ONNX 모델은 하나도 없다.**
 *
 * 2026-09-16 에 NanoDet ONNX를 지웠고, 같은 날 오후에 자체 JSON 격자
 * 검출기(`HilitPersonDetector`)를 넣었다. 합성 가중치이며 실사 품질이
 * 아니다. onnxruntime 은 쓰지 않는다.
 *
 * 🔴 검출 점수는 동일인 확률이 아니다. 자동 복구가 완성된 것이 아니다.
 *    기본 추적 경로는 검출기로 상태를 바꾸지 않는다.
 */
import { CONFIG } from './config.generated.js';
import { scoreRegionProxy } from './generated/region-proxy.js';
import { extractIdentityDescriptor } from './generated/identity-descriptor.js';

/* =====================================================================
 * onnxruntime — 더 이상 쓰지 않는다
 * =====================================================================
 *
 * 여기 `loadOrt()` 와 `createSession()` 이 있었다. CDN 에서
 * onnxruntime-web 을 내려받아 ONNX 세션을 만드는 함수들이다.
 *
 * 2026-09-16 에 마지막 ONNX 모델(NanoDet)을 지우면서 함께 지웠다.
 * 남겨 두면 **조용히 되살아난다** — 누군가 모델 파일 하나를 되돌려
 * 놓기만 하면 세션이 다시 만들어지고, 게이트가 막기 전에 사용자
 * 브라우저가 이미 그 파일을 내려받은 뒤다.
 *
 * 지금 이 파일이 만드는 것은 전부 가중치 없는 자체 구현이다.
 */

function makeScratch() {
  const canvas = document.createElement('canvas');
  return { canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }), buf: null };
}

/* =====================================================================
 * HilitMotionTracker — 매 프레임 위치 추적 (가중치 없음)
 * 정본: packages/hilit-vision/src/motion-tracker.ts
 * ===================================================================== */

export { HilitMotionTracker, SIZE_MIN_RATIO, SIZE_MAX_RATIO } from './hilit-motion-tracker.js';

/* =====================================================================
 * HILIT Appearance — 사람 재식별 (자체 기술, 가중치 없음)
 *
 * 여기 있던 OSNet 은 걷어냈다. 두 가지 이유가 겹친다.
 *
 *   1. 권리 — 그 가중치는 MSMT17 로 학습됐고 MSMT17 은 연구용으로
 *      배포된다. 수익화하는 앱에 실을 수 없다.
 *   2. 애초에 안 돌고 있었다 — 이 파일 머리말의 벤치마크 표에
 *      "osnet 277.42ms 실패 (InstanceNormalization 미지원)" 라고 적혀
 *      있다. ONNX Runtime Web 이 그 연산자를 지원하지 않아 세션이
 *      열리지 않는다. 그래서 Health 의 Re-ID 신호에 상수 1이 들어가
 *      있었고, 가중 0.40 짜리 항목과 reid_veto 가 죽어 있었다.
 *
 * 8.7MB 를 내려받으면서 그 출력을 한 번도 쓰지 않고 있었다는 뜻이다.
 *
 * 대신 색 기반 서술자를 쓴다(hilit-appearance.js). 학습된 표현보다
 * 얕지만, 우리 문제는 갤러리 검색이 아니라 **화면 안 서너 명 중
 * 하나를 고르는 이진 판정**이고 운동·위치·크기·시간과 함께 쓴다.
 * 그리고 무엇보다, 지금까지 없던 신호가 처음으로 실제로 돈다.
 * ===================================================================== */

import { describeRgba, appearanceSimilarity, CROP_W, CROP_H }
  from './hilit-appearance.js';

export class HilitAppearance {
  constructor() {
    this.scratch = makeScratch();
    this.lastEmbedDiag = null;
  }

  /** 모델이 없다. 내려받을 것도, 기다릴 것도 없다. */
  static async load() { return new HilitAppearance(); }

  /** 박스 하나의 서술자. 실패하면 null — 부르는 쪽이 그것으로 거른다. */
  async embed(ctx, box) {
    const W = CROP_W, H = CROP_H;
    const pad = CONFIG.REID_CROP_PADDING;
    const px = box.width * pad, py = box.height * pad;
    const x = box.x - px, y = box.y - py;
    const w = box.width + 2 * px, h = box.height + 2 * py;

    if (Math.min(w, h) < CONFIG.REID_MIN_CROP_PIXELS) {
      this.lastEmbedDiag = { reason: 'crop-too-small', w, h };
      return null;
    }

    /* 영상→캔버스 화소는 RGB가 있는데 알파가 0인 경우가 있다.
     * 그 캔버스를 drawImage 로 다시 그리면 source-over 가 RGB를 버리고,
     * 서술자는 표본 0이 된다. 추적기는 같은 칸의 RGB를 이미 쓴다. */
    const cw = ctx.canvas.width, ch = ctx.canvas.height;
    const sx = Math.max(0, Math.floor(x));
    const sy = Math.max(0, Math.floor(y));
    const ex = Math.min(cw, Math.ceil(x + w));
    const ey = Math.min(ch, Math.ceil(y + h));
    if (ex <= sx || ey <= sy) {
      this.lastEmbedDiag = { reason: 'outside', sx, sy, ex, ey, cw, ch };
      return null;
    }
    let src;
    try { src = ctx.getImageData(sx, sy, ex - sx, ey - sy); }
    catch (err) {
      this.lastEmbedDiag = { reason: 'getImageData', err: String(err && err.message) };
      return null;
    }

    const sw = src.width, sh = src.height, sdata = src.data;
    const out = new Uint8ClampedArray(W * H * 4);
    let rgbSum = 0, alpha0 = 0;
    for (let j = 0; j < H; j += 1) {
      const syy = Math.min(sh - 1, Math.floor(j * sh / H));
      for (let i = 0; i < W; i += 1) {
        const sxx = Math.min(sw - 1, Math.floor(i * sw / W));
        const si = (syy * sw + sxx) * 4;
        const di = (j * W + i) * 4;
        const r = sdata[si], g = sdata[si + 1], b = sdata[si + 2], a = sdata[si + 3];
        out[di] = r; out[di + 1] = g; out[di + 2] = b;
        out[di + 3] = a < 8 && (r + g + b) > 8 ? 255 : a;
        rgbSum += r + g + b;
        if (a < 8) alpha0 += 1;
      }
    }
    const d = describeRgba(out, W, H);
    // Measured crop gradient, not an inferred body orientation or learned embedding.
    let gradient = 0;
    const partTexture = Array(24).fill(0);
    for (let yy=1; yy<H; yy++) for (let xx=1; xx<W; xx++) {
      const at=(yy*W+xx)*4;
      const luminance = p => 0.299*out[p]+0.587*out[p+1]+0.114*out[p+2];
      const gx=luminance(at)-luminance(at-4), gy=luminance(at)-luminance(at-W*4);
      gradient += Math.abs(gx) + Math.abs(gy);
      const part=yy<H*0.25?0:yy<H*0.7?1:2;
      const angle=(Math.atan2(gy,gx)+Math.PI)%Math.PI;
      partTexture[part*8+Math.min(7,Math.floor(angle/Math.PI*8))] += Math.hypot(gx,gy);
    }
    const sharpness = Math.min(1, gradient/((W-1)*(H-1)*20));
    const region = scoreRegionProxy({
      box: { x, y, width: w, height: h },
      frame: { width: cw, height: ch },
    });
    const identity = extractIdentityDescriptor(out, W, H, {
      hasAlpha: true,
      box: { x, y, width: w, height: h },
      frame: { width: cw, height: ch },
    });
    d.identityDescriptor = identity;
    d.partObservation = { descriptor: { values:d.values, samples:d.samples, trust:d.trust },
      texture:partTexture, visible: region.visibleMask, view:'unknown',
      alignment: region.alignment,
      region,
      partTexture: identity.partTexture,
      hsvAux: identity.hsvAux,
      quality: Math.min(sharpness, Math.min(sw,sh)/24, d.trust ?? 0, identity.quality.score) };
    this.lastEmbedDiag = {
      reason: d.samples >= 60 ? 'ok' : 'few-samples',
      samples: d.samples, trust: d.trust, rgbSum, alpha0, sw, sh, cw, ch,
    };
    return d.samples >= 60 ? d : null;
  }
}

/**
 * 두 서술자가 같은 사람인가 (0~1).
 *
 * 예전에는 코사인 유사도였다. 이름을 그대로 두는 이유: 부르는 쪽의
 * 뜻("얼마나 닮았나")이 같고, 값의 범위도 실질적으로 같다.
 */
export function cosine(a, b) {
  return appearanceSimilarity(a, b);
}
/* =====================================================================
 * 사람 검출 — 자체 HilitPersonDetector (ONNX 없음)
 * =====================================================================
 *
 * NanoDet 클래스는 두지 않는다. 자체 격자 합성곱과 세로 에너지 창이
 * `hilit-person-detector.js` 에 있다. 검출 점수는 동일인 확률이 아니다.
 */
export { HilitPersonDetector } from './hilit-person-detector.js';

export function iou(a, b) {
  const ax2 = a.x + a.width, ay2 = a.y + a.height;
  const bx2 = b.x + b.width, by2 = b.y + b.height;
  const iw = Math.min(ax2, bx2) - Math.max(a.x, b.x);
  const ih = Math.min(ay2, by2) - Math.max(a.y, b.y);
  if (iw <= 0 || ih <= 0) return 0;
  const inter = iw * ih;
  return inter / (a.width * a.height + b.width * b.height - inter);
}

/* `nms()` 와 `mergeDuplicates()` 도 함께 지웠다.
 *
 * 둘 다 검출 결과를 다듬는 함수라 검출기가 없으면 부를 데가 없다.
 * 남겨 두면 다음 사람이 "검출 기능이 아직 살아 있나" 하고 헷갈린다.
 *
 * `iou()` 는 남긴다 — 추적·재식별·연관 검사가 계속 쓴다. */
