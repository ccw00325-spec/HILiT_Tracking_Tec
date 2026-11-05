/*! SPDX-License-Identifier: LicenseRef-HILiT-NCA-1.1 — HILiT Tracking Tec — © 2026 조찬우 (Chanwoo Cho). Noncommercial use only; commercial use requires prior written approval: ccw00325@gmail.com. Credit "HILiT Tracking Tec", the author, and https://github.com/ccw00325-spec/HILiT_Tracking_Tec when you use, publish, or host this. See LICENSE and NOTICE. HILiT-PUB-2026·CW·7b1e94c2a06fd358·910175b7 @license @preserve */
/* 확대된 화면의 화질 개선.
 *
 * 왜 필요한가
 * ----------
 * 대상을 크게 보여주려면 잘라서 늘려야 하고, 늘리면 화질이 떨어진다.
 * 1080p 영상에서 멀리 있는 사람을 크게 잡으면 crop 이 341px 까지
 * 내려가고, 그걸 720p 로 늘리면 실질 340p 다.
 *
 * 카메라 쪽에서 배율 상한(maxUpscale)으로 하한선을 두지만, 크게 보고
 * 싶다는 요구가 있는 한 확대는 남는다. 그 남은 손실을 줄인다.
 *
 * 무엇을 쓰지 않았나 — 그리고 왜
 * -------------------------------
 * 초해상도(super-resolution) 모델을 먼저 검토했다.
 *
 *   Real-ESRGAN   품질은 가장 좋다. 그런데 가중치가 60MB 를 넘고
 *                 브라우저 WASM 에서 프레임당 수 초가 걸린다. 영상에는
 *                 쓸 수 없다.
 *   FSRCNN/ESPCN  훨씬 가볍다(수만 파라미터). 그래도 720p 한 장에
 *                 수십~수백 ms 다. 30fps 로 내보내려면 프레임당 33ms
 *                 안에 끝나야 하는데 여유가 없다.
 *
 * 이미 NanoTrack·OSNet·NanoDet 세 모델이 CPU 를 쓰고 있다. 여기에
 * SR 모델을 더하면 추적이 느려진다. 화질을 얻고 추적을 잃는 교환은
 * 하지 않는다.
 *
 * 무엇을 썼나
 * -----------
 * GPU 셰이더 한 장으로 끝나는 것들만 골랐다. WebGL 프래그먼트 셰이더는
 * 720p 한 장을 1ms 안에 처리한다.
 *
 *   1. Catmull-Rom 보간
 *      브라우저 기본 확대는 이중선형(bilinear)이라 늘리면 뭉갠다.
 *      Catmull-Rom 은 4x4 이웃을 쓰는 3차 보간이라 가장자리가 살아 있다.
 *
 *   2. CAS (Contrast Adaptive Sharpening)
 *      AMD FidelityFX 의 공개 알고리즘. MIT 라이선스로 풀려 있다.
 *      https://github.com/GPUOpen-Effects/FidelityFX-CAS
 *      아래 셰이더의 CAS 부분은 그 식(mnRGB·mxRGB·rcpM·amp·peak·rcpW)을 옮겨 쓴 것이다.
 *      Copyright (c) 2020 Advanced Micro Devices, Inc. MIT License — 전문은
 *      docs/licenses/notices/amd-fidelityfx-cas-LICENSE.txt, 사용자 고지는 /licenses/THIRD_PARTY_NOTICES.txt.
 *
 *      일반 언샤프 마스크는 이미 선명한 곳까지 과하게 깎아 링잉을 만든다.
 *      CAS 는 국소 대비를 보고 **평평한 곳은 세게, 이미 대비가 큰 곳은
 *      약하게** 건다. 확대로 뭉개진 화면에 정확히 맞는 성질이다.
 *
 *   3. 노이즈 억제는 하지 않는다
 *      확대된 화면의 노이즈는 원본에 있던 것이 커진 것이다. 지우면
 *      질감까지 사라져 오히려 플라스틱처럼 보인다.
 *
 * 한계는 분명히 해둔다: 이건 **없는 정보를 만들어내지 않는다.** 있는
 * 정보를 또렷하게 보여줄 뿐이다. 340p 를 1080p 로 되살리는 기술이 아니다.
 */

import { HDR_TONEMAP_GLSL, probeHdrTransfer, rawHdrUploadKnown, type HdrTransfer } from './hdr-tonemap';

export type EnhanceLevel = 'off' | 'light' | 'strong';

/**
 * 색 보정 — 사용자가 손으로 맞추는 값들.
 *
 * ## 왜 캔버스 filter 가 아니라 셰이더인가
 *
 * 2D 캔버스의 `ctx.filter` 는 brightness·contrast·saturate·hue-rotate 까지다.
 * **하이라이트·그림자·색온도·틴트·명료도는 표현할 수 없다.** 그것들을
 * 빼거나 흉내만 내면 화면의 손잡이가 실제로 하는 일과 달라진다 —
 * "그림자만 올렸는데 전체가 밝아진다" 같은 일이 그렇게 생긴다.
 *
 * 이미 CAS 셰이더가 프레임마다 돌고 있다. 같은 패스에 색 보정을 얹으면
 * 텍스처를 한 번 더 오갈 필요가 없고, 미리보기와 내보내기가 **한 식**을
 * 쓰게 된다 — 본 것과 저장된 것이 다르지 않다.
 *
 * ## 값의 범위
 *
 * 명시한 것 말고는 전부 -1 ~ +1 이고 0 이 원본이다. 사용자에게는 -100 ~
 * +100 으로 보여주고 화면에서 나눈다 — 슬라이더 눈금이 정수여야 손이
 * 멈추는 자리가 생긴다.
 */
export interface ColorGrade {
  /** 밝기. 전 구간을 같은 양만큼 올리고 내린다. */
  brightness: number;
  /** 노출. 밝기와 달리 곱셈이라 밝은 곳이 더 크게 움직인다(카메라의 스톱). */
  exposure: number;
  /** 대비. 가운데 밝기를 축으로 벌리고 좁힌다. */
  contrast: number;
  /** 하이라이트. 밝은 쪽만 건드린다 — 하늘·조명이 날아간 곳을 되살릴 때. */
  highlights: number;
  /** 그림자. 어두운 쪽만 건드린다 — 역광에서 얼굴이 묻힐 때. */
  shadows: number;
  /** 채도. 색의 진하기. -1 이면 흑백이다. */
  saturation: number;
  /** 색온도. + 가 따뜻하고(주황) - 가 차갑다(파랑). */
  temperature: number;
  /** 틴트. + 가 자주빛, - 가 초록빛. 형광등 아래 초록기를 뺄 때 쓴다. */
  tint: number;
  /** 선명도. CAS 세기를 사용자가 직접 정한다. 0~1 이고 음수가 없다. */
  sharpness: number;
  /** 명료도. 국소 대비 — 윤곽 주변만 벌려서 "또렷한" 느낌을 만든다. */
  clarity: number;
}

export const NEUTRAL_GRADE: ColorGrade = {
  brightness: 0, exposure: 0, contrast: 0, highlights: 0, shadows: 0,
  saturation: 0, temperature: 0, tint: 0, sharpness: 0, clarity: 0,
};

/** 손댄 것이 하나도 없는가. 없으면 셰이더를 건너뛴다 — 공짜가 아니다. */
export function isNeutralGrade(g: ColorGrade | undefined | null): boolean {
  if (!g) return true;
  return (Object.keys(NEUTRAL_GRADE) as Array<keyof ColorGrade>)
    .every((k) => Math.abs(g[k]) < 1e-3);
}

/* Y 를 뒤집어서 샘플링한다.
 *
 * WebGL 과 2D 캔버스는 세로 방향이 반대다.
 *   클립 공간  y = +1  -> 화면 위쪽
 *   텍스처     v =  0  -> 이미지 위쪽   (texImage2D 는 첫 행을 v=0 에 둔다)
 *
 * 그래서 `vUv = aPos * 0.5 + 0.5` 로 두면 화면 위쪽(y=+1)이 v=1 을 읽어
 * 이미지 아래쪽을 가져온다 — 결과가 위아래로 뒤집힌다.
 *
 * 실제로 그랬다. 위 절반 빨강 / 아래 절반 파랑을 넣으면 위 파랑 / 아래
 * 빨강이 나왔다. 미리보기와 내보내기가 같은 코드를 쓰므로 저장된 영상도
 * 뒤집혀 있었다.
 *
 * UNPACK_FLIP_Y_WEBGL 로도 되지만 그건 업로드할 때마다 뒤집는다.
 * 여기서는 정점 3개의 UV 만 한 번 계산하면 끝이라 이쪽이 싸다. */
const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x, -aPos.y) * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/* Catmull-Rom 확대 + CAS 샤프닝.
 *
 * 두 단계를 한 셰이더에 넣었다. 텍스처를 두 번 오가면 대역폭만 쓴다. */
const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uTexel;      // 1 / 입력 크기
uniform float uSharp;     // 0 ~ 1
uniform float uUpscale;   // 확대 배율. 1 이면 보간을 건너뛴다

/* 색 보정. 전부 -1 ~ +1 이고 0 이 원본이다(uSharpen 만 0~1).
 * vec4 로 묶어 uniform 개수를 줄인다 — WebGL1 은 그 수에 상한이 있다. */
uniform vec4 uGradeA;     // x 밝기 · y 노출 · z 대비 · w 채도
uniform vec4 uGradeB;     // x 하이라이트 · y 그림자 · z 색온도 · w 틴트
uniform float uClarity;   // 명료도

/*SAMPLE*/

/* Catmull-Rom 가중치. 3차 보간이라 이중선형보다 가장자리가 산다. */
vec4 cubic(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x;
  float y = s.y - 4.0 * s.x;
  float z = s.z - 4.0 * s.y + 6.0 * s.x;
  float w = 6.0 - x - y - z;
  return vec4(x, y, z, w) * (1.0 / 6.0);
}

vec4 bicubic(vec2 uv) {
  vec2 texSize = 1.0 / uTexel;
  vec2 coord = uv * texSize - 0.5;
  vec2 f = fract(coord);
  coord -= f;

  vec4 xc = cubic(f.x);
  vec4 yc = cubic(f.y);
  vec4 c = coord.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 o = (c + vec4(xc.yw, yc.yw) / s) * uTexel.xxyy;

  vec4 a = sampleTex(o.yw);
  vec4 b = sampleTex(o.xw);
  vec4 cc = sampleTex(o.yz);
  vec4 d = sampleTex(o.xz);

  float mx = s.x / (s.x + s.y);
  float my = s.z / (s.z + s.w);
  return mix(mix(a, b, mx), mix(cc, d, mx), my);
}

/* 밝기 가중치.
 *
 * Rec.709 휘도다. 단순 평균((r+g+b)/3)을 쓰면 초록이 실제보다 어둡게
 * 취급돼서, 채도를 낮췄을 때 잔디밭이 회색으로 푹 꺼진다. */
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

/* 색 보정.
 *
 * 순서가 중요하다. 노출·밝기로 밝기를 정하고 -> 밝은 곳/어두운 곳을
 * 따로 손보고 -> 대비로 벌린 다음 -> 색(온도·틴트·채도)을 만진다.
 * 채도를 먼저 올리면 그다음 대비에서 색이 함께 튀어 넘친다.
 *
 * blurC 는 CAS 가 이미 읽은 십자 이웃의 평균이다 — 명료도를 위해 따로
 * 흐린 이미지를 만들 필요가 없다. */
vec3 grade(vec3 c, vec3 blurC) {
  /* 노출은 스톱이다. 곱셈이라 밝은 곳이 더 크게 움직인다 — 카메라의
   * 노출 보정과 같은 성질이고, 그래서 밝기와 따로 둘 값어치가 있다. */
  c *= pow(2.0, uGradeA.y * 1.2);
  // 밝기는 덧셈. 전 구간이 같은 양만큼 움직인다.
  c += uGradeA.x * 0.18;

  /* 하이라이트·그림자.
   *
   * 밝기에 따라 가중치를 다르게 준다. smoothstep 으로 부드럽게 갈라야
   * 경계에서 띠가 생기지 않는다 — 딱 잘라 나누면 얼굴 옆에 선이 보인다. */
  float l = luma(c);
  float hi = smoothstep(0.45, 1.0, l);
  float sh = 1.0 - smoothstep(0.0, 0.55, l);
  c += uGradeB.x * 0.28 * hi;
  c += uGradeB.y * 0.28 * sh;

  // 대비. 가운데 밝기를 축으로 벌리고 좁힌다.
  c = (c - 0.5) * (1.0 + uGradeA.z * 0.6) + 0.5;

  /* 색온도 — 빨강과 파랑을 반대로 움직인다. 초록은 그대로 두어야
   * 피부색이 돌지 않는다. */
  c.r += uGradeB.z * 0.10;
  c.b -= uGradeB.z * 0.10;

  /* 틴트 — 초록↔자주. 초록을 내리면서 빨강·파랑을 절반씩 올려야
   * 전체 밝기가 유지된다. */
  c.g -= uGradeB.w * 0.08;
  c.r += uGradeB.w * 0.04;
  c.b += uGradeB.w * 0.04;

  // 채도. -1 이면 완전한 흑백이다.
  c = mix(vec3(luma(c)), c, 1.0 + uGradeA.w);

  /* 명료도 — 국소 대비.
   *
   * 원본에서 흐린 것을 빼면 윤곽만 남는다. 그걸 더하면 또렷해지고
   * 빼면 부드러워진다. 선명도(CAS)와 다른 점: CAS 는 화소 단위 가장자리를
   * 세우고, 이건 더 넓은 덩어리의 명암을 벌린다. */
  c += (c - blurC) * uClarity * 1.6;

  return clamp(c, 0.0, 1.0);
}

void main() {
  vec3 base = (uUpscale > 1.02 ? bicubic(vUv) : sampleTex(vUv)).rgb;

  /* 십자 이웃. CAS 와 명료도가 함께 쓴다 — 한 번만 읽는다. */
  vec3 up = sampleTex(vUv + vec2(0.0, -uTexel.y)).rgb;
  vec3 dn = sampleTex(vUv + vec2(0.0,  uTexel.y)).rgb;
  vec3 lf = sampleTex(vUv + vec2(-uTexel.x, 0.0)).rgb;
  vec3 rt = sampleTex(vUv + vec2( uTexel.x, 0.0)).rgb;
  vec3 blurC = (up + dn + lf + rt) * 0.25;

  vec3 result = base;

  if (uSharp > 0.001) {
    /* CAS.
     * 십자 이웃 4개의 최소·최대를 본다. 국소 대비가 낮으면(평평하면)
     * 세게, 이미 대비가 크면 약하게 건다. 그래서 링잉이 안 생긴다. */
    vec3 mnRGB = min(min(min(up, dn), min(lf, rt)), base);
    vec3 mxRGB = max(max(max(up, dn), max(lf, rt)), base);

    vec3 rcpM = 1.0 / max(mxRGB, vec3(1.0 / 255.0));
    vec3 amp = clamp(min(mnRGB, 2.0 - mxRGB) * rcpM, 0.0, 1.0);
    amp = sqrt(amp);

    // uSharp 0~1 을 CAS 의 peak 범위로 옮긴다.
    float peak = -1.0 / mix(8.0, 5.0, clamp(uSharp, 0.0, 1.0));
    vec3 w = amp * peak;
    vec3 rcpW = 1.0 / (1.0 + 4.0 * w);

    vec3 sharpened = clamp((base + (up + dn + lf + rt) * w) * rcpW, 0.0, 1.0);
    result = mix(base, sharpened, clamp(uSharp, 0.0, 1.0));
  }

  gl_FragColor = vec4(grade(result, blurC), 1.0);
}`;

/* SDR: 잘라 둔 중간 캔버스를 그대로 읽는다. HDR 경로가 생기기 전과 같은 식이다. */
const SDR_SAMPLE = `vec4 sampleTex(vec2 uv) { return texture2D(uTex, uv); }`;

/* HDR: 원본 프레임을 통째로 부동소수점 텍스처에 올리고, uCrop 으로 잘라 읽으며
 * 한 화소씩 톤매핑한다. 2D 캔버스로 먼저 자르면 브라우저가 그 자리에서 색을 바꿔
 * 버리므로(어둡고 누렇게) 중간 캔버스를 거치지 않는다. 보간·샤프닝·색 보정은
 * 모두 톤매핑이 끝난 SDR 값 위에서 돈다 — SDR 영상과 같은 손잡이가 같은 일을 한다.
 * uHdrTransfer 가 0 이면 원본 신호를 그대로 낸다(자가 점검용). */
const HDR_SAMPLE = `${HDR_TONEMAP_GLSL}
uniform vec4 uCrop;
vec4 sampleTex(vec2 uv) {
  vec3 s = texture2D(uTex, uCrop.xy + uv * uCrop.zw).rgb;
  return vec4(uHdrTransfer == 0 ? s : hdrToneMap(s), 1.0);
}`;

const fragWith = (sample: string) => FRAG.replace('/*SAMPLE*/', sample);


const SHARPNESS: Record<EnhanceLevel, number> = {
  off: 0,
  light: 0.45,
  strong: 0.85,
};

/** 확대된 프레임을 또렷하게 만든다. GPU 가 없으면 조용히 원본을 그린다. */
type Uniforms = Record<string, WebGLUniformLocation | null>;

/** 셰이더 한 벌과 그 캔버스. SDR 은 WebGL1, HDR 은 부동소수점 텍스처가 필요해 WebGL2 다. */
class ShaderPass {
  gl: WebGLRenderingContext | WebGL2RenderingContext | null = null;
  canvas: HTMLCanvasElement | null = null;
  tex: WebGLTexture | null = null;
  loc: Uniforms = {};
  failed = false;
  private program: WebGLProgram | null = null;

  constructor(private readonly kind: 'webgl' | 'webgl2', private readonly frag: string,
              private readonly names: readonly string[]) {}

  ensure(width: number, height: number): boolean {
    if (this.failed) return false;
    if (this.gl && this.canvas
        && this.canvas.width === width && this.canvas.height === height) return true;

    try {
      if (!this.canvas) this.canvas = document.createElement('canvas');
      this.canvas.width = width;
      this.canvas.height = height;
      if (!this.gl) {
        const attrs = { premultipliedAlpha: false, antialias: false };
        this.gl = (this.kind === 'webgl2'
          ? this.canvas.getContext('webgl2', attrs)
          : (this.canvas.getContext('webgl', attrs)
            || this.canvas.getContext('experimental-webgl'))) as WebGLRenderingContext | null;
      }
      const gl = this.gl;
      if (!gl) { this.failed = true; return false; }

      if (!this.program) {
        const compile = (type: number, src: string) => {
          const sh = gl.createShader(type)!;
          gl.shaderSource(sh, src);
          gl.compileShader(sh);
          if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(sh) || '셰이더 컴파일 실패');
          }
          return sh;
        };
        const prog = gl.createProgram()!;
        gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
        gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, this.frag));
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
          throw new Error(gl.getProgramInfoLog(prog) || '셰이더 링크 실패');
        }
        this.program = prog;
        gl.useProgram(prog);

        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER,
          new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
        const aPos = gl.getAttribLocation(prog, 'aPos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        this.loc = Object.fromEntries(this.names.map((n) => [n, gl.getUniformLocation(prog, n)]));

        this.tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      }
      gl.viewport(0, 0, width, height);
      return true;
    } catch {
      this.failed = true;
      return false;
    }
  }

  /** 공통 uniform 을 넣고 그린다. 텍스처는 호출부가 이미 올려 두었다. */
  draw(texelW: number, texelH: number, sharp: number, upscale: number, g: ColorGrade) {
    const gl = this.gl!;
    gl.uniform1i(this.loc.uTex!, 0);
    gl.uniform2f(this.loc.uTexel!, texelW, texelH);
    gl.uniform1f(this.loc.uSharp!, sharp);
    gl.uniform1f(this.loc.uUpscale!, upscale);
    gl.uniform4f(this.loc.uGradeA!, g.brightness, g.exposure, g.contrast, g.saturation);
    gl.uniform4f(this.loc.uGradeB!, g.highlights, g.shadows, g.temperature, g.tint);
    gl.uniform1f(this.loc.uClarity!, g.clarity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  dispose() { this.gl = null; this.canvas = null; this.program = null; this.tex = null; }
}

const BASE_UNIFORMS = ['uTex', 'uTexel', 'uSharp', 'uUpscale', 'uGradeA', 'uGradeB', 'uClarity'] as const;
const HDR_UNIFORMS = [...BASE_UNIFORMS, 'uCrop', 'uHdrTransfer'] as const;

/**
 * 이 영상에 우리 톤매핑을 거는가. 영상 주소마다 한 번 정해 모듈 전체가 나눠 쓴다 —
 * 미리보기·저장·화면 알림이 같은 판단을 하도록.
 */
export interface HdrPlan {
  /** 원본이 HDR 이면 그 방식, 아니면 null. */
  transfer: HdrTransfer | null;
  /** 우리 톤매핑이 켜졌는가. false 면 브라우저 변환 그대로다(어둡거나 누렇게 보일 수 있다). */
  toneMapped: boolean;
}

const hdrPlans = new Map<string, HdrPlan>();
/** 「아직 모름」을 몇 번 받았나(영상 주소마다). 30fps 로 약 4초. */
const hdrProbeTries = new Map<string, number>();
const HDR_PROBE_LIMIT = 120;
let probePass: ShaderPass | null = null;

/** 부동소수점 텍스처로 원본 프레임을 올린다. 실패하면 false. */
function uploadHdr(gl: WebGL2RenderingContext, tex: WebGLTexture | null, video: HTMLVideoElement): boolean {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, video);
  return gl.getError() === gl.NO_ERROR;
}

/**
 * 자가 점검 — WebGL 이 정말 원본 신호를 넘기는가.
 *
 * 같은 프레임을 (가) 원본 신호 그대로 작은 판에 그린 것과 (나) 2D 캔버스(브라우저 변환)에
 * 그린 것의 채널 평균을 비교한다. 원본 신호라면 HLG·PQ 곡선 차이만큼 벌어진다(실측 15~20,
 * 0~255 기준). 거의 같으면 이 브라우저는 WebGL 에서도 이미 바꿔서 넘긴 것이고, 그 위에
 * 톤매핑을 또 걸면 두 번 바뀐다 — 그때는 켜지 않는다.
 */
function selfCheckRawUpload(video: HTMLVideoElement): boolean {
  const W = 64, H = 36;
  if (!probePass) probePass = new ShaderPass('webgl2', fragWith(HDR_SAMPLE), HDR_UNIFORMS);
  if (!probePass.ensure(W, H)) return false;
  const gl = probePass.gl as WebGL2RenderingContext;
  if (!uploadHdr(gl, probePass.tex, video)) return false;
  gl.uniform4f(probePass.loc.uCrop!, 0, 0, 1, 1);
  gl.uniform1i(probePass.loc.uHdrTransfer!, 0);
  probePass.draw(1 / video.videoWidth, 1 / video.videoHeight, 0, 1, NEUTRAL_GRADE);
  const raw = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, raw);

  const flat = document.createElement('canvas'); flat.width = W; flat.height = H;
  const ctx = flat.getContext('2d', { willReadFrequently: true });
  if (!ctx) return false;
  ctx.drawImage(video, 0, 0, W, H);
  const shown = ctx.getImageData(0, 0, W, H).data;

  let diff = 0;
  for (let k = 0; k < 3; k += 1) {
    let a = 0, b = 0;
    for (let i = k; i < raw.length; i += 4) { a += raw[i]; b += shown[i]; }
    diff += Math.abs(a - b) / (W * H);
  }
  return diff > 4;
}

/**
 * 영상의 HDR 판단. 처음 한 번은 감지·자가 점검을 하고, 그 뒤로는 같은 답을 돌려준다.
 * 아직 프레임이 없으면 null — 다음 프레임에 다시 묻는다.
 */
export function hdrPlanFor(video: HTMLVideoElement): HdrPlan | null {
  const key = video.currentSrc || video.src;
  if (!key) return null;
  const known = hdrPlans.get(key);
  if (known) return known;
  if (video.readyState < 2 || !video.videoWidth) return null;
  /* 아직 모르면 기억하지 않고 다음 프레임에 다시 묻는다(probeHdrTransfer 주석 — 첫 프레임 전의 오류를
   * 「SDR」로 굳히면 HDR 영상의 색이 여는 때마다 달라졌다). 그래도 끝내 모르면(예: 프레임을 못 읽는 영상)
   * HDR_PROBE_LIMIT 번 뒤에 예전처럼 SDR 로 정한다 — 매 프레임 묻는 비용을 끝없이 내지 않는다. */
  const probe = probeHdrTransfer(video);
  if (probe === 'unknown') {
    const tries = (hdrProbeTries.get(key) ?? 0) + 1;
    hdrProbeTries.set(key, tries);
    if (tries < HDR_PROBE_LIMIT) return null;
  }
  hdrProbeTries.delete(key);
  const transfer = probe === 'hlg' || probe === 'pq' ? probe : null;
  let plan: HdrPlan;
  if (!transfer) plan = { transfer: null, toneMapped: false };
  else {
    let ok = false;
    try { ok = rawHdrUploadKnown() && selfCheckRawUpload(video); } catch { ok = false; }
    plan = { transfer, toneMapped: ok };
  }
  hdrPlans.set(key, plan);
  return plan;
}

/** 확대된 프레임을 또렷하게 만든다. GPU 가 없으면 조용히 원본을 그린다. */
export class FrameEnhancer {
  private readonly sdr = new ShaderPass('webgl', fragWith(SDR_SAMPLE), BASE_UNIFORMS);
  private readonly hdr = new ShaderPass('webgl2', fragWith(HDR_SAMPLE), HDR_UNIFORMS);

  get available() { return !this.sdr.failed; }

  /* 잘라낸 영역을 출력 크기로 그린다.
   * 성공하면 결과 캔버스를 돌려주고, 실패하면 null 을 돌려준다.
   * null 이면 호출부가 평소대로 drawImage 를 쓰면 된다. */
  render(
    source: CanvasImageSource,
    crop: { sx: number; sy: number; sw: number; sh: number },
    outWidth: number, outHeight: number,
    level: EnhanceLevel,
    /**
     * 색 보정. 없거나 전부 0 이면 색은 건드리지 않는다.
     *
     * `sharpness` 를 만졌으면 그 값이 `level` 을 이긴다 — 사용자가 직접
     * 정한 값이 프리셋보다 우선한다. 두 손잡이를 화면에 함께 두지 않는
     * 것도 같은 이유다(5단계는 슬라이더 하나만 보여준다).
     */
    grade?: ColorGrade,
  ): HTMLCanvasElement | null {
    const g = grade ?? NEUTRAL_GRADE;
    const sharp = g.sharpness > 1e-3 ? g.sharpness : SHARPNESS[level];

    /* HDR 영상은 손댈 것이 없어도 반드시 셰이더를 거친다 — 톤매핑이 그 일이다.
     * 우리 톤매핑을 못 거는 브라우저면 아래 SDR 경로(브라우저 변환)로 내려간다. */
    if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) {
      const plan = hdrPlanFor(source);
      if (plan?.transfer && plan.toneMapped) {
        const out = this.renderHdr(source, crop, outWidth, outHeight, sharp, g, plan.transfer);
        if (out) return out;
      }
    }

    /* 할 일이 없으면 GPU 를 깨우지 않는다. 호출부가 평소대로 drawImage 를
     * 쓰면 되고, 그게 더 싸다. */
    if (sharp <= 1e-3 && isNeutralGrade(grade)) return null;
    if (!this.sdr.ensure(outWidth, outHeight)) return null;
    const gl = this.sdr.gl!;

    /* 잘라내기를 먼저 2D 캔버스에서 한다. WebGL 텍스처 업로드는 전체
     * 이미지를 올리므로, crop 을 셰이더에서 UV 로 처리하면 필요 없는
     * 영역까지 올리게 된다. 작은 중간 캔버스가 더 싸다. */
    const stage = this.stage(Math.round(crop.sw), Math.round(crop.sh));
    if (!stage) return null;
    stage.ctx.drawImage(source as CanvasImageSource,
      crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, stage.canvas.width, stage.canvas.height);

    gl.bindTexture(gl.TEXTURE_2D, this.sdr.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, stage.canvas);
    this.sdr.draw(1 / stage.canvas.width, 1 / stage.canvas.height, sharp,
      outHeight / Math.max(1, stage.canvas.height), g);
    return this.sdr.canvas;
  }

  /** HDR 원본을 톤매핑해 그린다. 실패하면 null(호출부는 SDR 경로로 내려간다). */
  private renderHdr(
    video: HTMLVideoElement,
    crop: { sx: number; sy: number; sw: number; sh: number },
    outWidth: number, outHeight: number,
    sharp: number, g: ColorGrade, transfer: HdrTransfer,
  ): HTMLCanvasElement | null {
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || crop.sw < 2 || crop.sh < 2) return null;
    if (!this.hdr.ensure(outWidth, outHeight)) return null;
    const gl = this.hdr.gl as WebGL2RenderingContext;
    if (!uploadHdr(gl, this.hdr.tex, video)) { this.hdr.failed = true; return null; }
    gl.uniform4f(this.hdr.loc.uCrop!, crop.sx / vw, crop.sy / vh, crop.sw / vw, crop.sh / vh);
    gl.uniform1i(this.hdr.loc.uHdrTransfer!, transfer === 'pq' ? 2 : 1);
    /* 보간 격자는 잘라낸 영역의 화소 단위다 — SDR 경로의 중간 캔버스와 같은 크기. */
    this.hdr.draw(1 / crop.sw, 1 / crop.sh, sharp, outHeight / Math.max(1, crop.sh), g);
    return this.hdr.canvas;
  }

  private stageCanvas: HTMLCanvasElement | null = null;
  private stageCtx: CanvasRenderingContext2D | null = null;
  private stage(w: number, h: number) {
    if (w < 2 || h < 2) return null;
    if (!this.stageCanvas) {
      this.stageCanvas = document.createElement('canvas');
      this.stageCtx = this.stageCanvas.getContext('2d', { willReadFrequently: false });
    }
    if (!this.stageCtx) return null;
    if (this.stageCanvas.width !== w || this.stageCanvas.height !== h) {
      this.stageCanvas.width = w; this.stageCanvas.height = h;
    }
    return { canvas: this.stageCanvas, ctx: this.stageCtx };
  }

  dispose() {
    this.sdr.dispose(); this.hdr.dispose();
    this.stageCanvas = null; this.stageCtx = null;
  }
}


/** 지금 배율에서 개선이 의미 있는지. 확대가 없으면 굳이 걸 이유가 없다. */
export function suggestEnhance(upscale: number): EnhanceLevel {
  if (upscale < 1.05) return 'off';
  if (upscale < 1.5) return 'light';
  return 'strong';
}
