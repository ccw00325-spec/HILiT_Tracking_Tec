/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·f5828f13 @license @preserve */
/** AI Hub 관절 특징 학습기와 같은 입력·연산입니다. 영상/스포츠 판별기 자체가 아닙니다. */
export const SCOUT_JOINT_ORDER = ['nose','leye','reye','lear','rear','lshoulder','rshoulder','lelbow','relbow','lwrist','rwrist','lhip','rhip','lknee','rknee','lankle','rankle','head','neck','hip','lbigtoe','rbigtoe','lsmalltoe','rsmalltoe','lheel','rheel','hand'] as const;
export type ScoutJoint = readonly [number,number,number] | null;
export type ScoutFrame = readonly ScoutJoint[];
export interface ScoutFeatureModel {
  schema: 'hilit-temporal-feature-mlp-v1'; labels: string[];
  mean: number[]; scale: number[]; w1: number[][]; b1: number[]; w2: number[][]; b2: number[];
}
const finite = (v: unknown): v is number => typeof v==='number' && Number.isFinite(v);
const vector = (v:unknown,n:number):v is number[] => Array.isArray(v)&&v.length===n&&v.every(finite);

export function validateScoutFeatureModel(input:unknown):ScoutFeatureModel {
  const m=input as ScoutFeatureModel;
  if(!m||m.schema!=='hilit-temporal-feature-mlp-v1'||!Array.isArray(m.labels)||m.labels.length<2||m.labels.length>1000
    ||!m.labels.every(l=>typeof l==='string'&&l.length>0&&l.length<=200)||new Set(m.labels).size!==m.labels.length
    ||!Array.isArray(m.b1)||m.b1.length<1||m.b1.length>256||!vector(m.b1,m.b1.length)
    ||!vector(m.mean,351)||!vector(m.scale,351)||m.scale.some(v=>v<=0)
    ||!Array.isArray(m.w1)||m.w1.length!==m.b1.length||!m.w1.every(r=>vector(r,351))
    ||!vector(m.b2,m.labels.length)||!Array.isArray(m.w2)||m.w2.length!==m.labels.length||!m.w2.every(r=>vector(r,m.b1.length)))
    throw new Error('Scout 학습 가중치의 구조·숫자가 올바르지 않습니다.');
  return m;
}

/** 고정된 27개 슬롯. 미관측 관절을 상자에서 만들어 넣지 않습니다. */
export function scoutSequenceFeatures(input:readonly ScoutFrame[]):number[] {
  if(!input.length)throw new Error('관절 시계열이 없습니다.');
  for(const f of input)if(f.length>27||f.some(j=>j!==null&&(!Array.isArray(j)||j.length!==3||!j.every(finite))))
    throw new Error('관절 이름 대응·좌표를 확인해 주세요.');
  const frames:ScoutJoint[][]=[];
  for(let k=0;k<24;k++) {
    const p=input.length===1?0:k*(input.length-1)/23, left=Math.floor(p), right=Math.min(left+1,input.length-1), w=p-left;
    const frame:ScoutJoint[]=[];
    for(let j=0;j<27;j++) {
      const a=input[left][j]??null,b=input[right][j]??null;
      frame.push(a&&b?[0,1,2].map(d=>a[d]*(1-w)+b[d]*w) as [number,number,number]:null);
    }
    frames.push(frame);
  }
  const normalized=frames.map(f=>{
    const present=f.filter((j):j is NonNullable<ScoutJoint>=>j!==null);
    const center=[0,1,2].map(d=>present.length?present.reduce((s,j)=>s+j[d],0)/present.length:0);
    const distances=present.map(j=>Math.hypot(...j.map((v,d)=>v-center[d]))).sort((a,b)=>a-b);
    let scale=distances.length?(distances[Math.floor((distances.length-1)/2)]+distances[Math.floor(distances.length/2)])/2:1;
    if(scale<1e-8)scale=1;
    return f.map(j=>j?j.map((v,d)=>(v-center[d])/scale):[0,0,0]);
  });
  const out:number[]=[];
  for(let j=0;j<27;j++)for(let d=0;d<3;d++)for(let c=0;c<4;c++) {
    out.push(normalized.reduce((s,f,t)=>s+f[j][d]*Math.cos(Math.PI*(t+.5)*c/24),0)/24);
  }
  for(let j=0;j<27;j++)out.push(frames.filter(f=>f[j]!==null).length/24);
  if(!out.every(finite))throw new Error('관절 특징 계산이 유효 범위를 벗어났습니다.');
  return out;
}

export function predictScoutFeatures(raw:unknown,features:readonly number[]) {
  const m=validateScoutFeatureModel(raw);
  if(!vector(features,351))throw new Error('351개 유한한 관절 특징이 필요합니다.');
  const x=features.map((v,i)=>(v-m.mean[i])/m.scale[i]);
  if(!x.every(finite))throw new Error('표준화 특징이 유효 범위를 벗어났습니다.');
  const h=m.w1.map((row,i)=>Math.tanh(row.reduce((s,w,j)=>s+w*x[j],m.b1[i])));
  const logits=m.w2.map((row,i)=>row.reduce((s,w,j)=>s+w*h[j],m.b2[i]));
  if(!logits.every(finite))throw new Error('모델 출력이 유효 범위를 벗어났습니다.');
  const exps=logits.map(v=>Math.exp(v-Math.max(...logits))), total=exps.reduce((a,b)=>a+b,0);
  const scores=exps.map(v=>v/total), top=scores.indexOf(Math.max(...scores));
  return {label:m.labels[top],scores:Object.fromEntries(m.labels.map((label,i)=>[label,scores[i]])),calibrated:false as const,
    sportInferred:false as const,boundariesInferred:false as const};
}
