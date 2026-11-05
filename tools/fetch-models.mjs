#!/usr/bin/env node
// models/manifest.json 대로 모델을 받아 해시를 확인하고 캐시에 넣는다. 저장소에는 가중치를 두지 않는다.
//
//   node tools/fetch-models.mjs --list
//   node tools/fetch-models.mjs --id <모델> [--source <폴더|https://기준주소>] [--cache <폴더>]
//   node tools/fetch-models.mjs --all-public
//
// 비공개 모델은 저작권자에게 받은 위치를 --source 로 넘겨야 합니다. 받은 권한은 환경변수 HILIT_MODEL_TOKEN 으로 넘기며 출력하지 않습니다.
// 해시가 다르면 파일을 버리고 실패합니다. 임시 파일에 받은 뒤 확인이 끝나야 캐시로 옮기므로 끊겨도 깨진 파일이 남지 않습니다.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RETRIES = 3;

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

async function download(url, dest) {
  const token = process.env.HILIT_MODEL_TOKEN;
  let lastError;
  for (let attempt = 1; attempt <= RETRIES; attempt += 1) {
    try {
      const res = await fetch(url, { redirect: 'follow', headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error(`응답 ${res.status}`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  throw new Error(`받지 못했습니다(${RETRIES}회): ${lastError.message}`);
}

export async function fetchModel(model, { source, cache }) {
  mkdirSync(cache, { recursive: true });
  const target = path.join(cache, `${model.sha256.slice(0, 12)}-${model.file}`);
  if (existsSync(target) && sha256File(target) === model.sha256) return { id: model.id, path: target, status: '캐시 사용' };
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    if (source && !/^https?:/.test(source)) {
      copyFileSync(path.join(source, model.file), tmp);
    } else {
      const url = source ? `${source.replace(/\/$/, '')}/${model.file}` : model.url;
      if (!url) throw new Error(`${model.id} 는 비공개 모델입니다. 위치를 --source 로 넘겨 주세요. 사용 승인: ccw00325@gmail.com`);
      await download(url, tmp);
    }
    const actual = sha256File(tmp);
    if (actual !== model.sha256) throw new Error(`${model.id} 해시가 다릅니다. 기대 ${model.sha256.slice(0, 12)}, 실제 ${actual.slice(0, 12)}`);
    renameSync(tmp, target);
    return { id: model.id, path: target, status: '받음' };
  } finally {
    rmSync(tmp, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const manifest = JSON.parse(readFileSync(path.join(ROOT, 'models/manifest.json'), 'utf8'));
  if (args.includes('--list') || !args.length) {
    for (const m of manifest.models) console.log(`${m.distribution.padEnd(8)} ${m.id} ${m.bytes}B ${m.sha256.slice(0, 12)} ${m.license}`);
    process.exit(0);
  }
  const chosen = args.includes('--all-public') ? manifest.models.filter((m) => m.distribution === 'public') : manifest.models.filter((m) => m.id === value('--id'));
  if (!chosen.length) {
    console.error('받을 모델이 없습니다. --list 로 이름을 확인해 주세요.');
    process.exit(2);
  }
  const cache = value('--cache') ?? path.join(os.homedir(), '.cache', 'hilit-models');
  try {
    for (const m of chosen) {
      const r = await fetchModel(m, { source: value('--source'), cache });
      console.log(`${r.status}: ${r.id} → ${r.path}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
