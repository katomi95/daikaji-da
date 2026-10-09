// 消火器の簡易モデル。
// 座標系はコントローラーの「指し示す方向（target ray）」と同じ：-Z が前、+Y が上。
// 取っ手を握っている想定で、本体は手の下にぶら下がり、ホースの先のノズルが前(-Z)を向く。
import * as THREE from '../vendor/three.module.min.js';

export function createExtinguisher() {
  const root = new THREE.Group();
  const red = new THREE.MeshLambertMaterial({ color: 0xd42a1c });
  const black = new THREE.MeshLambertMaterial({ color: 0x1b1b1d });
  const metal = new THREE.MeshLambertMaterial({ color: 0x9a9da3 });
  const white = new THREE.MeshLambertMaterial({ color: 0xf1efe8 });

  // 本体（赤い円筒）
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.23, 18), red);
  body.position.set(0, -0.165, 0.035);
  root.add(body);
  // 丸い肩と底
  const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.046, 18, 8, 0, Math.PI * 2, 0, Math.PI / 2), red);
  shoulder.position.set(0, -0.05, 0.035);
  root.add(shoulder);
  const bottom = new THREE.Mesh(new THREE.CylinderGeometry(0.048, 0.048, 0.012, 18), black);
  bottom.position.set(0, -0.285, 0.035);
  root.add(bottom);
  // 白いラベル帯
  const label = new THREE.Mesh(new THREE.CylinderGeometry(0.0475, 0.0475, 0.07, 18, 1, true), white);
  label.position.set(0, -0.17, 0.035);
  root.add(label);

  // 頭部の金具
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.02, 0.035, 10), metal);
  head.position.set(0, -0.02, 0.035);
  root.add(head);
  // 上部のハンドル（下側の固定グリップと上側のレバー）
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.012, 0.11), black);
  grip.position.set(0, -0.008, 0.06);
  root.add(grip);
  const lever = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.012, 0.1), black);
  lever.position.set(0, 0.012, 0.055);
  lever.rotation.x = -0.18;
  root.add(lever);
  // 圧力計
  const gauge = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.006, 12), white);
  gauge.rotation.z = Math.PI / 2;
  gauge.position.set(0.02, -0.025, 0.035);
  root.add(gauge);

  // ホース（本体の頭から前へ）
  const curve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0.0, -0.03, 0.02),
    new THREE.Vector3(0.035, -0.06, -0.01),
    new THREE.Vector3(0.03, -0.055, -0.08),
    new THREE.Vector3(0.0, -0.03, -0.13),
  ]);
  const hose = new THREE.Mesh(new THREE.TubeGeometry(curve, 16, 0.009, 6, false), black);
  root.add(hose);

  // ノズル（前に向かって開くラッパ形：噴射方向が一目で分かる）
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.01, 0.08, 12, 1, true), black);
  nozzle.material = black.clone();
  nozzle.material.side = THREE.DoubleSide;
  nozzle.rotation.x = -Math.PI / 2; // +Y 方向を -Z 方向へ
  nozzle.position.set(0, -0.03, -0.17);
  root.add(nozzle);

  // 噴射口（ここの位置と -Z 方向から消火剤が出る）
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, -0.03, -0.215);
  root.add(muzzle);

  return { root, muzzle };
}
