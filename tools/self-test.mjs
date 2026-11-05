#!/usr/bin/env node
// 공개 저장소의 기본 검사. 네트워크와 비공개 정본 없이 돈다.
//   표시·지문 대조 / 공개 안전 검사 / 웹·Android 상수 일치 / 코어 실행 / 복제 탐지 / 모델 받기 / 측정 해석
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate, parseBattery, parseGfx, parseThermal } from './android-profile.mjs';
import { runBench } from './bench-tracker.mjs';
import { scan } from './detect-copy.mjs';
import { fetchModel } from './fetch-models.mjs';
import { fileFingerprint, isStampable, stampSource } from './lib/stamp.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(
    (note) => console.log(`통과 ${name}${note ? ` — ${note}` : ''}`),
    (error) => { failures.push(name); console.log(`실패 ${name}: ${error.message}`); },
  );
}
function assert(ok, message) { if (!ok) throw new Error(message); }
function walk(dir, base = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === '.git' || e.name === 'node_modules') return [];
    const rel = base ? `${base}/${e.name}` : e.name;
    return e.isDirectory() ? walk(path.join(dir, e.name), rel) : [rel];
  });
}
const all = walk(ROOT);

await test('모든 코드 파일에 표시와 고유 지문이 있다', () => {
  const code = all.filter((p) => p.startsWith('runtime/') && isStampable(p));
  const seen = new Set();
  for (const p of code) {
    const head = readFileSync(path.join(ROOT, p), 'utf8').slice(0, 600);
    const fp = fileFingerprint(p);
    assert(head.includes(fp), `지문 없음 ${p}`);
    assert(head.includes('ccw00325@gmail.com') && head.includes('HILiT_Tracking_Tec'), `표시 없음 ${p}`);
    assert(!seen.has(fp), `지문 중복 ${p}`);
    seen.add(fp);
  }
  return `${code.length}개`;
});

await test('표시를 다시 찍어도 설명 주석이 지워지지 않는다', () => {
  const stamped = stampSource('a.js', '/* 설명 */\nexport const a = 1;\n');
  assert(stamped.includes('/* 설명 */'), '설명 주석이 지워졌습니다');
  const old = stampSource('a.js', '/*! © 2026 조찬우 (HILiT). HILiT-OWN-2026·x @license */\n/* 설명 */\nconst a = 1;\n');
  assert(!old.includes('HILiT-OWN-2026') && old.includes('/* 설명 */'), '옛 표시가 남았습니다');
});

await test('공개하면 안 되는 것이 없다', () => {
  const BIN = /\.(onnx|tflite|task|pth|pt|ckpt|bin|safetensors|wasm|apk|aab|mp4|mov|keystore|jks|pem|p12)$/i;
  const WEIGHT = /hilit-(?:grid|pose)-[a-z]+-v\d+(?:\.provenance)?\.json$/;
  const TEXT = [
    [/gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/, '토큰'],
    [/hf_[A-Za-z0-9]{30,}/, '토큰'],
    [/AKIA[0-9A-Z]{16}/, '토큰'],
    [/AIza[0-9A-Za-z_-]{30,}/, '토큰'],
    [/sk-(?:ant-)?[A-Za-z0-9_-]{24,}/, '토큰'],
    [/eyJ[A-Za-z0-9_-]{15,}\.eyJ[A-Za-z0-9_-]{15,}\./, '토큰'],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, '개인키'],
    [/[a-z0-9]{20}\.supabase\.co/, '내부 주소'],
    [/\b[A-Za-z]:[\\/](?:GPT|Users|HILiT_키보관|기술결정등)/, '내 PC 경로'],
    [new RegExp(['HILiT', 'OWN', '2026'].join('-')), '제품 지문'],
    [new RegExp(['d3f1a7c0', 'e9b24f85'].join('')), '제품 지문'],
    [new RegExp(['HILiT_', '(?:Research|Editor|Edit_APK|Docs|Admin)'].join('')), '비공개 저장소'],
    [new RegExp(['hilit_', '(?:loss|admin|lp)'].join('')), '비공개 저장소'],
  ];
  for (const p of all) {
    assert(!BIN.test(p), `이진 파일 ${p}`);
    assert(!WEIGHT.test(p), `가중치 ${p}`);
    assert(statSync(path.join(ROOT, p)).size < 1024 * 1024 || p === 'fingerprints/index.json', `큰 파일 ${p}`);
    if (/\.(jpe?g)$/i.test(p)) { assert(p === 'assets/hilit-tec-banner.jpg', `사진 ${p}`); continue; }
    const text = readFileSync(path.join(ROOT, p), 'utf8');
    for (const [rx, label] of TEXT) {
      // 사본 도구는 옛 표시를 걷어 내려고 그 접두어를 알아야 한다. 고유값은 어디에도 없어야 한다.
      if (label === '제품 지문' && p.startsWith('tools/') && rx.source.startsWith('HILiT')) continue;
      assert(!rx.test(text), `${label} ${p}`);
    }
  }
  return `${all.length}개`;
});

await test('모델 목록에 필요한 값이 있고 가중치는 없다', () => {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'models/manifest.json'), 'utf8'));
  assert(manifest.models.length >= 4, '모델 수');
  for (const m of manifest.models) {
    assert(/^[0-9a-f]{64}$/.test(m.sha256), `해시 ${m.id}`);
    assert(m.distribution !== 'public' || m.url, `주소 ${m.id}`);
    assert(m.distribution !== 'private' || !m.url, `비공개 주소 ${m.id}`);
  }
  return `${manifest.models.length}개`;
});

await test('웹과 Android 추적 상수가 같다', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/check-parity.mjs')], { encoding: 'utf8' });
  assert(r.status === 0, (r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' / '));
  return r.stdout.trim().split('\n').at(-1).slice(0, 80);
});

await test('추적 코어가 합성 영상의 대상을 따라간다', () => {
  const r = runBench({ frames: 60, width: 320, height: 180 });
  assert(r.trackedFrames > 50, `추적 프레임 ${r.trackedFrames}`);
  assert(r.meanCenterErrorPx < 20, `중심 오차 ${r.meanCenterErrorPx}`);
  return `중심 오차 ${r.meanCenterErrorPx}px, ${r.p50Ms}ms`;
});

const tmp = mkdtempSync(path.join(os.tmpdir(), 'hilit-tec-test-'));
try {
  await test('표시가 남은 사본을 찾는다', async () => {
    const f = path.join(tmp, 'copied.js');
    writeFileSync(f, readFileSync(path.join(ROOT, 'runtime/apps/web/public/tracking/affine-gmc.js')));
    const r = await scan([f]);
    assert(r.marks.length === 1, '표시를 못 찾음');
    assert(r.code.some((c) => c.source.endsWith('affine-gmc.js')), '코드 조각을 못 찾음');
  });

  await test('표시와 주석을 지우고 지역 이름을 바꾼 사본도 찾는다', async () => {
    const src = readFileSync(path.join(ROOT, 'runtime/apps/web/public/tracking/generated/dcf-tracker.js'), 'utf8');
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\b(const|let)\s+([a-zA-Z_]\w*)/g, (m, kind, name) => `${kind} q_${name}`)
      .replace(/\s+/g, ' ');
    const f = path.join(tmp, 'stripped.js');
    writeFileSync(f, stripped);
    const r = await scan([f]);
    assert(r.marks.length === 0, '표시가 남아 있으면 시험이 아닙니다');
    const hit = r.code.find((c) => c.source.endsWith('generated/dcf-tracker.js'));
    assert(hit, '코드 조각을 못 찾음');
    return `일치 ${(hit.share * 100).toFixed(0)}%`;
  });

  await test('무관한 코드는 복제로 보지 않는다', async () => {
    const r = await scan([path.join(ROOT, 'tools/lib/winnow.mjs')]);
    assert(!r.found, `오탐 ${JSON.stringify(r.code.slice(0, 2))}`);
  });

  await test('모델 받기는 해시가 맞을 때만 캐시에 넣는다', async () => {
    const src = path.join(tmp, 'src');
    execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(src)})`]);
    writeFileSync(path.join(src, 'm.bin'), 'weights');
    const sha256 = createHash('sha256').update('weights').digest('hex');
    const cache = path.join(tmp, 'cache');
    const first = await fetchModel({ id: 'm', file: 'm.bin', sha256, bytes: 7 }, { source: src, cache });
    assert(first.status === '받음', first.status);
    const again = await fetchModel({ id: 'm', file: 'm.bin', sha256, bytes: 7 }, { source: src, cache });
    assert(again.status === '캐시 사용', again.status);
    let rejected = false;
    await fetchModel({ id: 'x', file: 'm.bin', sha256: '0'.repeat(64), bytes: 7 }, { source: src, cache }).catch(() => { rejected = true; });
    assert(rejected, '해시가 달라도 받았습니다');
    assert(readdirSync(cache).length === 1, '깨진 파일이 남았습니다');
  });
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

await test('기기 측정값 해석과 예산 판정', () => {
  const gfx = parseGfx('Total frames rendered: 1000\nJanky frames: 200 (20.00%)\n50th percentile: 9ms\n95th percentile: 40ms\n99th percentile: 80ms\n');
  assert(gfx.totalFrames === 1000 && gfx.jankyFrames === 200 && gfx.p95Ms === 40, 'gfxinfo');
  assert(parseThermal('Thermal Status: 3\n') === 3, 'thermal');
  const b = parseBattery('  level: 80\n  temperature: 385\n');
  assert(b.level === 80 && b.tempC === 38.5, 'battery');
  const bad = evaluate({ gfx, thermalMax: 3, batteryStart: 80, batteryEnd: 70, tempMax: 44, seconds: 600 });
  assert(!bad.pass && bad.failures.length === 4, `실패 ${bad.failures.length}`);
  const ok = evaluate({ gfx: { totalFrames: 100, jankyFrames: 1 }, thermalMax: 1, batteryStart: 80, batteryEnd: 79, tempMax: 36, seconds: 600 });
  assert(ok.pass, ok.failures.join());
});

await test('라이선스 문서와 도구 표시가 맞다', () => {
  const license = readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  for (const need of ['LicenseRef-HILiT-NCA-1.1', 'ccw00325@gmail.com', 'HILiT Tracking Tec', 'https://github.com/ccw00325-spec/HILiT_Tracking_Tec', '조찬우']) assert(license.includes(need), `LICENSE ${need}`);
  for (const f of ['NOTICE', 'AI_NOTICE.md', 'README.md', 'CONTRIBUTING.md', 'ai.txt', 'CITATION.cff']) assert(all.includes(f), `없음 ${f}`);
  const code = all.filter((p) => /^(tools|demo|examples)\/.+\.m?js$/.test(p) && !/^tools\/(self-test|detect-copy|watch-github|fetch-models|android-profile|bench-tracker|sync-runtime)\.mjs$/.test(p) && !/^tools\/lib\/(stamp|winnow)\.mjs$/.test(p));
  for (const p of code) assert(readFileSync(path.join(ROOT, p), 'utf8').slice(0, 300).includes('LicenseRef-HILiT-NCA-1.1'), `표시 없음 ${p}`);
  return `${code.length}개`;
});

await test('사용 예가 실제로 돈다', () => {
  for (const f of ['examples/track-your-frames.mjs', 'examples/link-your-detections.mjs']) {
    const r = spawnSync(process.execPath, [path.join(ROOT, f)], { encoding: 'utf8' });
    assert(r.status === 0, `${f}: ${(r.stderr || '').split('\n')[0]}`);
  }
});

await test('자기 영상 채점 도구가 합성 시험과 같은 답을 낸다', async () => {
  const { scoreFiles } = await import('./eval-track.mjs');
  const box = { x: 0, y: 0, width: 10, height: 20 };
  const far = { x: 100, y: 0, width: 10, height: 20 };
  const r = scoreFiles(
    [{ t: 0, box, state: 'TRACKING_OK' }, { t: 1, box: far, state: 'TRACKING_OK' }, { t: 2, box, state: 'TARGET_LOST' }],
    [{ t: 0, box }, { t: 1, box, others: [far] }, { t: 2, box }],
  );
  assert(Math.abs(r.hitRate - 1 / 3) < 1e-6 && Math.abs(r.wrongRate - 1 / 3) < 1e-6 && r.switches === 1, JSON.stringify(r));
});

await test('암호화 가중치 묶음은 비밀번호와 해시가 맞아야 열린다', async () => {
  const { openBundle } = await import('./open-weights-bundle.mjs');
  const { createCipheriv, randomBytes, scryptSync } = await import('node:crypto');
  const data = Buffer.from('weights');
  const body = Buffer.from(JSON.stringify({ files: [{ name: 'm.json', sha256: createHash('sha256').update(data).digest('hex'), data: data.toString('base64') }] }));
  const salt = randomBytes(16), iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', scryptSync('pw', salt, 32, { N: 16384, r: 8, p: 1 }), iv);
  const enc = Buffer.concat([c.update(body), c.final()]);
  const head = JSON.stringify({ magic: 'HILIT-WEIGHTS-1', N: 16384, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') });
  const raw = Buffer.concat([Buffer.from(`${head}\n`), enc]);
  assert(openBundle(raw, 'pw').files[0].bytes.equals(data), '내용이 다릅니다');
  let rejected = false;
  try { openBundle(raw, 'wrong'); } catch { rejected = true; }
  assert(rejected, '틀린 비밀번호로 열렸습니다');
});

console.log(failures.length ? `실패 ${failures.length}건` : '전체 통과');
process.exit(failures.length ? 1 : 0);
