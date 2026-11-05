/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·2c500754 @license @preserve */
import { clamp01, type NormalizedBBox, type TrackingPoint, type VideoMetadata } from '@hilit/shared-types';
import {
  PRESENCE_CHECK, parseProductionProfile,
  type PresenceSample, type TrackingProgress, type ProductionProfile,
} from '@hilit/tracking-core';

/**
 * 운영 추적 설정(0079) — 연구실 가중치 담당자가 「운영에 적용」한 판정 문턱·판정기.
 * 추적을 시작할 때 받아 두고 끝날 때 상태만 다시 매긴다. 못 받으면 null(추적기 판단 그대로).
 * 같은 주소를 APK 네이티브 편집기도 쓴다(ProductionProfile.java).
 */
async function fetchProductionProfile(): Promise<ProductionProfile | null> {
  if (typeof fetch !== 'function') return null;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch('/api/tracking/profile', { cache: 'no-store', signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const body = await r.json() as { profile?: unknown };
    return parseProductionProfile(body.profile ?? null);
  } catch { return null; }
}
import {
  confirmedViewsToPipeline,
  describe as describeAppearance,
  newAppearanceRunId,
  ownerScopeId,
  similarity as appearanceSimilarity,
  runEditSpanSearch,
  bandProgressMessage,
  EDIT_SPAN_MEASUREMENT,
  type ConfirmedSubjectView,
  type Descriptor,
  type EditSpanResult,
  runTemporalContext,
  planContextEvents,
  patchObservations,
  type TemporalContextResult,
} from '@hilit/vision';
import { ContextFrameDecoder } from '@/lib/context-frame-decoder';
import { fromDetectorHits, type PersonCandidate } from '@/lib/person-candidates';
import { DISTINCT_PERSON_PROPOSALS, tapFallbackBox, trimBoxWidth } from '@/lib/person-box-fit';
import { detectPeople, detectPeopleForCheck, detectPersonAt, detectPickerPeople, personDetectorSupported } from '@/lib/mediapipe-person-detector';
import {
  appearanceCheckpointWriter,
  probeAppearanceStorage,
} from '@/lib/appearance-checkpoint';
import { postprocessPocResult } from '@/lib/tracking-postprocess';

export interface PocMeta { srcWidth: number; srcHeight: number; width: number; height: number; duration: number; scale: number; orientation: 'landscape' | 'portrait'; analysisFps: number }
export interface PocReview { t?: number; frame?: number; reason?: string }
export interface PocDoubtSpan { start: number; end: number; reason: string | null; resolved: boolean; level?: 'watch' | 'risk' }
export interface PocResult { trajectory: Array<{ t: number; box: { x: number; y: number; w?: number; h?: number; width?: number; height?: number }; state: string; health: number; reid: number | null; confidence: number; unverified?: boolean; watching?: boolean; identityLifecycle?: TrackingPoint['identityLifecycle']; nearbyBoxes?: Array<{ x: number; y: number; width: number; height: number }>; engineAbsent?: boolean }>; reviews: PocReview[]; events: unknown[]; causes: Record<string, number>; metrics: Record<string, number | null>; limits: Record<string, boolean>; uncertainAt?: number[]; doubtSpans?: PocDoubtSpan[]; verified?: boolean; autoRecovery?: string; detector?: string; detectorReason?: string;
  /** 추적 경로 이름. 'linked-v1' = 검출 연결 추적(2026-10-20 기본), 없으면 예전 경로. */
  engine?: string;
  stoppedForAsk?: { t: number; reason?: string; lastBox?: { x: number; y: number; width: number; height: number } | null;
    /** 엔진이 「이 사람이 맞나요?」로 먼저 보여 줄 사람(가장 닮은 사람). 신원 판정이 아니다. */
    proposal?: { t: number; box: { x: number; y: number; width: number; height: number } } | null } | null }

export interface DoubtSpan { start: number; end: number; reason: string | null; resolved: boolean;
  /** 'watch' = 가려져 있지만 자리는 안다(묻지 않는다) · 'risk' = 다른 사람일 수 있다(묻는다) */
  level: 'watch' | 'risk' }
export interface TrackingRun { points: TrackingPoint[]; rawPoints?: TrackingPoint[]; reviews: unknown[]; events: unknown[]; causes: Record<string, number>; metrics: Record<string, number | null>; limits: Record<string, boolean>; doubtSpans: DoubtSpan[];
  contextReports?: Array<{ eventTime: number; report: TemporalContextResult | null; error: string | null }>;
  verified?: boolean; autoRecovery?: string; detector?: string; detectorReason?: string;
  /** stopOnAsk 로 헷갈리는 자리에서 멈췄으면 그 시각·사유와 마지막으로 확인한 자리(정규화). 궤적은 그 직후까지만 있다. */
  /** 추적 경로 이름(PocResult.engine). */
  engine?: string;
  stoppedForAsk?: { t: number; reason: string; lastBox: NormalizedBBox | null;
    /** 「이 사람이 맞나요?」로 먼저 보여 줄 사람(정규화). 없으면 예전처럼 후보 중에서 고르게 한다. */
    proposal?: { t: number; box: NormalizedBBox } | null } | null }

export class WebTrackingEngine {
  readonly platform = 'web' as const;
  private disposed = false;
  // PoC 파이프라인은 box.width / box.height 로 읽는다. w / h 로 넘기면
  // undefined 가 되어 추적 전체가 조용히 NaN 이 된다 — 아래 track() 참조.
  private pipeline?: {
    openVideo(file: File): Promise<PocMeta>;
    loadModels(options?: Record<string, unknown>): Promise<unknown>;
    candidatesAt?(time?: number): Promise<{
      candidates: unknown[]; frame: string; time?: number; detectorAvailable?: boolean;
      detectorOutcome?: string; detectorModel?: string | null; detectorQuality?: string;
    }>;
    firstFrameCandidates?(): Promise<{
      candidates: unknown[]; frame: string; time?: number; detectorAvailable?: boolean;
    }>;
    track(box: {x:number;y:number;width:number;height:number}, options?: Record<string, unknown>): Promise<PocResult>;
    /** 그 시각으로 옮겨 분석 캔버스에 한 장 그린다(pipeline.js seekDraw). */
    seekDraw?(t: number): Promise<CanvasRenderingContext2D>;
    dispose(): void;
    /* 파이프라인이 프레임을 디코딩하는 <video>.
     *
     * 화면 밖(2px · opacity 0.01)에 있지만 렌더 트리에는 남아 있다 —
     * requestVideoFrameCallback 은 프레임이 실제로 표시될 때만 불리기
     * 때문이다(pipeline.js openVideo 주석). 추적 중 실시간 화면이 이
     * 엘리먼트를 그린다. */
    video: HTMLVideoElement | null;
  };
  private meta?: PocMeta;
  private openedFile?: File;
  private contextEpoch = 0;
  private contextAbort?: AbortController;
  private progress?: (progress: TrackingProgress) => void;

  /**
   * 추적 중 실제로 프레임이 도는 <video>.
   *
   * 편집기의 미리보기 <video> 와 **다른 엘리먼트**다. 파이프라인은 자기
   * 것을 따로 열어 되감으며 읽는다. 실시간 화면이 편집기 쪽 엘리먼트를
   * 그리면 추적이 도는 내내 정지 화면이 나온다 — 그쪽은 아무도 안
   * 움직이기 때문이다. 실제로 그랬다.
   */
  get liveVideo(): HTMLVideoElement | null {
    return this.pipeline?.video ?? null;
  }

  /** 진행률을 받을 곳을 바꾼다. 타임라인 편집은 영상을 다시 열지 않고 클립마다 진행률만 받는다. */
  setProgress(onProgress?: (progress: TrackingProgress) => void) {
    this.progress = onProgress;
  }

  /**
   * 이 파일이 이미 열려 있으면 다시 열지 않는다. 다시 열면 숨은 영상이 쌓이고, 검출 표본(pipe._linkedCache)을
   * 잃어 같은 클립에서 사람만 바꿔 고를 때도 검출을 처음부터 다시 한다.
   */
  async ensureOpen(file: File): Promise<void> {
    if (this.pipeline && this.meta && this.openedFile === file) return;
    await this.open(file, this.progress);
  }

  async open(file: File, onProgress?: (progress: TrackingProgress) => void): Promise<VideoMetadata> {
    if (this.disposed) throw abortError();
    this.contextEpoch += 1;
    this.contextAbort?.abort();
    this.progress = onProgress;
    // Public ESM is copied verbatim from the existing tracking PoC and loaded at runtime.
    // @ts-expect-error The module lives in public/ and intentionally is not bundled.
    const pipelineModule = await import(/* webpackIgnore: true */ '/tracking/pipeline.js');
    if (this.disposed) throw abortError();
    const pipeline = new pipelineModule.BrowserPipeline({ weightsBase: '/tracking/models/', onProgress: (event: Record<string, unknown>) => {
      const phase = event.phase === 'track' ? 'track' : 'models';
      this.progress?.({ phase, percent: typeof event.percent === 'number' ? event.percent : undefined, message: typeof event.message === 'string' ? event.message : undefined, fps: typeof event.fps === 'number' ? event.fps : undefined });
    }});
    if (this.disposed) {
      pipeline.dispose();
      throw abortError();
    }
    this.pipeline?.dispose();
    this.openedFile = undefined;
    this.pipeline = pipeline;
    try {
      const meta = await pipeline.openVideo(file);
      if (this.disposed || this.pipeline !== pipeline) throw abortError();
      this.meta = meta;
      this.openedFile = file;
      return { name: file.name, duration: meta.duration, width: meta.srcWidth, height: meta.srcHeight, orientation: meta.orientation, size: file.size, mimeType: file.type };
    } catch (cause) {
      pipeline.dispose();
      if (this.pipeline === pipeline) this.pipeline = undefined;
      this.meta = undefined;
      throw cause;
    }
  }

  /* 모델을 미리 받아 둔다.
   *
   * 위치 추적기는 가중치가 없다. 검출기는 2026-09-16 에 빼서 받을 파일이
   * 없다. 호출은 남겨 둔다 — 파이프라인이 캐시 정리(dropNanotrackCaches)를
   * 여기서 하기 때문이다. */
  async preloadModels(): Promise<void> {
    if (!this.pipeline) return;
    try { await this.pipeline.loadModels(); } catch { /* 추적 시작 때 다시 받는다 */ }
  }

  /** startTime: 사용자가 대상을 고른 시각. 첫 프레임에 본인이 없을 수
   *  있으므로 0 이 아닐 수 있다.
   *  endTime: 여기까지만 추적한다. AI 컷으로 고른 마지막 구간의 끝이다.
   *  생략하면 영상 끝까지 — 예전 동작과 같다.
   *
   *  범위를 좁히는 것이 왜 중요한가는 pipeline.js track() 주석 참조.
   *  요약하면, 쓰지 않을 구간을 처리하지 않는 것뿐이고 프레임별 계산은
   *  하나도 달라지지 않는다. */
  async track(target: NormalizedBBox, signal?: AbortSignal,
              startTime = 0, endTime?: number,
              ids?: {
                videoId?: string | null;
                subjectId?: string | null;
                confirmedViews?: readonly ConfirmedSubjectView[];
                ownerId?: string | null;
                runId?: string | null;
                /** startTime 에서 고른 사람을 이 시각부터 endTime 까지 앞뒤로 찾는다(linked-tracker.js fromTime). */
                fromTime?: number;
                /** 헷갈리는 자리에서 멈추고 돌려준다(pipeline.js stopOnAsk). 편집기가 바로 묻는다. */
                stopOnAsk?: boolean;
                /** 이 시각 전에는 멈춰 묻지 않는다 — 「여기 없어요」라고 답한 구간(pipeline.js askNotBefore). */
                askNotBefore?: number;
                /** 묻기를 건너뛰었다 — 외형이 어긋나도 얼리지 않고 끝까지 따라간다(pipeline.js followThrough). */
                followThrough?: boolean;
                /** 사용자가 "내가 아니다" 라고 한 상자(정규화). 이 영상 안에서만 확정 타인으로 기억한다(pipeline.js rejectedViews). */
                rejectedViews?: readonly { time: number; box: NormalizedBBox }[];
                /** 연구실에서 명시적으로 켠 별도 문맥 실험. 제품 기본값은 꺼져 있다. */
                contextShadow?: boolean;
                /** 위치 추적기 수치 계산을 GPU(WebGPU)로 돌린다(pipeline.js computeBackend, 2026-10-12).
                 *  크레딧을 차감하고 진행하는 흐름만 'gpu' 를 넘긴다. GPU 가 없으면 파이프라인이 CPU 로 돌아간다. */
                computeBackend?: 'cpu' | 'gpu';
              }): Promise<TrackingRun> {
    if (!this.pipeline || !this.meta) throw new Error('먼저 영상을 열어주세요.');
    /* 추적과 나란히 받아 둔다 — 추적이 끝날 때쯤이면 이미 와 있다. */
    const profilePromise = fetchProductionProfile();
    /* 키 이름이 중요하다.
     *
     * PoC 파이프라인은 box.width / box.height 를 읽는다.
     *
     *   public/tracking 자체 추적기
     *     box.width / box.height 를 읽는다.
     *
     * 여기서 w / h 로 넘기고 있었다. 그러면 this.w 가 undefined 가 되고
     * contextSize(undefined, undefined) 부터 모든 계산이 NaN 이 된다.
     * 그런데 아무 예외도 나지 않는다 —
     *
     *   clamp01(v) = v < 0 ? 0 : v > 1 ? 1 : v
     *
     * 는 NaN 비교가 항상 false 라서 NaN 을 그대로 통과시키고,
     * healthMean 의 `?? 0` 도 NaN 은 잡지 못한다.
     *
     * 실측 증상 (수정 전):
     *   평균 건강도  NaN
     *   평균 Re-ID   1.00   <- 박스가 NaN 이면 서술자가 비고,
     *                          측정 실패는 "유사도 1.0" 으로 취급된다
     *   하이라이트는 오디오/장면 특징만으로 만들어졌다
     *
     * 화면과 HTTP 응답은 정상으로 보였다. 브라우저에서 실제로 돌려봐야
     * 드러나는 종류의 버그다.
     */
    const box = {
      x: target.x * this.meta.width,
      y: target.y * this.meta.height,
      width: target.width * this.meta.width,
      height: target.height * this.meta.height,
    };
    if (![box.x, box.y, box.width, box.height].every(Number.isFinite)
        || box.width < 1 || box.height < 1) {
      throw new Error('선택한 영역이 너무 작거나 좌표를 읽을 수 없습니다. 다시 드래그해 주세요.');
    }
    const confirmedViews = this.meta && ids?.confirmedViews?.length
      ? confirmedViewsToPipeline(ids.confirmedViews, {
        width: this.meta.width,
        height: this.meta.height,
        duration: this.meta.duration,
      })
      : [];
    const ownerId = ownerScopeId(ids?.ownerId);
    const videoId = ids?.videoId || 'unknown-video';
    const subjectId = ids?.subjectId || 'manual-box';
    const runId = ids?.runId || newAppearanceRunId();
    const probe = probeAppearanceStorage();
    const writer = appearanceCheckpointWriter();
    const result = await this.pipeline.track(box, {
      signal, startTime,
      ...(Number.isFinite(endTime) ? { endTime } : {}),
      videoId,
      subjectId,
      ownerId,
      runId,
      originalAccessible: true,
      persistAppearance: probe.persistMode === 'indexeddb'
        ? (snap: unknown) => writer.save(snap as Parameters<typeof writer.save>[0])
        : null,
      restoreAppearance: probe.persistMode === 'indexeddb'
        ? (opts: { originalAccessible: boolean }) => writer.load(
          { ownerId, videoId, subjectId, runId },
          { originalAccessible: opts.originalAccessible, activeJob: true },
        )
        : null,
      ...(confirmedViews.length ? { confirmedViews } : {}),
      ...(typeof ids?.fromTime === 'number' && Number.isFinite(ids.fromTime) ? { fromTime: ids.fromTime } : {}),
      ...(ids?.stopOnAsk ? { stopOnAsk: true } : {}),
      ...(typeof ids?.askNotBefore === 'number' && Number.isFinite(ids.askNotBefore) ? { askNotBefore: ids.askNotBefore } : {}),
      ...(ids?.followThrough ? { followThrough: true } : {}),
      ...(ids?.computeBackend === 'gpu' ? { computeBackend: 'gpu' } : {}),
      ...(ids?.rejectedViews?.length ? {
        rejectedViews: ids.rejectedViews.map((r) => ({
          time: r.time,
          box: { x: r.box.x * this.meta!.width, y: r.box.y * this.meta!.height, width: r.box.width * this.meta!.width, height: r.box.height * this.meta!.height },
        })),
      } : {}),
      /* 추적 중 0.5초(영상 시간)마다 사람 검출로 상자를 바로잡고, 사람이 딴 자리에 있으면 묻는다
       * (public/tracking/detection-anchor.js, docs/tracking-research/2026-09-28-tracker-drift-determinism.md).
       * 검출기는 편집 2단계와 같은 MediaPipe 작업자다. 점수는 동일인 확률이 아니다. */
      ...(personDetectorSupported() ? {
        personProbe: (canvas: HTMLCanvasElement) => detectPeopleForCheck(canvas, 0.15).catch(() => null),
      } : {}),
      /* 6단계 배경 고착 실험(stage6-continuity.js)은 여기로 넘기지 않는다. 기본값은 꺼져 있다. */
    });
    const profile = await profilePromise;
    const run = postprocessPocResult(result, this.meta, profile);
    if (ids?.contextShadow === true) {
      run.contextReports = [];
      for (const eventTime of planContextEvents(run.points, run.doubtSpans, startTime, endTime ?? this.meta.duration)) {
        if (signal?.aborted || this.disposed) break;
        try {
          const report = await this.inspectTemporalContext({ eventTime, editStart: startTime,
            editEnd: endTime ?? this.meta.duration, referenceTime: startTime, referenceBox: target,
            rejectedViews: ids.rejectedViews, signal,
            onProgress: (done, max, direction) => this.progress?.({ phase: 'track',
              message: `기본 추적 뒤 별도 문맥 실험: ${direction === 'reverse' ? '역방향 새 관측' : '앞뒤 관측'} ${done}/${max}회`,
            }),
          });
          run.contextReports.push({ eventTime, report, error: null });
        } catch (cause) {
          run.contextReports.push({ eventTime, report: null, error: cause instanceof Error ? cause.message : String(cause) });
        }
      }
    }
    return run;
  }

  /** 그 시각의 분석 프레임 한 장(복사본). 아바타 자동 방향 판정이 본인 상자를 잘라 쓴다. 기기 밖으로 보내지 않는다. */
  async frameCanvas(time: number): Promise<HTMLCanvasElement | null> {
    if (!this.pipeline || !this.meta) return null;
    return this.frameAt(time);
  }

  /**
   * 그 시각의 한 장을 따로 떠 둔다. 검출을 기다리는 동안 파이프라인이 다른
   * 시각을 그려도 우리가 보는 그림은 바뀌지 않게.
   */
  private async frameAt(time: number): Promise<HTMLCanvasElement | null> {
    if (!this.pipeline?.seekDraw) return null;
    const ctx = await this.pipeline.seekDraw(Math.max(0, time));
    const copy = document.createElement('canvas');
    copy.width = ctx.canvas.width;
    copy.height = ctx.canvas.height;
    copy.getContext('2d', { willReadFrequently: true })?.drawImage(ctx.canvas, 0, 0);
    return copy;
  }

  /**
   * 지금 프레임의 사람 후보 — 편집 2단계에서 영상 위에 띄우는 상자.
   *
   * 2026-09-24 부터 MediaPipe EfficientDet-Lite0 을 작업자에서 돌린다
   * (mediapipe-person-detector.ts). 상자는 폭 맞추기(person-box-fit.trimBoxWidth)를
   * 거친 뒤 내보낸다 — 화면에 보이는 상자가 곧 추적을 시작하는 상자다.
   *
   * 원본 영상을 서버에 보내지 않는다. 점수는 동일인이 아니다.
   * 검출기를 못 쓰면 `detectorAvailable:false` 로 알린다 — 빈 후보와 가른다.
   *
   * compareTo(2026-09-29) — 다시 고르는 장면에서 헷갈리는 후보의 순서를 조금 바꾸는 **보조 근거**.
   * 사용자가 고른 자리(compareTo.time·box)와 각 후보의 옷 색 분포(@hilit/vision appearance)를 견준 값을
   * appearance[id] 로 준다. 신원 확률이 아니며 화면에 숫자로 내지 않는다(lib/repick-candidates.ts).
   */
  async candidatesAt(time = 0, compareTo?: { time: number; box: NormalizedBBox } | null, options?: { picker?: boolean }): Promise<{
    people: PersonCandidate[]; frame: string; time: number; detectorAvailable: boolean;
    appearance?: Record<string, number | null>;
  }> {
    if (!this.pipeline || !this.meta) throw new Error('먼저 영상을 열어주세요.');
    const t = Math.max(0, Number(time) || 0);
    if (!personDetectorSupported()) return { time: t, frame: '', people: [], detectorAvailable: false };
    const canvas = await this.frameAt(t);
    if (!canvas) return { time: t, frame: '', people: [], detectorAvailable: false };
    let hits;
    try {
      hits = options?.picker ? await detectPickerPeople(canvas) : await detectPeople(canvas, { distinct: DISTINCT_PERSON_PROPOSALS });
    } catch {
      return { time: t, frame: '', people: [], detectorAvailable: false };
    }
    const { width, height } = canvas;
    const rgba = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, width, height).data;
    const fitted = hits.map((h) => ({ ...trimBoxWidth(rgba, width, height, h).box, score: h.score }));
    const people = fromDetectorHits(fitted, width, height);
    const appearance = compareTo && people.length ? await this.appearanceAgainst(canvas, people, compareTo) : undefined;
    return { time: t, frame: '', people, detectorAvailable: true, ...(appearance ? { appearance } : {}) };
  }

  /** 후보마다 고른 자리와의 옷 색 분포 겹침(0~1). 기준 프레임을 못 뜨면 undefined — 순서는 거리만으로 정한다. */
  private async appearanceAgainst(
    canvas: HTMLCanvasElement, people: readonly PersonCandidate[], ref: { time: number; box: NormalizedBBox },
  ): Promise<Record<string, number | null> | undefined> {
    try {
      const refCanvas = await this.frameAt(Math.max(0, ref.time));
      if (!refCanvas) return undefined;
      const anchor = describeCrop(refCanvas, ref.box);
      if (!anchor) return undefined;
      const out: Record<string, number | null> = {};
      for (const person of people) {
        const d = describeCrop(canvas, person.box);
        out[person.id] = d ? appearanceSimilarity(anchor, d) : null;
      }
      return out;
    } catch {
      return undefined;
    }
  }

  /**
   * 사용자가 누른 자리의 사람. 누른 곳 둘레를 확대해 다시 본다 — 화면 전체로는
   * 작아서 놓친 사람을 여기서 건진다(실사에서 놓친 47명 중 33명).
   *
   * 그래도 없으면 누른 곳에 세로로 긴 기본 상자를 놓고 `source:'fallback'` 으로
   * 알린다. 사용자가 모서리를 끌어 맞추는 출발점이다.
   */
  async personAt(time: number, point: { x: number; y: number }): Promise<{
    time: number; box: NormalizedBBox; score: number | null; source: 'detector' | 'fallback';
  }> {
    if (!this.pipeline || !this.meta) throw new Error('먼저 영상을 열어주세요.');
    const t = Math.max(0, Number(time) || 0);
    const canvas = personDetectorSupported() ? await this.frameAt(t) : null;
    const width = canvas?.width ?? this.meta.width;
    const height = canvas?.height ?? this.meta.height;
    const tap = { x: clamp01(point.x) * width, y: clamp01(point.y) * height };
    const norm = (b: { x: number; y: number; width: number; height: number }): NormalizedBBox => ({
      x: clamp01(b.x / width), y: clamp01(b.y / height),
      width: clamp01(b.width / width), height: clamp01(b.height / height),
    });
    if (canvas) {
      try {
        const hit = await detectPersonAt(canvas, tap);
        if (hit) {
          const rgba = canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, width, height).data;
          return { time: t, box: norm(trimBoxWidth(rgba, width, height, hit).box), score: hit.score, source: 'detector' };
        }
      } catch { /* 아래 기본 상자로 */ }
    }
    return { time: t, box: norm(tapFallbackBox(width, height, tap)), score: null, source: 'fallback' };
  }

  /**
   * 추적이 끝난 뒤 사람 확인에 쓸 프레임별 사람 상자.
   *
   * 숨은 분석용 영상에서 그 시각을 그려 검출기에 넘긴다 — 사용자가 보는 영상은
   * 움직이지 않는다. 검출기를 못 쓰는 기기면 전부 null 로 돌려준다. 모르는 것을
   * 사람이 없다고 치지 않는다.
   */
  async presenceSamples(
    times: readonly number[],
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<PresenceSample[]> {
    if (!this.pipeline || !this.meta) throw new Error('먼저 영상을 열어주세요.');
    if (!personDetectorSupported()) return times.map((time) => ({ time, people: null }));
    const out: PresenceSample[] = [];
    for (let i = 0; i < times.length; i += 1) {
      if (signal?.aborted) throw new DOMException('Presence check aborted', 'AbortError');
      const time = times[i];
      const canvas = await this.frameAt(time);
      if (!canvas) { out.push({ time, people: null }); continue; }
      try {
        const hits = await detectPeopleForCheck(canvas, PRESENCE_CHECK.scoreMin);
        const { width, height } = canvas;
        out.push({
          time,
          people: hits.map((h) => ({
            x: clamp01(h.x / width), y: clamp01(h.y / height),
            width: clamp01(h.width / width), height: clamp01(h.height / height), score: h.score,
          })),
        });
      } catch {
        out.push({ time, people: null });
      }
      onProgress?.(i + 1, times.length);
    }
    return out;
  }

  dispose() {
    this.disposed = true;
    this.contextEpoch += 1;
    this.contextAbort?.abort();
    this.pipeline?.dispose();
    this.pipeline = undefined;
    this.meta = undefined;
  }

  /** 별도 디코더로 어려운 구간을 관측한다. 반환값은 기존 궤적·내보내기·학습에 자동 적용하지 않는다. */
  async inspectTemporalContext(input: {
    eventTime: number; editStart: number; editEnd: number;
    referenceTime: number; referenceBox: NormalizedBBox;
    rejectedViews?: readonly { time: number; box: NormalizedBBox }[];
    signal?: AbortSignal;
    onProgress?: (done: number, max: number, direction: 'forward' | 'reverse') => void;
  }): Promise<TemporalContextResult> {
    if (!this.pipeline?.video?.currentSrc || !this.meta || this.disposed) throw new Error('먼저 영상을 열어주세요.');
    this.contextAbort?.abort();
    const abort = new AbortController(); this.contextAbort = abort;
    const generation = ++this.contextEpoch;
    const cancel = () => abort.abort();
    input.signal?.addEventListener('abort', cancel, { once: true });
    if (input.signal?.aborted) abort.abort();
    // 원본 복제 영상은 기기 안의 같은 Blob URL만 사용하며 네트워크로 전송하지 않는다.
    const decoder = new ContextFrameDecoder(this.pipeline.video.currentSrc, this.meta.width, this.meta.height);
    const setupStarted = Date.now();
    let setupReads = 1, setupDecoded = 0;
    const timeout = setTimeout(cancel, 60_000);
    try {
      const reference = await decoder.read(input.referenceTime, abort.signal);
      if (reference) setupDecoded += 1;
      const anchor = reference ? describeCrop(reference.canvas, input.referenceBox) : null;
      const others: Descriptor[] = [];
      for (const view of (input.rejectedViews ?? []).slice(0, 8)) {
        if (abort.signal.aborted) break;
        setupReads += 1;
        const frame = await decoder.read(view.time, abort.signal);
        if (frame) setupDecoded += 1;
        const d = frame ? describeCrop(frame.canvas, view.box) : null;
        if (d) others.push(d);
      }
      const patchCanvas = document.createElement('canvas');
      const scale = Math.min(1, 256 / Math.max(this.meta.width, this.meta.height));
      patchCanvas.width = Math.max(1, Math.round(this.meta.width * scale));
      patchCanvas.height = Math.max(1, Math.round(this.meta.height * scale));
      return await runTemporalContext({
        ...input, generation, readGeneration: () => this.contextEpoch, signal: abort.signal,
        setupCost: { reads: setupReads, decoded: setupDecoded, wallMs: Date.now() - setupStarted },
        readFrame: async (time) => {
          const decoded = await decoder.read(time, abort.signal);
          if (!decoded) return { requestedTime: time, decodedTime: null, detector: 'error', candidates: [], patchFeatures: null, patchCount: 0 };
          const canvas = decoded.canvas;
          let detector: 'ok' | 'unavailable' | 'error' = personDetectorSupported() ? 'ok' : 'unavailable';
          const hits = detector === 'ok' ? await detectPeopleForCheck(canvas, 0.2).catch(() => { detector = 'error'; return []; }) : [];
          const patchCtx = patchCanvas.getContext('2d', { willReadFrequently: true });
          patchCtx?.drawImage(canvas, 0, 0, patchCanvas.width, patchCanvas.height);
          const patches = patchCtx ? patchObservations(patchCtx.getImageData(0, 0, patchCanvas.width, patchCanvas.height).data, patchCanvas.width, patchCanvas.height) : null;
          return {
            requestedTime: time, decodedTime: decoded.decodedTime, detector,
            patchFeatures: patches?.features ?? null, patchCount: patches?.count ?? 0,
            candidates: hits.map((hit, index) => {
              const box = { x: hit.x / canvas.width, y: hit.y / canvas.height, width: hit.width / canvas.width, height: hit.height / canvas.height };
              const d = describeCrop(canvas, box);
              const appearance = d && anchor ? appearanceSimilarity(anchor, d) : null;
              const other = d && others.length ? Math.max(...others.map((o) => appearanceSimilarity(o, d))) : null;
              return { id: `context-${time.toFixed(6)}-${index}`, box, detectorScore: hit.score, appearance,
                knownOtherConflict: other != null && appearance != null && other >= appearance - 0.06 };
            }),
          };
        },
      });
    } finally {
      clearTimeout(timeout); input.signal?.removeEventListener('abort', cancel); decoder.dispose();
      if (this.contextAbort === abort) this.contextAbort = undefined;
    }
  }

  /**
   * 녹화 편집 실험. 제품 track() 은 부르지 않는다.
   * 쿼리 editSpanReentry=1 일 때만 편집기가 호출한다.
   */
  async searchEditSpan(input: {
    lostT: number;
    editEnd: number;
    lastCertainT: number;
    lastCertainBox: NormalizedBBox;
    generation: number;
    readGeneration: () => number;
    signal?: AbortSignal;
    anchorViews: ReadonlyArray<{ time: number; box: NormalizedBBox }>;
    onProgress?: (progress: { message: string; percent: number }) => void;
  }): Promise<EditSpanResult> {
    if (!this.pipeline || !this.meta) throw new Error('먼저 영상을 열어주세요.');
    const anchors: Descriptor[] = [];
    for (const view of input.anchorViews) {
      if (input.signal?.aborted) break;
      const canvas = await this.frameAt(view.time);
      const described = canvas ? describeCrop(canvas, view.box) : null;
      if (described) anchors.push(described);
    }
    const anchorSnapshot = Object.freeze(anchors.slice());
    let prevLuma: Uint8Array | null = null;
    const span = Math.max(0.001, input.editEnd - input.lostT);
    return runEditSpanSearch({
      lostT: input.lostT,
      editEnd: input.editEnd,
      lastCertainT: input.lastCertainT,
      lastCertainBox: input.lastCertainBox,
      frameWidth: 1,
      frameHeight: 1,
      generation: input.generation,
      readGeneration: input.readGeneration,
      signal: input.signal,
      anchors: anchorSnapshot,
      pullChunk: async (request) => {
        if (input.signal?.aborted) return 'cancelled';
        input.onProgress?.({
          message: `${bandProgressMessage(request.band)} 영상이 길면 시간이 더 걸릴 수 있습니다. 취소할 수 있습니다.`,
          percent: Math.max(0, Math.min(100, Math.round(((request.start - input.lostT) / span) * 100))),
        });
        const frames = [];
        let bytes = 0;
        for (const t of request.times) {
          if (input.signal?.aborted || input.readGeneration() !== input.generation) return 'cancelled';
          const canvas = await this.frameAt(t);
          if (!canvas) continue;
          const reported = this.pipeline?.video?.currentTime;
          const hits = personDetectorSupported()
            ? await detectPeopleForCheck(canvas, EDIT_SPAN_MEASUREMENT.detectorScoreMin).catch(() => [])
            : [];
          const luma = lumaGrid(canvas);
          const sceneCut = prevLuma != null && luma != null && lumaChanged(prevLuma, luma);
          if (luma) prevLuma = luma;
          bytes += 64;
          frames.push({
            requestedTSec: t,
            reportedTSec: Number.isFinite(reported) ? Number(reported) : t,
            sceneCut,
            cameraReset: sceneCut,
            candidates: hits.map((hit, index) => {
              const box = {
                x: hit.x / canvas.width,
                y: hit.y / canvas.height,
                width: hit.width / canvas.width,
                height: hit.height / canvas.height,
              };
              const described = describeCrop(canvas, box);
              let best: number | null = null;
              if (described) {
                for (const anchor of anchorSnapshot) {
                  const score = appearanceSimilarity(anchor, described);
                  if (best == null || score > best) best = score;
                }
              }
              return {
                id: `det-${t.toFixed(3)}-${index}`,
                box,
                detectorScore: hit.score,
                appearance: best,
                confirmedOtherSimilarity: null,
                knownOtherConflict: false,
                visibility: 'visible' as const,
              };
            }),
          });
        }
        return { frames, decodedFrames: frames.length, bytes };
      },
    });
  }
}

/** 정규화 상자 자리를 48×96 으로 잘라 외형 서술자를 만든다(pipeline 의 hilit-appearance 와 같은 크기). */
function describeCrop(canvas: HTMLCanvasElement, box: NormalizedBBox): Descriptor | null {
  const W = canvas.width;
  const H = canvas.height;
  const sx = Math.max(0, Math.floor(box.x * W));
  const sy = Math.max(0, Math.floor(box.y * H));
  const sw = Math.min(W - sx, Math.ceil(box.width * W));
  const sh = Math.min(H - sy, Math.ceil(box.height * H));
  if (sw < 4 || sh < 8) return null;
  const crop = document.createElement('canvas');
  crop.width = 48;
  crop.height = 96;
  const ctx = crop.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, 48, 96);
  const d = describeAppearance(ctx.getImageData(0, 0, 48, 96).data, 48, 96, undefined, true);
  return d.samples > 0 ? d : null;
}

function lumaGrid(canvas: HTMLCanvasElement): Uint8Array | null {
  const sample = document.createElement('canvas');
  sample.width = 8;
  sample.height = 8;
  const ctx = sample.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, 8, 8);
  const data = ctx.getImageData(0, 0, 8, 8).data;
  const out = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) out[i] = data[i * 4];
  return out;
}

function lumaChanged(prev: Uint8Array, next: Uint8Array): boolean {
  let sum = 0;
  for (let i = 0; i < prev.length; i += 1) sum += Math.abs(prev[i] - next[i]);
  return sum / prev.length / 255 > 0.35;
}

function abortError(): Error {
  const error = new Error('영상 열기를 취소했습니다.');
  error.name = 'AbortError';
  return error;
}
