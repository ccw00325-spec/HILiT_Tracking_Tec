/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·f1f8056c @license @preserve */
/* 외형 기억의 작업 범위.

파일 이름만으로 같은 영상이라고 보지 않는다.
같은 origin IndexedDB 도 계정 격리를 자동으로 보장하지 않는다.
*/

export interface AppearanceScope {
  ownerId: string;
  videoId: string;
  subjectId: string;
  runId: string;
}

export function ownerScopeId(userId: string | null | undefined): string {
  if (typeof userId === 'string' && userId.trim().length > 0) return `user:${userId.trim()}`;
  return 'anon:local';
}

export function videoScopeId(input: {
  name: string;
  size: number;
  lastModified: number;
  durationSec?: number;
  width?: number;
  height?: number;
}): string {
  const name = String(input.name || '');
  const size = Number.isFinite(input.size) ? Math.round(input.size) : 0;
  const modified = Number.isFinite(input.lastModified) ? Math.round(input.lastModified) : 0;
  const dur = Number.isFinite(input.durationSec) ? input.durationSec!.toFixed(3) : '';
  const w = Number.isFinite(input.width) ? String(Math.round(input.width!)) : '';
  const h = Number.isFinite(input.height) ? String(Math.round(input.height!)) : '';
  return [name, size, modified, dur, w, h].join('\u001f');
}

export function newAppearanceRunId(now = Date.now()): string {
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `run:${now.toString(36)}:${rand}`;
}

export function appearanceStoreKey(scope: Pick<AppearanceScope, 'ownerId' | 'videoId' | 'subjectId'>): string {
  return [scope.ownerId, scope.videoId, scope.subjectId].join('\u0000');
}

export function scopesCompatible(
  stored: Pick<AppearanceScope, 'ownerId' | 'videoId' | 'subjectId'>,
  wanted: Pick<AppearanceScope, 'ownerId' | 'videoId' | 'subjectId'>,
): boolean {
  return stored.ownerId === wanted.ownerId
    && stored.videoId === wanted.videoId
    && stored.subjectId === wanted.subjectId;
}
