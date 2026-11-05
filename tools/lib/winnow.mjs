// 코드 지문(winnowing). 주석·공백·지역 변수 이름을 버리고 숫자·문자열·속성 이름·연산자만 남겨 비교한다.
// 그래서 압축하거나 지역 변수 이름을 바꾼 사본에서도 같은 조각을 찾을 수 있다.

export const K = 16;
export const WINDOW = 32;

const OPS = new Set(['+', '-', '*', '/', '%', '<', '>', '<=', '>=', '==', '===', '!=', '!==', '&&', '||', '?', '**', '>>', '<<', '>>>']);
const TOKEN = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\b0[xX][0-9a-fA-F]+\b|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_$][\w$]*|>>>|===|!==|\*\*|<=|>=|==|!=|&&|\|\||>>|<<|[+\-*/%<>?.]/g;

export function coreTokens(source) {
  const out = [];
  let prev = '';
  for (const match of source.matchAll(TOKEN)) {
    const t = match[0];
    if (t.startsWith('/*') || t.startsWith('//')) continue;
    if (t === '.') { prev = '.'; continue; }
    const c = t[0];
    if (c === '"' || c === "'" || c === '`') {
      out.push(`s:${t.slice(1, -1)}`);
    } else if (/[0-9.]/.test(c)) {
      const n = Number(t);
      out.push(Number.isFinite(n) ? `n:${n}` : `n:${t}`);
    } else if (/[A-Za-z_$]/.test(c)) {
      // 점 뒤의 속성 이름은 압축해도 남는다. 지역 이름은 바뀌므로 버린다.
      if (prev === '.') out.push(`p:${t}`);
    } else if (OPS.has(t)) {
      out.push(t);
    }
    prev = t;
  }
  return out;
}

function fnv1a(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function winnow(source, k = K, w = WINDOW) {
  const tokens = coreTokens(source);
  if (tokens.length < k) return [];
  const grams = [];
  for (let i = 0; i + k <= tokens.length; i += 1) grams.push(fnv1a(tokens.slice(i, i + k).join('\u0001')));
  const picked = new Set();
  let last = -1;
  for (let i = 0; i + w <= grams.length; i += 1) {
    let min = i;
    for (let j = i + 1; j < i + w; j += 1) if (grams[j] <= grams[min]) min = j;
    if (min !== last) { picked.add(grams[min]); last = min; }
  }
  if (grams.length < w && grams.length) picked.add(Math.min(...grams));
  return [...picked];
}
