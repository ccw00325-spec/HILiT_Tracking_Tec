#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1
// 데모를 이 PC 안에서만 여는 작은 서버입니다. 외부에서는 접속할 수 없고, 영상도 어디로 보내지 않습니다.
//   node tools/serve-demo.mjs [--port 4173]
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--port');
const PORT = i >= 0 ? Number(process.argv[i + 1]) : 4173;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.jpg': 'image/jpeg' };
const ALLOWED = /^\/(demo|runtime\/apps\/web\/public\/tracking|tools\/lib|assets)\//;

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  // 페이지의 상대 경로가 맞도록 첫 주소는 데모 폴더로 보낸다.
  if (rel === '/') { res.writeHead(302, { Location: `/demo/${url.search}` }).end(); return; }
  if (rel === '/demo/') rel = '/demo/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  if (!ALLOWED.test(rel) || !file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('찾을 수 없습니다');
    return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
});
server.listen(PORT, '127.0.0.1', () => console.log(`데모: http://127.0.0.1:${PORT}  (끄려면 Ctrl+C)`));
