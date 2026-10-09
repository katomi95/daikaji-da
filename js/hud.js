// VR空間内に置く文字パネル（Canvas を貼った板）。
// 大きな見出しは、表示した瞬間の頭の正面に固定する。頭に張り付けて追従はさせない（酔い防止）。
// 常時表示の情報（火元の数・経過時間）は、消火器に付けた小さな表示板に出す（視界をふさがない）。
import * as THREE from '../vendor/three.module.min.js';

const FONT = '"Noto Sans JP","Hiragino Sans","Yu Gothic","Meiryo",sans-serif';

function makePanel(w, h, draw, pxPerM = 600) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * pxPerM);
  canvas.height = Math.round(h * pxPerM);
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  mesh.renderOrder = 100;
  // 中身を描き直す関数（引数は draw にそのまま渡す）
  mesh.userData.redraw = (...args) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    draw(ctx, canvas.width, canvas.height, ...args);
    tex.needsUpdate = true;
  };
  mesh.userData.redraw();
  return mesh;
}

// 幅に収まるよう文字サイズを自動で縮める
function fitFont(ctx, text, weight, size, maxW) {
  let s = size;
  ctx.font = `${weight} ${s}px ${FONT}`;
  const w = ctx.measureText(text).width;
  if (w > maxW) {
    s = Math.floor((s * maxW) / w);
    ctx.font = `${weight} ${s}px ${FONT}`;
  }
  return s;
}

function bigText(text, color) {
  return (ctx, W, H) => {
    fitFont(ctx, text, 900, Math.round(H * 0.66), W * 0.94);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = H * 0.1;
    ctx.strokeStyle = 'rgba(20,10,8,0.9)';
    ctx.strokeText(text, W / 2, H / 2);
    ctx.fillStyle = color;
    ctx.fillText(text, W / 2, H / 2);
  };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// 決着時の結果パネル（見出し＋数字＋「もう一度遊ぶ」）
function resultGroup(title, color) {
  const g = new THREE.Group();
  const head = makePanel(1.2, 0.32, bigText(title, color));
  const stats = makePanel(0.9, 0.14, (ctx, W, H, lines) => {
    if (!lines) return;
    roundRect(ctx, 2, 2, W - 4, H - 4, H * 0.2);
    ctx.fillStyle = 'rgba(24,16,14,0.78)';
    ctx.fill();
    ctx.fillStyle = '#fff6ee';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, lines, 'bold', Math.round(H * 0.42), W * 0.92);
    ctx.fillText(lines, W / 2, H / 2);
  });
  stats.position.y = -0.24;
  const retry = makePanel(0.5, 0.16, (ctx, W, H) => {
    roundRect(ctx, 4, 4, W - 8, H - 8, H * 0.22);
    ctx.fillStyle = '#d8341a';
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#fff3e8';
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.round(H * 0.36)}px ${FONT}`;
    ctx.fillText('もう一度遊ぶ', W / 2, H * 0.4);
    ctx.font = `${Math.round(H * 0.17)}px ${FONT}`;
    ctx.fillText('トリガー（クリック）で再スタート', W / 2, H * 0.76);
  });
  retry.position.y = -0.43;
  g.add(head, stats, retry);
  g.userData.stats = stats;
  g.userData.retry = retry;
  return g;
}

export class Hud {
  constructor() {
    this.group = new THREE.Group();
    this.alert = makePanel(1.2, 0.34, bigText('大火事だ！', '#ff4a1c'));
    this.clear = resultGroup('完全鎮火！', '#ffffff');
    this.over = resultGroup('もうだめだ！', '#ff4a1c');
    this.group.add(this.alert, this.clear, this.over);
    this.hideAll();
    this._fwd = new THREE.Vector3();
    // PCプレビューでは画面の中央付近に出したいので、視線の上下も考慮する
    this.followPitch = false;
    this.alertTime = 0;
  }

  hideAll() {
    this.alert.visible = false;
    this.clear.visible = false;
    this.over.visible = false;
  }

  // 頭の位置・向きから、正面 dist m・目線より少し上に置く（水平方向だけ見る）
  placeInFront(camera, dist = 1.7, up = 0.12) {
    const pos = camera.getWorldPosition(new THREE.Vector3());
    const fwd = camera.getWorldDirection(this._fwd);
    if (this.followPitch) {
      // 縦長・狭いウィンドウでも文字がはみ出さないよう、遠くに置く
      if (camera.aspect) dist *= Math.max(1, 1.8 / camera.aspect);
      this.group.position.copy(pos).addScaledVector(fwd, dist);
      this.group.position.y += up * 0.5;
      const pitch = Math.asin(Math.max(-1, Math.min(1, fwd.y)));
      fwd.y = 0;
      fwd.normalize();
      this.group.rotation.set(0, 0, 0);
      this.group.rotation.order = 'YXZ';
      this.group.rotation.y = Math.atan2(-fwd.x, -fwd.z);
      this.group.rotation.x = pitch;
      return;
    }
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-4) fwd.set(0, 0, -1);
    fwd.normalize();
    this.group.position.set(pos.x + fwd.x * dist, pos.y + up, pos.z + fwd.z * dist);
    this.group.rotation.set(0, Math.atan2(-fwd.x, -fwd.z), 0);
  }

  showAlert(camera) {
    this.hideAll();
    this.placeInFront(camera);
    this.alert.visible = true;
    this.alert.material.opacity = 1;
    this.alertTime = 0;
  }

  showResult(camera, won, lines) {
    this.hideAll();
    this.placeInFront(camera, 1.7, 0.15);
    const g = won ? this.clear : this.over;
    g.userData.stats.userData.redraw(lines);
    g.visible = true;
  }

  update(dt) {
    if (this.alert.visible) {
      // 2.5秒表示して0.5秒でフェードアウト（点滅はしない）
      this.alertTime += dt;
      const o = Math.max(0, Math.min(1, (3.0 - this.alertTime) / 0.5));
      this.alert.material.opacity = o;
      if (o <= 0) this.alert.visible = false;
    }
  }
}

// 消火器に付ける小さな表示板：「火元 N」と経過時間
export function createStatusPanel() {
  const mesh = makePanel(0.16, 0.05, (ctx, W, H, count, time) => {
    roundRect(ctx, 2, 2, W - 4, H - 4, H * 0.22);
    ctx.fillStyle = 'rgba(16,12,12,0.82)';
    ctx.fill();
    if (count === undefined) return;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = count >= 12 ? '#ff7a4a' : '#ffd2a8';
    ctx.font = `bold ${Math.round(H * 0.42)}px ${FONT}`;
    ctx.fillText(`火元 ${count}`, W * 0.06, H * 0.52);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#f3ece6';
    ctx.font = `${Math.round(H * 0.38)}px ${FONT}`;
    ctx.fillText(fmtTime(time), W * 0.94, H * 0.52);
  }, 2400);
  mesh.renderOrder = 90;
  let last = '';
  // 値が変わったときだけ描き直す
  mesh.userData.set = (count, time) => {
    const key = `${count}|${Math.floor(time)}`;
    if (key === last) return;
    last = key;
    mesh.userData.redraw(count, time);
  };
  return mesh;
}
