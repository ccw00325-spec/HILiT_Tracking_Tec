/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·af2e74ee @license @preserve */
/**
 * 편집 2단계의 사람 후보 검출 — 작업자(public/person-detector/worker.js)를 부른다.
 *
 * 모델: MediaPipe ObjectDetector + EfficientDet-Lite0 int8 (둘 다 Apache-2.0).
 * 실사 184장(model-reviewed 정답)에서 문턱 0.3 기준 정밀도 74% · 재현율 72%,
 * 놓친 사람을 눌러 다시 찾으면 합산 재현율 92%. 예전 자체 격자 검출기는
 * 같은 자료에서 F1 0.04 였다.
 *
 * 영상 프레임은 이 기기 안에서만 다룬다. 작업자는 같은 출처 파일만 읽고,
 * MediaPipe 가 보내려는 사용 통계는 보안 정책과 fetch 가드로 막는다.
 *
 * 🔴 점수는 "사람처럼 보이는 정도" 다. 동일인 확률이 아니다.
 */
import {
  PERSON_SCORE_MIN,
  TAP_CROP_FRACTIONS,
  TAP_CROP_INPUT,
  TAP_SCORE_MIN,
  fromCrop,
  pickTapHit,
  selectPickerProposals,
  selectDistinctProposals,
  selectProposals,
  tapCrop,
  type ScoredPxBox,
} from '@/lib/person-box-fit';

const WORKER_URL = '/person-detector/worker.js';

type Reply = { id: number; ok: boolean; hits?: ScoredPxBox[]; error?: string; elapsedMs?: number };

/**
 * 작업자 답을 기다리는 한도. 작업자가 끝내 답하지 않으면 화면이 「찾는 중」에 영원히 멈추므로 상한을 둔다.
 *
 * 적재(WASM 약 12MB + 모델 4.6MB 내려받기)는 **끊고 다시 받지 않는다.** 2026-11-03 에뮬레이터·운영 실측에서 30초 한도가
 * 느린 회선의 정상 내려받기를 끊고 처음부터 다시 받게 해, 두 번째도 끝나지 못하고 실패했다(PR #77 → #78 수정).
 * 그래서 한 번만, 느린 회선도 받을 만큼 넉넉히 기다린다. 검출 한 장은 받을 것이 없으므로 짧게 둔다.
 */
export const DETECTOR_LOAD_TIMEOUT_MS = 180_000;
export const DETECTOR_DETECT_TIMEOUT_MS = 20_000;

export class PersonDetectorClient {
  private worker: Worker | null = null;
  private seq = 0;
  private waiting = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>();
  private ready: Promise<void> | null = null;

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(WORKER_URL);
    worker.onmessage = (event: MessageEvent<Reply>) => {
      const w = this.waiting.get(event.data.id);
      if (!w) return;
      this.waiting.delete(event.data.id);
      if (event.data.ok) w.resolve(event.data);
      else w.reject(new Error(event.data.error || '사람 검출에 실패했습니다.'));
    };
    worker.onerror = () => {
      /* 작업자가 죽으면 기다리던 요청을 모두 풀어 준다. 다음 호출에서 새로 띄운다. */
      this.abandon(new Error('사람 검출기를 열지 못했습니다.'));
    };
    this.worker = worker;
    return worker;
  }

  /** 이 작업자를 버린다. 기다리던 요청은 모두 실패로 풀고, 다음 호출이 새로 띄운다. */
  private abandon(reason: Error) {
    const waiting = [...this.waiting.values()];
    this.waiting.clear();
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const w of waiting) w.reject(reason);
  }

  private call(message: Record<string, unknown>, transfer: Transferable[], timeoutMs: number): Promise<Reply> {
    const worker = this.ensureWorker();
    const id = ++this.seq;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.worker === worker) this.abandon(new Error('사람 검출기가 응답하지 않습니다.'));
      }, timeoutMs);
      const settle = <T,>(done: (value: T) => void) => (value: T) => { clearTimeout(timer); done(value); };
      this.waiting.set(id, { resolve: settle(resolve), reject: settle(reject) });
      worker.postMessage({ ...message, id }, transfer);
    });
  }


  /** 모델을 미리 올려 둔다. 첫 검출이 1~2초 늦어지는 것을 화면에 들어올 때 치른다. */
  warmUp(): Promise<void> {
    if (!this.ready) {
      const ready = this.call({ type: 'load' }, [], DETECTOR_LOAD_TIMEOUT_MS).then(() => undefined);
      this.ready = ready;
      ready.catch(() => { if (this.ready === ready) this.ready = null; });
    }
    return this.ready;
  }

  async detect(bitmap: ImageBitmap): Promise<ScoredPxBox[]> {
    await this.warmUp();
    const reply = await this.call({ type: 'detect', bitmap }, [bitmap], DETECTOR_DETECT_TIMEOUT_MS);
    return reply.hits ?? [];
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    for (const w of this.waiting.values()) w.reject(new Error('취소했습니다.'));
    this.waiting.clear();
  }
}

let shared: PersonDetectorClient | null = null;

function client(): PersonDetectorClient {
  if (!shared) shared = new PersonDetectorClient();
  return shared;
}

export function personDetectorSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof Worker !== 'undefined'
    && typeof createImageBitmap === 'function'
    && typeof WebAssembly !== 'undefined';
}

export function warmUpPersonDetector(): void {
  if (!personDetectorSupported()) return;
  void client().warmUp().catch(() => undefined);
}

/** 화면 전체에서 사람 상자. 문턱·크기·개수 제한을 건 뒤 돌려준다(픽셀 좌표). */
export async function detectPeople(
  canvas: HTMLCanvasElement,
  options?: { distinct?: boolean },
): Promise<ScoredPxBox[]> {
  const bitmap = await createImageBitmap(canvas);
  const hits = await client().detect(bitmap);
  const eligible = hits.filter((h) => h.score >= PERSON_SCORE_MIN);
  const choose = options?.distinct === true ? selectDistinctProposals : selectProposals;
  return choose(eligible, canvas.height);
}

/** 타임라인 바에서 사람을 고르는 화면의 후보. 사람 모양인 낮은 점수 상자까지 보인다(person-box-fit selectPickerProposals). */
export async function detectPickerPeople(canvas: HTMLCanvasElement): Promise<ScoredPxBox[]> {
  const bitmap = await createImageBitmap(canvas);
  return selectPickerProposals(await client().detect(bitmap), canvas.height);
}

/**
 * 추적 확인용 — 문턱만 낮춰 걸고 개수·크기 제한 없이 돌려준다(픽셀 좌표).
 *
 * 화면에 띄우는 후보(detectPeople)와 목적이 다르다. 여기서는 추적 상자 아래에
 * 사람이 있는지만 보므로, 놓치는 쪽(사람이 있는데 없다고 함)이 더 비싸다.
 * 근거: tracking-core/presence-check.ts
 */
export async function detectPeopleForCheck(canvas: HTMLCanvasElement, scoreMin: number): Promise<ScoredPxBox[]> {
  const bitmap = await createImageBitmap(canvas);
  const hits = await client().detect(bitmap);
  return hits.filter((h) => h.score >= scoreMin);
}

/**
 * 누른 자리를 확대해 다시 본다. 화면 전체로는 작아서 놓친 사람을 여기서 건진다.
 * 누른 점을 품은 상자가 없으면 null.
 */
export async function detectPersonAt(
  canvas: HTMLCanvasElement,
  tap: { x: number; y: number },
): Promise<ScoredPxBox | null> {
  const found: ScoredPxBox[] = [];
  for (const fraction of TAP_CROP_FRACTIONS) {
    const crop = tapCrop(canvas.width, canvas.height, tap, fraction);
    const bitmap = await createImageBitmap(canvas, crop.sx, crop.sy, crop.side, crop.side, {
      resizeWidth: TAP_CROP_INPUT,
      resizeHeight: TAP_CROP_INPUT,
    });
    const hits = await client().detect(bitmap);
    for (const h of hits) if (h.score >= TAP_SCORE_MIN) found.push(fromCrop(h, crop));
  }
  return pickTapHit(found, tap);
}

export function disposePersonDetector(): void {
  shared?.dispose();
  shared = null;
}
