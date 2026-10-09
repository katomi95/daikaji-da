// 軽量パーティクル：インスタンス化した四角形をビュー空間でビルボード化する。
// gl_PointSize を使わないので、XR の左右の目でも大きさ（メートル単位）が正しく出る。
import * as THREE from '../vendor/three.module.min.js';

const VERT = /* glsl */`
attribute vec3 iPos;
attribute float iSize;
attribute vec4 iCol;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vUv = uv;
  vCol = iCol;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  mv.xy += position.xy * iSize;
  gl_Position = projectionMatrix * mv;
}`;

// 出力は乗算済みアルファ。glow=1 で完全な加算、0 で通常の半透明。
const FRAG = /* glsl */`
uniform float uGlow;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float a = vCol.a * smoothstep(1.0, 0.15, d);
  if (a < 0.004) discard;
  gl_FragColor = vec4(vCol.rgb * a, a * (1.0 - uGlow));
}`;

export class Particles {
  constructor(max, { glow = 0 } = {}) {
    this.max = max;
    this.count = 0;
    // CPU側の状態（構造体配列ではなく型付き配列で持つ）
    this.pos = new Float32Array(max * 3);
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.kind = new Uint8Array(max);

    const base = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.index = base.index;
    geo.setAttribute('position', base.getAttribute('position'));
    geo.setAttribute('uv', base.getAttribute('uv'));
    this.aPos = new THREE.InstancedBufferAttribute(new Float32Array(max * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iPos', this.aPos);
    geo.setAttribute('iSize', this.aSize);
    geo.setAttribute('iCol', this.aCol);
    geo.instanceCount = 0;

    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uGlow: { value: glow } },
      transparent: true,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.geo = geo;
    // 色の決め方は使う側が差し替える： (kind, t, out) => out に [r,g,b,a] を書いて返す
    this.colorFn = (k, t, out) => { out[0] = out[1] = out[2] = out[3] = 1; return out; };
    this._c = [0, 0, 0, 0];
  }

  spawn(x, y, z, vx, vy, vz, life, size0, size1, kind = 0) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.age[i] = 0;
    this.life[i] = life;
    this.size0[i] = size0;
    this.size1[i] = size1;
    this.kind[i] = kind;
  }

  clear() {
    this.count = 0;
    this.geo.instanceCount = 0;
  }

  // drag: 1秒あたりの速度減衰率, lift: 上向き加速度
  update(dt, drag = 0, lift = 0) {
    const damp = Math.exp(-drag * dt);
    let i = 0;
    while (i < this.count) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        // 末尾と入れ替えて削除
        const j = --this.count;
        if (i !== j) {
          this.pos.copyWithin(i * 3, j * 3, j * 3 + 3);
          this.vel.copyWithin(i * 3, j * 3, j * 3 + 3);
          this.age[i] = this.age[j]; this.life[i] = this.life[j];
          this.size0[i] = this.size0[j]; this.size1[i] = this.size1[j];
          this.kind[i] = this.kind[j];
        }
        continue;
      }
      const k = i * 3;
      this.vel[k] *= damp; this.vel[k + 1] = this.vel[k + 1] * damp + lift * dt; this.vel[k + 2] *= damp;
      this.pos[k] += this.vel[k] * dt; this.pos[k + 1] += this.vel[k + 1] * dt; this.pos[k + 2] += this.vel[k + 2] * dt;
      i++;
    }
    const P = this.aPos.array, S = this.aSize.array, C = this.aCol.array;
    for (let n = 0; n < this.count; n++) {
      const t = this.age[n] / this.life[n];
      P[n * 3] = this.pos[n * 3]; P[n * 3 + 1] = this.pos[n * 3 + 1]; P[n * 3 + 2] = this.pos[n * 3 + 2];
      S[n] = this.size0[n] + (this.size1[n] - this.size0[n]) * t;
      const c = this.colorFn(this.kind[n], t, this._c);
      C[n * 4] = c[0]; C[n * 4 + 1] = c[1]; C[n * 4 + 2] = c[2]; C[n * 4 + 3] = c[3];
    }
    this.geo.instanceCount = this.count;
    this.aPos.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aCol.needsUpdate = true;
  }
}
