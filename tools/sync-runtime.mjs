#!/usr/bin/env node
// 비공개 제품 정본의 커밋에서 runtime/ 을 다시 뽑는다. 사본을 직접 고치지 않는다.
//
//   HILIT_WEB_REPO=<웹 정본 폴더> HILIT_ANDROID_REPO=<Android 정본 폴더> node tools/sync-runtime.mjs
//   ... node tools/sync-runtime.mjs --check    사본이 정본 커밋에서 뽑은 결과와 같은지만 본다(다르면 exit 1)
//
// 하는 일: 허용 경로만 복사 → 가중치·권리 기록 제외 → 파일 머리 표시와 지문 교체 → 모델 목록·코드 지문 갱신.
// 정본 저장소의 작업 트리는 읽지 않으므로 커밋되지 않은 수정은 섞이지 않는다.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileFingerprint, isStampable, MARK, PROJECT, REPO_URL, stampSource } from './lib/stamp.mjs';
import { K, WINDOW, winnow } from './lib/winnow.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIME = path.join(ROOT, 'runtime');
const check = process.argv.includes('--check');
// 공개 사본에서 바꿀 내부 이름 목록. 이름 자체를 공개하지 않도록 저작자 PC의 설정으로 넘긴다: [["원래 이름","바꿀 이름"], ...]
const SCRUB = JSON.parse(process.env.HILIT_SYNC_SCRUB ?? '[]');

export const WEB_PATHS = [
  'packages/shared-types',
  'packages/hilit-vision',
  'packages/tracking-core',
  'apps/web/public/tracking',
  'apps/web/public/person-detector',
  'apps/web/public/person-mask',
  'apps/web/src/lib/web-tracking-engine.ts',
  'apps/web/src/lib/tracking-postprocess.ts',
  'apps/web/src/lib/mediapipe-person-detector.ts',
  'apps/web/src/lib/person-candidates.ts',
  'apps/web/src/lib/person-box-fit.ts',
  'apps/web/src/lib/appearance-checkpoint.ts',
];
const ANDROID_DIR = 'apps/android/app/src/main/java/app/hilit/mobile';
export const ANDROID_FILES = [
  'AffineGmc', 'HilitDetectorThresholds', 'HilitMotionTracker', 'HilitPredictionFirewall', 'HilitReacquireGate',
  'HilitTrackRegionPrediction', 'NativeAppearanceCheckpoint', 'NativeFollowCamera', 'NativeReidScheduler',
  'NativeTrackingEngine', 'SportsTrack', 'LinkedCore', 'LinkedCues', 'LinkedAppearance', 'LinkedNativeTracker',
  'NativeLiveAsk', 'NativePersonMask',
].map((name) => `${ANDROID_DIR}/${name}.java`);

const BLOCKED_EXT = /\.(onnx|tflite|task|pth|pt|ckpt|bin|safetensors|wasm|apk|aab|mp4|mov|png|jpe?g|webp)$/i;
// 자체 가중치와 그 출처 기록, 내부 권리 판정 기록은 공개하지 않는다.
const BLOCKED_FILE = /(?:^|\/)(?:hilit-[a-z]+-[a-z]+-v\d+(?:\.provenance)?\.json|commercial-registry\.json|commercial\.ts|package-lock\.json)$/;
const OWN_WEIGHTS = /^apps\/web\/public\/tracking\/(hilit-[a-z]+-[a-z]+-v\d+)\.json$/;
const PUBLIC_MODELS = [
  { id: 'mediapipe-efficientdet-lite0-int8', file: 'efficientdet_lite0_int8.tflite', provenance: 'apps/web/public/models/person/efficientdet_lite0_int8.tflite.provenance.json' },
  { id: 'mediapipe-pose-landmarker-lite-f16', file: 'pose_landmarker_lite.task', provenance: 'apps/web/public/models/pose/pose_landmarker_lite.task.provenance.json' },
  { id: 'mediapipe-blazeface-short-range-f16', file: 'blaze_face_short_range.tflite', provenance: 'apps/web/public/models/face/blaze_face_short_range.tflite.provenance.json' },
];

const repos = [
  { env: 'HILIT_WEB_REPO', paths: WEB_PATHS, extra: ['scripts/check-android-tracking-parity.mjs'] },
  { env: 'HILIT_ANDROID_REPO', paths: ANDROID_FILES, extra: [] },
];
for (const repo of repos) {
  repo.dir = process.env[repo.env];
  if (!repo.dir || !existsSync(path.join(repo.dir, '.git'))) {
    console.error(`${repo.env} 에 정본 저장소 폴더를 지정해 주세요.`);
    process.exit(2);
  }
  const git = (...a) => execFileSync('git', ['-C', repo.dir, '-c', 'core.quotepath=false', ...a], { maxBuffer: 1 << 29 });
  repo.git = git;
  git('fetch', 'origin', '--quiet');
  repo.commit = git('rev-parse', 'origin/main').toString().trim();
}

/** 공개 사본에 맞게 글자를 고친다. 동작하는 코드는 바꾸지 않고 주석과 소유권 상수, 빠진 파일의 내보내기만 바꾼다. */
function transform(rel, text) {
  let out = text
    // 제품용 소유권 표시는 파일 어디에 있든 걷어 낸다. 공개 사본의 표시는 stampSource 가 넣는다.
    .replace(/\/\*(?:(?!\*\/)[\s\S])*?HILiT-OWN-2026(?:(?!\*\/)[\s\S])*?\*\/[ \t]*\r?\n?/g, '')
    // 조사 여부나 권리 문제의 유무는 코드 주석이 아니라 LICENSE 7항과 고지 문서로 말한다.
    .replace(/^[ \t]*\*[ \t]*특허 조사는 하지 않았다\.[ \t]*\r?\n/m, '')
    .replace('고전 영상처리의 기본 도구이고 특허·라이선스 문제가 없다.', '고전 영상처리의 기본 도구다.')
    .replace('"license": "UNLICENSED"', '"license": "SEE LICENSE IN LICENSE"');
  for (const [from, to] of SCRUB) out = out.replaceAll(from, to);
  if (rel === 'packages/tracking-core/src/ownership.ts') {
    return `/**
 * 소유권·출처 표시. 번들러가 남기는 상수이며 동작에 쓰이지 않는다. 지우거나 바꾸면 LICENSE 4항 위반이다.
 */
export const OWNERSHIP = Object.freeze({
  product: '${PROJECT}',
  holder: '조찬우 (Chanwoo Cho)',
  copyright: '© 2026 조찬우 (Chanwoo Cho)',
  notice: 'Noncommercial use only. Commercial use requires prior written approval: ccw00325@gmail.com',
  canonical: '${REPO_URL}',
  fingerprint: '${fileFingerprint(`runtime/${rel}`)}',
} as const);

export type Ownership = typeof OWNERSHIP;
`;
  }
  if (rel === 'packages/tracking-core/src/index.ts') {
    const before = out;
    out = out.replace(/^export[^;]*from\s+['"]\.\/commercial['"];?[ \t]*\r?\n/gm, '');
    if (before === out) throw new Error('index.ts 에서 commercial 내보내기를 찾지 못했습니다');
  }
  if (rel === 'scripts/check-android-tracking-parity.mjs') {
    const before = out;
    out = out.replace(
      "const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
      "const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'runtime');",
    );
    if (before === out) throw new Error('패리티 검사의 ROOT 를 찾지 못했습니다');
    // 앱 설정 파일은 공개 사본에 없고 추적 상수와도 무관하므로 그 한 줄만 뺀다.
    const noManifest = out.replace(/^.*AndroidManifest\.xml.*\r?\n/m, '');
    if (noManifest === out) throw new Error('패리티 검사의 앱 설정 줄을 찾지 못했습니다');
    out = `// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1\n${noManifest}`.replace(/^(\/\/ SPDX[^\n]*\n)(#!\/usr\/bin\/env node\n)/, '$2$1');
  }
  return out;
}

const output = new Map();
const models = [];
for (const repo of repos) {
  const listed = repo.git('ls-tree', '-r', 'origin/main', '--name-only', '--', ...repo.paths, ...repo.extra).toString().split('\n').filter(Boolean);
  for (const rel of listed) {
    const weight = rel.match(OWN_WEIGHTS);
    if (weight) {
      const blob = repo.git('show', `origin/main:${rel}`);
      models.push({
        id: weight[1],
        file: path.basename(rel),
        bytes: blob.length,
        sha256: createHash('sha256').update(blob).digest('hex'),
        distribution: 'private',
        license: 'Not licensed. Request access: ccw00325@gmail.com',
      });
    }
    if (BLOCKED_EXT.test(rel) || BLOCKED_FILE.test(rel)) continue;
    const raw = repo.git('show', `origin/main:${rel}`);
    const text = transform(rel, raw.toString('utf8'));
    const dest = rel === 'scripts/check-android-tracking-parity.mjs' ? 'tools/check-parity.mjs' : `runtime/${rel}`;
    output.set(dest, isStampable(rel) && !dest.startsWith('tools/') ? stampSource(dest, text) : text);
  }
}
for (const m of PUBLIC_MODELS) {
  const p = JSON.parse(repos[0].git('show', `origin/main:${m.provenance}`).toString('utf8'));
  models.push({
    id: m.id,
    file: m.file,
    bytes: p.bytes,
    sha256: p.modelSha256,
    distribution: 'public',
    url: p.source,
    license: p.weightLicense,
  });
}
models.sort((a, b) => a.id.localeCompare(b.id));
output.set('models/manifest.json', `${JSON.stringify({ schema: 'hilit-model-manifest-v1', note: 'Hashes only. No weights are stored in this repository.', models }, null, 2)}\n`);

// 코드 지문: 흔한 조각은 오탐을 만들므로 여러 파일에 나오면 뺀다.
const entries = [...output].filter(([p]) => p.startsWith('runtime/') && /\.(ts|tsx|js|mjs|java)$/.test(p) && !p.endsWith('/ownership.ts'));
const count = new Map();
const hashes = new Map();
for (const [p, text] of entries) {
  const h = winnow(text);
  hashes.set(p, h);
  for (const v of h) count.set(v, (count.get(v) ?? 0) + 1);
}
const files = entries
  .map(([p]) => ({ p, h: hashes.get(p).filter((v) => count.get(v) < 4) }))
  .filter((f) => f.h.length >= 8)
  .map((f) => ({ p: f.p, fp: fileFingerprint(f.p), h: f.h.map((v) => v.toString(36)).join(' ') }));
output.set('fingerprints/index.json', `${JSON.stringify({ schema: 'hilit-code-fingerprints-v1', mark: MARK, k: K, w: WINDOW, files })}\n`);
output.set('runtime/SOURCE.json', `${JSON.stringify({
  note: 'Generated by tools/sync-runtime.mjs from private product commits. Do not edit runtime/ by hand.',
  web: repos[0].commit,
  android: repos[1].commit,
}, null, 2)}\n`);

function walk(dir, base = '') {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(base, e.name);
    return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [rel];
  });
}

if (check) {
  const expected = new Map(output);
  const current = walk(RUNTIME, 'runtime');
  const diffs = [];
  for (const [p, text] of expected) {
    const file = path.join(ROOT, p);
    if (!existsSync(file) || readFileSync(file, 'utf8') !== text) diffs.push(`다름 ${p}`);
  }
  for (const p of current) if (!expected.has(p)) diffs.push(`남는 파일 ${p}`);
  if (diffs.length) {
    console.error(diffs.slice(0, 20).join('\n'));
    console.error(`사본이 정본과 다릅니다: ${diffs.length}개`);
    process.exit(1);
  }
  console.log(`사본 일치: ${expected.size}개 (web ${repos[0].commit.slice(0, 8)} · android ${repos[1].commit.slice(0, 8)})`);
} else {
  rmSync(RUNTIME, { recursive: true, force: true });
  for (const [p, text] of output) {
    const file = path.join(ROOT, p);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  console.log(`사본 갱신: ${output.size}개, 코드 지문 ${files.length}개 파일, 모델 ${models.length}개 (web ${repos[0].commit.slice(0, 8)} · android ${repos[1].commit.slice(0, 8)})`);
}
