// 공개 사본의 파일 표시. 지문은 저장소 고유값과 파일 경로로 정해지므로 파일마다 다르고 다시 계산해 대조할 수 있다.
import { createHash } from 'node:crypto';

export const PROJECT = 'HILiT Tracking Tec';
export const REPO_URL = 'https://github.com/ccw00325-spec/HILiT_Tracking_Tec';
export const CONTACT = 'ccw00325@gmail.com';
export const MARK = 'HILiT-PUB-2026·CW·7b1e94c2a06fd358';

export function fileFingerprint(relPath) {
  const id = createHash('sha256').update(`${MARK}|${relPath}`).digest('hex').slice(0, 8);
  return `${MARK}·${id}`;
}

export function header(relPath) {
  return `/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — ${PROJECT} — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ${CONTACT}. `
    + `Credit "${PROJECT}", the author, and ${REPO_URL} when you use, publish, or host this. See LICENSE and NOTICE. `
    + `${fileFingerprint(relPath)} @license @preserve */\n`;
}

const OLD_HEAD = /^﻿?\s*\/\*[\s\S]*?\*\/[ \t]*\r?\n?/;

export function stampSource(relPath, text) {
  const match = text.match(OLD_HEAD);
  let body = text;
  // 첫 주석이 예전 소유권 표시일 때만 걷어 낸다. 설명 주석은 그대로 둔다.
  if (match && /HILiT-OWN-2026|HILiT Proprietary|조찬우/.test(match[0])) body = text.slice(match[0].length);
  return header(relPath) + body;
}

export function isStampable(relPath) {
  return /\.(ts|tsx|js|mjs|java)$/.test(relPath);
}
