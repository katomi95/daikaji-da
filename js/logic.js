// ゲームロジック本体（炎の成長・延焼・消火・勝敗）。
// Three.js にも DOM にも依存しない純粋な JS。Quest / PCプレビュー / Node のシミュレーションで共通。
//
// 座標は「プレイ空間」：プレイヤーの開始位置の床が原点、開始時の正面が -Z、右が +X、上が +Y（単位 m）。
// 角度は正面 0°、右回りが +（右 = +90°、左 = -90°）。

export const CONFIG = {
  // --- 進行 ---
  startDelay: 1.0,        // 開始ボタンから出火までの秒数（XRの頭の位置が落ち着くのを待つ）
  graceTime: 8.0,         // 出火から延焼が始まるまでの猶予（秒）。この間も炎は成長する
  retryDelay: 1.5,        // 決着後、再スタートを受け付けるまでの秒数

  // --- 初期の炎（正面・左・右に1つずつ。火勢はシャッフルして割り当てる） ---
  initialAngles: [[-12, 12], [-95, -55], [55, 95]], // 角度の範囲（度）
  initialIntensity: [18, 30, 46],
  initialDist: [1.8, 2.5],   // プレイヤーからの水平距離(m)

  // --- 新たな出火（延焼とは別に、部屋のあちこちで火が出る。数か所ずつ「波」で来る） ---
  waves: [                   // at: 出火からの秒数, count: 同時に出る数
    { at: 15, count: 2 },
    { at: 30, count: 3 },
    { at: 46, count: 3 },
    { at: 62, count: 4 },
  ],
  waveWhenClear: 2.0,        // 炎が0になったら、次の波をこの秒数後に前倒しする
  waveIntensity: [12, 40],
  waveDist: [1.8, 2.8],

  // --- 成長 ---
  growthMin: 1.6,         // 火勢/秒 の下限（炎ごとにランダム）
  growthMax: 2.8,         // 火勢/秒 の上限
  growthAccelMin: 0.6,    // 火勢0での成長倍率。火勢50で1倍、100で(2-この値)倍になる
  sprayResumeDelay: 0.8,  // 消火剤が外れてから再び成長し始めるまでの秒数

  // --- 消火 ---
  extinguishRate: 16,     // 当て続けたときに 1秒で減る火勢（火勢30≈1.9秒・60≈3.8秒・100≈6.3秒）

  // --- 延焼 ---
  spreadMin: 40,          // この火勢以上で延焼が始まる
  spreadCooldownMin: 6,   // 延焼間隔（秒）の基準。炎ごと・延焼ごとにこの範囲でランダム
  spreadCooldownMax: 10,
  spreadTiers: [          // 火勢が高いほど延焼間隔が短くなる（上から順に判定）
    { min: 90, mult: 0.5 },
    { min: 70, mult: 0.72 },
    { min: 40, mult: 1.0 },
  ],
  spreadDecay: 0.5,       // 火勢が spreadMin 未満に下がったとき、延焼の溜まりが減る速さ（倍率）
  globalSpreadGap: 1.2,   // どこかで延焼してから、次の延焼が起こるまでの最短秒数（一斉発生を防ぐ）
  newFireIntensity: [10, 18],
  spreadDist: [0.8, 1.15], // 元の炎からの距離(m)
  spreadTries: 12,

  // --- 配置の制限 ---
  minSeparation: 0.75,    // 炎同士の最短距離(m)
  minRadius: 1.3,         // プレイヤーにこれより近い位置には出さない(m)
  maxRadius: 3.2,         // これより遠い位置には出さない（消火剤が届き、狙える距離）
  maxAngle: 140,          // 開始時の正面から左右何度までに出すか（真後ろは避け、着席でも振り向ける範囲）

  // --- 勝敗 ---
  loseCount: 20,          // 炎がこの数になったら「もうだめだ！」（＝同時に存在できる最大数）
  loseTotal: 900,         // 全部の炎の火勢の合計がこれを超えたら「もうだめだ！」

  // --- 当たり判定 ---
  sprayRange: 5.0,        // 消火剤が届く距離(m)
  hitRadius0: 0.16,       // 噴射口直後の当たり半径(m)
  hitSpread: 0.09,        // 1m 進むごとに広がる当たり半径(m)
};

// 炎の見た目の大きさ（当たり判定にも使うのでロジック側で定義する）
export const FIRE_HEIGHT = 0.72; // scale=1 のときの高さ(m)
export const FIRE_WIDTH = 0.62;
export function fireScale(intensity) {
  const p = Math.max(0, Math.min(100, intensity)) / 100;
  return { x: (0.35 + 0.95 * p) * (0.9 + 0.35 * p), y: 0.35 + 0.95 * p };
}

// 火勢の区分
export function tierOf(intensity) {
  if (intensity <= 0) return 'out';
  if (intensity <= 30) return 'small';
  if (intensity <= 60) return 'medium';
  return 'large';
}

const DEG = Math.PI / 180;
const rand = (rng, a, b) => a + (b - a) * rng();

export class FireLogic {
  constructor(config = CONFIG, rng = Math.random) {
    this.cfg = config;
    this.rng = rng;
    this.fires = [];
    this.events = [];
    this.state = 'idle'; // idle | waiting | burning | won | lost
    this.reset();
  }

  reset() {
    this.fires.length = 0;
    this.events.length = 0;
    this.nextId = 1;
    this.time = 0;          // 出火してからの経過秒（ゲーム内時計）
    this.stateTime = 0;
    this.lastSpreadTime = -1e9;
    this.extinguished = 0;  // 消した炎の数
    this.spawned = 0;       // 発生した炎の総数
    this.hitId = 0;         // いま消火剤が当たっている炎（0 = なし）
    this.hitPoint = null;
    this.endTime = 0;
    this.endReason = '';
    this.waveIndex = 0;      // 次に来る波
    this.nextWave = 0;       // 次の波の時刻
    this.waveShift = 0;      // 前倒しで早まった秒数の合計
  }

  start() {
    this.reset();
    this.state = 'waiting';
  }

  stop() {
    this.reset();
    this.state = 'idle';
  }

  get playing() { return this.state === 'waiting' || this.state === 'burning'; }
  get ended() { return this.state === 'won' || this.state === 'lost'; }
  get canRestart() { return this.ended && this.stateTime >= this.cfg.retryDelay; }

  totalIntensity() {
    let s = 0;
    for (const f of this.fires) s += f.intensity;
    return s;
  }

  // ---------- 1フレーム分の更新 ----------
  // ray: 噴射中なら { o:[x,y,z], d:[x,y,z] }（プレイ空間、d は正規化済み）。噴射していなければ null
  update(dt, ray) {
    this.hitId = 0;
    this.hitPoint = null;
    if (this.state === 'burning' && ray) {
      const h = this.findHit(ray);
      if (h) { this.hitId = h.id; this.hitPoint = h.point; }
    }
    this.step(dt, this.hitId);
  }

  // 当たっている炎の id を直接渡して進める（シミュレーション用にも使う）。
  // フレームレートに依存しないよう、大きな dt は分割する
  step(dt, hitId = 0) {
    let left = dt;
    while (left > 1e-6) {
      const h = Math.min(left, 0.05);
      left -= h;
      this.tick(h, hitId);
    }
  }

  tick(dt, hitId) {
    const c = this.cfg;
    this.stateTime += dt;

    if (this.state === 'waiting') {
      if (this.stateTime >= c.startDelay) this.ignite();
      return;
    }
    if (this.state !== 'burning') return;

    this.time += dt;
    const graceOver = this.time >= c.graceTime;

    // 1) 消火と成長
    for (let i = this.fires.length - 1; i >= 0; i--) {
      const f = this.fires[i];
      f.extinguishing = f.id === hitId;
      if (f.extinguishing) {
        f.intensity -= c.extinguishRate * dt;
        f.sinceSprayed = 0;
        if (f.intensity <= 0) {
          f.intensity = 0;
          this.fires.splice(i, 1);
          this.extinguished++;
          this.events.push({ type: 'out', fire: f });
        }
      } else {
        f.sinceSprayed += dt;
        if (f.sinceSprayed >= c.sprayResumeDelay) {
          // 大きい炎ほど速く育つ（放置するほど手に負えなくなる）
          const accel = c.growthAccelMin + (1 - c.growthAccelMin) * 2 * (f.intensity / 100);
          f.intensity = Math.min(100, f.intensity + f.growthRate * accel * dt);
        }
      }
    }

    // 2) すべて消えて、次の波も残っていなければ勝ち。
    //    延焼は生きている炎からしか起こらず、遅れて出る炎は波だけなので、
    //    ここで勝ちなら「新しい炎が出る可能性が残っていない」ことになる
    const wavesLeft = this.waveIndex < c.waves.length;
    if (this.fires.length === 0) {
      if (!wavesLeft) {
        this.finish('won', 'all-out');
        return;
      }
      this.nextWave = Math.min(this.nextWave, this.time + c.waveWhenClear);
    }

    // 2.5) 新たな出火の波
    if (wavesLeft && this.time >= this.nextWave) {
      // 前倒しした分だけ、以降の波も前にずらす
      this.waveShift += Math.max(0, this.nextWaveScheduled() - this.time);
      this.spawnWave(c.waves[this.waveIndex].count);
      this.waveIndex++;
      this.nextWave = this.nextWaveScheduled();
    }

    // 3) 延焼
    if (graceOver) {
      for (let i = 0; i < this.fires.length; i++) {
        const f = this.fires[i];
        if (f.extinguishing) continue; // 消火剤を浴びている間は延焼しない
        if (f.intensity >= c.spreadMin) {
          f.spreadCharge += dt / (f.spreadCooldown * this.spreadMult(f.intensity));
        } else {
          f.spreadCharge = Math.max(0, f.spreadCharge - dt * c.spreadDecay / f.spreadCooldown);
        }
        if (f.spreadCharge >= 1 && this.time - this.lastSpreadTime >= c.globalSpreadGap) {
          if (this.trySpread(f)) {
            f.spreadCharge = 0;
            f.lastSpreadTime = this.time;
            f.spreadCooldown = rand(this.rng, c.spreadCooldownMin, c.spreadCooldownMax);
            this.lastSpreadTime = this.time;
            if (this.fires.length >= c.loseCount) break;
          } else {
            // 置き場所が無かった：少し待ってからもう一度
            f.spreadCharge = 0.75;
          }
        }
      }
    }

    // 4) 負け判定
    if (this.fires.length >= c.loseCount) {
      this.finish('lost', 'count');
    } else if (this.totalIntensity() > c.loseTotal) {
      this.finish('lost', 'total');
    }
  }

  nextWaveScheduled() {
    const w = this.cfg.waves[this.waveIndex];
    return w ? w.at - this.waveShift : Infinity;
  }

  spreadMult(intensity) {
    for (const t of this.cfg.spreadTiers) if (intensity >= t.min) return t.mult;
    return 1;
  }

  finish(result, reason) {
    this.state = result;
    this.stateTime = 0;
    this.endTime = this.time;
    this.endReason = reason;
    this.hitId = 0;
    for (const f of this.fires) f.extinguishing = false;
    this.events.push({ type: result });
  }

  ignite() {
    const c = this.cfg;
    this.state = 'burning';
    this.stateTime = 0;
    this.time = 0;
    const ints = c.initialIntensity.slice();
    // 火勢の割り当てをシャッフル（毎回どこが大きいかが変わる）
    for (let i = ints.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [ints[i], ints[j]] = [ints[j], ints[i]];
    }
    c.initialAngles.forEach((range, i) => {
      const a = rand(this.rng, range[0], range[1]) * DEG;
      const d = rand(this.rng, c.initialDist[0], c.initialDist[1]);
      this.addFire(Math.sin(a) * d, -Math.cos(a) * d, ints[i % ints.length] + rand(this.rng, -3, 3), 0);
    });
    this.waveIndex = 0;
    this.nextWave = this.nextWaveScheduled();
    this.events.push({ type: 'start' });
  }

  // 左右の範囲を count 個の区画に分け、区画ごとに1つ出す（一か所に固まらず、あちこちに出る）
  spawnWave(count) {
    const c = this.cfg;
    const span = (c.maxAngle * 2) / count;
    const offset = this.rng() * span;
    for (let i = 0; i < count; i++) {
      if (this.fires.length >= c.loseCount) return; // 上限を超えては出さない
      for (let k = 0; k < c.spreadTries; k++) {
        const deg = -c.maxAngle + ((offset + i * span + rand(this.rng, -0.35, 0.35) * span + 2 * c.maxAngle) % (2 * c.maxAngle));
        const a = deg * DEG;
        const d = rand(this.rng, c.waveDist[0], c.waveDist[1]);
        const x = Math.sin(a) * d, z = -Math.cos(a) * d;
        if (this.placeOK(x, z)) {
          this.addFire(x, z, rand(this.rng, c.waveIntensity[0], c.waveIntensity[1]), 0);
          break;
        }
      }
    }
  }

  addFire(x, z, intensity, parentId) {
    const c = this.cfg;
    const f = {
      id: this.nextId++,
      position: { x, y: 0, z },
      intensity,
      growthRate: rand(this.rng, c.growthMin, c.growthMax),
      spreadCooldown: rand(this.rng, c.spreadCooldownMin, c.spreadCooldownMax),
      lastSpreadTime: this.time,
      spreadCharge: 0,
      extinguishing: false,
      sinceSprayed: 999,
      parentId,
      born: this.time,
    };
    this.fires.push(f);
    this.spawned++;
    this.events.push({ type: 'ignite', fire: f });
    return f;
  }

  // 置いてよい位置か
  placeOK(x, z) {
    const c = this.cfg;
    const r = Math.hypot(x, z);
    if (r < c.minRadius || r > c.maxRadius) return false;
    const ang = Math.atan2(x, -z) / DEG;
    if (Math.abs(ang) > c.maxAngle) return false;
    const min2 = c.minSeparation * c.minSeparation;
    for (const o of this.fires) {
      const dx = o.position.x - x, dz = o.position.z - z;
      if (dx * dx + dz * dz < min2) return false;
    }
    return true;
  }

  trySpread(src) {
    const c = this.cfg;
    for (let k = 0; k < c.spreadTries; k++) {
      const a = this.rng() * Math.PI * 2;
      const d = rand(this.rng, c.spreadDist[0], c.spreadDist[1]);
      const x = src.position.x + Math.cos(a) * d;
      const z = src.position.z + Math.sin(a) * d;
      if (this.placeOK(x, z)) {
        this.addFire(x, z, rand(this.rng, c.newFireIntensity[0], c.newFireIntensity[1]), src.id);
        return true;
      }
    }
    return false;
  }

  // ---------- 当たり判定 ----------
  // 円錐状の簡易判定：噴射の軸と、炎の中心軸（縦の線分）との距離で判定。
  // 複数に当たるときは一番狙いの合っている炎だけを消す（1つずつ消す＝順番がゲーム性になる）
  findHit(ray) {
    const c = this.cfg;
    let best = null;
    let bestScore = Infinity;
    for (const f of this.fires) {
      const s = fireScale(f.intensity);
      const h = Math.max(0.15, FIRE_HEIGHT * s.y);
      const r = rayToVertical(ray.o, ray.d, f.position.x, f.position.z, 0.03, h * 0.85);
      if (r.t <= 0 || r.t > c.sprayRange) continue;
      const allow = c.hitRadius0 + c.hitSpread * r.t + FIRE_WIDTH * 0.5 * s.x * 0.55;
      const score = r.dist / allow;
      if (score < 1 && score < bestScore) {
        bestScore = score;
        best = { id: f.id, point: r.point };
      }
    }
    return best;
  }
}

// 半直線 O + tD と、縦の線分 (x, y0..y1, z) の最短距離
function rayToVertical(O, D, x, z, y0, y1) {
  const ux = 0, uy = y1 - y0, uz = 0;
  const wx = O[0] - x, wy = O[1] - y0, wz = O[2] - z;
  const a = D[0] * D[0] + D[1] * D[1] + D[2] * D[2];
  const b = D[1] * uy;
  const cc = uy * uy;
  const d = D[0] * wx + D[1] * wy + D[2] * wz;
  const e = uy * wy;
  const den = a * cc - b * b;
  let s;
  if (den < 1e-8) s = Math.min(1, Math.max(0, e / cc));
  else s = Math.min(1, Math.max(0, (a * e - b * d) / den));
  const qx = x + ux * s, qy = y0 + uy * s, qz = z + uz * s;
  const t = Math.max(0, (D[0] * (qx - O[0]) + D[1] * (qy - O[1]) + D[2] * (qz - O[2])) / a);
  const px = O[0] + D[0] * t, py = O[1] + D[1] * t, pz = O[2] + D[2] * t;
  return { dist: Math.hypot(px - qx, py - qy, pz - qz), t, point: [qx, qy, qz] };
}
