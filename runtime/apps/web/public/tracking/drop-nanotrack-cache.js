/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·6f817d49 @license @preserve */
/* NanoTrack 전용 캐시 키만 지운다. 영상·draft·다른 모델은 건드리지 않는다. */

const FORBIDDEN = /nanotrack/i;

export async function dropNanotrackCaches() {
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
