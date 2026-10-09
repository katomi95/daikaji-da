// 起動・モード切替・入力の取り出し。
//  - XRモード：Quest Browser の immersive-ar（パススルー）。右手コントローラーに消火器。
//  - プレビューモード：PCブラウザ。仮想の部屋。マウスで見回し、画面中央の照準を炎に合わせて左クリック長押しで噴射。
// ゲームロジック（logic.js / game.js）は両モード共通。
import * as THREE from '../vendor/three.module.min.js';
import { Game } from './game.js';
import { createExtinguisher } from './extinguisher.js';
import { createStatusPanel, fmtTime } from './hud.js';
import { Sfx } from './audio.js';
import { FIRE_HEIGHT, fireScale } from './logic.js';

const $ = (id) => document.getElementById(id);
const titleEl = $('title');
const startBtn = $('btn-start');
const previewBtn = $('btn-preview');
const backBtn = $('btn-back');
const statusEl = $('xr-status');
const pcHud = $('pc-hud');
const pcCount = $('pc-count');
const pcTime = $('pc-time');
const pcHint = $('pc-hint');

// ---------- レンダラーとシーン ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 50);
camera.rotation.order = 'YXZ';
scene.add(camera);

scene.add(new THREE.HemisphereLight(0xfff4e8, 0x5a4a40, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(0.5, 2, 1);
scene.add(sun);

const sfx = new Sfx();
const game = new Game(scene, sfx);
const ext = createExtinguisher();

// 消火器の頭に付ける小さな表示板（火元の数・経過時間）。手元を見れば読める
const statusPanel = createStatusPanel();
statusPanel.position.set(0, 0.05, 0.085);
statusPanel.rotation.x = -0.85; // 持ったときに顔の方へ向く
ext.root.add(statusPanel);

let mode = 'title'; // 'title' | 'xr' | 'preview'

// ---------- PCプレビュー用の仮想の部屋 ----------
const room = new THREE.Group();
{
  const S = 10;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshLambertMaterial({ color: 0x7a6250 }));
  floor.rotation.x = -Math.PI / 2;
  room.add(floor);
  const grid = new THREE.GridHelper(S, 20, 0x5c4838, 0x5c4838);
  grid.position.y = 0.002;
  room.add(grid);
  const wallMat = new THREE.MeshLambertMaterial({ color: 0xd9d0c4 });
  const half = 4.2;
  for (let i = 0; i < 4; i++) {
    const w = new THREE.Mesh(new THREE.PlaneGeometry(half * 2, 2.6), wallMat);
    const a = (i * Math.PI) / 2;
    w.position.set(-Math.sin(a) * half, 1.3, -Math.cos(a) * half);
    w.rotation.y = a;
    room.add(w);
  }
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(S, S), new THREE.MeshLambertMaterial({ color: 0xece6dc }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.y = 2.6;
  room.add(ceil);
  // 家具っぽい箱をいくつか（距離感・向きの目安）
  const box = (w, h, d, color, x, z, ry = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
    m.position.set(x, h / 2, z);
    m.rotation.y = ry;
    room.add(m);
  };
  box(1.8, 0.45, 0.8, 0x4f6c7a, -1.6, -3.7);      // ソファ
  box(0.8, 1.6, 0.35, 0x8a6a48, 2.4, -3.95);      // 棚
  box(1.2, 0.7, 0.6, 0x6b5440, 3.9, 0.6, Math.PI / 2); // 机
  box(0.5, 0.9, 0.5, 0x3d4a3c, -3.9, 1.2);        // 観葉植物の鉢のつもり
  box(1.6, 0.5, 2.0, 0x8c7c94, -3.2, -1.2);       // ベッド
  // 椅子（プレイヤーが座っている）
  box(0.5, 0.45, 0.5, 0x2e2a28, 0, 0.12);
}
room.visible = false;
scene.add(room);

// ---------- タイトル画面：XR 対応状況の確認 ----------
function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

async function checkXR() {
  if (!window.isSecureContext) {
    setStatus('WebXR は HTTPS（または localhost）でのみ動きます。GitHub Pages の https:// のURLで開いてください。PCではプレビューで遊べます。', true);
    return;
  }
  if (!('xr' in navigator)) {
    setStatus('このブラウザは WebXR に対応していません。Meta Quest 3 のブラウザで開いてください。PCではプレビューで遊べます。', true);
    return;
  }
  let ok = false;
  try {
    ok = await navigator.xr.isSessionSupported('immersive-ar');
  } catch (e) {
    console.warn(e);
  }
  if (ok) {
    startBtn.disabled = false;
    setStatus('パススルーMRで遊べます。「ゲーム開始」を押すと現実の部屋が映ります。');
  } else {
    setStatus('この環境はパススルーMR（immersive-ar）に対応していません。Meta Quest 3 のブラウザで開いてください。VRモードへの切り替えは行いません。PCではプレビューで遊べます。', true);
  }
}
checkXR();

// ---------- XR（Quest 3） ----------
const controllers = [];
let handController = null; // 消火器を持たせているコントローラー

for (let i = 0; i < 2; i++) {
  const c = renderer.xr.getController(i);
  c.userData.select = false;
  c.userData.source = null;
  c.addEventListener('connected', (e) => { c.userData.source = e.data; pickHand(); });
  c.addEventListener('disconnected', () => { c.userData.source = null; c.userData.select = false; pickHand(); });
  c.addEventListener('selectstart', () => { c.userData.select = true; });
  c.addEventListener('selectend', () => { c.userData.select = false; });
  scene.add(c);
  controllers.push(c);
}

// 右手のコントローラーを優先。右手が無いときだけ、つながっている方を使う
function pickHand() {
  if (mode !== 'xr') return;
  const live = controllers.filter((c) => c.userData.source);
  const right = live.find((c) => c.userData.source.handedness === 'right');
  const next = right || live[0] || null;
  if (next === handController) return;
  handController = next;
  if (next) next.add(ext.root);
  else ext.root.removeFromParent();
}

function triggerPressed(c) {
  if (!c) return false;
  if (c.userData.select) return true;
  const gp = c.userData.source && c.userData.source.gamepad;
  return !!(gp && gp.buttons[0] && (gp.buttons[0].pressed || gp.buttons[0].value > 0.5));
}

function pulse(c, strength, ms) {
  const gp = c && c.userData.source && c.userData.source.gamepad;
  const h = gp && gp.hapticActuators && gp.hapticActuators[0];
  if (h && h.pulse) {
    try { h.pulse(strength, ms); } catch (e) { /* 振動非対応なら何もしない */ }
  }
}

async function startXR() {
  sfx.init(); // ボタン操作の中で音を有効化しておく
  startBtn.disabled = true;
  setStatus('起動中…');
  let session;
  try {
    // DOM overlay 等の追加機能は使わない。床基準(local-floor)は任意扱いで要求
    session = await navigator.xr.requestSession('immersive-ar', { optionalFeatures: ['local-floor'] });
  } catch (e) {
    console.error(e);
    setStatus(`パススルーMRを開始できませんでした（${e.name || 'Error'}: ${e.message || e}）。ブラウザの許可ダイアログで拒否した場合は、ページを再読み込みしてもう一度お試しください。`, true);
    startBtn.disabled = false;
    return;
  }

  // 床基準が使えるか確認。使えなければ 'local'（頭の位置基準）で、床の高さは推定する
  let refType = 'local-floor';
  try {
    await session.requestReferenceSpace('local-floor');
  } catch (e) {
    refType = 'local';
  }
  game.floorY = 0;
  game.floorFromHead = refType === 'local';

  renderer.xr.setReferenceSpaceType(refType);
  try {
    await renderer.xr.setSession(session);
  } catch (e) {
    console.error(e);
    setStatus(`XRの初期化に失敗しました（${e.message || e}）。`, true);
    startBtn.disabled = false;
    session.end().catch(() => {});
    return;
  }
  session.addEventListener('end', onXREnd);

  mode = 'xr';
  titleEl.hidden = true;
  backBtn.hidden = true;
  pcHud.hidden = true;
  // パススルーを見せるため、背景は完全に透明にする
  scene.background = null;
  renderer.setClearColor(0x000000, 0);
  room.visible = false;
  game.hud.followPitch = false;
  statusPanel.visible = true;
  ext.root.removeFromParent();
  ext.root.position.set(0, 0, 0);
  ext.root.quaternion.identity();
  handController = null;
  pickHand();
  prevTrigger = false;
  game.start();
}

function onXREnd() {
  game.stop();
  ext.root.removeFromParent();
  handController = null;
  backToTitle();
}

// ---------- PCプレビュー ----------
// 見回し：マウス（画面をクリックするとポインターロック。Escで解除）／右ドラッグ／矢印キー・A D W S
// 噴射：左クリックを押している間。照準は常に画面中央なので、見回しと噴射がぶつからない
const pointer = { down: false };
const look = { yaw: 0, pitch: -0.12, keys: new Set(), drag: false };
const SENS = 0.0022;
const KEY_SPEED = 1.9; // ラジアン/秒
const _aim = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _wp = new THREE.Vector3();
const _fp = new THREE.Vector3();
const _camQ = new THREE.Quaternion();
const _fwd = new THREE.Vector3();

function applyLook() {
  look.pitch = Math.max(-1.2, Math.min(0.9, look.pitch));
  camera.rotation.set(look.pitch, look.yaw, 0);
}

function startPreview() {
  sfx.init();
  mode = 'preview';
  titleEl.hidden = true;
  backBtn.hidden = false;
  pcHud.hidden = false;
  document.body.classList.add('preview');
  scene.background = new THREE.Color(0x2b2422);
  renderer.setClearColor(0x2b2422, 1);
  room.visible = true;
  game.floorY = 0;
  game.floorFromHead = false;
  game.hud.followPitch = true;
  statusPanel.visible = false; // PCでは画面上部に同じ情報を出す
  // 着席した人の目線くらい
  camera.position.set(0, 1.2, 0);
  look.yaw = 0;
  look.pitch = -0.12;
  applyLook();
  camera.add(ext.root);
  ext.root.position.set(0.2, -0.17, -0.42);
  pointer.down = false;
  prevTrigger = false;
  game.start();
}

function backToTitle() {
  mode = 'title';
  game.stop();
  ext.root.removeFromParent();
  room.visible = false;
  document.body.classList.remove('preview');
  if (document.pointerLockElement) document.exitPointerLock();
  backBtn.hidden = true;
  pcHud.hidden = true;
  titleEl.hidden = false;
  startBtn.disabled = true;
  checkXR();
}

// 照準（画面中央）の先にある炎までの距離を求め、消火器のノズルをそこへ向ける
function aimPreview() {
  camera.getWorldPosition(_wp);
  camera.getWorldDirection(_fwd);
  let dist = 2.4;
  let best = 0.35; // これより外れている炎は無視（ラジアン）
  for (const f of game.logic.fires) {
    const s = fireScale(f.intensity);
    game.field.toWorld(f.position.x, FIRE_HEIGHT * s.y * 0.4, f.position.z, _fp);
    _fp.sub(_wp);
    const d = _fp.length();
    const ang = _fp.angleTo(_fwd);
    if (ang < best) { best = ang; dist = d * Math.cos(ang); }
  }
  _aim.copy(_wp).addScaledVector(_fwd, dist);
  // 消火器の -Z を狙う点へ向ける（Matrix4.lookAt は -Z が target を向く）
  ext.root.getWorldPosition(_fp);
  _m.lookAt(_fp, _aim, THREE.Object3D.DEFAULT_UP);
  const worldQ = new THREE.Quaternion().setFromRotationMatrix(_m);
  camera.getWorldQuaternion(_camQ);
  ext.root.quaternion.copy(_camQ.invert().multiply(worldQ));
}

const canvas = renderer.domElement;
canvas.addEventListener('pointerdown', (e) => {
  if (mode !== 'preview') return;
  if (e.button === 0) {
    pointer.down = true;
    if (!document.pointerLockElement && canvas.requestPointerLock) {
      try {
        const r = canvas.requestPointerLock();
        if (r && r.catch) r.catch(() => {});
      } catch (err) { /* ロックできなくても右ドラッグ・キーで見回せる */ }
    }
  } else if (e.button === 2) {
    look.drag = true;
  }
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* 取れなくても動く */ }
});
canvas.addEventListener('pointermove', (e) => {
  if (mode !== 'preview') return;
  if (document.pointerLockElement === canvas || look.drag) {
    look.yaw -= e.movementX * SENS;
    look.pitch -= e.movementY * SENS;
    applyLook();
  }
});
const release = (e) => {
  if (!e || e.button === 0 || e.type !== 'pointerup') pointer.down = false;
  if (!e || e.button === 2 || e.type !== 'pointerup') look.drag = false;
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
window.addEventListener('blur', () => { release(); look.keys.clear(); });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('pointerlockchange', () => {
  pcHint.textContent = document.pointerLockElement
    ? 'マウスで見回し・左クリック長押しで噴射（Escでマウス解放）'
    : 'クリックでマウス操作開始／右ドラッグ・矢印キーでも見回せます';
});
window.addEventListener('keydown', (e) => {
  if (mode !== 'preview') return;
  look.keys.add(e.code);
  if (e.code.startsWith('Arrow')) e.preventDefault();
  // 軽く押しただけでも少し回る
  if (!e.repeat) {
    if (e.code === 'ArrowLeft' || e.code === 'KeyA') look.yaw += 0.05;
    if (e.code === 'ArrowRight' || e.code === 'KeyD') look.yaw -= 0.05;
    applyLook();
  }
});
window.addEventListener('keyup', (e) => look.keys.delete(e.code));

function updateKeys(dt) {
  const k = look.keys;
  const h = (k.has('ArrowLeft') || k.has('KeyA') ? 1 : 0) - (k.has('ArrowRight') || k.has('KeyD') ? 1 : 0);
  const v = (k.has('ArrowUp') || k.has('KeyW') ? 1 : 0) - (k.has('ArrowDown') || k.has('KeyS') ? 1 : 0);
  if (h || v) {
    look.yaw += h * KEY_SPEED * dt;
    look.pitch += v * KEY_SPEED * 0.6 * dt;
    applyLook();
  }
}

window.addEventListener('resize', () => {
  if (renderer.xr.isPresenting) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

startBtn.addEventListener('click', startXR);
previewBtn.addEventListener('click', startPreview);
backBtn.addEventListener('click', backToTitle);

// ---------- メインループ（XR でも PC でも同じ setAnimationLoop） ----------
const clock = new THREE.Clock();
let prevTrigger = false;
const input = { spray: false, muzzle: ext.muzzle, restart: false };
let lastPcKey = '';

renderer.setAnimationLoop(() => frame(Math.min(clock.getDelta(), 0.05)));

function frame(dt) {
  if (mode === 'title') return;

  let trig = false;
  if (mode === 'xr') {
    trig = triggerPressed(handController);
    input.muzzle = handController ? ext.muzzle : null;
  } else {
    updateKeys(dt);
    camera.updateMatrixWorld();
    aimPreview();
    trig = pointer.down;
    input.muzzle = ext.muzzle;
  }
  input.spray = trig;
  input.restart = trig && !prevTrigger;
  prevTrigger = trig;

  game.update(dt, input, camera);
  sfx.updateListener(camera);

  // 常時表示：火元の数と経過時間
  const L = game.logic;
  const count = L.fires.length;
  const t = L.ended ? L.endTime : L.time;
  if (mode === 'xr') statusPanel.userData.set(count, t);
  else {
    const key = `${count}|${Math.floor(t)}`;
    if (key !== lastPcKey) {
      lastPcKey = key;
      pcCount.textContent = String(count);
      pcTime.textContent = fmtTime(t);
    }
  }

  if (mode === 'xr' && game.spraying) pulse(handController, game.hitting ? 0.35 : 0.12, 40);

  renderer.render(scene, camera);
}

// デバッグ・自動確認用
window.__daikaji = { frame, game, logic: game.logic, camera, ext, pointer, look, applyLook, startPreview, backToTitle };
