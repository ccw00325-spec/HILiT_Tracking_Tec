/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·0b87caea @license @preserve */
package app.hilit.mobile;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 기기 로컬 외형 체크포인트. 웹 IndexedDB 자리의 안드로이드 쪽.
 *
 * {@code Context.getFilesDir()} 아래 JSON. crop 화소는 넣지 않는다.
 * 서술자 숫자만. 앱 백업은 매니페스트 {@code allowBackup=false}.
 * 비교는 RAM 에서 하고, 이 파일은 재시작 힌트다. 서버로 안 보낸다.
 */
final class NativeAppearanceCheckpoint {
    static final int USER_CONFIRMED = 4;
    static final int CURRENT = 12;
    static final int PAST = 4;
    static final int TENTATIVE = 4;
    static final int BYTE_BUDGET = 256 * 1024;
    static final int TTL_MINUTES = 60;
    static final int POLICY_VERSION = 1;
    static final String FILE_NAME = "hilit-appearance-checkpoint.json";

    private final File dir;
    private int lastAccepted;
    private int lastRejected;

    NativeAppearanceCheckpoint(File filesDir) {
        this.dir = filesDir;
    }

    int lastAccepted() { return lastAccepted; }
    int lastRejected() { return lastRejected; }

    File file() {
        return new File(dir, FILE_NAME);
    }

    void save(String subjectId, float[] values) {
        lastAccepted = 0;
        lastRejected = 0;
        if (values == null || values.length == 0 || subjectId == null) {
            lastRejected = 1;
            return;
        }
        StringBuilder sb = new StringBuilder(64 + values.length * 8);
        sb.append("{\"schemaVersion\":1,\"policyVersion\":").append(POLICY_VERSION)
                .append(",\"noCrops\":true,\"byteBudget\":").append(BYTE_BUDGET)
                .append(",\"ttlMinutes\":").append(TTL_MINUTES)
                .append(",\"userConfirmed\":").append(USER_CONFIRMED)
                .append(",\"current\":").append(CURRENT)
                .append(",\"past\":").append(PAST)
                .append(",\"tentative\":").append(TENTATIVE)
                .append(",\"subjectId\":\"").append(escape(subjectId)).append("\",\"values\":[");
        for (int i = 0; i < values.length; i += 1) {
            if (i > 0) sb.append(',');
            sb.append(values[i]);
        }
        sb.append("]}");
        byte[] bytes = sb.toString().getBytes(StandardCharsets.UTF_8);
        if (bytes.length > BYTE_BUDGET) {
            lastRejected = 1;
            return;
        }
        if (!dir.exists() && !dir.mkdirs()) {
            lastRejected = 1;
            return;
        }
        try (FileOutputStream out = new FileOutputStream(file())) {
            out.write(bytes);
            lastAccepted = 1;
        } catch (Exception e) {
            lastRejected = 1;
        }
    }

    float[] load(String subjectId) {
        File f = file();
        if (!f.isFile() || f.length() > BYTE_BUDGET) return null;
        long ageMs = System.currentTimeMillis() - f.lastModified();
        if (ageMs > TTL_MINUTES * 60_000L) return null;
        byte[] bytes = new byte[(int) f.length()];
        try (FileInputStream in = new FileInputStream(f)) {
            int n = in.read(bytes);
            if (n != bytes.length) return null;
        } catch (Exception e) {
            return null;
        }
        String text = new String(bytes, StandardCharsets.UTF_8);
        if (text.contains("\"crops\"") || text.contains("\"pixels\"")) return null;
        if (subjectId != null && !text.contains("\"subjectId\":\"" + escape(subjectId) + "\"")) {
            return null;
        }
        int start = text.indexOf("\"values\":[");
        if (start < 0) return null;
        int open = text.indexOf('[', start);
        int close = text.indexOf(']', open);
        if (open < 0 || close < 0) return null;
        String[] parts = text.substring(open + 1, close).split(",");
        float[] values = new float[parts.length];
        for (int i = 0; i < parts.length; i += 1) {
            try {
                values[i] = Float.parseFloat(parts[i].trim());
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return values.length == 0 ? null : values;
    }

    private static String escape(String s) {
        return s.replace("\\", "").replace("\"", "");
    }
}
