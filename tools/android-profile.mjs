#!/usr/bin/env node
// 연결된 Android 기기에서 앱을 쓰는 동안 프레임·발열·배터리를 재고 예산과 비교한다. 읽기만 하며 앱을 조작하지 않는다.
//
//   node tools/android-profile.mjs --seconds 600 [--package <앱 id>] [--serial <기기>] [--out 결과.json]
//
// 측정을 시작한 뒤 앱에서 추적을 직접 돌려 주세요. 값은 adb dumpsys 에서 읽습니다.
// 에뮬레이터 값은 발열·배터리 근거가 되지 못합니다. 결과의 isEmulator 를 함께 보세요.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUDGET = {
  maxJankRatio: 0.1,      // 끊긴 프레임 비율
  maxThermalStatus: 2,    // 0 없음·1 가벼움·2 보통·3 심함 이상이면 실패
  maxBatteryDropPer10Min: 5, // 10분당 배터리 감소(%)
  maxTempC: 42,
};

export function parseGfx(text) {
  const num = (rx) => Number(text.match(rx)?.[1] ?? NaN);
  return {
    totalFrames: num(/Total frames rendered:\s*(\d+)/),
    jankyFrames: num(/Janky frames:\s*(\d+)/),
    p50Ms: num(/50th percentile:\s*(\d+)ms/),
    p95Ms: num(/95th percentile:\s*(\d+)ms/),
    p99Ms: num(/99th percentile:\s*(\d+)ms/),
  };
}

export function parseThermal(text) {
  const m = text.match(/Thermal Status:\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

export function parseBattery(text) {
  const level = text.match(/^\s*level:\s*(\d+)/m);
  const temp = text.match(/^\s*temperature:\s*(\d+)/m);
  return { level: level ? Number(level[1]) : null, tempC: temp ? Number(temp[1]) / 10 : null };
}

export function evaluate({ gfx, thermalMax, batteryStart, batteryEnd, tempMax, seconds }, budget = BUDGET) {
  const failures = [];
  const jank = gfx.totalFrames > 0 ? gfx.jankyFrames / gfx.totalFrames : null;
  if (jank !== null && jank > budget.maxJankRatio) failures.push(`끊긴 프레임 ${(jank * 100).toFixed(1)}%`);
  if (thermalMax !== null && thermalMax > budget.maxThermalStatus) failures.push(`발열 상태 ${thermalMax}`);
  if (tempMax !== null && tempMax > budget.maxTempC) failures.push(`배터리 온도 ${tempMax}°C`);
  const drop = batteryStart !== null && batteryEnd !== null && seconds > 0 ? ((batteryStart - batteryEnd) / seconds) * 600 : null;
  if (drop !== null && drop > budget.maxBatteryDropPer10Min) failures.push(`10분당 배터리 ${drop.toFixed(1)}% 감소`);
  return { jankRatio: jank, batteryDropPer10Min: drop, pass: failures.length === 0, failures };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
  const pkg = value('--package', 'app.hilit.mobile');
  const seconds = Number(value('--seconds', '60'));
  const serial = value('--serial');
  const adb = (...a) => execFileSync(process.env.ADB ?? 'adb', [...(serial ? ['-s', serial] : []), 'shell', ...a], { encoding: 'utf8', maxBuffer: 1 << 26 });
  let isEmulator;
  try {
    isEmulator = adb('getprop', 'ro.kernel.qemu').trim() === '1';
  } catch (error) {
    console.error(`기기에 연결하지 못했습니다: ${error.message.split('\n')[0]}`);
    process.exit(2);
  }
  const model = adb('getprop', 'ro.product.model').trim();
  adb('dumpsys', 'gfxinfo', pkg, 'reset');
  const start = parseBattery(adb('dumpsys', 'battery'));
  let thermalMax = parseThermal(adb('dumpsys', 'thermalservice'));
  let tempMax = start.tempC;
  const began = Date.now();
  console.log(`${model}${isEmulator ? ' (에뮬레이터)' : ''} ${seconds}초 측정 중입니다. 앱에서 추적을 돌려 주세요.`);
  while (Date.now() - began < seconds * 1000) {
    await new Promise((r) => setTimeout(r, Math.min(5000, seconds * 1000)));
    const t = parseThermal(adb('dumpsys', 'thermalservice'));
    if (t !== null) thermalMax = Math.max(thermalMax ?? 0, t);
    const b = parseBattery(adb('dumpsys', 'battery'));
    if (b.tempC !== null) tempMax = Math.max(tempMax ?? 0, b.tempC);
  }
  const elapsed = (Date.now() - began) / 1000;
  const end = parseBattery(adb('dumpsys', 'battery'));
  const gfx = parseGfx(adb('dumpsys', 'gfxinfo', pkg));
  const verdict = evaluate({ gfx, thermalMax, batteryStart: start.level, batteryEnd: end.level, tempMax, seconds: elapsed });
  const report = { model, isEmulator, package: pkg, seconds: elapsed, gfx, thermalMax, tempMax, batteryStart: start.level, batteryEnd: end.level, budget: BUDGET, ...verdict };
  console.log(JSON.stringify(report, null, 2));
  const out = value('--out');
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  process.exit(verdict.pass ? 0 : 1);
}
