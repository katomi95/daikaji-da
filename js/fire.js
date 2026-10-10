// 炎の描画（たくさんの炎をまとめて描く）。
// 1つの炎＝交差させた半透明の板3枚＋芯の板2枚＋床の照り返し。これを炎の数だけインスタンス描画するので、
// 炎が何個あっても描画呼び出しは「外側の板・芯・照り返し」の3回で済む。ジオメトリとマテリアルは全炎で共有。
// 火勢は 1インスタンスごとの属性(iPower)で渡す。
import * as THREE from '../vendor/three.module.min.js';
import { Particles } from './particles.js';
import { FIRE_HEIGHT, FIRE_WIDTH, fireScale } from './logic.js';

const FLAME_VERT = /* glsl */`
attribute vec3 iPos;
attribute vec2 iScale;
attribute float iRot;
attribute float iPower;
attribute float iSeed;
varying vec2 vUv;
varying float vPower;
varying float vSeed;
void main() {
  vUv = uv;
  vPower = iPower;
  vSeed = iSeed;
  vec3 p = vec3(position.x * iScale.x, position.y * iScale.y, position.z);
  float c = cos(iRot), s = sin(iRot);
  vec3 r = vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(r + iPos, 1.0);
}`;

const FLAME_FRAG = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying float vPower;
varying float vSeed;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}

void main() {
  float speed = 2.0 + 3.0 * vPower;
  float y = vUv.y;
  float x = (vUv.x - 0.5) * 2.0;
  float t = uTime * speed + vSeed * 7.0;
  float n1 = noise(vec2(x * 2.2 + vSeed * 3.0, y * 3.5 - t));
  float n2 = noise(vec2(x * 5.0 - vSeed, y * 7.0 - t * 1.7));
  float n = n1 * 0.7 + n2 * 0.3;

  // 上に行くほど大きく揺らす（大火ほど激しく）
  x += (n - 0.5) * (0.9 + 0.9 * vPower) * y;
  // しずく型の幅：根元は丸く、先端は細く
  float w = 0.82 * pow(max(1.0 - y, 0.0), 0.75) * (0.35 + 0.65 * smoothstep(0.0, 0.2, y));
  float body = 1.0 - smoothstep(w * 0.45, w, abs(x));
  // 先端はノイズでちぎれる
  body *= smoothstep(1.02, 0.45, y + (n - 0.5) * (0.55 + 0.45 * vPower));
  if (body < 0.01) discard;

  // 芯ほど黄色、外側ほど赤
  float heat = body * (1.15 - y * 0.75) * (0.95 + 0.25 * vPower);
  vec3 red = vec3(0.92, 0.12, 0.03);
  vec3 orange = vec3(1.0, 0.45, 0.05);
  vec3 yellow = vec3(1.0, 0.88, 0.35);
  vec3 col = mix(red, orange, smoothstep(0.15, 0.55, heat));
  col = mix(col, yellow, smoothstep(0.6, 0.95, heat));

  float a = body * (0.7 + 0.3 * vPower);
  // 乗算済みアルファ。アルファを少し控えめに書いて「光っている」感じを残す
  gl_FragColor = vec4(col * a * (1.0 + 0.25 * vPower), a * 0.7);
}`;

const GLOW_VERT = /* glsl */`
attribute vec3 iPos;
attribute vec2 iScale;
attribute float iPower;
attribute float iSeed;
varying vec2 vUv;
varying float vPower;
varying float vSeed;
void main() {
  vUv = uv;
  vPower = iPower;
  vSeed = iSeed;
  vec3 p = vec3(position.x * iScale.x, position.y, position.z * iScale.x);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p + iPos, 1.0);
}`;

const GLOW_FRAG = /* glsl */`
uniform float uTime;
varying vec2 vUv;
varying float vPower;
varying float vSeed;
void main() {
  float d = length(vUv - 0.5) * 2.0;
  float tt = uTime + vSeed * 3.0;
  float flick = 0.85 + 0.15 * sin(tt * 9.0) * sin(tt * 5.3);
  float a = (1.0 - smoothstep(0.0, 1.0, d)) * (0.25 + 0.55 * vPower) * flick;
  if (a < 0.004) discard;
  vec3 col = mix(vec3(1.0, 0.35, 0.05), vec3(1.0, 0.7, 0.2), 1.0 - d);
  gl_FragColor = vec4(col * a, a * 0.35);
}`;

const blendPremul = {
  transparent: true,
  depthWrite: false,
  side: THREE.DoubleSide,
  blending: THREE.CustomBlending,
  blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor,
  blendDst: THREE.OneMinusSrcAlphaFactor,
  blendSrcAlpha: THREE.OneFactor,
  blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
};

// 板1枚（base）を maxInst 個並べて描くインスタンスメッシュ
function makeInstanced(base, maxInst, vert, frag, uniforms, withRot) {
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = base.index;
  geo.setAttribute('position', base.getAttribute('position'));
  geo.setAttribute('uv', base.getAttribute('uv'));
  const attrs = {
    iPos: new THREE.InstancedBufferAttribute(new Float32Array(maxInst * 3), 3),
    iScale: new THREE.InstancedBufferAttribute(new Float32Array(maxInst * 2), 2),
    iPower: new THREE.InstancedBufferAttribute(new Float32Array(maxInst), 1),
    iSeed: new THREE.InstancedBufferAttribute(new Float32Array(maxInst), 1),
  };
  if (withRot) attrs.iRot = new THREE.InstancedBufferAttribute(new Float32Array(maxInst), 1);
  for (const [k, a] of Object.entries(attrs)) {
    a.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(k, a);
  }
  geo.instanceCount = 0;
  const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms, ...blendPremul });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false; // インスタンスはあちこちにあるので、まとめての視錐台判定はしない
  return { mesh, geo, attrs };
}

const OUTER = 3; // 1つの炎あたりの外側の板の枚数
const CORE = 2;  // 芯の板の枚数

export class FireField {
  // group は「プレイ空間」。プレイヤーの開始位置の床に置き、開始時の正面に向ける
  constructor(maxFires = 30) {
    this.max = maxFires;
    this.group = new THREE.Group();
    this.time = 0;
    this.uTime = { value: 0 }; // 3つのマテリアルで共有

    const outerGeo = new THREE.PlaneGeometry(FIRE_WIDTH, FIRE_HEIGHT);
    outerGeo.translate(0, FIRE_HEIGHT / 2, 0);
    this.outer = makeInstanced(outerGeo, maxFires * OUTER, FLAME_VERT, FLAME_FRAG, { uTime: this.uTime }, true);
    this.outer.mesh.renderOrder = 2;

    const coreGeo = new THREE.PlaneGeometry(FIRE_WIDTH * 0.55, FIRE_HEIGHT * 0.6);
    coreGeo.translate(0, FIRE_HEIGHT * 0.3, 0);
    this.core = makeInstanced(coreGeo, maxFires * CORE, FLAME_VERT, FLAME_FRAG, { uTime: this.uTime }, true);
    this.core.mesh.renderOrder = 3;

    const glowGeo = new THREE.PlaneGeometry(1.4, 1.4);
    glowGeo.rotateX(-Math.PI / 2);
    this.glow = makeInstanced(glowGeo, maxFires, GLOW_VERT, GLOW_FRAG, { uTime: this.uTime }, false);
    this.glow.mesh.renderOrder = 1;

    this.group.add(this.glow.mesh, this.outer.mesh, this.core.mesh);

    // 火の粉（全部の炎で1つのプールを共有。ワールド座標で動かす）
    this.sparks = new Particles(320, { glow: 0.6 });
    this.sparks.colorFn = (k, t, o) => {
      o[0] = 1.0;
      o[1] = 0.85 - 0.65 * t;
      o[2] = 0.3 * (1 - t) * (1 - t);
      o[3] = (1 - t) * Math.min(1, t * 6) * 0.9;
      return o;
    };
    this.sparks.mesh.renderOrder = 4;

    // id → 見た目の状態
    this.items = new Map();
    this.list = [];
    this._v = new THREE.Vector3();
  }

  clear() {
    this.items.clear();
    this.list.length = 0;
    this.sparks.clear();
    this.writeAttributes();
  }

  // ロジックの炎が生まれたとき。見た目は 0 から育つ
  add(fire) {
    if (this.list.length >= this.max) return; // 念のため（ロジック側の上限より多めに確保してある）
    const it = {
      id: fire.id,
      x: fire.position.x,
      z: fire.position.z,
      power: 0,
      target: fire.intensity / 100,
      seed: Math.random() * 10,
      rot: Math.random() * Math.PI,
      dying: false,
      spawnAcc: 0,
    };
    this.items.set(fire.id, it);
    this.list.push(it);
  }

  // 消火されたとき：すっと縮んで消える
  kill(id) {
    const it = this.items.get(id);
    if (it) { it.dying = true; it.target = 0; }
  }

  // ロジックの火勢を見た目の目標値に反映
  sync(fires) {
    for (const f of fires) {
      const it = this.items.get(f.id);
      if (it && !it.dying) it.target = f.intensity / 100;
    }
  }

  // プレイ空間の点をワールド座標へ
  toWorld(x, y, z, out) {
    return this.group.localToWorld(out.set(x, y, z));
  }

  update(dt) {
    this.time += dt;
    this.uTime.value = this.time;
    this.group.updateMatrixWorld();
    const sx = this.group.scale.x;

    for (let i = this.list.length - 1; i >= 0; i--) {
      const it = this.list[i];
      if (it.dying) {
        it.power = Math.max(0, it.power - dt * 1.6);
        if (it.power <= 0) {
          this.items.delete(it.id);
          this.list.splice(i, 1);
          continue;
        }
      } else {
        // 見た目は火勢を少し遅れて追う（新しい炎はふわっと立ち上がる）
        it.power += (it.target - it.power) * Math.min(1, dt * 5);
      }
      // 火の粉：大きい炎ほど多い
      const p = it.power;
      if (p > 0.03 && !it.dying) {
        it.spawnAcc += dt * (4 + 26 * p);
        const s = fireScale(p * 100);
        const base = this.toWorld(it.x, 0, it.z, this._v);
        while (it.spawnAcc >= 1) {
          it.spawnAcc -= 1;
          const a = Math.random() * Math.PI * 2;
          const r = Math.random() * 0.14 * s.x * sx;
          this.sparks.spawn(
            base.x + Math.cos(a) * r, base.y + (0.1 + Math.random() * 0.4) * s.y, base.z + Math.sin(a) * r,
            (Math.random() - 0.5) * (0.3 + 0.5 * p), 0.6 + Math.random() * (0.6 + 1.4 * p), (Math.random() - 0.5) * (0.3 + 0.5 * p),
            0.5 + Math.random() * (0.5 + 0.5 * p), (0.05 + Math.random() * 0.06) * (0.6 + 0.5 * p), 0.015,
          );
        }
      }
    }
    this.writeAttributes();
    this.sparks.update(dt, 0.6, 0.4);
  }

  writeAttributes() {
    const o = this.outer.attrs, c = this.core.attrs, g = this.glow.attrs;
    const n = this.list.length;
    for (let i = 0; i < n; i++) {
      const it = this.list[i];
      const p = it.power;
      const s = fireScale(p * 100);
      // ゆるやかな揺らぎ（強い点滅にはしない）
      // 大きい炎ほど大きく伸び縮みする
      const sway = 1 + (0.05 + 0.07 * p) * Math.sin(this.time * 3.1 + it.seed) + (0.03 + 0.05 * p) * Math.sin(this.time * 7.7 + it.seed * 2);
      // 消えかけは小さく（縮み切ったら見えなくなる）
      const vis = it.dying ? Math.min(1, p * 4) : Math.min(1, p * 12);
      const scx = s.x * vis, scy = s.y * sway * vis;
      for (let k = 0; k < OUTER; k++) {
        const j = i * OUTER + k;
        o.iPos.array.set([it.x, 0, it.z], j * 3);
        o.iScale.array[j * 2] = scx; o.iScale.array[j * 2 + 1] = scy;
        o.iRot.array[j] = it.rot + (k * Math.PI) / 3;
        o.iPower.array[j] = p;
        o.iSeed.array[j] = it.seed + k * 1.37;
      }
      for (let k = 0; k < CORE; k++) {
        const j = i * CORE + k;
        c.iPos.array.set([it.x, 0, it.z], j * 3);
        c.iScale.array[j * 2] = scx; c.iScale.array[j * 2 + 1] = scy;
        c.iRot.array[j] = it.rot + Math.PI / 4 + (k * Math.PI) / 2;
        c.iPower.array[j] = p;
        c.iSeed.array[j] = it.seed + 4.1 + k * 2.3;
      }
      g.iPos.array.set([it.x, 0.005, it.z], i * 3);
      g.iScale.array[i * 2] = 0.8 + 1.3 * p; g.iScale.array[i * 2 + 1] = 1;
      g.iPower.array[i] = p * vis;
      g.iSeed.array[i] = it.seed;
    }
    this.outer.geo.instanceCount = n * OUTER;
    this.core.geo.instanceCount = n * CORE;
    this.glow.geo.instanceCount = n;
    for (const set of [o, c, g]) for (const a of Object.values(set)) a.needsUpdate = true;
  }
}
