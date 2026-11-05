/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·440933ce @license @preserve */
/** HILiT session-local multi-view descriptor matching. Original implementation.
 * No weights, training data, face recognition or anatomical/view inference.
 * Bands are crop regions, not detected body parts. Scores are not probabilities.
 */
export type AppearanceView = 'front' | 'side' | 'back' | 'unknown';
export interface PartVector {
  values: ArrayLike<number>;
  samples: number;
  trust?: number;
}
export interface ViewObservation {
  descriptor: PartVector;
  texture?: number[];
  visible: [boolean, boolean, boolean];
  quality: number;
  view: AppearanceView;
}
export interface ReentryCandidate extends ViewObservation {
  id: string;
  box: { x: number; y: number; width: number; height: number };
}
type Stored = Omit<ViewObservation, 'descriptor'> & { descriptor: PartVector; other: boolean };
/** 이전: maxMemory 9, 같은 view 2(최초+1). 2026-09-20: 확정 12, 같은 view 3. 최초 view 앵커는 유지. */
export const REENTRY_POLICY = Object.freeze({ accept: 0.82, margin: 0.12, minQuality: 0.6,
  frames: 3, minSpan: 0.20, maxGap: 0.5, maxMemory: 12, extraPerView: 3 });

function valid(o: ViewObservation): boolean {
  return Number.isFinite(o.quality) && o.quality >= REENTRY_POLICY.minQuality && o.quality <= 1
    && Number.isFinite(o.descriptor.samples) && o.descriptor.samples >= 60
    && Number.isFinite(o.descriptor.trust) && o.descriptor.trust! >= 0.2
    && o.descriptor.values.length >= 48
    && (o.texture === undefined || (o.texture.length === 24 && o.texture.every(v => Number.isFinite(v) && v >= 0)))
    && Array.from(o.descriptor.values).every(v => Number.isFinite(v) && v >= 0)
    && o.visible.length === 3 && o.visible.every(v => typeof v === 'boolean');
}
export function compareVisibleParts(a: ViewObservation, b: ViewObservation): number | null {
  if (!valid(a) || !valid(b)) return null;
  let count = 0, sum = 0;
  for (let part = 0; part < 3; part++) {
    if (!a.visible[part] || !b.visible[part]) continue;
    let sa = 0, sb = 0;
    for (let k = 0; k < 16; k++) { sa += a.descriptor.values[part*16+k]; sb += b.descriptor.values[part*16+k]; }
    if (sa <= 0 || sb <= 0) continue;
    let affinity = 0;
    for (let k = 0; k < 16; k++) affinity += Math.sqrt(a.descriptor.values[part*16+k]/sa * b.descriptor.values[part*16+k]/sb);
    let combined = Math.min(1, affinity);
    if (a.texture && b.texture) {
      const aa=a.texture.slice(part*8,part*8+8), bb=b.texture.slice(part*8,part*8+8);
      const ta=aa.reduce((s,v)=>s+v,0), tb=bb.reduce((s,v)=>s+v,0);
      if (ta>0 && tb>0) {
        const texture=aa.reduce((s,v,k)=>s+Math.sqrt(v/ta*bb[k]/tb),0);
        combined *= 0.8 + 0.2*Math.min(1,texture);
      }
    }
    sum += combined; count++;
  }
  return count >= 2 ? sum/count : null;
}

/** A new instance per track session prevents cross-video/subject identity leakage. */
export class MultiViewReid {
  private memory: Stored[] = [];
  private lastTime = -Infinity;
  private streak: { box: ReentryCandidate['box']; start: number; last: number; count: number } | null = null;

  /** Only explicit user confirmations may create appearance anchors. */
  remember(o: ViewObservation, userConfirmed: boolean, other = false): boolean {
    if (!userConfirmed || !valid(o)) return false;
    const entry: Stored = { ...o, texture:o.texture?.slice(), descriptor: { ...o.descriptor, values: Float32Array.from(o.descriptor.values) }, visible: [...o.visible], other };
    // Keep the first anchor for each view. Additional exemplars are bounded.
    const sameView = this.memory.filter(s => s.view === o.view && s.other === other);
    if (sameView.length >= REENTRY_POLICY.extraPerView) this.memory.splice(this.memory.indexOf(sameView[1]), 1);
    if (this.memory.length >= REENTRY_POLICY.maxMemory) return false;
    this.memory.push(entry); this.streak = null; return true;
  }
  clear(): void { this.memory = []; this.streak = null; this.lastTime = -Infinity; }
  get size(): number { return this.memory.length; }
  score(o: ViewObservation, other = false): number | null {
    const scores = this.memory.filter(s => s.other === other).map(s => compareVisibleParts(s,o)).filter((s): s is number => s !== null);
    return scores.length ? Math.max(...scores) : null;
  }
  observe(candidates: ReentryCandidate[], time: number) {
    const wait = (reason: string) => { this.streak = null; return { state: 'waiting' as const, reason, candidateId: null as string|null, score: null as number|null, identityConfirmed: false, eligibleForAutoReacquire: false }; };
    if (!Number.isFinite(time) || time <= this.lastTime) return wait('non-increasing-time');
    this.lastTime = time;
    // Unknown-quality competitors cannot safely be ignored in an identity decision.
    if (candidates.some(c => !valid(c) || ![c.box.x,c.box.y,c.box.width,c.box.height].every(Number.isFinite) || c.box.width <= 0 || c.box.height <= 0)) return wait('unmeasured-candidate');
    const ranked = candidates.map(c => ({ c, self:this.score(c), other:this.score(c,true) })).sort((a,b)=>(b.self??-1)-(a.self??-1));
    const best = ranked[0];
    if (!best || best.self === null || best.self < REENTRY_POLICY.accept) return wait('no-matching-observation');
    if (ranked.some(r=>r.self===null)) return wait('insufficient-visible-parts');
    if (ranked[1] && best.self - ranked[1].self! < REENTRY_POLICY.margin) return wait('similar-candidates');
    if (best.other !== null && best.self-best.other < REENTRY_POLICY.margin) return wait('known-other-conflict');
    const box = best.c.box, prev = this.streak;
    const distance = prev ? Math.hypot(box.x+box.width/2-prev.box.x-prev.box.width/2,box.y+box.height/2-prev.box.y-prev.box.height/2)/Math.max(1,Math.min(box.height,prev.box.height)) : Infinity;
    const sizeRatio = prev ? Math.max(box.height/prev.box.height,prev.box.height/box.height,box.width/prev.box.width,prev.box.width/box.width) : Infinity;
    const continuous = prev && time-prev.last <= REENTRY_POLICY.maxGap && distance <= 0.5 && sizeRatio <= 1.4;
    this.streak = continuous ? { box:{...box},start:prev.start,last:time,count:prev.count+1 } : { box:{...box},start:time,last:time,count:1 };
    const ready = this.streak.count >= REENTRY_POLICY.frames && time-this.streak.start >= REENTRY_POLICY.minSpan;
    return { state: ready ? 'candidate_ready' as const : 'verifying' as const, reason:ready?'consistent-appearance-candidate':'waiting-for-temporal-evidence', candidateId:best.c.id, score:best.self, identityConfirmed:false, eligibleForAutoReacquire:false };
  }
}
