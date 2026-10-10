// 効果音はすべて WebAudio で合成（音声ファイル不要）。
// AudioContext はブラウザの制約上、ボタンを押したタイミングで init() すること。
// 着火音・消火音は 3D 定位（PannerNode / HRTF）で鳴らし、視界の外の火元の方向が分かるようにする。
export class Sfx {
  constructor() {
    this.ctx = null;
  }

  init() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      const ctx = this.ctx;
      this.master = ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(ctx.destination);

      // 白色雑音のバッファ（いろいろな音の素）
      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

      // 「シューッ」：高域寄りに絞ってループ再生し、音量だけ上げ下げする
      const src = ctx.createBufferSource();
      src.buffer = this.noise;
      src.loop = true;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1800;
      const peak = ctx.createBiquadFilter();
      peak.type = 'peaking';
      peak.frequency.value = 4200;
      peak.gain.value = 6;
      this.sprayGain = ctx.createGain();
      this.sprayGain.gain.value = 0;
      src.connect(hp).connect(peak).connect(this.sprayGain).connect(this.master);
      src.start();

      // 「ゴーッ」：火災全体の規模に合わせて大きくなる低い唸り（定位なし）
      const rum = ctx.createBufferSource();
      rum.buffer = this.noise;
      rum.loop = true;
      rum.playbackRate.value = 0.5;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 380;
      this.rumbleGain = ctx.createGain();
      this.rumbleGain.gain.value = 0;
      rum.connect(lp).connect(this.rumbleGain).connect(this.master);
      rum.start();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  // 聞き手（頭）の位置と向きをカメラに合わせる。毎フレーム呼ぶ
  updateListener(camera) {
    if (!this.ctx) return;
    const L = this.ctx.listener;
    const e = camera.matrixWorld.elements;
    const px = e[12], py = e[13], pz = e[14];
    // 前 = -Z列、上 = +Y列
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const ux = e[4], uy = e[5], uz = e[6];
    if (L.positionX) {
      const t = this.ctx.currentTime;
      L.positionX.setValueAtTime(px, t); L.positionY.setValueAtTime(py, t); L.positionZ.setValueAtTime(pz, t);
      L.forwardX.setValueAtTime(fx, t); L.forwardY.setValueAtTime(fy, t); L.forwardZ.setValueAtTime(fz, t);
      L.upX.setValueAtTime(ux, t); L.upY.setValueAtTime(uy, t); L.upZ.setValueAtTime(uz, t);
    } else if (L.setPosition) {
      L.setPosition(px, py, pz);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  // ワールド座標 pos に置いた音の出口（使い捨て）
  panner(pos) {
    const p = this.ctx.createPanner();
    p.panningModel = 'HRTF';
    p.distanceModel = 'inverse';
    p.refDistance = 1.2;
    p.rolloffFactor = 0.8;
    if (p.positionX) {
      p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
    } else {
      p.setPosition(pos.x, pos.y, pos.z);
    }
    p.connect(this.master);
    return p;
  }

  setSpray(on) {
    if (!this.ctx) return;
    const g = this.sprayGain.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(on ? 0.3 : 0, t, on ? 0.03 : 0.08);
  }

  // 0..1：火災の規模
  setFireLevel(x) {
    if (!this.ctx) return;
    const v = x <= 0 ? 0 : 0.06 + 0.3 * Math.min(1, x);
    this.rumbleGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.4);
  }

  tone(freq, start, dur, type = 'sine', vol = 0.2, out = this.master) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    const t = ctx.currentTime + start;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // 着火：「ボッ」（雑音を低域に絞った短い破裂音＋低い胴鳴り）。火元の位置から鳴る
  ignite(pos) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.panner(pos);
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    n.playbackRate.value = 0.7;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(2400, t);
    f.frequency.exponentialRampToValueAtTime(300, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.9, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
    n.connect(f).connect(g).connect(out);
    n.start(t, Math.random() * 1.5);
    n.stop(t + 0.55);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.3);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.5, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
    o.connect(og).connect(out);
    o.start(t);
    o.stop(t + 0.4);
  }

  // 1つ消えた：「ジュッ」＋小さな澄んだ音
  out(pos) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const out = this.panner(pos);
    const n = ctx.createBufferSource();
    n.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 3200;
    f.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.35, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    n.connect(f).connect(g).connect(out);
    n.start(t, Math.random() * 1.5);
    n.stop(t + 0.45);
    this.tone(1318.5, 0.05, 0.3, 'triangle', 0.08, out);
  }

  // 開始：短い警報（大音量・連続にはしない）
  alarm() {
    if (!this.ctx) return;
    for (let i = 0; i < 3; i++) {
      this.tone(880, i * 0.36, 0.16, 'square', 0.07);
      this.tone(660, i * 0.36 + 0.18, 0.16, 'square', 0.07);
    }
  }

  // 完全鎮火：上がっていく音
  success() {
    if (!this.ctx) return;
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, i * 0.12, 0.6, 'triangle', 0.16));
  }

  // もうだめだ：下がっていく音
  fail() {
    if (!this.ctx) return;
    [392, 349.23, 311.13, 233.08].forEach((f, i) => this.tone(f, i * 0.22, 0.5, 'sawtooth', 0.06));
  }
}
