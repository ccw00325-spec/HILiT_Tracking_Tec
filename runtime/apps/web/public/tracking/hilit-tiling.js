/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·f79dd9ca @license @preserve */
/* HILIT Tiling — 작게 찍힌 사람을 검출기가 볼 수 있게. 가중치가 없다.
 *
 * 🔴 정본은 `packages/hilit-vision/src/tiling.ts` 다. 거기에 검사가
 *    붙어 있다(10개). 이 파일은 추적 엔진이 쓰는 **런타임 사본**이다 —
 *    엔진은 번들 밖의 ESM 이라 패키지를 import 할 수 없다.
 *    한쪽을 고치면 반드시 다른 쪽도 고친다.
 *
 * ## 왜 필요한가 — 우리 실패의 대부분이 여기서 났다
 *
 *   실제 농구 영상   사람 높이 69~85px / 프레임 높이 334px = 21~25%
 *                    모바일 재획득 0/17
 *   피겨 영상        대상이 화면의 1%. 외형 분리도 -0.131
 *
 * 원인이 하나다. 검출기는 프레임 전체를 416×416 으로 찌그러뜨려 넣는다.
 * 1920×1080 에서 높이 5% 인 사람은 54px 이고, 416 으로 줄이면 20px 이
 * 된다. 20px 짜리 사람에게서 뽑을 특징이 없다.
 *
 * 그래서 겹치게 잘라 조각마다 검출기를 돌리고 원본 좌표로 되돌려
 * 합친다(SAHI, Akyon et al. 2022). 조각이 작으니 그 안의 사람은 커진다.
 *
 *   전체 한 번   1920×1080 -> 416   사람 20px   못 본다
 *   조각 한 번    480×480  -> 416   사람 47px   본다
 *
 * 격자로 다 훑지는 않는다 — 조각 수만큼 추론이 늘어난다. 우리는 대상이
 * 있을 자리를 예측으로 알고 있으므로 그 자리 하나만 집중해서 본다.
 */

/* 대상이 프레임 높이의 이 비율보다 작을 때만 조각을 낸다.
 *
 * 🔴 처음에 0.22 로 뒀다가 실측으로 고쳤다. 그렇게 두면 고치려던
 *    영상(대상 21~25%)에서 조각이 안 난다 — 0.23 은 0.22 보다 크다.
 *    `scripts/diag-sliced-detect.mjs` 가 그걸 잡았다.
 *
 * 검출기 입력이 416 정사각이므로 입력에서의 사람 높이는 언제나
 * `비율 × 416` 이다(원본 해상도와 무관). 0.23 이면 96px, 0.35 면 146px.
 * 자세한 근거는 정본(packages/hilit-vision/src/tiling.ts). */
export const SLICE_BELOW_SHARE = 0.35;
const FOCUS_SUBJECT_SHARE = 0.34;
const MIN_SLICE_PX = 160;

/** 조각을 낼 가치가 있는가. 대상 크기를 모르면 낸다 — 놓친 상태다. */
export function shouldSlice(subjectHeight) {
  if (subjectHeight === null || subjectHeight === undefined) return true;
  if (!Number.isFinite(subjectHeight) || subjectHeight <= 0) return true;
  return subjectHeight < SLICE_BELOW_SHARE;
}

function clampRegion(region, frameW, frameH) {
  const width = Math.min(frameW, Math.max(MIN_SLICE_PX, Math.round(region.width)));
  const height = Math.min(frameH, Math.max(MIN_SLICE_PX, Math.round(region.height)));
  return {
    width, height,
    x: Math.round(Math.max(0, Math.min(frameW - width, region.x))),
    y: Math.round(Math.max(0, Math.min(frameH - height, region.y))),
  };
}

/** 검출기를 어디에 댈지. 첫 번째는 언제나 전체 프레임이다. */
export function planSlices(frameW, frameH, options = {}) {
  const full = { region: { x: 0, y: 0, width: frameW, height: frameH }, kind: 'full' };
  if (frameW < MIN_SLICE_PX || frameH < MIN_SLICE_PX) return [full];

  const max = Math.max(1, Math.floor(options.maxSlices ?? 3));
  if (max <= 1) return [full];
  if (!options.force && !shouldSlice(options.subjectHeight)) return [full];

  const slices = [full];
  const share = options.subjectHeight;
  const sliceH = share && share > 1e-4
    ? Math.max(MIN_SLICE_PX, Math.round(frameH * Math.min(1, share / FOCUS_SUBJECT_SHARE)))
    : Math.round(frameH * 0.5);
  /* 정사각으로 자른다. 검출기 입력이 정사각이라 그래야 왜곡이 없다 —
   * 16:9 를 통째로 넣으면 서 있는 사람이 가로로 1.78배 눌린다. */
  const side = Math.min(Math.min(frameW, frameH), Math.max(MIN_SLICE_PX, sliceH));

  const focus = options.focus;
  if (focus && focus.width > 0 && focus.height > 0) {
    const cx = focus.x + focus.width / 2;
    const cy = focus.y + focus.height / 2;
    slices.push({
      region: clampRegion({ x: cx - side / 2, y: cy - side / 2, width: side, height: side },
        frameW, frameH),
      /* 이 조각이 **이전에 본** 자리인지 **예측이 가리킨** 자리인지 적는다.
       * 자리를 정하는 규칙은 같고 이름만 다르다 — 나중에 "이 후보가
       * 관측에서 나왔나, 짐작에서 나왔나" 를 따질 때 섞이면 짐작을
       * 관측으로 읽게 된다.
       *
       * 🔴 이름이 accept 여도 그 조각에서 나온 후보의 신원이 올라가지
       * 않는다. 예측은 거절만 한다(prediction-identity-firewall). */
      kind: options.focusFromPrediction === true ? 'accept' : 'focus',
    });
    if (slices.length >= max) return slices;
  }

  const overlap = Math.min(0.5, Math.max(0, options.overlap ?? 0.2));
  const step = side * (1 - overlap);
  const cols = Math.max(1, Math.ceil((frameW - side) / step) + 1);
  const rows = Math.max(1, Math.ceil((frameH - side) / step) + 1);
  const grid = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      grid.push({
        region: clampRegion({ x: c * step, y: r * step, width: side, height: side },
          frameW, frameH),
        kind: 'grid',
      });
    }
  }

  /* 자리가 모자라면 가운데부터 담는다. 경기 영상에서 대상은 대개 화면
   * 가운데 근처에 있고, 구석 조각은 관중석일 때가 많다. */
  const fcx = focus ? focus.x + focus.width / 2 : frameW / 2;
  const fcy = focus ? focus.y + focus.height / 2 : frameH / 2;
  grid.sort((a, b) => {
    const da = Math.hypot(a.region.x + a.region.width / 2 - fcx,
      a.region.y + a.region.height / 2 - fcy);
    const db = Math.hypot(b.region.x + b.region.width / 2 - fcx,
      b.region.y + b.region.height / 2 - fcy);
    return da - db;
  });
  for (const slice of grid) {
    if (slices.length >= max) break;
    const same = slices.some((s) => s.kind !== 'full'
      && Math.abs(s.region.x - slice.region.x) < side * 0.35
      && Math.abs(s.region.y - slice.region.y) < side * 0.35);
    if (!same) slices.push(slice);
  }
  return slices;
}

/** 조각 좌표를 원본 좌표로. */
export function toFrame(box, region) {
  return { x: box.x + region.x, y: box.y + region.y, width: box.width, height: box.height };
}

/** 조각 경계에 잘린 상자인가. 전체 프레임에서는 판단하지 않는다. */
export function isClipped(box, slice, tolerance = 2) {
  if (slice.kind === 'full') return false;
  const r = slice.region;
  return box.x <= r.x + tolerance
    || box.y <= r.y + tolerance
    || box.x + box.width >= r.x + r.width - tolerance
    || box.y + box.height >= r.y + r.height - tolerance;
}
