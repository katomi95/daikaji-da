// バランス確認用のシミュレーション（ブラウザ不要）。
//   node tools/sim.mjs [試行回数]
// 本番と同じ js/logic.js を動かし、プレイヤーの消し方（方針）ごとに勝率・時間を集計する。
// プレイヤーモデル：首を振る速さに上限があり、狙いを合わせるのに少し時間がかかり、
// 視界の外で出た炎は着火音を聞いてから少し遅れて気づく。命中率も100%ではない。
import { FireLogic, CONFIG } from '../js/logic.js';

const N = Number(process.argv[2] || 400);
// 例: node tools/sim.mjs 300 '{"growthMax":3}'  … CONFIG を一時的に上書きして試す
if (process.argv[3]) Object.assign(CONFIG, JSON.parse(process.argv[3]));
const DT = 1 / 72;

// 再現できる乱数
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const angOf = (f) => (Math.atan2(f.position.x, -f.position.z) * 180) / Math.PI;
const angDiff = (a, b) => Math.abs(a - b);

const SKILL = process.env.SKILL || 'normal';
const PLAYER = {
  turnSpeed: 170,     // 度/秒
  settle: 0.35,       // 向いてから狙いが合うまで(秒)
  hitRate: 0.85,      // 狙いが合っている間に実際に当たっている割合
  fov: 50,            // これより外の炎は見えていない（±度）
  notice: 1.4,        // 視界外の炎に気づくまで(秒)
  firstLook: 1.0,     // 出火直後、状況を把握するまで(秒)
};
// SKILL=novice : 初見で慣れていない人（振り向きが遅く、狙いが甘い）
if (SKILL === 'novice') Object.assign(PLAYER, { turnSpeed: 110, settle: 0.6, hitRate: 0.7, notice: 2.2, firstLook: 2.0 });

const POLICIES = {
  // 何もしない
  idle: () => null,
  // いま向いている方向から近い順（首を振る量が最小）
  nearestAim: (known, p) => minBy(known, (f) => angDiff(angOf(f), p.aim)),
  // プレイヤーから物理的に近い順
  nearestDist: (known) => minBy(known, (f) => Math.hypot(f.position.x, f.position.z)),
  // 適当：ランダムに選んで消えるまで当てる
  random: (known, p, rng) => known[Math.floor(rng() * known.length)],
  careless: (known, p, rng) => known[Math.floor(rng() * known.length)],
  // 小さい火から（数を減らす）
  smallest: (known) => minBy(known, (f) => f.intensity),
  // 大きい火から（延焼を止める）
  largest: (known) => maxBy(known, (f) => f.intensity),
  // 考えて消す：基本は向いている方向から順に片付けるが、火勢65以上（延焼が速くなる手前）の炎があれば
  // 首を振ってでもそちらを先に叩く
  smart: (known, p) => {
    const big = known.filter((f) => f.intensity >= 65);
    const pool = big.length ? big : known;
    return minBy(pool, (f) => angDiff(angOf(f), p.aim) - (big.length ? f.intensity : 0));
  },
};
// 慌てて適当に消す人：ランダムに選び、消し切る前に別の火へ移ってしまう。命中率も低い
const CARELESS = { switchAfter: [1.2, 3.5], hitRate: 0.7 };

function minBy(a, fn) { let b = null, bv = Infinity; for (const x of a) { const v = fn(x); if (v < bv) { bv = v; b = x; } } return b; }
function maxBy(a, fn) { return minBy(a, (x) => -fn(x)); }

function runOne(policyName, seed) {
  const rng = mulberry32(seed);
  const prng = mulberry32(seed * 7919 + 13);
  const g = new FireLogic(CONFIG, rng);
  g.start();
  const p = { aim: 0, target: 0, settleLeft: 0, replan: 0 };
  const seenAt = new Map();
  let t = 0;
  let maxFires = 0;
  while (!g.ended && t < 600) {
    t += DT;
    // 気づいている炎
    const known = [];
    for (const f of g.fires) {
      if (!seenAt.has(f.id)) seenAt.set(f.id, g.time);
      const visible = angDiff(angOf(f), p.aim) <= PLAYER.fov;
      const age = g.time - seenAt.get(f.id);
      if (g.time < PLAYER.firstLook) continue;
      if (visible || age >= PLAYER.notice) known.push(f);
    }
    const cur = g.fires.find((f) => f.id === p.target);
    const careless = policyName === 'careless';
    p.replan -= DT;
    let next = cur;
    if (!cur || (careless && p.replan <= 0)) {
      next = known.length ? POLICIES[policyName](known, p, prng) : null;
      if (careless) p.replan = CARELESS.switchAfter[0] + prng() * (CARELESS.switchAfter[1] - CARELESS.switchAfter[0]);
    }
    if (next && next.id !== p.target) { p.target = next.id; p.settleLeft = PLAYER.settle; }
    if (!next) p.target = 0;

    let hit = 0;
    if (next) {
      const want = angOf(next);
      const d = want - p.aim;
      const stepA = PLAYER.turnSpeed * DT;
      if (Math.abs(d) > stepA) p.aim += Math.sign(d) * stepA;
      else {
        p.aim = want;
        if (p.settleLeft > 0) p.settleLeft -= DT;
        else if (prng() < (careless ? CARELESS.hitRate : PLAYER.hitRate)) hit = next.id;
      }
    }
    g.step(DT, hit);
    maxFires = Math.max(maxFires, g.fires.length);
  }
  return { won: g.state === 'won', time: g.endTime, reason: g.endReason, out: g.extinguished, spawned: g.spawned, maxFires };
}

const pct = (x) => `${(x * 100).toFixed(0).padStart(3)}%`;
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
console.log(`試行 ${N} 回 / 方針ごと\n`);
console.log('方針         勝率  勝ち平均時間  負け平均時間  発生数(平均)  最大同時  負け理由(数/合計)');
for (const name of Object.keys(POLICIES)) {
  const rs = [];
  for (let i = 0; i < N; i++) rs.push(runOne(name, 1000 + i));
  const w = rs.filter((r) => r.won), l = rs.filter((r) => !r.won);
  const avg = (a, k) => (a.length ? a.reduce((s, r) => s + r[k], 0) / a.length : 0);
  const byCount = l.filter((r) => r.reason === 'count').length;
  console.log(
    `${name.padEnd(12)} ${pct(w.length / N)}  ${w.length ? fmt(avg(w, 'time')).padStart(10) : '         -'}  ${l.length ? fmt(avg(l, 'time')).padStart(12) : '           -'}  ${avg(rs, 'spawned').toFixed(1).padStart(12)}  ${avg(rs, 'maxFires').toFixed(1).padStart(8)}  ${byCount}/${l.length - byCount}`,
  );
}
