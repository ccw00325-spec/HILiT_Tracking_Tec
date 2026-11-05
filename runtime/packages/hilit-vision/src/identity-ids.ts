/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·79e403eb @license @preserve */
/* 같은 원본 영상 안에서만 쓰는 신원 칸.

날짜·옷·영상 사이의 영구 식별이 아니다. 얼굴 인식이 아니다.
이름 문자열로 사람을 알아봤다고 말하지 않는다.
*/

export type SubjectId = string;
export type TrackId = string;
export type MemberId = string;
export type DisplayName = string;

export type IdentityLinkStatus = 'unlinked' | 'user_linked';

export interface TrackSpan {
  trackId: TrackId;
  subjectId: SubjectId;
  startSec: number;
  endSec: number;
  status: 'confirmed' | 'uncertain' | 'needs_confirm';
}

export interface IdentityRecord {
  subjectId: SubjectId;
  displayName: DisplayName;
  memberId: MemberId | null;
  memberLink: IdentityLinkStatus;
  trackSpans: TrackSpan[];
  videoId: string;
  projectId: string;
}

export function createIdentityRecord(input: {
  subjectId: SubjectId;
  displayName: DisplayName;
  videoId: string;
  projectId: string;
  memberId?: MemberId | null;
}): IdentityRecord {
  const name = input.displayName.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('표시 이름이 비어 있습니다. 이름만으로 신원을 정하지 않습니다.');
  if (!input.subjectId.trim()) throw new Error('subjectId 가 필요합니다.');
  if (!input.videoId.trim() || !input.projectId.trim()) {
    throw new Error('외형 기억은 그 영상·프로젝트 안에서만 둡니다.');
  }
  return {
    subjectId: input.subjectId.trim(),
    displayName: name,
    memberId: input.memberId?.trim() || null,
    memberLink: input.memberId?.trim() ? 'user_linked' : 'unlinked',
    trackSpans: [],
    videoId: input.videoId.trim(),
    projectId: input.projectId.trim(),
  };
}

/** 화면 이름만 바꾼다. subjectId·구간 연결은 그대로다. */
export function renameDisplayName(record: IdentityRecord, displayName: DisplayName): IdentityRecord {
  const name = displayName.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('표시 이름을 비울 수 없습니다.');
  return { ...record, displayName: name };
}

/** 회원 계정 연결. 영상 속 사람이 확인된 것은 아니다. */
export function linkMemberAccount(record: IdentityRecord, memberId: MemberId | null): IdentityRecord {
  const id = memberId?.trim() || null;
  return {
    ...record,
    memberId: id,
    memberLink: id ? 'user_linked' : 'unlinked',
  };
}

export function attachTrackSpan(record: IdentityRecord, span: Omit<TrackSpan, 'subjectId'>): IdentityRecord {
  if (span.endSec < span.startSec) throw new Error('구간 끝이 시작보다 앞입니다.');
  const next: TrackSpan = {
    ...span,
    subjectId: record.subjectId,
  };
  const others = record.trackSpans.filter((row) => row.trackId !== next.trackId);
  return { ...record, trackSpans: [...others, next].sort((a, b) => a.startSec - b.startSec) };
}

export function tracksForSubject(record: IdentityRecord): TrackSpan[] {
  return record.trackSpans.filter((row) => row.subjectId === record.subjectId);
}

export function assertSameProject(record: IdentityRecord, videoId: string, projectId: string): boolean {
  return record.videoId === videoId && record.projectId === projectId;
}

export function resolveByDisplayName(
  records: readonly IdentityRecord[],
  name: string,
): IdentityRecord[] {
  const folded = name.replace(/\s+/g, '').toLowerCase();
  return records.filter((row) => row.displayName.replace(/\s+/g, '').toLowerCase() === folded);
}
