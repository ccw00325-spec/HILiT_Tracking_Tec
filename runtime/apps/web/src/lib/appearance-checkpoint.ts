/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·7a5a07f6 @license @preserve */
'use client';

/* 검증된 외형 특징만 앱 전용 IndexedDB 에 둔다.

OPFS 는 쓰지 않는다. 특징은 작은 구조화 값이라 IndexedDB 한 곳이 맞다.
원본 영상 autosave 와 초안 7일 TTL 을 여기에 적용하지 않는다.
실패하면 RAM-only 로 추적한다. 추적 자체를 실패시키지 않는다.
잠정 표본은 저장하지 않는다. crop·원본 바이트는 넣지 않는다.
*/

import {
  APPEARANCE_GALLERY_POLICY,
  appearanceStoreKey,
  EXTRACTOR_VERSION,
  HSV_TEXTURE_EXTRACTOR_ID,
  scopesCompatible,
  type AppearanceCheckpointSnapshot,
  type AppearanceScope,
} from '@hilit/vision';
import { decideAppearanceCheckpoint } from './storage/cleanup-policy';

export const APPEARANCE_DB = 'hilit-appearance-checkpoint';
export const APPEARANCE_STORE = 'snapshots';
export const APPEARANCE_DB_VERSION = 1;

export const APPEARANCE_USER_NOTICE =
  '추적 정확도 향상을 위해 선택한 대상의 특징을 이 기기에 임시 저장합니다. 해당 특징과 임시 이미지는 서버로 전송하지 않으며, 작업 종료 또는 보관 기간 만료 후 정리합니다.';

export type AppearanceRecoveryKind =
  | 'feature-reuse'
  | 'missing'
  | 'expired'
  | 'incompatible'
  | 'owner-mismatch'
  | 'corrupt'
  | 'no-original'
  | 'ram-only'
  | 'deleted';

export interface AppearanceRecovery {
  kind: AppearanceRecoveryKind;
  snapshot: AppearanceCheckpointSnapshot | null;
  persistAvailable: boolean;
  resumeTracking: false;
  message: string;
}

export interface CheckpointBackend {
  get(key: string): Promise<StoredRow | null>;
  put(key: string, value: StoredRow): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

export interface StoredRow {
  snapshot: AppearanceCheckpointSnapshot;
  generation: number;
  deleted: boolean;
  tombstoneAt: number | null;
  writerTabId: string;
}

export class MemoryCheckpointBackend implements CheckpointBackend {
  readonly map = new Map<string, StoredRow>();
  failNextPut = false;
  async get(key: string): Promise<StoredRow | null> {
    return this.map.get(key) ?? null;
  }
  async put(key: string, value: StoredRow): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error('QuotaExceededError');
    }
    this.map.set(key, value);
  }
  async del(key: string): Promise<void> {
    this.map.delete(key);
  }
  async keys(): Promise<string[]> {
    return [...this.map.keys()];
  }
}

function openIdb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(APPEARANCE_DB, APPEARANCE_DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(APPEARANCE_STORE)) db.createObjectStore(APPEARANCE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

export class IndexedDbCheckpointBackend implements CheckpointBackend {
  async get(key: string): Promise<StoredRow | null> {
    const db = await openIdb();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const req = db.transaction(APPEARANCE_STORE, 'readonly').objectStore(APPEARANCE_STORE).get(key);
        req.onsuccess = () => resolve((req.result as StoredRow | undefined) ?? null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  async put(key: string, value: StoredRow): Promise<void> {
    const db = await openIdb();
    if (!db) throw new Error('indexeddb-unavailable');
    await new Promise<void>((resolve, reject) => {
      try {
        const req = db.transaction(APPEARANCE_STORE, 'readwrite').objectStore(APPEARANCE_STORE).put(value, key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error('indexeddb-put-failed'));
      } catch (err) {
        reject(err);
      }
    });
  }
  async del(key: string): Promise<void> {
    const db = await openIdb();
    if (!db) return;
    await new Promise<void>((resolve) => {
      try {
        const req = db.transaction(APPEARANCE_STORE, 'readwrite').objectStore(APPEARANCE_STORE).delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      } catch {
        resolve();
      }
    });
  }
  async keys(): Promise<string[]> {
    const db = await openIdb();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const req = db.transaction(APPEARANCE_STORE, 'readonly').objectStore(APPEARANCE_STORE).getAllKeys();
        req.onsuccess = () => resolve((req.result as IDBValidKey[]).map(String));
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }
}

export function probeAppearanceStorage(): {
  indexedDB: boolean;
  opfs: false;
  persistMode: 'indexeddb' | 'ram-only';
} {
  const idb = typeof indexedDB !== 'undefined';
  return { indexedDB: idb, opfs: false, persistMode: idb ? 'indexeddb' : 'ram-only' };
}

function snapshotLooksCorrupt(snap: AppearanceCheckpointSnapshot): boolean {
  if (!snap || snap.schemaVersion !== APPEARANCE_GALLERY_POLICY.gallerySchemaVersion) return true;
  if (!Array.isArray(snap.samples)) return true;
  if (snap.extractorId !== HSV_TEXTURE_EXTRACTOR_ID || snap.extractorVersion !== EXTRACTOR_VERSION) return true;
  for (const s of snap.samples) {
    if (s.source !== 'user_anchor' && s.source !== 'verified_auto') return true;
    if (!Array.isArray(s.values) || s.values.some((v) => !Number.isFinite(v))) return true;
    if ('rgb' in s || 'crop' in s || 'videoBytes' in s) return true;
  }
  return false;
}

export class AppearanceCheckpointWriter {
  readonly tabId: string;
  private inFlight = false;
  private queued: AppearanceCheckpointSnapshot | null = null;
  lastGeneration = 0;

  constructor(
    readonly backend: CheckpointBackend,
    readonly persistAvailable: boolean,
    tabId?: string,
  ) {
    this.tabId = tabId ?? `tab:${Math.random().toString(36).slice(2)}`;
  }

  async save(snap: AppearanceCheckpointSnapshot): Promise<{ ok: boolean; reason: string; keptPrevious: boolean }> {
    if (!this.persistAvailable) return { ok: false, reason: 'storage-unavailable', keptPrevious: true };
    if (this.inFlight) {
      this.queued = snap;
      return { ok: true, reason: 'coalesced', keptPrevious: true };
    }
    this.inFlight = true;
    try {
      return await this.write(snap);
    } finally {
      this.inFlight = false;
      const next = this.queued;
      this.queued = null;
      if (next) void this.save(next);
    }
  }

  private async write(snap: AppearanceCheckpointSnapshot): Promise<{ ok: boolean; reason: string; keptPrevious: boolean }> {
    const key = appearanceStoreKey(snap);
    const existing = await this.backend.get(key);
    if (existing?.deleted && existing.generation >= this.lastGeneration) {
      return { ok: false, reason: 'tombstone', keptPrevious: true };
    }
    if (existing && existing.generation > this.lastGeneration && existing.writerTabId !== this.tabId) {
      return { ok: false, reason: 'stale-writer', keptPrevious: true };
    }
    if (snapshotLooksCorrupt(snap)) {
      return { ok: false, reason: 'corrupt-input', keptPrevious: true };
    }
    const generation = Math.max(this.lastGeneration, existing?.generation ?? 0) + 1;
    const row: StoredRow = {
      snapshot: { ...snap, generation, persistMode: 'indexeddb' },
      generation,
      deleted: false,
      tombstoneAt: null,
      writerTabId: this.tabId,
    };
    try {
      await this.backend.put(key, row);
      this.lastGeneration = generation;
      return { ok: true, reason: 'saved', keptPrevious: false };
    } catch {
      return { ok: false, reason: 'write-failed', keptPrevious: true };
    }
  }

  async load(scope: AppearanceScope, input: {
    now?: number;
    originalAccessible: boolean;
    activeJob?: boolean;
  }): Promise<AppearanceRecovery> {
    const persistAvailable = this.persistAvailable;
    const ram = (kind: AppearanceRecoveryKind, message: string): AppearanceRecovery => ({
      kind, snapshot: null, persistAvailable, resumeTracking: false, message,
    });
    if (!persistAvailable) {
      return ram('ram-only', '이 기기에서 특징을 저장할 수 없어 이번 분석만 기억합니다. 추적은 계속됩니다.');
    }
    const key = appearanceStoreKey(scope);
    const row = await this.backend.get(key);
    if (!row) return ram('missing', '저장된 특징이 없습니다. 영상을 다시 분석하면 됩니다.');
    if (row.deleted) return ram('deleted', '이 작업의 임시 특징은 이미 지웠습니다.');
    const snap = row.snapshot;
    if (snapshotLooksCorrupt(snap)) return ram('corrupt', '저장된 특징이 손상되어 쓰지 않습니다. 다시 분석하면 됩니다.');
    if (!scopesCompatible(snap, scope)) {
      return ram('owner-mismatch', '다른 계정 또는 다른 영상의 특징은 쓰지 않습니다.');
    }
    if (!input.originalAccessible) {
      return ram('no-original', '원본 영상에 다시 접근해야 특징을 재분석에 쓸 수 있습니다. 추적을 이어서 이어간 것은 아닙니다.');
    }
    const now = input.now ?? Date.now();
    const inactiveMs = now - snap.lastUsedAt;
    const decision = decideAppearanceCheckpoint({
      inactiveMinutes: inactiveMs / 60_000,
      activeJob: input.activeJob === true,
      ownerMatch: true,
      explicitDelete: false,
      referencedByOpenWork: input.activeJob === true,
    });
    if (decision.action === 'DELETE') {
      return ram('expired', '보관 기간이 지난 특징은 쓰지 않습니다. 다시 분석하면 됩니다.');
    }
    if (now > snap.expiresAt && input.activeJob !== true) {
      return ram('expired', '보관 기간이 지난 특징은 쓰지 않습니다. 다시 분석하면 됩니다.');
    }
    this.lastGeneration = row.generation;
    return {
      kind: 'feature-reuse',
      snapshot: snap,
      persistAvailable,
      resumeTracking: false,
      message: '이 기기에 남은 특징을 재분석에 쓸 수 있습니다. 중간 프레임부터 이어서 추적한 것은 아닙니다.',
    };
  }

  async remove(scope: Pick<AppearanceScope, 'ownerId' | 'videoId' | 'subjectId'>): Promise<void> {
    const key = appearanceStoreKey(scope);
    const existing = await this.backend.get(key);
    const generation = (existing?.generation ?? this.lastGeneration) + 1;
    const tombstone: StoredRow = {
      snapshot: existing?.snapshot ?? emptyTombstone(scope, generation),
      generation,
      deleted: true,
      tombstoneAt: Date.now(),
      writerTabId: this.tabId,
    };
    try {
      await this.backend.put(key, tombstone);
    } catch {
      await this.backend.del(key);
    }
    this.lastGeneration = generation;
  }

  async clearOwner(ownerId: string): Promise<number> {
    const keys = await this.backend.keys();
    let n = 0;
    for (const key of keys) {
      const row = await this.backend.get(key);
      if (!row) continue;
      if (row.snapshot.ownerId !== ownerId && !key.startsWith(`${ownerId}\u0000`)) continue;
      await this.remove({
        ownerId: row.snapshot.ownerId,
        videoId: row.snapshot.videoId,
        subjectId: row.snapshot.subjectId,
      });
      n += 1;
    }
    return n;
  }

  async clearAll(): Promise<number> {
    const keys = await this.backend.keys();
    for (const key of keys) await this.backend.del(key);
    this.lastGeneration += 1;
    return keys.length;
  }

  async purgeExpired(now = Date.now(), activeKeys: ReadonlySet<string> = new Set()): Promise<number> {
    const keys = await this.backend.keys();
    let n = 0;
    for (const key of keys) {
      if (activeKeys.has(key)) continue;
      const row = await this.backend.get(key);
      if (!row || row.deleted) continue;
      const inactiveMinutes = (now - row.snapshot.lastUsedAt) / 60_000;
      const decision = decideAppearanceCheckpoint({
        inactiveMinutes,
        activeJob: false,
        ownerMatch: true,
        explicitDelete: false,
        referencedByOpenWork: false,
      });
      if (decision.action === 'DELETE') {
        await this.remove(row.snapshot);
        n += 1;
      }
    }
    return n;
  }
}

function emptyTombstone(
  scope: Pick<AppearanceScope, 'ownerId' | 'videoId' | 'subjectId'>,
  generation: number,
): AppearanceCheckpointSnapshot {
  return {
    schemaVersion: APPEARANCE_GALLERY_POLICY.gallerySchemaVersion,
    policyVersion: APPEARANCE_GALLERY_POLICY.policyVersion,
    galleryVersion: 0,
    generation,
    ownerId: scope.ownerId,
    videoId: scope.videoId,
    subjectId: scope.subjectId,
    runId: 'deleted',
    persistMode: 'indexeddb',
    extractorId: HSV_TEXTURE_EXTRACTOR_ID,
    extractorVersion: EXTRACTOR_VERSION,
    currentStateId: 'none',
    states: [],
    samples: [],
    recent: null,
    slow: null,
    createdAt: 0,
    lastUsedAt: 0,
    expiresAt: 0,
    estimatedBytes: 0,
  };
}

let defaultWriter: AppearanceCheckpointWriter | null = null;

export function appearanceCheckpointWriter(backend?: CheckpointBackend): AppearanceCheckpointWriter {
  if (backend) return new AppearanceCheckpointWriter(backend, true);
  if (defaultWriter) return defaultWriter;
  const probe = probeAppearanceStorage();
  defaultWriter = new AppearanceCheckpointWriter(
    probe.indexedDB ? new IndexedDbCheckpointBackend() : new MemoryCheckpointBackend(),
    probe.indexedDB,
  );
  return defaultWriter;
}

export async function clearAllAppearanceCheckpoints(): Promise<number> {
  return appearanceCheckpointWriter().clearAll();
}
