/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·650205a0 @license @preserve */
/* 사람 모양 마스크 부르기 — /person-mask/worker.js(Pose Landmarker lite 분할, 2026-10-27 제안 1번).
 *
 * 마스크는 상자 크기(outW×outH)의 0~1 숫자다. 기기 밖으로 보내지 않고, 영상이 열려 있는 동안 검출 결과에만 붙는다.
 * 작업자를 못 띄우거나 한 번 실패하면 이 영상 분석 동안은 다시 부르지 않는다(마스크 없이 예전처럼 센다).
 */

/* 첫 응답은 모델·그래픽(WebGL 셰이더) 준비가 들어가 느리다 — 그래픽 칩이 없는 PC(소프트웨어 그리기)에서 18초를 쟀다. */
const FIRST_TIMEOUT_MS = 45000;
const TIMEOUT_MS = 8000;
let worker = null;
let seq = 0;
let broken = false;
let warmed = false;
const waiting = new Map();

export function personMaskAvailable() {
  return !broken && typeof Worker !== 'undefined' && typeof createImageBitmap === 'function';
}

function fail() {
  broken = true;
  for (const done of waiting.values()) done({ ok: false });
  waiting.clear();
  try { worker?.terminate(); } catch { /* 이미 닫힘 */ }
  worker = null;
}

function ensure() {
  if (worker) return worker;
  worker = new Worker('/person-mask/worker.js');
  worker.onmessage = (e) => {
    const done = waiting.get(e.data?.id);
    if (done) { waiting.delete(e.data.id); done(e.data); }
  };
  worker.onerror = () => fail();
  return worker;
}

function call(msg, transfer) {
  return new Promise((resolve) => {
    const id = ++seq;
    const timer = setTimeout(() => { if (waiting.has(id)) { waiting.delete(id); fail(); resolve({ ok: false }); } }, warmed ? TIMEOUT_MS : FIRST_TIMEOUT_MS);
    waiting.set(id, (r) => { clearTimeout(timer); if (r?.ok) warmed = true; resolve(r); });
    try { ensure().postMessage({ ...msg, id }, transfer); } catch { clearTimeout(timer); waiting.delete(id); fail(); resolve({ ok: false }); }
  });
}

/** 마스크를 읽을 자리 — 상자 둘레를 조금 넓혀(팔·머리가 상자 밖으로 나가도) 분할기가 사람 전체를 보게 한다. */
export function maskRegion(box, width, height) {
  const px = box.width * 0.2, py = box.height * 0.08;
  const x0 = Math.max(0, Math.floor(box.x - px)), y0 = Math.max(0, Math.floor(box.y - py));
  const x1 = Math.min(width, Math.ceil(box.x + box.width + px)), y1 = Math.min(height, Math.ceil(box.y + box.height + py));
  return { x: x0, y: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/** canvas 위 box(사람 상자) 의 마스크. outW×outH Float32Array 또는 null. */
export async function personMask(canvas, box, outW, outH) {
  if (!personMaskAvailable()) return null;
  const r = maskRegion(box, canvas.width, canvas.height);
  let bitmap;
  try { bitmap = await createImageBitmap(canvas, r.x, r.y, r.width, r.height); } catch { return null; }
  const rect = { x: box.x - r.x, y: box.y - r.y, width: box.width, height: box.height };
  const res = await call({ bitmap, rect, outW, outH }, [bitmap]);
  if (!res.ok) { if (res.error) fail(); return null; }
  return res.mask instanceof Float32Array && res.mask.length === outW * outH ? res.mask : null;
}

export function disposePersonMask() {
  try { worker?.terminate(); } catch { /* 이미 닫힘 */ }
  worker = null;
  waiting.clear();
  broken = false;
  warmed = false;
}
