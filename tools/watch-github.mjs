#!/usr/bin/env node
// GitHub 공개 코드와 이 저장소의 포크·별·조회 수를 살펴 새로 나타난 것을 알린다.
//
//   node tools/watch-github.mjs --state <상태 파일> [--term <검색어>]... [--quiet-names]
//
// 인증은 GITHUB_TOKEN 또는 설치된 gh 로그인을 쓴다. 권한이 없어 건너뛴 항목은 결과에 그대로 적는다.
// 새로 나타난 것이 있으면 exit 1 이다. 상태 파일은 이미 본 항목을 기억하므로 같은 것을 두 번 알리지 않는다.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const OWNER = 'ccw00325-spec';
const REPO = `${OWNER}/HILiT_Tracking_Tec`;
const TERMS = ['HILiT-PUB-2026', 'HILiT_Tracking_Tec', 'HilitDcfTrackerCore', 'LinkedNativeTracker', 'hilit-affine-gmc-v1', 'linked-v1 HILiT'];

const args = process.argv.slice(2);
function option(name) {
  const out = [];
  args.forEach((a, i) => { if (a === name) out.push(args[i + 1]); });
  return out;
}
const statePath = option('--state')[0];
if (!statePath) {
  console.error('--state <파일> 이 필요합니다.');
  process.exit(2);
}
const quietNames = args.includes('--quiet-names');
const terms = [...TERMS, ...option('--term')];

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
const auth = token();

async function api(url, accept = 'application/vnd.github+json') {
  const res = await fetch(`https://api.github.com/${url}`, {
    headers: { Accept: accept, 'User-Agent': 'hilit-watch', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
  });
  if (!res.ok) return { error: res.status };
  return { data: await res.json() };
}

const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { seen: {} };
const skipped = [];
const fresh = [];
function note(kind, key, detail) {
  const id = `${kind}:${key}`;
  if (state.seen[id]) return;
  state.seen[id] = new Date().toISOString();
  fresh.push({ kind, key, detail });
}

for (const term of terms) {
  const res = await api(`search/code?per_page=100&q=${encodeURIComponent(`"${term}" -user:${OWNER}`)}`);
  if (res.error) { skipped.push(`코드 검색 ${term}: ${res.error}`); continue; }
  for (const item of res.data.items ?? []) {
    note('코드', `${item.repository.full_name}/${item.path}`, `${term} ${item.html_url}`);
  }
  await new Promise((r) => setTimeout(r, 7000)); // 코드 검색은 분당 10회 제한이다.
}

const forks = await api(`repos/${REPO}/forks?per_page=100&sort=newest`);
if (forks.error) skipped.push(`포크: ${forks.error}`);
else for (const f of forks.data) note('포크', f.full_name, f.html_url);

const stars = await api(`repos/${REPO}/stargazers?per_page=100`);
if (stars.error) skipped.push(`별: ${stars.error}`);
else for (const s of stars.data) note('별', s.login, s.html_url);

const clones = await api(`repos/${REPO}/traffic/clones`);
const views = await api(`repos/${REPO}/traffic/views`);
const referrers = await api(`repos/${REPO}/traffic/popular/referrers`);
if (clones.error || views.error) skipped.push(`조회 통계: ${clones.error ?? views.error}`);
else {
  state.traffic = { at: new Date().toISOString(), clones: clones.data.count, clonesUnique: clones.data.uniques, views: views.data.count, viewsUnique: views.data.uniques };
  for (const c of clones.data.clones ?? []) if (c.count) note('복제일', c.timestamp.slice(0, 10), `${c.count}회, ${c.uniques}명`);
}
if (!referrers.error) for (const r of referrers.data) note('유입', r.referrer, `${r.count}회`);

mkdirSync(path.dirname(path.resolve(statePath)), { recursive: true });
writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

// 알릴 가치가 큰 것은 코드와 포크다. 별·복제일·유입은 기록만 하고 실패로 치지 않는다.
const alerts = fresh.filter((f) => f.kind === '코드' || f.kind === '포크');
console.log(`새 항목 ${fresh.length}건 (알림 ${alerts.length}건), 건너뜀 ${skipped.length}건`);
if (!quietNames) for (const f of fresh) console.log(`  [${f.kind}] ${f.key} — ${f.detail}`);
for (const s of skipped) console.log(`  건너뜀: ${s}`);
if (state.traffic) console.log(`  최근 14일: 복제 ${state.traffic.clones}회(${state.traffic.clonesUnique}명), 조회 ${state.traffic.views}회(${state.traffic.viewsUnique}명)`);
process.exit(alerts.length ? 1 : 0);
