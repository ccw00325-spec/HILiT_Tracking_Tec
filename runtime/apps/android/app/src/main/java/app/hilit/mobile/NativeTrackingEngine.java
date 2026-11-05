/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·cab1df8c @license @preserve */
package app.hilit.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.RectF;
import android.media.MediaMetadataRetriever;
import android.net.Uri;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;


/** Android adapter over HilitMotionTracker(자체 위치) + HILIT Appearance(자체)
 * + AffineGmc + SportsTrack(Tracklet·Jersey·Team·Court·EventForMe·신원 문).
 *
 * 🔴 **ONNX 모델을 하나도 쓰지 않는다** (2026-09-16). NanoTrack 은 9/15 에,
 * NanoDet 은 9/16 에 가중치까지 지웠다. 그래서 놓친 대상을 자동으로 다시
 * 잡지 못한다 — 놓치면 TARGET_LOST 로 올리고 사용자에게 다시 지정해 달라고
 * 한다. `Result.reacquireTried`·`reacquireOk` 는 늘 0 이다.
 * 자동 재획득 기본값은 SportsTrack.AUTO_REACQUIRE_DEFAULT = off.
 * Re-ID 간격은 NativeReidScheduler(웹과 같은 1.67s/0.42s·쿨다운 0.12s).
 * 외형 숫자는 NativeAppearanceCheckpoint 가 getFilesDir() 에만 둔다. crop 없음. */
final class NativeTrackingEngine implements AutoCloseable {
    static final int HEALTH_WINDOW_SIZE = 20, N_LEVEL = 2;
    static final float REID_THRESHOLD = .60f, CRITICAL_REID = .35f;
    interface Progress { void onProgress(int percent, String state, float fps); }
    static final class Box { float x,y,w,h; Box(float x,float y,float w,float h){this.x=x;this.y=y;this.w=w;this.h=h;} Box copy(){return new Box(x,y,w,h);} float cx(){return x+w/2;} float cy(){return y+h/2;} float area(){return Math.max(0,w)*Math.max(0,h);} }
    static final class Point { final double timestamp; final Box box; final float health,reid,confidence; final String state; final String identityLifecycle; Point(double t,Box b,float h,float r,float c,String s){this(t,b,h,r,c,s,null);} Point(double t,Box b,float h,float r,float c,String s,String life){timestamp=t;box=b;health=h;reid=r;confidence=c;state=s;identityLifecycle=life==null?SportsTrack.classifyLifecycle(!"TARGET_LOST".equals(s)&&!"OCCLUDED".equals(s),false,false,0f,true):life;} }
    static final class Result { final List<Point> points=new ArrayList<>(); int reidCalls,detectorCalls,reacquireTried,reacquireOk,userReviews,expensiveExtracts,hashDedup,galleryAccepted,galleryRejected,jaccardCalls,detectorFull,detectorSliced,detectorRegion,reacquireGateSpans,reacquireGateTentativeFrames,reacquireGateAsked; double elapsed; int width,height; String orientation; /** 연구실 판정기 비교 기록(ProductionProfile.audit). 상태에는 쓰지 않는다. */ int[] profileAudit;
        /** 카메라(미리보기·저장본)가 따라갈 경로. 사람 검출로 다듬었으면 그것(FollowRefine), 아니면 points. 추적 결과(points)는 그대로 둔다. */
        List<Point> cameraPoints;
        List<Point> camera(){return cameraPoints!=null&&cameraPoints.size()==points.size()?cameraPoints:points;} }

    /* 🔴 ONNX 세션이 없다 — 2026-09-16
     *
     * 여기 `OrtEnvironment env`, `OrtSession.SessionOptions options`,
     * `NanoDet nanoDet`, 그리고 assets 에서 모델을 읽어 세션을 만드는
     * `session()` 이 있었다. NanoDet 을 가중치까지 지우면서 함께 없앴다
     * (패치노트 0.56).
     *
     * 세션 만드는 코드를 남겨 두지 않는다. 남겨 두면 assets 에 파일 하나만
     * 되돌려 놓아도 모델이 조용히 되살아난다. 지금 이 엔진이 쓰는 것은
     * 전부 가중치 없는 자체 구현이다 — HilitMotionTracker, HilitAppearance. */
    private final Context context;
    private HilitMotionTracker motionTracker;
    NativeTrackingEngine(Context context) { this.context=context.getApplicationContext(); motionTracker=new HilitMotionTracker(); }

    Result track(Uri uri, float nx,float ny,float nw,float nh, Progress progress) throws Exception {
        long started=System.nanoTime(); MediaMetadataRetriever retriever=new MediaMetadataRetriever(); retriever.setDataSource(context,uri);
        int sourceW=Integer.parseInt(value(retriever,MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH,"1")); int sourceH=Integer.parseInt(value(retriever,MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT,"1"));
        int rotation=Integer.parseInt(value(retriever,MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION,"0")); if(rotation==90||rotation==270){int swap=sourceW;sourceW=sourceH;sourceH=swap;}
        long durationMs=Long.parseLong(value(retriever,MediaMetadataRetriever.METADATA_KEY_DURATION,"0")); float scale=Math.min(1f,720f/Math.max(1,Math.min(sourceW,sourceH))); int width=even(sourceW*scale),height=even(sourceH*scale); float analysisFps=20f; int total=Math.max(1,(int)Math.floor(durationMs/1000f*analysisFps));
        Bitmap first=frame(retriever,0,width,height); Box current=new Box(nx*width,ny*height,nw*width,nh*height); motionTracker.init(first,current); float[] trustedAnchor=HilitAppearance.describe(first,current); if(trustedAnchor==null)throw new IllegalArgumentException("선택 영역에서 사람 특징을 읽을 수 없습니다.");
        HilitMotionTracker.Gray prevGray=HilitMotionTracker.toGray(first); int[] prevGmc=AffineGmc.fromFloatGray(prevGray.data);
        SportsTrack.TrackletGraph tracklets=new SportsTrack.TrackletGraph(); SportsTrack.JerseyLock jerseyLock=new SportsTrack.JerseyLock(); boolean jerseyLockedOnce=false;
        int[] seedArgb=argbCrop(first,current); SportsTrack.TeamVector teamSelf=seedArgb==null?null:SportsTrack.describeTeam(seedArgb,cropW(first,current),cropH(first,current));
        SportsTrack.CourtPoint lastFoot=null; double lastOkT=0;
        Result out=new Result();out.width=sourceW;out.height=sourceH;out.orientation=sourceW>=sourceH?"landscape":"portrait";out.points.add(point(0,current,1,1,1,"TRACKING_OK",width,height));
        /* 추적 영역 예측 — 웹과 같은 규칙으로 다음 자리를 낸다.
         *
         * 예전에는 프레임 사이 차이(vx,vy)만 들고 있었다. 급정지·방향 전환에서
         * 그대로 지나쳐 가고, 가림 동안 버틸 근거도 없었다. 웹에서 쓰는 예측기를
         * 그대로 옮겨 두 화면이 같은 판단을 하게 한다. */
        HilitTrackRegionPrediction predictor=new HilitTrackRegionPrediction();
        predictor.start(new HilitTrackRegionPrediction.Rect(current.x,current.y,current.w,current.h),0);
        HilitTrackRegionPrediction.Prediction prediction=null;
        NativeReidScheduler reidSched=new NativeReidScheduler();
        NativeAppearanceCheckpoint appearanceCheckpoint=new NativeAppearanceCheckpoint(context.getFilesDir());
        float[] restored=appearanceCheckpoint.load(uri.toString());
        if(restored!=null) trustedAnchor=restored;
        HealthWindow healthWindow=new HealthWindow(HEALTH_WINDOW_SIZE); Box previous=current.copy(); float previousReid=1,vx=0,vy=0; String state="TRACKING_OK"; Box pending=null;int pendingCount=0; long lastTick=System.nanoTime();
        for(int i=1;i<total;i++){
            if(Thread.currentThread().isInterrupted())throw new InterruptedException("Tracking cancelled"); double t=i/analysisFps; Bitmap bitmap=frame(retriever,(long)(t*1_000_000),width,height);
            HilitMotionTracker.Gray nextGray=HilitMotionTracker.toGray(bitmap); int[] nextGmc=AffineGmc.fromFloatGray(nextGray.data);
            AffineGmc.Result gmc=AffineGmc.estimate(prevGmc,nextGmc,width,height,new AffineGmc.Box[]{new AffineGmc.Box(previous.x,previous.y,previous.w,previous.h)});
            Box compensatedPrev=previous;
            /* 잔차가 작다는 것만으로 아핀을 쓰지 않는다. 틀린 대응들도 서로 일관된
               움직임을 만들고, 그때 잘못된 아핀은 상자를 옆 사람 자리로 민다.
               근거가 모자라면 보정 없이 간다(웹과 같은 규칙). */
            if(gmc.usable&&AffineGmc.evidenceOk(gmc)){AffineGmc.Box moved=AffineGmc.applyToBox(new AffineGmc.Box(previous.x,previous.y,previous.w,previous.h),gmc.affine);compensatedPrev=new Box(moved.x,moved.y,moved.width,moved.height);}
            HilitMotionTracker.Update update=motionTracker.update(nextGray, t); current=update.box; if("not_initialized".equals(update.reason) || (current.w<=2 && current.h<=2)){current=previous.copy();} float motion=motionContinuity(compensatedPrev,current,width,height); float boxStability=boxStability(previous,current); float visibility=visibility(current,width,height); boolean risky=update.confidence<.45f||motion<.45f||boxStability<.35f||"TRACKING_WARNING".equals(state); float reid=previousReid;
            NativeReidScheduler.Signals sig=new NativeReidScheduler.Signals();
            sig.videoTSec=t; sig.cropValid=Math.min(current.w,current.h)>=NativeReidScheduler.MIN_CROP_PX; sig.visibleRatio=visibility;
            sig.occluded="OCCLUDED".equals(state)||"TARGET_LOST".equals(state); sig.rivalNearby=risky; sig.rankCompetition=risky;
            sig.appearanceWeak=previousReid<REID_THRESHOLD; sig.trackLostSuspect=risky;
            NativeReidScheduler.Decision dec=reidSched.decide(sig);
            if(dec.extract){float[] e=HilitAppearance.describe(bitmap,current);reid=e==null?0:HilitAppearance.similarity(trustedAnchor,e);out.reidCalls++;out.expensiveExtracts++;previousReid=reid;}
            SportsTrack.JerseyDecision jersey=null; SportsTrack.TeamDecision team=null; Boolean courtFar=null;
            int[] crop=argbCrop(bitmap,current);
            if(!jerseyLockedOnce){if(crop!=null)jerseyLock.remember(SportsTrack.readJerseyNumber(crop,cropW(bitmap,current),cropH(bitmap,current)),true);jerseyLockedOnce=true;}
            if(crop!=null){SportsTrack.JerseyRead read=SportsTrack.readJerseyNumber(crop,cropW(bitmap,current),cropH(bitmap,current));jersey=jerseyLock.decide(read);if(teamSelf!=null)team=SportsTrack.decideTeamCue(teamSelf,SportsTrack.describeTeam(crop,cropW(bitmap,current),cropH(bitmap,current)));}
            if(i%5==0){SportsTrack.CourtHintResult court=courtHint(bitmap,current);if(court.usable&&court.foot!=null){if(lastFoot!=null){Float dist=SportsTrack.courtFootDistance(lastFoot,court.foot,height);courtFar=dist!=null&&dist>0.35f;}lastFoot=court.foot;}}
            SportsTrack.SwitchDecision tracklet=tracklets.decideSwitch(new SportsTrack.Box(current.x,current.y,current.w,current.h));
            SportsTrack.SportsGateResult gated=SportsTrack.gateSportsIdentity(SportsTrack.appearanceFromReid(reid,REID_THRESHOLD,CRITICAL_REID),tracklet,jersey,team,courtFar,t-lastOkT);
            if("reject-switch".equals(gated.action)){current=previous.copy();motionTracker.reposition(previous);update=new HilitMotionTracker.Update(current,Math.min(update.confidence,.2f),update.status,false,update.pointsUsed,update.pointsKept,update.fbError,update.scaleEvidence,"sports_identity_block",t,update.referenceTimestamp);}
            else if("hold".equals(gated.action)&&"TRACKING_OK".equals(state))state="TRACKING_WARNING";
            float occlusionSignal=("OCCLUDED".equals(state)||"TARGET_LOST".equals(state))?0:1,ambiguitySignal=pendingCount>0?.5f:1;float health=clamp((.40f*reid+.25f*update.confidence+.15f*motion+.10f*boxStability+.10f*visibility+.12f*occlusionSignal+.08f*ambiguitySignal)/1.20f); boolean motionHolding=update.observed&&!"lost".equals(update.status)&&current.w>8&&current.h>8; boolean bad=health<.55f||reid<REID_THRESHOLD||(!motionHolding&&update.confidence<.22f)||"reject-switch".equals(gated.action); float lostRatio=healthWindow.add(bad); boolean critical=reid<CRITICAL_REID||(!motionHolding&&update.confidence<.10f)||motion<.1f||current.area()<width*height*.0005f;
            /* 🔴 놓쳤을 때 자동으로 다시 잡지 않는다 — 2026-09-16
             *
             * 여기서 NanoDet 을 돌려 후보를 뽑고, rank() 로 하나를 골라
             * 추적을 이어 붙였다. 검출기를 지웠으니 후보가 0개다.
             *
             * 후보 없이 추적기 혼자 다시 찾게 두면 "비슷한 무늬" 를 잡으므로
             * 옆 사람으로 이어 붙는다. 그래서 잇지 않고 사용자에게 넘긴다.
             * 웹 파이프라인의 Lv2 와 같은 판단이다. */
            /* 관측을 예측기에 넣는다. 못 봤으면 null 을 넣어 예측만 돌린다. */
            boolean occludedNow=!motionHolding;
            prediction=predictor.observe(t,
                motionHolding?new HilitTrackRegionPrediction.Rect(current.x,current.y,current.w,current.h):null,
                update.confidence, occludedNow?HilitTrackRegionPrediction.OCC_OCCLUDED:HilitTrackRegionPrediction.OCC_VISIBLE,
                width, height, null, 1.0/analysisFps);
            /* 짧은 가림은 예측으로 메운다. 예측기가 손을 들면(mayFillGap=false)
             * 메우지 않는다 — 오래 못 본 자리를 계속 짐작하면 그 짐작이 해롭다. */
            if(occludedNow && prediction.mayFillGap && prediction.box!=null){
                current=new Box((float)prediction.box.x,(float)prediction.box.y,(float)prediction.box.w,(float)prediction.box.h);
                motionTracker.reposition(current);
            }
            if(critical || lostRatio>=lostThreshold(N_LEVEL)){ pending=null;pendingCount=0; if(!"TARGET_LOST".equals(state)) out.userReviews++; state="TARGET_LOST"; }
            else if(prediction!=null && !prediction.usable && !motionHolding){
                /* 예측으로 버틸 수 있는 한계를 넘었다. 계속 짐작하지 않고 넘긴다. */
                if(!"TARGET_LOST".equals(state)) out.userReviews++;
                state="TARGET_LOST";
            }
            else if(health<.68f||lostRatio>=.3f||"hold".equals(gated.action))state="TRACKING_WARNING";else state="TRACKING_OK";
            if("TRACKING_OK".equals(state))lastOkT=t;
            boolean atEdge=visibility<.18f; boolean headingOut=vx*(current.cx()-width/2f)>0 && atEdge;
            String life=SportsTrack.classifyLifecycle(motionHolding && "TRACKING_OK".equals(state), headingOut, atEdge, 0f, visibility>0.05f);
            if("TARGET_LOST".equals(state) && "TRACKING".equals(life)) life="LOST_UNCERTAIN";
            out.points.add(point(t,current,health,reid,update.confidence,state,width,height,life));vx=current.x-previous.x;vy=current.y-previous.y;previous=current.copy();prevGmc=nextGmc;bitmap.recycle();
            if(i%5==0||i==total-1){long now=System.nanoTime();float fps=(float)(i/((now-started)/1e9));progress.onProgress(Math.round(i*100f/total),state,fps);lastTick=now;}
        }
        applyOffline(out);first.recycle();retriever.release();
        appearanceCheckpoint.save(uri.toString(), trustedAnchor);
        out.galleryAccepted=appearanceCheckpoint.lastAccepted();
        out.galleryRejected=appearanceCheckpoint.lastRejected();
        out.elapsed=(System.nanoTime()-started)/1e9;return out;
    }

    /** 합성 Bitmap 시간 측정. 스포츠 수율·S24 실측이 아니다. */
    Result trackBitmaps(Bitmap[] frames, float fps, Box start, Progress progress) throws Exception {
        long started=System.nanoTime();
        if(frames==null||frames.length<2) throw new IllegalArgumentException("need >=2 frames");
        int width=frames[0].getWidth(), height=frames[0].getHeight();
        Box current=start.copy();
        motionTracker=new HilitMotionTracker();
        motionTracker.init(frames[0], current);
        float[] trustedAnchor=HilitAppearance.describe(frames[0], current);
        NativeReidScheduler reidSched=new NativeReidScheduler();
        NativeAppearanceCheckpoint appearanceCheckpoint=new NativeAppearanceCheckpoint(context.getFilesDir());
        Result out=new Result();
        out.width=width; out.height=height; out.orientation=width>=height?"landscape":"portrait";
        out.points.add(point(0,current,1,1,1,"TRACKING_OK",width,height));
        Box previous=current.copy(); float previousReid=1; String state="TRACKING_OK";
        for(int i=1;i<frames.length;i++){
            if(Thread.currentThread().isInterrupted()) throw new InterruptedException("Tracking cancelled");
            double t=i/Math.max(1e-6,fps);
            Bitmap bitmap=frames[i];
            HilitMotionTracker.Gray nextGray=HilitMotionTracker.toGray(bitmap);
            HilitMotionTracker.Update update=motionTracker.update(nextGray, t);
            current=update.box;
            if("not_initialized".equals(update.reason)||(current.w<=2&&current.h<=2)) current=previous.copy();
            float visibility=visibility(current,width,height);
            boolean risky=update.confidence<.45f||"TRACKING_WARNING".equals(state);
            NativeReidScheduler.Signals sig=new NativeReidScheduler.Signals();
            sig.videoTSec=t; sig.cropValid=Math.min(current.w,current.h)>=NativeReidScheduler.MIN_CROP_PX;
            sig.visibleRatio=visibility; sig.rivalNearby=risky; sig.rankCompetition=risky;
            sig.appearanceWeak=previousReid<REID_THRESHOLD; sig.trackLostSuspect=risky;
            NativeReidScheduler.Decision dec=reidSched.decide(sig);
            float reid=previousReid;
            if(dec.extract){
                float[] e=HilitAppearance.describe(bitmap,current);
                reid=e==null?0:HilitAppearance.similarity(trustedAnchor,e);
                out.reidCalls++; out.expensiveExtracts++; previousReid=reid;
            }
            if(update.confidence<.22f) state="TRACKING_WARNING"; else state="TRACKING_OK";
            out.points.add(point(t,current,update.confidence,reid,update.confidence,state,width,height));
            previous=current.copy();
            if(progress!=null && (i%5==0||i==frames.length-1)){
                float inst=(float)(i/Math.max(1e-6,(System.nanoTime()-started)/1e9));
                progress.onProgress(Math.round(i*100f/frames.length),state,inst);
            }
        }
        appearanceCheckpoint.save("bitmap-bench", trustedAnchor);
        out.galleryAccepted=appearanceCheckpoint.lastAccepted();
        out.galleryRejected=appearanceCheckpoint.lastRejected();
        out.elapsed=(System.nanoTime()-started)/1e9;
        return out;
    }

    /* 후보를 줄 세우던 `rank()` 와 `Candidate` 도 지웠다. 줄 세울 후보를
     * 만들어 주던 것이 검출기였다. */
    private static Point point(double t,Box p,float health,float reid,float conf,String state,int width,int height){return point(t,p,health,reid,conf,state,width,height,null);}
    private static Point point(double t,Box p,float health,float reid,float conf,String state,int width,int height,String life){return new Point(t,new Box(clamp(p.x/width),clamp(p.y/height),clamp(p.w/width),clamp(p.h/height)),health,reid,conf,state,life);}
    private static String value(MediaMetadataRetriever r,int key,String fallback){String v=r.extractMetadata(key);return v==null?fallback:v;}
    private static Bitmap frame(MediaMetadataRetriever r,long us,int width,int height){Bitmap raw=r.getFrameAtTime(us,MediaMetadataRetriever.OPTION_CLOSEST);if(raw==null)throw new IllegalStateException("영상 프레임을 디코딩하지 못했습니다.");Bitmap scaled=Bitmap.createScaledBitmap(raw,width,height,true);if(scaled!=raw)raw.recycle();if(scaled.getConfig()==Bitmap.Config.ARGB_8888)return scaled;Bitmap copy=scaled.copy(Bitmap.Config.ARGB_8888,false);scaled.recycle();return copy;}
    private static int even(float v){return Math.max(2,Math.round(v/2)*2);} private static float clamp(float v){return Math.max(0,Math.min(1,v));}
    private static int cropX(Bitmap bm,Box b){return Math.max(0,(int)Math.floor(b.x));}
    private static int cropY(Bitmap bm,Box b){return Math.max(0,(int)Math.floor(b.y));}
    private static int cropW(Bitmap bm,Box b){return Math.max(1,Math.min(bm.getWidth()-cropX(bm,b),(int)Math.floor(Math.max(8,b.w))));}
    private static int cropH(Bitmap bm,Box b){return Math.max(1,Math.min(bm.getHeight()-cropY(bm,b),(int)Math.floor(Math.max(12,b.h))));}
    private static int[] argbCrop(Bitmap bm,Box b){
        int x=cropX(bm,b),y=cropY(bm,b),w=cropW(bm,b),h=cropH(bm,b);
        if(w<8||h<12)return null;
        int[] px=new int[w*h]; bm.getPixels(px,0,w,x,y,w,h); return px;
    }
    private static SportsTrack.CourtHintResult courtHint(Bitmap bm,Box subject){
        int w=160,h=96; Bitmap small=Bitmap.createScaledBitmap(bm,w,h,true);
        int[] px=new int[w*h]; small.getPixels(px,0,w,0,0,w,h); if(small!=bm)small.recycle();
        SportsTrack.Box sub=new SportsTrack.Box(subject.x*w/(float)bm.getWidth(),subject.y*h/(float)bm.getHeight(),subject.w*w/(float)bm.getWidth(),subject.h*h/(float)bm.getHeight());
        return SportsTrack.estimateCourtHint(px,w,h,sub);
    }
    private static void applyOffline(Result out){
        List<SportsTrack.OfflineBox> forward=new ArrayList<>();
        for(Point p:out.points){
            boolean observed=!"TARGET_LOST".equals(p.state)&&p.box.w>0.002f;
            forward.add(new SportsTrack.OfflineBox(p.timestamp,p.box.x,p.box.y,p.box.w,p.box.h,observed));
        }
        List<SportsTrack.OfflinePoint> refined=SportsTrack.refineOfflineTrajectory(forward,SportsTrack.inferBackwardFromForward(forward));
        for(int i=0;i<out.points.size()&&i<refined.size();i++){
            SportsTrack.OfflinePoint row=refined.get(i);
            Point p=out.points.get(i);
            if("lost".equals(row.state)){
                out.points.set(i,new Point(p.timestamp,p.box,Math.min(p.health,.32f),p.reid,Math.min(p.confidence,.30f),"TARGET_LOST"));
            }else if("occluded".equals(row.state)&&"TRACKING_OK".equals(p.state)){
                out.points.set(i,new Point(p.timestamp,new Box(row.box.x,row.box.y,row.box.width,row.box.height),p.health,p.reid,p.confidence,"OCCLUDED"));
            }else if("warning".equals(row.state)&&"TRACKING_OK".equals(p.state)){
                out.points.set(i,new Point(p.timestamp,p.box,p.health,p.reid,p.confidence,"TRACKING_WARNING"));
            }
        }
        applyReacquireGate(out);
    }
    /* 끊겼다 다시 붙은 구간을 곧바로 확정하지 않는다.
     *
     * 웹(web-tracking-engine.ts)과 같은 자리, 같은 규칙이다. 최소 관측 수와 최소
     * 확인 시간을 채울 때까지 잠정으로 두고 신뢰도를 낮춘다. 따라가는 것은 멈추지
     * 않는다. 자동으로 "같은 사람이다" 라고 올리지도 않는다.
     *
     * 경쟁자 수는 앱에 검출기가 없어 셀 수 없다. TRACKING_WARNING 을 대리값으로
     * 쓴다(HilitReacquireGate 주석 참조). */
    private static void applyReacquireGate(Result out){
        if(!HilitReacquireGate.REACQUIRE_TRAJECTORY_GATE_ENABLED) return;
        List<HilitReacquireGate.Input> in=new ArrayList<>();
        for(Point p:out.points){
            boolean observed=!"TARGET_LOST".equals(p.state)&&!"OCCLUDED".equals(p.state)&&p.box.w>0.002f&&p.box.h>0.002f;
            int competing="TRACKING_WARNING".equals(p.state)?1:0;
            in.add(new HilitReacquireGate.Input(p.timestamp,observed,competing));
        }
        HilitReacquireGate.Result gate=HilitReacquireGate.gateReacquisitions(in);
        for(HilitReacquireGate.Mark mark:gate.marks){
            if(mark.index<0||mark.index>=out.points.size()) continue;
            Point p=out.points.get(mark.index);
            float cap=HilitReacquireGate.TENTATIVE_CONFIDENCE_CAP;
            String state=("TRACKING_OK".equals(p.state)&&mark.hardScene)?"TRACKING_WARNING":p.state;
            out.points.set(mark.index,new Point(p.timestamp,p.box,Math.min(p.health,cap),p.reid,
                    Math.min(p.confidence,cap),state,mark.lifecycle));
        }
        out.reacquireGateSpans=gate.reacquisitions;
        out.reacquireGateTentativeFrames=gate.marks.size();
        out.reacquireGateAsked=gate.askedCount;
    }
    /* cosine(내적) 은 OSNet 임베딩용이었다. 자체 서술자는 히스토그램
     * 교집합으로 비교하므로(HilitAppearance.similarity) 더 이상 쓰지 않는다. */
    private static float motionContinuity(Box a,Box b,int w,int h){return clamp(1-(float)Math.hypot((b.cx()-a.cx())/w,(b.cy()-a.cy())/h)/.12f);}
    private static float boxStability(Box a,Box b){float ratio=b.area()/Math.max(1,a.area());return clamp(1-Math.abs((float)Math.log(Math.max(.01f,ratio)))/1.4f);}
    private static float visibility(Box b,int w,int h){float x1=Math.max(0,b.x),y1=Math.max(0,b.y),x2=Math.min(w,b.x+b.w),y2=Math.min(h,b.y+b.h);return clamp(Math.max(0,x2-x1)*Math.max(0,y2-y1)/Math.max(1,b.area()));}
    private static float lostThreshold(int nLevel){return nLevel==4?.75f:nLevel==3?.667f:.50f;}

    private static final class HealthWindow { final int size; final ArrayDeque<Boolean> window=new ArrayDeque<>();int bad;HealthWindow(int s){size=s;}float add(boolean value){window.add(value);if(value)bad++;if(window.size()>size&&window.remove())bad--;return bad/(float)Math.max(1,window.size());} }

    /* HILIT Appearance Descriptor — OSNet 이 있던 자리다. 가중치가 없다.
     *
     * 🔴 왜 걷어냈나. OSNet 가중치(osnet_ain_x1_0_msmt17.onnx, 8.7MB)는
     *    MSMT17 로 학습된 것이고, MSMT17 은 **연구 목적으로만** 배포된다.
     *    코드 라이선스(MIT)와 가중치 라이선스는 다른 문제다 — 제약은
     *    데이터에서 가중치로 따라온다. 수익화하는 앱에 실을 수 없다.
     *
     * 웹은 2026-09-06 에 이미 갈아탔다(hilit-appearance.js). 안드로이드가
     * 남아 있었고, 릴리스 빌드 산출물에도 그 파일이 들어가 있었다.
     *
     * ## 어떻게 대신하나 — 세 띠의 색 분포
     *
     * 사람을 세로로 셋(머리 25% · 상의 45% · 하의 30%)으로 자르고 각
     * 띠에서 HSV 색조 히스토그램을 만든다. 채도가 낮은 화소는 색조 대신
     * 밝기 칸에 센다 — 흰 옷과 검은 옷을 가르는 것이 그 칸이다.
     *
     * 왜 HSV 인가: 같은 흰 티셔츠가 그늘에 들어가면 RGB 세 값이 모두
     * 내려가 다른 색이 된다. HSV 는 색조를 밝기와 분리하므로 그늘에서도
     * 색조가 유지된다. 경기장 조명이 고르지 않은 우리 영상에서 중요하다.
     *
     * 정본은 packages/hilit-vision/src/appearance.ts 다(검사 21개 + 실측).
     * 실측 분리도: 테니스 +0.236 / 피겨 -0.131 — 되는 데서 되고 안 되는
     * 데서 안 된다고 말한다(믿음도 trust).
     */
    private static final class HilitAppearance {
        static final int HUE_BINS=12,GRAY_BINS=4,BAND_BINS=HUE_BINS+GRAY_BINS,CROP_W=48,CROP_H=96;
        static final float GRAY_SAT=.18f;
        static final float[] BANDS={.25f,.45f,.30f},BAND_WEIGHT={.8f,2f,1f};
        static final int SIZE=BANDS.length*BAND_BINS+BANDS.length*2;

        /** 상자 하나의 서술자. 표본이 너무 적으면 null — 부르는 쪽이 그걸로 거른다. */
        static float[] describe(Bitmap bitmap,Box b){
            float pad=.08f,x=b.x-b.w*pad,y=b.y-b.h*pad,w=b.w*(1+2*pad),h=b.h*(1+2*pad);
            if(Math.min(w,h)<24)return null;
            int[] px=cropPixels(bitmap,x,y,w,h,CROP_W,CROP_H);
            float[] values=new float[SIZE];
            /* 좌우 12% 만 자른다. 나머지는 커널 가중이 맡는다 — 딱 잘라
             * 버리면 팔을 벌린 자세에서 팔이 통째로 사라진다. */
            int x0=(int)Math.floor(CROP_W*.12f),x1=(int)Math.ceil(CROP_W*.88f);
            float cx=(x0+x1)/2f,halfW=Math.max(1,(x1-x0)/2f),cy=CROP_H/2f,halfH=Math.max(1,CROP_H/2f);
            float samples=0;int y0=0;
            for(int band=0;band<BANDS.length;band++){
                int y1=band==BANDS.length-1?CROP_H:Math.min(CROP_H,y0+Math.round(CROP_H*BANDS[band]));
                int base=band*BAND_BINS;float sum=0,sumSq=0,n=0;
                for(int yy=y0;yy<y1;yy++){
                    float dy=(yy-cy)/halfH;
                    for(int xx=x0;xx<x1;xx++){
                        int v=px[yy*CROP_W+xx];
                        /* 완전 투명은 세지 않는다 — 상자가 화면 밖으로 나가 빈 자리다.
                         * 검은색으로 칠하면 그 부분이 "검은 옷" 으로 세어져 오염된다. */
                        if(Color.alpha(v)<8)continue;
                        float dx=(xx-cx)/halfW;
                        /* 가운데일수록 무겁다(커널 가중). 상자에는 배경이
                         * 반드시 섞여 들어오고, 특히 가장자리가 그렇다.
                         * Comaniciu et al. 2003 의 착상이고 알고리즘만 가져왔다. */
                        float r2=dx*dx+dy*dy*.35f;
                        if(r2>=1)continue;
                        float k=1-r2;
                        float rr=Color.red(v)/255f,gg=Color.green(v)/255f,bb=Color.blue(v)/255f;
                        float max=Math.max(rr,Math.max(gg,bb)),min=Math.min(rr,Math.min(gg,bb)),d=max-min;
                        float hue=0;
                        if(d>1e-6f){
                            if(max==rr)hue=(((gg-bb)/d)+(gg<bb?6:0))/6f;
                            else if(max==gg)hue=(((bb-rr)/d)+2)/6f;
                            else hue=(((rr-gg)/d)+4)/6f;
                        }
                        float sat=max>1e-6f?d/max:0;
                        if(sat<GRAY_SAT)values[base+HUE_BINS+Math.min(GRAY_BINS-1,(int)(max*GRAY_BINS))]+=k;
                        else values[base+Math.min(HUE_BINS-1,(int)(hue*HUE_BINS))]+=sat*k;
                        sum+=max*k;sumSq+=max*max*k;n+=k;
                    }
                }
                if(n>0){float mean=sum/n;int stat=BANDS.length*BAND_BINS+band*2;values[stat]=mean;values[stat+1]=(float)Math.sqrt(Math.max(0,sumSq/n-mean*mean));samples+=n;}
                y0=y1;
            }
            if(samples<60)return null;
            /* 띠마다 따로 정규화한다. 통째로 하면 화소가 많은 띠가 나머지를 누른다. */
            for(int band=0;band<BANDS.length;band++){
                int base=band*BAND_BINS;float sum=0;
                for(int k=0;k<BAND_BINS;k++)sum+=values[base+k];
                if(sum>0)for(int k=0;k<BAND_BINS;k++)values[base+k]/=sum;
            }
            return values;
        }

        /* 두 서술자가 같은 사람인가 (0~1).
         *
         * 코사인 대신 히스토그램 교집합을 쓴다. 히스토그램은 확률분포라
         * 교집합이 "겹치는 비율" 이라는 뜻을 그대로 갖는다 — 0.7 이면 색
         * 분포의 70% 가 겹친다는 말이고, 사람이 임계값을 정할 때 읽을 수
         * 있는 숫자다.
         *
         * 상의 가중치가 2.0 인 것은 재 보고 정했다. 1.4 에서는 상의만
         * 다른 두 사람의 유사도가 0.63 이었다 — 다른 신호에 묻힌다. */
        static float similarity(float[] a,float[] b){
            if(a==null||b==null)return .5f;
            float total=0,weight=0;
            for(int band=0;band<BANDS.length;band++){
                int base=band*BAND_BINS;float inter=0;
                for(int k=0;k<BAND_BINS;k++)inter+=Math.min(a[base+k],b[base+k]);
                total+=inter*BAND_WEIGHT[band];weight+=BAND_WEIGHT[band];
            }
            float colour=weight>0?total/weight:0;
            int statBase=BANDS.length*BAND_BINS;float statDiff=0;
            for(int k=0;k<BANDS.length*2;k++)statDiff+=Math.abs(a[statBase+k]-b[statBase+k]);
            float stat=Math.max(0,1-statDiff/(BANDS.length*2));
            /* 밝기 통계는 거들 뿐이다. 0.15 로 뒀더니 색이 완전히 달라도
             * 통계가 같으면 바닥 점수가 높아졌다. */
            return clamp(colour*.9f+stat*.1f);
        }

        /* 서술자용 crop. 채우지 않는다 — 화면 밖은 투명으로 남겨 세지 않는다. */
        private static int[] cropPixels(Bitmap bitmap,float x,float y,float w,float h,int outW,int outH){
            Bitmap crop=Bitmap.createBitmap(outW,outH,Bitmap.Config.ARGB_8888);
            Canvas canvas=new Canvas(crop);
            Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG|Paint.FILTER_BITMAP_FLAG);
            Matrix matrix=new Matrix();
            matrix.setRectToRect(new RectF(x,y,x+w,y+h),new RectF(0,0,outW,outH),Matrix.ScaleToFit.FILL);
            canvas.drawBitmap(bitmap,matrix,paint);
            int[] pixels=new int[outW*outH];
            crop.getPixels(pixels,0,outW,0,0,outW,outH);
            crop.recycle();
            return pixels;
        }
    }

    /* 여기 `NanoDet` 내부 클래스와 전용 전처리(`crop`/`cropRect`/BGR 평면,
     * `averageColor`, `bound`, 후보 `iou`)가 있었다. 2026-09-16 에 가중치와
     * 함께 실행 경로에서 빠졌고, 2026-09-18 에 미호출이 확인되어 삭제했다.
     * 서술자용 `HilitAppearance.cropPixels` 는 HSV 띠용이라 남긴다.
     * ONNX 세션·텐서 헬퍼는 되살리지 않는다. */

    /* 닫을 세션이 없다. AutoCloseable 은 유지한다 — 부르는 쪽(try-with-resources)을
     * 고치지 않아도 되고, 다음 자체 모델이 생기면 여기서 정리한다. */
    @Override public void close() { }
}
