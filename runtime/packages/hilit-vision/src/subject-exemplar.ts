/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·6784bc80 @license @preserve */
/* 확정 기억과 자동 수집을 나눈다.

이전 identity-memory: MAX_MEMORY_SLOTS=8, MAX_USER_ANCHORS=3.
이번 확정 exemplar: 전체 12, 같은 view 3, 최초 anchor 불변.
초기에 보지 못한 정면·측면·후면을 만들지 않는다.
*/

import type { Descriptor } from './appearance';
import type { TextureDescriptor } from './appearance-texture';
import type { PartTextureDescriptor } from './part-texture';
import type { HsvAuxDescriptor } from './hsv-aux';
import type { RegionProxyObservation } from './region-proxy';
import { EXTRACTOR_CONTRACT } from './descriptor-layout';

export type ExemplarView = 'front' | 'left' | 'right' | 'back' | 'unknown';
export type ConfirmationSource = 'user_pick' | 'user_extra_view' | 'user_correction';
export type ExemplarKind = 'confirmed' | 'auto_candidate';

export const PREV_MAX_MEMORY_SLOTS = 8;
export const PREV_MAX_USER_ANCHORS = 3;
export const PREV_MULTIVIEW_MAX = 9;
export const PREV_MULTIVIEW_PER_VIEW = 2;

export const MAX_CONFIRMED_EXEMPLARS = 12;
export const MAX_PER_VIEW = 3;
export const MAX_AUTO_CANDIDATES = 4;

export interface SubjectExemplar {
  subjectId: string;
  sessionId: string;
  sourceFrameTime: number;
  view: ExemplarView;
  globalDescriptor: Descriptor;
  headDescriptor: Float32Array | null;
  torsoDescriptor: Float32Array | null;
  legsDescriptor: Float32Array | null;
  texture: TextureDescriptor | null;
  partTexture: PartTextureDescriptor | null;
  hsvAux: HsvAuxDescriptor | null;
  region: RegionProxyObservation | null;
  confirmationSource: ConfirmationSource | 'auto';
  descriptorVersion: number;
  extractorId: string;
  anchor: boolean;
  kind: ExemplarKind;
}

export interface SubjectExemplarStore {
  subjectId: string;
  sessionId: string;
  videoId: string;
  confirmed: SubjectExemplar[];
  autoCandidates: SubjectExemplar[];
}

export function createExemplarStore(input: {
  subjectId: string;
  sessionId: string;
  videoId: string;
}): SubjectExemplarStore {
  return {
    subjectId: input.subjectId,
    sessionId: input.sessionId,
    videoId: input.videoId,
    confirmed: [],
    autoCandidates: [],
  };
}

function inSession(store: SubjectExemplarStore, sessionId: string, subjectId: string, videoId: string): boolean {
  return store.sessionId === sessionId && store.subjectId === subjectId && store.videoId === videoId;
}

function diversityDistance(a: Descriptor, b: Descriptor): number {
  let dot = 0;
  const n = Math.min(a.values.length, b.values.length);
  for (let i = 0; i < n; i += 1) dot += a.values[i] * b.values[i];
  return 1 - Math.max(-1, Math.min(1, dot));
}

export function addConfirmedExemplar(
  store: SubjectExemplarStore,
  item: Omit<SubjectExemplar, 'kind' | 'extractorId' | 'descriptorVersion'> & {
    extractorId?: string;
    descriptorVersion?: number;
  },
  scope: { sessionId: string; subjectId: string; videoId: string },
): { ok: boolean; reason: string } {
  if (!inSession(store, scope.sessionId, scope.subjectId, scope.videoId)) {
    return { ok: false, reason: 'session-mismatch' };
  }
  if (item.confirmationSource === 'auto') {
    return { ok: false, reason: 'auto-cannot-write-confirmed' };
  }
  const first = store.confirmed.find((e) => e.anchor);
  const next: SubjectExemplar = {
    ...item,
    kind: 'confirmed',
    extractorId: item.extractorId ?? EXTRACTOR_CONTRACT.extractorId,
    descriptorVersion: item.descriptorVersion ?? EXTRACTOR_CONTRACT.extractorVersion,
    anchor: store.confirmed.length === 0 ? true : item.anchor && !first ? true : item.anchor && store.confirmed.length === 0,
  };
  if (store.confirmed.length === 0) next.anchor = true;
  else if (next.anchor && first) next.anchor = false;

  const sameView = store.confirmed.filter((e) => e.view === next.view);
  if (sameView.length >= MAX_PER_VIEW) {
    const drop = sameView.filter((e) => !e.anchor).sort((a, b) => a.sourceFrameTime - b.sourceFrameTime)[0];
    if (!drop) return { ok: false, reason: 'view-full-anchor-protected' };
    store.confirmed = store.confirmed.filter((e) => e !== drop);
  }
  if (store.confirmed.length >= MAX_CONFIRMED_EXEMPLARS) {
    const drop = store.confirmed.filter((e) => !e.anchor).sort((a, b) => a.sourceFrameTime - b.sourceFrameTime)[0];
    if (!drop) return { ok: false, reason: 'store-full-anchor-protected' };
    store.confirmed = store.confirmed.filter((e) => e !== drop);
  }
  const near = store.confirmed.find((e) =>
    e.view === next.view && !e.anchor && diversityDistance(e.globalDescriptor, next.globalDescriptor) < 0.04);
  if (near) store.confirmed = store.confirmed.filter((e) => e !== near);
  store.confirmed.push(next);
  return { ok: true, reason: 'confirmed' };
}

export function addAutoCandidate(
  store: SubjectExemplarStore,
  item: Omit<SubjectExemplar, 'kind' | 'anchor' | 'extractorId' | 'descriptorVersion'> & {
    extractorId?: string;
    descriptorVersion?: number;
  },
  scope: { sessionId: string; subjectId: string; videoId: string },
  provisional: boolean,
): { ok: boolean; reason: string } {
  if (!inSession(store, scope.sessionId, scope.subjectId, scope.videoId)) {
    return { ok: false, reason: 'session-mismatch' };
  }
  if (provisional) return { ok: false, reason: 'provisional-not-confirmed-memory' };
  const next: SubjectExemplar = {
    ...item,
    kind: 'auto_candidate',
    anchor: false,
    extractorId: item.extractorId ?? EXTRACTOR_CONTRACT.extractorId,
    descriptorVersion: item.descriptorVersion ?? EXTRACTOR_CONTRACT.extractorVersion,
  };
  store.autoCandidates.push(next);
  if (store.autoCandidates.length > MAX_AUTO_CANDIDATES) {
    store.autoCandidates.splice(0, store.autoCandidates.length - MAX_AUTO_CANDIDATES);
  }
  return { ok: true, reason: 'auto-candidate' };
}

export function firstAnchor(store: SubjectExemplarStore): SubjectExemplar | null {
  return store.confirmed.find((e) => e.anchor) ?? store.confirmed[0] ?? null;
}

export function removeExemplar(store: SubjectExemplarStore, sourceFrameTime: number, view: ExemplarView): boolean {
  const before = store.confirmed.length;
  store.confirmed = store.confirmed.filter((e) => !(e.sourceFrameTime === sourceFrameTime && e.view === view && !e.anchor));
  return store.confirmed.length < before;
}

export function clearExemplarStore(store: SubjectExemplarStore): void {
  store.confirmed = [];
  store.autoCandidates = [];
}

export function forgetExemplarIfSessionChanged(
  store: SubjectExemplarStore,
  next: { sessionId: string; subjectId: string; videoId: string },
): boolean {
  if (inSession(store, next.sessionId, next.subjectId, next.videoId)) return false;
  clearExemplarStore(store);
  store.sessionId = next.sessionId;
  store.subjectId = next.subjectId;
  store.videoId = next.videoId;
  return true;
}

export function mapUiViewToReid(view: ExemplarView): 'front' | 'side' | 'back' | 'unknown' {
  if (view === 'left' || view === 'right') return 'side';
  return view;
}

export function collisionOpportunity(confirmedCount: number): number {
  return Math.max(0, confirmedCount - 1);
}
