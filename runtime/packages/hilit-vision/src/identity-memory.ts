/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·88d6743d @license @preserve */
/* 대상별 외형 기억. 사용자 앵커와 자동 관측을 한 칸에 넣지 않는다.

한 장의 나쁜 관측이 사용자 앵커를 덮지 않는다.
기억은 그 영상·프로젝트 안에서만 둔다.
*/

import type { MemoryKind } from './appearance-memory';
import { mayAdaptUserAnchor } from './appearance-memory';
import type { Descriptor } from './appearance';
import { similarityBandAware } from './appearance';
import type { TextureDescriptor } from './appearance-texture';
import { textureSimilarity } from './appearance-texture';
import type { ObservationQuality } from './appearance-quality';
import { mayCommitAppearanceObservation } from './appearance-quality';
import type { IdentityJudgeState, TrackMotionState } from './track-identity-report';
import { EXTRACTOR_VERSION, HSV_TEXTURE_EXTRACTOR_ID } from './feature-extractor';

export type ViewHint = 'front' | 'back' | 'side' | 'unknown';

export interface MemorySlot {
  kind: MemoryKind;
  tSec: number;
  box: { x: number; y: number; width: number; height: number };
  color: Descriptor;
  texture: TextureDescriptor | null;
  quality: ObservationQuality;
  userConfirmed: boolean;
  viewHint: ViewHint;
  extractorId: string;
  extractorVersion: number;
}

export interface MemoryUpdate {
  atSec: number;
  kind: MemoryKind;
  accepted: boolean;
  reason: string;
}

export interface SubjectAppearanceMemory {
  subjectId: string;
  videoId: string;
  projectId: string;
  slots: MemorySlot[];
  updates: MemoryUpdate[];
}

export const MAX_MEMORY_SLOTS = 8;
export const MAX_USER_ANCHORS = 3;
export const MAX_VERIFIED_AUTO = 4;
export const MAX_TENTATIVE = 2;
export const MAX_KNOWN_OTHER = 4;
export const MAX_UPDATE_LOG = 24;

export function createSubjectMemory(input: {
  subjectId: string;
  videoId: string;
  projectId: string;
}): SubjectAppearanceMemory {
  return {
    subjectId: input.subjectId,
    videoId: input.videoId,
    projectId: input.projectId,
    slots: [],
    updates: [],
  };
}

function inScope(mem: SubjectAppearanceMemory, videoId: string, projectId: string): boolean {
  return mem.videoId === videoId && mem.projectId === projectId;
}

function pushUpdate(mem: SubjectAppearanceMemory, update: MemoryUpdate): void {
  mem.updates.push(update);
  if (mem.updates.length > MAX_UPDATE_LOG) mem.updates.splice(0, mem.updates.length - MAX_UPDATE_LOG);
}

function evictKind(mem: SubjectAppearanceMemory, kind: MemoryKind, keep: number): void {
  const ofKind = mem.slots.filter((s) => s.kind === kind);
  if (ofKind.length <= keep) return;
  const firstAnchor = kind === 'user_anchor'
    ? ofKind.slice().sort((a, b) => a.tSec - b.tSec)[0]
    : null;
  ofKind
    .sort((a, b) => a.quality.score - b.quality.score || a.tSec - b.tSec)
    .filter((s) => s !== firstAnchor)
    .slice(0, ofKind.length - keep)
    .forEach((drop) => {
      mem.slots = mem.slots.filter((s) => s !== drop);
    });
}

function capSlots(mem: SubjectAppearanceMemory): void {
  evictKind(mem, 'user_anchor', MAX_USER_ANCHORS);
  evictKind(mem, 'verified_auto', MAX_VERIFIED_AUTO);
  evictKind(mem, 'tentative', MAX_TENTATIVE);
  evictKind(mem, 'known_other', MAX_KNOWN_OTHER);
  if (mem.slots.length <= MAX_MEMORY_SLOTS) return;
  const protectedKinds = new Set(['user_anchor']);
  const extra = mem.slots
    .filter((s) => !protectedKinds.has(s.kind))
    .sort((a, b) => a.quality.score - b.quality.score);
  while (mem.slots.length > MAX_MEMORY_SLOTS && extra.length) {
    const drop = extra.shift();
    mem.slots = mem.slots.filter((s) => s !== drop);
  }
}

export function recordUserAnchor(
  mem: SubjectAppearanceMemory,
  slot: Omit<MemorySlot, 'kind' | 'userConfirmed' | 'extractorId' | 'extractorVersion'> & {
    extractorId?: string;
    extractorVersion?: number;
  },
  scope: { videoId: string; projectId: string },
): boolean {
  if (!inScope(mem, scope.videoId, scope.projectId)) return false;
  mem.slots.push({
    ...slot,
    kind: 'user_anchor',
    userConfirmed: true,
    extractorId: slot.extractorId ?? HSV_TEXTURE_EXTRACTOR_ID,
    extractorVersion: slot.extractorVersion ?? EXTRACTOR_VERSION,
  });
  capSlots(mem);
  pushUpdate(mem, { atSec: slot.tSec, kind: 'user_anchor', accepted: true, reason: 'user-anchor' });
  return true;
}

export function recordAutoObservation(
  mem: SubjectAppearanceMemory,
  slot: Omit<MemorySlot, 'userConfirmed' | 'extractorId' | 'extractorVersion'> & {
    extractorId?: string;
    extractorVersion?: number;
  },
  gate: {
    videoId: string;
    projectId: string;
    trackState: TrackMotionState;
    identityState: IdentityJudgeState;
    doubtOpen: boolean;
  },
): boolean {
  if (!inScope(mem, gate.videoId, gate.projectId)) {
    pushUpdate(mem, { atSec: slot.tSec, kind: slot.kind, accepted: false, reason: 'wrong-project' });
    return false;
  }
  if (slot.kind === 'user_anchor') {
    pushUpdate(mem, { atSec: slot.tSec, kind: slot.kind, accepted: false, reason: 'auto-cannot-write-user-anchor' });
    return false;
  }
  if (!mayCommitAppearanceObservation({
    quality: slot.quality,
    trackState: gate.trackState,
    identityState: gate.identityState,
    doubtOpen: gate.doubtOpen,
    kind: slot.kind,
    userConfirmed: false,
  })) {
    pushUpdate(mem, { atSec: slot.tSec, kind: slot.kind, accepted: false, reason: 'quality-or-state-gate' });
    return false;
  }
  if (!mayAdaptUserAnchor(slot.kind) && slot.kind !== 'known_other') {
    pushUpdate(mem, { atSec: slot.tSec, kind: slot.kind, accepted: false, reason: 'kind-not-adaptable' });
    return false;
  }
  mem.slots.push({
    ...slot,
    userConfirmed: false,
    extractorId: slot.extractorId ?? HSV_TEXTURE_EXTRACTOR_ID,
    extractorVersion: slot.extractorVersion ?? EXTRACTOR_VERSION,
  });
  capSlots(mem);
  pushUpdate(mem, { atSec: slot.tSec, kind: slot.kind, accepted: true, reason: 'auto-slot' });
  return true;
}

export function trustedSlots(mem: SubjectAppearanceMemory): MemorySlot[] {
  return mem.slots.filter((s) => s.kind === 'user_anchor' || s.kind === 'verified_auto');
}

export function scoreAgainstMemory(
  mem: SubjectAppearanceMemory,
  color: Descriptor,
  texture: TextureDescriptor | null,
): { self: number | null; slotKind: MemoryKind | null; usedSlots: number } {
  const pool = trustedSlots(mem);
  if (!pool.length) return { self: null, slotKind: null, usedSlots: 0 };
  let best = -1;
  let kind: MemoryKind | null = null;
  for (const slot of pool) {
    let score = similarityBandAware(slot.color, color);
    if (slot.texture && texture) {
      const tex = textureSimilarity(slot.texture, texture);
      if (tex !== 0.5 && score >= 0.55) score = score * 0.78 + tex * 0.22;
    }
    if (score > best) {
      best = score;
      kind = slot.kind;
    }
  }
  return { self: best < 0 ? null : best, slotKind: kind, usedSlots: pool.length };
}

export function clearSubjectMemory(mem: SubjectAppearanceMemory): void {
  mem.slots = [];
  pushUpdate(mem, { atSec: -1, kind: 'tentative', accepted: true, reason: 'cleared' });
}

export function forgetIfVideoChanged(
  mem: SubjectAppearanceMemory,
  videoId: string,
  projectId: string,
): boolean {
  if (inScope(mem, videoId, projectId)) return false;
  clearSubjectMemory(mem);
  mem.videoId = videoId;
  mem.projectId = projectId;
  return true;
}
