/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·4d70c22a @license @preserve */
/* 같은 분석 프레임·상자·전처리 버전의 특징만 재사용한다.

이전 프레임 벡터를 지금 잰 것처럼 두지 않는다.
프레임이 바뀌면 비운다.
*/

import { APPEARANCE_PREPROCESS_VERSION, EXTRACTOR_VERSION } from './feature-extractor';

export interface PixelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CachedFrameFeature<T = unknown> {
  embedding: T;
  videoTSec: number;
  box: PixelBox;
  extractorVersion: number;
  preprocessVersion: number;
}

export class FrameFeatureCache<T = unknown> {
  readonly extractorVersion: number;
  readonly preprocessVersion: number;
  readonly quantizePx: number;
  private videoTSec = Number.NaN;
  private readonly map = new Map<string, CachedFrameFeature<T>>();
  hits = 0;
  misses = 0;

  constructor(opts?: {
    extractorVersion?: number;
    preprocessVersion?: number;
    quantizePx?: number;
  }) {
    this.extractorVersion = opts?.extractorVersion ?? EXTRACTOR_VERSION;
    this.preprocessVersion = opts?.preprocessVersion ?? APPEARANCE_PREPROCESS_VERSION;
    this.quantizePx = Math.max(1, opts?.quantizePx ?? 2);
  }

  beginFrame(videoTSec: number): void {
    if (!Number.isFinite(videoTSec)) return;
    if (this.videoTSec === videoTSec) return;
    this.videoTSec = videoTSec;
    this.map.clear();
  }

  key(box: PixelBox): string {
    const q = this.quantizePx;
    return [
      Math.round(box.x / q),
      Math.round(box.y / q),
      Math.round(box.width / q),
      Math.round(box.height / q),
      this.extractorVersion,
      this.preprocessVersion,
    ].join(':');
  }

  get(box: PixelBox | null | undefined): CachedFrameFeature<T> | null {
    if (!box || !Number.isFinite(this.videoTSec)) {
      this.misses += 1;
      return null;
    }
    const hit = this.map.get(this.key(box));
    if (!hit) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    return hit;
  }

  put(box: PixelBox, embedding: T): CachedFrameFeature<T> {
    const row: CachedFrameFeature<T> = {
      embedding,
      videoTSec: this.videoTSec,
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      extractorVersion: this.extractorVersion,
      preprocessVersion: this.preprocessVersion,
    };
    this.map.set(this.key(box), row);
    return row;
  }

  get extractsAvoided(): number {
    return this.hits;
  }
}
