/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·936ebed2 @license @preserve */
/* 사람 후보 검출 작업자 — 편집 2단계(나 지정)에서 화면의 사람을 상자로 띄운다.
 *
 * MediaPipe Tasks Vision 1.0.1 의 ObjectDetector 와 EfficientDet-Lite0(int8)
 * 모델을 쓴다. 둘 다 Apache-2.0 이다. 고지는 /licenses/THIRD_PARTY_NOTICES.txt.
 * 근거와 측정: docs/tracking-research/2026-09-24-mediapipe-person-proposals.md
 *
 * ## 왜 작업자(worker) 안에서 돌리나
 *
 * 1. MediaPipe 는 이미지를 밖으로 보내지 않지만, **API 사용 통계를 60초마다
 *    Google(odml.pa.googleapis.com)으로 보낸다.** 끄는 옵션이 없다. 하일릿은
 *    "영상 분석은 기기 안에서만" 을 약속했으므로 이 통계도 나가면 안 된다.
 *    이 파일의 응답에는 `connect-src 'self'` 보안 정책이 붙는다(next.config.ts).
 *    작업자 안에서는 그 정책이 적용되므로 브라우저가 그 요청을 막는다.
 *    아래 fetch 가드가 한 번 더 막는다 — 정책이 빠져도 새지 않게.
 * 2. 한 장에 100ms 쯤 걸린다. 화면 스레드에서 돌리면 그동안 손가락이 먹통이 된다.
 *
 * 🔴 검출 점수는 "사람처럼 보이는 정도" 다. 동일인 확률이 아니다.
 */
'use strict';

const MEDIAPIPE_VERSION = '1.0.1';
const BASE = `/vendor/mediapipe/${MEDIAPIPE_VERSION}`;
const MODEL = '/models/person/efficientdet_lite0_int8.tflite';

/* ── 바깥으로 나가는 요청 차단 ──────────────────────────────────────
 * 이 작업자가 읽을 것은 같은 출처의 WASM·모델뿐이다. 그 밖의 주소는 전부
 * 거절한다. MediaPipe 통계 전송은 실패하면 스스로 멈춘다(재시도 없음). */
let blocked = 0;
const nativeFetch = self.fetch.bind(self);
self.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url, self.location.href);
  if (url.origin !== self.location.origin) {
    blocked += 1;
    return Promise.reject(new TypeError('hilit: 기기 밖으로 나가는 요청을 막았습니다'));
  }
  return nativeFetch(input, init);
};

let detectorPromise = null;

function load() {
  if (!detectorPromise) {
    detectorPromise = (async () => {
      importScripts(`${BASE}/vision_bundle.js`);
      const fileset = await self.Vision.FilesetResolver.forVisionTasks(`${BASE}/wasm`);
      return self.Vision.ObjectDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' },
        runningMode: 'IMAGE',
        /* 문턱은 부르는 쪽이 쓰임새마다 따로 건다(person-box-fit.ts). 여기서는
         * 가장 낮은 쪽(누른 자리 재검출 0.1)까지 넘긴다. */
        scoreThreshold: 0.1,
        maxResults: 50,
        categoryAllowlist: ['person'],
      });
    })();
    detectorPromise.catch(() => { detectorPromise = null; });
  }
  return detectorPromise;
}

self.onmessage = async (event) => {
  const { id, type, bitmap } = event.data || {};
  try {
    if (type === 'load') {
      await load();
      self.postMessage({ id, ok: true, blocked });
      return;
    }
    if (type === 'detect') {
      const detector = await load();
      const started = performance.now();
      const result = detector.detect(bitmap);
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
      const hits = result.detections.map((d) => ({
        x: d.boundingBox.originX,
        y: d.boundingBox.originY,
        width: d.boundingBox.width,
        height: d.boundingBox.height,
        score: d.categories[0] ? d.categories[0].score : 0,
      }));
      self.postMessage({ id, ok: true, hits, elapsedMs: performance.now() - started, blocked });
      return;
    }
    self.postMessage({ id, ok: false, error: `unknown message: ${type}` });
  } catch (error) {
    if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    self.postMessage({ id, ok: false, error: String((error && error.message) || error) });
  }
};
