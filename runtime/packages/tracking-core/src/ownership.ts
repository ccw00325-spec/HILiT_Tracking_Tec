/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·f7bd0305 @license @preserve */
/**
 * 소유권·출처 표시. 번들러가 남기는 상수이며 동작에 쓰이지 않는다. 지우거나 바꾸면 LICENSE 4항 위반이다.
 */
export const OWNERSHIP = Object.freeze({
  product: 'HILiT Tracking Tec',
  holder: '조찬우 (Chanwoo Cho)',
  copyright: '© 2026 조찬우 (Chanwoo Cho)',
  notice: 'Noncommercial use only. Commercial use requires prior written approval: ccw00325@gmail.com',
  canonical: 'https://github.com/ccw00325-spec/HILiT_Tracking_Tec',
  fingerprint: 'HILiT-PUB-2026·CW·7b1e94c2a06fd358·f7bd0305',
} as const);

export type Ownership = typeof OWNERSHIP;
