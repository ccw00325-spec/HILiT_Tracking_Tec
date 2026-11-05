/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·edafe9ef @license @preserve */
/* NanoDet 전용 캐시 키만 지운다. 영상·draft·다른 파일은 건드리지 않는다.
 *
 * ## 왜 필요한가
 *
 * 저장소에서 파일을 지우고 배포해도, **이미 그 파일을 내려받은 브라우저에는
 * 그대로 남아 있다.** 서비스 워커 캐시는 서버에 파일이 없어져도 자기가 가진
 * 사본을 계속 내준다. 즉 "지웠다" 가 사용자 기기에서는 아직 아니다.
 *
 * NanoTrack 을 지울 때 같은 일을 겪었다(`drop-nanotrack-cache.js`). 그때
 * 배운 것을 그대로 쓴다.
 *
 * ## 왜 캐시 전체를 비우지 않나
 *
 * 같은 캐시에 사용자의 영상 조각과 임시저장이 들어 있다. 통째로 비우면
 * 편집하던 것이 사라진다. 모델 파일 이름에만 걸리는 정규식으로 고른다.
 */

const FORBIDDEN = /nanodet/i;

export async function dropNanodetCaches() {
  if (typeof caches === 'undefined') return { deleted: 0 };
  let deleted = 0;
  const names = await caches.keys();
  for (const name of names) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    for (const req of keys) {
      if (FORBIDDEN.test(req.url)) {
        const ok = await cache.delete(req);
        if (ok) deleted += 1;
      }
    }
  }
  return { deleted };
}
