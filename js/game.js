// ゲームロジック（logic.js）と描画・音をつなぐ層。Quest(XR) と PCプレビューで共通。
// 入力は「噴射しているか」「噴射口(muzzle)の位置と向き」「再スタート操作」だけを受け取る。
import * as THREE from '../vendor/three.module.min.js';
import { FireLogic, CONFIG } from './logic.js';
import { FireField } from './fire.js';
import { Particles } from './particles.js';
import { Hud, fmtTime } from './hud.js';

const _o = new THREE.Vector3();
const _d = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _w = new THREE.Vector3();

export class Game {
  constructor(scene, sfx) {
    this.scene = scene;
    this.sfx = sfx;
    this.logic = new FireLogic(CONFIG);
    this.floorY = 0;
    // 床の高さが分からない参照空間('local')のときは、頭の高さから床を推定する
    this.floorFromHead = false;
    this.spraying = false;
    this.hitting = false;

    // 炎は「プレイ空間」（開始時のプレイヤーの足元・正面基準）に置く
    this.field = new FireField(CONFIG.loseCount + 10);
    scene.add(this.field.group);
    scene.add(this.field.sparks.mesh);

    // 消火剤（白い粉）
    this.spray = new Particles(200, { glow: 0 });
    this.spray.colorFn = (k, t, o) => {
      o[0] = o[1] = o[2] = 0.97;
      o[3] = 0.6 * (1 - t) * Math.min(1, t * 10);
      return o;
    };
    this.spray.mesh.renderOrder = 5;
    scene.add(this.spray.mesh);
    // 炎に当たったところ・消えたところから上がる湯気
    this.steam = new Particles(120, { glow: 0 });
    this.steam.colorFn = (k, t, o) => {
      o[0] = 0.86; o[1] = 0.86; o[2] = 0.88;
      o[3] = 0.4 * (1 - t) * Math.min(1, t * 5);
      return o;
    };
    this.steam.mesh.renderOrder = 6;
    scene.add(this.steam.mesh);

    this.hud = new Hud();
    scene.add(this.hud.group);

    this.sprayAcc = 0;
    this.steamAcc = 0;
    this.ray = { o: [0, 0, 0], d: [0, 0, -1] };
  }

  get state() { return this.logic.state; }

  start() {
    this.logic.start();
    this.field.clear();
    this.spray.clear();
    this.steam.clear();
    this.hud.hideAll();
  }

  stop() {
    this.logic.stop();
    this.field.clear();
    this.spray.clear();
    this.steam.clear();
    this.hud.hideAll();
    this.setSpraying(false);
    this.sfx.setFireLevel(0);
  }

  setSpraying(on) {
    if (on !== this.spraying) {
      this.spraying = on;
      this.sfx.setSpray(on);
    }
  }

  // プレイ空間をプレイヤーの足元に置き、今の顔の向き（水平）に合わせる
  placeField(camera) {
    const pos = camera.getWorldPosition(_w);
    const fwd = camera.getWorldDirection(_d);
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    if (this.floorFromHead) this.floorY = pos.y - 1.2;
    this.field.group.position.set(pos.x, this.floorY, pos.z);
    this.field.group.rotation.set(0, Math.atan2(-fwd.x, -fwd.z), 0);
    this.field.group.updateMatrixWorld();
  }

  // input: { spray:boolean, muzzle:Object3D|null, restart:boolean(押した瞬間だけtrue) }
  update(dt, input, camera) {
    const L = this.logic;
    // 出火までは毎フレーム、プレイ空間を今の頭の位置・向きに合わせ直す
    if (L.state === 'waiting') this.placeField(camera);

    this.setSpraying(L.playing && input.spray && !!input.muzzle);

    // 噴射の向きをプレイ空間の座標に直してロジックへ
    let ray = null;
    if (this.spraying) {
      input.muzzle.getWorldPosition(_o);
      input.muzzle.getWorldQuaternion(_q);
      _d.set(0, 0, -1).applyQuaternion(_q);
      this.emitSpray(dt, _o, _d);
      this.field.group.worldToLocal(_a.copy(_o));
      _qi.copy(this.field.group.quaternion).invert();
      _b.copy(_d).applyQuaternion(_qi);
      this.ray.o[0] = _a.x; this.ray.o[1] = _a.y; this.ray.o[2] = _a.z;
      this.ray.d[0] = _b.x; this.ray.d[1] = _b.y; this.ray.d[2] = _b.z;
      ray = this.ray;
    }

    L.update(dt, ray);
    this.hitting = L.hitId !== 0;
    if (this.hitting && L.hitPoint) {
      const p = this.field.toWorld(L.hitPoint[0], L.hitPoint[1], L.hitPoint[2], _w);
      this.emitSteam(dt * 18, p, 0.3);
    }

    // ロジックで起きた出来事を見た目と音に反映
    for (const ev of L.events) this.onEvent(ev, camera);
    L.events.length = 0;

    if (L.state === 'burning') {
      this.field.sync(L.fires);
      this.sfx.setFireLevel(L.totalIntensity() / CONFIG.loseTotal + L.fires.length / CONFIG.loseCount * 0.5);
    }
    if (L.canRestart && input.restart) this.start();

    this.field.update(dt);
    this.spray.update(dt, 2.2, -0.6);
    this.steam.update(dt, 1.2, 0.5);
    this.hud.update(dt);
  }

  onEvent(ev, camera) {
    const L = this.logic;
    switch (ev.type) {
      case 'start':
        this.hud.showAlert(camera);
        this.sfx.alarm();
        break;
      case 'ignite': {
        this.field.add(ev.fire);
        const p = ev.fire.position;
        this.sfx.ignite(this.field.toWorld(p.x, 0.3, p.z, _w));
        break;
      }
      case 'out': {
        this.field.kill(ev.fire.id);
        const p = ev.fire.position;
        const w = this.field.toWorld(p.x, 0.15, p.z, _w);
        this.sfx.out(w);
        this.emitSteam(10, w, 0.35);
        break;
      }
      case 'won':
        this.setSpraying(false);
        this.sfx.setFireLevel(0);
        this.sfx.success();
        this.hud.showResult(camera, true, `消火時間 ${fmtTime(L.endTime)}　消した炎 ${L.extinguished}個`);
        break;
      case 'lost':
        this.setSpraying(false);
        // 炎は残すが、唸りは静かにする
        this.sfx.setFireLevel(0.15);
        this.sfx.fail();
        this.hud.showResult(camera, false, `${fmtTime(L.endTime)} 持ちこたえた　消した炎 ${L.extinguished}個`);
        break;
    }
  }

  emitSpray(dt, origin, fwd) {
    // ばらつき用に前方向と直交する2軸を作る
    const side = _a.set(0, 1, 0).cross(fwd);
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize();
    const up = _b.crossVectors(fwd, side).normalize();
    this.sprayAcc += dt * 110;
    while (this.sprayAcc >= 1) {
      this.sprayAcc -= 1;
      const spread = 0.12;
      const sx = (Math.random() - 0.5) * 2 * spread;
      const sy = (Math.random() - 0.5) * 2 * spread;
      const speed = 4.4 + Math.random() * 1.6;
      const vx = (fwd.x + side.x * sx + up.x * sy) * speed;
      const vy = (fwd.y + side.y * sx + up.y * sy) * speed;
      const vz = (fwd.z + side.z * sx + up.z * sy) * speed;
      const j = Math.random() * 0.02;
      this.spray.spawn(origin.x + vx * j, origin.y + vy * j, origin.z + vz * j, vx, vy, vz,
        0.7 + Math.random() * 0.3, 0.025, 0.2 + Math.random() * 0.12);
    }
  }

  // n 個ぶん（端数は持ち越し）の湯気を p のまわりに出す
  emitSteam(n, p, spread) {
    this.steamAcc += n;
    while (this.steamAcc >= 1) {
      this.steamAcc -= 1;
      this.steam.spawn(
        p.x + (Math.random() - 0.5) * spread, p.y + Math.random() * 0.2, p.z + (Math.random() - 0.5) * spread,
        (Math.random() - 0.5) * 0.3, 0.3 + Math.random() * 0.4, (Math.random() - 0.5) * 0.3,
        1.0 + Math.random() * 0.6, 0.08, 0.35,
      );
    }
  }
}
