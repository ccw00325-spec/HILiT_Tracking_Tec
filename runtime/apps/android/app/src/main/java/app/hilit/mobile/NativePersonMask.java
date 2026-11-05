/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·a3a3fb75 @license @preserve */
package app.hilit.mobile;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.util.Log;

import org.tensorflow.lite.DataType;
import org.tensorflow.lite.Interpreter;
import org.tensorflow.lite.Tensor;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 사람 모양 마스크(2026-10-27 추적 제안 1번, 사용자 결정 D-16 「직접 구현」).
 *
 * 웹은 MediaPipe 작업자(/person-mask/worker.js)를 쓰지만 Android 는 MediaPipe Tasks 를 쓰지 않는다 — 사용 통계를 Google 로 보낸다
 * (build.gradle.kts). 그래서 이미 앱에 있는 LiteRT 로, 이미 제품에 있는 같은 Pose Landmarker lite 묶음(.task, Apache-2.0, 해시 고정)의
 * pose_landmarks_detector.tflite 를 직접 돌려 분할 출력(output_segmentation, 시그모이드 전 값)만 읽는다. 자리 맞춤은 MediaPipe 그래프
 * 대신 사람 검출기 상자를 정사각으로 넓혀 넣는 방식으로 직접 했다 — 그래서 마스크가 웹과 조금 다를 수 있다.
 *
 * 관절은 쓰지 않는다. 마스크는 상자 크기의 0~1 숫자로만 돌려주고, 그 영상 분석 동안 메모리에만 있다. 신원 판정에 쓰지 않는다.
 * 모델을 못 열면 null — 부르는 쪽은 마스크 없이 센다(D-08).
 */
final class NativePersonMask implements AutoCloseable {
    static final String ASSET = "models/pose/pose_landmarker_lite.task";
    static final String SHA256 = "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a";
    static final String ENTRY = "pose_landmarks_detector.tflite";
    /** 상자를 정사각으로 넓히는 배수(긴 변 기준). */
    static final float ROI_SCALE = 1.25f;

    private final Interpreter interpreter;
    private final int inW, inH, segIdx, segW, segH;
    private final ByteBuffer input;
    private final int outCount;

    private NativePersonMask(Interpreter interpreter) {
        this.interpreter = interpreter;
        Tensor in = interpreter.getInputTensor(0);
        int[] s = in.shape();
        inH = s[1]; inW = s[2];
        if (in.dataType() != DataType.FLOAT32) throw new IllegalStateException("입력 형식이 다릅니다: " + in.dataType());
        input = ByteBuffer.allocateDirect(inW * inH * 3 * 4).order(ByteOrder.nativeOrder());
        outCount = interpreter.getOutputTensorCount();
        int seg = -1, w = 0, h = 0;
        for (int i = 0; i < outCount; i++) {
            Tensor t = interpreter.getOutputTensor(i);
            int[] sh = t.shape();
            String name = String.valueOf(t.name()).toLowerCase(java.util.Locale.ROOT);
            boolean shapeOk = sh.length == 4 && sh[3] == 1 && sh[1] == sh[2] && sh[1] >= 32;
            if (shapeOk && (seg < 0 || name.contains("segment"))) { seg = i; h = sh[1]; w = sh[2]; }
        }
        if (seg < 0) throw new IllegalStateException("분할 출력이 없습니다");
        segIdx = seg; segW = w; segH = h;
    }

    /** 모델을 연다. 묶음 해시가 다르거나 실행기가 못 열면 null. 작업 스레드에서 부른다. */
    static NativePersonMask open(Context context) {
        try {
            byte[] bundle;
            try (InputStream inStream = context.getAssets().open(ASSET)) { bundle = readAll(inStream); }
            if (!SHA256.equals(sha256(bundle))) { Log.w("HilitPersonMask", "포즈 모델 해시가 다릅니다"); return null; }
            byte[] model = null;
            try (ZipInputStream zip = new ZipInputStream(new java.io.ByteArrayInputStream(bundle))) {
                for (ZipEntry e; (e = zip.getNextEntry()) != null; ) if (ENTRY.equals(e.getName())) { model = readAll(zip); break; }
            }
            if (model == null) return null;
            ByteBuffer buf = ByteBuffer.allocateDirect(model.length).order(ByteOrder.nativeOrder());
            buf.put(model).rewind();
            return new NativePersonMask(new Interpreter(buf, new Interpreter.Options().setNumThreads(2)));
        } catch (Exception | LinkageError e) {
            Log.w("HilitPersonMask", "사람 마스크 모델을 열지 못했습니다", e);
            return null;
        }
    }

    /** 정사각 ROI(프레임 화소) — 상자 가운데, 긴 변 × ROI_SCALE. */
    static float[] roi(float x, float y, float w, float h) {
        float side = Math.max(w, h) * ROI_SCALE, cx = x + w / 2, cy = y + h / 2;
        return new float[]{cx - side / 2, cy - side / 2, side};
    }

    /**
     * frame 위 상자(프레임 화소)의 마스크 — outW×outH, 0~1. 웹 worker.js boxMask 와 같은 품질 검사(덮은 비율 0.1~0.95, 가운데 자리
     * 0.2~0.8)를 지나지 못하면 null.
     */
    float[] mask(Bitmap frame, float bx, float by, float bw, float bh, int outW, int outH) {
        float[] r = roi(bx, by, bw, bh);
        Bitmap crop = Bitmap.createBitmap(inW, inH, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(crop);
        Matrix m = new Matrix();
        m.setTranslate(-r[0], -r[1]);
        m.postScale(inW / r[2], inH / r[2]);
        canvas.drawBitmap(frame, m, new Paint(Paint.FILTER_BITMAP_FLAG));
        int[] px = new int[inW * inH];
        crop.getPixels(px, 0, inW, 0, 0, inW, inH);
        crop.recycle();
        input.rewind();
        for (int p : px) {
            input.putFloat(((p >> 16) & 0xFF) / 255f);
            input.putFloat(((p >> 8) & 0xFF) / 255f);
            input.putFloat((p & 0xFF) / 255f);
        }
        input.rewind();
        Map<Integer, Object> outputs = new HashMap<>();
        for (int i = 0; i < outCount; i++) {
            Tensor t = interpreter.getOutputTensor(i);
            ByteBuffer o = ByteBuffer.allocateDirect(t.numBytes()).order(ByteOrder.nativeOrder());
            outputs.put(i, o);
        }
        interpreter.runForMultipleInputsOutputs(new Object[]{input}, outputs);
        ByteBuffer seg = (ByteBuffer) outputs.get(segIdx);
        seg.rewind();
        float[] logits = new float[segW * segH];
        seg.asFloatBuffer().get(logits);
        return boxMask(logits, segW, segH, r, bx, by, bw, bh, outW, outH);
    }

    /** ROI 격자의 값 → 상자 안 outW×outH 마스크(시그모이드). 순수 계산이라 JVM 시험에서 부른다. */
    static float[] boxMask(float[] logits, int segW, int segH, float[] roi, float bx, float by, float bw, float bh, int outW, int outH) {
        float[] out = new float[outW * outH];
        double sum = 0, sx = 0;
        for (int j = 0; j < outH; j++) {
            float fy = by + (j + 0.5f) * bh / outH;
            int my = Math.min(segH - 1, Math.max(0, (int) Math.floor((fy - roi[1]) / roi[2] * segH)));
            for (int i = 0; i < outW; i++) {
                float fx = bx + (i + 0.5f) * bw / outW;
                int mx = Math.min(segW - 1, Math.max(0, (int) Math.floor((fx - roi[0]) / roi[2] * segW)));
                float v = (float) (1 / (1 + Math.exp(-logits[my * segW + mx])));
                out[j * outW + i] = v;
                sum += v; sx += v * (i + 0.5) / outW;
            }
        }
        double cover = sum / (outW * outH);
        double centre = sx / Math.max(1e-6, sum);
        if (cover < 0.1 || cover > 0.95 || centre < 0.2 || centre > 0.8) return null;
        return out;
    }

    @Override public void close() { interpreter.close(); }

    private static byte[] readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[1 << 16];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        return out.toByteArray();
    }

    private static String sha256(byte[] bytes) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(bytes);
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString();
    }
}
