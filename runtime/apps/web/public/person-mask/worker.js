/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·38864cf4 @license @preserve */
/* 사람 모양 마스크 작업자 — 검출 연결 추적(linked-v1)이 사람 상자 안에서 배경 화소를 빼고 겉모습을 세게 한다(2026-10-27).
 *
 * 2026-10-27 사용자 승인(추적 제안 1번): 이미 제품에 있는 같은 Pose Landmarker lite(Apache-2.0, 고정 해시)의
 * 사람 분할 마스크를 추적 보조로 쓴다. 새 모델·얼굴 모델·외부 가중치는 없다. 관절은 마스크 확인에만 쓰고 돌려주지 않는다.
 * 입력 그림은 판정 뒤 닫고, 상자 크기로 줄인 0~1 마스크 숫자만 기기 안 호출자에게 돌려준다(저장·전송 없음).
 * 이 파일의 응답에는 connect-src 'self' 정책이 붙는다(next.config.ts) — MediaPipe 사용 통계가 기기 밖으로 나가지 않게.
 */
'use strict';
const BASE = '/vendor/mediapipe/1.0.1';
const MODEL = '/models/pose/pose_landmarker_lite.task';
const SHA = '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a';
const nativeFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(value, self.location.href);
  const method = String(init?.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
  if (url.origin !== self.location.origin || url.search || url.hash || method !== 'GET'
    || !(url.pathname === MODEL || url.pathname.startsWith(BASE + '/')))
    return Promise.reject(new TypeError('사람 마스크 작업자의 허용된 로컬 모델 읽기 외 요청을 차단했습니다.'));
  return nativeFetch(input, init);
};
let modelPromise = null;
function load() {
  if (!modelPromise) {
    modelPromise = (async () => {
      importScripts(BASE + '/vision_bundle.js');
      const response = await self.fetch(MODEL);
      if (!response.ok) throw new Error('기존 포즈 모델을 불러오지 못했습니다.');
      const bytes = await response.arrayBuffer();
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) => v.toString(16).padStart(2, '0')).join('');
      if (hash !== SHA) throw new Error('포즈 모델의 고정 해시가 다릅니다.');
      const files = await self.Vision.FilesetResolver.forVisionTasks(BASE + '/wasm');
      return self.Vision.PoseLandmarker.createFromOptions(files, {
        /* GPU(WebGL) 로만 돌린다. CPU 로 돌리면 사람이 잡힌 장에서 분할 단계가 MediaPipe 를 강제 종료시킨다
         * (image_frame.cc "Check failed: 1 == ChannelSize() (1 vs. 4)", tasks-vision 1.0.1, 2026-10-27 확인).
         * WebGL 을 못 쓰는 기기에서는 만들기가 실패하고, 부르는 쪽이 마스크 없이 예전처럼 센다. */
        baseOptions: { modelAssetBuffer: new Uint8Array(bytes), delegate: 'GPU' },
        canvas: typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : undefined,
        runningMode: 'IMAGE', numPoses: 1,
        minPoseDetectionConfidence: 0.3, minPosePresenceConfidence: 0.3,
        outputSegmentationMasks: true,
      });
    })();
    modelPromise.catch(() => { modelPromise = null; });
  }
  return modelPromise;
}

/**
 * 마스크 → 상자(rect, 그림 좌표) 안을 outW×outH 로 줄인 값. 사람이 상자 가운데에 있지 않거나(옆 사람을 잡음)
 * 너무 적거나 거의 전부면(분할 실패) null.
 */
function boxMask(values, mw, mh, rect, outW, outH) {
  const out = new Float32Array(outW * outH);
  let sum = 0, sx = 0;
  for (let j = 0; j < outH; j += 1) {
    const y = Math.min(mh - 1, Math.max(0, Math.floor(rect.y + (j + 0.5) * rect.height / outH)));
    for (let i = 0; i < outW; i += 1) {
      const x = Math.min(mw - 1, Math.max(0, Math.floor(rect.x + (i + 0.5) * rect.width / outW)));
      const v = values[y * mw + x];
      const m = v > 0 ? Math.min(1, v) : 0;
      out[j * outW + i] = m;
      sum += m; sx += m * (i + 0.5) / outW;
    }
  }
  const cover = sum / (outW * outH);
  const centre = sx / Math.max(1e-6, sum);
  const info = { cover: +cover.toFixed(3), centre: +centre.toFixed(3) };
  if (cover < 0.1 || cover > 0.95 || centre < 0.2 || centre > 0.8) return { mask: null, info };
  return { mask: out, info };
}

self.onmessage = async (event) => {
  const { id, bitmap, rect, outW, outH } = event.data || {};
  try {
    const model = await load();
    if (!bitmap) { self.postMessage({ id, ok: true, ready: true, modelSha256: SHA }); return; }
    const result = model.detect(bitmap);
    const masks = result.segmentationMasks || [];
    let mask = null, info = { masks: masks.length };
    if (masks.length) {
      const m = masks[0];
      const r = boxMask(m.getAsFloat32Array(), m.width, m.height, rect, outW, outH);
      mask = r.mask; info = { masks: masks.length, ...r.info };
      for (const x of masks) { try { x.close(); } catch { /* 이미 닫힘 */ } }
    }
    /* info(덮은 비율·가운데 자리)는 품질 판정 근거 숫자뿐이다 — 그림·관절은 돌려주지 않는다. */
    if (mask) self.postMessage({ id, ok: true, mask, info }, [mask.buffer]);
    else self.postMessage({ id, ok: true, mask: null, info });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error?.message || error) });
  } finally {
    try { bitmap?.close?.(); } catch { /* 프레임은 보관하지 않습니다. */ }
  }
};
