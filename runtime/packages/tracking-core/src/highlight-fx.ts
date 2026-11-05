/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·d0b1da59 @license @preserve */
/* 하이라이트 시작의 주인공 표시.
 *
 * 구도(크롭)는 FollowCamera 가 맡는다. 여기는 **클립이 열리는 0.5초**만
 * 다룬다. 비네트와 링을 길게 남기면 경기장이 가려지고, 안 넣으면
 * "이게 내 장면" 이라는 첫 인상이 없다.
 *
 * 미리보기와 내보내기가 같은 식을 쓴다. 워터마크는 여기 없다 —
 * 편집 화면에만 얹고, 올린 파일·다른 사람 재생에는 넣지 않는다.
 */

export type HighlightFx = { vignette: number; ring: number };

export const HIGHLIGHT_FX_SECONDS = 0.5;

export function highlightStartsOf(
  windows: ReadonlyArray<{ start: number; end: number }>,
): number[] {
  return windows.filter((w) => w.end > w.start).map((w) => w.start);
}

/** 클립 시작 후 몇 초인가에 따른 세기. 0~1 을 넘기지 않는다. */
export function highlightFxAt(t: number, starts: readonly number[]): HighlightFx {
  let age = Number.POSITIVE_INFINITY;
  for (const start of starts) {
    const d = t - start;
    if (d >= -0.04 && d <= 0.72 && d < age) age = d;
  }
  if (!Number.isFinite(age) || age < 0) return { vignette: 0, ring: 0 };
  const ring = age < 0.10
    ? age / 0.10
    : age < HIGHLIGHT_FX_SECONDS
      ? 1 - (age - 0.10) / (HIGHLIGHT_FX_SECONDS - 0.10)
      : 0;
  const vig = age < 0.08
    ? age / 0.08
    : age < HIGHLIGHT_FX_SECONDS
      ? 0.9
      : Math.max(0, 1 - (age - HIGHLIGHT_FX_SECONDS) / 0.18);
  /* 🔴 고리(주인공 둘레의 흰 원·노란 원)는 그리지 않는다(2026-09-28 사용자 요청).
   * 클립이 시작될 때마다 영상 첫 부분에 원 두 개가 떠서 올린 영상에도 그대로 남았다 — 「주인공」 표시보다
   * 이상한 무늬로 읽혔다. 주인공은 구도(가운데·확대)로 보여 준다. 짧은 비네트만 남긴다. */
  void ring;
  return {
    vignette: Math.max(0, Math.min(1, vig)) * 0.42,
    ring: 0,
  };
}

export function subjectOnCanvas(
  bbox: { x: number; y: number; width: number; height: number },
  crop: { sx: number; sy: number; sw: number; sh: number },
  sourceW: number,
  sourceH: number,
  canvasW: number,
  canvasH: number,
): { x: number; y: number; w: number; h: number } {
  return {
    x: ((bbox.x * sourceW - crop.sx) / Math.max(1e-6, crop.sw)) * canvasW,
    y: ((bbox.y * sourceH - crop.sy) / Math.max(1e-6, crop.sh)) * canvasH,
    w: (bbox.width * sourceW / Math.max(1e-6, crop.sw)) * canvasW,
    h: (bbox.height * sourceH / Math.max(1e-6, crop.sh)) * canvasH,
  };
}

export function drawHighlightFx(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  fx: HighlightFx,
  subject?: { x: number; y: number; w: number; h: number } | null,
): void {
  if (fx.vignette < 0.01 && fx.ring < 0.01) return;
  ctx.save();
  if (fx.vignette >= 0.01) {
    const g = ctx.createRadialGradient(
      width * 0.5, height * 0.40, Math.min(width, height) * 0.20,
      width * 0.5, height * 0.46, Math.hypot(width, height) * 0.64,
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${fx.vignette})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, width, height);
  }
  if (fx.ring >= 0.01) {
    const cx = subject ? subject.x + subject.w / 2 : width * 0.5;
    const cy = subject ? subject.y + subject.h * 0.22 : height * 0.34;
    const rx = subject ? Math.max(18, subject.w * 0.70) : width * 0.16;
    const ry = subject ? Math.max(18, subject.h * 0.38) : height * 0.14;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${fx.ring})`;
    ctx.lineWidth = Math.max(2, Math.min(width, height) * 0.011);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx * 1.16, ry * 1.16, 0, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,236,180,${fx.ring * 0.42})`;
    ctx.lineWidth = Math.max(1, Math.min(width, height) * 0.006);
    ctx.stroke();
  }
  ctx.restore();
}
