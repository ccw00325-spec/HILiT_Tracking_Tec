/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·fcb42685 @license @preserve */
import type {ScoutFrame,ScoutJoint} from './scout-feature-mlp';

/** AI Hub 2D 학습과 동일한 12개 관절만 사용합니다. 코를 머리/목으로 대체하지 않습니다. */
export const SCOUT_POSE_MAP = [[5,11],[6,12],[7,13],[8,14],[9,15],[10,16],[11,23],[12,24],[13,25],[14,26],[15,27],[16,28]] as const;
export interface ScoutPosePoint {x:number;y:number;visibility?:number;}
export interface ScoutPoseCrop {x:number;y:number;width:number;height:number;}
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v);
export function scoutPoseCrop(box:ScoutPoseCrop,width:number,height:number,paddingFactor=1):ScoutPoseCrop|null {
  if(![width,height,box.x,box.y,box.width,box.height,paddingFactor].every(finite)||width<=0||height<=0||box.width<=0||box.height<=0||paddingFactor<1||paddingFactor>2)return null;
  const x=Math.max(0,Math.floor((box.x-box.width*.18*paddingFactor)*width)),y=Math.max(0,Math.floor((box.y-box.height*.08*paddingFactor)*height));
  const right=Math.min(width,Math.ceil((box.x+box.width*(1+.18*paddingFactor))*width)),bottom=Math.min(height,Math.ceil((box.y+box.height*(1+.08*paddingFactor))*height));
  return right-x>=16&&bottom-y>=32?{x,y,width:right-x,height:bottom-y}:null;
}
export type ScoutPoseFailure='invalid-input'|'no-pose'|'incomplete-torso'|'insufficient-joints'|'outside-target'|'ambiguous-target';
export interface ScoutPoseObservation {frame:ScoutFrame|null;reason:ScoutPoseFailure|null;candidateCount:number;observedJoints:number;}
export function scoutPoseObservation(poses:readonly (readonly ScoutPosePoint[])[],crop:ScoutPoseCrop,target:ScoutPoseCrop,sourceWidth:number,sourceHeight:number):ScoutPoseObservation {
  const held=(reason:ScoutPoseFailure):ScoutPoseObservation=>({frame:null,reason,candidateCount:poses.length,observedJoints:0});
  if(![crop.x,crop.y,crop.width,crop.height,sourceWidth,sourceHeight,target.x,target.y,target.width,target.height].every(finite)
    ||sourceWidth<=0||sourceHeight<=0||crop.width<=0||crop.height<=0||crop.x<0||crop.y<0||crop.x+crop.width>sourceWidth||crop.y+crop.height>sourceHeight||target.width<=0||target.height<=0)return held('invalid-input');
  if(!poses.length)return held('no-pose');
  if(poses.length>20)return held('ambiguous-target');
  const matches:ScoutFrame[]=[];let uncertain=0,lastFailure:ScoutPoseFailure='outside-target';
  for(const pose of poses){
  if(pose.length<29){uncertain++;lastFailure='incomplete-torso';continue;}
  const frame:ScoutJoint[]=Array(27).fill(null);
  for(const [slot,index] of SCOUT_POSE_MAP){const p=pose[index],visibility=p?.visibility;
    if(!p||!finite(p.x)||!finite(p.y)||!finite(visibility)||visibility<.5||p.x<0||p.x>1||p.y<0||p.y>1)continue;
    frame[slot]=[crop.x+p.x*crop.width,crop.y+p.y*crop.height,0];
  }
  // 몸통 위치로 해당 상자에 들어온 후보만 검사합니다. 신원을 보증하는 기능이 아닙니다.
  const torso=[5,6,11,12].map(i=>frame[i]);
  if(torso.some(p=>p===null)){uncertain++;lastFailure='incomplete-torso';continue;}
  const cx=torso.reduce((s,p)=>s+p![0],0)/4/sourceWidth,cy=torso.reduce((s,p)=>s+p![1],0)/4/sourceHeight;
  if(cx<target.x||cx>target.x+target.width||cy<target.y||cy>target.y+target.height){
    if(torso.some(p=>p![0]/sourceWidth>=target.x&&p![0]/sourceWidth<=target.x+target.width&&p![1]/sourceHeight>=target.y&&p![1]/sourceHeight<=target.y+target.height))uncertain++;
    continue;
  }
  if(frame.filter(Boolean).length<8){uncertain++;lastFailure='insufficient-joints';continue;}
  matches.push(frame);
  }
  // 다른 후보를 배제할 수 없거나 대상 안에 두 몸통이 있으면 고르지 않습니다.
  if(matches.length>1||(poses.length>1&&uncertain>0))return held('ambiguous-target');
  return matches.length===1?{frame:matches[0],reason:null,candidateCount:poses.length,observedJoints:matches[0].filter(Boolean).length}:held(lastFailure);
}
export function scoutPoseFrame(poses:readonly (readonly ScoutPosePoint[])[],crop:ScoutPoseCrop,target:ScoutPoseCrop,sourceWidth:number,sourceHeight:number):ScoutFrame|null {
  return scoutPoseObservation(poses,crop,target,sourceWidth,sourceHeight).frame;
}
