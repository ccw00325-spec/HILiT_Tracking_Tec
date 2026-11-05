// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
import { HilitDcfTrackerCore } from '../runtime/apps/web/public/tracking/generated/dcf-tracker.js';
import { ENGINES, runEngine, truthFn } from '../tools/lib/engines.mjs';
import { buildScene, renderFrame, SCENARIOS } from '../tools/lib/scenes.mjs';

const $ = (id) => document.getElementById(id);
const view = $('view');
const ctx = view.getContext('2d', { willReadFrequently: true });
const status = (text) => { $('status').textContent = text; };
const STATE = { TRACKING_OK: '정상', TRACKING_WARNING: '주의', TARGET_LOST: '놓침' };
let playing = 0;

for (const [k, v] of Object.entries(SCENARIOS)) $('scene').add(new Option(v, k));
for (const [k, v] of Object.entries(ENGINES)) $('engine').add(new Option(v, k));

function strokeBox(box, color, dash = []) {
  if (!box) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.setLineDash(dash);
  ctx.strokeRect(box.x, box.y, box.width, box.height);
  ctx.restore();
}

function showScore(s) {
  const pct = (x) => (x === null ? '해당 없음' : `${(x * 100).toFixed(1)}%`);
  const rows = [
    ['대상이 보일 때 정답 상자 비율', pct(s.hitRate)],
    ['다른 사람을 따라간 비율', pct(s.wrongRate)],
    ['보이는데 놓침으로 표시한 비율', pct(s.lostVisibleRate)],
    ['가려졌는데 정상으로 표시한 비율', pct(s.hiddenClaimRate)],
    ['대상이 바뀐 횟수', String(s.switches)],
  ];
  $('score').replaceChildren(...rows.map(([a, b]) => {
    const tr = document.createElement('tr');
    tr.append(Object.assign(document.createElement('td'), { textContent: a }), Object.assign(document.createElement('td'), { textContent: b }));
    return tr;
  }));
  $('scorePanel').hidden = false;
}

function runScene() {
  const token = ++playing;
  const scene = buildScene($('scene').value);
  view.width = scene.width;
  view.height = scene.height;
  status('계산하고 있습니다…');
  $('run').disabled = true;
  setTimeout(() => {
    const engine = $('engine').value;
    const result = runEngine(engine, scene);
    $('run').disabled = false;
    if (result.failed) { status(`시작하지 못했습니다: ${result.failed}`); return; }
    showScore(result.score);
    window.__demoResult = { scene: scene.name, engine, score: result.score, frames: result.rows.length };
    const truth = truthFn(scene);
    const started = performance.now();
    const draw = () => {
      if (token !== playing) return;
      const t = ((performance.now() - started) / 1000) % (scene.seconds + 1);
      const now = Math.min(t, scene.seconds);
      const frame = renderFrame(scene, now);
      ctx.putImageData(new ImageData(frame.data, frame.width, frame.height), 0, 0);
      strokeBox(truth(now).target.box, '#ffffff', [5, 4]);
      let row = result.rows[0];
      for (const r of result.rows) { if (r.t <= now) row = r; else break; }
      if (row.state !== 'TARGET_LOST') strokeBox(row.box, row.state === 'TRACKING_OK' ? '#22d36b' : '#ffb020');
      status(`${now.toFixed(1)}초 · ${STATE[row.state] ?? row.state} · 실선: 추적 결과, 흰 점선: 정답`);
      requestAnimationFrame(draw);
    };
    draw();
  }, 20);
}
$('run').addEventListener('click', runScene);

/* 내 영상: 첫 화면에서 드래그로 대상을 고르고 DCF 로 따라간다. */
const video = document.createElement('video');
video.muted = true;
video.playsInline = true;
let picked = null;
let dragStart = null;

function point(e) {
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left) * (view.width / r.width), y: (e.clientY - r.top) * (view.height / r.height) };
}

$('file').addEventListener('change', () => {
  const f = $('file').files[0];
  if (!f) return;
  playing += 1;
  picked = null;
  $('play').disabled = true;
  video.src = URL.createObjectURL(f);
  video.onloadeddata = () => {
    const scale = Math.min(1, 640 / video.videoWidth);
    view.width = Math.round(video.videoWidth * scale);
    view.height = Math.round(video.videoHeight * scale);
    video.currentTime = 0;
    ctx.drawImage(video, 0, 0, view.width, view.height);
    status('따라갈 사람을 드래그해 주세요.');
  };
  video.onseeked = () => { if (!picked) ctx.drawImage(video, 0, 0, view.width, view.height); };
  video.onerror = () => status('이 영상은 브라우저에서 열 수 없습니다.');
});

view.addEventListener('pointerdown', (e) => {
  if (!video.src || !$('file').files[0]) return;
  dragStart = point(e);
  view.setPointerCapture(e.pointerId);
});
view.addEventListener('pointermove', (e) => {
  if (!dragStart) return;
  const p = point(e);
  picked = { x: Math.min(p.x, dragStart.x), y: Math.min(p.y, dragStart.y), width: Math.abs(p.x - dragStart.x), height: Math.abs(p.y - dragStart.y) };
  ctx.drawImage(video, 0, 0, view.width, view.height);
  strokeBox(picked, '#22d36b');
});
view.addEventListener('pointerup', () => {
  dragStart = null;
  const ready = picked && picked.width >= 8 && picked.height >= 16;
  $('play').disabled = !ready;
  status(ready ? '추적 시작을 눌러 주세요.' : '사람을 조금 더 크게 드래그해 주세요.');
});

function readFrame() {
  const id = ctx.getImageData(0, 0, view.width, view.height);
  return { data: id.data, width: id.width, height: id.height, ox: 0, oy: 0, frameWidth: id.width, frameHeight: id.height };
}

$('play').addEventListener('click', async () => {
  const token = ++playing;
  $('scorePanel').hidden = true;
  ctx.drawImage(video, 0, 0, view.width, view.height);
  const tracker = new HilitDcfTrackerCore();
  tracker.init(readFrame(), picked, video.currentTime);
  await video.play();
  const step = () => {
    if (token !== playing) { video.pause(); return; }
    if (video.ended) { status('끝났습니다.'); return; }
    ctx.drawImage(video, 0, 0, view.width, view.height);
    const t0 = performance.now();
    const r = tracker.update(readFrame(), video.currentTime);
    const ms = performance.now() - t0;
    if (r?.box && r.status !== 'lost') strokeBox(r.box, r.status === 'tracked' ? '#22d36b' : '#ffb020');
    status(`${video.currentTime.toFixed(1)}초 · ${r?.status === 'tracked' ? '정상' : r?.status === 'lost' ? '놓침' : '주의'} · 프레임 처리 ${ms.toFixed(1)}ms`);
    requestAnimationFrame(step);
  };
  step();
});

/* 자동 확인용: ?auto=장면&engine=방식 */
const q = new URLSearchParams(location.search);
if (q.get('auto')) {
  $('scene').value = q.get('auto');
  if (q.get('engine')) $('engine').value = q.get('engine');
  runScene();
}
