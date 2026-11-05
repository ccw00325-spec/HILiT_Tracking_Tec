#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 저작자에게 받은 암호화 가중치 묶음을 풉니다. 비밀번호는 환경변수 HILIT_BUNDLE_PASS 로 넘기며 출력하지 않습니다.
//   node tools/open-weights-bundle.mjs <받은 파일> [--out <폴더>]
import { createDecipheriv, createHash, scryptSync } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAGIC = 'HILIT-WEIGHTS-1';

export function openBundle(raw, pass) {
  const headEnd = raw.indexOf(0x0a);
  const head = JSON.parse(raw.subarray(0, headEnd).toString('utf8'));
  if (head.magic !== MAGIC) throw new Error('가중치 묶음 파일이 아닙니다.');
  const key = scryptSync(pass, Buffer.from(head.salt, 'base64'), 32, { N: head.N, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(head.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(head.tag, 'base64'));
  let plain;
  try {
    plain = Buffer.concat([decipher.update(raw.subarray(headEnd + 1)), decipher.final()]);
  } catch {
    throw new Error('비밀번호가 틀렸거나 파일이 손상되었습니다.');
  }
  const body = JSON.parse(plain.toString('utf8'));
  for (const f of body.files) {
    const data = Buffer.from(f.data, 'base64');
    const sha = createHash('sha256').update(data).digest('hex');
    if (sha !== f.sha256) throw new Error(`${f.name} 해시가 다릅니다.`);
    f.bytes = data;
  }
  return body;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
  const pass = process.env.HILIT_BUNDLE_PASS;
  if (!file || !pass) {
    console.error('사용법: HILIT_BUNDLE_PASS=<비밀번호> node tools/open-weights-bundle.mjs <받은 파일> [--out <폴더>]');
    process.exit(2);
  }
  const i = args.indexOf('--out');
  const out = i >= 0 ? args[i + 1] : 'hilit-weights';
  try {
    const body = openBundle(readFileSync(file), pass);
    mkdirSync(out, { recursive: true });
    for (const f of body.files) {
      writeFileSync(path.join(out, path.basename(f.name)), f.bytes);
      console.log(`확인: ${f.name} ${f.sha256.slice(0, 12)}`);
    }
    console.log(`폴더: ${out}. 약정문(WEIGHTS_LICENSE.txt)을 먼저 읽어 주세요. 다시 나눠 줄 수 없습니다.`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
