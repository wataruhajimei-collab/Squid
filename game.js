'use strict';

/**
 * ============================================================================
 * SQUID (スクイッド) - ROGAN & WATCH WABISABI SCREEN (MODEL 1972-54)
 * Showa 80s Pocket LCD Game Tribute
 * With Cloudflare Global Ranking & Player Location Recording
 * ============================================================================
 */

// Cloudflare Worker API エンドポイント候補（同一オリジン `/api/scores` を最優先し、単体Worker URLへ自動フォールバック）
const API_ENDPOINTS = [
  '/api/scores',
  'https://squid.wataruhajimei.workers.dev/api/scores',
  'https://squid-api.wataruhajimei.workers.dev'
];

const STORAGE_KEYS = {
  NAME: 'squid_gw_player_name',
  PLACE: 'squid_gw_player_place',
  PLAYER_ID: 'squid_gw_player_id',
  HIGH_A: 'squid_gw_high_a',
  HIGH_B: 'squid_gw_high_b',
  HIGH_C: 'squid_gw_high_c',
  LOCAL_LB: 'squid_gw_local_leaderboard',
  SOUND: 'squid_gw_sound_on'
};

// 国コード (ISO 3166-1 alpha-2) -> 国旗絵文字
function countryToFlag(code) {
  if (!code || typeof code !== 'string' || code.length !== 2) return '🌐';
  const upper = code.toUpperCase();
  if (upper === 'XX' || upper === 'T1') return '🌐';
  return String.fromCodePoint(
    0x1F1E6 + (upper.charCodeAt(0) - 65),
    0x1F1E6 + (upper.charCodeAt(1) - 65)
  );
}

// プレイヤー固有IDの取得・生成
function getOrCreatePlayerId() {
  try {
    let id = localStorage.getItem(STORAGE_KEYS.PLAYER_ID);
    if (!id) {
      id = 'sq_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 10);
      localStorage.setItem(STORAGE_KEYS.PLAYER_ID, id);
    }
    return id;
  } catch (_) {
    return 'sq_guest_' + Math.floor(Math.random() * 1000000);
  }
}

/* ============================================================================
   1. PIEZO BUZZER SOUND ENGINE (Web Audio API による1981年LSIピエゾ圧電ブザー音再現)
   ============================================================================ */
class PiezoSoundEngine {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    try {
      const saved = localStorage.getItem(STORAGE_KEYS.SOUND);
      if (saved === '0') this.enabled = false;
    } catch (_) {}
  }

  init() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  beep(freq = 880, duration = 0.035, delay = 0, type = 'square', gainVal = 0.09) {
    if (!this.enabled) return;
    this.init();
    if (!this.ctx) return;

    try {
      const now = this.ctx.currentTime + delay;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);

      gain.gain.setValueAtTime(gainVal, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + duration);

      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(now);
      osc.stop(now + duration + 0.005);
    } catch (_) {}
  }

  // イカの足が伸び縮みするクロック音（本家特有の「プッ…プッ…」）
  tick(alt = false) {
    this.beep(alt ? 440 : 495, 0.022, 0, 'square', 0.055);
  }

  // 潜水夫の移動音（「ピッ」）
  step() {
    this.beep(987, 0.03, 0, 'square', 0.085);
  }

  // 宝箱から財宝を1個掴んだ時の音（「ピピッ！」+1点）
  grabTreasure() {
    this.beep(1318, 0.035, 0, 'square', 0.095);
    this.beep(1760, 0.045, 0.04, 'square', 0.095);
  }

  // 船に生還して+3点ボーナスが入る時のカウント音（「ピ・ピ・ピ！」）
  boatBonusTick(stepIdx) {
    const freqs = [1568, 1760, 2093];
    this.beep(freqs[stepIdx % 3], 0.05, 0, 'square', 0.1);
  }

  // イカの足に捕まってバタバタもがく時の警告ブザー音
  caughtFlail(frame) {
    this.beep(frame % 2 === 0 ? 932 : 587, 0.09, 0, 'square', 0.11);
  }

  // 200点 / 500点 ライフ全回復ボーナスファンファーレ
  bonusLifeFanfare() {
    const notes = [1046, 1318, 1568, 2093, 1568, 2093];
    notes.forEach((f, i) => {
      this.beep(f, 0.07, i * 0.085, 'square', 0.11);
    });
  }

  // ゲーム開始音
  gameStart() {
    this.beep(1046, 0.045, 0, 'square', 0.09);
    this.beep(1568, 0.065, 0.055, 'square', 0.09);
  }
}

/* ============================================================================
   2. MAIN GAME ENGINE (SQUID - MODEL 1972-54 Mechanics + LCD Renderer)
   ============================================================================ */
class SquidGameWatch {
  constructor() {
    this.canvas = document.getElementById('lcdCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.sound = new PiezoSoundEngine();

    // モード状態: 'TIME' (時計&デモ画面), 'PLAYING', 'CAUGHT' (捕まりバタバタ中), 'UNLOADING' (船上+3点演出中), 'BONUS' (200/500点復活演出), 'GAMEOVER'
    this.state = 'TIME';
    this.gameMode = 'A'; // 'A', 'B', or 'C'

    // スコア＆統計
    this.score = 0;
    this.bagsReturned = 0;
    this.treasuresGrabbed = 0;
    this.highScoreA = Number(localStorage.getItem(STORAGE_KEYS.HIGH_A) || 0);
    this.highScoreB = Number(localStorage.getItem(STORAGE_KEYS.HIGH_B) || 0);
    this.highScoreC = Number(localStorage.getItem(STORAGE_KEYS.HIGH_C) || 0);

    // 残機（最大3人：1人が海中、残り2人が船上に待機）
    this.lives = 3;
    this.bonus200Triggered = false;
    this.bonus500Triggered = false;

    // 潜水夫の状態
    // pos: 0=船上, 1=船の下のロープ(安全地帯), 2=海底左(足1), 3=海底中左(足2), 4=海底中右(足3), 5=宝箱前(足4)
    this.diverPos = 0;
    this.hasBag = false;      // 財宝を1個以上持っているか
    this.grabAnimPhase = 0;   // 宝箱前(pos=5)で宝を掴む腕アニメーション (0:通常, 1:宝箱に手を入れる, 2:袋に詰める)
    this.grabAnimTimer = 0;

    // 船上への生還ボーナス(+3点)アニメーション用
    this.unloadTicksLeft = 0;
    this.unloadTimer = 0;

    // 捕まった時のバタバタ演出用
    this.caughtTentacleIdx = -1;
    this.caughtFlailTicks = 0;
    this.caughtTimer = 0;

    // 200/500点ボーナス演出用
    this.bonusTimer = 0;

    // 巨大イカ（スクイッド）の4本の触腕
    // 足0(左): 最大4セグメント -> pos 2 を攻撃
    // 足1(中左): 最大5セグメント -> pos 3 を攻撃
    // 足2(中右): 最大4セグメント -> pos 4 を攻撃
    // 足3(右/宝箱): 最大3セグメント -> pos 5 を攻撃
    this.tentacles = [
      { maxLen: 4, len: 1, dir: 1, wait: 0 },
      { maxLen: 5, len: 2, dir: 1, wait: 0 },
      { maxLen: 4, len: 1, dir: -1, wait: 0 },
      { maxLen: 3, len: 0, dir: 1, wait: 0 }
    ];

    this.tickTimer = 0;
    this.tickCount = 0;
    this.demoAiTimer = 0;

    // プレイヤー情報 & 位置情報
    const savedName = localStorage.getItem(STORAGE_KEYS.NAME) || '';
    this.playerName = (savedName && savedName !== 'DIVER') ? savedName : '';
    this.hasConfirmedName = Boolean(this.playerName);
    this.customPlace = localStorage.getItem(STORAGE_KEYS.PLACE) || '';
    this.detectedGeo = {
      city: '',
      region: '',
      country: 'JP',
      display: 'Detecting...'
    };
    this.activeApiUrl = null;
    this.currentLbTab = 'player';
    this.currentLbFilter = 'ALL';

    this._lastTime = performance.now();
    this._initBioSquidAndBubbles();
    this._bindUI();
    this._initStartModal();
    this._updateProfilePill();
    this._detectPlayerLocation();
    this._resetDemoState();

    requestAnimationFrame(ts => this._loop(ts));
  }

  // GAME C 専用：活イカの透明〜赤茶マダラ色素胞（クロマトフォア）配列＆リアル気泡物理の初期化
  _initBioSquidAndBubbles() {
    this.bioTime = 0;
    this.squidFlushBoost = 0; // 攻撃時・捕獲時に色素胞が一気に赤茶色に集約・興奮するブースト値
    this.bubbles = [];
    this.surfaceRipples = [];
    this.bubbleSpawnTimer = 0;

    // 擬似乱数（決定論的シードで毎回美しいマダラ模様を生成）
    let seed = 19810722;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed & 0x0fffffff) / 0x10000000;
    };

    // 空間的な「マダラ模様（斑紋クラスタ）」強度を計算するマルチスケール波関数 (0.0〜1.0)
    const mottleField = (x, y) => {
      const n1 = Math.sin(x * 0.095 + y * 0.065) * Math.cos(x * 0.055 - y * 0.11);
      const n2 = Math.sin(x * 0.21 - y * 0.17 + 1.4) * 0.5;
      const n3 = Math.cos(x * 0.34 + y * 0.29 - 0.8) * 0.25;
      return Math.max(0, Math.min(1, (n1 + n2 + n3 + 1.25) / 2.5));
    };

    // 1. 外套膜・エンペラ・頭部用の色素胞セル（約185個）
    this.mantleChromatophores = [];
    for (let i = 0; i < 185; i++) {
      // 外套膜ポリゴン (x: 492..696, y: 92..228) 全域に分布（描画時は厳密にポリゴンでclipされる）
      const x = 492 + rand() * 204;
      const y = 92 + rand() * 136;
      const mottle = mottleField(x, y);
      // 4段階のリアルな色素胞カラー階層 (0:濃暗赤褐, 1:赤茶マダラ主色, 2:鮮赤褐色, 3:黄褐・琥珀色)
      const rVal = rand();
      const tier = rVal < 0.28 ? 0 : (rVal < 0.68 ? 1 : (rVal < 0.90 ? 2 : 3));
      this.mantleChromatophores.push({
        x,
        y,
        // 透明収縮時は0.55〜1.0pxの極小点、拡張集約時はマダラ斑の中心ほど大きく(2.6〜6.2px)広がる
        baseR: 0.52 + rand() * 0.48,
        maxR: (2.1 + rand() * 2.8) * (0.65 + mottle * 0.78),
        mottle,
        tier,
        phase: rand() * Math.PI * 2,
        aspect: 0.72 + rand() * 0.55,
        angle: (rand() - 0.5) * 1.2
      });
    }

    // 2. 触腕セグメント用の色素胞セル（正規化座標 u:0..1, v:-0.9..0.9 に34個）
    this.tentacleChromatophores = [];
    for (let i = 0; i < 34; i++) {
      const u = 0.04 + rand() * 0.92;
      const v = (rand() * 1.76) - 0.88;
      const mottle = Math.max(0, Math.min(1, (Math.sin(u * 14 + v * 4) * Math.cos(u * 7 - v * 6) + 1) * 0.55));
      const rVal = rand();
      const tier = rVal < 0.30 ? 0 : (rVal < 0.72 ? 1 : (rVal < 0.92 ? 2 : 3));
      this.tentacleChromatophores.push({
        u,
        v,
        baseR: 0.45 + rand() * 0.4,
        maxR: (1.8 + rand() * 2.3) * (0.65 + mottle * 0.75) * (1.08 - u * 0.35),
        mottle,
        tier,
        phase: rand() * Math.PI * 2
      });
    }

    // GAME C: 袋に詰めた金貨の量・袋の揺れ・飛び交う金貨パーティクル・船上荷下ろし演出
    this.bagGoldCount = 0;
    this.visualBagGold = 0;
    this.bagGoldRipple = 0;
    this.bagStuffBounce = 0;
    this.goldCoinsInFlight = [];
    this.unloadElapsed = 0;
    this.unloadStartGold = 0;
    this.demoUnloadTimer = 0;
    this.boatUnloadParticles = [];
    this.boatDeckCoins = [];

    // GAME C: 流れる多層雲・羽ばたく海鳥・星空・季節＆天候パーティクル・海中魚群・リアル海藻
    this.skyClouds = [
      { x: 75,  y: 28, rx: 56, ry: 14, speed: 6.5,  layer: 0, puffs: [[-24, 3, 0.72], [0, -2, 1.0], [26, 4, 0.78]] },
      { x: 215, y: 48, rx: 68, ry: 15, speed: 9.2,  layer: 1, puffs: [[-30, 4, 0.76], [-4, -3, 1.0], [24, 2, 0.84], [44, 6, 0.62]] },
      { x: 385, y: 34, rx: 52, ry: 13, speed: 5.8,  layer: 0, puffs: [[-20, 2, 0.75], [4, -2, 0.96], [25, 3, 0.72]] },
      { x: 520, y: 54, rx: 64, ry: 15, speed: 11.4, layer: 1, puffs: [[-28, 3, 0.80], [0, -3, 1.0], [28, 3, 0.82]] },
      { x: 660, y: 38, rx: 58, ry: 14, speed: 7.8,  layer: 0, puffs: [[-22, 3, 0.74], [2, -2, 0.98], [26, 4, 0.76]] }
    ];

    // 空を飛ぶ多彩なキャラクター群（全24種類・26体：カモメ、ペリカン、アホウドリ、アオサギ、渡り鳥V字編隊、カワセミ、ツバメ、赤トンボ、アゲハ蝶、フクロウ、コウモリ、複葉機、飛行船、熱気球、フラミンゴ、ハクトウワシ、コンゴウインコ、UFO、トビ、オオハシ、気象観測気球、プテラノドン、花火、ペガサス）
    this.skyBirds = [
      { kind: 'seagull',         x: 175, y: 32, vx: 22.0,  vy: 0.4, wingSpeed: 7.5,  phase: 0.0, scale: 0.96, activeTime: 'all' },
      { kind: 'seagull',         x: 154, y: 42, vx: 21.5,  vy: 0.3, wingSpeed: 7.8,  phase: 1.2, scale: 0.82, activeTime: 'all' },
      { kind: 'pelican',         x: 410, y: 48, vx: -18.5, vy: 0.25, wingSpeed: 5.2, phase: 0.8, scale: 1.08, activeTime: 'all' },
      { kind: 'albatross',       x: 565, y: 20, vx: -25.0, vy: 0.18, wingSpeed: 3.1, phase: 2.1, scale: 1.16, activeTime: 'all' },
      { kind: 'heron',           x: 88,  y: 56, vx: 19.5,  vy: 0.22, wingSpeed: 4.8, phase: 3.4, scale: 1.02, activeTime: 'all' },
      { kind: 'goose_flock',     x: 625, y: 26, vx: -21.0, vy: 0.15, wingSpeed: 6.4, phase: 1.5, scale: 0.82, activeTime: 'all' },
      { kind: 'kingfisher',      x: 278, y: 76, vx: 42.0,  vy: 0.6, wingSpeed: 14.5, phase: 0.5, scale: 0.85, activeTime: 'all' },
      { kind: 'swallow',         x: 485, y: 64, vx: -36.0, vy: 0.8, wingSpeed: 12.8, phase: 2.7, scale: 0.88, activeTime: 'all' },
      { kind: 'dragonfly',       x: 238, y: 72, vx: 17.5,  vy: 0.5, wingSpeed: 24.0, phase: 1.1, scale: 0.92, activeTime: 'all' },
      { kind: 'butterfly',       x: 348, y: 68, vx: -14.0, vy: 0.9, wingSpeed: 9.5,  phase: 4.0, scale: 0.92, activeTime: 'all' },
      { kind: 'owl',             x: 520, y: 38, vx: -19.5, vy: 0.3, wingSpeed: 5.6,  phase: 0.9, scale: 1.00, activeTime: 'night' },
      { kind: 'bat',             x: 215, y: 46, vx: 28.0,  vy: 0.9, wingSpeed: 13.5, phase: 2.2, scale: 0.88, activeTime: 'night' },
      { kind: 'biplane',         x: 665, y: 22, vx: -18.5, vy: 0.08, wingSpeed: 28.0, phase: 0.0, scale: 0.84, activeTime: 'all' },
      { kind: 'blimp',           x: 46,  y: 18, vx: 9.5,   vy: 0.04, wingSpeed: 2.0,  phase: 1.7, scale: 0.86, activeTime: 'all' },
      { kind: 'hot_air_balloon', x: 312, y: 24, vx: 6.2,   vy: 0.12, wingSpeed: 1.6,  phase: 0.4, scale: 0.92, activeTime: 'all' },
      { kind: 'flamingo',        x: 445, y: 54, vx: 20.5,  vy: 0.22, wingSpeed: 5.8,  phase: 2.5, scale: 0.96, activeTime: 'all' },
      { kind: 'eagle',           x: 125, y: 24, vx: 24.0,  vy: 0.20, wingSpeed: 4.2,  phase: 1.9, scale: 1.06, activeTime: 'all' },
      { kind: 'macaw',           x: 382, y: 60, vx: -26.5, vy: 0.45, wingSpeed: 9.2,  phase: 3.1, scale: 0.90, activeTime: 'all' },
      { kind: 'ufo',             x: 690, y: 14, vx: -32.0, vy: 0.35, wingSpeed: 12.0, phase: 5.1, scale: 0.82, activeTime: 'night' },
      { kind: 'black_kite',      x: 190, y: 36, vx: 21.0,  vy: 0.25, wingSpeed: 3.8, phase: 1.6, scale: 1.02, activeTime: 'all' },
      { kind: 'toucan',          x: 430, y: 62, vx: -23.0, vy: 0.35, wingSpeed: 7.2, phase: 2.8, scale: 0.95, activeTime: 'all' },
      { kind: 'weather_balloon', x: 110, y: 16, vx: 5.5,   vy: 0.05, wingSpeed: 1.4, phase: 0.8, scale: 0.88, activeTime: 'all' },
      { kind: 'pterosaur',       x: 640, y: 28, vx: -29.0, vy: 0.28, wingSpeed: 4.5, phase: 4.2, scale: 1.05, activeTime: 'all' },
      { kind: 'firework_rocket', x: 260, y: 20, vx: 18.0,  vy: 0.50, wingSpeed: 22.0,phase: 0.0, scale: 0.85, activeTime: 'night' },
      { kind: 'pegasus',         x: 580, y: 22, vx: -24.0, vy: 0.20, wingSpeed: 6.2, phase: 3.0, scale: 1.00, activeTime: 'all' }
    ];

    this.skyStars = [];
    for (let i = 0; i < 48; i++) {
      const u1 = ((i * 73 + 19) % 97) / 97;
      const u2 = ((i * 41 + 53) % 89) / 89;
      this.skyStars.push({
        x: 12 + u1 * 696,
        y: 6 + u2 * 88,
        r: 0.7 + (i % 3) * 0.45,
        twinkleSpeed: 2.0 + (i % 5) * 0.7,
        phase: i * 1.13
      });
    }

    // 季節・天候パーティクル（春の桜花びら・秋の紅葉・冬の雪結晶・雨粒）
    this.weatherParticles = [];
    for (let i = 0; i < 42; i++) {
      this.weatherParticles.push({
        x: rand() * 720,
        y: rand() * 115,
        vx: -14 - rand() * 18,
        vy: 18 + rand() * 22,
        rot: rand() * Math.PI * 2,
        rotSpeed: (rand() - 0.5) * 4.5,
        size: 2.5 + rand() * 2.8,
        phase: rand() * Math.PI * 2
      });
    }

    // 海中を回遊する多彩な海洋生物（全30種・32体＋海底生物4種：イワシ銀鱗群・カクレクマノミ・ツノダシ・チョウチョウウオ・ウミガメ・マンタ・クラゲ・タツノオトシゴ・ハリセンボン・イルカ・サメ・マンボウ・チョウチンアンコウ・オウムガイ・トビウオ・クジラ・シャチ・メカジキ・マダラトビエイ・ハコフグ・メンダコ・ウツボ・シュモクザメ・クリオネ・ジンベエザメ・カジキマグロ・リュウグウノツカイ・シーラカンス・潜水球・マーメイド）
    this.underwaterFish = [
      { kind: 'sardine_school', x: 235, y: 162, vx: 22.0,  scale: 0.90, phase: 0.0, hue: 198, fg: false },
      { kind: 'clownfish',      x: 165, y: 315, vx: 15.5,  scale: 0.95, phase: 0.6, hue: 22,  fg: true },
      { kind: 'clownfish',      x: 146, y: 326, vx: 15.5,  scale: 0.78, phase: 1.9, hue: 24,  fg: true },
      { kind: 'angelfish',      x: 335, y: 268, vx: -16.5, scale: 0.98, phase: 1.2, hue: 48,  fg: true },
      { kind: 'butterflyfish',  x: 475, y: 308, vx: -15.5, scale: 0.92, phase: 2.4, hue: 52,  fg: true },
      { kind: 'sea_turtle',     x: 545, y: 205, vx: -14.5, scale: 1.12, phase: 0.4, hue: 142, fg: false },
      { kind: 'manta_ray',      x: 195, y: 228, vx: 17.5,  scale: 1.16, phase: 2.1, hue: 215, fg: false },
      { kind: 'jellyfish',      x: 290, y: 218, vx: 5.2,   scale: 0.96, phase: 0.8, hue: 192, fg: true },
      { kind: 'jellyfish',      x: 435, y: 262, vx: -4.5,  scale: 0.84, phase: 3.1, hue: 285, fg: true },
      { kind: 'seahorse',       x: 118, y: 342, vx: 4.5,   scale: 0.96, phase: 1.5, hue: 38,  fg: true },
      { kind: 'pufferfish',     x: 388, y: 328, vx: 12.0,  scale: 0.96, phase: 2.8, hue: 44,  fg: true },
      { kind: 'dolphin',        x: 610, y: 138, vx: -34.0, scale: 1.12, phase: 0.3, hue: 205, fg: false },
      { kind: 'shark',          x: 590, y: 278, vx: -22.0, scale: 1.10, phase: 1.7, hue: 210, fg: true },
      { kind: 'sunfish',        x: 78,  y: 256, vx: 10.5,  scale: 1.12, phase: 3.6, hue: 196, fg: true },
      { kind: 'anglerfish',     x: 515, y: 352, vx: -10.5, scale: 0.95, phase: 4.2, hue: 265, fg: true },
      { kind: 'nautilus',       x: 225, y: 348, vx: -9.5,  scale: 0.92, phase: 5.0, hue: 18,  fg: true },
      { kind: 'flying_fish',    x: 65,  y: 122, vx: 42.0,  scale: 0.92, phase: 0.9, hue: 195, fg: false },
      { kind: 'whale',          x: 380, y: 154, vx: -11.5, scale: 1.18, phase: 1.1, hue: 212, fg: false },
      { kind: 'orca',           x: 495, y: 176, vx: 26.0,  scale: 1.08, phase: 2.6, hue: 220, fg: false },
      { kind: 'swordfish',      x: 150, y: 146, vx: 36.0,  scale: 1.02, phase: 0.7, hue: 202, fg: false },
      { kind: 'eagle_ray',      x: 272, y: 292, vx: -19.0, scale: 1.04, phase: 3.3, hue: 208, fg: true },
      { kind: 'boxfish',        x: 318, y: 368, vx: 11.5,  scale: 0.92, phase: 1.8, hue: 48,  fg: true },
      { kind: 'mini_octopus',   x: 455, y: 344, vx: -8.5,  scale: 0.94, phase: 2.9, hue: 8,   fg: true },
      { kind: 'moray_eel',      x: 188, y: 374, vx: 13.0,  scale: 0.96, phase: 4.4, hue: 135, fg: true },
      { kind: 'hammerhead',     x: 620, y: 235, vx: -20.5, scale: 1.08, phase: 1.4, hue: 215, fg: true },
      { kind: 'clione',         x: 360, y: 210, vx: 3.8,   scale: 0.90, phase: 3.7, hue: 190, fg: true },
      { kind: 'whale_shark',    x: 120, y: 185, vx: 9.8,   scale: 1.25, phase: 0.5, hue: 225, fg: false },
      { kind: 'oarfish',        x: 530, y: 330, vx: -12.0, scale: 1.15, phase: 2.2, hue: 345, fg: true },
      { kind: 'coelacanth',     x: 210, y: 360, vx: 8.5,   scale: 0.98, phase: 4.8, hue: 230, fg: true },
      { kind: 'bathysphere',    x: 420, y: 275, vx: -4.2,  scale: 0.92, phase: 1.9, hue: 45,  fg: false },
      { kind: 'mermaid',        x: 670, y: 310, vx: -14.5, scale: 0.96, phase: 5.5, hue: 160, fg: true }
    ];

    this._resetCreatureDiscovery();

    this.marineSnow = [];
    for (let i = 0; i < 36; i++) {
      this.marineSnow.push({
        x: 20 + rand() * 680,
        y: 118 + rand() * 320,
        r: 0.7 + rand() * 1.2,
        speedY: 3.5 + rand() * 5.5,
        phase: rand() * Math.PI * 2
      });
    }

    // 海底の超リアルな揺れる海藻（ジャイアントケルプ・カジメ・紅藻）の株データ
    this.kelpPlants = [
      { baseX: 74,  baseY: 422, height: 108, blades: 11, hue: 96,  sat: 64, light: 28, freq: 1.45, phase: 0.2, kind: 'kelp' },
      { baseX: 92,  baseY: 425, height: 76,  blades: 8,  hue: 122, sat: 58, light: 24, freq: 1.68, phase: 1.4, kind: 'kelp' },
      { baseX: 112, baseY: 426, height: 58,  blades: 7,  hue: 348, sat: 62, light: 30, freq: 1.85, phase: 2.7, kind: 'red' },
      { baseX: 252, baseY: 438, height: 118, blades: 12, hue: 88,  sat: 68, light: 30, freq: 1.38, phase: 0.9, kind: 'kelp' },
      { baseX: 268, baseY: 440, height: 84,  blades: 9,  hue: 114, sat: 56, light: 25, freq: 1.62, phase: 2.1, kind: 'kelp' },
      { baseX: 374, baseY: 442, height: 124, blades: 13, hue: 102, sat: 65, light: 27, freq: 1.32, phase: 1.7, kind: 'kelp' },
      { baseX: 392, baseY: 444, height: 74,  blades: 8,  hue: 42,  sat: 72, light: 32, freq: 1.74, phase: 3.3, kind: 'amber' },
      { baseX: 500, baseY: 440, height: 112, blades: 11, hue: 92,  sat: 62, light: 26, freq: 1.48, phase: 2.8, kind: 'kelp' },
      { baseX: 516, baseY: 442, height: 68,  blades: 8,  hue: 352, sat: 58, light: 28, freq: 1.90, phase: 4.1, kind: 'red' },
      { baseX: 598, baseY: 440, height: 92,  blades: 10, hue: 108, sat: 60, light: 26, freq: 1.54, phase: 3.9, kind: 'kelp' }
    ];
  }

  _initStartModal() {
    const startNameIn = document.getElementById('start-name-input');
    const startPlaceIn = document.getElementById('start-place-input');
    if (startNameIn) startNameIn.value = this.playerName;
    if (startPlaceIn) startPlaceIn.value = this.customPlace;
  }

  openStartModal() {
    const startModal = document.getElementById('start-modal');
    const startNameIn = document.getElementById('start-name-input');
    const startPlaceIn = document.getElementById('start-place-input');
    const errEl = document.getElementById('start-name-error');
    if (startNameIn) {
      startNameIn.value = this.playerName;
      startNameIn.classList.remove('input-shake');
    }
    if (startPlaceIn) startPlaceIn.value = this.customPlace;
    if (errEl) errEl.classList.add('hidden');
    startModal?.classList.remove('hidden');
    setTimeout(() => startNameIn?.focus(), 60);
  }

  /* --------------------------------------------------------------------------
     UI Event Bindings & Controls
     -------------------------------------------------------------------------- */
  _bindUI() {
    const btnLeft = document.getElementById('btn-left');
    const btnRight = document.getElementById('btn-right');
    const btnGameA = document.getElementById('btn-game-a');
    const btnGameB = document.getElementById('btn-game-b');
    const btnGameC = document.getElementById('btn-game-c');
    const btnTime = document.getElementById('btn-time');
    const lcdTouchZone = document.getElementById('lcd-touch-zone');

    // タッチとマウスの二重発火防止ヘルパー
    const bindFastTap = (el, handler) => {
      if (!el) return;
      let lastTouch = 0;
      el.addEventListener('touchstart', (e) => {
        e.preventDefault();
        lastTouch = Date.now();
        el.classList.add('pressed');
        handler(e);
      }, { passive: false });
      el.addEventListener('touchend', () => el.classList.remove('pressed'));
      el.addEventListener('touchcancel', () => el.classList.remove('pressed'));
      el.addEventListener('mousedown', (e) => {
        if (Date.now() - lastTouch < 500) return;
        el.classList.add('pressed');
        handler(e);
      });
      el.addEventListener('mouseup', () => el.classList.remove('pressed'));
      el.addEventListener('mouseleave', () => el.classList.remove('pressed'));
    };

    bindFastTap(btnLeft, () => this.handleInput('LEFT'));
    bindFastTap(btnRight, () => this.handleInput('RIGHT'));

    // 液晶画面自体の左右タップでも操作可能
    if (lcdTouchZone) {
      let lastTouch = 0;
      const onLcdTap = (clientX) => {
        const rect = lcdTouchZone.getBoundingClientRect();
        const relX = clientX - rect.left;
        if (relX < rect.width * 0.48) {
          this.handleInput('LEFT');
        } else {
          this.handleInput('RIGHT');
        }
      };
      lcdTouchZone.addEventListener('touchstart', (e) => {
        e.preventDefault();
        lastTouch = Date.now();
        if (e.touches && e.touches[0]) onLcdTap(e.touches[0].clientX);
      }, { passive: false });
      lcdTouchZone.addEventListener('mousedown', (e) => {
        if (Date.now() - lastTouch < 500) return;
        onLcdTap(e.clientX);
      });
    }

    // システムボタン (GAME A / GAME B / GAME C / TIME)
    btnGameA?.addEventListener('click', () => this.startGame('A'));
    btnGameB?.addEventListener('click', () => this.startGame('B'));
    btnGameC?.addEventListener('click', () => this.startGame('C'));
    btnTime?.addEventListener('click', () => this.enterTimeMode());

    // キーボード操作 (PC / 外付けキーボード対応)
    window.addEventListener('keydown', (e) => {
      if (this._isAnyModalOpen()) return;
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        btnLeft?.classList.add('pressed');
        this.handleInput('LEFT');
      } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D' || e.key === ' ') {
        e.preventDefault();
        btnRight?.classList.add('pressed');
        this.handleInput('RIGHT');
      } else if (e.key === '1') {
        this.startGame('A');
      } else if (e.key === '2') {
        this.startGame('B');
      } else if (e.key === '3') {
        this.startGame('C');
      }
    });
    window.addEventListener('keyup', (e) => {
      if (e.key === 'ArrowLeft' || e.key === 'a' || e.key === 'A') {
        btnLeft?.classList.remove('pressed');
      } else if (e.key === 'ArrowRight' || e.key === 'd' || e.key === 'D' || e.key === ' ') {
        btnRight?.classList.remove('pressed');
      }
    });

    // サウンド切替ボタン
    const soundBtn = document.getElementById('sound-btn');
    const updateSoundIcon = () => {
      if (soundBtn) soundBtn.textContent = this.sound.enabled ? '🔊' : '🔇';
    };
    updateSoundIcon();
    soundBtn?.addEventListener('click', () => {
      this.sound.enabled = !this.sound.enabled;
      try {
        localStorage.setItem(STORAGE_KEYS.SOUND, this.sound.enabled ? '1' : '0');
      } catch (_) {}
      updateSoundIcon();
      if (this.sound.enabled) this.sound.step();
    });

    // 初回スタート（名前入力）モーダル
    const startModal = document.getElementById('start-modal');
    const startNameIn = document.getElementById('start-name-input');
    const startPlaceIn = document.getElementById('start-place-input');
    const startErr = document.getElementById('start-name-error');

    const tryStartFromModal = (mode) => {
      const rawName = (startNameIn?.value || '').trim();
      if (!rawName) {
        if (startErr) startErr.classList.remove('hidden');
        if (startNameIn) {
          startNameIn.classList.add('input-shake');
          startNameIn.focus();
        }
        return;
      }
      if (startErr) startErr.classList.add('hidden');
      startNameIn?.classList.remove('input-shake');
      this._savePlayerProfile(rawName, startPlaceIn?.value);
      this.hasConfirmedName = true;
      startModal?.classList.add('hidden');
      this.startGame(mode);
    };

    startNameIn?.addEventListener('input', () => {
      if (startNameIn.value.trim()) {
        startErr?.classList.add('hidden');
        startNameIn.classList.remove('input-shake');
      }
    });
    startNameIn?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        tryStartFromModal('A');
      }
    });

    document.getElementById('start-btn-a')?.addEventListener('click', () => tryStartFromModal('A'));
    document.getElementById('start-btn-b')?.addEventListener('click', () => tryStartFromModal('B'));
    document.getElementById('start-btn-c')?.addEventListener('click', () => tryStartFromModal('C'));
    document.getElementById('start-open-ranking')?.addEventListener('click', () => {
      this.openRankingModal();
    });
    document.getElementById('start-open-help')?.addEventListener('click', () => {
      document.getElementById('help-modal')?.classList.remove('hidden');
    });

    // 遊び方モーダル
    const helpModal = document.getElementById('help-modal');
    document.getElementById('help-btn')?.addEventListener('click', () => {
      helpModal?.classList.remove('hidden');
    });
    document.getElementById('help-close-btn')?.addEventListener('click', () => {
      helpModal?.classList.add('hidden');
    });

    // プロフィール＆地名設定モーダル
    const profileModal = document.getElementById('profile-modal');
    const profNameIn = document.getElementById('profile-name-input');
    const profPlaceIn = document.getElementById('profile-place-input');
    document.getElementById('profile-btn')?.addEventListener('click', () => {
      if (profNameIn) profNameIn.value = this.playerName;
      if (profPlaceIn) profPlaceIn.value = this.customPlace;
      const geoInfo = document.getElementById('detected-geo-info');
      if (geoInfo) {
        geoInfo.textContent = `自動検出された地名: ${countryToFlag(this.detectedGeo.country)} ${this.detectedGeo.display || 'Unknown'}`;
      }
      profileModal?.classList.remove('hidden');
    });
    document.getElementById('profile-save-btn')?.addEventListener('click', () => {
      this._savePlayerProfile(profNameIn?.value, profPlaceIn?.value);
      profileModal?.classList.add('hidden');
    });

    // リザルトモーダルボタン
    const resultModal = document.getElementById('result-modal');
    const resNameIn = document.getElementById('result-name-input');
    const resPlaceIn = document.getElementById('result-place-input');

    const saveFromResultAndResubmit = () => {
      const changed = (resNameIn && resNameIn.value.trim() !== this.playerName) ||
                      (resPlaceIn && resPlaceIn.value.trim() !== this.customPlace);
      if (changed) {
        this._savePlayerProfile(resNameIn?.value, resPlaceIn?.value);
        if (this.score > 0) this.submitScore();
      }
    };

    resNameIn?.addEventListener('change', saveFromResultAndResubmit);
    resPlaceIn?.addEventListener('change', saveFromResultAndResubmit);

    document.getElementById('result-retry-a')?.addEventListener('click', () => {
      saveFromResultAndResubmit();
      resultModal?.classList.add('hidden');
      this.startGame('A');
    });
    document.getElementById('result-retry-b')?.addEventListener('click', () => {
      saveFromResultAndResubmit();
      resultModal?.classList.add('hidden');
      this.startGame('B');
    });
    document.getElementById('result-retry-c')?.addEventListener('click', () => {
      saveFromResultAndResubmit();
      resultModal?.classList.add('hidden');
      this.startGame('C');
    });
    document.getElementById('result-open-ranking')?.addEventListener('click', () => {
      saveFromResultAndResubmit();
      resultModal?.classList.add('hidden');
      this.openRankingModal();
    });
    document.getElementById('result-close-btn')?.addEventListener('click', () => {
      saveFromResultAndResubmit();
      resultModal?.classList.add('hidden');
    });

    // グローバルランキングモーダル
    const rankingModal = document.getElementById('ranking-modal');
    document.getElementById('open-ranking-btn')?.addEventListener('click', () => {
      this.openRankingModal();
    });
    document.getElementById('ranking-close-btn')?.addEventListener('click', () => {
      rankingModal?.classList.add('hidden');
    });
    document.getElementById('ranking-refresh-btn')?.addEventListener('click', () => {
      this.loadRankingData();
    });

    // ランキングタブ切替
    document.getElementById('tab-player')?.addEventListener('click', () => this._switchRankingTab('player'));
    document.getElementById('tab-region')?.addEventListener('click', () => this._switchRankingTab('region'));
    document.getElementById('tab-avg')?.addEventListener('click', () => this._switchRankingTab('avg'));

    // モードフィルター切替 (ALL / GAME A / GAME B)
    document.querySelectorAll('.subfilter-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.subfilter-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentLbFilter = btn.getAttribute('data-filter') || 'ALL';
        this.loadRankingData();
      });
    });
  }

  _isAnyModalOpen() {
    const modals = ['start-modal', 'result-modal', 'profile-modal', 'help-modal', 'ranking-modal'];
    return modals.some(id => {
      const el = document.getElementById(id);
      return el && !el.classList.contains('hidden');
    });
  }

  _savePlayerProfile(nameVal, placeVal) {
    const cleanName = String(nameVal || '').trim().substring(0, 12);
    const cleanPlace = String(placeVal || '').trim().substring(0, 20);
    if (cleanName) {
      this.playerName = cleanName;
      this.hasConfirmedName = true;
    }
    this.customPlace = cleanPlace;
    try {
      if (cleanName) localStorage.setItem(STORAGE_KEYS.NAME, cleanName);
      localStorage.setItem(STORAGE_KEYS.PLACE, cleanPlace);
    } catch (_) {}
    this._updateProfilePill();
  }

  _updateProfilePill() {
    const nameEl = document.getElementById('display-player-name');
    const cityEl = document.getElementById('display-player-city');
    if (nameEl) nameEl.textContent = this.playerName || '名前未設定';
    const flag = countryToFlag(this.detectedGeo.country);
    const placeText = this.customPlace || this.detectedGeo.display || 'Japan';
    if (cityEl) {
      cityEl.textContent = `${flag} ${placeText}`;
    }
    const startGeoEl = document.getElementById('start-geo-info');
    if (startGeoEl) {
      startGeoEl.textContent = `📍 自動検出された地域: ${flag} ${this.detectedGeo.display || 'Japan'}`;
    }
  }

  /* --------------------------------------------------------------------------
     Geolocation & Global Ranking API (Cloudflare + Client Fallback)
     -------------------------------------------------------------------------- */
  async _detectPlayerLocation() {
    // 1. まず Cloudflare Worker / Pages Function の ?mode=whoami からエッジ位置情報を取得
    for (const base of API_ENDPOINTS) {
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 2800);
        const res = await fetch(`${base}?mode=whoami`, { signal: ctrl.signal });
        clearTimeout(tid);
        if (res.ok) {
          const data = await res.json();
          if (data && (data.city || data.country)) {
            this.activeApiUrl = base;
            if (data.city && data.city !== 'Unknown') {
              this.detectedGeo = {
                city: data.city,
                region: data.region || '',
                country: data.country || 'JP',
                display: data.display || data.city
              };
              this._updateProfilePill();
              return;
            }
          }
        }
      } catch (_) {}
    }

    // 2. ローカル環境やKV未接続時でも地名が確実に記録されるようパブリックGeo APIへフォールバック
    const geoApis = [
      'https://ipwho.is/',
      'https://ipapi.co/json/'
    ];
    for (const url of geoApis) {
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 3000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(tid);
        if (res.ok) {
          const g = await res.json();
          const city = g.city || g.region || '';
          const region = g.region || g.region_name || '';
          const country = g.country_code || g.country || 'JP';
          if (city) {
            const disp = (region && region !== city) ? `${city}, ${region}` : city;
            this.detectedGeo = {
              city,
              region,
              country: String(country).substring(0, 2).toUpperCase(),
              display: disp
            };
            this._updateProfilePill();
            return;
          }
        }
      } catch (_) {}
    }

    // 3. タイムゾーンから推測（最終フォールバック）
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    const tzCity = tz.includes('/') ? tz.split('/').pop().replace(/_/g, ' ') : 'Tokyo';
    this.detectedGeo = {
      city: tzCity,
      region: '',
      country: 'JP',
      display: tzCity
    };
    this._updateProfilePill();
  }

  async _fetchApi(queryOrPath = '', options = {}) {
    const candidates = this.activeApiUrl
      ? [this.activeApiUrl, ...API_ENDPOINTS.filter(u => u !== this.activeApiUrl)]
      : API_ENDPOINTS;

    for (const base of candidates) {
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 3500);
        const res = await fetch(`${base}${queryOrPath}`, { ...options, signal: ctrl.signal });
        clearTimeout(tid);
        if (res.ok) {
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            this.activeApiUrl = base;
            return await res.json();
          }
        }
      } catch (_) {}
    }
    throw new Error('Offline or API unreachable');
  }

  _saveToLocalLeaderboard(entry) {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_LB);
      let list = raw ? JSON.parse(raw) : [];
      const existingIdx = list.findIndex(e => e.name === entry.name && (e.gameMode || 'A') === entry.gameMode);
      if (existingIdx !== -1) {
        if (entry.score >= list[existingIdx].score) {
          list[existingIdx] = entry;
        }
      } else {
        list.push(entry);
      }
      list.sort((a, b) => b.score - a.score);
      list = list.slice(0, 100);
      localStorage.setItem(STORAGE_KEYS.LOCAL_LB, JSON.stringify(list));
      return list;
    } catch (_) {
      return [entry];
    }
  }

  _getLocalLeaderboard() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.LOCAL_LB);
      return raw ? JSON.parse(raw) : [];
    } catch (_) {
      return [];
    }
  }

  async submitScore() {
    if (this.score <= 0) return;
    const statusEl = document.getElementById('submit-status-msg');
    const placeDisplay = this.customPlace || this.detectedGeo.display || 'Tokyo';
    const entry = {
      name: this.playerName,
      score: this.score,
      gameMode: this.gameMode,
      bags: this.bagsReturned,
      date: new Date().toISOString(),
      playerId: getOrCreatePlayerId(),
      customPlace: this.customPlace || '',
      clientCity: this.detectedGeo.city || placeDisplay,
      clientRegion: this.detectedGeo.region || '',
      clientCountry: this.detectedGeo.country || 'JP',
      city: placeDisplay,
      country: this.detectedGeo.country || 'JP'
    };

    // ローカルにも必ず保存
    this._saveToLocalLeaderboard(entry);

    if (statusEl) {
      statusEl.style.color = '#ffd43b';
      statusEl.textContent = '🌐 グローバルランキングへ記録中...';
    }

    try {
      const res = await this._fetchApi('', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry)
      });
      const recordedCity = res?.location?.display || placeDisplay;
      const rankStr = res?.rank ? `世界第 ${res.rank} 位！` : '登録完了！';
      if (statusEl) {
        statusEl.style.color = '#8ce99a';
        statusEl.textContent = `✅ グローバル記録完了 (${countryToFlag(this.detectedGeo.country)} ${recordedCity}) - ${rankStr}`;
      }
    } catch (_) {
      if (statusEl) {
        statusEl.style.color = '#a5d8ff';
        statusEl.textContent = `📍 端末ランキングに記録しました (${countryToFlag(this.detectedGeo.country)} ${placeDisplay})`;
      }
    }
  }

  openRankingModal() {
    const modal = document.getElementById('ranking-modal');
    modal?.classList.remove('hidden');
    this.loadRankingData();
  }

  _switchRankingTab(tab) {
    this.currentLbTab = tab;
    const tabs = ['player', 'region', 'avg'];
    tabs.forEach(t => {
      document.getElementById(`tab-${t}`)?.classList.toggle('active', t === tab);
      document.getElementById(`lb-header-${t}`)?.classList.toggle('hidden', t !== tab);
    });
    const modeFilters = document.getElementById('lb-mode-filters');
    if (modeFilters) {
      modeFilters.classList.toggle('hidden', tab !== 'player');
    }
    this.loadRankingData();
  }

  async loadRankingData() {
    const listEl = document.getElementById('ranking-list');
    if (!listEl) return;
    listEl.innerHTML = '<div class="loading-box">🌐 グローバルランキングを取得中...</div>';

    let data = [];
    let isOfflineFallback = false;

    try {
      if (this.currentLbTab === 'region') {
        data = await this._fetchApi('?mode=regional');
      } else if (this.currentLbTab === 'avg') {
        data = await this._fetchApi('?mode=average');
      } else {
        const q = this.currentLbFilter !== 'ALL' ? `?gameMode=${this.currentLbFilter}` : '';
        data = await this._fetchApi(q);
      }
    } catch (_) {
      isOfflineFallback = true;
      data = this._buildFallbackLeaderboardData();
    }

    // ローカル記録とマージ（クラウドが空または反映直後の場合でも自分の記録が見えるようにする）
    if (this.currentLbTab === 'player' && (!Array.isArray(data) || data.length === 0)) {
      data = this._buildFallbackLeaderboardData();
    }

    this._renderRankingList(listEl, data, isOfflineFallback);
  }

  _buildFallbackLeaderboardData() {
    let local = this._getLocalLeaderboard();
    if (this.currentLbTab === 'player') {
      if (this.currentLbFilter !== 'ALL') {
        local = local.filter(e => (e.gameMode || 'A') === this.currentLbFilter);
      }
      return local;
    }
    if (this.currentLbTab === 'region') {
      const map = new Map();
      for (const e of local) {
        const c = e.city || 'Tokyo';
        if (!map.has(c)) map.set(c, { city: c, country: e.country || 'JP', total: 0, count: 0, best: 0 });
        const r = map.get(c);
        r.total += e.score;
        r.count += 1;
        if (e.score > r.best) r.best = e.score;
      }
      return Array.from(map.values()).map(r => ({
        city: r.city,
        country: r.country,
        best: r.best,
        avg: Math.round((r.total / r.count) * 10) / 10,
        count: r.count
      }));
    }
    // avg
    return local.map(e => ({
      name: e.name,
      city: e.city,
      country: e.country || 'JP',
      avg: e.score,
      best: e.score,
      games: 1
    }));
  }

  _renderRankingList(listEl, data, isOffline) {
    listEl.innerHTML = '';
    if (!Array.isArray(data) || data.length === 0) {
      listEl.innerHTML = '<div class="loading-box">まだスコア記録がありません。<br>最初のダイバーとして記録を残そう！</div>';
      return;
    }

    data.forEach((entry, idx) => {
      const rank = idx + 1;
      const rankClass = rank <= 3 ? `rank-${rank}` : '';
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}`;
      const flag = countryToFlag(entry.country || 'JP');
      const row = document.createElement('div');
      row.className = `lb-row ${rankClass}`;

      if (this.currentLbTab === 'region') {
        row.innerHTML = `
          <div class="col-rank">${medal}</div>
          <div class="col-city">
            <div class="player-main-name">${flag} ${this._esc(entry.city || 'Unknown')}</div>
            <div class="player-geo-sub">${entry.topPlayer ? `TOP: ${this._esc(entry.topPlayer)}` : ''}</div>
          </div>
          <div class="col-best">${entry.best}</div>
          <div class="col-avg">${entry.avg}</div>
          <div class="col-count">${entry.count}人</div>
        `;
      } else if (this.currentLbTab === 'avg') {
        const cityTxt = entry.city ? `${flag} 📍${this._esc(entry.city)}` : `${flag}`;
        row.innerHTML = `
          <div class="col-rank">${medal}</div>
          <div class="col-name">
            <div class="player-main-name">${this._esc(entry.name)}</div>
            <div class="player-geo-sub">${cityTxt}</div>
          </div>
          <div class="col-avg">${entry.avg}</div>
          <div class="col-best">${entry.best}</div>
          <div class="col-count">${entry.games || 1}回</div>
        `;
      } else {
        const d = entry.date ? new Date(entry.date) : null;
        const dateStr = (d && !isNaN(d))
          ? `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
          : '-';
        const cityTxt = entry.city ? `${flag} 📍${this._esc(entry.city)}` : `${flag} Location Unknown`;
        const gMode = (entry.gameMode === 'B' || entry.gameMode === 'C') ? entry.gameMode : 'A';
        row.innerHTML = `
          <div class="col-rank">${medal}</div>
          <div class="col-name">
            <div class="player-main-name">${this._esc(entry.name)}</div>
            <div class="player-geo-sub">${cityTxt}</div>
          </div>
          <div class="col-mode"><span class="mode-pill mode-${gMode}">GAME ${gMode}</span></div>
          <div class="col-score">${entry.score}</div>
          <div class="col-date">${dateStr}</div>
        `;
      }
      listEl.appendChild(row);
    });
  }

  _esc(str) {
    return String(str || '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  /* --------------------------------------------------------------------------
     Game State Control (Start Game A / B, Time/Demo Mode, Input Handling)
     -------------------------------------------------------------------------- */
  _resetDemoState() {
    this.lives = 3;
    this.diverPos = 1;
    this.hasBag = false;
    this.bagGoldCount = 0;
    this.visualBagGold = 0;
    this.bagGoldRipple = 0;
    this.grabAnimPhase = 0;
    this.tentacles = [
      { maxLen: 4, len: 1, dir: 1, wait: 0 },
      { maxLen: 5, len: 2, dir: 1, wait: 0 },
      { maxLen: 4, len: 2, dir: -1, wait: 0 },
      { maxLen: 3, len: 1, dir: 1, wait: 0 }
    ];
  }

  enterTimeMode() {
    this.state = 'TIME';
    this._resetDemoState();
    this._updateModeButtons('TIME');
    this._setStatusText('TIME & DEMO MODE — PRESS [GAME A] OR [GAME B]');
  }

  startGame(mode = 'A') {
    // まだ名前を入力していない場合は必ず名前入力モーダルを開く
    if (!this.playerName || !this.hasConfirmedName) {
      this.openStartModal();
      return;
    }
    this.sound.init();
    this.gameMode = (mode === 'B' || mode === 'C') ? mode : 'A';
    this.state = 'PLAYING';
    this.score = 0;
    this.bagsReturned = 0;
    this.treasuresGrabbed = 0;
    this.lives = 3;
    this.bonus200Triggered = false;
    this.bonus500Triggered = false;

    this.diverPos = 0;
    this.hasBag = false;
    this.bagGoldCount = 0;
    this.visualBagGold = 0;
    this.bagGoldRipple = 0;
    this.bagStuffBounce = 0;
    this.goldCoinsInFlight = [];
    this.unloadElapsed = 0;
    this.unloadStartGold = 0;
    this.demoUnloadTimer = 0;
    this.boatUnloadParticles = [];
    this.boatDeckCoins = [];
    this.grabAnimPhase = 0;
    this.grabAnimTimer = 0;
    this.unloadTicksLeft = 0;
    this.caughtTentacleIdx = -1;

    // 初期のイカの足配置（開始直後に理不尽な即死が起きない本家準拠の初期位相）
    this.tentacles = [
      { maxLen: 4, len: 1, dir: 1, wait: 0 },
      { maxLen: 5, len: 1, dir: 1, wait: 1 },
      { maxLen: 4, len: 2, dir: -1, wait: 0 },
      { maxLen: 3, len: 0, dir: 1, wait: 1 }
    ];

    this.tickTimer = 0;
    this.tickCount = 0;

    this._updateModeButtons(this.gameMode);
    this._setStatusText(`GAME ${this.gameMode} START! 宝箱へ進んで財宝を持ち帰ろう！`);
    this.sound.gameStart();

    // GAME C: 空と海の仲間たちは最初は少数から始まり、プレイ時間の経過とともに1種類ずつ新しく登場する
    this._resetCreatureDiscovery();

    // 画面タップガイドを短時間表示
    const hintOverlay = document.getElementById('touch-hint-overlay');
    if (hintOverlay) {
      hintOverlay.classList.remove('hidden');
      hintOverlay.style.animation = 'none';
      void hintOverlay.offsetWidth;
      hintOverlay.style.animation = '';
      setTimeout(() => hintOverlay.classList.add('hidden'), 2600);
    }
  }

  _updateModeButtons(active) {
    document.getElementById('btn-game-a')?.classList.toggle('active-mode', active === 'A');
    document.getElementById('btn-game-b')?.classList.toggle('active-mode', active === 'B');
    document.getElementById('btn-game-c')?.classList.toggle('active-mode', active === 'C');
    document.getElementById('btn-time')?.classList.toggle('active-mode', active === 'TIME');
  }

  _setStatusText(msg) {
    const el = document.getElementById('live-status-text');
    if (el) el.textContent = msg;
  }

  handleInput(dir) {
    this.sound.init();

    // TIMEモード中またはGAME OVER中に左右ボタンを押したら即座に現在のモード(A/B)でゲーム開始！
    if (this.state === 'TIME' || this.state === 'GAMEOVER') {
      const resultModal = document.getElementById('result-modal');
      if (resultModal && !resultModal.classList.contains('hidden')) return;
      this.startGame(this.gameMode);
      return;
    }

    // 捕まり中・船上荷下ろし中・ボーナス演出中は入力を受け付けない（実機仕様）
    if (this.state !== 'PLAYING') return;

    if (navigator.vibrate) {
      try { navigator.vibrate(10); } catch (_) {}
    }

    if (dir === 'RIGHT') {
      if (this.diverPos < 5) {
        this.diverPos += 1;
        this.grabAnimPhase = 0;
        this.sound.step();
        this._spawnDiverBubbleBurst(7);
        this._checkCollisionImmediate();
      } else if (this.diverPos === 5) {
        // 宝箱の前(pos=5)でRIGHTを押すと財宝を1個掴んで+1点！
        this._grabTreasureAtChest();
      }
    } else if (dir === 'LEFT') {
      if (this.diverPos > 1) {
        this.diverPos -= 1;
        this.grabAnimPhase = 0;
        this.sound.step();
        this._spawnDiverBubbleBurst(7);
        this._checkCollisionImmediate();
      } else if (this.diverPos === 1) {
        // 財宝袋(hasBag)を持っている時だけ船上(pos=0)へ上がって満杯の布袋から金を船に降ろす+3点ボーナス演出！
        if (this.hasBag) {
          this.diverPos = 0;
          this.state = 'UNLOADING';
          this.unloadTicksLeft = 3;
          this.unloadTimer = 0;
          this.unloadElapsed = 0;
          this.unloadStartGold = Math.max(4, this.bagGoldCount || 3);
          this.bagsReturned += 1;
          this._spawnBoatUnloadGoldWave(0);
          this._setStatusText('🙌 生還成功！ 満杯の布袋から金を船へ荷下ろし中 (+3 PTS BONUS!)');
        } else {
          // まだ宝を持っていない時はロープ位置で待機音のみ
          this.sound.step();
          this._setStatusText('右下の宝箱(RIGHT ▶)で財宝を取ってから船へ戻ろう！');
        }
      }
    }
  }

  _grabTreasureAtChest() {
    // すでにその瞬間に足3(右端)が伸びきっていたら捕まる
    if (this._isPositionDangerous(5)) {
      this._triggerCaught(3);
      return;
    }
    const prevGold = this.bagGoldCount || 0;
    this.hasBag = true;
    this.treasuresGrabbed += 1;
    this.bagGoldCount = prevGold + 1;
    if (typeof this.visualBagGold !== 'number' || this.visualBagGold < prevGold) {
      this.visualBagGold = prevGold;
    }
    this.bagStuffBounce = 1.0;
    this.bagGoldRipple = 1.0;
    this.grabAnimPhase = 1;
    this.grabAnimTimer = 0.22;
    this.squidFlushBoost = Math.min(1.0, this.squidFlushBoost + 0.45);
    this._spawnDiverBubbleBurst(9);
    this._spawnGoldStuffingBurst();
    this.sound.grabTreasure();
    this._addScore(1);
    this._setStatusText(`💰 財宝ゲット (+1点)！ 布袋に金が溜まっていくぞ (現在${this.bagGoldCount}掴み)！`);
  }

  // 宝箱(628,394)からダイバーの手を経由して左手の布袋の大きく開いた口(508,384)へ金貨・金塊・宝石を次々と流し込むパーティクルを生成
  _spawnGoldStuffingBurst() {
    if (!this.goldCoinsInFlight) this.goldCoinsInFlight = [];
    const types = ['coin', 'coin', 'ingot', 'coin', 'ruby', 'coin', 'emerald', 'ingot', 'coin'];
    for (let i = 0; i < 12; i++) {
      const kind = types[i % types.length];
      this.goldCoinsInFlight.push({
        kind,
        t: -i * 0.026, // 時間差で連続して布袋の口へ吸い込まれる
        duration: 0.34 + (i % 3) * 0.035,
        startX: 626 + (Math.random() - 0.5) * 20,
        startY: 394 + (Math.random() - 0.5) * 10,
        ctrlX: 564 + (Math.random() - 0.5) * 14,
        ctrlY: 342 - Math.random() * 18,
        endX: 508 + (Math.random() - 0.5) * 7,
        endY: 384 + (Math.random() - 0.5) * 4,
        rot: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 18,
        r: kind === 'ingot' ? 4.4 : (3.1 + (i % 3) * 0.65)
      });
    }
    if (this.goldCoinsInFlight.length > 48) {
      this.goldCoinsInFlight.splice(0, this.goldCoinsInFlight.length - 48);
    }
  }

  // 船に戻った時、満杯の布袋の口(x≈198, y≈48)から船の甲板(x≈186..224, y≈82..88)へ金貨・金塊・宝石をザクザク降ろすパーティクル波を生成
  _spawnBoatUnloadGoldWave(waveIdx = 0) {
    if (!this.boatUnloadParticles) this.boatUnloadParticles = [];
    const types = ['coin', 'coin', 'ingot', 'coin', 'ruby', 'coin', 'ingot', 'emerald', 'coin'];
    const count = 9 + Math.min(8, (this.bagGoldCount || 2) * 2);
    // 布袋の口の位置（ダイバー(168,52)が右前方の甲板へ向けて傾けた袋の口）
    const mouthX = 198 + (waveIdx % 2 === 0 ? 2 : -2);
    const mouthY = 48 + waveIdx * 1.5;

    for (let i = 0; i < count; i++) {
      const kind = types[(i + waveIdx * 3) % types.length];
      const spreadX = (Math.random() - 0.42) * 34;
      this.boatUnloadParticles.push({
        kind,
        delay: i * 0.018,
        x: mouthX + (Math.random() - 0.5) * 7,
        y: mouthY + (Math.random() - 0.5) * 5,
        vx: spreadX,
        vy: 32 + Math.random() * 48,
        gravity: 290 + Math.random() * 80,
        targetDeckY: 81.5 + Math.random() * 6.5,
        bounces: 0,
        rot: Math.random() * Math.PI * 2,
        rotSpeed: (Math.random() - 0.5) * 20,
        r: kind === 'ingot' ? 4.3 : (2.9 + (i % 3) * 0.55),
        alpha: 1.0,
        sparkle: Math.random() < 0.45
      });
    }
    if (this.boatUnloadParticles.length > 72) {
      this.boatUnloadParticles.splice(0, this.boatUnloadParticles.length - 72);
    }
  }

  _addScore(pts) {
    const prev = this.score;
    this.score += pts;

    // ハイスコア更新
    if (this.gameMode === 'A' && this.score > this.highScoreA) {
      this.highScoreA = this.score;
      try { localStorage.setItem(STORAGE_KEYS.HIGH_A, String(this.highScoreA)); } catch (_) {}
    } else if (this.gameMode === 'B' && this.score > this.highScoreB) {
      this.highScoreB = this.score;
      try { localStorage.setItem(STORAGE_KEYS.HIGH_B, String(this.highScoreB)); } catch (_) {}
    } else if (this.gameMode === 'C' && this.score > this.highScoreC) {
      this.highScoreC = this.score;
      try { localStorage.setItem(STORAGE_KEYS.HIGH_C, String(this.highScoreC)); } catch (_) {}
    }

    // 200点到達時、および以降は500点ごと（500, 1000, 1500, 2000...）にダイバーが1名増える（+1UP・最大3名）
    const crossed200 = !this.bonus200Triggered && prev < 200 && this.score >= 200;
    const crossedEvery500 = Math.floor(prev / 500) < Math.floor(this.score / 500);

    if (crossed200 || crossedEvery500) {
      if (crossed200) this.bonus200Triggered = true;
      if (this.lives < 3) {
        this.lives += 1;
      }
      this.bonusTimer = 2.0;
      this.sound.bonusLifeFanfare();
      const milestone = crossedEvery500 ? Math.floor(this.score / 500) * 500 : 200;
      this._setStatusText(`🎉 ${milestone} PTS BONUS! ダイバーが1名復活 (+1UP)！`);
    }
  }

  _isPositionDangerous(pos) {
    // pos 2 -> tentacle 0, pos 3 -> tentacle 1, pos 4 -> tentacle 2, pos 5 -> tentacle 3
    const tIdx = pos - 2;
    if (tIdx < 0 || tIdx > 3) return false;
    const t = this.tentacles[tIdx];
    return t.len >= t.maxLen;
  }

  _checkCollisionImmediate() {
    if (this.state !== 'PLAYING') return;
    if (this.diverPos >= 2 && this.diverPos <= 5) {
      const tIdx = this.diverPos - 2;
      if (this.tentacles[tIdx].len >= this.tentacles[tIdx].maxLen) {
        this._triggerCaught(tIdx);
      }
    }
  }

  _triggerCaught(tentacleIdx) {
    this.state = 'CAUGHT';
    this.caughtTentacleIdx = tentacleIdx;
    this.caughtFlailTicks = 7; // 本家同様の手足バタバタ回数
    this.caughtTimer = 0;
    this.grabAnimPhase = 0;
    this.squidFlushBoost = 1.0; // 捕獲時はイカが激しく興奮し赤茶色マダラ模様が最大発色
    this._spawnDiverBubbleBurst(16, 376, 166);
    if (navigator.vibrate) {
      try { navigator.vibrate([60, 40, 80]); } catch (_) {}
    }
    this.sound.caughtFlail(0);
    this._setStatusText('🦑 イカの足に捕まった！ MISS!');
  }

  // ダイバーの現在水中座標を取得（水中にいない時はnull）
  _getActiveUnderwaterDiverCoords() {
    if (this.state === 'CAUGHT') {
      return { x: 374, y: 164, isFlailing: true };
    }
    if ((this.state === 'PLAYING' || this.state === 'TIME' || this.state === 'BONUS') && this.diverPos >= 1 && this.diverPos <= 5) {
      const coords = [
        null,
        { x: 142, y: 184 },
        { x: 194, y: 294 },
        { x: 304, y: 344 },
        { x: 420, y: 362 },
        { x: 534, y: 368 }
      ];
      return coords[this.diverPos];
    }
    return null;
  }

  // ヘルメット排気弁から「ぼこぼこ」と大小の空気塊を発生させる
  _spawnDiverBubbleBurst(count = 6, customX = null, customY = null) {
    if (!this.bubbles) return;
    const dc = (customX !== null && customY !== null)
      ? { x: customX, y: customY }
      : this._getActiveUnderwaterDiverCoords();
    if (!dc) return;

    const originX = dc.x - 4;
    const originY = dc.y - 14;

    for (let i = 0; i < count; i++) {
      // 大粒で扁平に歪みながら「ぼこっ」と上がる主気泡と、それに付随する中・小気泡を混ぜる
      const roll = Math.random();
      const radius = roll < 0.26
        ? (5.2 + Math.random() * 3.6)   // 大気泡（ぼこぼこ変形する塊）
        : (roll < 0.65 ? (2.5 + Math.random() * 2.4) : (1.1 + Math.random() * 1.3)); // 中・小気泡
      this.bubbles.push({
        x: originX + (Math.random() - 0.5) * 14,
        y: originY - Math.random() * 10,
        vx: (Math.random() - 0.5) * 28,
        vy: -(52 + radius * 11 + Math.random() * 26),
        r: radius,
        wobblePhase: Math.random() * Math.PI * 2,
        wobbleFreq: 5.5 + Math.random() * 5.0,
        wobbleAmp: 12 + Math.random() * 18,
        deformPhase: Math.random() * Math.PI * 2,
        age: 0
      });
    }
    if (this.bubbles.length > 140) {
      this.bubbles.splice(0, this.bubbles.length - 140);
    }
  }

  // GAME C: 時間帯・季節・天候の滑らかな連続変化パラメータを算出
  _getEnvAtmosphere() {
    // 時間経過(bioTime)とスコア進行の両方で、時間帯・季節・天候がゆっくり美しく巡る
    const prog = this.bioTime * 0.042 + (this.score || 0) * 0.018;

    // 時間帯 (0: 朝焼け Dawn -> 1: 真昼 Day -> 2: 夕焼け Sunset -> 3: 月夜・満天の星 Night)
    const todCycle = ((prog * 0.85) + 0.85) % 4;
    const todIdx = Math.floor(todCycle);
    const todFrac = todCycle - todIdx;
    const todSmooth = todFrac * todFrac * (3 - 2 * todFrac);

    // 季節 (0: 春・桜吹雪 -> 1: 夏・入道雲と陽光の煌めき -> 2: 秋・黄金色の風と紅葉 -> 3: 冬・澄んだ空と雪結晶)
    const seasonCycle = (prog * 0.32) % 4;
    const seasonIdx = Math.floor(seasonCycle);
    const seasonFrac = seasonCycle - seasonIdx;

    // 天候 (0: 快晴 -> 1: そよ風と流れ雲 -> 2: 通り雨と水面の雨紋 -> 3: 雨上がりの七色の虹)
    const weatherCycle = (prog * 0.51 + 0.25) % 4;
    const weatherIdx = Math.floor(weatherCycle);
    const weatherFrac = weatherCycle - weatherIdx;

    // 雨の強さ (weatherIdx === 2 の前後で滑らかにフェードイン・アウト)
    let rainIntensity = 0;
    if (weatherIdx === 2) {
      rainIntensity = Math.sin(weatherFrac * Math.PI);
    } else if (weatherIdx === 1 && weatherFrac > 0.72) {
      rainIntensity = ((weatherFrac - 0.72) / 0.28) * 0.35;
    }

    // 雨上がりの虹の濃さ (weatherIdx === 3 で浮かび上がる)
    let rainbowAlpha = 0;
    if (weatherIdx === 3) {
      rainbowAlpha = Math.sin(weatherFrac * Math.PI) * 0.78;
    } else if (weatherIdx === 2 && weatherFrac > 0.68) {
      rainbowAlpha = ((weatherFrac - 0.68) / 0.32) * 0.45;
    }

    return {
      todCycle,
      todIdx,
      todSmooth,
      seasonIdx,
      seasonFrac,
      weatherIdx,
      weatherFrac,
      rainIntensity,
      rainbowAlpha
    };
  }

  _updateBubbles(dt) {
    this.bioTime += dt;
    if (this.squidFlushBoost > 0) {
      this.squidFlushBoost = Math.max(0, this.squidFlushBoost - dt * 0.38);
    }
    if (this.bagStuffBounce > 0) {
      this.bagStuffBounce = Math.max(0, this.bagStuffBounce - dt * 3.4);
    }
    if (this.bagGoldRipple > 0) {
      this.bagGoldRipple = Math.max(0, this.bagGoldRipple - dt * 3.2);
    }

    // 宝箱から布袋へ詰め込まれる金貨・金塊・宝石の放物線アニメーション更新（着弾ごとに布袋の中の金かさが増える）
    if (this.goldCoinsInFlight && this.goldCoinsInFlight.length > 0) {
      for (let i = this.goldCoinsInFlight.length - 1; i >= 0; i--) {
        const gc = this.goldCoinsInFlight[i];
        gc.t += dt;
        gc.rot += gc.rotSpeed * dt;
        if (gc.t >= gc.duration) {
          this.bagStuffBounce = Math.min(1.0, this.bagStuffBounce + 0.24);
          this.bagGoldRipple = 1.0;
          this.visualBagGold = Math.min(this.bagGoldCount || 1, (this.visualBagGold || 0) + 0.11);
          this.goldCoinsInFlight.splice(i, 1);
        }
      }
    } else {
      this.visualBagGold = this.bagGoldCount || 0;
    }

    // 船に戻った時、満杯の布袋から船の甲板へ降り注ぐ金貨・金塊・宝石の物理バウンド更新
    if (this.boatUnloadParticles && this.boatUnloadParticles.length > 0) {
      if (!this.boatDeckCoins) this.boatDeckCoins = [];
      for (let i = this.boatUnloadParticles.length - 1; i >= 0; i--) {
        const p = this.boatUnloadParticles[i];
        if (p.delay > 0) {
          p.delay -= dt;
          continue;
        }
        p.vy += p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.rotSpeed * dt;

        // 船の甲板範囲内に収める
        if (p.x < 180) { p.x = 180; p.vx = Math.abs(p.vx) * 0.5; }
        if (p.x > 224) { p.x = 224; p.vx = -Math.abs(p.vx) * 0.5; }

        if (p.y >= p.targetDeckY) {
          p.y = p.targetDeckY;
          if (p.bounces < 1) {
            p.bounces += 1;
            p.vy = -(42 + Math.random() * 34);
            p.vx *= 0.65;
            p.rotSpeed *= 0.6;
          } else {
            // 甲板上の金貨の山へ定着
            if (this.boatDeckCoins.length < 44) {
              this.boatDeckCoins.push({
                kind: p.kind,
                x: p.x,
                y: p.targetDeckY - Math.min(6.5, this.boatDeckCoins.length * 0.14),
                r: p.r,
                rot: (Math.random() - 0.5) * 0.45
              });
            }
            this.boatUnloadParticles.splice(i, 1);
          }
        }
      }
    }

    if (this.demoUnloadTimer > 0) {
      this.demoUnloadTimer = Math.max(0, this.demoUnloadTimer - dt);
    }

    // 空の雲・海鳥・季節天候パーティクル・海中魚の移動更新
    const env = this._getEnvAtmosphere();
    const windMul = 1.0 + env.rainIntensity * 0.85;

    if (this.skyClouds) {
      for (const cl of this.skyClouds) {
        cl.x -= cl.speed * windMul * dt;
        if (cl.x + cl.rx * 1.5 < -20) {
          cl.x = 740 + cl.rx * 1.2;
        }
      }
    }

    // 空と海の仲間たちの「時間経過による段階的な登場」タイマー
    this._updateCreatureDiscovery(dt);

    if (this.skyBirds) {
      for (const bd of this.skyBirds) {
        if (!bd.revealed) continue;
        bd.x += bd.vx * dt;
        bd.y += Math.sin(this.bioTime * 2.2 + bd.phase) * bd.vy * dt * 12;
        if (bd.vx > 0 && bd.x > 820) bd.x = -95;
        if (bd.vx < 0 && bd.x < -95) bd.x = 820;
      }
    }

    if (this.weatherParticles) {
      for (const wp of this.weatherParticles) {
        if (env.rainIntensity > 0.15) {
          // 雨粒モード：斜め下へ高速落下し、海面で小さな雨波紋を作る
          wp.x -= (65 + wp.size * 12) * dt;
          wp.y += (240 + wp.size * 35) * dt;
        } else {
          // 季節モード（春の桜・秋の紅葉・冬の雪結晶）
          const sway = Math.sin(this.bioTime * 2.6 + wp.phase) * 18;
          wp.x += (wp.vx + sway) * dt;
          wp.y += wp.vy * dt;
          wp.rot += wp.rotSpeed * dt;
        }
        if (wp.x < -15) wp.x = 735;
        if (wp.x > 735) wp.x = -15;
        if (wp.y > 108) {
          if (env.rainIntensity > 0.2 && this.surfaceRipples && this.surfaceRipples.length < 36 && Math.random() < 0.35) {
            this.surfaceRipples.push({
              x: wp.x,
              y: 105 + Math.sin(wp.x * 0.065) * 3,
              rx: 1.5,
              maxRx: 9 + Math.random() * 6,
              alpha: 0.55
            });
          }
          wp.y = -8;
          wp.x = Math.random() * 720;
        }
      }
    }

    if (this.underwaterFish) {
      for (const f of this.underwaterFish) {
        if (!f.revealed) continue;
        f.x += f.vx * dt;
        if (f.vx > 0 && f.x > 790) f.x = -65;
        if (f.vx < 0 && f.x < -65) f.x = 790;
      }
    }

    if (this.marineSnow) {
      for (const ms of this.marineSnow) {
        ms.y += ms.speedY * dt;
        ms.x += Math.sin(this.bioTime * 1.4 + ms.phase) * 4.5 * dt;
        if (ms.y > 438) {
          ms.y = 116;
          ms.x = 20 + Math.random() * 680;
        }
      }
    }

    // ダイバーが水中にいる間、呼吸に合わせて周期的に「ボコボコッ…」と気泡が湧き出る
    const dc = this._getActiveUnderwaterDiverCoords();
    if (dc) {
      this.bubbleSpawnTimer -= dt;
      if (this.bubbleSpawnTimer <= 0) {
        // 呼吸のリズム（吸気時の小泡＋呼気時のボコボコ大放出）
        const isExhale = Math.sin(this.bioTime * 3.4) > -0.15;
        this._spawnDiverBubbleBurst(isExhale ? (dc.isFlailing ? 7 : 4) : 1);
        this.bubbleSpawnTimer = dc.isFlailing ? 0.08 : (isExhale ? 0.11 : 0.24);
      }
    }

    // 各気泡の浮力上昇・横揺れ・水圧減による膨張・海面到達時の波紋生成
    for (let i = this.bubbles.length - 1; i >= 0; i--) {
      const b = this.bubbles[i];
      b.age += dt;
      // 浮力で少しずつ加速しながら上昇し、浅くなるほど水圧が減ってわずかに膨張する
      b.vy -= dt * 18;
      b.r += dt * 0.22;
      const sway = Math.cos(b.age * b.wobbleFreq + b.wobblePhase) * b.wobbleAmp;
      b.x += (b.vx * 0.35 + sway) * dt;
      b.y += b.vy * dt;

      // 海面の波ライン(y ≒ 104〜108)に達したら弾けて波紋リングを作る
      const surfaceY = 104 + Math.sin(b.x * 0.065) * 4;
      if (b.y - b.r <= surfaceY) {
        if (b.r >= 2.2 && this.surfaceRipples.length < 30) {
          this.surfaceRipples.push({
            x: b.x,
            y: surfaceY,
            rx: b.r * 1.4,
            maxRx: b.r * 5.2 + 8,
            alpha: 0.78
          });
        }
        this.bubbles.splice(i, 1);
      }
    }

    // 海面で弾けた気泡の波紋アニメーション
    for (let i = this.surfaceRipples.length - 1; i >= 0; i--) {
      const rp = this.surfaceRipples[i];
      rp.rx += dt * 36;
      rp.alpha -= dt * 1.35;
      if (rp.alpha <= 0 || rp.rx >= rp.maxRx) {
        this.surfaceRipples.splice(i, 1);
      }
    }
  }

  /* --------------------------------------------------------------------------
     Main Update Loop (Authentic LCD Clock Tick & Tentacle Patterns)
     -------------------------------------------------------------------------- */
  _getTickInterval() {
    if (this.state === 'TIME') return 0.42;
    // スコアが100点刻みで上がるごとに少しずつ加速し、100点台突入直後に少し緩む波を作る
    const base = this.gameMode === 'B' ? 0.31 : 0.43;
    const withinHundred = this.score % 100;
    const hundredTier = Math.min(5, Math.floor(this.score / 100));
    const speedUp = (withinHundred / 100) * 0.09 + hundredTier * 0.018;
    return Math.max(0.17, base - speedUp);
  }

  _update(dt) {
    this._updateBubbles(dt);

    if (this.bonusTimer > 0) {
      this.bonusTimer = Math.max(0, this.bonusTimer - dt);
    }

    // 宝箱前での腕アニメーション遷移 (1:手を入れる -> 2:袋へ詰める -> 0:通常)
    if (this.grabAnimPhase > 0) {
      this.grabAnimTimer -= dt;
      if (this.grabAnimTimer <= 0) {
        if (this.grabAnimPhase === 1) {
          this.grabAnimPhase = 2;
          this.grabAnimTimer = 0.20;
        } else {
          this.grabAnimPhase = 0;
        }
      }
    }

    // 1. 船上での+3点ボーナス荷下ろしステート（満杯の布袋を逆さに傾けて金を船に降ろす演出）
    if (this.state === 'UNLOADING') {
      this.unloadTimer += dt;
      this.unloadElapsed += dt;
      if (this.unloadTimer >= 0.30) {
        this.unloadTimer = 0;
        if (this.unloadTicksLeft > 0) {
          const stepIdx = 3 - this.unloadTicksLeft;
          this.sound.boatBonusTick(stepIdx);
          this._spawnBoatUnloadGoldWave(stepIdx + 1);
          this._addScore(1);
          this.unloadTicksLeft -= 1;
        } else {
          this.hasBag = false;
          this.bagGoldCount = 0;
          this.visualBagGold = 0;
          this.bagGoldRipple = 0;
          this.goldCoinsInFlight = [];
          this.state = 'PLAYING';
          this._setStatusText('RIGHT ▶ ボタンで再び海底へ潜ろう！');
        }
      }
      return;
    }

    // 2. イカに捕まって手足をバタバタさせるステート
    if (this.state === 'CAUGHT') {
      this.caughtTimer += dt;
      if (this.caughtTimer >= 0.30) {
        this.caughtTimer = 0;
        this.caughtFlailTicks -= 1;
        if (this.caughtFlailTicks > 0) {
          this.sound.caughtFlail(this.caughtFlailTicks);
        } else {
          // 残機を1減らす
          this.lives -= 1;
          if (this.lives <= 0) {
            this.state = 'GAMEOVER';
            this._onGameOver();
          } else {
            // 次の潜水夫が船上からスタート
            this.diverPos = 0;
            this.hasBag = false;
            this.bagGoldCount = 0;
            this.visualBagGold = 0;
            this.bagGoldRipple = 0;
            this.goldCoinsInFlight = [];
            this.caughtTentacleIdx = -1;
            // 捕まった足を少し引っ込めて再開
            this.tentacles.forEach(t => {
              if (t.len >= t.maxLen) {
                t.len = Math.max(1, t.maxLen - 2);
                t.dir = -1;
              }
            });
            this.state = 'PLAYING';
            this._setStatusText(`残りダイバー ${this.lives}人！ RIGHT ▶ で潜水開始！`);
          }
        }
      }
      return;
    }

    if (this.state === 'GAMEOVER') return;

    // 3. 通常プレイまたはTIMEデモモードのLCDクロック更新
    const tickInterval = this._getTickInterval();
    this.tickTimer += dt;
    if (this.tickTimer >= tickInterval) {
      this.tickTimer -= tickInterval;
      this.tickCount += 1;
      this._stepTentacles();

      if (this.state === 'PLAYING') {
        this.sound.tick(this.tickCount % 2 === 0);
        this._checkCollisionImmediate();
      } else if (this.state === 'TIME') {
        this._stepDemoAI();
      }
    }
  }

  _stepTentacles() {
    // 4本の足が同時に全て最大長になって詰むことがないよう、本家同様のグループ交互更新＋フェイント制御を行う
    const isGameB = this.gameMode === 'B' && this.state === 'PLAYING';

    // 各ティックで動く足のインデックスを決定（毎回2〜3本が伸縮し、独特のリズムを生む）
    const activeIndices = [];
    for (let i = 0; i < 4; i++) {
      if ((this.tickCount + i) % 2 === 0 || (isGameB && (this.tickCount + i) % 3 === 0)) {
        activeIndices.push(i);
      }
    }

    for (const idx of activeIndices) {
      const t = this.tentacles[idx];
      if (t.wait > 0) {
        t.wait -= 1;
        continue;
      }

      t.len += t.dir;

      if (t.len >= t.maxLen) {
        t.len = t.maxLen;
        t.dir = -1;
        this.squidFlushBoost = Math.min(1.0, this.squidFlushBoost + 0.28);
        // 先端到達後、次のティックですぐ引っ込む
      } else if (t.len <= 0) {
        t.len = 0;
        t.dir = 1;
        t.wait = isGameB ? 0 : 1;
      } else {
        // GAME B または高スコア時は、縮む途中で再び伸び始める「フェイント（切り返し）」が時折発生！
        const feintChance = isGameB ? 0.22 : (this.score >= 100 ? 0.12 : 0.04);
        if (t.dir === -1 && t.len >= 1 && t.len < t.maxLen - 1 && Math.random() < feintChance) {
          t.dir = 1;
        }
      }
    }

    // 安全保証：隣接する足がすべて同時に先端（maxLen）に張り付かないよう調整
    let maxCount = 0;
    for (let i = 0; i < 4; i++) {
      if (this.tentacles[i].len >= this.tentacles[i].maxLen) maxCount++;
    }
    if (maxCount >= 3) {
      const releaseIdx = this.tickCount % 4;
      this.tentacles[releaseIdx].len = this.tentacles[releaseIdx].maxLen - 1;
      this.tentacles[releaseIdx].dir = -1;
    }
  }

  _stepDemoAI() {
    // TIMEモード中に画面内で動くデモダイバーAI
    if (!this.hasBag) {
      if (this.diverPos < 5) {
        const nextPos = this.diverPos + 1;
        if (!this._isPositionDangerous(nextPos)) {
          this.diverPos = nextPos;
        }
      } else {
        this.grabAnimPhase = 1;
        this.grabAnimTimer = 0.2;
        if (Math.random() < 0.45) {
          this.hasBag = true;
        }
      }
    } else {
      if (this.diverPos > 1) {
        const prevPos = this.diverPos - 1;
        if (!this._isPositionDangerous(prevPos)) {
          this.diverPos = prevPos;
        }
      } else {
        this.diverPos = 0;
        this.hasBag = false;
        setTimeout(() => {
          if (this.state === 'TIME') this.diverPos = 1;
        }, 500);
      }
    }
  }

  _onGameOver() {
    this._setStatusText(`GAME OVER — FINAL SCORE: ${this.score}`);
    const modal = document.getElementById('result-modal');
    const modeBadge = document.getElementById('result-mode-badge');
    const scoreVal = document.getElementById('result-score-val');
    const subStats = document.getElementById('result-sub-stats');
    const nameIn = document.getElementById('result-name-input');
    const placeIn = document.getElementById('result-place-input');

    if (modeBadge) modeBadge.textContent = `GAME ${this.gameMode}`;
    if (scoreVal) scoreVal.textContent = String(this.score);
    if (subStats) {
      subStats.textContent = `持ち帰った宝袋: ${this.bagsReturned}個 / 掴んだ財宝: ${this.treasuresGrabbed}個`;
    }
    if (nameIn) nameIn.value = this.playerName;
    if (placeIn) placeIn.value = this.customPlace;

    setTimeout(() => {
      modal?.classList.remove('hidden');
      this.submitScore();
    }, 650);
  }

  /* --------------------------------------------------------------------------
     3. AUTHENTIC 1981 LCD SCREEN RENDERER + GAME C REALISTIC COLOR MODE
     -------------------------------------------------------------------------- */
  _isRealColor() {
    return this.gameMode === 'C' && this.state !== 'TIME';
  }

  _lerpRgb(c1, c2, t) {
    const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
    const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
    const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
    return `rgb(${r}, ${g}, ${b})`;
  }

  _lerpRgba(c1, c2, t, alpha) {
    const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
    const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
    const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);
    return `rgba(${r}, ${g}, ${b}, ${alpha.toFixed(3)})`;
  }

  // GAME C: 空・太陽と月・星空・虹・流れる雲・羽ばたく海鳥・季節と天候パーティクルの描画
  _drawRealisticDynamicSky(ctx, W, H, env) {
    // 4つの時間帯パレット (0:朝焼け Dawn, 1:真昼 Day, 2:夕焼け Sunset, 3:月夜 Night)
    const skyPalettes = [
      { // 0: 朝焼け (Dawn)
        top: [49, 46, 129],
        mid: [192, 132, 252],
        low: [251, 146, 60],
        hor: [254, 240, 138],
        cloudTop: [255, 241, 242],
        cloudBot: [244, 114, 182]
      },
      { // 1: 真昼 (Midday)
        top: [29, 78, 216],
        mid: [59, 130, 246],
        low: [147, 197, 253],
        hor: [254, 249, 195],
        cloudTop: [255, 255, 255],
        cloudBot: [148, 163, 184]
      },
      { // 2: 夕焼け (Sunset)
        top: [30, 27, 75],
        mid: [153, 27, 27],
        low: [234, 88, 12],
        hor: [253, 224, 71],
        cloudTop: [254, 215, 170],
        cloudBot: [154, 52, 18]
      },
      { // 3: 月夜・星空 (Starry Night)
        top: [2, 6, 23],
        mid: [15, 23, 42],
        low: [30, 41, 59],
        hor: [51, 65, 85],
        cloudTop: [148, 163, 184],
        cloudBot: [30, 41, 59]
      }
    ];

    const pA = skyPalettes[env.todIdx % 4];
    const pB = skyPalettes[(env.todIdx + 1) % 4];
    const t = env.todSmooth;

    // 雨天時は空の彩度を少し落として雨雲の重厚感を出す
    const rainDim = env.rainIntensity * 0.38;
    const blendSky = (colA, colB) => {
      const r = colA[0] + (colB[0] - colA[0]) * t;
      const g = colA[1] + (colB[1] - colA[1]) * t;
      const b = colA[2] + (colB[2] - colA[2]) * t;
      return `rgb(${Math.round(r * (1 - rainDim) + 70 * rainDim)}, ${Math.round(g * (1 - rainDim) + 82 * rainDim)}, ${Math.round(b * (1 - rainDim) + 100 * rainDim)})`;
    };

    const skyGrad = ctx.createLinearGradient(0, 0, 0, 114);
    skyGrad.addColorStop(0, blendSky(pA.top, pB.top));
    skyGrad.addColorStop(0.42, blendSky(pA.mid, pB.mid));
    skyGrad.addColorStop(0.78, blendSky(pA.low, pB.low));
    skyGrad.addColorStop(1, blendSky(pA.hor, pB.hor));
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, W, H);

    // 夜〜薄明時の満天の星々と天の川グロー
    let nightWeight = 0;
    if (env.todIdx === 3) nightWeight = 1.0 - env.todSmooth * 0.45;
    else if (env.todIdx === 2) nightWeight = Math.max(0, (env.todSmooth - 0.35) / 0.65);
    else if (env.todIdx === 0) nightWeight = Math.max(0, 0.55 - env.todSmooth * 0.9);
    nightWeight *= (1 - env.rainIntensity * 0.85);

    if (nightWeight > 0.03 && this.skyStars) {
      ctx.save();
      for (const st of this.skyStars) {
        const twinkle = 0.45 + 0.55 * Math.sin(this.bioTime * st.twinkleSpeed + st.phase);
        const a = nightWeight * twinkle;
        ctx.fillStyle = `rgba(248, 250, 252, ${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(st.x, st.y, st.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // 太陽と月の軌道描画
    const sunVis = Math.max(0, 1 - nightWeight * 1.15) * (1 - env.rainIntensity * 0.65);
    if (sunVis > 0.02) {
      const sunProg = Math.min(1, Math.max(0, (env.todCycle < 3.2 ? env.todCycle : 0) / 2.8));
      const sunX = 165 + sunProg * 330;
      const sunY = 78 - Math.sin(sunProg * Math.PI) * 52;
      const isGoldenHour = env.todIdx === 0 || env.todIdx === 2;

      const sunGrad = ctx.createRadialGradient(sunX, sunY, 3, sunX, sunY, isGoldenHour ? 150 : 120);
      sunGrad.addColorStop(0, `rgba(255, 255, 245, ${(0.96 * sunVis).toFixed(3)})`);
      sunGrad.addColorStop(0.18, isGoldenHour ? `rgba(251, 146, 60, ${(0.72 * sunVis).toFixed(3)})` : `rgba(254, 240, 138, ${(0.62 * sunVis).toFixed(3)})`);
      sunGrad.addColorStop(0.55, isGoldenHour ? `rgba(225, 29, 72, ${(0.28 * sunVis).toFixed(3)})` : `rgba(253, 224, 71, ${(0.18 * sunVis).toFixed(3)})`);
      sunGrad.addColorStop(1, 'rgba(254, 240, 138, 0)');
      ctx.fillStyle = sunGrad;
      ctx.fillRect(0, 0, W, 114);

      // 太陽本体ディスク
      ctx.fillStyle = isGoldenHour ? `rgba(254, 215, 170, ${(0.95 * sunVis).toFixed(3)})` : `rgba(255, 255, 240, ${(0.95 * sunVis).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(sunX, sunY, isGoldenHour ? 13.5 : 11, 0, Math.PI * 2);
      ctx.fill();
    }

    // 月夜にはクレーターのあるリアルな満月が輝く
    if (nightWeight > 0.08) {
      const moonX = 335 + Math.sin(this.bioTime * 0.02) * 45;
      const moonY = 34;
      const moonGlow = ctx.createRadialGradient(moonX, moonY, 6, moonX, moonY, 85);
      moonGlow.addColorStop(0, `rgba(254, 249, 195, ${(0.85 * nightWeight).toFixed(3)})`);
      moonGlow.addColorStop(0.32, `rgba(186, 230, 253, ${(0.35 * nightWeight).toFixed(3)})`);
      moonGlow.addColorStop(1, 'rgba(15, 23, 42, 0)');
      ctx.fillStyle = moonGlow;
      ctx.beginPath();
      ctx.arc(moonX, moonY, 85, 0, Math.PI * 2);
      ctx.fill();

      // 月本体と海（クレーター陰影）
      ctx.fillStyle = `rgba(254, 249, 195, ${(0.95 * nightWeight).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(moonX, moonY, 12.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(148, 163, 184, ${(0.32 * nightWeight).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(moonX - 3.5, moonY - 2.5, 3.2, 0, Math.PI * 2);
      ctx.arc(moonX + 4.0, moonY + 3.0, 2.6, 0, Math.PI * 2);
      ctx.arc(moonX + 2.0, moonY - 4.0, 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // 雨上がりの七色の虹 (weatherIdx === 3 付近で空に美しいアーチを描く)
    if (env.rainbowAlpha > 0.02) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, 108);
      ctx.clip();
      const rbColors = [
        [239, 68, 68],   // 赤
        [249, 115, 22],  // 橙
        [250, 204, 21],  // 黄
        [34, 197, 94],   // 緑
        [56, 189, 248],  // 青
        [99, 102, 241],  // 藍
        [168, 85, 247]   // 紫
      ];
      ctx.lineWidth = 2.4;
      for (let i = 0; i < rbColors.length; i++) {
        const c = rbColors[i];
        ctx.strokeStyle = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${(env.rainbowAlpha * 0.42).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(385, 138, 152 - i * 2.2, Math.PI * 1.08, Math.PI * 1.92);
        ctx.stroke();
      }
      ctx.restore();
    }

    // 水平線遠くの島影とゆっくり航行する遠景帆船シルエット
    ctx.save();
    ctx.fillStyle = nightWeight > 0.5 ? 'rgba(15, 23, 42, 0.78)' : 'rgba(51, 65, 85, 0.42)';
    ctx.beginPath();
    ctx.moveTo(415, 104);
    ctx.quadraticCurveTo(442, 91, 468, 97);
    ctx.quadraticCurveTo(486, 93, 508, 104);
    ctx.closePath();
    ctx.fill();

    // 水平線上をゆっくり進む遠景の小型帆船
    const distShipX = 560 - ((this.bioTime * 2.2) % 280);
    ctx.beginPath();
    ctx.moveTo(distShipX - 8, 103);
    ctx.lineTo(distShipX + 8, 103);
    ctx.lineTo(distShipX + 5, 106);
    ctx.lineTo(distShipX - 6, 106);
    ctx.closePath();
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(distShipX, 92);
    ctx.lineTo(distShipX + 5, 102);
    ctx.lineTo(distShipX - 4, 102);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 海面に落ちる雲の影（光源の反対側へ斜めに落ちる）
    const clearSky = Math.pow(Math.max(0, 1.0 - env.rainIntensity * 1.45), 1.6);
    if (this.skyClouds && clearSky > 0.05) {
      const ltSky = this._getDiverLighting(360, 60);
      const cloudShadowAlpha = Math.min(0.28, 0.22 * ltSky.shadowStrength * clearSky);
      if (cloudShadowAlpha > 0.02) {
        ctx.save();
        ctx.fillStyle = ltSky.shadowColor(cloudShadowAlpha);
        for (const cl of this.skyClouds) {
          const csX = cl.x + ltSky.nx * 26 * ltSky.lenMul;
          const csY = 106 + Math.max(3, ltSky.ny * 8);
          ctx.beginPath();
          ctx.ellipse(csX, csY, cl.rx * 0.95, 7.5, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }

    // 流れる立体積雲（時間帯と天候に応じて雲のハイライト・陰影色が変化）
    if (this.skyClouds) {
      const cTop = this._lerpRgba(pA.cloudTop, pB.cloudTop, t, 0.88 - rainDim * 0.15);
      const cBot = this._lerpRgba(pA.cloudBot, pB.cloudBot, t, 0.62 + rainDim * 0.25);
      const ltCloud = this._getDiverLighting(360, 45);
      for (const cl of this.skyClouds) {
        // 光源の反対側へ下部・側面の影がつくようにグラデーションを傾ける
        const cg = ctx.createLinearGradient(
          cl.x - ltCloud.nx * cl.rx * 0.45,
          cl.y - cl.ry * 1.3,
          cl.x + ltCloud.nx * cl.rx * 0.45,
          cl.y + cl.ry
        );
        cg.addColorStop(0, cTop);
        cg.addColorStop(1, cBot);
        ctx.fillStyle = cg;
        ctx.beginPath();
        ctx.ellipse(cl.x, cl.y, cl.rx, cl.ry, 0, 0, Math.PI * 2);
        for (const pf of cl.puffs) {
          ctx.ellipse(cl.x + pf[0], cl.y + pf[1], cl.rx * 0.52 * pf[2], cl.ry * 0.95 * pf[2], 0, 0, Math.PI * 2);
        }
        ctx.fill();
      }
    }

    // 空を飛ぶ多彩なキャラクター群（時間帯・天候に応じてカモメ、ペリカン、アホウドリ、アオサギ、渡り鳥V字編隊、カワセミ、ツバメ、赤トンボ、蝶、夜行性フクロウ、コウモリ、複葉機、飛行船が登場）
    if (this.skyBirds) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, 106);
      ctx.clip();
      for (const bd of this.skyBirds) {
        this._drawSkyFlyerItem(ctx, bd, env, nightWeight);
      }
      ctx.restore();
    }

    // 季節＆天候パーティクル（雨粒・春の桜花びら・秋の紅葉・冬の雪結晶）
    if (this.weatherParticles) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, 108);
      ctx.clip();
      for (const wp of this.weatherParticles) {
        if (env.rainIntensity > 0.15) {
          // 通り雨の銀色の雨筋
          ctx.strokeStyle = `rgba(224, 242, 254, ${(0.35 + env.rainIntensity * 0.45).toFixed(3)})`;
          ctx.lineWidth = 1.2;
          ctx.beginPath();
          ctx.moveTo(wp.x, wp.y);
          ctx.lineTo(wp.x + 3.5, wp.y - 11);
          ctx.stroke();
        } else if (env.seasonIdx === 0) {
          // 春：風に舞う桜の花びら
          ctx.save();
          ctx.translate(wp.x, wp.y);
          ctx.rotate(wp.rot);
          ctx.fillStyle = 'rgba(251, 207, 232, 0.86)';
          ctx.beginPath();
          ctx.ellipse(0, 0, wp.size * 1.05, wp.size * 0.62, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        } else if (env.seasonIdx === 2) {
          // 秋：舞い散る紅葉・黄金葉
          ctx.save();
          ctx.translate(wp.x, wp.y);
          ctx.rotate(wp.rot);
          ctx.fillStyle = (Math.floor(wp.phase * 10) % 2 === 0) ? 'rgba(239, 68, 68, 0.85)' : 'rgba(245, 158, 11, 0.85)';
          ctx.beginPath();
          ctx.moveTo(0, -wp.size);
          ctx.lineTo(wp.size * 0.8, 0);
          ctx.lineTo(0, wp.size);
          ctx.lineTo(-wp.size * 0.8, 0);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        } else if (env.seasonIdx === 3) {
          // 冬：舞い降りる雪の結晶
          ctx.fillStyle = 'rgba(255, 255, 255, 0.88)';
          ctx.beginPath();
          ctx.arc(wp.x, wp.y, wp.size * 0.58, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }
  }

  // GAME C: 海流にたなびく超リアルな海藻群（ジャイアントケルプ・カジメ・紅藻）の描画
  _drawRealisticSwayingKelp(ctx) {
    if (!this.kelpPlants) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const kp of this.kelpPlants) {
      const segments = kp.blades;
      const segLen = kp.height / segments;
      const spinePts = [{ x: kp.baseX, y: kp.baseY }];

      let currX = kp.baseX;
      let currY = kp.baseY;
      for (let s = 1; s <= segments; s++) {
        const u = s / segments;
        // 海流の進行波（根元はしっかり、先端ほど大きくしなやかに揺れる）
        const wave = Math.sin(this.bioTime * kp.freq - s * 0.48 + kp.phase) * (5 + u * 16)
                   + Math.cos(this.bioTime * (kp.freq * 0.62) + kp.phase) * (u * 6);
        currX = kp.baseX + wave;
        currY = kp.baseY - s * segLen;
        spinePts.push({ x: currX, y: currY, u });
      }

      // 1. 各節から左右に広がるリアルな葉状体（フリル＆鋸歯エッジ・葉脈・気胞付き）
      for (let s = 1; s < spinePts.length; s++) {
        const pt = spinePts[s];
        const side = (s % 2 === 0) ? 1 : -1;
        const u = pt.u;
        const bladeLen = (18 + Math.sin(u * Math.PI) * 22) * (kp.kind === 'red' ? 0.75 : 1.0);
        const bladeWid = (5.2 + Math.sin(u * Math.PI) * 4.5) * (kp.kind === 'red' ? 0.82 : 1.0);
        const flutter = Math.sin(this.bioTime * (kp.freq * 1.6) - s * 0.7 + kp.phase) * 0.32;
        const angle = (side > 0 ? -0.38 : -2.76) + flutter;

        ctx.save();
        ctx.translate(pt.x, pt.y);
        ctx.rotate(angle);

        // 根元の気胞（ウキ袋：ジャイアントケルプ特有の丸い浮き球）
        if (kp.kind !== 'red') {
          ctx.fillStyle = `hsla(${kp.hue + 12}, ${kp.sat + 10}%, ${kp.light + 16}%, 0.92)`;
          ctx.beginPath();
          ctx.ellipse(3.2, 0, 3.2, 2.3, 0, 0, Math.PI * 2);
          ctx.fill();
        }

        // 半透明の太陽光透過グラデーションを持つ葉身
        const bGrad = ctx.createLinearGradient(0, -bladeWid, bladeLen, bladeWid);
        bGrad.addColorStop(0, `hsla(${kp.hue - 6}, ${kp.sat}%, ${kp.light - 4}%, 0.86)`);
        bGrad.addColorStop(0.55, `hsla(${kp.hue + 8}, ${kp.sat + 12}%, ${kp.light + 12}%, 0.78)`);
        bGrad.addColorStop(1, `hsla(${kp.hue + 18}, ${kp.sat + 16}%, ${kp.light + 22}%, 0.62)`);
        ctx.fillStyle = bGrad;
        ctx.strokeStyle = `hsla(${kp.hue + 16}, ${kp.sat + 14}%, ${kp.light + 20}%, 0.55)`;
        ctx.lineWidth = 0.9;

        // 波打つ鋸歯（ギザギザ）状のリアルな海藻ブレード輪郭
        ctx.beginPath();
        ctx.moveTo(4, 0);
        const ripples = 4;
        for (let r = 1; r <= ripples; r++) {
          const rx = 4 + (bladeLen - 4) * (r / ripples);
          const prevX = 4 + (bladeLen - 4) * ((r - 0.5) / ripples);
          const w = bladeWid * Math.sin((r / ripples) * Math.PI * 0.92);
          const waveOff = Math.sin(this.bioTime * 3.2 + r * 1.4 + s) * 1.6;
          ctx.quadraticCurveTo(prevX, -w * 1.25 + waveOff, rx, -w * 0.72 + waveOff);
        }
        ctx.lineTo(bladeLen + 2, Math.sin(this.bioTime * 3.5 + s) * 2.0);
        for (let r = ripples; r >= 1; r--) {
          const rx = 4 + (bladeLen - 4) * ((r - 1) / ripples);
          const midX = 4 + (bladeLen - 4) * ((r - 0.5) / ripples);
          const w = bladeWid * Math.sin((r / ripples) * Math.PI * 0.92);
          const waveOff = Math.sin(this.bioTime * 3.2 + r * 1.4 + s) * 1.6;
          ctx.quadraticCurveTo(midX, w * 1.25 + waveOff, rx, (r === 1 ? 0 : w * 0.72 + waveOff));
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // 葉の中央を走る主脈（ミッドリブ）
        ctx.strokeStyle = `hsla(${kp.hue + 20}, ${kp.sat + 18}%, ${kp.light + 26}%, 0.52)`;
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(4, 0);
        ctx.quadraticCurveTo(bladeLen * 0.5, Math.sin(this.bioTime * 3.2 + s) * 1.8, bladeLen * 0.92, Math.sin(this.bioTime * 3.5 + s) * 1.6);
        ctx.stroke();

        ctx.restore();
      }

      // 2. しなやかに湾曲する主茎（スタイプ）と根元の付着器（ホールドファスト）
      ctx.strokeStyle = `hsla(${kp.hue - 8}, ${kp.sat}%, ${kp.light - 2}%, 0.94)`;
      ctx.lineWidth = 3.4;
      ctx.beginPath();
      ctx.moveTo(spinePts[0].x, spinePts[0].y);
      for (let s = 1; s < spinePts.length; s++) {
        const prev = spinePts[s - 1];
        const curr = spinePts[s];
        const mx = (prev.x + curr.x) * 0.5;
        const my = (prev.y + curr.y) * 0.5;
        ctx.quadraticCurveTo(prev.x, prev.y, mx, my);
      }
      const last = spinePts[spinePts.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();

      // 茎のハイライトライン
      ctx.strokeStyle = `hsla(${kp.hue + 14}, ${kp.sat + 12}%, ${kp.light + 18}%, 0.45)`;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    // 3. 海底の岩肌や砂地に棲むヒトデ＆横歩きするカニ
    this._drawSeabedCritters(ctx);

    ctx.restore();
  }

  // 海底の岩礁・砂地を横歩きするカニと五芒星のヒトデ
  _drawSeabedCritters(ctx) {
    // (A) 岩礁と砂地の五芒星ヒトデ（2匹：オレンジ＆紅紫）
    const starfishes = [
      { x: 64,  y: 356, r: 7.5, rot: 0.4,  col: '#f97316', dot: '#fef08a' },
      { x: 332, y: 436, r: 6.8, rot: -0.2, col: '#ec4899', dot: '#fbcfe8' }
    ];
    for (const sf of starfishes) {
      ctx.save();
      ctx.translate(sf.x, sf.y);
      ctx.rotate(sf.rot + Math.sin(this.bioTime * 0.8 + sf.x) * 0.04);
      ctx.scale(1.0, 0.62);
      ctx.fillStyle = sf.col;
      ctx.strokeStyle = 'rgba(67, 20, 7, 0.65)';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i * Math.PI) / 5 - Math.PI * 0.5;
        const rad = (i % 2 === 0) ? sf.r : sf.r * 0.42;
        const px = Math.cos(a) * rad;
        const py = Math.sin(a) * rad;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = sf.dot;
      ctx.beginPath();
      ctx.arc(0, 0, 1.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // (B) 海底をハサミを振りながらチョコチョコ横歩きする赤いカニ（2匹）
    const crabs = [
      { baseX: 215, baseY: 424, range: 26, speed: 1.35, phase: 0.0, scale: 0.88 },
      { baseX: 448, baseY: 438, range: 22, speed: 1.65, phase: 2.4, scale: 0.78 }
    ];
    for (const cb of crabs) {
      const cx = cb.baseX + Math.sin(this.bioTime * cb.speed + cb.phase) * cb.range;
      const legWave = Math.sin(this.bioTime * 11.0 + cb.phase);
      const clawSnap = Math.abs(Math.sin(this.bioTime * 3.8 + cb.phase)) * 0.35;
      ctx.save();
      ctx.translate(cx, cb.baseY);
      ctx.scale(cb.scale, cb.scale);

      // 左右の歩脚（4対）
      ctx.strokeStyle = '#b91c1c';
      ctx.lineWidth = 1.4;
      for (let l = -1; l <= 1; l += 2) {
        for (let k = 0; k < 3; k++) {
          const lift = (k % 2 === 0 ? legWave : -legWave) * 1.6;
          ctx.beginPath();
          ctx.moveTo(l * 4, k * 1.4 - 1);
          ctx.lineTo(l * (8 + k * 1.5), k * 1.5 - 2 + lift);
          ctx.lineTo(l * (10 + k * 1.5), k * 2.2 + 2.5 + lift);
          ctx.stroke();
        }
      }

      // 振り上げた大きなハサミ（鉗脚）
      for (let side = -1; side <= 1; side += 2) {
        ctx.save();
        ctx.translate(side * 5.5, -2.5);
        ctx.rotate(side * (-0.35 + clawSnap * 0.4));
        ctx.strokeStyle = '#dc2626';
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(side * 3.5, -4.5);
        ctx.stroke();
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(side * 4.2, -6.2, 2.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }

      // 甲羅と飛び出た2つの目
      ctx.fillStyle = '#dc2626';
      ctx.strokeStyle = '#7f1d1d';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.ellipse(0, 0, 6.2, 4.0, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = '#111827';
      ctx.beginPath();
      ctx.arc(-2.2, -4.5, 1.1, 0, Math.PI * 2);
      ctx.arc(2.2, -4.5, 1.1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // (C) 海底の砂地からひょっこり顔を出して潮に揺れるチンアナゴ＆ニシキアナゴの群れ（5匹：プレイ途中から砂の中から順に顔を出す）
    const eelReveal = this._seabedRevealAlpha('garden_eel');
    const eels = [
      { x: 162, y: 392, h: 20, kind: 'spotted', phase: 0.3 },
      { x: 171, y: 396, h: 17, kind: 'banded',  phase: 1.5 },
      { x: 179, y: 394, h: 22, kind: 'spotted', phase: 2.7 },
      { x: 348, y: 432, h: 21, kind: 'banded',  phase: 0.9 },
      { x: 358, y: 434, h: 18, kind: 'spotted', phase: 2.1 }
    ];
    for (const el of eels) {
      if (eelReveal <= 0) break;
      const sway = Math.sin(this.bioTime * 2.6 + el.phase) * 4.2;
      const emerge = Math.min(1, eelReveal * 1.15);
      ctx.save();
      ctx.globalAlpha = Math.min(1, eelReveal * 1.6);
      ctx.translate(el.x, el.y);
      ctx.scale(1, emerge);
      ctx.lineCap = 'round';
      ctx.strokeStyle = el.kind === 'banded' ? '#f97316' : '#f1f5f9';
      ctx.lineWidth = 3.0;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(sway * 0.5, -el.h * 0.55, sway, -el.h);
      ctx.quadraticCurveTo(sway + 3.5, -el.h - 2.2, sway + 5.2, -el.h + 0.5);
      ctx.stroke();
      if (el.kind === 'banded') {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2.8;
        ctx.beginPath();
        ctx.moveTo(sway * 0.3, -el.h * 0.35);
        ctx.lineTo(sway * 0.45, -el.h * 0.50);
        ctx.moveTo(sway * 0.7, -el.h * 0.72);
        ctx.lineTo(sway * 0.85, -el.h * 0.86);
        ctx.stroke();
      } else {
        ctx.fillStyle = '#1e293b';
        ctx.beginPath();
        ctx.arc(sway * 0.35, -el.h * 0.38, 0.9, 0, Math.PI * 2);
        ctx.arc(sway * 0.72, -el.h * 0.72, 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(sway + 3.2, -el.h - 0.6, 0.85, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // (D) 螺旋の巻貝を背負って歩くヤドカリ（プレイ後半に登場）
    const hermitReveal = this._seabedRevealAlpha('hermit_crab');
    if (hermitReveal <= 0) return;
    const hx = 292 + Math.sin(this.bioTime * 0.95 + 1.1) * 16;
    ctx.save();
    ctx.globalAlpha = hermitReveal;
    ctx.translate(hx, 428);
    ctx.fillStyle = '#d97706';
    ctx.strokeStyle = '#78350f';
    ctx.lineWidth = 1.0;
    ctx.beginPath();
    ctx.moveTo(-6, 1);
    ctx.quadraticCurveTo(-2, -8, 6, -3);
    ctx.quadraticCurveTo(9, 1, -6, 1);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(-4, 1); ctx.lineTo(-7, 3.5);
    ctx.moveTo(-2, 1); ctx.lineTo(-4, 4.0);
    ctx.stroke();
    ctx.restore();
  }

  /* --------------------------------------------------------------------------
     空と海の仲間たちの「段階的な登場（ディスカバリー）」演出
     ・ゲーム開始時は空2体・海3体だけ。プレイ時間が進むたびに1種類ずつ新しい仲間が画面外から登場する
     ・登場時は画面の端から泳ぎ／飛び込んできて、ふわっとフェードイン＋ステータス欄で「NEW!」を告知
     -------------------------------------------------------------------------- */
  _getCreatureJpName(kind) {
    const names = {
      seagull: 'カモメ', pelican: 'ペリカン', albatross: 'アホウドリ', heron: 'アオサギ',
      goose_flock: '渡り鳥の群れ', kingfisher: 'カワセミ', swallow: 'ツバメ', dragonfly: '赤トンボ',
      butterfly: 'アゲハチョウ', owl: 'フクロウ', bat: 'コウモリ', biplane: '複葉機', blimp: '飛行船',
      hot_air_balloon: '熱気球', flamingo: 'フラミンゴ', eagle: 'ハクトウワシ', macaw: 'コンゴウインコ', ufo: 'UFO',
      black_kite: 'トビ', toucan: 'オオハシ', weather_balloon: '気象観測気球', pterosaur: 'プテラノドン', firework_rocket: '打ち上げ花火', pegasus: '天馬ペガサス',
      sardine_school: 'イワシの群れ', clownfish: 'カクレクマノミ', angelfish: 'キンチャクダイ',
      butterflyfish: 'チョウチョウウオ', sea_turtle: 'ウミガメ', manta_ray: 'マンタ', jellyfish: 'クラゲ',
      seahorse: 'タツノオトシゴ', pufferfish: 'ハリセンボン', dolphin: 'イルカ', shark: 'サメ',
      sunfish: 'マンボウ', anglerfish: 'チョウチンアンコウ', nautilus: 'オウムガイ', flying_fish: 'トビウオ',
      whale: 'ザトウクジラ', orca: 'シャチ', swordfish: 'メカジキ', eagle_ray: 'マダラトビエイ',
      boxfish: 'ハコフグ', mini_octopus: 'メンダコ', moray_eel: 'ウツボ',
      hammerhead: 'シュモクザメ', clione: 'クリオネ', whale_shark: 'ジンベエザメ', oarfish: 'リュウグウノツカイ',
      coelacanth: 'シーラカンス', bathysphere: '潜水探査球', mermaid: '人魚マーメイド',
      garden_eel: 'チンアナゴ', hermit_crab: 'ヤドカリ'
    };
    return names[kind] || kind;
  }

  _resetCreatureDiscovery() {
    this.discoveryAnnounced = {};
    this.seabedRevealT = {};

    // 同じ種類が連続するもの（カモメ2羽・クマノミのペア等）は1つのグループとして同時に登場させる
    const buildGroups = (list, starters) => {
      const groups = [];
      let prev = null;
      (list || []).forEach((it, i) => {
        if (i < starters) {
          it.unlockScore = 0;
          it.revealed = true;
          it.revealT = 1;
          prev = it.kind;
          return;
        }
        if (it.kind !== prev || groups.length === 0) groups.push([]);
        groups[groups.length - 1].push(it);
        it.revealed = false;
        it.revealT = 0;
        prev = it.kind;
      });
      return groups;
    };
    // 開始時：空はカモメ2羽、海はイワシの群れ＋クマノミのペアだけ
    const skyGroups = buildGroups(this.skyBirds, 2);
    const seaGroups = buildGroups(this.underwaterFish, 3);

    // 海 → 空 → 海 → 空… と交互に並べ、途中に海底の隠れキャラ（チンアナゴ・ヤドカリ）を挟む
    const order = [];
    const maxLen = Math.max(skyGroups.length, seaGroups.length);
    for (let i = 0; i < maxLen; i++) {
      if (seaGroups[i]) order.push({ type: 'group', items: seaGroups[i] });
      if (skyGroups[i]) order.push({ type: 'group', items: skyGroups[i] });
      if (order.length === 18) order.push({ type: 'seabed', kind: 'garden_eel' });
      if (order.length === 34) order.push({ type: 'seabed', kind: 'hermit_crab' });
    }

    // 点数しきい値：序盤はサクサク、後半ほど高得点が必要（k番目 ≒ 4k + 0.06k²点：5,8,13…約200点で半分、全員集合は約400点）
    this.seabedUnlocks = {};
    this.creatureUnlockScores = [];
    order.forEach((step, idx) => {
      const k = idx + 1;
      const need = Math.round(4 * k + 0.06 * k * k);
      this.creatureUnlockScores.push(need);
      if (step.type === 'seabed') {
        this.seabedUnlocks[step.kind] = need;
      } else {
        for (const it of step.items) it.unlockScore = need;
      }
    });
  }

  // 現在の「発見ポイント」：GAME中はスコア、TIME（時計・デモ）表示中は全員集合で賑やかに見せる
  _getDiscoveryProgress() {
    if (this.state === 'TIME') return Infinity;
    return Math.max(0, this.score || 0);
  }

  _updateCreatureDiscovery(dt) {
    if (!this.creatureUnlockScores) this._resetCreatureDiscovery();
    const progress = this._getDiscoveryProgress();
    const announce = (kind) => {
      if (this.discoveryAnnounced[kind]) return;
      this.discoveryAnnounced[kind] = true;
      if (this._isRealColor() && this.state !== 'TIME') {
        const next = this.creatureUnlockScores.find(s => s > progress);
        const nextMsg = next ? `（次の仲間は ${next} 点で登場）` : '（全員集合！）';
        this._setStatusText(`✨ NEW! ${this._getCreatureJpName(kind)} が現れた！${nextMsg}`);
      }
    };

    const revealList = (list, leftX, rightX) => {
      if (!list) return;
      for (const it of list) {
        if (!it.revealed && progress >= it.unlockScore) {
          it.revealed = true;
          it.revealT = 0;
          // 画面の外側から飛び込んで／泳いで登場する
          it.x = it.vx >= 0 ? leftX : rightX;
          announce(it.kind);
        }
        if (it.revealed && it.revealT < 1) {
          it.revealT = Math.min(1, it.revealT + dt / 2.2);
        }
      }
    };
    revealList(this.skyBirds, -40, 760);
    revealList(this.underwaterFish, -45, 765);

    if (this.seabedUnlocks) {
      for (const k of Object.keys(this.seabedUnlocks)) {
        if (progress >= this.seabedUnlocks[k]) {
          announce(k);
          this.seabedRevealT[k] = Math.min(1, (this.seabedRevealT[k] || 0) + dt / 2.5);
        }
      }
    }
  }

  _seabedRevealAlpha(kind) {
    if (!this.seabedUnlocks || !this.seabedRevealT) return 1;
    if (this._getDiscoveryProgress() === Infinity) return 1;
    return this.seabedRevealT[kind] || 0;
  }

  // 空を飛ぶ18種類のキャラクターの個別描画
  _drawSkyFlyerItem(ctx, bd, env, nightWeight) {
    if (bd.revealed === false) return;
    // どの時間帯・天候でもバラエティ豊かなキャラが画面に賑やかに見えるよう高い視認性を保つ
    let visAlpha = 0.96;
    if (bd.activeTime === 'night') {
      visAlpha = 0.78 + nightWeight * 0.22;
    }
    visAlpha *= (typeof bd.revealT === 'number' ? bd.revealT : 1);
    if (visAlpha <= 0.01) return;
    const dir = bd.vx >= 0 ? 1 : -1;
    const flap = Math.sin(this.bioTime * bd.wingSpeed + bd.phase);
    const kind = bd.kind || 'seagull';

    ctx.save();
    ctx.globalAlpha = visAlpha;
    ctx.translate(bd.x, bd.y);
    ctx.scale(dir * bd.scale, bd.scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (kind === 'seagull') {
      // 1. カモメ（白い翼・黒い翼端・黄色いくちばし）
      const wy = flap * 5.2;
      ctx.fillStyle = '#f8fafc';
      ctx.strokeStyle = '#334155';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(0, 0, 5.2, 2.1, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#f8fafc';
      ctx.lineWidth = 2.1;
      ctx.beginPath();
      ctx.moveTo(-1, -0.5);
      ctx.quadraticCurveTo(-5, -wy * 0.5 - 2.5, -9.5, -wy);
      ctx.moveTo(1, -0.5);
      ctx.quadraticCurveTo(5, -wy * 0.5 - 2.5, 9.5, -wy);
      ctx.stroke();
      // 黒い翼端と黄色いくちばし
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(-8.0, -wy * 0.85); ctx.lineTo(-10.2, -wy);
      ctx.moveTo(8.0, -wy * 0.85);  ctx.lineTo(10.2, -wy);
      ctx.stroke();
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(5.0, 0); ctx.lineTo(7.5, 0.5);
      ctx.stroke();
    } else if (kind === 'pelican') {
      // 2. ペリカン（大きな黄色い喉袋とゆったり羽ばたく広い翼）
      const wy = flap * 5.8;
      ctx.fillStyle = '#f1f5f9';
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(-1, 0.5, 7.0, 3.0, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // 頭と大きなオレンジ黄色の喉袋（ポーチ）
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(5.5, -1.8, 2.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f59e0b';
      ctx.beginPath();
      ctx.moveTo(6.8, -2.2);
      ctx.lineTo(13.2, -1.5);
      ctx.quadraticCurveTo(10.5, 3.2, 6.2, 0.4);
      ctx.closePath();
      ctx.fill();
      // 広い翼
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(-1, -0.5);
      ctx.quadraticCurveTo(1, -wy - 3.5, -7, -wy - 1.5);
      ctx.stroke();
    } else if (kind === 'albatross') {
      // 3. アホウドリ（長大なグライダー翼で風を切る大型海鳥）
      const wy = flap * 3.2;
      ctx.strokeStyle = nightWeight > 0.5 ? '#e2e8f0' : '#1e293b';
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(-14, -wy - 1);
      ctx.quadraticCurveTo(-6, -wy * 0.4 - 3.5, 0, 0);
      ctx.quadraticCurveTo(6, -wy * 0.4 - 3.5, 14, -wy - 1);
      ctx.stroke();
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.ellipse(0, 0.5, 5.5, 1.8, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'heron') {
      // 4. アオサギ（長い脚を後ろに伸ばし、青灰色の翼で優雅に飛ぶ）
      const wy = flap * 6.0;
      ctx.strokeStyle = '#f59e0b';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-5, 0.8); ctx.lineTo(-13.5, 2.2);
      ctx.moveTo(6.5, -1.2); ctx.lineTo(10.8, -1.0);
      ctx.stroke();
      ctx.fillStyle = '#94a3b8';
      ctx.beginPath();
      ctx.ellipse(0, 0, 6.0, 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 2.3;
      ctx.beginPath();
      ctx.moveTo(-1, 0);
      ctx.quadraticCurveTo(0, -wy - 3, -6, -wy);
      ctx.stroke();
    } else if (kind === 'goose_flock') {
      // 5. 渡り鳥の5羽V字フォーメーション編隊
      const offsets = [[0, 0, 1.0], [-7, -4.5, 0.88], [-7, 4.5, 0.88], [-14, -9, 0.78], [-14, 9, 0.78]];
      ctx.strokeStyle = nightWeight > 0.45 ? 'rgba(241, 245, 249, 0.85)' : 'rgba(30, 41, 59, 0.82)';
      for (let i = 0; i < offsets.length; i++) {
        const [ox, oy, os] = offsets[i];
        const fLocal = Math.sin(this.bioTime * bd.wingSpeed + bd.phase - i * 0.55) * 3.8 * os;
        ctx.lineWidth = 1.5 * os;
        ctx.beginPath();
        ctx.moveTo(ox - 4.5 * os, oy - fLocal);
        ctx.quadraticCurveTo(ox - 1.8 * os, oy - fLocal * 0.4 - 1.2, ox, oy);
        ctx.quadraticCurveTo(ox + 1.8 * os, oy - fLocal * 0.4 - 1.2, ox + 4.5 * os, oy - fLocal);
        ctx.stroke();
      }
    } else if (kind === 'kingfisher') {
      // 6. カワセミ（鮮やかなコバルトブルーの背とオレンジの胸・高速羽ばたき）
      const wy = flap * 4.5;
      ctx.fillStyle = '#ea580c';
      ctx.beginPath();
      ctx.ellipse(0, 0.8, 3.8, 1.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0284c7';
      ctx.beginPath();
      ctx.ellipse(0.5, -0.5, 4.2, 1.7, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(0, -0.5); ctx.lineTo(-2.5, -wy - 1.5);
      ctx.stroke();
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(4.2, -0.4); ctx.lineTo(7.5, -0.4);
      ctx.stroke();
    } else if (kind === 'swallow') {
      // 7. ツバメ（紺色の流線型ボディと二股に分かれた燕尾）
      const wy = flap * 4.8;
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      // 二股の燕尾
      ctx.moveTo(-2, 0); ctx.lineTo(-8.5, -2.5);
      ctx.moveTo(-2, 0); ctx.lineTo(-8.5, 2.5);
      // 鋭い後退翼
      ctx.moveTo(1, 0); ctx.lineTo(-2.5, -wy - 2.2);
      ctx.moveTo(1, 0); ctx.lineTo(-2.5, wy + 2.2);
      ctx.stroke();
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.ellipse(0.8, 0, 3.8, 1.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#dc2626';
      ctx.beginPath();
      ctx.arc(3.6, 0.2, 1.1, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'dragonfly') {
      // 8. 赤トンボ（細い赤い腹とキラキラ光る4枚の透明翅）
      const wy = flap * 3.5;
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-7.5, 0); ctx.lineTo(3.5, 0);
      ctx.stroke();
      ctx.fillStyle = '#b91c1c';
      ctx.beginPath();
      ctx.arc(4.0, 0, 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(224, 242, 254, 0.72)';
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.8)';
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.ellipse(1.2, -2.2 - wy * 0.4, 1.6, 4.6, 0.25, 0, Math.PI * 2);
      ctx.ellipse(-0.8, -2.0 + wy * 0.4, 1.4, 4.2, -0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'butterfly') {
      // 9. アゲハチョウ（ひらひら舞う黄色と黒縁の華やかな翅）
      const wingScale = 0.25 + 0.75 * Math.abs(flap);
      ctx.save();
      ctx.scale(1.0, wingScale);
      ctx.fillStyle = '#facc15';
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.ellipse(1.2, -3.2, 3.6, 4.2, 0.3, 0, Math.PI * 2);
      ctx.ellipse(-2.0, -2.6, 2.8, 3.4, -0.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.arc(-2.2, -2.8, 1.0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    } else if (kind === 'owl') {
      // 10. 夜行性フクロウ（丸い頭・金色に光る両目・音もなく羽ばたく広い茶色の翼）
      const wy = flap * 5.2;
      ctx.fillStyle = '#78350f';
      ctx.strokeStyle = '#451a03';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(-8, -wy);
      ctx.quadraticCurveTo(-3, -wy * 0.5 - 3, 0, 0);
      ctx.quadraticCurveTo(3, -wy * 0.5 - 3, 8, -wy);
      ctx.quadraticCurveTo(3, 2.5, 0, 2.5);
      ctx.quadraticCurveTo(-3, 2.5, -8, -wy);
      ctx.fill();
      ctx.stroke();
      // 丸い顔と光る金色の目
      ctx.fillStyle = '#92400e';
      ctx.beginPath();
      ctx.arc(2.2, -0.5, 2.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fde047';
      ctx.beginPath();
      ctx.arc(1.5, -0.8, 0.9, 0, Math.PI * 2);
      ctx.arc(3.2, -0.8, 0.9, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'bat') {
      // 11. 夜行性コウモリ（ピンと立った耳とギザギザの黒い翼膜）
      const wy = flap * 4.8;
      ctx.fillStyle = '#1e1b4b';
      ctx.strokeStyle = '#312e81';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(0, -1.5);
      ctx.lineTo(-7.5, -wy - 2);
      ctx.quadraticCurveTo(-5.0, 2.0, -2.5, 1.2);
      ctx.quadraticCurveTo(0, 2.5, 2.5, 1.2);
      ctx.quadraticCurveTo(5.0, 2.0, 7.5, -wy - 2);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // 耳
      ctx.beginPath();
      ctx.moveTo(-1.2, -1.2); ctx.lineTo(-1.8, -3.4); ctx.lineTo(-0.3, -1.5);
      ctx.moveTo(1.2, -1.2);  ctx.lineTo(1.8, -3.4);  ctx.lineTo(0.3, -1.5);
      ctx.fill();
    } else if (kind === 'biplane') {
      // 12A. レトロな赤複葉機（プロペラ回転＆上下2枚翼）
      ctx.fillStyle = '#dc2626';
      ctx.strokeStyle = '#7f1d1d';
      ctx.lineWidth = 1.0;
      // 胴体と垂直尾翼
      ctx.beginPath();
      ctx.moveTo(-9, -0.5);
      ctx.lineTo(7, -1.2);
      ctx.lineTo(7, 1.8);
      ctx.lineTo(-9, 1.2);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-9, -0.5); ctx.lineTo(-11.5, -4.2); ctx.lineTo(-7.0, -0.5);
      ctx.closePath();
      ctx.fill();
      // 上下2枚の翼と支柱
      ctx.strokeStyle = '#fef08a';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(-2, -3.8); ctx.lineTo(5, -3.8);
      ctx.moveTo(-2, 2.2);  ctx.lineTo(5, 2.2);
      ctx.stroke();
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(0, -3.8); ctx.lineTo(0, 2.2);
      ctx.moveTo(3.5, -3.8); ctx.lineTo(3.5, 2.2);
      ctx.stroke();
      // 高速回転するプロペラ
      const propH = 1.2 + Math.abs(flap) * 3.4;
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.85)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(8.0, -propH); ctx.lineTo(8.0, propH);
      ctx.stroke();
    } else if (kind === 'blimp') {
      // 12B. 水平線の上空をゆったり進むレトロ飛行船
      const bg = ctx.createLinearGradient(0, -5, 0, 5);
      bg.addColorStop(0, '#f8fafc');
      bg.addColorStop(0.55, '#cbd5e1');
      bg.addColorStop(1, '#64748b');
      ctx.fillStyle = bg;
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.ellipse(0, 0, 13.5, 5.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // 赤いラインと尾翼・ゴンドラ
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(-11, 0); ctx.lineTo(11, 0);
      ctx.stroke();
      ctx.fillStyle = '#dc2626';
      ctx.beginPath();
      ctx.moveTo(-10, -2); ctx.lineTo(-14.5, -5.5); ctx.lineTo(-12.5, 0);
      ctx.moveTo(-10, 2);  ctx.lineTo(-14.5, 5.5);  ctx.lineTo(-12.5, 0);
      ctx.fill();
      ctx.fillStyle = '#334155';
      ctx.fillRect(-3.5, 5.0, 7.0, 2.2);
    } else if (kind === 'hot_air_balloon') {
      // 13. カラフルなストライプの熱気球（バスケットとバーナーの灯り付き）
      const bob = Math.sin(this.bioTime * 1.8 + bd.phase) * 1.5;
      ctx.translate(0, bob);
      // バスケットと吊りロープ
      ctx.strokeStyle = '#78350f';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(-2.5, 5.5); ctx.lineTo(-1.8, 9.2);
      ctx.moveTo(2.5, 5.5);  ctx.lineTo(1.8, 9.2);
      ctx.stroke();
      ctx.fillStyle = '#92400e';
      ctx.fillRect(-2.4, 9.0, 4.8, 3.2);
      // バーナーの炎の輝き
      ctx.fillStyle = '#fef08a';
      ctx.beginPath();
      ctx.arc(0, 7.2, 1.4 + Math.abs(flap) * 0.6, 0, Math.PI * 2);
      ctx.fill();
      // バルーン球体
      const hg = ctx.createRadialGradient(-2.5, -2.5, 1.0, 0, -1.0, 9.5);
      hg.addColorStop(0, '#fef08a');
      hg.addColorStop(0.38, '#f97316');
      hg.addColorStop(0.72, '#ef4444');
      hg.addColorStop(1, '#7c2d12');
      ctx.fillStyle = hg;
      ctx.strokeStyle = '#451a03';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.arc(0, -1.5, 7.2, Math.PI * 0.82, Math.PI * 0.18, false);
      ctx.lineTo(2.8, 5.8);
      ctx.lineTo(-2.8, 5.8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // カラフルな横ストライプ帯
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-6.8, -1.5);
      ctx.quadraticCurveTo(0, -3.2, 6.8, -1.5);
      ctx.stroke();
    } else if (kind === 'flamingo') {
      // 14. ピンク色のフラミンゴ（真っ直ぐ伸ばした長い首と脚、黒縁の翼）
      const wy = flap * 5.8;
      ctx.strokeStyle = '#f472b6';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-4, 0.5); ctx.lineTo(-12.5, 1.2);
      ctx.moveTo(4, -0.2); ctx.lineTo(11.5, -1.2);
      ctx.stroke();
      ctx.fillStyle = '#f472b6';
      ctx.beginPath();
      ctx.ellipse(0, 0, 5.2, 2.3, 0, 0, Math.PI * 2);
      ctx.arc(11.8, -1.2, 1.6, 0, Math.PI * 2);
      ctx.fill();
      // 下に曲がった黒いくちばし
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(13.0, -1.2); ctx.lineTo(14.5, 0.4);
      ctx.stroke();
      // ローズピンクと黒の翼
      ctx.strokeStyle = '#ec4899';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.quadraticCurveTo(-2, -wy * 0.6 - 2, -6.5, -wy);
      ctx.moveTo(1, 0); ctx.quadraticCurveTo(4, -wy * 0.6 - 2, 7.5, -wy);
      ctx.stroke();
    } else if (kind === 'eagle') {
      // 15. ハクトウワシ（白い頭と尾・ダークブラウンの力強い大翼・黄色い鉤爪とくちばし）
      const wy = flap * 5.0;
      ctx.fillStyle = '#451a03';
      ctx.beginPath();
      ctx.ellipse(0, 0, 6.8, 2.8, 0, 0, Math.PI * 2);
      ctx.fill();
      // 白い頭部と白い尾羽
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(6.2, -0.4, 2.4, 0, Math.PI * 2);
      ctx.moveTo(-6.0, 0); ctx.lineTo(-10.5, -2.2); ctx.lineTo(-10.5, 2.2);
      ctx.closePath();
      ctx.fill();
      // 黄色い猛禽類のくちばし
      ctx.fillStyle = '#facc15';
      ctx.beginPath();
      ctx.moveTo(8.2, -1.0); ctx.lineTo(10.8, 0.2); ctx.lineTo(8.0, 0.8);
      ctx.closePath();
      ctx.fill();
      // 力強い大翼
      ctx.strokeStyle = '#78350f';
      ctx.lineWidth = 2.8;
      ctx.beginPath();
      ctx.moveTo(-1, -0.5); ctx.quadraticCurveTo(-6, -wy * 0.5 - 3.5, -12.5, -wy);
      ctx.moveTo(2, -0.5);  ctx.quadraticCurveTo(7, -wy * 0.5 - 3.5, 12.5, -wy);
      ctx.stroke();
    } else if (kind === 'macaw') {
      // 16. コンゴウインコ（鮮やかなスカーレット＆イエロー＆ブルーの翼と長い飾り尾）
      const wy = flap * 5.2;
      ctx.strokeStyle = '#2563eb';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-4, 0); ctx.lineTo(-13.5, 1.2);
      ctx.stroke();
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.ellipse(0, 0, 5.2, 2.4, 0, 0, Math.PI * 2);
      ctx.arc(4.8, -0.8, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fef08a';
      ctx.beginPath();
      ctx.arc(5.4, -0.8, 1.1, 0, Math.PI * 2);
      ctx.fill();
      // 三色のトロピカル翼
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = 2.4;
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.quadraticCurveTo(-3, -wy * 0.5 - 2, -8.5, -wy);
      ctx.moveTo(1, 0); ctx.quadraticCurveTo(4, -wy * 0.5 - 2, 8.5, -wy);
      ctx.stroke();
      ctx.strokeStyle = '#3b82f6';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(-5.5, -wy * 0.7); ctx.lineTo(-9.2, -wy);
      ctx.moveTo(5.5, -wy * 0.7);  ctx.lineTo(9.2, -wy);
      ctx.stroke();
    } else if (kind === 'ufo') {
      // 17. 空飛ぶ円盤UFO（ガラスドームと虹色に点滅するリムライト）
      const hover = Math.sin(this.bioTime * 6.0 + bd.phase) * 1.4;
      ctx.translate(0, hover);
      ctx.fillStyle = 'rgba(125, 211, 252, 0.78)';
      ctx.beginPath();
      ctx.arc(0, -1.5, 4.2, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = '#cbd5e1';
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.ellipse(0, 0, 9.2, 2.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      for (let i = -2; i <= 2; i++) {
        ctx.fillStyle = ((Math.floor(this.bioTime * 8) + i) % 2 === 0) ? '#fde047' : '#38bdf8';
        ctx.beginPath();
        ctx.arc(i * 3.2, 0.2, 1.0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (kind === 'black_kite') {
      // 18. トビ（鳶：褐色の翼・特徴的な三味線のバチ型の尾羽・悠然とした旋回滑空）
      const wy = flap * 4.2;
      ctx.fillStyle = '#78350f';
      ctx.beginPath();
      ctx.ellipse(0, 0, 6.5, 2.6, 0, 0, Math.PI * 2);
      ctx.fill();
      // バチ型の尾羽（中央が凹んだ扇形）
      ctx.beginPath();
      ctx.moveTo(-6, 0); ctx.lineTo(-12.5, -3.2); ctx.lineTo(-10.5, 0); ctx.lineTo(-12.5, 3.2);
      ctx.closePath();
      ctx.fill();
      // 滑空する幅広の翼
      ctx.strokeStyle = '#92400e';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(-1, 0); ctx.quadraticCurveTo(-6, -wy * 0.4 - 2.8, -13, -wy);
      ctx.moveTo(1, 0);  ctx.quadraticCurveTo(6, -wy * 0.4 - 2.8, 13, -wy);
      ctx.stroke();
    } else if (kind === 'toucan') {
      // 19. オオハシ（巨大な黄色とオレンジのくちばし・黒い胴体・白い胸元）
      const wy = flap * 6.0;
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.ellipse(0, 0, 5.5, 2.8, 0, 0, Math.PI * 2);
      ctx.arc(4.8, -1.0, 2.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#f8fafc';
      ctx.beginPath();
      ctx.arc(4.8, -0.6, 1.4, 0, Math.PI * 2);
      ctx.fill();
      // 鮮やかな巨大くちばし
      const bg = ctx.createLinearGradient(6, -1.5, 14, 1.5);
      bg.addColorStop(0, '#facc15');
      bg.addColorStop(0.7, '#f97316');
      bg.addColorStop(1, '#ef4444');
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.moveTo(6.5, -2.4); ctx.quadraticCurveTo(14.5, -1.2, 14.0, 2.0); ctx.quadraticCurveTo(9.0, 1.5, 6.5, 0.4);
      ctx.closePath();
      ctx.fill();
      // 翼
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 2.2;
      ctx.beginPath();
      ctx.moveTo(0, 0); ctx.quadraticCurveTo(-3, -wy * 0.6 - 2, -7.5, -wy);
      ctx.moveTo(1, 0); ctx.quadraticCurveTo(3, -wy * 0.6 - 2, 7.5, -wy);
      ctx.stroke();
    } else if (kind === 'weather_balloon') {
      // 20. 気象観測気球（真っ白な巨大ゴム気球・吊り下げられた小型ラジオゾンデ観測機）
      ctx.fillStyle = '#f8fafc';
      ctx.strokeStyle = '#94a3b8';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.arc(0, -2, 8.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // 吊り紐と観測機器ボックス
      ctx.strokeStyle = '#64748b';
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      ctx.moveTo(0, 6.5); ctx.lineTo(0, 13.5);
      ctx.stroke();
      ctx.fillStyle = '#dc2626';
      ctx.fillRect(-2, 13.5, 4, 3);
    } else if (kind === 'pterosaur') {
      // 21. プテラノドン（長いトサカ・大きな翼膜・太古の翼竜）
      const wy = flap * 7.0;
      ctx.fillStyle = '#713f12';
      ctx.beginPath();
      ctx.ellipse(0, 0, 6.0, 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
      // 後頭部の長いトサカ
      ctx.strokeStyle = '#a16207';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(4, -1); ctx.lineTo(-6.5, -5.2);
      ctx.stroke();
      // 長いくちばし
      ctx.fillStyle = '#eab308';
      ctx.beginPath();
      ctx.moveTo(4, -1.5); ctx.lineTo(13.5, 0); ctx.lineTo(4, 1.0);
      ctx.closePath();
      ctx.fill();
      // 皮膜の翼
      ctx.fillStyle = 'rgba(202, 138, 4, 0.72)';
      ctx.strokeStyle = '#854d0e';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(-1, 0); ctx.lineTo(-14, -wy); ctx.quadraticCurveTo(-6, -wy * 0.4 + 2, -3, 2);
      ctx.moveTo(1, 0);  ctx.lineTo(14, -wy);  ctx.quadraticCurveTo(6, -wy * 0.4 + 2, 3, 2);
      ctx.stroke();
    } else if (kind === 'firework_rocket') {
      // 22. 打ち上げ花火ロケット（火花を噴き出しながら夜空を上昇）
      ctx.fillStyle = '#ef4444';
      ctx.fillRect(-1.5, -4, 3, 8);
      ctx.fillStyle = '#facc15';
      ctx.beginPath();
      ctx.moveTo(-2, -4); ctx.lineTo(0, -8); ctx.lineTo(2, -4);
      ctx.closePath();
      ctx.fill();
      // 噴射する火花パーティクル
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 1.2;
      for (let s = 1; s <= 3; s++) {
        ctx.beginPath();
        ctx.moveTo(0, 4); ctx.lineTo((s % 2 === 0 ? -3 : 3) * s * 0.6, 5 + s * 3.5);
        ctx.stroke();
      }
    } else if (kind === 'pegasus') {
      // 23. 天馬ペガサス（純白の跳ね馬と黄金に輝く大翼）
      const wy = flap * 6.5;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(0, 0, 7.5, 3.8, -0.15, 0, Math.PI * 2);
      ctx.fill();
      // 首と頭
      ctx.beginPath();
      ctx.moveTo(4, -1); ctx.lineTo(9.5, -6.5); ctx.lineTo(12, -5.5); ctx.lineTo(8, 2);
      ctx.closePath();
      ctx.fill();
      // 黄金に輝く翼
      const pg = ctx.createLinearGradient(0, -2, 0, -wy - 6);
      pg.addColorStop(0, '#ffffff');
      pg.addColorStop(0.5, '#fef08a');
      pg.addColorStop(1, '#facc15');
      ctx.strokeStyle = pg;
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(1, -2); ctx.quadraticCurveTo(5, -wy * 0.6 - 5, 12, -wy - 6);
      ctx.moveTo(-1, -2); ctx.quadraticCurveTo(-5, -wy * 0.6 - 5, -12, -wy - 6);
      ctx.stroke();
    }

    ctx.restore();
  }

  // 海中を泳ぐ15種類の海洋生物の個別描画（＋海底のカニ＆ヒトデで計16種類以上）
  _drawSeaCreatureItem(ctx, f, env) {
    if (f.revealed === false) return;
    const revealA = typeof f.revealT === 'number' ? f.revealT : 1;
    if (revealA <= 0.01) return;
    const dir = f.vx >= 0 ? 1 : -1;
    const wag = Math.sin(this.bioTime * 8.5 + f.phase);
    const fy = f.y + Math.sin(this.bioTime * 1.8 + f.phase) * 4.8;
    const kind = f.kind || 'sardine_school';

    ctx.save();
    ctx.globalAlpha *= revealA;
    ctx.translate(f.x, fy);
    ctx.scale(dir * f.scale, f.scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (kind === 'sardine_school') {
      // 1. イワシ・キビナゴの銀鱗大群（7匹が隊列を組んでキラキラ銀色に光りながら泳ぐ）
      const schoolOffsets = [
        [0, 0, 1.0], [-11, -5, 0.88], [-9, 5, 0.85], [-21, -2, 0.82],
        [-20, 8, 0.78], [10, 3, 0.90], [-30, 3, 0.74]
      ];
      for (let i = 0; i < schoolOffsets.length; i++) {
        const [ox, oy, os] = schoolOffsets[i];
        const wLocal = Math.sin(this.bioTime * 10.5 + f.phase - i * 0.6) * 2.0;
        const oyWave = oy + Math.cos(this.bioTime * 3.5 + i) * 1.4;
        ctx.save();
        ctx.translate(ox, oyWave);
        ctx.scale(os, os);
        ctx.fillStyle = 'rgba(125, 211, 252, 0.65)';
        ctx.beginPath();
        ctx.ellipse(0, 0, 7.5, 2.5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(-6.5, 0);
        ctx.lineTo(-11.0, -2.8 + wLocal);
        ctx.lineTo(-9.5, 0);
        ctx.lineTo(-11.0, 2.8 + wLocal);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = 'rgba(255, 255, 255, 0.82)';
        ctx.beginPath();
        ctx.ellipse(1.5, -0.5, 4.2, 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    } else if (kind === 'clownfish') {
      // 2. カクレクマノミ（鮮やかなオレンジ色に白い縦バンドと黒縁）
      const tailW = wag * 2.2;
      ctx.fillStyle = '#f97316';
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 0.9;
      // 尾ビレ
      ctx.beginPath();
      ctx.moveTo(-6.5, 0);
      ctx.quadraticCurveTo(-11, -3.8 + tailW, -11, tailW);
      ctx.quadraticCurveTo(-11, 3.8 + tailW, -6.5, 0);
      ctx.fill();
      ctx.stroke();
      // 胴体
      ctx.beginPath();
      ctx.ellipse(0, 0, 7.8, 4.4, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // クマノミ特有の白い2本の太帯
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.1;
      ctx.beginPath();
      ctx.moveTo(2.8, -3.8); ctx.quadraticCurveTo(1.8, 0, 2.8, 3.8);
      ctx.moveTo(-2.5, -3.9); ctx.quadraticCurveTo(-3.4, 0, -2.5, 3.9);
      ctx.stroke();
      // 目
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(5.0, -1.0, 1.1, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'angelfish') {
      // 3. ツノダシ / エンゼルフィッシュ（白・黒・黄色の縞模様と長くたなびく背ビレ）
      const finSway = wag * 3.5;
      ctx.fillStyle = '#fef08a';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(9.5, 0.5);
      ctx.quadraticCurveTo(3, -8.5, -6, -15.5 + finSway);
      ctx.quadraticCurveTo(-4, -5.5, -7.5, 0);
      ctx.quadraticCurveTo(-4, 6.5, -2, 9.5);
      ctx.quadraticCurveTo(4, 5.5, 9.5, 0.5);
      ctx.fill();
      ctx.stroke();
      // 黒い太縞バンド
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      ctx.moveTo(3.5, -5.2); ctx.lineTo(3.5, 5.2);
      ctx.moveTo(-2.5, -6.8); ctx.lineTo(-2.5, 6.8);
      ctx.stroke();
    } else if (kind === 'butterflyfish') {
      // 4. チョウチョウウオ（レモンイエローの丸平たい体と尾元の黒いアイスポット）
      ctx.fillStyle = '#facc15';
      ctx.strokeStyle = '#854d0e';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.ellipse(0, 0, 8.2, 5.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // 目の黒帯と尾元の偽目玉（アイスポット）
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(4.8, -4.5); ctx.lineTo(4.8, 4.5);
      ctx.stroke();
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(-4.2, -1.8, 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 0.7;
      ctx.stroke();
    } else if (kind === 'sea_turtle') {
      // 5. アオウミガメ（六角模様のドーム甲羅と大きく上下に羽ばたく前ヒレ）
      const flipperY = Math.sin(this.bioTime * 3.8 + f.phase) * 7.5;
      // 奥の前ヒレと後ろ足
      ctx.fillStyle = '#15803d';
      ctx.beginPath();
      ctx.ellipse(-9.5, 3.2, 4.2, 1.8, 0.35, 0, Math.PI * 2);
      ctx.fill();
      // 頭
      ctx.fillStyle = '#16a34a';
      ctx.beginPath();
      ctx.ellipse(12.5, -1.0, 4.2, 2.8, -0.1, 0, Math.PI * 2);
      ctx.fill();
      // ドーム状の甲羅
      const shellGrad = ctx.createRadialGradient(-1, -3, 1.5, 0, 0, 11);
      shellGrad.addColorStop(0, '#a16207');
      shellGrad.addColorStop(0.6, '#713f12');
      shellGrad.addColorStop(1, '#3f2209');
      ctx.fillStyle = shellGrad;
      ctx.strokeStyle = '#fef08a';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.ellipse(0, -0.5, 10.5, 6.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // 甲羅の六角模様ライン
      ctx.strokeStyle = 'rgba(254, 240, 138, 0.45)';
      ctx.beginPath();
      ctx.moveTo(-6, -0.5); ctx.lineTo(6, -0.5);
      ctx.moveTo(-2, -6.5); ctx.lineTo(-2, 5.5);
      ctx.moveTo(3, -6.5);  ctx.lineTo(3, 5.5);
      ctx.stroke();
      // 手前の大きな前ヒレ（優雅に上下ストローク）
      ctx.fillStyle = '#22c55e';
      ctx.strokeStyle = '#14532d';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(4.5, 1.5);
      ctx.quadraticCurveTo(8.5, 4.5 + flipperY * 0.6, 2.0, 9.5 + flipperY);
      ctx.quadraticCurveTo(-1.0, 5.5 + flipperY * 0.4, 2.2, 1.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'manta_ray') {
      // 6. マンタ / オニイトマキエイ（大きな翼のような胸ビレを波打たせて優雅に滑空）
      const wingY = Math.sin(this.bioTime * 3.4 + f.phase) * 8.5;
      // 長い鞭状の尾
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(-8, 0);
      ctx.quadraticCurveTo(-16, wag * 2.5, -24, -wag * 2.0);
      ctx.stroke();
      // 菱形〜翼型の体と頭鰭（とうき）
      const mGrad = ctx.createLinearGradient(0, -10, 0, 10);
      mGrad.addColorStop(0, '#1e3a8a');
      mGrad.addColorStop(0.6, '#0f172a');
      mGrad.addColorStop(1, '#e2e8f0');
      ctx.fillStyle = mGrad;
      ctx.beginPath();
      ctx.moveTo(11, -1.5);
      ctx.lineTo(14.5, -3.2);
      ctx.lineTo(10, -3.8);
      ctx.quadraticCurveTo(2, -12.5 - wingY, -2.5, -14.5 - wingY);
      ctx.quadraticCurveTo(-5.5, -5.0, -9.5, 0);
      ctx.quadraticCurveTo(-5.5, 5.0, -2.5, 11.5 + wingY * 0.85);
      ctx.quadraticCurveTo(3, 8.5 + wingY * 0.5, 10, 2.8);
      ctx.lineTo(14.5, 2.2);
      ctx.lineTo(11, 0.8);
      ctx.closePath();
      ctx.fill();
      // 背中の白い斑紋ハイライト
      ctx.strokeStyle = 'rgba(224, 242, 254, 0.55)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(4, -2, 3.2, -1.2, 0.5);
      ctx.stroke();
    } else if (kind === 'jellyfish') {
      // 7. ミズクラゲ・発光クラゲ（半透明の傘をぷかぷか拍動させ、触手を揺らす）
      const pulse = Math.sin(this.bioTime * 3.6 + f.phase);
      const bellW = 7.8 + pulse * 1.8;
      const bellH = 6.5 - pulse * 1.3;
      ctx.rotate(0.18 * dir);
      // 揺れる複数本の触手
      ctx.strokeStyle = `hsla(${f.hue}, 85%, 78%, 0.52)`;
      ctx.lineWidth = 1.0;
      for (let t = -3; t <= 3; t++) {
        const tx = t * 1.7;
        const tSway = Math.sin(this.bioTime * 4.2 + t + f.phase) * 3.2;
        ctx.beginPath();
        ctx.moveTo(tx, 1);
        ctx.quadraticCurveTo(tx + tSway * 0.5, 7, tx + tSway, 13.5 + (t % 2) * 2.5);
        ctx.stroke();
      }
      // 半透明ドーム状の傘と四つ葉模様の生殖腺
      const jGrad = ctx.createRadialGradient(0, -bellH * 0.4, 1, 0, 0, bellW);
      jGrad.addColorStop(0, `hsla(${f.hue}, 95%, 92%, 0.82)`);
      jGrad.addColorStop(0.6, `hsla(${f.hue}, 88%, 72%, 0.52)`);
      jGrad.addColorStop(1, `hsla(${f.hue}, 82%, 58%, 0.18)`);
      ctx.fillStyle = jGrad;
      ctx.strokeStyle = `hsla(${f.hue}, 92%, 85%, 0.78)`;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(0, 1, bellW, Math.PI * 1.02, Math.PI * 1.98);
      ctx.quadraticCurveTo(0, 2.8 - pulse * 0.8, -bellW, 1);
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'seahorse') {
      // 8. タツノオトシゴ（王冠のような頭・S字の胸・くるんと巻いた尾で縦姿勢のまま漂う）
      ctx.strokeStyle = '#f59e0b';
      ctx.fillStyle = '#fbbf24';
      ctx.lineWidth = 2.6;
      ctx.beginPath();
      // 頭〜首〜お腹〜くるんと巻いた尻尾
      ctx.moveTo(3.8, -7.2);
      ctx.lineTo(1.0, -7.5);
      ctx.quadraticCurveTo(-1.8, -4.5, 1.5, -0.5);
      ctx.quadraticCurveTo(3.2, 3.0, -0.5, 6.8);
      ctx.arc(-1.8, 6.8, 1.8, 0, Math.PI * 1.35);
      ctx.stroke();
      // お腹のぷっくり膨らみと背中のパタパタ小ヒレ
      ctx.beginPath();
      ctx.ellipse(0.8, 0.2, 2.6, 3.8, 0.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(254, 240, 138, 0.78)';
      ctx.beginPath();
      ctx.ellipse(-2.4, 0.2, 2.2, 1.2 + Math.abs(wag) * 0.8, -0.2, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'pufferfish') {
      // 9. ハリセンボン / フグ（周期的にぷっくり丸く膨らむトゲ付きボディ）
      const puff = 0.5 + 0.5 * Math.sin(this.bioTime * 1.8 + f.phase);
      const rx = 6.8 + puff * 2.8;
      const ry = 5.4 + puff * 3.2;
      // 尾ビレ
      ctx.fillStyle = '#fde047';
      ctx.beginPath();
      ctx.moveTo(-rx + 1, 0);
      ctx.lineTo(-rx - 4.2, -2.5 + wag * 1.5);
      ctx.lineTo(-rx - 4.2, 2.5 + wag * 1.5);
      ctx.closePath();
      ctx.fill();
      // 丸い体（上半分は黄褐色、お腹はクリーム白）
      ctx.fillStyle = '#fef9c3';
      ctx.strokeStyle = '#854d0e';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ca8a04';
      ctx.beginPath();
      ctx.ellipse(0, -ry * 0.22, rx * 0.94, ry * 0.65, 0, Math.PI, Math.PI * 2);
      ctx.fill();
      // 膨らんだ時に立つ周囲の小さなトゲ
      if (puff > 0.35) {
        ctx.strokeStyle = '#713f12';
        ctx.lineWidth = 0.9;
        for (let a = 0; a < Math.PI * 2; a += Math.PI / 5) {
          const sx = Math.cos(a) * rx;
          const sy = Math.sin(a) * ry;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.lineTo(sx + Math.cos(a) * 2.2 * puff, sy + Math.sin(a) * 2.2 * puff);
          ctx.stroke();
        }
      }
      // 大きな丸い目
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(rx * 0.48, -1.2, 1.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(rx * 0.52, -1.2, 0.95, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'dolphin') {
      // 10. イルカ（流線型の青灰色ボディ・背ビレ・上下に振る水平尾ビレで弓なりに泳ぐ）
      const leapPitch = Math.cos(this.bioTime * 1.8 + f.phase) * 0.18;
      ctx.rotate(leapPitch);
      const tailY = Math.sin(this.bioTime * 7.2 + f.phase) * 3.5;
      const dGrad = ctx.createLinearGradient(0, -6, 0, 6);
      dGrad.addColorStop(0, '#0284c7');
      dGrad.addColorStop(0.55, '#38bdf8');
      dGrad.addColorStop(1, '#e0f2fe');
      ctx.fillStyle = dGrad;
      ctx.strokeStyle = '#0369a1';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      // 吻（くちばし）〜額（メロン）〜背ビレ〜尾ビレ
      ctx.moveTo(16.5, 0.8);
      ctx.quadraticCurveTo(13.5, 0.2, 11.5, -1.8);
      ctx.quadraticCurveTo(5.0, -5.5, -1.0, -4.5);
      // 背ビレ
      ctx.lineTo(-3.8, -9.2);
      ctx.quadraticCurveTo(-5.2, -5.2, -6.5, -3.5);
      ctx.quadraticCurveTo(-12.5, -1.5, -16.5, tailY);
      ctx.lineTo(-20.5, tailY - 3.8);
      ctx.lineTo(-18.5, tailY);
      ctx.lineTo(-20.5, tailY + 3.8);
      ctx.quadraticCurveTo(-11.5, 2.8, -2.0, 4.2);
      ctx.quadraticCurveTo(6.5, 4.5, 16.5, 0.8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // 胸ビレと目
      ctx.fillStyle = '#0284c7';
      ctx.beginPath();
      ctx.moveTo(4.0, 2.5); ctx.lineTo(0.5, 7.2); ctx.lineTo(1.8, 2.2);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(10.2, -0.4, 1.0, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'shark') {
      // 11. リーフシャーク（精悍な流線型・三角形の背ビレ・三日月尾ビレ・エラ裂孔）
      const tailX = wag * 2.8;
      const sGrad = ctx.createLinearGradient(0, -6, 0, 6);
      sGrad.addColorStop(0, '#334155');
      sGrad.addColorStop(0.58, '#64748b');
      sGrad.addColorStop(1, '#f1f5f9');
      ctx.fillStyle = sGrad;
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.moveTo(16.0, 0);
      ctx.quadraticCurveTo(7.0, -5.2, 0, -4.5);
      // 三角背ビレ
      ctx.lineTo(-2.5, -10.2);
      ctx.lineTo(-5.5, -4.0);
      ctx.lineTo(-14.5, -1.5);
      // 上下に長い三日月尾ビレ
      ctx.lineTo(-20.5, -7.2 + tailX * 0.3);
      ctx.lineTo(-17.2, 0);
      ctx.lineTo(-19.5, 5.2 + tailX * 0.3);
      ctx.lineTo(-14.0, 1.8);
      ctx.quadraticCurveTo(-2.0, 4.8, 16.0, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // 3本のエラ裂孔と鋭い目
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 0.85;
      ctx.beginPath();
      for (let g = 0; g < 3; g++) {
        ctx.moveTo(4.5 - g * 1.6, -1.8);
        ctx.lineTo(4.2 - g * 1.6, 1.8);
      }
      ctx.stroke();
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(10.8, -0.8, 1.0, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'sunfish') {
      // 12. マンボウ（巨大で丸平たい独特のシルエットと上下に長い背ビレ・臀ビレ）
      const finFlap = Math.sin(this.bioTime * 3.8 + f.phase) * 2.8;
      ctx.fillStyle = '#94a3b8';
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.1;
      // 上下の長いヒレ
      ctx.beginPath();
      ctx.moveTo(-2, -7);
      ctx.quadraticCurveTo(-5 + finFlap, -16, -6.5 + finFlap, -18.5);
      ctx.quadraticCurveTo(-7.5, -11, -6.5, -6);
      ctx.moveTo(-2, 7);
      ctx.quadraticCurveTo(-5 - finFlap, 16, -6.5 - finFlap, 18.5);
      ctx.quadraticCurveTo(-7.5, 11, -6.5, 6);
      ctx.fill();
      ctx.stroke();
      // 丸い胴体と波打つ舵ビレ
      const sfGrad = ctx.createRadialGradient(2, -1, 1.5, 0, 0, 11);
      sfGrad.addColorStop(0, '#e2e8f0');
      sfGrad.addColorStop(0.65, '#94a3b8');
      sfGrad.addColorStop(1, '#475569');
      ctx.fillStyle = sfGrad;
      ctx.beginPath();
      ctx.ellipse(0, 0, 9.5, 8.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // おちょぼ口と丸い目
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(5.2, -1.8, 1.3, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'anglerfish') {
      // 13. チョウチンアンコウ（頭の上から伸びる発光エスカ提灯で深場を照らす）
      ctx.fillStyle = '#3b0764';
      ctx.strokeStyle = '#1e1b4b';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.ellipse(0, 1, 8.2, 6.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // 尾ビレ
      ctx.beginPath();
      ctx.moveTo(-7.5, 1);
      ctx.lineTo(-12.5, -2.5 + wag * 1.5);
      ctx.lineTo(-12.5, 4.5 + wag * 1.5);
      ctx.closePath();
      ctx.fill();
      // 頭から前に垂れる誘引突起（イリシウム）と発光提灯（エスカ）
      ctx.strokeStyle = '#a855f7';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(2.5, -4.5);
      ctx.quadraticCurveTo(8.5, -10.5, 11.5, -3.5 + wag * 0.8);
      ctx.stroke();
      const lX = 11.5, lY = -3.5 + wag * 0.8;
      const lGlow = ctx.createRadialGradient(lX, lY, 0.5, lX, lY, 8.5);
      lGlow.addColorStop(0, 'rgba(254, 249, 195, 0.98)');
      lGlow.addColorStop(0.4, 'rgba(74, 222, 128, 0.65)');
      lGlow.addColorStop(1, 'rgba(74, 222, 128, 0)');
      ctx.fillStyle = lGlow;
      ctx.beginPath();
      ctx.arc(lX, lY, 8.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fef9c3';
      ctx.beginPath();
      ctx.arc(lX, lY, 1.9, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'nautilus') {
      // 14. オウムガイ（赤白の縞模様が入った美しい対数螺旋殻と小さな触手）
      // 触手
      ctx.strokeStyle = '#fda4af';
      ctx.lineWidth = 1.0;
      for (let t = -2; t <= 2; t++) {
        ctx.beginPath();
        ctx.moveTo(3, t * 1.1 + 1);
        ctx.lineTo(8.5, t * 1.5 + 1.5 + wag * 0.6);
        ctx.stroke();
      }
      // 巻貝の殻
      ctx.fillStyle = '#fef3c7';
      ctx.strokeStyle = '#9a3412';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.arc(0, 0, 6.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // 赤褐色の虎縞模様と中心の渦
      ctx.strokeStyle = '#c2410c';
      ctx.lineWidth = 1.4;
      for (let a = 0.4; a < Math.PI * 1.7; a += 0.52) {
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * 1.8, Math.sin(a) * 1.8);
        ctx.lineTo(Math.cos(a) * 6.5, Math.sin(a) * 6.5);
        ctx.stroke();
      }
      ctx.fillStyle = '#431407';
      ctx.beginPath();
      ctx.arc(-0.5, 0.5, 1.8, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'flying_fish') {
      // 15. トビウオ（水色の流線型ボディと、大きく広げた半透明のグライダー胸ビレ）
      const wingFlutter = Math.sin(this.bioTime * 15.0 + f.phase) * 2.2;
      ctx.fillStyle = '#0284c7';
      ctx.beginPath();
      ctx.ellipse(0, 0, 8.8, 2.4, 0, 0, Math.PI * 2);
      ctx.fill();
      // 下葉が長い独特の尾ビレ
      ctx.beginPath();
      ctx.moveTo(-7.8, 0);
      ctx.lineTo(-12.5, -3.2);
      ctx.moveTo(-7.8, 0);
      ctx.lineTo(-14.2, 4.5);
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // 大きく広げた透き通る胸ビレ翼
      ctx.fillStyle = 'rgba(186, 230, 253, 0.78)';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(3.5, -1.0);
      ctx.lineTo(-4.5, -9.5 - wingFlutter);
      ctx.lineTo(-6.5, -5.0 - wingFlutter * 0.5);
      ctx.lineTo(0.5, -0.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    } else if (kind === 'whale') {
      // 16. ザトウクジラ（雄大な濃紺ボディ・白い腹部の畝・長い胸ビレ・潮吹き気泡）
      const tailFluke = Math.sin(this.bioTime * 3.2 + f.phase) * 3.0;
      ctx.fillStyle = '#1e3a8a';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(18, 0.5);
      ctx.quadraticCurveTo(10, -7.5, -4, -5.0);
      ctx.quadraticCurveTo(-14, -3.0, -21, tailFluke);
      ctx.lineTo(-26, tailFluke - 4.5);
      ctx.lineTo(-24, tailFluke);
      ctx.lineTo(-26, tailFluke + 4.5);
      ctx.lineTo(-20, tailFluke + 1.2);
      ctx.quadraticCurveTo(-8, 5.5, 4, 6.2);
      ctx.quadraticCurveTo(14, 5.5, 18, 0.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // 白い腹部の縦畝（ベンガルグルーブ）
      ctx.fillStyle = '#e2e8f0';
      ctx.beginPath();
      ctx.moveTo(17.5, 1.0);
      ctx.quadraticCurveTo(8, 6.0, -4, 3.8);
      ctx.quadraticCurveTo(6, 1.2, 17.5, 1.0);
      ctx.fill();
      // ザトウクジラ特有の白い長大な胸ビレ
      ctx.fillStyle = '#f8fafc';
      ctx.strokeStyle = '#1e3a8a';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.moveTo(5, 3.2);
      ctx.quadraticCurveTo(0, 12.5 + tailFluke * 0.4, -5.5, 10.5 + tailFluke * 0.4);
      ctx.quadraticCurveTo(-1.5, 5.0, 2.0, 2.8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // 目
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(11.5, -0.5, 1.1, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'orca') {
      // 17. シャチ・オルカ（漆黒の流線型ボディ・純白のアイパッチ＆腹部・高い背ビレ）
      const tailW = wag * 2.2;
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.ellipse(0, 0, 14.5, 5.2, 0, 0, Math.PI * 2);
      ctx.fill();
      // 高い三角形の背ビレと尾ビレ
      ctx.beginPath();
      ctx.moveTo(1.5, -4.5);
      ctx.lineTo(-2.5, -12.2);
      ctx.lineTo(-4.8, -4.2);
      ctx.moveTo(-13.0, 0);
      ctx.lineTo(-18.5, -4.2 + tailW * 0.6);
      ctx.lineTo(-18.5, 4.2 + tailW * 0.6);
      ctx.closePath();
      ctx.fill();
      // シャチ特有の白いアイパッチと白い腹部模様
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.ellipse(8.2, -1.6, 2.8, 1.2, -0.15, 0, Math.PI * 2);
      ctx.ellipse(1.5, 2.8, 9.5, 2.1, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'swordfish') {
      // 18. メカジキ（メタリックブルーの疾走ボディ・鋭く長い吻・三日月型の背ビレ＆尾ビレ）
      const tailW = wag * 2.4;
      ctx.fillStyle = '#0369a1';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 0.85;
      ctx.beginPath();
      ctx.ellipse(0, 0, 11.5, 3.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // 銀白色の腹部
      ctx.fillStyle = '#e0f2fe';
      ctx.beginPath();
      ctx.ellipse(0.5, 1.2, 9.5, 1.5, 0, 0, Math.PI * 2);
      ctx.fill();
      // 長く鋭い剣状の吻（ビル）
      ctx.strokeStyle = '#0284c7';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(10.5, -0.3);
      ctx.lineTo(20.5, -0.5);
      ctx.stroke();
      // 高い背ビレと三日月尾ビレ
      ctx.fillStyle = '#075985';
      ctx.beginPath();
      ctx.moveTo(4.5, -2.8); ctx.lineTo(1.2, -8.5); ctx.lineTo(-1.5, -2.8);
      ctx.moveTo(-10.8, 0); ctx.lineTo(-15.5, -5.0 + tailW * 0.5); ctx.lineTo(-13.2, 0); ctx.lineTo(-15.5, 5.0 + tailW * 0.5);
      ctx.closePath();
      ctx.fill();
    } else if (kind === 'eagle_ray') {
      // 19. マダラトビエイ（濃紺に白い水玉模様のひし形翼と長い鞭状の尾）
      const wingFlap = Math.sin(this.bioTime * 4.5 + f.phase) * 4.8;
      ctx.strokeStyle = '#1e293b';
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(-8, 0);
      ctx.quadraticCurveTo(-15, 1.5, -22, 2.5 - wingFlap * 0.25);
      ctx.stroke();
      ctx.fillStyle = '#1e3a8a';
      ctx.beginPath();
      ctx.moveTo(10.5, 0);
      ctx.quadraticCurveTo(3, -10.5 - wingFlap, -3.5, -8.5 - wingFlap * 0.7);
      ctx.lineTo(-9.0, 0);
      ctx.lineTo(-3.5, 7.5 - wingFlap * 0.4);
      ctx.quadraticCurveTo(3, 8.5 - wingFlap * 0.5, 10.5, 0);
      ctx.closePath();
      ctx.fill();
      // 白い水玉スポット模様
      ctx.fillStyle = '#e0f2fe';
      for (const [sx, sy] of [[2, -3], [-1, -5], [-3, -1], [1, 2], [-2, 3]]) {
        ctx.beginPath();
        ctx.arc(sx, sy - wingFlap * 0.3, 0.9, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (kind === 'boxfish') {
      // 20. ミナミハコフグ（鮮やかな黄色い角丸四角形ボディに黒の水玉模様・おちょぼ口）
      ctx.fillStyle = '#facc15';
      ctx.strokeStyle = '#854d0e';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.roundRect(-5.8, -4.6, 11.6, 9.2, 2.8);
      ctx.fill();
      ctx.stroke();
      // 小さな尾ビレ
      ctx.fillStyle = '#fde047';
      ctx.beginPath();
      ctx.moveTo(-5.8, 0);
      ctx.lineTo(-9.2, -2.5 + wag * 1.4);
      ctx.lineTo(-9.2, 2.5 + wag * 1.4);
      ctx.closePath();
      ctx.fill();
      // 黒い水玉ドットと大きな目
      ctx.fillStyle = '#1e293b';
      for (const [dx, dy] of [[-2.5, -2.0], [0.5, -2.2], [-2.2, 1.8], [1.2, 1.6], [3.5, -1.2]]) {
        ctx.beginPath();
        ctx.arc(dx, dy, 0.95, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (kind === 'mini_octopus') {
      // 21. メンダコ・赤いミニタコ（耳のようなヒレと傘状の8本足でふわふわ泳ぐ）
      const pulse = Math.sin(this.bioTime * 5.2 + f.phase);
      ctx.fillStyle = '#f43f5e';
      ctx.strokeStyle = '#881337';
      ctx.lineWidth = 0.95;
      // 頭部の耳ヒレ
      ctx.beginPath();
      ctx.ellipse(-3.5, -4.2 - pulse * 0.8, 2.6, 1.2, -0.4, 0, Math.PI * 2);
      ctx.ellipse(3.5, -4.2 - pulse * 0.8, 2.6, 1.2, 0.4, 0, Math.PI * 2);
      ctx.fill();
      // 丸いドーム頭とスカラップ状の足幕
      ctx.beginPath();
      ctx.arc(0, -1.5, 5.8, Math.PI, 0, false);
      ctx.lineTo(6.5 + pulse * 1.2, 3.8);
      ctx.quadraticCurveTo(3.2, 2.0, 0, 4.2);
      ctx.quadraticCurveTo(-3.2, 2.0, -6.5 - pulse * 1.2, 3.8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // 大きな可愛い目
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(-2.2, -1.2, 1.6, 0, Math.PI * 2);
      ctx.arc(2.2, -1.2, 1.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(-2.2, -1.2, 0.9, 0, Math.PI * 2);
      ctx.arc(2.2, -1.2, 0.9, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'moray_eel') {
      // 22. ウツボ（黄緑〜暗緑の豹紋模様でS字に波打ちながら泳ぐ長い体）
      const w1 = Math.sin(this.bioTime * 6.5 + f.phase) * 3.2;
      const w2 = Math.cos(this.bioTime * 6.5 + f.phase) * 3.2;
      ctx.strokeStyle = '#65a30d';
      ctx.lineWidth = 4.2;
      ctx.beginPath();
      ctx.moveTo(11, 0);
      ctx.quadraticCurveTo(4, w1, -2, 0);
      ctx.quadraticCurveTo(-8, w2, -15, -w1 * 0.5);
      ctx.stroke();
      ctx.strokeStyle = '#365314';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([2.0, 2.5]);
      ctx.beginPath();
      ctx.moveTo(9, 0);
      ctx.quadraticCurveTo(4, w1, -2, 0);
      ctx.quadraticCurveTo(-8, w2, -13, -w1 * 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fef08a';
      ctx.beginPath();
      ctx.arc(9.2, -0.8, 1.0, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'hammerhead') {
      // 23. シュモクザメ（ハンマーヘッド：左右に大きく張り出した頭部・鋭い背ビレ）
      const tailW = wag * 2.2;
      ctx.fillStyle = '#475569';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 0.9;
      ctx.beginPath();
      ctx.ellipse(0, 0, 13.5, 4.0, 0, 0, Math.PI * 2);
      ctx.fill();
      // ハンマー状の頭部（T字）
      ctx.beginPath();
      ctx.roundRect(10.5, -6.5, 3.5, 13.0, 1.2);
      ctx.fill();
      ctx.stroke();
      // 左右端の目
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.arc(12.2, -5.8, 0.9, 0, Math.PI * 2);
      ctx.arc(12.2, 5.8, 0.9, 0, Math.PI * 2);
      ctx.fill();
      // 背ビレと尾ビレ
      ctx.fillStyle = '#334155';
      ctx.beginPath();
      ctx.moveTo(-1, -3.5); ctx.lineTo(-4.5, -11.0); ctx.lineTo(-7.5, -3.5);
      ctx.moveTo(-12.5, 0); ctx.lineTo(-17.5, -5.5 + tailW * 0.6); ctx.lineTo(-15.5, 0); ctx.lineTo(-17.5, 4.5 + tailW * 0.6);
      ctx.closePath();
      ctx.fill();
    } else if (kind === 'clione') {
      // 24. クリオネ（流氷の妖精：透明なゼラチン質の翼足とオレンジ色の内臓）
      const wingA = Math.sin(this.bioTime * 9.0 + f.phase) * 3.5;
      ctx.fillStyle = 'rgba(224, 242, 254, 0.85)';
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 0.8;
      // 紡錘形の胴体
      ctx.beginPath();
      ctx.ellipse(0, 0, 3.5, 6.5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // パタパタ羽ばたく一対の翼足（パラポディア）
      ctx.fillStyle = 'rgba(186, 230, 253, 0.92)';
      ctx.beginPath();
      ctx.ellipse(-4.5, -1.0 + wingA * 0.3, 3.2, 1.5, -0.3 + wingA * 0.08, 0, Math.PI * 2);
      ctx.ellipse(4.5, -1.0 - wingA * 0.3, 3.2, 1.5, 0.3 - wingA * 0.08, 0, Math.PI * 2);
      ctx.fill();
      // 透けて見えるオレンジ色の生殖腺＆消化器官
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.ellipse(0, -0.5, 1.6, 2.4, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'whale_shark') {
      // 25. ジンベエザメ（巨大な青灰色ボディ・無数の白い水玉模様・平たい頭）
      const tailW = wag * 1.8;
      ctx.fillStyle = '#1e293b';
      ctx.beginPath();
      ctx.ellipse(0, 0, 19.0, 6.8, 0, 0, Math.PI * 2);
      ctx.fill();
      // 白いドット模様（碁盤目状）
      ctx.fillStyle = '#f8fafc';
      for (let ix = -10; ix <= 10; ix += 4.5) {
        for (let iy = -3.2; iy <= 3.2; iy += 2.2) {
          ctx.beginPath();
          ctx.arc(ix, iy, 0.85, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // 背ビレと巨大な三日月尾ビレ
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.moveTo(-2, -6.0); ctx.lineTo(-5.5, -13.5); ctx.lineTo(-8.5, -6.0);
      ctx.moveTo(-17.5, 0); ctx.lineTo(-24.5, -6.8 + tailW * 0.5); ctx.lineTo(-21.5, 0); ctx.lineTo(-24.5, 6.8 + tailW * 0.5);
      ctx.closePath();
      ctx.fill();
    } else if (kind === 'oarfish') {
      // 26. リュウグウノツカイ（銀白色の超長身・真紅の長いトサカ背ビレと糸状の腹ビレ）
      const undul = Math.sin(this.bioTime * 4.5 + f.phase);
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 4.0;
      ctx.beginPath();
      ctx.moveTo(18, 0);
      ctx.quadraticCurveTo(6, undul * 4.5, -6, -undul * 4.5);
      ctx.quadraticCurveTo(-18, undul * 3.0, -28, 0);
      ctx.stroke();
      // 真紅の長い背ビレトサカ
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(17, -2); ctx.lineTo(19, -12); ctx.lineTo(15, -3);
      ctx.moveTo(14, -2); ctx.lineTo(15, -9);
      ctx.stroke();
      // 糸状の赤い腹ビレ
      ctx.beginPath();
      ctx.moveTo(15, 2); ctx.lineTo(12, 10 + undul * 2);
      ctx.stroke();
    } else if (kind === 'coelacanth') {
      // 27. シーラカンス（深海性の紺青色・肉質の肢状ヒレ・三葉の尾ビレ・生きた化石）
      const tailW = wag * 1.5;
      ctx.fillStyle = '#1e3a8a';
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1.0;
      ctx.beginPath();
      ctx.ellipse(0, 0, 11.5, 4.8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // 特有の三葉の尾ビレ
      ctx.beginPath();
      ctx.moveTo(-10.5, 0);
      ctx.lineTo(-16.0, -3.8 + tailW * 0.5);
      ctx.lineTo(-14.0, 0);
      ctx.lineTo(-17.5, 0 + tailW * 0.5);
      ctx.lineTo(-14.0, 0);
      ctx.lineTo(-16.0, 3.8 + tailW * 0.5);
      ctx.closePath();
      ctx.fill();
      // 肢のような肉質ヒレ
      ctx.fillStyle = '#172554';
      ctx.beginPath();
      ctx.ellipse(-2, 4.5, 3.2, 1.8, 0.4, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'bathysphere') {
      // 28. 潜水探査球（丸い黄色い潜水球・丸窓から光るサーチライト探照灯）
      ctx.fillStyle = '#eab308';
      ctx.strokeStyle = '#713f12';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(0, 0, 6.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      // サーチライトビーム
      const beamGrad = ctx.createRadialGradient(-3, 0, 1, -16, 0, 18);
      beamGrad.addColorStop(0, 'rgba(254, 240, 138, 0.85)');
      beamGrad.addColorStop(1, 'rgba(250, 204, 21, 0)');
      ctx.fillStyle = beamGrad;
      ctx.beginPath();
      ctx.moveTo(-5, -2); ctx.lineTo(-20, -7); ctx.lineTo(-20, 7); ctx.lineTo(-5, 2);
      ctx.closePath();
      ctx.fill();
      // 丸窓
      ctx.fillStyle = '#38bdf8';
      ctx.beginPath();
      ctx.arc(-2.5, 0, 2.2, 0, Math.PI * 2);
      ctx.fill();
    } else if (kind === 'mermaid') {
      // 29. 人魚マーメイド（エメラルドグリーンの魚尾・流れる長い金髪・優雅な遊泳）
      const tailW = wag * 2.8;
      // 金髪と上半身
      ctx.fillStyle = '#fde047';
      ctx.beginPath();
      ctx.arc(6.5, -2.5, 2.8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fed7aa';
      ctx.beginPath();
      ctx.ellipse(3.8, -0.5, 3.2, 1.8, 0.2, 0, Math.PI * 2);
      ctx.fill();
      // エメラルドの魚尾
      ctx.fillStyle = '#10b981';
      ctx.beginPath();
      ctx.moveTo(1.5, 0);
      ctx.quadraticCurveTo(-4, tailW * 0.5, -9, tailW);
      ctx.lineTo(-14, tailW - 4.5);
      ctx.lineTo(-12, tailW);
      ctx.lineTo(-14, tailW + 4.5);
      ctx.quadraticCurveTo(-4, tailW * 0.5 + 2, 1.5, 1.5);
      ctx.closePath();
      ctx.fill();
    }

    ctx.restore();
  }

  _render() {
    const ctx = this.ctx;
    const W = this.canvas.width;  // 720
    const H = this.canvas.height; // 480

    if (this._isRealColor()) {
      const env = this._getEnvAtmosphere();
      this._drawRealisticDynamicSky(ctx, W, H, env);
    } else {
      // 1. 反射型液晶パネルのオリーブグリーン背景とビネット陰影
      const bgGrad = ctx.createRadialGradient(W * 0.5, H * 0.45, 40, W * 0.5, H * 0.5, W * 0.68);
      bgGrad.addColorStop(0, '#9ead8b');
      bgGrad.addColorStop(0.75, '#8f9e7c');
      bgGrad.addColorStop(1, '#7c8b69');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, W, H);

      // 微細な液晶偏光板テクスチャ横線
      ctx.fillStyle = 'rgba(30, 40, 22, 0.018)';
      for (let y = 0; y < H; y += 3) {
        ctx.fillRect(0, y, W, 1);
      }
    }

    // 2. カラー印刷オーバーレイ層（海面・サルベージ船・海底岩礁・沈没船・黄金の宝箱）
    this._drawColorFoilOverlay(ctx);

    // 3. 全ての液晶セグメント描画（非点灯ゴースト＋点灯セグメント＆反射影）
    this._drawAllLcdSegments(ctx);
  }

  _drawColorFoilOverlay(ctx) {
    ctx.save();
    const real = this._isRealColor();
    const env = real ? this._getEnvAtmosphere() : null;

    // --- 海面の波ライン＆海中の表現 ---
    ctx.beginPath();
    ctx.moveTo(0, 108);
    for (let x = 0; x <= 720; x += 48) {
      const waveY = real ? (96 + Math.sin(this.bioTime * 2.4 + x * 0.045) * 2.8) : 96;
      ctx.quadraticCurveTo(x + 24, waveY, x + 48, 108);
    }
    ctx.lineTo(720, 480);
    ctx.lineTo(0, 480);
    ctx.closePath();

    if (real) {
      // 時間帯（朝焼け・真昼・夕焼け・月夜）に連動して海中の色彩も美しく変化
      const seaPalettes = [
        { s0: [20, 184, 166], s1: [13, 148, 136], s2: [15, 118, 110], s3: [30, 58, 138], s4: [9, 20, 42], ray: [254, 215, 170] }, // 朝焼け
        { s0: [6, 182, 212],  s1: [2, 132, 199],  s2: [3, 105, 161],  s3: [30, 58, 138], s4: [9, 21, 43], ray: [224, 242, 254] }, // 真昼
        { s0: [217, 119, 6],  s1: [14, 116, 144], s2: [21, 94, 117],  s3: [30, 27, 75],  s4: [8, 14, 32], ray: [253, 186, 116] }, // 夕焼け
        { s0: [14, 116, 144], s1: [12, 74, 110],  s2: [15, 23, 42],   s3: [9, 14, 30],   s4: [2, 6, 23],  ray: [186, 230, 253] }  // 月夜
      ];
      const spA = seaPalettes[env.todIdx % 4];
      const spB = seaPalettes[(env.todIdx + 1) % 4];
      const t = env.todSmooth;

      const seaGrad = ctx.createLinearGradient(0, 96, 0, 480);
      seaGrad.addColorStop(0, this._lerpRgb(spA.s0, spB.s0, t));
      seaGrad.addColorStop(0.15, this._lerpRgb(spA.s1, spB.s1, t));
      seaGrad.addColorStop(0.42, this._lerpRgb(spA.s2, spB.s2, t));
      seaGrad.addColorStop(0.75, this._lerpRgb(spA.s3, spB.s3, t));
      seaGrad.addColorStop(1, this._lerpRgb(spA.s4, spB.s4, t));
      ctx.fillStyle = seaGrad;
      ctx.fill();

      // 海中に差し込む太陽光・月光の筋（ゴッドレイ）と回遊する小魚・マリンスノー
      ctx.save();
      ctx.clip();
      const rayCol = [
        Math.round(spA.ray[0] + (spB.ray[0] - spA.ray[0]) * t),
        Math.round(spA.ray[1] + (spB.ray[1] - spA.ray[1]) * t),
        Math.round(spA.ray[2] + (spB.ray[2] - spA.ray[2]) * t)
      ];
      // 太陽・満月の水平位置(ltSun.nx)と完全に連動し、光線が斜めに差し込む
      const ltSun = this._getDiverLighting(360, 100);
      const sunSlopeX = -ltSun.nx * 110 * ltSun.lenMul;
      const rayShift = Math.sin(this.bioTime * 0.55) * 16;
      const rays = [
        { xTop: 135 + rayShift, wTop: 45, xBot: 135 + sunSlopeX + rayShift * 1.3, wBot: 120, alpha: 0.18 },
        { xTop: 275 - rayShift * 0.7, wTop: 55, xBot: 275 + sunSlopeX - rayShift * 1.1, wBot: 140, alpha: 0.22 },
        { xTop: 420 + rayShift * 0.8, wTop: 50, xBot: 420 + sunSlopeX + rayShift, wBot: 130, alpha: 0.17 },
        { xTop: 565 - rayShift * 0.6, wTop: 45, xBot: 565 + sunSlopeX - rayShift * 0.9, wBot: 115, alpha: 0.14 }
      ];
      for (const r of rays) {
        const rg = ctx.createLinearGradient(r.xTop, 100, r.xBot, 440);
        rg.addColorStop(0, `rgba(${rayCol[0]}, ${rayCol[1]}, ${rayCol[2]}, ${r.alpha})`);
        rg.addColorStop(0.55, `rgba(${rayCol[0]}, ${rayCol[1]}, ${rayCol[2]}, ${r.alpha * 0.42})`);
        rg.addColorStop(1, 'rgba(14, 116, 144, 0)');
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.moveTo(r.xTop, 98);
        ctx.lineTo(r.xTop + r.wTop, 98);
        ctx.lineTo(r.xBot + r.wBot, 450);
        ctx.lineTo(r.xBot, 450);
        ctx.closePath();
        ctx.fill();
      }

      // 海中を漂うマリンスノー（プランクトン光粒）
      if (this.marineSnow) {
        ctx.fillStyle = `rgba(${rayCol[0]}, ${rayCol[1]}, ${rayCol[2]}, 0.34)`;
        for (const ms of this.marineSnow) {
          ctx.beginPath();
          ctx.arc(ms.x, ms.y, ms.r, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 背景の海中（上層〜中層）を泳ぐ海洋生物
      if (this.underwaterFish) {
        for (const f of this.underwaterFish) {
          if (!f.fg) this._drawSeaCreatureItem(ctx, f, env);
        }
      }
      ctx.restore();

      // リアルな白波の輝きライン（太陽・月光の反射きらめき付き）
      ctx.strokeStyle = `rgba(${rayCol[0]}, ${rayCol[1]}, ${rayCol[2]}, 0.88)`;
      ctx.lineWidth = 3.5;
      ctx.beginPath();
      ctx.moveTo(0, 108);
      for (let x = 0; x <= 720; x += 48) {
        const waveY = 96 + Math.sin(this.bioTime * 2.4 + x * 0.045) * 2.8;
        ctx.quadraticCurveTo(x + 24, waveY, x + 48, 108);
      }
      ctx.stroke();
    } else {
      ctx.strokeStyle = 'rgba(26, 112, 138, 0.58)';
      ctx.fillStyle = 'rgba(34, 132, 160, 0.16)';
      ctx.lineWidth = 4;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(0, 108);
      for (let x = 0; x <= 720; x += 48) {
        ctx.quadraticCurveTo(x + 24, 96, x + 48, 108);
      }
      ctx.stroke();
    }

    // --- 左上のサルベージ船 ---
    const ltBoat = real ? this._getDiverLighting(128, 96) : null;
    if (real) {
      // 1. 船底から光源の反対側（水中）へ滑らかに伸びる一体型の船影と、光の強さに連動する水鏡リフレクション
      ctx.save();
      const bWave = Math.sin(this.bioTime * 2.8) * 4.5;
      const bShiftX = ltBoat.nx * 42 * ltBoat.lenMul + bWave;
      const bShiftY = Math.max(8, ltBoat.ny * 24 * ltBoat.lenMul);
      const bShadowGrad = ctx.createRadialGradient(125 + bShiftX * 0.45, 114 + bShiftY * 0.4, 12, 125 + bShiftX, 118 + bShiftY, 115);
      bShadowGrad.addColorStop(0, ltBoat.shadowColor(0.72 * ltBoat.shadowStrength));
      bShadowGrad.addColorStop(0.55, ltBoat.shadowColor(0.38 * ltBoat.shadowStrength));
      bShadowGrad.addColorStop(1, ltBoat.shadowColor(0));
      ctx.fillStyle = bShadowGrad;
      ctx.beginPath();
      ctx.ellipse(125 + bShiftX * 0.72, 116 + bShiftY * 0.68, 108, 20, 0.05 * ltBoat.nx, 0, Math.PI * 2);
      ctx.fill();

      // 船体の赤い塗装がすぐ下の水面に映り込む水鏡リフレクション（光の強さ rimPower に応じて強弱）
      if (ltBoat.rimPower > 0.12) {
        for (let wr = 0; wr < 3; wr++) {
          const wy = 118 + wr * 5.5;
          const wSway = Math.sin(this.bioTime * 3.8 + wr * 1.4) * (3.5 + wr * 1.6);
          const wLen = 74 - wr * 16;
          ctx.strokeStyle = `rgba(185, 28, 28, ${((0.24 - wr * 0.06) * ltBoat.rimPower).toFixed(3)})`;
          ctx.lineWidth = 2.4 - wr * 0.4;
          ctx.beginPath();
          ctx.moveTo(125 - wLen + wSway + ltBoat.nx * wr * 4, wy);
          ctx.lineTo(125 + wLen + wSway + ltBoat.nx * wr * 4, wy);
          ctx.stroke();
        }
      }
      ctx.restore();

      // 2. 光源方向（朝日・夕日・太陽・満月）から立体的に照らされる船体グラデーション
      const boatGrad = ctx.createLinearGradient(
        125 - ltBoat.nx * 95,
        82 - ltBoat.ny * 12,
        125 + ltBoat.nx * 95,
        118 + ltBoat.ny * 14
      );
      const hullR = Math.min(255, Math.round(185 * (1 - ltBoat.nightWeight * 0.48) + ltBoat.rimArr[0] * 0.24));
      const hullG = Math.min(255, Math.round(28 * (1 - ltBoat.nightWeight * 0.35) + ltBoat.rimArr[1] * 0.14));
      const hullB = Math.min(255, Math.round(28 * (1 - ltBoat.nightWeight * 0.15) + ltBoat.rimArr[2] * 0.18));
      boatGrad.addColorStop(0, `rgb(${hullR}, ${hullG}, ${hullB})`);
      boatGrad.addColorStop(0.45, `rgb(${Math.round(hullR * 0.68)}, ${Math.round(hullG * 0.58)}, ${Math.round(hullB * 0.62)})`);
      boatGrad.addColorStop(0.82, `rgb(${Math.round(hullR * 0.36)}, ${Math.round(hullG * 0.28)}, ${Math.round(hullB * 0.34)})`);
      boatGrad.addColorStop(1, '#160408');
      ctx.fillStyle = boatGrad;
      ctx.strokeStyle = '#270909';
    } else {
      ctx.fillStyle = 'rgba(138, 48, 34, 0.72)';
      ctx.strokeStyle = 'rgba(72, 24, 16, 0.85)';
    }
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(22, 82);
    ctx.lineTo(232, 82);
    ctx.lineTo(208, 116);
    ctx.lineTo(42, 116);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // GAME C: 船体の光源側エッジに輝くリムハイライトと水面からの照り返し（光が弱い時は控えめに減光・消滅）
    if (real && ltBoat) {
      ctx.save();
      if (ltBoat.rimPower > 0.08) {
        ctx.strokeStyle = ltBoat.rimColor(0.82 * ltBoat.rimPower);
        ctx.lineWidth = 1.6 + ltBoat.rimPower * 1.0;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(23, 82.8);
        ctx.lineTo(231, 82.8);
        if (-ltBoat.nx >= 0) {
          ctx.moveTo(231, 82.8);
          ctx.lineTo(208, 115);
        } else {
          ctx.moveTo(23, 82.8);
          ctx.lineTo(42, 115);
        }
        ctx.stroke();
      }

      // 水面から船腹へ跳ね返る波紋状の反射光（強い日差しがある時のみ）
      if (ltBoat.specPower > 0.08) {
        ctx.strokeStyle = ltBoat.rimColor(0.34 * ltBoat.specPower);
        ctx.lineWidth = 1.5;
        for (let wc = 0; wc < 3; wc++) {
          const cx = 62 + wc * 56 + Math.sin(this.bioTime * 3.2 + wc) * 8;
          const cy = 104 + Math.cos(this.bioTime * 4.1 + wc) * 2.5;
          ctx.beginPath();
          ctx.moveTo(cx - 18, cy);
          ctx.quadraticCurveTo(cx, cy - 3.5, cx + 18, cy);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // 船の白いラインと操舵室フレーム
    ctx.strokeStyle = real ? ltBoat.rimColor(0.45 + 0.50 * ltBoat.rimPower) : 'rgba(235, 225, 195, 0.65)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(32, 92);
    ctx.lineTo(220, 92);
    ctx.stroke();

    // 船から海中へ垂れるロープ梯子（pos=1用：GAME Cでは単一ソフトブラーの滑らかな影付き）
    if (real && ltBoat) {
      ctx.save();
      const lWave = Math.sin(this.bioTime * 2.8) * 2.8;
      const lxOff = ltBoat.nx * 14 * ltBoat.lenMul + lWave;
      const lyOff = ltBoat.ny * 7 * ltBoat.lenMul;
      const lCol = ltBoat.shadowColor(0.32 * ltBoat.shadowStrength);
      ctx.shadowColor = lCol;
      ctx.shadowBlur = 6;
      ctx.strokeStyle = lCol;
      ctx.lineWidth = 3.0;
      ctx.beginPath();
      ctx.moveTo(182 + lxOff * 0.35, 116);
      ctx.lineTo(155 + lxOff, 228 + lyOff);
      ctx.moveTo(198 + lxOff * 0.35, 116);
      ctx.lineTo(171 + lxOff, 228 + lyOff);
      for (let r = 0; r < 5; r++) {
        const ry = 132 + r * 20 + lyOff * (r / 5);
        const rx = 180 - r * 5 + lxOff * (0.35 + 0.65 * (r / 5));
        ctx.moveTo(rx, ry);
        ctx.lineTo(rx + 16, ry);
      }
      ctx.stroke();
      ctx.restore();
    }
    ctx.strokeStyle = real ? ltBoat.sackLit : 'rgba(92, 58, 30, 0.55)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(182, 116);
    ctx.lineTo(155, 228);
    ctx.moveTo(198, 116);
    ctx.lineTo(171, 228);
    for (let r = 0; r < 5; r++) {
      const ry = 132 + r * 20;
      const rx = 180 - r * 5;
      ctx.moveTo(rx, ry);
      ctx.lineTo(rx + 16, ry);
    }
    ctx.stroke();

    // --- 右奥〜宝箱の後ろにそびえる大きな沈没帆船（ガレオン船・カラー印刷層） ---
    this._drawSunkenGalleon(ctx);

    // --- 左側〜海底の岩礁と海藻プリント ---
    const ltReef = real ? this._getDiverLighting(220, 360) : null;
    if (real) {
      // 岩礁斜面が光源の反対側へ落とす滑らかな海底シャドウ（nxの符号に応じて左右正しく伸びる）
      ctx.save();
      const rShiftX = ltReef.nx * 42 * ltReef.lenMul;
      const rShiftY = Math.max(6, ltReef.ny * 16 * ltReef.lenMul);
      const rCol = ltReef.shadowColor(0.58 * ltReef.shadowStrength);
      ctx.shadowColor = rCol;
      ctx.shadowBlur = 12;
      ctx.fillStyle = rCol;
      ctx.beginPath();
      ctx.moveTo(0, 195);
      ctx.quadraticCurveTo(68 + rShiftX * 0.6, 205 + rShiftY * 0.5, 86 + rShiftX, 260 + rShiftY);
      ctx.quadraticCurveTo(118 + rShiftX, 330 + rShiftY, 150 + rShiftX * 1.15, 382 + rShiftY);
      ctx.lineTo(265 + rShiftX * 0.8, 420 + rShiftY * 0.6);
      ctx.lineTo(150, 440);
      ctx.lineTo(0, 440);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      const reefGrad = ctx.createLinearGradient(
        180 - ltReef.nx * 140,
        195,
        360 + ltReef.nx * 140,
        480
      );
      reefGrad.addColorStop(0, ltReef.suitMid);
      reefGrad.addColorStop(0.32, '#334155');
      reefGrad.addColorStop(0.72, '#1e293b');
      reefGrad.addColorStop(1, '#090f1d');
      ctx.fillStyle = reefGrad;
      ctx.strokeStyle = '#0f172a';
    } else {
      ctx.fillStyle = 'rgba(54, 78, 52, 0.34)';
      ctx.strokeStyle = 'rgba(40, 58, 38, 0.52)';
    }
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, 195);
    ctx.quadraticCurveTo(68, 205, 86, 260);
    ctx.quadraticCurveTo(118, 330, 150, 382);
    ctx.lineTo(265, 420);
    ctx.lineTo(465, 434);
    ctx.lineTo(720, 438);
    ctx.lineTo(720, 480);
    ctx.lineTo(0, 480);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    if (real && ltReef) {
      // 海底の砂地・岩肌のリアルな陰影ハイライトと、光の強さに連動する海底コースティクス
      const sandGrad = ctx.createLinearGradient(
        380 - ltReef.nx * 220,
        385,
        380 + ltReef.nx * 220,
        480
      );
      sandGrad.addColorStop(0, ltReef.rimColor(0.32 * ltReef.rimPower));
      sandGrad.addColorStop(0.45, 'rgba(136, 118, 90, 0.34)');
      sandGrad.addColorStop(1, 'rgba(15, 23, 42, 0.45)');
      ctx.fillStyle = sandGrad;
      ctx.beginPath();
      ctx.moveTo(150, 382);
      ctx.lineTo(265, 420);
      ctx.lineTo(465, 434);
      ctx.lineTo(720, 438);
      ctx.lineTo(720, 480);
      ctx.lineTo(120, 480);
      ctx.closePath();
      ctx.fill();

      // 岩礁の稜線と海底の砂地に差す光源方向のリムハイライト＆波紋コースティクス
      ctx.save();
      if (ltReef.rimPower > 0.08) {
        ctx.strokeStyle = ltReef.rimColor(0.40 * ltReef.rimPower);
        ctx.lineWidth = 2.0;
        ctx.beginPath();
        ctx.moveTo(0, 195);
        ctx.quadraticCurveTo(68, 205, 86, 260);
        ctx.quadraticCurveTo(118, 330, 150, 382);
        ctx.lineTo(265, 420);
        ctx.lineTo(465, 434);
        ctx.lineTo(610, 437);
        ctx.stroke();
      }

      // 海底の上をゆらゆら流れる光の網目リボン（直射光がある時のみ出現）
      if (ltReef.specPower > 0.06) {
        ctx.strokeStyle = ltReef.rimColor(0.24 * ltReef.specPower);
        ctx.lineWidth = 1.8;
        for (let ci = 0; ci < 6; ci++) {
          const cxBase = 175 + ci * 78 + Math.sin(this.bioTime * 2.2 + ci * 1.3) * 14;
          const cyBase = 426 + (ci % 2) * 14 + Math.cos(this.bioTime * 2.8 + ci) * 3.5;
          ctx.beginPath();
          ctx.moveTo(cxBase - 24, cyBase);
          ctx.quadraticCurveTo(cxBase, cyBase - 5 * Math.sin(this.bioTime * 3.5 + ci), cxBase + 24, cyBase + 2);
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // 海藻の揺らぎシルエット（GAME C では超リアルに色と形が揺れる多層ジャイアントケルプ＆紅藻群、および岩礁・沈没船の手前を泳ぐ多彩な海洋生物を描画）
    if (real) {
      this._drawRealisticSwayingKelp(ctx);
      if (this.underwaterFish) {
        for (const f of this.underwaterFish) {
          if (f.fg) this._drawSeaCreatureItem(ctx, f, env);
        }
      }
    } else {
      ctx.strokeStyle = 'rgba(38, 92, 58, 0.42)';
      ctx.lineWidth = 4;
      const weeds = [42, 74, 305, 492];
      for (const wx of weeds) {
        ctx.beginPath();
        ctx.moveTo(wx, 445);
        ctx.quadraticCurveTo(wx - 12, 410, wx + 6, 380);
        ctx.quadraticCurveTo(wx + 16, 355, wx - 4, 332);
        ctx.stroke();
      }
    }

    // --- 右下の開いた黄金の宝箱（プリント層） ---
    const cx = 612, cy = 382;
    const ltChest = real ? this._getDiverLighting(cx + 42, cy + 32) : null;
    if (real && ltChest) {
      // 1. 宝箱から光源の反対側へ滑らかに伸びる一体型キャストシャドウ
      ctx.save();
      const cSway = Math.sin(this.bioTime * 2.8) * 3.2;
      const cOffX = ltChest.nx * 38 * ltChest.lenMul + cSway;
      const cOffY = Math.max(6, ltChest.ny * 14 * ltChest.lenMul);
      const cShadowGrad = ctx.createRadialGradient(cx + 42, cy + 60, 8, cx + 42 + cOffX, cy + 62 + cOffY, 70);
      cShadowGrad.addColorStop(0, ltChest.shadowColor(0.72 * ltChest.shadowStrength));
      cShadowGrad.addColorStop(0.55, ltChest.shadowColor(0.38 * ltChest.shadowStrength));
      cShadowGrad.addColorStop(1, ltChest.shadowColor(0));
      ctx.fillStyle = cShadowGrad;
      ctx.beginPath();
      ctx.ellipse(cx + 42 + cOffX * 0.72, cy + 62 + cOffY * 0.72, 62, 13, 0, 0, Math.PI * 2);
      ctx.fill();

      // 2. 開いた宝箱から水中へ立ち昇る黄金のオーラ（光の強さに応じて強弱）
      const auraPulse = (0.78 + 0.22 * Math.sin(this.bioTime * 3.8)) * (0.45 + 0.55 * ltChest.rimPower);
      const auraGrad = ctx.createRadialGradient(cx + 44, cy + 16, 6, cx + 44 - ltChest.nx * 14, cy - 12, 68);
      auraGrad.addColorStop(0, `rgba(254, 240, 138, ${(0.40 * auraPulse).toFixed(3)})`);
      auraGrad.addColorStop(0.45, `rgba(250, 204, 21, ${(0.16 * auraPulse).toFixed(3)})`);
      auraGrad.addColorStop(1, 'rgba(234, 179, 8, 0)');
      ctx.fillStyle = auraGrad;
      ctx.beginPath();
      ctx.arc(cx + 44, cy + 8, 68, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      const chestGrad = ctx.createLinearGradient(
        cx + 42 - ltChest.nx * 44,
        cy,
        cx + 42 + ltChest.nx * 44,
        cy + 64
      );
      chestGrad.addColorStop(0, ltChest.helmDark);
      chestGrad.addColorStop(0.5, '#7c2d12');
      chestGrad.addColorStop(1, '#2a0503');
      ctx.fillStyle = chestGrad;
      ctx.strokeStyle = '#270905';
    } else {
      ctx.fillStyle = 'rgba(138, 72, 24, 0.78)';
      ctx.strokeStyle = 'rgba(65, 32, 10, 0.9)';
    }
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.roundRect(cx, cy + 16, 84, 48, 5);
    ctx.fill();
    ctx.stroke();

    // 開いた蓋
    ctx.beginPath();
    ctx.moveTo(cx + 4, cy + 16);
    ctx.lineTo(cx + 18, cy - 8);
    ctx.lineTo(cx + 92, cy - 2);
    ctx.lineTo(cx + 84, cy + 16);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // GAME C: 宝箱の蓋エッジに走る光源リムハイライト
    if (real && ltChest) {
      ctx.save();
      ctx.strokeStyle = ltChest.rimColor(0.82);
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(cx + 4, cy + 16);
      ctx.lineTo(cx + 18, cy - 8);
      ctx.lineTo(cx + 92, cy - 2);
      ctx.stroke();
      ctx.restore();
    }

    // 中の金貨・財宝の輝き
    if (real) {
      const goldGrad = ctx.createRadialGradient(cx + 40, cy + 15, 3, cx + 44, cy + 18, 36);
      goldGrad.addColorStop(0, '#fef9c3');
      goldGrad.addColorStop(0.45, '#facc15');
      goldGrad.addColorStop(0.85, '#ca8a04');
      goldGrad.addColorStop(1, '#854d0e');
      ctx.fillStyle = goldGrad;
    } else {
      ctx.fillStyle = 'rgba(235, 185, 35, 0.88)';
    }
    ctx.beginPath();
    ctx.ellipse(cx + 44, cy + 18, 34, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = real ? '#713f12' : 'rgba(120, 80, 10, 0.8)';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    if (real) {
      // GAME C: 宝箱の中にぎっしり詰まった個別の金貨・金塊・ルビー・エメラルド・黄金聖杯のディテール
      const coinOffsets = [
        [-22, 2, 3.8], [-15, -2, 4.0], [-8, 3, 3.6], [0, -3, 4.2], [8, 2, 3.9],
        [15, -1, 4.1], [22, 3, 3.7], [-11, 5, 3.5], [4, 5, 3.8], [18, 5, 3.5]
      ];
      for (const [ox, oy, cr] of coinOffsets) {
        ctx.fillStyle = '#fde047';
        ctx.strokeStyle = '#a16207';
        ctx.lineWidth = 0.9;
        ctx.beginPath();
        ctx.ellipse(cx + 44 + ox, cy + 16 + oy, cr, cr * 0.68, 0.15, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      // 赤いルビーと緑のエメラルドの輝き
      ctx.fillStyle = '#ef4444';
      ctx.beginPath();
      ctx.arc(cx + 34, cy + 16, 3.0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#10b981';
      ctx.beginPath();
      ctx.arc(cx + 55, cy + 15, 2.8, 0, Math.PI * 2);
      ctx.fill();
      // キラリと光る黄金スパークル
      const glintAlpha = 0.55 + 0.45 * Math.sin(this.bioTime * 6.5);
      ctx.strokeStyle = `rgba(255, 255, 255, ${glintAlpha.toFixed(3)})`;
      ctx.lineWidth = 1.3;
      const gx = cx + 44 + Math.sin(Math.floor(this.bioTime * 2.5)) * 16;
      const gy = cy + 14;
      ctx.beginPath();
      ctx.moveTo(gx - 4, gy); ctx.lineTo(gx + 4, gy);
      ctx.moveTo(gx, gy - 4); ctx.lineTo(gx, gy + 4);
      ctx.stroke();
    }

    // 宝箱の金具バンド
    ctx.strokeStyle = real ? '#fde047' : 'rgba(215, 175, 65, 0.85)';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(cx + 22, cy + 16);
    ctx.lineTo(cx + 22, cy + 64);
    ctx.moveTo(cx + 64, cy + 16);
    ctx.lineTo(cx + 64, cy + 64);
    ctx.stroke();

    ctx.restore();
  }

  // 宝物の後ろに描かれる大型沈没帆船（ガレオン船）の緻密な背景イラスト
  _drawSunkenGalleon(ctx) {
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const real = this._isRealColor();
    const ltShip = real ? this._getDiverLighting(520, 310) : null;
    let hullFill = 'rgba(96, 62, 34, 0.34)';
    let hullDark = 'rgba(68, 42, 22, 0.46)';
    let hullStroke = 'rgba(58, 38, 20, 0.58)';
    let rigStroke = 'rgba(44, 72, 78, 0.44)';
    let sailFill = 'rgba(52, 92, 102, 0.22)';
    let sailStroke = 'rgba(42, 78, 88, 0.40)';

    if (real && ltShip) {
      // GAME C: 沈没ガレオン船が光源の反対側（海底・水中）へ落とす重厚なアンビエント＆キャストシャドウ
      ctx.save();
      const sOffX = ltShip.nx * 38 * ltShip.lenMul + Math.sin(this.bioTime * 3.1) * 4;
      const sOffY = Math.max(6, ltShip.ny * 16 * ltShip.lenMul);
      const shipShadowGrad = ctx.createRadialGradient(535 + sOffX * 0.4, 438 + sOffY * 0.4, 25, 535 + sOffX, 438 + sOffY, 210);
      shipShadowGrad.addColorStop(0, ltShip.shadowColor(0.55 * ltShip.shadowStrength));
      shipShadowGrad.addColorStop(0.65, ltShip.shadowColor(0.28 * ltShip.shadowStrength));
      shipShadowGrad.addColorStop(1, ltShip.shadowColor(0));
      ctx.fillStyle = shipShadowGrad;
      ctx.beginPath();
      ctx.ellipse(535 + sOffX, 438 + sOffY * 0.6, 205, 20, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // GAME C: 時間帯・天候の光（朝日・夕日・太陽・満月・雨天）を受けて変化する海底沈没船
      const realHullGrad = ctx.createLinearGradient(
        525 - ltShip.nx * 190,
        270 - ltShip.ny * 60,
        525 + ltShip.nx * 190,
        442 + ltShip.ny * 60
      );
      const hR = Math.min(255, Math.round(98 * (1 - ltShip.nightWeight * 0.45) + ltShip.rimArr[0] * 0.18));
      const hG = Math.min(255, Math.round(64 * (1 - ltShip.nightWeight * 0.40) + ltShip.rimArr[1] * 0.14));
      const hB = Math.min(255, Math.round(40 * (1 - ltShip.nightWeight * 0.20) + ltShip.rimArr[2] * 0.16));
      realHullGrad.addColorStop(0, `rgba(${hR}, ${hG}, ${hB}, 0.90)`);
      realHullGrad.addColorStop(0.38, `rgba(${Math.round(hR * 0.68)}, ${Math.round(hG * 0.65)}, ${Math.round(hB * 0.65)}, 0.93)`);
      realHullGrad.addColorStop(0.74, `rgba(${Math.round(hR * 0.40)}, ${Math.round(hG * 0.38)}, ${Math.round(hB * 0.42)}, 0.96)`);
      realHullGrad.addColorStop(1, 'rgba(14, 10, 16, 0.98)');
      hullFill = realHullGrad;
      hullDark = 'rgba(20, 12, 10, 0.92)';
      hullStroke = 'rgba(28, 16, 10, 0.94)';
      rigStroke = ltShip.rimColor(0.42);

      const realSailGrad = ctx.createLinearGradient(
        510 - ltShip.nx * 170,
        165 - ltShip.ny * 50,
        510 + ltShip.nx * 170,
        315 + ltShip.ny * 50
      );
      realSailGrad.addColorStop(0, ltShip.rimColor(0.58));
      realSailGrad.addColorStop(0.48, 'rgba(142, 158, 154, 0.56)');
      realSailGrad.addColorStop(1, 'rgba(45, 62, 68, 0.52)');
      sailFill = realSailGrad;
      sailStroke = ltShip.rimColor(0.62);
    }

    // 1. 2本の巨大な傾いたマスト（メインマスト＆ミズンマスト）とバウスプリット（斜檣）
    ctx.strokeStyle = real ? '#4a2e1b' : hullStroke;
    ctx.lineWidth = 5.5;
    ctx.beginPath();
    // メインマスト（中央〜やや右）
    ctx.moveTo(482, 365);
    ctx.lineTo(448, 114);
    // フォアマスト（左寄り）
    ctx.moveTo(395, 378);
    ctx.lineTo(368, 152);
    // ミズンマスト（船尾側・宝箱の真後ろ）
    ctx.moveTo(628, 325);
    ctx.lineTo(662, 116);
    // 左へ突き出たバウスプリット（船首斜檣）
    ctx.moveTo(358, 366);
    ctx.lineTo(288, 326);
    ctx.stroke();

    // マスト上の見張り台（クロウズネスト）
    ctx.fillStyle = hullDark;
    ctx.beginPath();
    ctx.ellipse(455, 162, 16, 6, -0.1, 0, Math.PI * 2);
    ctx.ellipse(374, 192, 13, 5, -0.1, 0, Math.PI * 2);
    ctx.ellipse(654, 164, 14, 5, 0.12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // 2. 横帆桁（ヤード）と破れた帆（セイル）
    ctx.fillStyle = sailFill;
    ctx.strokeStyle = sailStroke;
    ctx.lineWidth = 2.5;

    // メインマストの帆（上下2段の破れた帆）
    ctx.beginPath();
    ctx.moveTo(398, 180);
    ctx.lineTo(516, 168);
    ctx.quadraticCurveTo(526, 208, 502, 232);
    ctx.lineTo(476, 214);
    ctx.lineTo(452, 238);
    ctx.lineTo(426, 218);
    ctx.quadraticCurveTo(392, 212, 398, 180);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(388, 250);
    ctx.lineTo(526, 236);
    ctx.quadraticCurveTo(536, 282, 508, 305);
    ctx.lineTo(482, 284);
    ctx.lineTo(444, 310);
    ctx.lineTo(402, 292);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // フォアマストの破れた帆
    ctx.beginPath();
    ctx.moveTo(328, 214);
    ctx.lineTo(420, 204);
    ctx.quadraticCurveTo(426, 248, 404, 268);
    ctx.lineTo(372, 250);
    ctx.lineTo(340, 272);
    ctx.quadraticCurveTo(322, 244, 328, 214);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 船尾ミズンマストの三角帆（ラティーンセイル）と帆桁
    ctx.beginPath();
    ctx.moveTo(605, 198);
    ctx.lineTo(704, 174);
    ctx.quadraticCurveTo(698, 236, 672, 264);
    ctx.lineTo(642, 242);
    ctx.lineTo(614, 258);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 帆桁（太い横木）
    ctx.strokeStyle = real ? '#5c3a21' : hullStroke;
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(392, 180); ctx.lineTo(522, 167);
    ctx.moveTo(382, 250); ctx.lineTo(532, 235);
    ctx.moveTo(324, 214); ctx.lineTo(424, 203);
    ctx.moveTo(600, 199); ctx.lineTo(708, 173);
    ctx.stroke();

    // 3. 縄梯子（シュラウド・ラットライン）と索具
    ctx.strokeStyle = rigStroke;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    // メインマストの縄梯子
    for (let i = -2; i <= 2; i++) {
      ctx.moveTo(455, 166);
      ctx.lineTo(476 + i * 14, 362);
    }
    for (let y = 188; y <= 348; y += 20) {
      const t = (y - 166) / (362 - 166);
      const cx = 455 + (476 - 455) * t;
      const halfW = 28 * t;
      ctx.moveTo(cx - halfW, y);
      ctx.lineTo(cx + halfW, y);
    }
    // ミズンマストの縄梯子
    for (let i = -1; i <= 1; i++) {
      ctx.moveTo(654, 168);
      ctx.lineTo(632 + i * 14, 326);
    }
    ctx.stroke();

    // 4. 巨大な帆船の船体（ハル）と高くそびえる船尾楼（スターンキャッスル）
    ctx.fillStyle = hullFill;
    ctx.strokeStyle = hullStroke;
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.moveTo(342, 356); // 船首上端
    ctx.lineTo(418, 366); // 前甲板
    ctx.lineTo(432, 378); // 中央甲板（ウェスト）
    ctx.lineTo(548, 368); // 後甲板への段差
    ctx.lineTo(568, 336); // クォーターデッキ（後甲板）
    ctx.lineTo(618, 326);
    ctx.lineTo(632, 286); // 高くそびえる船尾楼（プープデッキ）
    ctx.lineTo(712, 272); // 船尾最上段
    ctx.quadraticCurveTo(718, 355, 696, 442); // 船尾の曲線
    ctx.lineTo(368, 442); // 竜骨（船底）
    ctx.quadraticCurveTo(346, 405, 342, 356);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // GAME C: 沈没船の甲板上縁・マストの光源側エッジに走る水中リムライト
    if (real && ltShip) {
      ctx.save();
      ctx.strokeStyle = ltShip.rimColor(0.55 * ltShip.directStrength);
      ctx.lineWidth = 2.0;
      ctx.beginPath();
      ctx.moveTo(342, 356);
      ctx.lineTo(418, 366);
      ctx.lineTo(432, 378);
      ctx.lineTo(548, 368);
      ctx.lineTo(568, 336);
      ctx.lineTo(618, 326);
      ctx.lineTo(632, 286);
      ctx.lineTo(712, 272);
      ctx.stroke();
      ctx.restore();
    }

    // 船体の木目プランクライン（板張り）
    ctx.strokeStyle = real ? 'rgba(180, 130, 85, 0.35)' : 'rgba(58, 36, 18, 0.38)';
    ctx.lineWidth = 2;
    const plankYs = [388, 406, 424];
    for (const py of plankYs) {
      ctx.beginPath();
      ctx.moveTo(354, py);
      ctx.quadraticCurveTo(525, py + 8, 704, py - 24);
      ctx.stroke();
    }

    // 船尾楼の手すり欄干（バラストレード）と舵輪（ラダーホイール）
    ctx.strokeStyle = real ? '#a16207' : hullStroke;
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(632, 276);
    ctx.lineTo(710, 262);
    for (let x = 638; x <= 706; x += 11) {
      const yTop = 276 - ((x - 632) / 78) * 14;
      ctx.moveTo(x, yTop);
      ctx.lineTo(x, yTop + 10);
    }
    ctx.stroke();

    // 甲板上の舵輪（シップホイール）
    ctx.beginPath();
    ctx.arc(592, 320, 12, 0, Math.PI * 2);
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 4) {
      ctx.moveTo(592, 320);
      ctx.lineTo(592 + Math.cos(a) * 15, 320 + Math.sin(a) * 15);
    }
    ctx.stroke();

    // 船尾キャビンの豪華なアーチ飾り窓（4連ギャラリーウィンドウ：夕日・月光・船内灯火の反射グロー付き）
    ctx.fillStyle = real ? (ltShip ? ltShip.helmSpec : 'rgba(250, 204, 21, 0.78)') : 'rgba(218, 178, 78, 0.38)';
    ctx.strokeStyle = real ? '#ca8a04' : hullStroke;
    ctx.lineWidth = 2;
    for (let w = 0; w < 4; w++) {
      const wx = 636 + w * 17;
      const wy = 304 - w * 2.5;
      if (real && ltShip) {
        const winGlow = ctx.createRadialGradient(wx + 6, wy + 11, 2, wx + 6, wy + 11, 18);
        winGlow.addColorStop(0, ltShip.rimColor(0.55));
        winGlow.addColorStop(1, ltShip.rimColor(0));
        ctx.save();
        ctx.fillStyle = winGlow;
        ctx.beginPath();
        ctx.arc(wx + 6, wy + 11, 18, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
      ctx.beginPath();
      ctx.roundRect(wx, wy, 12, 22, [6, 6, 2, 2]);
      ctx.fill();
      ctx.stroke();
    }

    // 船腹に並ぶ大砲の砲門（ガンポート 6門）
    ctx.fillStyle = hullDark;
    ctx.strokeStyle = real ? '#5c3a21' : hullStroke;
    for (let g = 0; g < 6; g++) {
      const gx = 386 + g * 38;
      const gy = 392 - g * 2.2;
      ctx.beginPath();
      ctx.rect(gx, gy, 14, 12);
      ctx.fill();
      ctx.stroke();
      // 突き出た大砲の砲身
      ctx.fillStyle = real ? '#2dd4bf' : hullDark;
      ctx.beginPath();
      ctx.arc(gx + 7, gy + 6, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = hullDark;
    }

    // 船首から垂れ下がる錨（アンカー）
    ctx.strokeStyle = real ? '#94a3b8' : hullStroke;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(366, 368);
    ctx.lineTo(366, 412);
    ctx.moveTo(358, 384);
    ctx.lineTo(374, 384);
    ctx.arc(366, 404, 12, 0.2 * Math.PI, 0.8 * Math.PI);
    ctx.stroke();

    ctx.restore();
  }

  // 活イカの現在の色素胞集約度（0.0=透き通った活イカ透明状態 〜 1.0=赤茶色の細かなマダラ模様に全開集約）を計算
  _getSquidFlushLevel(x = 580, y = 160) {
    // 周期的に「透き通る透明状態」と「赤茶色マダラ模様への集約状態」を行き来しつつ、攻撃・捕獲時は一気に赤茶マダラに興奮する
    const slowCycle = Math.sin(this.bioTime * 1.35) * 0.5 + 0.5; // 0..1 の基本呼吸サイクル
    const sharpWave = Math.pow(slowCycle, 1.45);
    // 外套膜先端(右上)から頭部・触腕先端へ走る神経フラッシング波
    const spatialWave = Math.sin((x - 650) * 0.032 + (y - 92) * 0.032 + this.bioTime * 5.4) * 0.22;
    const pulseRipple = Math.cos((x + y) * 0.055 - this.bioTime * 8.2) * 0.08;
    const raw = sharpWave * 0.78 + this.squidFlushBoost * 0.65 + spatialWave + pulseRipple;
    return Math.max(0.02, Math.min(1.0, raw));
  }

  // 単一のリアルな水中気泡（屈折リム・扁平ゆらぎ・三日月ハイライト）を描画
  _drawSingleRefractiveBubble(c, bx, by, r, wobbleArg = 0) {
    c.save();
    c.translate(bx, by);
    // 大粒の気泡ほど水圧抵抗で横長の楕円（扁平）にボコボコと歪みながら揺れる
    const isLarge = r >= 3.8;
    const stretch = isLarge ? (1.0 + Math.sin(wobbleArg) * 0.22 + 0.14) : (1.0 + Math.sin(wobbleArg) * 0.09);
    const squash = isLarge ? (1.0 / stretch) * 0.94 : (1.0 - Math.sin(wobbleArg) * 0.07);
    const tilt = Math.cos(wobbleArg * 0.7) * (isLarge ? 0.22 : 0.08);
    c.rotate(tilt);
    c.scale(stretch, squash);

    // 1. 気泡内部の水中屈折グラデーション（中心は透き通り、輪郭がシアン銀色に輝く）
    const bGrad = c.createRadialGradient(-r * 0.28, -r * 0.28, r * 0.08, 0, 0, r);
    bGrad.addColorStop(0, 'rgba(255, 255, 255, 0.35)');
    bGrad.addColorStop(0.35, 'rgba(186, 230, 253, 0.10)');
    bGrad.addColorStop(0.76, 'rgba(125, 211, 252, 0.38)');
    bGrad.addColorStop(0.92, 'rgba(224, 242, 254, 0.82)');
    bGrad.addColorStop(1, 'rgba(12, 74, 110, 0.55)');
    c.fillStyle = bGrad;
    c.beginPath();
    c.arc(0, 0, r, 0, Math.PI * 2);
    c.fill();

    // 2. 左上の鋭い光沢ハイライト（太陽光反射）
    c.fillStyle = 'rgba(255, 255, 255, 0.94)';
    c.beginPath();
    c.ellipse(-r * 0.34, -r * 0.34, Math.max(0.7, r * 0.28), Math.max(0.5, r * 0.16), -0.65, 0, Math.PI * 2);
    c.fill();

    // 3. 右下の二次反射アーク
    if (r >= 2.2) {
      c.strokeStyle = 'rgba(186, 230, 253, 0.75)';
      c.lineWidth = Math.max(0.8, r * 0.14);
      c.lineCap = 'round';
      c.beginPath();
      c.arc(0, 0, r * 0.72, 0.15 * Math.PI, 0.45 * Math.PI);
      c.stroke();
    }
    c.restore();
  }

  // ダイバーから海面へ「ぼこぼこ」と浮かび上がる連続気泡パーティクル＆海面波紋を描画
  _drawRealisticBubbleStream(ctx) {
    if (!this._isRealColor()) return;
    ctx.save();

    // 1. 浮上中の大小気泡群
    for (const b of this.bubbles) {
      const wobbleArg = b.age * b.wobbleFreq * 1.35 + b.deformPhase;
      this._drawSingleRefractiveBubble(ctx, b.x, b.y, b.r, wobbleArg);
    }

    // 2. 海面に到達してパチンと弾けた気泡の波紋リング
    for (const rp of this.surfaceRipples) {
      ctx.strokeStyle = `rgba(224, 242, 254, ${Math.max(0, rp.alpha).toFixed(3)})`;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.ellipse(rp.x, rp.y, rp.rx, rp.rx * 0.26, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  // GAME C: 太陽・満月・朝焼け・夕焼け・快晴・雨天・水深に応じたダイバーのライティング＆逆向き影ベクトルを算出
  _getDiverLighting(x, y) {
    const env = this._getEnvAtmosphere();

    // 夜間ウェイト (0.0: 昼〜薄明, 1.0: 満月の夜)
    let nightWeight = 0;
    if (env.todIdx === 3) nightWeight = 1.0 - env.todSmooth * 0.45;
    else if (env.todIdx === 2) nightWeight = Math.max(0, (env.todSmooth - 0.35) / 0.65);
    else if (env.todIdx === 0) nightWeight = Math.max(0, 0.55 - env.todSmooth * 0.9);

    // 太陽と満月の現在座標（空の描画と完全同期）
    const sunProg = Math.min(1, Math.max(0, (env.todCycle < 3.2 ? env.todCycle : 0) / 2.8));
    const sunX = 165 + sunProg * 330;
    const sunY = 78 - Math.sin(sunProg * Math.PI) * 52;
    const moonX = 335 + Math.sin(this.bioTime * 0.02) * 45;
    const moonY = 34;

    const moonBlend = Math.max(0, Math.min(1, (nightWeight - 0.32) / 0.45));
    const lightX = sunX + (moonX - sunX) * moonBlend;
    const lightY = sunY + (moonY - sunY) * moonBlend;

    // 水中では水面の波によって入射角がわずかに屈折・揺動する
    const isUnderwater = y > 108;
    const waveRefractX = isUnderwater ? Math.sin(this.bioTime * 2.9 + x * 0.045) * 16 : 0;

    // 光源(lightX, lightY)から対象(x, y)へ向かうベクトル＝「光源の反対側（影が落ちる向き）」
    const rawDx = (x - lightX) * 1.45 + waveRefractX;
    const rawDy = Math.max(22, (y - lightY) * 0.75);
    const dist = Math.hypot(rawDx, rawDy) || 1;
    const nx = rawDx / dist; // 影が伸びるX方向（光源の反対側。光源が左にあれば nx>0、右にあれば nx<0）
    const ny = Math.max(0.28, rawDy / dist); // 影が落ちるY方向（光源が上にあるため常に下方へ落ちる）

    // 4つの時間帯別ダイバー照光パレット (0:朝焼け, 1:快晴真昼, 2:夕焼け, 3:満月の夜)
    const palettes = [
      { // 0: 朝焼け (Dawn - 東からの薔薇色・琥珀ゴールドの朝日)
        helmSpec: [255, 237, 213],
        helmMid:  [251, 146, 60],
        helmDark: [154, 52, 78],
        helmDeep: [59, 20, 48],
        suitLit:  [248, 210, 180],
        suitMid:  [186, 136, 110],
        suitShadow: [96, 58, 70],
        suitDeep: [46, 24, 38],
        visorSpec: [254, 215, 170],
        visorMid:  [244, 114, 182],
        visorDark: [49, 46, 129],
        sackLit:  [255, 238, 220],
        sackMid:  [228, 185, 148],
        sackDark: [138, 86, 68],
        rimRgb:   [253, 186, 116],
        shadowRgb: [22, 9, 36],
        lenMul:   1.34
      },
      { // 1: 真昼・快晴 (Midday - 眩しい太陽の白金・黄金光とエメラルド水光)
        helmSpec: [255, 255, 242],
        helmMid:  [245, 158, 11],
        helmDark: [180, 83, 9],
        helmDeep: [69, 26, 3],
        suitLit:  [236, 224, 192],
        suitMid:  [164, 146, 110],
        suitShadow: [94, 80, 54],
        suitDeep: [48, 38, 24],
        visorSpec: [254, 249, 195],
        visorMid:  [56, 189, 248],
        visorDark: [8, 47, 73],
        sackLit:  [252, 246, 230],
        sackMid:  [230, 211, 173],
        sackDark: [138, 107, 59],
        rimRgb:   [254, 243, 150],
        shadowRgb: [4, 14, 28],
        lenMul:   1.02
      },
      { // 2: 夕焼け (Sunset - 西からの紅蓮・茜色の強烈な夕日)
        helmSpec: [254, 215, 170],
        helmMid:  [234, 88, 12],
        helmDark: [153, 27, 27],
        helmDeep: [52, 12, 28],
        suitLit:  [246, 174, 124],
        suitMid:  [176, 102, 74],
        suitShadow: [90, 38, 48],
        suitDeep: [42, 15, 28],
        visorSpec: [253, 186, 116],
        visorMid:  [249, 115, 22],
        visorDark: [49, 16, 42],
        sackLit:  [254, 222, 192],
        sackMid:  [222, 158, 112],
        sackDark: [128, 62, 46],
        rimRgb:   [251, 113, 36],
        shadowRgb: [26, 8, 32],
        lenMul:   1.38
      },
      { // 3: 満月の夜 (Full Moon - 青銀色の神秘的な月光と濃紺の闇)
        helmSpec: [224, 242, 254],
        helmMid:  [96, 165, 250],
        helmDark: [30, 58, 138],
        helmDeep: [9, 14, 32],
        suitLit:  [168, 196, 224],
        suitMid:  [100, 126, 156],
        suitShadow: [45, 62, 90],
        suitDeep: [15, 23, 42],
        visorSpec: [224, 242, 254],
        visorMid:  [56, 189, 248],
        visorDark: [2, 6, 23],
        sackLit:  [204, 224, 242],
        sackMid:  [138, 162, 188],
        sackDark: [52, 70, 96],
        rimRgb:   [186, 230, 253],
        shadowRgb: [2, 6, 20],
        lenMul:   1.16
      }
    ];

    const pA = palettes[env.todIdx % 4];
    const pB = palettes[(env.todIdx + 1) % 4];
    const t = env.todSmooth;

    // 雨天時（rainIntensity: 0..1）は雲で直射光が拡散し、濡れたスレートブルーグレーの色調へシフト
    const rainMix = env.rainIntensity * 0.56;
    const depthRatio = isUnderwater ? Math.min(1, Math.max(0, (y - 108) / 310)) : 0;

    const mixRgbArr = (cA, cB, overcastRgb) => {
      let r = cA[0] + (cB[0] - cA[0]) * t;
      let g = cA[1] + (cB[1] - cA[1]) * t;
      let b = cA[2] + (cB[2] - cA[2]) * t;
      // 雨天時のスレートシフト
      r = r * (1 - rainMix) + overcastRgb[0] * rainMix;
      g = g * (1 - rainMix) + overcastRgb[1] * rainMix;
      b = b * (1 - rainMix) + overcastRgb[2] * rainMix;
      // 水深によるわずかな海中青緑フィルター
      if (depthRatio > 0) {
        const dMix = depthRatio * 0.18;
        r = r * (1 - dMix) + 18 * dMix;
        g = g * (1 - dMix) + 118 * dMix;
        b = b * (1 - dMix) + 148 * dMix;
      }
      return [Math.round(r), Math.round(g), Math.round(b)];
    };

    const toCss = (arr, alpha = 1) =>
      alpha >= 0.999 ? `rgb(${arr[0]}, ${arr[1]}, ${arr[2]})` : `rgba(${arr[0]}, ${arr[1]}, ${arr[2]}, ${alpha.toFixed(3)})`;

    const helmSpecArr = mixRgbArr(pA.helmSpec, pB.helmSpec, [203, 213, 225]);
    const helmMidArr  = mixRgbArr(pA.helmMid,  pB.helmMid,  [100, 116, 139]);
    const helmDarkArr = mixRgbArr(pA.helmDark, pB.helmDark, [51, 65, 85]);
    const helmDeepArr = mixRgbArr(pA.helmDeep, pB.helmDeep, [15, 23, 42]);

    const suitLitArr    = mixRgbArr(pA.suitLit,    pB.suitLit,    [162, 174, 188]);
    const suitMidArr    = mixRgbArr(pA.suitMid,    pB.suitMid,    [104, 116, 130]);
    const suitShadowArr = mixRgbArr(pA.suitShadow, pB.suitShadow, [56, 68, 82]);
    const suitDeepArr   = mixRgbArr(pA.suitDeep,   pB.suitDeep,   [24, 32, 44]);

    const visorSpecArr = mixRgbArr(pA.visorSpec, pB.visorSpec, [226, 232, 240]);
    const visorMidArr  = mixRgbArr(pA.visorMid,  pB.visorMid,  [100, 116, 139]);
    const visorDarkArr = mixRgbArr(pA.visorDark, pB.visorDark, [15, 23, 42]);

    const sackLitArr  = mixRgbArr(pA.sackLit,  pB.sackLit,  [188, 196, 206]);
    const sackMidArr  = mixRgbArr(pA.sackMid,  pB.sackMid,  [136, 144, 154]);
    const sackDarkArr = mixRgbArr(pA.sackDark, pB.sackDark, [68, 76, 88]);

    const rimArr    = mixRgbArr(pA.rimRgb,    pB.rimRgb,    [186, 206, 226]);
    const shadowArr = mixRgbArr(pA.shadowRgb, pB.shadowRgb, [10, 18, 30]);

    const lenMul = (pA.lenMul + (pB.lenMul - pA.lenMul) * t) * (1 - env.rainIntensity * 0.22);

    // 太陽高度 (0.0: 地平線/夜 〜 1.0: 真昼の天頂) と雲・雨・夜間・水深による物理的な光強度の減衰計算
    const sunAltitude = Math.max(0, Math.sin(sunProg * Math.PI)) * Math.max(0, 1.0 - nightWeight * 1.25);
    const clearSkyFactor = Math.pow(Math.max(0, 1.0 - env.rainIntensity * 1.45), 1.6); // 雨天時(rainIntensity>=0.68)は0になる
    const depthAtten = isUnderwater ? Math.max(0.22, 1.0 - depthRatio * 0.58) : 1.0;

    // 時間帯ごとの基本直射光パワー（快晴真昼:1.0、朝夕:0.25〜0.65、満月夜:0.06、雨天時:0〜極小）
    const sunDirect = (0.18 + 0.82 * sunAltitude) * Math.max(0, 1.0 - nightWeight * 1.2) * clearSkyFactor;
    const moonDirect = nightWeight * 0.08 * Math.max(0, 1.0 - env.rainIntensity * 1.3);
    const rawDirect = (sunDirect + moonDirect) * depthAtten;

    // 1. 反射光コーン・水面反射の強さ (specPower: 0.0〜1.0 — 夜間や雨天・曇天ではほぼ0〜完全に消える)
    const specPower = Math.max(0, Math.min(1, (rawDirect - 0.08) * 1.15));
    // 2. キラリと光る十字スターグレアの強さ (glintPower: 0.0〜1.0 — 晴れた日中の強い太陽光がある時だけ出現し、光が弱い時・夜・雨天は完全に0になる)
    const glintPower = Math.max(0, Math.min(1, (sunDirect * depthAtten - 0.34) * 1.55));
    // 3. 輪郭リムハイライトの強さ (rimPower: 0.08〜1.0 — 光が弱い時は控えめに減光)
    const rimPower = Math.max(0.08, Math.min(1.0, rawDirect * 1.05 + (1 - env.rainIntensity) * 0.12));
    // 4. 影の濃さ係数 (shadowStrength: 0.30〜1.0 — 明るい日中ほどくっきり濃く、雨天や夜間は柔らかく薄くなる)
    const shadowStrength = Math.max(0.30, Math.min(1.0, 0.30 + rawDirect * 0.95));

    const directStrength = specPower;

    return {
      nx,
      ny,
      lightX,
      lightY,
      isUnderwater,
      rainIntensity: env.rainIntensity,
      nightWeight,
      directStrength,
      specPower,
      glintPower,
      rimPower,
      shadowStrength,
      lenMul,
      shadowStretch: lenMul,
      helmSpec: toCss(helmSpecArr),
      helmMid:  toCss(helmMidArr),
      helmDark: toCss(helmDarkArr),
      helmDeep: toCss(helmDeepArr),
      suitLit:    toCss(suitLitArr),
      suitMid:    toCss(suitMidArr),
      suitDark:   toCss(suitShadowArr),
      suitShadow: toCss(suitShadowArr),
      suitDeep:   toCss(suitDeepArr),
      visorSpec: toCss(visorSpecArr),
      visorMid:  toCss(visorMidArr),
      visorDark: toCss(visorDarkArr),
      visorDeep: toCss(visorDarkArr),
      sackLit:  toCss(sackLitArr),
      sackMid:  toCss(sackMidArr),
      sackDark: toCss(sackDarkArr),
      rimArr,
      rimColor: (a = 1) => toCss(rimArr, a),
      shadowArr,
      shadowRgb: shadowArr,
      shadowAlpha: 0.58 * shadowStrength,
      shadowColor: (a = 1) => toCss(shadowArr, a)
    };
  }

  // 光源と逆向きに伸びる「分身にならない100%滑らかなグラデーション揺らぎ影」を描画
  _drawWaveringDiverShadow(ctx, pivotX, pivotY, pathFn, opts = {}) {
    const lt = this._getDiverLighting(pivotX, pivotY);
    const isUnderwater = opts.isUnderwater !== false;
    const footOffsetY = opts.footOffsetY || 58;
    // 明るい日差しの時ほど影をくっきり濃く（上限0.88で真っ黒な塗りつぶしにはしない）
    const brightBoost = 1.0 + lt.specPower * 0.45;
    const baseAlpha = Math.min(0.88, (opts.shadowAlpha || 0.42) * lt.shadowStrength * 1.55 * brightBoost);
    if (baseAlpha <= 0.02) return;

    // 影が伸びる距離（光源の高さと向きに応じ、明確かつダイナミックに伸ばす）
    const reach = (isUnderwater ? 46.0 : 30.0) * (1.0 + Math.abs(lt.nx) * 0.95) * lt.lenMul;
    const phase = this.bioTime * (isUnderwater ? 3.0 : 1.9) + pivotX * 0.02 + pivotY * 0.015;
    const smoothWave = Math.sin(phase) * 0.7 + Math.cos(phase * 1.5 + 0.5) * 0.3;

    ctx.save();

    // 1. 足元の甲板・海底から光源の反対側へ斜めにしっかり伸びる「連続テーパード・グラデーション影」
    if (opts.drawGroundShadow) {
      const footX = pivotX;
      const footY = pivotY + footOffsetY - 2;
      const swayPerpX = -lt.ny * smoothWave * (isUnderwater ? 5.0 : 2.0);
      const swayPerpY = lt.nx * smoothWave * (isUnderwater ? 2.2 : 0.8);
      const tipX = footX + lt.nx * reach * 2.6 + swayPerpX;
      const tipY = footY + Math.max(5.0, lt.ny * reach * 0.52) + swayPerpY;
      const midX = (footX + tipX) * 0.5 - lt.ny * Math.cos(phase * 1.3) * (isUnderwater ? 4.0 : 1.5);
      const midY = (footY + tipY) * 0.5 + lt.nx * Math.cos(phase * 1.3) * 1.5;

      // (A) 足元直下の接地アンビエントオクルージョン（光源の反対側へオフセット）
      const aoGrad = ctx.createRadialGradient(footX, footY, 2, footX + lt.nx * 9, footY + 2.0, isUnderwater ? 24 : 16);
      aoGrad.addColorStop(0, lt.shadowColor(Math.min(0.95, baseAlpha * 1.05)));
      aoGrad.addColorStop(0.55, lt.shadowColor(baseAlpha * 0.58));
      aoGrad.addColorStop(1, lt.shadowColor(0));
      ctx.fillStyle = aoGrad;
      ctx.beginPath();
      ctx.ellipse(footX + lt.nx * 8, footY + 2.0, isUnderwater ? 23 : 15, isUnderwater ? 8.5 : 5.8, 0, 0, Math.PI * 2);
      ctx.fill();

      // (B) 足元から先端へ境目なく溶ける滑らかな1本の影リボン（光源の反対側へしっかり長く伸びる）
      const gGrad = ctx.createLinearGradient(footX, footY, tipX, tipY);
      gGrad.addColorStop(0, lt.shadowColor(baseAlpha * 0.92));
      gGrad.addColorStop(0.35, lt.shadowColor(baseAlpha * 0.65));
      gGrad.addColorStop(0.72, lt.shadowColor(baseAlpha * 0.32));
      gGrad.addColorStop(1, lt.shadowColor(0));

      ctx.save();
      ctx.strokeStyle = gGrad;
      ctx.lineCap = 'round';
      ctx.lineWidth = isUnderwater ? 26 : 18;
      ctx.beginPath();
      ctx.moveTo(footX, footY);
      ctx.quadraticCurveTo(midX, midY, tipX, tipY);
      ctx.stroke();
      ctx.restore();
    }

    // 2. 水中・空間のダイバー背後（光源の反対側）に落ちる「分身にならない滑らかなソフト・ボリューメトリック影」
    const bodyCenterY = pivotY + footOffsetY * 0.36;
    const shiftX = lt.nx * reach * 0.85 + (-lt.ny) * smoothWave * (isUnderwater ? 3.5 : 1.5);
    const shiftY = lt.ny * reach * 0.50 + lt.nx * smoothWave * 1.4;
    const shX = pivotX + shiftX;
    const shY = bodyCenterY + shiftY;
    const rx = isUnderwater ? 26 : 18;
    const ry = footOffsetY * 0.66;
    const tilt = Math.atan2(shiftY, shiftX) * 0.25 + lt.nx * 0.30 + smoothWave * 0.05;

    ctx.save();
    ctx.translate(shX, shY);
    ctx.rotate(tilt);
    ctx.scale(1.0, ry / rx);
    const volGrad = ctx.createRadialGradient(-lt.nx * 4, 0, 2, 0, 0, rx);
    const coreAlpha = baseAlpha * (opts.drawGroundShadow ? 0.75 : 0.82);
    volGrad.addColorStop(0, lt.shadowColor(coreAlpha));
    volGrad.addColorStop(0.45, lt.shadowColor(coreAlpha * 0.68));
    volGrad.addColorStop(0.80, lt.shadowColor(coreAlpha * 0.28));
    volGrad.addColorStop(1, lt.shadowColor(0));
    ctx.fillStyle = volGrad;
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.restore();
  }

  // ダイバーの光源側リムライト・水中コースティクス・および「時間帯と光の強さに連動する銅ヘルメット反射光」を描画
  _drawDiverDirectionalRimAndCaustics(c, hx, hy, helmR, bodyW, bodyH, lt, isUnderwater = true) {
    c.save();
    // 光源が存在する方向ベクトル (-lt.nx, -lt.ny) と角度
    const lightDirX = -lt.nx;
    const lightDirY = -lt.ny;
    const lightAngle = Math.atan2(lightDirY, lightDirX);

    // ヘルメット球面上のスペキュラー（正反射）ホットスポット座標
    const specX = hx + lightDirX * (helmR * 0.52);
    const specY = hy + lightDirY * (helmR * 0.52);

    const pulse = 0.85 + 0.15 * Math.sin(this.bioTime * 4.8 + hx * 0.07 + hy * 0.04);
    const specStr = lt.specPower * pulse;   // 反射コーン・鏡面ハイライト強度 (0.0〜1.0)
    const glintStr = lt.glintPower * pulse; // 十字スターグレア強度 (強い日差し時のみ > 0、夜間・雨天・薄明時は 0)
    const rimStr = lt.rimPower;             // エッジリムライト強度 (0.08〜1.0)

    // 1. ヘルメットの銅ドームから周囲へ広がる「反射光ビーム＆ハロー」（光が強い時ほど輝き、夜間や雨天時は消える）
    if (specStr > 0.04) {
      const beamLen = helmR * (isUnderwater ? 2.6 : 2.1) * (0.65 + specStr * 0.55);
      const beamTargetX = specX + lightDirX * beamLen;
      const beamTargetY = specY + lightDirY * beamLen * 0.82;

      // (A) 光源方向へ跳ね返る扇状の反射光コーン
      const coneGrad = c.createRadialGradient(specX, specY, 1.0, beamTargetX * 0.45 + specX * 0.55, beamTargetY * 0.45 + specY * 0.55, beamLen);
      coneGrad.addColorStop(0, `rgba(255, 255, 255, ${(0.42 * specStr).toFixed(3)})`);
      coneGrad.addColorStop(0.30, lt.rimColor(0.28 * specStr));
      coneGrad.addColorStop(0.68, lt.rimColor(0.09 * specStr));
      coneGrad.addColorStop(1, lt.rimColor(0));
      c.fillStyle = coneGrad;
      c.beginPath();
      c.moveTo(specX - lightDirY * (helmR * 0.28), specY + lightDirX * (helmR * 0.28));
      c.lineTo(beamTargetX - lightDirY * (helmR * 1.25), beamTargetY + lightDirX * (helmR * 1.25));
      c.quadraticCurveTo(
        beamTargetX + lightDirX * (helmR * 0.4),
        beamTargetY + lightDirY * (helmR * 0.4),
        beamTargetX + lightDirY * (helmR * 1.25),
        beamTargetY - lightDirX * (helmR * 1.25)
      );
      c.lineTo(specX + lightDirY * (helmR * 0.28), specY - lightDirX * (helmR * 0.28));
      c.closePath();
      c.fill();

      // (B) ヘルメット下部の真鍮・銅からダイバー自身の肩・胸元へ落ちる金属バウンス反射光
      const bounceGrad = c.createRadialGradient(hx + lightDirX * 4, hy + helmR * 0.85, 1.5, hx, hy + helmR + 8, helmR * 1.5);
      bounceGrad.addColorStop(0, lt.rimColor(0.34 * specStr));
      bounceGrad.addColorStop(0.55, `rgba(245, 158, 11, ${(0.14 * specStr).toFixed(3)})`);
      bounceGrad.addColorStop(1, lt.rimColor(0));
      c.fillStyle = bounceGrad;
      c.beginPath();
      c.arc(hx, hy + helmR + 4, helmR * 1.4, 0, Math.PI * 2);
      c.fill();
    }

    // 2. ヘルメットの光源側エッジに走るリムライト（光の強さ rimStr に比例して強弱がつく）
    const rimAlpha = Math.min(0.92, rimStr * 0.82);
    if (rimAlpha > 0.05) {
      c.strokeStyle = lt.rimColor(rimAlpha);
      c.lineWidth = 1.4 + rimStr * 0.85;
      c.lineCap = 'round';
      c.beginPath();
      c.arc(hx, hy, helmR - 0.7, lightAngle - (0.75 + rimStr * 0.35), lightAngle + (0.75 + rimStr * 0.35));
      c.stroke();
    }

    // 球面鏡のような三日月型ハイライト（光が弱い時は小さく控えめに、雨天・暗闇では消える）
    if (specStr > 0.03) {
      c.fillStyle = `rgba(255, 255, 255, ${(0.72 * specStr).toFixed(3)})`;
      c.beginPath();
      c.ellipse(specX, specY, helmR * (0.16 + 0.10 * specStr), helmR * (0.08 + 0.05 * specStr), lightAngle + Math.PI * 0.5, 0, Math.PI * 2);
      c.fill();
    }

    // 3. ヘルメット表面でキラリと輝く十字スターグレア（強い太陽光がある時だけ輝き、夕暮れ・夜・雨天時は完全に消滅）
    if (glintStr > 0.04) {
      const glintLen = (helmR * 0.45 + helmR * 0.45 * glintStr + Math.sin(this.bioTime * 7.2 + hx * 0.1) * 2.0 * glintStr);
      const glintRot = Math.sin(this.bioTime * 2.1 + hx * 0.05) * 0.22;
      c.save();
      c.translate(specX, specY);
      c.rotate(glintRot);
      c.strokeStyle = `rgba(255, 255, 255, ${(0.88 * glintStr).toFixed(3)})`;
      c.lineWidth = 1.0 + 0.4 * glintStr;
      c.beginPath();
      c.moveTo(-glintLen, 0); c.lineTo(glintLen, 0);
      c.moveTo(0, -glintLen); c.lineTo(0, glintLen);
      c.stroke();

      c.strokeStyle = lt.rimColor(0.70 * glintStr);
      c.lineWidth = 0.85;
      const diagLen = glintLen * 0.50;
      c.beginPath();
      c.moveTo(-diagLen, -diagLen); c.lineTo(diagLen, diagLen);
      c.moveTo(-diagLen, diagLen);  c.lineTo(diagLen, -diagLen);
      c.stroke();
      c.restore();
    }

    // 4. 潜水服の肩〜胴体の光源側エッジに当たるリムハイライト
    if (rimAlpha > 0.06) {
      const shoulderX = hx - lt.nx * (bodyW * 0.46);
      const bodyTopY = hy + helmR - 1;
      const rimGrad = c.createLinearGradient(
        shoulderX,
        bodyTopY,
        hx + lt.nx * (bodyW * 0.45),
        bodyTopY + bodyH
      );
      rimGrad.addColorStop(0, lt.rimColor(rimAlpha * 0.65));
      rimGrad.addColorStop(0.45, lt.rimColor(rimAlpha * 0.18));
      rimGrad.addColorStop(1, lt.rimColor(0));
      c.fillStyle = rimGrad;
      c.beginPath();
      c.roundRect(hx - bodyW * 0.5, bodyTopY, bodyW, bodyH, 6);
      c.fill();
    }

    // 5. 海中ダイバーの表面をゆらゆら揺れ動く水面屈折光（コースティクス波紋：太陽光が強い時のみ現れる）
    if (isUnderwater && specStr > 0.08) {
      const bodyTopY = hy + helmR - 1;
      c.save();
      c.beginPath();
      c.arc(hx, hy, helmR, 0, Math.PI * 2);
      c.roundRect(hx - bodyW * 0.5, bodyTopY, bodyW, bodyH, 6);
      c.clip();

      const causticAlpha = 0.34 * specStr;
      c.strokeStyle = lt.rimColor(causticAlpha);
      c.lineWidth = 1.75;
      for (let k = -1; k <= 1; k++) {
        const waveShift = ((this.bioTime * 16 + k * 14 + hx * 0.2) % 38) - 14;
        const cy = hy - 8 + waveShift;
        const curveSway = Math.sin(this.bioTime * 5.2 + k * 1.7 + hx * 0.08) * 4.5;
        c.beginPath();
        c.moveTo(hx - 15, cy - lt.nx * 5);
        c.quadraticCurveTo(hx, cy + curveSway, hx + 15, cy + lt.nx * 5);
        c.stroke();
      }
      c.restore();
    }

    c.restore();
  }

  // 液晶セグメント描画ヘルパー（GAME A/B: 1981年モノクロ液晶 / GAME C: 同じ形で妙にリアルな彩色＆光源連動の滑らかな一体型揺らぎ影）
  _drawSegment(ctx, isLit, pathFn, realDrawFn = null, shadowAlpha = 0.38, shadowOpts = null) {
    if (this._isRealColor()) {
      if (!isLit) return;
      ctx.save();
      if (shadowOpts && shadowOpts.isDiver) {
        // ダイバー専用：分身にならない一体型の滑らかな揺らぎシャドウ
        this._drawWaveringDiverShadow(ctx, shadowOpts.pivotX, shadowOpts.pivotY, pathFn, {
          ...shadowOpts,
          shadowAlpha
        });
      } else if (shadowAlpha > 0.01) {
        // イカやHUD等のドロップシャドウ（分身にならない単一ソフトブラーシャドウ）
        ctx.save();
        if (shadowOpts === 'hud') {
          ctx.translate(2.4, 3.0);
          ctx.fillStyle = `rgba(4, 12, 26, ${shadowAlpha.toFixed(3)})`;
          ctx.strokeStyle = `rgba(4, 12, 26, ${shadowAlpha.toFixed(3)})`;
          pathFn(ctx);
        } else {
          // イカや触腕等のドロップシャドウ：光源の反対側へしっかり落とす
          const lt = this._getDiverLighting(540, 220);
          const swX = Math.sin(this.bioTime * 2.4) * 1.5;
          const swY = Math.cos(this.bioTime * 2.0) * 1.2;
          const effAlpha = Math.min(0.78, shadowAlpha * lt.shadowStrength * 0.95);
          const col = lt.shadowColor(effAlpha);
          ctx.shadowColor = col;
          ctx.shadowBlur = 14;
          // 光源の反対側へ明確にシフト
          ctx.translate(lt.nx * 10.5 * lt.lenMul + swX, Math.max(4.0, lt.ny * 8.5 * lt.lenMul) + swY);
          ctx.fillStyle = col;
          ctx.strokeStyle = col;
          pathFn(ctx);
        }
        ctx.restore();
      }

      if (realDrawFn) {
        realDrawFn(ctx);
      } else {
        ctx.fillStyle = '#fef08a';
        ctx.strokeStyle = '#fef08a';
        pathFn(ctx);
      }
      ctx.restore();
      return;
    }

    ctx.save();
    if (isLit) {
      // 1. 反射板へのドロップシャドウ（GAME C時は上空の太陽・月光源の反対側へダイナミックに投影）
      ctx.save();
      if (this.gameMode === 'C') {
        const lt = this._getDiverLighting(360, 240);
        ctx.translate(lt.nx * 5.5, Math.max(3.2, lt.ny * 5.0));
        ctx.fillStyle = 'rgba(16, 24, 18, 0.28)';
        ctx.strokeStyle = 'rgba(16, 24, 18, 0.28)';
      } else {
        ctx.translate(2.2, 2.8);
        ctx.fillStyle = 'rgba(24, 32, 18, 0.18)';
        ctx.strokeStyle = 'rgba(24, 32, 18, 0.18)';
      }
      pathFn(ctx);
      ctx.restore();

      // 2. 点灯している液晶セグメント本体
      ctx.fillStyle = '#182015';
      ctx.strokeStyle = '#182015';
      pathFn(ctx);
    } else {
      // 非点灯（ゴースト）セグメント：実機特有のうっすら見える液晶パターン
      ctx.fillStyle = 'rgba(28, 36, 22, 0.068)';
      ctx.strokeStyle = 'rgba(28, 36, 22, 0.068)';
      pathFn(ctx);
    }
    ctx.restore();
  }

  _drawAllLcdSegments(ctx) {
    // 1. 船上に待機している残機ダイバー（2スロット）
    // 3人残っている時は船上に2人待機、2人の時は1人待機、1人の時は船上0人
    const waitingCount = Math.max(0, this.lives - 1);
    this._drawWaitingDiverInBoat(ctx, 62, 56, waitingCount >= 2);
    this._drawWaitingDiverInBoat(ctx, 112, 56, waitingCount >= 1);

    // 2. 船の右端（pos=0）のダイバー ＆ 宝袋を掲げる+3点ボーナス演出セグメント
    const atBoat = (this.state === 'PLAYING' || this.state === 'UNLOADING' || this.state === 'TIME') && this.diverPos === 0;
    const isUnloading = this.state === 'UNLOADING';
    this._drawBoatBowDiver(ctx, 168, 52, atBoat, isUnloading);

    // 3. 海中の5つのポジションのダイバー (pos = 1..5)
    // 捕まり中(CAUGHT)は通常位置のダイバーが消え、中央の「捕まりバタバタ用セグメント」が点灯する
    const diverCoordinates = [
      null,
      { x: 142, y: 184, pose: 'rope' },  // pos 1: 船の下のロープ
      { x: 194, y: 294, pose: 'walk1' }, // pos 2: 海底1 (足0の標的)
      { x: 304, y: 344, pose: 'walk2' }, // pos 3: 海底2 (足1の標的)
      { x: 420, y: 362, pose: 'walk1' }, // pos 4: 海底3 (足2の標的)
      { x: 534, y: 368, pose: 'chest' }  // pos 5: 宝箱前 (足3の標的)
    ];

    for (let p = 1; p <= 5; p++) {
      const c = diverCoordinates[p];
      const isHere = (this.state === 'PLAYING' || this.state === 'TIME' || this.state === 'BONUS') && this.diverPos === p;
      const showBag = isHere && this.hasBag;
      this._drawUnderwaterDiver(ctx, c.x, c.y, c.pose, isHere, showBag);
    }

    // 4. 宝箱前(pos=5)で宝を掴む2段階の腕セグメント
    const reach1Lit = (this.state === 'PLAYING' || this.state === 'TIME') && this.diverPos === 5 && this.grabAnimPhase === 1;
    const reach2Lit = (this.state === 'PLAYING' || this.state === 'TIME') && this.diverPos === 5 && this.grabAnimPhase === 2;
    this._drawTreasureGrabArms(ctx, 534, 368, reach1Lit, reach2Lit);

    // 5. 巨大イカ（スクイッド）の胴体・エンペラ（三角ヒレ）・目・漏斗
    this._drawGiantSquidBody(ctx);

    // 6. 巨大イカの4本の伸縮する触腕セグメント (足0:4段, 足1:5段, 足2:4段, 足3:3段)
    this._drawSquidTentacles(ctx);

    // 7. イカに捕まった時の「手足バタバタもがきダイバー」セグメント（中央空中）
    this._drawCaughtFlailingDiver(ctx);

    // 7.5. GAME C 専用：ダイバーから海面へ「ぼこぼこ」とリアルに浮かび上がる空気の泡＆波紋
    this._drawRealisticBubbleStream(ctx);

    // 8. 右上の7セグメントデジタルスコア＆モード・ステータス表示
    this._drawTopRightHudSegments(ctx);
  }

  _drawWaitingDiverInBoat(ctx, x, y, isLit) {
    this._drawSegment(ctx, isLit, (c) => {
      // 潜水ヘルメット頭部
      c.beginPath();
      c.arc(x, y, 11, 0, Math.PI * 2);
      c.fill();
      // ヘルメットの窓抜き
      c.save();
      c.globalCompositeOperation = 'destination-out';
      c.beginPath();
      c.arc(x + 2, y - 1, 5, 0, Math.PI * 2);
      c.fill();
      c.restore();
      // 座っている上半身
      c.beginPath();
      c.roundRect(x - 10, y + 11, 20, 16, 4);
      c.fill();
    }, (c) => {
      // GAME C: 太陽・満月・朝焼け・夕焼け・雨天の光源に合わせて照らされた銅ヘルメット＆潜水服
      const lt = this._getDiverLighting(x, y);
      const suitGrad = c.createLinearGradient(
        x - lt.nx * 12,
        y + 11 - lt.ny * 8,
        x + lt.nx * 12,
        y + 27 + lt.ny * 8
      );
      suitGrad.addColorStop(0, lt.suitLit);
      suitGrad.addColorStop(0.52, lt.suitMid);
      suitGrad.addColorStop(1, lt.suitDeep);
      c.fillStyle = suitGrad;
      c.beginPath();
      c.roundRect(x - 10, y + 11, 20, 16, 4);
      c.fill();

      const helmGrad = c.createRadialGradient(
        x - lt.nx * 5.2,
        y - lt.ny * 5.2,
        1.5,
        x,
        y,
        11
      );
      helmGrad.addColorStop(0, lt.helmSpec);
      helmGrad.addColorStop(0.42, lt.helmMid);
      helmGrad.addColorStop(0.80, lt.helmDark);
      helmGrad.addColorStop(1, lt.helmDeep);
      c.fillStyle = helmGrad;
      c.beginPath();
      c.arc(x, y, 11, 0, Math.PI * 2);
      c.fill();

      // ガラス覗き窓＋空の色（朝日・夕日・月光・快晴）の反射
      const glassGrad = c.createRadialGradient(
        x + 2 - lt.nx * 2,
        y - 1 - lt.ny * 2,
        0.8,
        x + 2,
        y - 1,
        5
      );
      glassGrad.addColorStop(0, lt.visorSpec);
      glassGrad.addColorStop(0.55, lt.visorMid);
      glassGrad.addColorStop(1, lt.visorDark);
      c.fillStyle = glassGrad;
      c.beginPath();
      c.arc(x + 2, y - 1, 5, 0, Math.PI * 2);
      c.fill();

      // 光源方向のリムライト
      this._drawDiverDirectionalRimAndCaustics(c, x, y, 11, 20, 16, lt, false);
    }, 0.42, {
      isDiver: true,
      pivotX: x,
      pivotY: y,
      isUnderwater: false,
      footOffsetY: 26,
      drawGroundShadow: true
    });
  }

  _drawBoatBowDiver(ctx, x, y, isLit, isUnloading) {
    const activeUnload = isLit && (isUnloading || this.hasBag);
    const unloadProg = isUnloading
      ? Math.min(1, (this.unloadElapsed || 0) / 1.05)
      : 0;
    const bodyLeanX = activeUnload ? Math.sin((this.unloadElapsed || 0) * 26) * 1.4 + 1.5 : 0;

    // 1. 船首に立つダイバー本体（GAME A / B は本家準拠の固定モノクロ液晶セグメント）
    this._drawSegment(ctx, isLit, (c) => {
      c.beginPath();
      c.arc(x, y, 12, 0, Math.PI * 2);
      c.fill();
      c.beginPath();
      c.roundRect(x - 10, y + 12, 20, 24, 5);
      c.fill();
      // 足
      c.lineWidth = 6;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x - 5, y + 34);
      c.lineTo(x - 8, y + 48);
      c.moveTo(x + 5, y + 34);
      c.lineTo(x + 9, y + 48);
      c.stroke();
    }, (c) => {
      const lt = this._getDiverLighting(x, y);
      // GAME C 専用：足（重厚な潜水ズボンと鉛靴・光源シェーディング）
      const legGrad = c.createLinearGradient(
        x - lt.nx * 10,
        y + 34,
        x + lt.nx * 10,
        y + 48
      );
      legGrad.addColorStop(0, lt.suitMid);
      legGrad.addColorStop(1, lt.suitDeep);
      c.strokeStyle = legGrad;
      c.lineWidth = 6;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x - 5, y + 34);
      c.lineTo(x - 8, y + 48);
      c.moveTo(x + 5, y + 34);
      c.lineTo(x + 9, y + 48);
      c.stroke();

      // 胴体（太陽・満月・夕焼け・雨天の色で照らされたキャンバス潜水服）
      const suitGrad = c.createLinearGradient(
        x - lt.nx * 12,
        y + 12 - lt.ny * 10,
        x + lt.nx * 12,
        y + 36 + lt.ny * 10
      );
      suitGrad.addColorStop(0, lt.suitLit);
      suitGrad.addColorStop(0.48, lt.suitMid);
      suitGrad.addColorStop(0.82, lt.suitShadow);
      suitGrad.addColorStop(1, lt.suitDeep);
      c.fillStyle = suitGrad;
      c.beginPath();
      c.roundRect(x - 10 + bodyLeanX * 0.7, y + 12, 20, 24, 5);
      c.fill();

      // 真鍮・銅製ヘルメット（光源方向にハイライトが移動）
      const hx = x + bodyLeanX;
      const helmGrad = c.createRadialGradient(
        hx - lt.nx * 5.6,
        y - lt.ny * 5.6,
        1.8,
        hx,
        y,
        12
      );
      helmGrad.addColorStop(0, lt.helmSpec);
      helmGrad.addColorStop(0.40, lt.helmMid);
      helmGrad.addColorStop(0.78, lt.helmDark);
      helmGrad.addColorStop(1, lt.helmDeep);
      c.fillStyle = helmGrad;
      c.beginPath();
      c.arc(hx, y, 12, 0, Math.PI * 2);
      c.fill();

      // ヘルメット覗き窓
      const glassGrad = c.createRadialGradient(
        hx + 3 - lt.nx * 2.2,
        y - 1 - lt.ny * 2.2,
        0.9,
        hx + 3,
        y - 1,
        5
      );
      glassGrad.addColorStop(0, lt.visorSpec);
      glassGrad.addColorStop(0.55, lt.visorMid);
      glassGrad.addColorStop(1, lt.visorDark);
      c.fillStyle = glassGrad;
      c.beginPath();
      c.arc(hx + 3, y - 1, 5, 0, Math.PI * 2);
      c.fill();

      // 光源方向のリムライト
      this._drawDiverDirectionalRimAndCaustics(c, hx, y, 12, 20, 24, lt, false);
    }, 0.44, {
      isDiver: true,
      pivotX: x,
      pivotY: y,
      isUnderwater: false,
      footOffsetY: 46,
      drawGroundShadow: true
    });

    // GAME C 専用：船の甲板上に積み上がった黄金の山
    const hasDeckPile = (this.bagsReturned > 0) || activeUnload || (this.boatDeckCoins && this.boatDeckCoins.length > 0);
    if (this._isRealColor() && hasDeckPile) {
      ctx.save();
      this._drawBoatDeckTreasureMound(ctx, x + 32, y + 32, unloadProg);
      ctx.restore();
    }

    // 生還時に宝袋を高々と掲げる腕＆宝袋セグメント（+3点ボーナス時）
    // GAME A / B は元の1981年モノクロ液晶セグメントそのまま、GAME C のみリアルな布袋荷下ろし演出
    const bagRaisedLit = isLit && (isUnloading || this.hasBag);
    this._drawSegment(ctx, bagRaisedLit, (c) => {
      c.lineWidth = 6;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x + 6, y + 16);
      c.lineTo(x + 24, y - 4);
      c.stroke();
      // 掲げた宝袋
      c.beginPath();
      c.arc(x + 30, y - 10, 11, 0, Math.PI * 2);
      c.fill();
    }, (c) => {
      this._drawRealisticBoatBagUnloading(c, x, y, unloadProg);
    }, 0.42, {
      isDiver: true,
      pivotX: x + 28,
      pivotY: y - 8,
      isUnderwater: false,
      footOffsetY: 20,
      drawGroundShadow: false
    });
  }

  // 船の甲板(x≈200, y≈84)に積み上がるリアルな金貨・金塊・宝石の山を描画
  _drawBoatDeckTreasureMound(c, deckX, deckY, unloadProg = 0) {
    c.save();
    const bagsCount = Math.max(1, this.bagsReturned || 1);
    const pileScale = Math.min(1.35, 0.55 + Math.min(4, bagsCount) * 0.16 + unloadProg * 0.25);
    const moundW = 20 * pileScale;
    const moundH = 8.5 * pileScale;

    // 1. 黄金のベースマウンド（甲板に広がる金貨の輝き）
    const mGrad = c.createRadialGradient(deckX - 2, deckY - moundH * 0.4, 1.5, deckX, deckY, moundW);
    mGrad.addColorStop(0, '#fef9c3');
    mGrad.addColorStop(0.45, '#facc15');
    mGrad.addColorStop(0.82, '#ca8a04');
    mGrad.addColorStop(1, '#713f12');
    c.fillStyle = mGrad;
    c.strokeStyle = '#713f12';
    c.lineWidth = 1.1;
    c.beginPath();
    c.moveTo(deckX - moundW, deckY + 1.5);
    c.quadraticCurveTo(deckX, deckY - moundH * 1.6, deckX + moundW, deckY + 1.5);
    c.closePath();
    c.fill();
    c.stroke();

    // 2. 甲板の上に重なる黄金の延べ棒（インゴット）と金貨・宝石のディテール
    const baseIngots = [
      [-8, -1.5, -0.12], [6, -1.2, 0.15], [0, -4.2, 0.04]
    ];
    for (const [ix, iy, irot] of baseIngots) {
      c.save();
      c.translate(deckX + ix * pileScale, deckY + iy * pileScale);
      c.rotate(irot);
      c.fillStyle = '#fde047';
      c.strokeStyle = '#854d0e';
      c.lineWidth = 0.85;
      c.beginPath();
      c.roundRect(-4.2, -2.1, 8.4, 4.2, 1.0);
      c.fill();
      c.stroke();
      c.fillStyle = '#fef9c3';
      c.fillRect(-2.8, -1.2, 5.6, 1.1);
      c.restore();
    }

    // 3. 荷下ろしで実際に跳ねて定着した個別の金貨・金塊・ルビー・エメラルド
    if (this.boatDeckCoins && this.boatDeckCoins.length > 0) {
      for (const dc of this.boatDeckCoins) {
        c.save();
        c.translate(dc.x, dc.y);
        c.rotate(dc.rot);
        if (dc.kind === 'ingot') {
          c.fillStyle = '#facc15';
          c.strokeStyle = '#713f12';
          c.lineWidth = 0.75;
          c.beginPath();
          c.roundRect(-3.6, -1.8, 7.2, 3.6, 0.9);
          c.fill();
          c.stroke();
        } else if (dc.kind === 'ruby' || dc.kind === 'emerald') {
          c.fillStyle = dc.kind === 'ruby' ? '#ef4444' : '#10b981';
          c.strokeStyle = '#ffffff';
          c.lineWidth = 0.6;
          c.beginPath();
          c.arc(0, 0, 2.2, 0, Math.PI * 2);
          c.fill();
          c.stroke();
        } else {
          c.fillStyle = '#fde047';
          c.strokeStyle = '#854d0e';
          c.lineWidth = 0.7;
          c.beginPath();
          c.ellipse(0, 0, dc.r * 0.85, dc.r * 0.55, 0, 0, Math.PI * 2);
          c.fill();
          c.stroke();
        }
        c.restore();
      }
    }

    // 4. 甲板の金貨山のキラリと光るスパークル
    const sparkleA = 0.5 + 0.5 * Math.sin(this.bioTime * 8.0);
    c.strokeStyle = `rgba(255, 255, 255, ${sparkleA.toFixed(3)})`;
    c.lineWidth = 1.2;
    const sx = deckX + Math.sin(Math.floor(this.bioTime * 3.5)) * 8;
    const sy = deckY - moundH * 0.65;
    c.beginPath();
    c.moveTo(sx - 3.5, sy); c.lineTo(sx + 3.5, sy);
    c.moveTo(sx, sy - 3.5); c.lineTo(sx, sy + 3.5);
    c.stroke();

    c.restore();
  }

  // 船に戻ったダイバーが「満杯の布袋」を逆さに傾けて振り、金貨・金塊・宝石を甲板へザクザク降ろすリアルアニメーション
  _drawRealisticBoatBagUnloading(c, x, y, unloadProg) {
    c.save();
    const elapsed = this.unloadElapsed || 0;
    // 布袋を上下に振って金を振り落とすモーション
    const shakeWave = Math.sin(elapsed * 28);
    const shakeY = shakeWave * 3.2;
    const shakeRot = Math.cos(elapsed * 28) * 0.16;

    // 最初はパンパンの満杯(fullness=1.0)から、金が甲板に降り注ぐにつれて布袋がしぼんでシワが寄る(fullness->0.22)
    const fullness = Math.max(0.22, 1.0 - Math.max(0, unloadProg - 0.08) * 0.85);
    // 袋を逆さまに傾ける角度（最初は持ち上げ、すぐに口を甲板へ向けて逆さまに傾ける）
    const tiltProgress = Math.min(1, elapsed / 0.16);
    const bagAngle = -0.3 + tiltProgress * 2.72 + shakeRot;

    const bagCenterX = x + 30;
    const bagCenterY = y - 7 + shakeY;

    // 1. ダイバーの両腕（右腕で布袋の底角を持ち上げて振り、左腕で布袋の口元を支える）
    const armGrad = c.createLinearGradient(x + 6, y + 14, bagCenterX, bagCenterY);
    armGrad.addColorStop(0, '#c2b28f');
    armGrad.addColorStop(0.6, '#8c7a56');
    armGrad.addColorStop(1, '#4a3f2a');
    c.strokeStyle = armGrad;
    c.lineWidth = 6.2;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    // 上側の腕（布袋の底角を掴んで振る）
    c.moveTo(x + 6, y + 15);
    c.quadraticCurveTo(x + 16, y - 4 + shakeY * 0.5, bagCenterX - 3, bagCenterY - 8);
    // 下側の腕（布袋の首元を支える）
    c.moveTo(x + 8, y + 23);
    c.quadraticCurveTo(x + 19, y + 14 + shakeY * 0.5, bagCenterX - 2, bagCenterY + 5);
    c.stroke();

    // 2. 満杯の布袋（麻布・帆布の織り目・内部の金貨の凹凸・ほどけた麻紐・開いた袋口）
    c.save();
    c.translate(bagCenterX, bagCenterY);
    c.rotate(bagAngle);

    const rx = 7.8 + fullness * 6.8; // 満杯時は横幅14.6pxのぷっくり布袋 -> 空になると7.8pxのしぼんだ布袋
    const ry = 13.0 + fullness * 2.2;

    // (A) ほどけて揺れる麻紐（ドローストリング）
    c.strokeStyle = '#fef08a';
    c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(-4, -9);
    c.quadraticCurveTo(-10 - shakeWave * 2.5, -5, -12, 2 + shakeWave * 3);
    c.moveTo(4, -9);
    c.quadraticCurveTo(10 + shakeWave * 2.5, -4, 11, 3 - shakeWave * 3);
    c.stroke();

    // (B) ガバッと大きく開いた布袋の口フリル
    const mouthW = 6.5 + fullness * 3.5;
    const neckGrad = c.createLinearGradient(-mouthW, -18, mouthW, -8);
    neckGrad.addColorStop(0, '#78350f');
    neckGrad.addColorStop(0.5, '#b45309');
    neckGrad.addColorStop(1, '#451a03');
    c.fillStyle = neckGrad;
    c.strokeStyle = '#451a03';
    c.lineWidth = 1.2;
    c.beginPath();
    c.moveTo(-mouthW, -17.5);
    c.lineTo(-mouthW * 0.6, -19.2);
    c.lineTo(0, -17.2);
    c.lineTo(mouthW * 0.6, -19.2);
    c.lineTo(mouthW, -17.5);
    c.lineTo(4.2, -8.5);
    c.lineTo(-4.2, -8.5);
    c.closePath();
    c.fill();
    c.stroke();

    // (C) 布袋の口元から今まさに溢れ出している金貨・金塊・宝石の塊
    if (fullness > 0.25) {
      const mouthCoins = [
        [-3.8, -16.5, 3.1, '#fde047'],
        [0.0,  -18.0, 3.5, '#facc15'],
        [3.8,  -16.2, 3.0, '#fde047'],
        [-1.8, -14.8, 2.7, '#ef4444'],
        [2.2,  -14.8, 2.6, '#10b981']
      ];
      for (const [mcx, mcy, mcr, mcol] of mouthCoins) {
        c.fillStyle = mcol;
        c.strokeStyle = '#713f12';
        c.lineWidth = 0.75;
        c.beginPath();
        c.arc(mcx * fullness, mcy, mcr * (0.65 + fullness * 0.35), 0, Math.PI * 2);
        c.fill();
        c.stroke();
      }
    }

    // (D) 布袋本体（満杯時はゴツゴツと膨らみ、空になるにつれて布のたるみヒダができる）
    const sackGrad = c.createRadialGradient(-rx * 0.3, -ry * 0.25, 1.5, 0, 0, Math.max(rx, ry) + 2);
    sackGrad.addColorStop(0, '#fef3c7');
    sackGrad.addColorStop(0.32, '#eab308');
    sackGrad.addColorStop(0.68, '#b45309');
    sackGrad.addColorStop(1, '#451a03');
    c.fillStyle = sackGrad;
    c.strokeStyle = '#451a03';
    c.lineWidth = 1.25;

    c.beginPath();
    c.ellipse(0, 1.5, rx, ry, 0, 0, Math.PI * 2);
    c.fill();
    c.stroke();

    // (E) 布袋の織り目テクスチャ＆満杯時の金貨の張り出し凹凸／空になった時の縦シワ
    if (fullness > 0.48) {
      // 満杯〜中盤：袋の中から金貨や金塊が布地を押し広げているリアルな凹凸ハイライト
      const bulges = [
        [-rx * 0.42, -2.5, 3.8 * fullness],
        [rx * 0.38, -1.8, 3.6 * fullness],
        [-rx * 0.28, 4.8, 4.1 * fullness],
        [rx * 0.32, 4.5, 3.7 * fullness],
        [0, 1.2, 4.3 * fullness]
      ];
      c.strokeStyle = 'rgba(254, 249, 195, 0.42)';
      c.lineWidth = 1.05;
      for (const [bx, by, br] of bulges) {
        c.beginPath();
        c.arc(bx, by, br, -0.8, 1.5);
        c.stroke();
      }
    } else {
      // 終盤：金が抜けてしぼんだ布袋のリアルな縦ドレープ（布のたるみシワ）
      c.strokeStyle = 'rgba(69, 26, 3, 0.55)';
      c.lineWidth = 1.1;
      for (const fx of [-3.2, 0, 3.2]) {
        c.beginPath();
        c.moveTo(fx * 0.7, -7);
        c.quadraticCurveTo(fx * 1.3, 1.5, fx * 0.8, 10);
        c.stroke();
      }
    }

    // 麻布のクロスハッチ織り目ラインと縫い目ステッチ
    c.strokeStyle = 'rgba(120, 53, 15, 0.28)';
    c.lineWidth = 0.75;
    c.beginPath();
    c.moveTo(-rx * 0.65, -2); c.lineTo(rx * 0.65, -2);
    c.moveTo(-rx * 0.72, 3);  c.lineTo(rx * 0.72, 3);
    c.moveTo(-rx * 0.55, 8);  c.lineTo(rx * 0.55, 8);
    c.stroke();

    // 口元の縛り目リング
    c.strokeStyle = '#fde68a';
    c.lineWidth = 1.7;
    c.beginPath();
    c.moveTo(-4.5, -8.5);
    c.quadraticCurveTo(0, -7.0, 4.5, -8.5);
    c.stroke();

    c.restore();

    // 3. 傾けた布袋の口から船の甲板へザクザク降り注ぐ金貨・黄金の延べ棒・宝石の滝ストリーム
    if (this.boatUnloadParticles && this.boatUnloadParticles.length > 0) {
      for (const p of this.boatUnloadParticles) {
        if (p.delay > 0) continue;
        c.save();
        c.translate(p.x, p.y);
        c.rotate(p.rot);

        if (p.kind === 'ingot') {
          // 黄金の延べ棒（インゴット）
          const ig = c.createLinearGradient(-p.r, -p.r * 0.5, p.r, p.r * 0.5);
          ig.addColorStop(0, '#fef9c3');
          ig.addColorStop(0.45, '#facc15');
          ig.addColorStop(1, '#a16207');
          c.fillStyle = ig;
          c.strokeStyle = '#713f12';
          c.lineWidth = 0.9;
          c.beginPath();
          c.roundRect(-p.r, -p.r * 0.55, p.r * 2, p.r * 1.1, 1.2);
          c.fill();
          c.stroke();
          c.fillStyle = '#ffffff';
          c.fillRect(-p.r * 0.6, -p.r * 0.28, p.r * 1.2, p.r * 0.28);
        } else if (p.kind === 'ruby' || p.kind === 'emerald') {
          // ルビー・エメラルドの宝石
          c.fillStyle = p.kind === 'ruby' ? '#f43f5e' : '#10b981';
          c.strokeStyle = '#ffffff';
          c.lineWidth = 0.75;
          c.beginPath();
          c.moveTo(0, -p.r);
          c.lineTo(p.r * 0.85, 0);
          c.lineTo(0, p.r);
          c.lineTo(-p.r * 0.85, 0);
          c.closePath();
          c.fill();
          c.stroke();
        } else {
          // くるくる3D回転しながら船に降り注ぐ金貨
          const squash = Math.max(0.30, Math.abs(Math.cos(p.rot * 1.7)));
          const cg = c.createRadialGradient(-0.8, -0.8, 0.4, 0, 0, p.r);
          cg.addColorStop(0, '#ffffff');
          cg.addColorStop(0.38, '#fde047');
          cg.addColorStop(0.82, '#eab308');
          cg.addColorStop(1, '#854d0e');
          c.fillStyle = cg;
          c.strokeStyle = '#713f12';
          c.lineWidth = 0.8;
          c.beginPath();
          c.ellipse(0, 0, p.r, p.r * squash, 0, 0, Math.PI * 2);
          c.fill();
          c.stroke();
        }

        // 落下中の金貨のキラめきスパークル
        if (p.sparkle && Math.sin(this.bioTime * 24 + p.rot) > 0.3) {
          c.strokeStyle = 'rgba(255, 255, 255, 0.9)';
          c.lineWidth = 1.0;
          c.beginPath();
          c.moveTo(-3.2, 0); c.lineTo(3.2, 0);
          c.moveTo(0, -3.2); c.lineTo(0, 3.2);
          c.stroke();
        }
        c.restore();
      }
    }

    c.restore();
  }

  _drawDiverLimbsPath(c, x, y, pose) {
    c.lineWidth = 7;
    if (pose === 'rope') {
      c.beginPath();
      c.moveTo(x + 8, y + 18);
      c.lineTo(x + 24, y + 6);
      c.moveTo(x - 6, y + 40);
      c.lineTo(x - 12, y + 60);
      c.moveTo(x + 6, y + 40);
      c.lineTo(x + 14, y + 56);
      c.stroke();
    } else if (pose === 'walk1') {
      c.beginPath();
      c.moveTo(x - 10, y + 18);
      c.lineTo(x - 24, y + 30);
      c.moveTo(x + 10, y + 18);
      c.lineTo(x + 24, y + 10);
      c.moveTo(x - 6, y + 41);
      c.lineTo(x - 18, y + 64);
      c.moveTo(x + 6, y + 41);
      c.lineTo(x + 16, y + 64);
      c.stroke();
    } else if (pose === 'walk2') {
      c.beginPath();
      c.moveTo(x - 10, y + 18);
      c.lineTo(x - 22, y + 10);
      c.moveTo(x + 10, y + 18);
      c.lineTo(x + 24, y + 28);
      c.moveTo(x - 5, y + 41);
      c.lineTo(x - 12, y + 65);
      c.moveTo(x + 6, y + 41);
      c.lineTo(x + 20, y + 62);
      c.stroke();
    } else {
      c.beginPath();
      c.moveTo(x - 10, y + 20);
      c.lineTo(x - 24, y + 32);
      c.moveTo(x - 6, y + 41);
      c.lineTo(x - 15, y + 65);
      c.moveTo(x + 6, y + 41);
      c.lineTo(x + 14, y + 65);
      c.stroke();
    }
  }

  // GAME C 専用：布袋の首元を上から自然に握る手足パス
  _drawRealDiverLimbsPath(c, x, y, pose) {
    c.lineWidth = 7;
    if (pose === 'rope') {
      c.beginPath();
      c.moveTo(x - 10, y + 18);
      c.lineTo(x - 26, y + 24);
      c.moveTo(x + 8, y + 18);
      c.lineTo(x + 24, y + 6);
      c.moveTo(x - 6, y + 40);
      c.lineTo(x - 12, y + 60);
      c.moveTo(x + 6, y + 40);
      c.lineTo(x + 14, y + 56);
      c.stroke();
    } else if (pose === 'walk1') {
      c.beginPath();
      c.moveTo(x - 10, y + 18);
      c.lineTo(x - 26, y + 24);
      c.moveTo(x + 10, y + 18);
      c.lineTo(x + 24, y + 10);
      c.moveTo(x - 6, y + 41);
      c.lineTo(x - 16, y + 64);
      c.moveTo(x + 6, y + 41);
      c.lineTo(x + 16, y + 64);
      c.stroke();
    } else if (pose === 'walk2') {
      c.beginPath();
      c.moveTo(x - 10, y + 18);
      c.lineTo(x - 26, y + 22);
      c.moveTo(x + 10, y + 18);
      c.lineTo(x + 24, y + 28);
      c.moveTo(x - 5, y + 41);
      c.lineTo(x - 12, y + 65);
      c.moveTo(x + 6, y + 41);
      c.lineTo(x + 20, y + 62);
      c.stroke();
    } else {
      c.beginPath();
      c.moveTo(x - 10, y + 19);
      c.lineTo(x - 26, y + 24);
      c.moveTo(x - 6, y + 41);
      c.lineTo(x - 14, y + 65);
      c.moveTo(x + 6, y + 41);
      c.lineTo(x + 14, y + 65);
      c.stroke();
    }
  }

  // 海中でダイバーが手に持つ「麻の布袋（CLOTH TREASURE SACK）」の描画
  // ・潜水中（金0個）は柔らかくしぼんだ生成り麻の布袋（縦ヒダ・底角マチ・絞り口フリル・麻紐結び目）
  // ・宝箱で金を拾うたびに、布袋の底から1段ずつ金貨・金塊・宝石が積み上がり、布袋が重みでぷっくり膨らんでいく
  _drawUnderwaterClothSack(c, x, y, pose, hasBagLit) {
    const nx = x - 26;
    const ny = (pose === 'walk2') ? (y + 22) : (y + 24);
    const isAtChest = (pose === 'chest');

    const rawGold = hasBagLit
      ? Math.max(0.32, (typeof this.visualBagGold === 'number' ? this.visualBagGold : (this.bagGoldCount || 1)))
      : 0;
    const fillRatio = Math.min(1.0, rawGold / 5.0); // 0.0(空の布袋) 〜 1.0(満杯の布袋)
    const bounce = isAtChest ? (this.bagStuffBounce || 0) : 0;
    const ripple = isAtChest ? (this.bagGoldRipple || 0) : 0;
    const isFillingNow = isAtChest && (
      this.grabAnimPhase > 0 ||
      bounce > 0.04 ||
      (this.goldCoinsInFlight && this.goldCoinsInFlight.length > 0)
    );

    // 水流による布袋の揺れ（空の時は布が柔らかくたなびき、金が溜まるほど重みでどっしり落ち着く）
    // 宝箱前では布袋の口を右側の宝箱・右手方向へ向けて少し傾けて広げる
    const currentSway = Math.sin(this.bioTime * 3.1 + x * 0.05) * (0.13 * (1.0 - fillRatio * 0.55));
    const baseTilt = isAtChest ? -0.18 : (0.06 + currentSway);

    c.save();
    c.translate(nx, ny);
    c.rotate(baseTilt);

    // 金貨が袋に着弾した瞬間の弾성バウンド（横にぷっくり広がり縦に少し沈む）
    const stretchX = 1.0 + Math.sin(bounce * Math.PI * 2) * 0.16;
    const stretchY = 1.0 - Math.sin(bounce * Math.PI * 2) * 0.11;
    c.scale(stretchX, stretchY);

    // 布袋のサイズパラメータ（空の時は細長くしなやかな布袋、金が溜まるにつれて底がぷっくり大きく膨らむ）
    const neckW = isAtChest ? 4.8 : 3.8;
    const bagH = 22.0 + fillRatio * 5.5;
    const upperW = 5.8 + fillRatio * 4.5;
    const bellyW = 7.2 + fillRatio * 8.4; // 空: 7.2px(しぼんだ布袋) -> 満杯: 15.6px(パンパンの布袋)
    const cornerW = 6.6 + fillRatio * 5.4;

    const traceSackBody = () => {
      c.beginPath();
      c.moveTo(-neckW, 0);
      // 左肩〜左腹（布の柔らかいドレープ曲線）
      c.bezierCurveTo(
        -upperW, bagH * 0.26,
        -bellyW * 1.04, bagH * 0.62,
        -cornerW * 1.05, bagH * 0.90
      );
      // 布袋特有の底の左角耳（縫い目マチ）から底面中央へ
      c.quadraticCurveTo(
        -cornerW * 0.95, bagH * 1.01,
        0, bagH + (fillRatio > 0 ? 1.4 : -0.4)
      );
      // 底面中央から右角耳（縫い目マチ）へ
      c.quadraticCurveTo(
        cornerW * 0.95, bagH * 1.01,
        cornerW * 1.05, bagH * 0.90
      );
      // 右腹〜右肩
      c.bezierCurveTo(
        bellyW * 1.04, bagH * 0.62,
        upperW, bagH * 0.26,
        neckW, 0
      );
      c.closePath();
    };

    // 光源（太陽・満月・朝焼け・夕焼け・雨天）に合わせた布袋のライティング＆分身にならない滑らかなグラデーション影
    const lt = this._getDiverLighting(nx, ny);
    if (lt.shadowAlpha > 0.02) {
      const wave = Math.sin(this.bioTime * 3.0 + x * 0.03) * 1.8;
      const sx = lt.nx * 8.5 * lt.shadowStretch + (-lt.ny) * wave;
      const sy = bagH * 0.55 + lt.ny * 6.0 * lt.shadowStretch;
      const sGrad = c.createRadialGradient(sx, sy, 2, sx, sy, bagH * 0.78);
      sGrad.addColorStop(0, lt.shadowColor(lt.shadowAlpha * 0.72));
      sGrad.addColorStop(0.55, lt.shadowColor(lt.shadowAlpha * 0.34));
      sGrad.addColorStop(1, lt.shadowColor(0));
      c.save();
      c.fillStyle = sGrad;
      c.beginPath();
      c.ellipse(sx, sy, bellyW * 1.35, bagH * 0.72, 0, 0, Math.PI * 2);
      c.fill();
      c.restore();
    }

    // 1. 袋の口元の布ヒダ（巾着の絞り耳フリル／宝箱前ではガバッと開いた布袋の口）
    const mouthOpen = isAtChest || isFillingNow;
    const mouthW = mouthOpen ? (8.2 + fillRatio * 2.4) : (6.6 + fillRatio * 1.2);
    const mouthTopY = mouthOpen ? -10.5 : -9.2;

    const ruffleGrad = c.createLinearGradient(-lt.nx * mouthW, mouthTopY, lt.nx * mouthW, 0);
    ruffleGrad.addColorStop(0, lt.sackLit);
    ruffleGrad.addColorStop(0.55, lt.sackMid);
    ruffleGrad.addColorStop(1, lt.sackDark);
    c.fillStyle = ruffleGrad;
    c.strokeStyle = lt.sackDark;
    c.lineWidth = 1.15;

    // 波打つ3枚の柔らかい布ヒダ（陶器のリムではなく巾着袋の絞り布耳）
    c.beginPath();
    c.moveTo(-neckW, 0.5);
    c.quadraticCurveTo(-mouthW * 1.05, mouthTopY * 0.45, -mouthW * 0.88, mouthTopY * 0.88);
    c.quadraticCurveTo(-mouthW * 0.55, mouthTopY * 1.15, -mouthW * 0.25, mouthTopY * 0.78);
    c.quadraticCurveTo(0, mouthTopY * 1.22, mouthW * 0.25, mouthTopY * 0.78);
    c.quadraticCurveTo(mouthW * 0.55, mouthTopY * 1.15, mouthW * 0.88, mouthTopY * 0.88);
    c.quadraticCurveTo(mouthW * 1.05, mouthTopY * 0.45, neckW, 0.5);
    c.closePath();
    c.fill();
    c.stroke();

    // 布耳の縦シワ
    c.strokeStyle = 'rgba(70, 50, 24, 0.45)';
    c.lineWidth = 0.9;
    c.beginPath();
    c.moveTo(-mouthW * 0.32, mouthTopY * 0.75); c.lineTo(-neckW * 0.45, -0.5);
    c.moveTo(0, mouthTopY * 0.92);              c.lineTo(0, -0.5);
    c.moveTo(mouthW * 0.32, mouthTopY * 0.75);  c.lineTo(neckW * 0.45, -0.5);
    c.stroke();

    // 宝箱前では大きく開いた布袋の口の内側（暗い布地穴）を描画し、そこに金貨が吸い込まれるように見せる
    if (mouthOpen) {
      c.fillStyle = '#3b2510';
      c.strokeStyle = lt.sackDark;
      c.lineWidth = 0.9;
      c.beginPath();
      c.ellipse(0, mouthTopY * 0.72, mouthW * 0.76, 2.9, 0, 0, Math.PI * 2);
      c.fill();
      c.stroke();
    }

    // 満杯に近い時は布袋の口元からも金貨・宝石が山盛りに顔を覗かせる
    if (fillRatio >= 0.45) {
      const topCoins = [
        [-3.2, mouthTopY * 0.72, 2.5, '#fde047'],
        [0.0,  mouthTopY * 0.82, 2.8, '#facc15'],
        [3.2,  mouthTopY * 0.70, 2.5, '#fde047']
      ];
      if (fillRatio >= 0.75) {
        topCoins.push([-1.5, mouthTopY * 0.62, 2.2, '#ef4444']);
        topCoins.push([1.8,  mouthTopY * 0.62, 2.2, '#10b981']);
      }
      for (const [tcx, tcy, tcr, tcol] of topCoins) {
        c.fillStyle = tcol;
        c.strokeStyle = '#713f12';
        c.lineWidth = 0.7;
        c.beginPath();
        c.arc(tcx, tcy, tcr, 0, Math.PI * 2);
        c.fill();
        c.stroke();
      }
    }

    // 2. 布袋本体（光源方向が明るく照らされる生成り麻布・帆布のマットな質感グラデーション）
    const sackLightX = -lt.nx * bellyW * 0.42;
    const sackLightY = bagH * 0.42 - lt.ny * bagH * 0.22;
    const sackGrad = c.createRadialGradient(sackLightX, sackLightY, 1.5, 0, bagH * 0.55, Math.max(bellyW, bagH) * 0.98);
    sackGrad.addColorStop(0, lt.sackLit);    // 光源に照らされた麻布ハイライト
    sackGrad.addColorStop(0.52, lt.sackMid); // 時間帯・天候に染まる麻布ベージュ
    sackGrad.addColorStop(1, lt.sackDark);   // 反光源側の織り影
    c.fillStyle = sackGrad;
    traceSackBody();
    c.fill();

    // 3. 布袋内部の描画（クリップ領域内：麻布の織り目・空袋の縦ドレープ・底から順番に溜まっていく金貨と金塊の層）
    c.save();
    traceSackBody();
    c.clip();

    // (A) 麻布・帆布のクロスハッチ織り目テクスチャ
    c.strokeStyle = 'rgba(120, 88, 42, 0.16)';
    c.lineWidth = 0.7;
    c.beginPath();
    for (let wy = 4; wy < bagH; wy += 4.2) {
      c.moveTo(-bellyW, wy);
      c.lineTo(bellyW, wy + 1.2);
    }
    for (let wx = -12; wx <= 12; wx += 4.5) {
      c.moveTo(wx, 0);
      c.lineTo(wx - 1.5, bagH);
    }
    c.stroke();

    // (B) 金が溜まっていない部分（空の布袋〜上部）に入る柔らかい布の縦ヒダ・たるみシワ
    const emptyTopH = bagH * (1.0 - fillRatio * 0.78);
    if (emptyTopH > 4) {
      const folds = [-0.42, 0.0, 0.42];
      for (const f of folds) {
        c.strokeStyle = 'rgba(115, 82, 38, 0.36)';
        c.lineWidth = 1.1;
        c.beginPath();
        c.moveTo(f * neckW * 0.8, 1);
        c.quadraticCurveTo(f * bellyW * 0.95, emptyTopH * 0.55, f * cornerW * 0.75, Math.min(bagH - 2, emptyTopH + 5));
        c.stroke();

        c.strokeStyle = 'rgba(255, 252, 240, 0.48)';
        c.lineWidth = 0.8;
        c.beginPath();
        c.moveTo(f * neckW * 0.8 + 1.0, 1);
        c.quadraticCurveTo(f * bellyW * 0.95 + 1.0, emptyTopH * 0.55, f * cornerW * 0.75 + 1.0, Math.min(bagH - 2, emptyTopH + 5));
        c.stroke();
      }
    }

    // (C) 金を拾うたびに布袋の底から順番に金貨・金塊・宝石が溜まっていく演出！
    if (fillRatio > 0.01) {
      // 現在の金のかさ（底から fillTopY まで金が詰まっている）
      const fillFrac = Math.min(0.95, 0.22 + fillRatio * 0.73);
      const fillTopY = bagH * (1.0 - fillFrac);

      // 布袋の底から金が詰まっている領域の黄金色の透かし・張り出しグロー
      const goldGlowGrad = c.createLinearGradient(0, fillTopY, 0, bagH);
      goldGlowGrad.addColorStop(0, 'rgba(253, 224, 71, 0.42)');
      goldGlowGrad.addColorStop(0.4, 'rgba(234, 179, 8, 0.48)');
      goldGlowGrad.addColorStop(1, 'rgba(180, 83, 9, 0.55)');
      c.fillStyle = goldGlowGrad;
      c.fillRect(-bellyW - 2, fillTopY, (bellyW + 2) * 2, bagH - fillTopY + 4);

      // 布袋の中に底から順番に積み上がっていく金貨・金塊・ルビー・エメラルドの層
      // （宝箱前では内部に溜まっていく様子がくっきり見え、移動中も布越しに黄金の塊と凹凸が透けて見える）
      const interiorAlpha = (isAtChest || isFillingNow) ? 0.92 : 0.62;
      c.save();
      c.globalAlpha = interiorAlpha;

      // 下の段(row 0: 底)から上の段(row 4: 口元近く)まで順番に溜まる財宝データ
      const stackItems = [
        // 1掴み目 (fillRatio > 0.05): 布袋の底に最初の金貨と金塊が溜まる
        { req: 0.05, x: -3.2, y: bagH - 3.2, r: 2.9, kind: 'coin' },
        { req: 0.05, x:  3.0, y: bagH - 3.0, r: 2.9, kind: 'coin' },
        { req: 0.12, x:  0.0, y: bagH - 4.2, r: 3.3, kind: 'ingot' },
        // 2掴み目 (fillRatio >= 0.30): 底の上に2段目の金貨とルビーが積み上がる
        { req: 0.28, x: -5.2, y: bagH - 7.2, r: 2.8, kind: 'coin' },
        { req: 0.32, x:  4.8, y: bagH - 7.0, r: 2.8, kind: 'coin' },
        { req: 0.36, x: -1.4, y: bagH - 8.0, r: 2.5, kind: 'ruby' },
        { req: 0.38, x:  2.2, y: bagH - 8.2, r: 3.0, kind: 'coin' },
        // 3掴み目 (fillRatio >= 0.50): 布袋の中腹まで金塊・エメラルド・金貨が溜まる
        { req: 0.48, x: -6.0, y: bagH - 11.5, r: 2.9, kind: 'coin' },
        { req: 0.52, x:  0.2, y: bagH - 12.0, r: 3.4, kind: 'ingot' },
        { req: 0.56, x:  5.6, y: bagH - 11.4, r: 2.5, kind: 'emerald' },
        { req: 0.58, x: -2.8, y: bagH - 13.2, r: 2.8, kind: 'coin' },
        // 4掴み目 (fillRatio >= 0.72): 布袋の上部までぎっしり溜まる
        { req: 0.70, x:  3.4, y: bagH - 15.6, r: 2.9, kind: 'coin' },
        { req: 0.74, x: -4.2, y: bagH - 16.2, r: 3.2, kind: 'ingot' },
        { req: 0.78, x:  0.0, y: bagH - 17.0, r: 2.6, kind: 'ruby' },
        // 5掴み目以降 (fillRatio >= 0.90): 首元までパンパンの満杯！
        { req: 0.88, x: -2.6, y: bagH - 20.2, r: 2.8, kind: 'coin' },
        { req: 0.92, x:  2.8, y: bagH - 20.0, r: 2.8, kind: 'coin' },
        { req: 0.95, x:  0.0, y: bagH - 21.2, r: 2.5, kind: 'emerald' }
      ];

      for (const item of stackItems) {
        if (fillRatio < item.req) continue;
        c.save();
        c.translate(item.x, item.y);
        if (item.kind === 'ingot') {
          c.fillStyle = '#facc15';
          c.strokeStyle = '#854d0e';
          c.lineWidth = 0.75;
          c.beginPath();
          c.roundRect(-item.r, -item.r * 0.52, item.r * 2, item.r * 1.04, 0.9);
          c.fill();
          c.stroke();
          c.fillStyle = '#fef9c3';
          c.fillRect(-item.r * 0.6, -item.r * 0.25, item.r * 1.2, item.r * 0.28);
        } else if (item.kind === 'ruby' || item.kind === 'emerald') {
          c.fillStyle = item.kind === 'ruby' ? '#ef4444' : '#10b981';
          c.strokeStyle = '#fef08a';
          c.lineWidth = 0.65;
          c.beginPath();
          c.arc(0, 0, item.r * 0.85, 0, Math.PI * 2);
          c.fill();
          c.stroke();
        } else {
          c.fillStyle = '#fde047';
          c.strokeStyle = '#854d0e';
          c.lineWidth = 0.7;
          c.beginPath();
          c.ellipse(0, 0, item.r, item.r * 0.7, 0.1, 0, Math.PI * 2);
          c.fill();
          c.stroke();
        }
        c.restore();
      }
      c.restore();

      // 溜まった金の天面ライン（新しい金貨が落ちてくるたびにキラキラ波打つ黄金ライン）
      c.strokeStyle = `rgba(254, 249, 195, ${(0.55 + ripple * 0.42).toFixed(3)})`;
      c.lineWidth = 1.3 + ripple * 0.8;
      c.beginPath();
      c.moveTo(-bellyW * 0.78, fillTopY + 1.5);
      c.quadraticCurveTo(0, fillTopY - 1.8 - ripple * 2.2, bellyW * 0.78, fillTopY + 1.5);
      c.stroke();

      // 布地の内側から金貨が押し広げている立体的な布の張りハイライト
      c.strokeStyle = 'rgba(255, 251, 235, 0.45)';
      c.lineWidth = 1.0;
      c.beginPath();
      c.arc(-bellyW * 0.32, Math.min(bagH - 5, fillTopY + 5), 3.6, -0.6, 1.3);
      c.stroke();
      c.beginPath();
      c.arc(bellyW * 0.30, Math.min(bagH - 4, fillTopY + 6), 3.4, -0.4, 1.5);
      c.stroke();
    }

    // (D) 布袋の両脇の縫い目ステッチ（破線）
    c.save();
    c.strokeStyle = 'rgba(110, 78, 35, 0.52)';
    c.lineWidth = 0.85;
    c.setLineDash([2.0, 2.0]);
    c.beginPath();
    c.moveTo(-neckW + 1.2, 2);
    c.quadraticCurveTo(-bellyW + 1.8, bagH * 0.62, -cornerW * 0.8, bagH - 1.5);
    c.moveTo(neckW - 1.2, 2);
    c.quadraticCurveTo(bellyW - 1.8, bagH * 0.62, cornerW * 0.8, bagH - 1.5);
    c.stroke();
    c.restore();

    c.restore(); // end clip

    // 4. 布袋本体の外周アウトライン＋光源側のリムハイライト
    c.strokeStyle = lt.sackDark;
    c.lineWidth = 1.25;
    traceSackBody();
    c.stroke();

    c.save();
    c.strokeStyle = lt.rimColor(0.85);
    c.lineWidth = 1.45;
    c.lineCap = 'round';
    c.beginPath();
    if (-lt.nx >= 0) {
      c.moveTo(neckW * 0.85, 1.5);
      c.quadraticCurveTo(bellyW * 0.98, bagH * 0.45, cornerW * 0.88, bagH * 0.85);
    } else {
      c.moveTo(-neckW * 0.85, 1.5);
      c.quadraticCurveTo(-bellyW * 0.98, bagH * 0.45, -cornerW * 0.88, bagH * 0.85);
    }
    c.stroke();
    c.restore();

    // 5. 首元をキュッと縛る二重巻きの麻紐（ドローストリング）と蝶結び・垂れ紐
    c.strokeStyle = '#fef08a';
    c.lineWidth = 2.0;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(-neckW - 0.8, -0.8);
    c.quadraticCurveTo(0, 1.2, neckW + 0.8, -0.8);
    c.moveTo(-neckW - 0.5, 1.2);
    c.quadraticCurveTo(0, 3.0, neckW + 0.5, 1.2);
    c.stroke();

    // 麻紐の結び目と水中で揺れる2本の垂れ紐（布袋らしさの決定打）
    const cordSway = Math.sin(this.bioTime * 5.2 + x * 0.1) * 1.8;
    c.strokeStyle = '#fde047';
    c.lineWidth = 1.35;
    c.beginPath();
    c.moveTo(-neckW, 0.5);
    c.quadraticCurveTo(-neckW - 4.5, 3.5 + cordSway * 0.5, -neckW - 5.5, 8.5 + cordSway);
    c.moveTo(-neckW + 0.5, 1.2);
    c.quadraticCurveTo(-neckW - 2.5, 5.0 - cordSway * 0.4, -neckW - 2.8, 9.8 - cordSway * 0.6);
    c.stroke();

    // 6. 布袋の首元を上からしっかり握っているダイバーの左手グローブ（時間帯・天候ライティング連動）
    const gloveGrad = c.createRadialGradient(neckW * 0.5 - lt.nx * 1.5, -1.5 - lt.ny * 1.2, 0.8, neckW * 0.6, 0, 4.6);
    gloveGrad.addColorStop(0, lt.suitLit);
    gloveGrad.addColorStop(0.58, lt.suitMid);
    gloveGrad.addColorStop(1, lt.suitDeep);
    c.fillStyle = gloveGrad;
    c.strokeStyle = lt.suitDeep;
    c.lineWidth = 1.0;
    c.beginPath();
    c.arc(neckW * 0.55, -0.2, 4.0, 0, Math.PI * 2);
    c.fill();
    c.stroke();

    c.restore();
  }

  _drawUnderwaterDiver(ctx, x, y, pose, isLit, hasBagLit) {
    // ダイバー本体セグメント
    this._drawSegment(ctx, isLit, (c) => {
      c.lineCap = 'round';
      c.lineJoin = 'round';

      // 1. 潜水ヘルメット
      c.beginPath();
      c.arc(x, y, 14, 0, Math.PI * 2);
      c.fill();

      // ヘルメット覗き窓の格子スリット表現
      c.save();
      c.globalCompositeOperation = 'destination-out';
      c.beginPath();
      c.arc(x + 4, y - 1, 6.5, 0, Math.PI * 2);
      c.fill();
      c.restore();

      // 2. 胴体（重厚な潜水服）
      c.beginPath();
      c.roundRect(x - 12, y + 13, 24, 30, 7);
      c.fill();

      // 3. 呼吸気泡（ヘルメット上の3連ドット）
      c.beginPath();
      c.arc(x - 6, y - 20, 2.8, 0, Math.PI * 2);
      c.arc(x - 2, y - 28, 3.6, 0, Math.PI * 2);
      c.fill();

      // 4. ポーズ別の手足
      this._drawDiverLimbsPath(c, x, y, pose);
    }, (c) => {
      // GAME C: 太陽・満月・朝焼け・夕焼け・快晴・雨天と水深に応じたリアルな潜水夫の照り返し＆シェーディング
      const lt = this._getDiverLighting(x, y);
      c.lineCap = 'round';
      c.lineJoin = 'round';

      // 手足（光源方向から反光源側へ陰影がつく耐圧ゴム引きキャンバス生地）
      const limbGrad = c.createLinearGradient(
        x - lt.nx * 24, y + 32 - lt.ny * 22,
        x + lt.nx * 24, y + 32 + lt.ny * 26
      );
      limbGrad.addColorStop(0, lt.suitLit);
      limbGrad.addColorStop(0.48, lt.suitMid);
      limbGrad.addColorStop(0.82, lt.suitDark);
      limbGrad.addColorStop(1, lt.suitDeep);
      c.strokeStyle = limbGrad;
      this._drawRealDiverLimbsPath(c, x, y, pose);

      // 胴体（光源方向から立体的に照らされる重厚なヴィンテージ潜水服）
      const suitGrad = c.createLinearGradient(
        x - lt.nx * 14, y + 28 - lt.ny * 15,
        x + lt.nx * 14, y + 28 + lt.ny * 15
      );
      suitGrad.addColorStop(0, lt.suitLit);
      suitGrad.addColorStop(0.36, lt.suitMid);
      suitGrad.addColorStop(0.75, lt.suitDark);
      suitGrad.addColorStop(1, lt.suitDeep);
      c.fillStyle = suitGrad;
      c.beginPath();
      c.roundRect(x - 12, y + 13, 24, 30, 7);
      c.fill();

      // 潜水ヘルメット（太陽や満月の位置を映し込む磨かれた銅・真鍮の金属光沢）
      const specX = x - lt.nx * 6.2;
      const specY = y - lt.ny * 6.2;
      const helmGrad = c.createRadialGradient(specX, specY, 1.8, x, y, 14.5);
      helmGrad.addColorStop(0, lt.helmSpec);
      helmGrad.addColorStop(0.34, lt.helmMid);
      helmGrad.addColorStop(0.74, lt.helmDark);
      helmGrad.addColorStop(1, lt.helmDeep);
      c.fillStyle = helmGrad;
      c.beginPath();
      c.arc(x, y, 14, 0, Math.PI * 2);
      c.fill();

      // ヘルメット覗き窓（空と光源の色を反射するガラス＋中の潜水夫）
      const visorGrad = c.createRadialGradient(
        x + 4 - lt.nx * 2.5, y - 1 - lt.ny * 2.5, 0.9,
        x + 4, y - 1, 6.5
      );
      visorGrad.addColorStop(0, lt.visorSpec);
      visorGrad.addColorStop(0.55, lt.visorMid);
      visorGrad.addColorStop(1, lt.visorDeep);
      c.fillStyle = visorGrad;
      c.beginPath();
      c.arc(x + 4, y - 1, 6.5, 0, Math.PI * 2);
      c.fill();

      // 光源側のエッジに輝くリムライト＆水中の揺らぐコースティクス（集光模様）
      this._drawDiverDirectionalRimAndCaustics(c, x, y, 14, 24, 30, lt, true);

      // 呼吸気泡（ヘルメット排気口直上の2つの気泡もリアルな屈折・揺らぎ気泡として描画）
      this._drawSingleRefractiveBubble(c, x - 6, y - 20, 2.9, this.bioTime * 8.0);
      this._drawSingleRefractiveBubble(c, x - 2, y - 28, 3.8, this.bioTime * 7.2 + 1.5);

      // GAME C 専用：海中に潜る時〜金を拾う時のリアルな「麻の布袋（空のしぼんだ状態→金が底から溜まって膨らむ状態）」
      this._drawUnderwaterClothSack(c, x, y, pose, hasBagLit);
    }, 0.46, {
      isDiver: true,
      pivotX: x,
      pivotY: y,
      isUnderwater: true,
      footOffsetY: 62,
      drawGroundShadow: pose !== 'rope'
    });

    // GAME A / B 用：腰にぶら下げる「宝袋（TREASURE BAG）」独立液晶セグメント（元の1981年モノクロ液晶セグメントそのまま）
    if (!this._isRealColor()) {
      this._drawSegment(ctx, hasBagLit, (c) => {
        const bx = x - 22;
        const by = y + 36;
        // 袋の結び目
        c.beginPath();
        c.moveTo(bx - 5, by - 12);
        c.lineTo(bx + 5, by - 12);
        c.lineTo(bx + 2, by - 6);
        c.lineTo(bx - 2, by - 6);
        c.closePath();
        c.fill();
        // 膨らんだ宝袋本体
        c.beginPath();
        c.arc(bx, by + 3, 11.5, 0, Math.PI * 2);
        c.fill();
      });
    }
  }

  _drawTreasureGrabArms(ctx, x, y, reach1Lit, reach2Lit) {
    // 腕セグメント1：右下の宝箱の中に手を突っ込み、金貨と宝石をごっそり鷲掴みにする
    this._drawSegment(ctx, reach1Lit, (c) => {
      c.lineWidth = 7.5;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x + 10, y + 20);
      c.lineTo(x + 48, y + 28);
      c.lineTo(x + 76, y + 24);
      c.stroke();
      // 掴んだ金貨の塊
      c.beginPath();
      c.arc(x + 82, y + 24, 7, 0, Math.PI * 2);
      c.fill();
    }, (c) => {
      // GAME C 専用：時間帯・天候の光に照らされる耐圧キャンバス袖と重厚な潜水グローブ
      const lt = this._getDiverLighting(x + 44, y + 24);
      const armGrad = c.createLinearGradient(x + 10, y + 18 - lt.ny * 8, x + 78, y + 28 + lt.ny * 8);
      armGrad.addColorStop(0, lt.suitLit);
      armGrad.addColorStop(0.6, lt.suitMid);
      armGrad.addColorStop(1, lt.suitDeep);
      c.strokeStyle = armGrad;
      c.lineWidth = 7.5;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x + 10, y + 20);
      c.lineTo(x + 48, y + 28);
      c.lineTo(x + 76, y + 24);
      c.stroke();

      // 手の中で山盛りに輝く金貨・金塊・ルビーの束
      const gx = x + 82, gy = y + 24;
      const goldGrad = c.createRadialGradient(gx - 2, gy - 2, 1, gx, gy, 8.5);
      goldGrad.addColorStop(0, '#ffffff');
      goldGrad.addColorStop(0.35, '#fef08a');
      goldGrad.addColorStop(0.72, '#eab308');
      goldGrad.addColorStop(1, '#854d0e');
      c.fillStyle = goldGrad;
      c.beginPath();
      c.arc(gx, gy, 7.5, 0, Math.PI * 2);
      c.fill();

      // 指の間からこぼれ落ちる個別の金貨と宝石
      const handCoins = [[-5, -4, 3.0, '#fde047'], [4, -4, 2.8, '#facc15'], [5, 3, 2.7, '#fde047'], [-3, 5, 2.4, '#ef4444']];
      for (const [ox, oy, cr, col] of handCoins) {
        c.fillStyle = col;
        c.strokeStyle = '#713f12';
        c.lineWidth = 0.8;
        c.beginPath();
        c.ellipse(gx + ox, gy + oy, cr, cr * 0.72, 0.3, 0, Math.PI * 2);
        c.fill();
        c.stroke();
      }
    }, 0.42, {
      isDiver: true,
      pivotX: x + 44,
      pivotY: y + 24,
      isUnderwater: true,
      footOffsetY: 20,
      drawGroundShadow: false
    });

    // 腕セグメント2：宝箱から引き上げ、左手で広げた布袋の口へ金貨を流し込む！
    this._drawSegment(ctx, reach2Lit, (c) => {
      c.lineWidth = 7.5;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x + 10, y + 18);
      c.lineTo(x + 32, y + 2);
      c.stroke();
      c.beginPath();
      c.arc(x + 36, y - 2, 7.5, 0, Math.PI * 2);
      c.fill();
    }, (c) => {
      // GAME C 専用：1. 元のLCDセグメント位置の引き上げ腕（山盛りの金貨を抱えて運ぶ）
      const lt = this._getDiverLighting(x + 24, y + 8);
      const armGrad2 = c.createLinearGradient(x + 10, y + 18, x + 36, y - 2);
      armGrad2.addColorStop(0, lt.suitMid);
      armGrad2.addColorStop(1, lt.suitLit);
      c.strokeStyle = armGrad2;
      c.lineWidth = 7.5;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x + 10, y + 18);
      c.lineTo(x + 32, y + 2);
      c.stroke();

      const gx = x + 36, gy = y - 2;
      const goldGrad = c.createRadialGradient(gx - 2, gy - 2, 1, gx, gy, 8);
      goldGrad.addColorStop(0, '#fef9c3');
      goldGrad.addColorStop(0.55, '#facc15');
      goldGrad.addColorStop(1, '#a16207');
      c.fillStyle = goldGrad;
      c.beginPath();
      c.arc(gx, gy, 7.5, 0, Math.PI * 2);
      c.fill();

      // 2. 手から左手の布袋の大きく開いた口(x - 26, y + 16)へザクザク流し込まれる金貨の軌跡ストリーム
      const bagMouthX = x - 26;
      const bagMouthY = y + 16;
      for (let i = 0; i < 6; i++) {
        const u = (i + ((this.bioTime * 14) % 1)) / 6;
        const cx = (1 - u) * (1 - u) * gx + 2 * (1 - u) * u * (x + 2) + u * u * bagMouthX;
        const cy = (1 - u) * (1 - u) * gy + 2 * (1 - u) * u * (y - 16) + u * u * bagMouthY;
        c.save();
        c.translate(cx, cy);
        c.rotate(u * 4.5 + i);
        c.fillStyle = (i === 2) ? '#ef4444' : (i === 4 ? '#10b981' : '#fde047');
        c.strokeStyle = '#854d0e';
        c.lineWidth = 0.8;
        c.beginPath();
        c.ellipse(0, 0, 3.4, 2.2, 0, 0, Math.PI * 2);
        c.fill();
        c.stroke();
        c.restore();
      }
    }, 0.42, {
      isDiver: true,
      pivotX: x + 24,
      pivotY: y + 8,
      isUnderwater: true,
      footOffsetY: 20,
      drawGroundShadow: false
    });

    // GAME C 専用：宝箱からダイバーの手を経て左手の布袋の口へ吸い込まれ、布袋の底に溜まっていく連続金貨・金塊・宝石パーティクル描画
    if (this._isRealColor() && this.goldCoinsInFlight && this.goldCoinsInFlight.length > 0) {
      ctx.save();
      for (const gc of this.goldCoinsInFlight) {
        if (gc.t < 0) continue;
        const u = Math.min(1, gc.t / gc.duration);
        const px = (1 - u) * (1 - u) * gc.startX + 2 * (1 - u) * u * gc.ctrlX + u * u * gc.endX;
        const py = (1 - u) * (1 - u) * gc.startY + 2 * (1 - u) * u * gc.ctrlY + u * u * gc.endY;

        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(gc.rot);

        if (gc.kind === 'ingot') {
          // 黄金の延べ棒（インゴット）
          ctx.fillStyle = '#facc15';
          ctx.strokeStyle = '#854d0e';
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          ctx.roundRect(-gc.r, -gc.r * 0.55, gc.r * 2, gc.r * 1.1, 1.2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = '#fef9c3';
          ctx.fillRect(-gc.r * 0.65, -gc.r * 0.3, gc.r * 1.3, gc.r * 0.35);
        } else if (gc.kind === 'ruby' || gc.kind === 'emerald') {
          // 輝く宝石（ルビー・エメラルド）
          ctx.fillStyle = gc.kind === 'ruby' ? '#f43f5e' : '#10b981';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 0.7;
          ctx.beginPath();
          ctx.moveTo(0, -gc.r);
          ctx.lineTo(gc.r * 0.85, 0);
          ctx.lineTo(0, gc.r);
          ctx.lineTo(-gc.r * 0.85, 0);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        } else {
          // 回転しながら布袋へ吸い込まれる金貨
          const coinSquash = Math.max(0.32, Math.abs(Math.cos(gc.rot * 1.5)));
          const cg = ctx.createRadialGradient(-1, -1, 0.5, 0, 0, gc.r);
          cg.addColorStop(0, '#ffffff');
          cg.addColorStop(0.4, '#fde047');
          cg.addColorStop(1, '#ca8a04');
          ctx.fillStyle = cg;
          ctx.strokeStyle = '#713f12';
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.ellipse(0, 0, gc.r, gc.r * coinSquash, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.restore();
      }
      ctx.restore();
    }
  }

  _drawGiantSquidBody(ctx) {
    // 巨大イカ（ダイオウイカ）の頭部・外套膜・三角エンペラ（常時点灯セグメント）
    const squidLit = true;
    const eyeShift = (this.tickCount % 2 === 0) ? -3 : 3;
    const avgFlush = this._getSquidFlushLevel(585, 155);
    const squidShadowAlpha = 0.08 + avgFlush * 0.28;

    this._drawSegment(ctx, squidLit, (c) => {
      c.save();
      // 1. イカ特有の三角形の大きなエンペラ（耳ヒレ）と槍型の外套膜（右上〜中央上）
      c.beginPath();
      c.moveTo(648, 92);   // 外套膜の先端（右上）
      c.lineTo(696, 152);  // 右エンペラ頂点
      c.lineTo(652, 168);  // 右エンペラ付け根
      c.quadraticCurveTo(628, 212, 598, 226); // 胴体右側
      c.lineTo(492, 206);  // 胴体下部（目の下）
      c.quadraticCurveTo(516, 168, 554, 138); // 胴体左側
      c.lineTo(528, 106);  // 左エンペラ頂点
      c.closePath();
      c.fill();

      // 外套膜の立体スリット抜き（LCDらしさを高める白抜きライン）
      c.save();
      c.globalCompositeOperation = 'destination-out';
      c.lineWidth = 4;
      c.beginPath();
      c.moveTo(638, 114);
      c.lineTo(568, 165);
      c.stroke();

      // 2. 巨大イカの鋭い両目（白抜き＋瞳）
      c.beginPath();
      c.ellipse(528, 188, 16, 13, -0.2, 0, Math.PI * 2);
      c.ellipse(574, 198, 16, 13, 0.15, 0, Math.PI * 2);
      c.fill();
      c.restore();

      // 目の瞳孔（ティックに合わせてギョロッと動く）
      c.beginPath();
      c.arc(526 + eyeShift, 190, 7.5, 0, Math.PI * 2);
      c.arc(572 + eyeShift, 200, 7.5, 0, Math.PI * 2);
      c.fill();

      // 漏斗（イカの墨吐き管）
      c.beginPath();
      c.roundRect(604, 216, 22, 14, 5);
      c.fill();
      c.restore();
    }, (c) => {
      // GAME C: まったく同じ形・座標で「本物の生きたイカの如き超リアルな透明状態」から
      // 「色素胞（クロマトフォア）が一気に集約・拡張して赤茶色の細かなマダラ模様になる」異常なまでの生物学的演出
      c.save();

      // --- 1. 漏斗（イカの呼吸・墨吐き管）の半透明軟骨〜赤茶色素胞表現 ---
      c.save();
      c.beginPath();
      c.roundRect(604, 216, 22, 14, 5);
      c.clip();
      const siphonFlush = this._getSquidFlushLevel(615, 223);
      const siphonGrad = c.createLinearGradient(604, 216, 626, 230);
      siphonGrad.addColorStop(0, `rgba(236, 246, 255, ${(0.34 + siphonFlush * 0.25).toFixed(3)})`);
      siphonGrad.addColorStop(0.55, `rgba(${Math.round(185 - siphonFlush * 35)}, ${Math.round(160 - siphonFlush * 115)}, ${Math.round(155 - siphonFlush * 125)}, ${(0.38 + siphonFlush * 0.48).toFixed(3)})`);
      siphonGrad.addColorStop(1, `rgba(92, 22, 12, ${(0.28 + siphonFlush * 0.62).toFixed(3)})`);
      c.fillStyle = siphonGrad;
      c.fillRect(602, 214, 26, 18);
      c.restore();

      // --- 2. 外套膜＆エンペラ（厳密に元のポリゴン形状でクリップ） ---
      c.save();
      c.beginPath();
      c.moveTo(648, 92);
      c.lineTo(696, 152);
      c.lineTo(652, 168);
      c.quadraticCurveTo(628, 212, 598, 226);
      c.lineTo(492, 206);
      c.quadraticCurveTo(516, 168, 554, 138);
      c.lineTo(528, 106);
      c.closePath();
      c.clip();

      // (A) 活イカのガラス質・半透明オパール外皮ベース（透明時は背景の海や沈没船がうっすら透ける）
      const mantleBaseGrad = c.createLinearGradient(656, 94, 512, 218);
      const baseAlphaTop = 0.28 + avgFlush * 0.56;
      const baseAlphaMid = 0.34 + avgFlush * 0.52;
      const baseAlphaBot = 0.38 + avgFlush * 0.46;
      mantleBaseGrad.addColorStop(0, `rgba(${Math.round(195 - avgFlush * 95)}, ${Math.round(225 - avgFlush * 195)}, ${Math.round(238 - avgFlush * 218)}, ${baseAlphaTop.toFixed(3)})`);
      mantleBaseGrad.addColorStop(0.45, `rgba(${Math.round(220 - avgFlush * 68)}, ${Math.round(232 - avgFlush * 185)}, ${Math.round(240 - avgFlush * 208)}, ${baseAlphaMid.toFixed(3)})`);
      mantleBaseGrad.addColorStop(1, `rgba(${Math.round(238 - avgFlush * 42)}, ${Math.round(242 - avgFlush * 128)}, ${Math.round(246 - avgFlush * 148)}, ${baseAlphaBot.toFixed(3)})`);
      c.fillStyle = mantleBaseGrad;
      c.fillRect(488, 88, 214, 144);

      // (B) 透明時に外套膜の奥に透けて見える「内臓（中腸腺・肝臓の淡い琥珀サーモン色）」「銀黒色の墨袋」「軟甲（ガラス質の背骨筋）」
      const organVis = Math.max(0.12, 1.0 - avgFlush * 0.72);
      const liverGrad = c.createRadialGradient(596, 156, 4, 592, 160, 44);
      liverGrad.addColorStop(0, `rgba(234, 138, 102, ${(0.48 * organVis).toFixed(3)})`);
      liverGrad.addColorStop(0.55, `rgba(194, 92, 68, ${(0.32 * organVis).toFixed(3)})`);
      liverGrad.addColorStop(1, 'rgba(180, 80, 60, 0)');
      c.fillStyle = liverGrad;
      c.beginPath();
      c.ellipse(592, 160, 42, 18, -0.62, 0, Math.PI * 2);
      c.fill();

      // 奥に透ける銀黒色の墨袋（インクサック）
      c.fillStyle = `rgba(30, 41, 59, ${(0.42 * organVis).toFixed(3)})`;
      c.beginPath();
      c.ellipse(582, 174, 16, 6.5, -0.58, 0, Math.PI * 2);
      c.fill();

      // (C) 虹色色素胞（イリドフォア：活イカ特有の青緑〜エメラルドの構造色ラメの輝き）
      const iridShift = Math.sin(this.bioTime * 3.8) * 0.5 + 0.5;
      c.strokeStyle = `rgba(52, 211, 153, ${(0.22 + iridShift * 0.24).toFixed(3)})`;
      c.lineWidth = 5.5;
      c.beginPath();
      c.moveTo(646, 98);
      c.lineTo(688, 150);
      c.moveTo(644, 98);
      c.lineTo(534, 108);
      c.moveTo(552, 142);
      c.quadraticCurveTo(526, 168, 502, 198);
      c.stroke();

      c.strokeStyle = `rgba(56, 189, 248, ${(0.20 + (1 - iridShift) * 0.22).toFixed(3)})`;
      c.lineWidth = 2.6;
      c.stroke();

      // (D) 赤茶色の細かなマダラ模様を作る「色素胞（クロマトフォア）185個」のリアルタイム収縮・拡張アニメーション
      // 各セルが局所の神経波によって極小点(0.5px)から赤茶色・焦茶色・琥珀色のマダラ斑(最大6px)へうねるように集約・拡散する
      const tierColors = [
        [58, 14, 7],    // Tier 0: 濃暗セピア・黒赤褐色
        [128, 29, 16],  // Tier 1: スルメイカ特有の赤茶色（主マダラ色）
        [166, 44, 22],  // Tier 2: 鮮やかな赤褐色
        [196, 92, 24]   // Tier 3: 黄褐色・琥珀色素胞
      ];

      for (let i = 0; i < this.mantleChromatophores.length; i++) {
        const ch = this.mantleChromatophores[i];
        const localFlush = this._getSquidFlushLevel(ch.x, ch.y);
        // 個々の色素胞の微小な筋収縮震え（脈動）
        const microPulse = Math.sin(this.bioTime * 9.5 + ch.phase) * 0.08;
        // マダラ斑の中心部から優先的に色素が集約して赤茶色の斑紋が浮かび上がる
        const activation = Math.max(0, Math.min(1, (localFlush * (0.55 + ch.mottle * 0.72)) + microPulse));

        const curR = ch.baseR + (ch.maxR - ch.baseR) * Math.pow(activation, 1.35);
        const rgb = tierColors[ch.tier];
        const alpha = 0.42 + activation * 0.52;

        // 拡張した色素胞の周囲に滲む赤茶色のサブサーフェスハロー（隣り合う色素胞と融合してリアルなマダラ模様を形成）
        if (activation > 0.32 && curR > 1.8) {
          c.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${(activation * 0.28).toFixed(3)})`;
          c.beginPath();
          c.ellipse(ch.x, ch.y, curR * 1.55, curR * 1.55 * ch.aspect, ch.angle, 0, Math.PI * 2);
          c.fill();
        }

        // 色素胞セル本体
        c.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(3)})`;
        c.beginPath();
        c.ellipse(ch.x, ch.y, curR, curR * ch.aspect, ch.angle, 0, Math.PI * 2);
        c.fill();
      }

      // (E) 外套膜正中線の軟甲ハイライト＆表皮の濡れた粘液グロス（同じスリット座標 (638,114)->(568,165)）
      c.strokeStyle = 'rgba(255, 250, 245, 0.68)';
      c.lineWidth = 4;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(638, 114);
      c.lineTo(568, 165);
      c.stroke();

      // 外套膜輪郭の半透明ゼラチン質リム光沢
      c.strokeStyle = `rgba(224, 242, 254, ${(0.48 - avgFlush * 0.22).toFixed(3)})`;
      c.lineWidth = 2.2;
      c.beginPath();
      c.moveTo(648, 92);
      c.lineTo(696, 152);
      c.lineTo(652, 168);
      c.quadraticCurveTo(628, 212, 598, 226);
      c.lineTo(492, 206);
      c.quadraticCurveTo(516, 168, 554, 138);
      c.lineTo(528, 106);
      c.closePath();
      c.stroke();

      c.restore();

      // --- 3. 巨大イカの生々しい眼球（エメラルド銀色の虹彩膜・赤茶の色素縁・漆黒の水晶体） ---
      const drawRealEye = (ex, ey, rot) => {
        const eyeGrad = c.createRadialGradient(ex - 2, ey - 2, 2, ex, ey, 16);
        eyeGrad.addColorStop(0, '#fefce8');
        eyeGrad.addColorStop(0.48, '#fde047');
        eyeGrad.addColorStop(0.76, '#5eead4');
        eyeGrad.addColorStop(0.90, '#64748b');
        eyeGrad.addColorStop(1, '#581c1c');
        c.fillStyle = eyeGrad;
        c.beginPath();
        c.ellipse(ex, ey, 16, 13, rot, 0, Math.PI * 2);
        c.fill();
      };
      drawRealEye(528, 188, -0.2);
      drawRealEye(574, 198, 0.15);

      // 漆黒の濡れた瞳孔（同じ座標・同じ半径 7.5）
      c.fillStyle = '#09090b';
      c.beginPath();
      c.arc(526 + eyeShift, 190, 7.5, 0, Math.PI * 2);
      c.arc(572 + eyeShift, 200, 7.5, 0, Math.PI * 2);
      c.fill();

      // 瞳孔内の濡れた角膜キャッチライト
      c.fillStyle = 'rgba(255, 255, 255, 0.92)';
      c.beginPath();
      c.arc(523.5 + eyeShift, 187, 2.3, 0, Math.PI * 2);
      c.arc(569.5 + eyeShift, 197, 2.3, 0, Math.PI * 2);
      c.fill();

      c.restore();
    }, squidShadowAlpha);
  }

  _drawSquidTentacles(ctx) {
    // 4本の触腕それぞれのセグメント座標定義
    // 根本（胴体側）を太く（w1: 32〜36px）、先端に向かって細く（w2: 4.5px）テーパーさせ、片側に吸盤（◎）を並べる
    const paths = [
      // 足0 (左端: 4セグメント -> pos 2 [x:194, y:294] を襲う)
      [
        { x1: 498, y1: 196, x2: 422, y2: 214, w1: 32, w2: 24, curve: -8, suckerDir: 1 },
        { x1: 420, y1: 215, x2: 340, y2: 238, w1: 24, w2: 17, curve: 7, suckerDir: 1 },
        { x1: 338, y1: 239, x2: 266, y2: 268, w1: 17, w2: 11, curve: -6, suckerDir: 1 },
        { x1: 264, y1: 269, x2: 208, y2: 292, w1: 11, w2: 4.5, curve: 6, suckerDir: 1, isTip: true }
      ],
      // 足1 (中左: 5セグメント -> pos 3 [x:304, y:344] を襲う)
      [
        { x1: 526, y1: 208, x2: 472, y2: 236, w1: 34, w2: 26, curve: -7, suckerDir: 1 },
        { x1: 470, y1: 237, x2: 420, y2: 266, w1: 26, w2: 19.5, curve: 6, suckerDir: 1 },
        { x1: 418, y1: 268, x2: 374, y2: 296, w1: 19.5, w2: 14, curve: -6, suckerDir: 1 },
        { x1: 372, y1: 298, x2: 338, y2: 324, w1: 14, w2: 9.5, curve: 5, suckerDir: 1 },
        { x1: 336, y1: 326, x2: 310, y2: 344, w1: 9.5, w2: 4.2, curve: -5, suckerDir: 1, isTip: true }
      ],
      // 足2 (中右: 4セグメント -> pos 4 [x:420, y:362] を襲う)
      [
        { x1: 558, y1: 216, x2: 522, y2: 254, w1: 32, w2: 23.5, curve: -6, suckerDir: 1 },
        { x1: 520, y1: 256, x2: 484, y2: 296, w1: 23.5, w2: 16.5, curve: 6, suckerDir: 1 },
        { x1: 482, y1: 298, x2: 452, y2: 332, w1: 16.5, w2: 11, curve: -5, suckerDir: 1 },
        { x1: 450, y1: 334, x2: 428, y2: 358, w1: 11, w2: 4.5, curve: 5, suckerDir: 1, isTip: true }
      ],
      // 足3 (右端/宝箱前: 3セグメント -> pos 5 [x:534, y:368] を襲う)
      [
        { x1: 592, y1: 220, x2: 580, y2: 270, w1: 31, w2: 21, curve: 7, suckerDir: -1 },
        { x1: 579, y1: 272, x2: 564, y2: 322, w1: 21, w2: 13, curve: -6, suckerDir: -1 },
        { x1: 563, y1: 324, x2: 546, y2: 362, w1: 13, w2: 4.5, curve: 6, suckerDir: -1, isTip: true }
      ]
    ];

    for (let tIdx = 0; tIdx < 4; tIdx++) {
      const t = this.tentacles[tIdx];
      const segs = paths[tIdx];

      for (let sIdx = 0; sIdx < segs.length; sIdx++) {
        const seg = segs[sIdx];
        const isLit = t.len > sIdx;
        const segFlush = this._getSquidFlushLevel((seg.x1 + seg.x2) * 0.5, (seg.y1 + seg.y2) * 0.5);
        const segShadow = 0.08 + segFlush * 0.28;

        this._drawSegment(ctx, isLit, (c) => {
          this._drawTaperedTentacleSegment(c, seg, false, tIdx, sIdx);
        }, (c) => {
          this._drawTaperedTentacleSegment(c, seg, true, tIdx, sIdx);
        }, segShadow);
      }
    }
  }

  // 根本が太く先端が細いイカの足セグメント＋リアルな輪っか状の吸盤（◎）を描画
  _drawTaperedTentacleSegment(c, seg, isRealColor = false, tIdx = 0, sIdx = 0) {
    const { x1, y1, x2, y2, w1, w2, curve = 0, suckerDir = 1, isTip = false } = seg;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    // ベジェ制御点
    const cx = (x1 + x2) * 0.5 + nx * curve;
    const cy = (y1 + y2) * 0.5 + ny * curve;

    const steps = 10;
    const upperPts = [];
    const lowerPts = [];
    const spinePts = [];

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const inv = 1 - t;
      // 2次ベジェ曲線上の座標
      const px = inv * inv * x1 + 2 * inv * t * cx + t * t * x2;
      const py = inv * inv * y1 + 2 * inv * t * cy + t * t * y2;

      // 接線ベクトルと法線ベクトル
      const tx = 2 * inv * (cx - x1) + 2 * t * (x2 - cx);
      const ty = 2 * inv * (cy - y1) + 2 * t * (y2 - cy);
      const tLen = Math.hypot(tx, ty) || 1;
      const pnx = -ty / tLen;
      const pny = tx / tLen;

      // 根本(w1)から先端(w2)への滑らかなテーパー半径
      const r = (w1 * (1 - t) + w2 * t) * 0.5;

      spinePts.push({ px, py, pnx, pny, r, tx: tx / tLen, ty: ty / tLen });
      upperPts.push([px + pnx * r, py + pny * r]);
      lowerPts.push([px - pnx * r, py - pny * r]);
    }

    const midSp = spinePts[5];
    const segFlush = isRealColor ? this._getSquidFlushLevel(midSp.px, midSp.py) : 0;

    // 1. テーパーのかかった触腕本体ポリゴンパスを構築
    c.beginPath();
    c.moveTo(upperPts[0][0], upperPts[0][1]);
    for (let i = 1; i <= steps; i++) {
      c.lineTo(upperPts[i][0], upperPts[i][1]);
    }
    const endSp = spinePts[steps];
    c.arc(endSp.px, endSp.py, Math.max(2, w2 * 0.5), Math.atan2(endSp.pny, endSp.pnx), Math.atan2(-endSp.pny, -endSp.pnx), false);
    for (let i = steps; i >= 0; i--) {
      c.lineTo(lowerPts[i][0], lowerPts[i][1]);
    }
    const startSp = spinePts[0];
    c.arc(startSp.px, startSp.py, w1 * 0.5, Math.atan2(-startSp.pny, -startSp.pnx), Math.atan2(startSp.pny, startSp.pnx), false);
    c.closePath();

    if (isRealColor) {
      // GAME C: 活イカの透き通った触腕筋肉（内部の白い神経索が透ける）〜赤茶色マダラ模様へのリアルタイム変化
      c.save();
      c.clip();

      const armGrad = c.createLinearGradient(
        midSp.px - midSp.pnx * suckerDir * (midSp.r + 4),
        midSp.py - midSp.pny * suckerDir * (midSp.r + 4),
        midSp.px + midSp.pnx * suckerDir * (midSp.r + 6),
        midSp.py + midSp.pny * suckerDir * (midSp.r + 6)
      );
      const dorsalAlpha = 0.30 + segFlush * 0.58;
      const ventralAlpha = 0.36 + segFlush * 0.46;
      armGrad.addColorStop(0, `rgba(${Math.round(185 - segFlush * 105)}, ${Math.round(220 - segFlush * 198)}, ${Math.round(235 - segFlush * 222)}, ${dorsalAlpha.toFixed(3)})`);
      armGrad.addColorStop(0.52, `rgba(${Math.round(215 - segFlush * 65)}, ${Math.round(232 - segFlush * 188)}, ${Math.round(240 - segFlush * 212)}, ${((dorsalAlpha + ventralAlpha) * 0.5).toFixed(3)})`);
      armGrad.addColorStop(1, `rgba(248, ${Math.round(242 - segFlush * 32)}, ${Math.round(240 - segFlush * 40)}, ${ventralAlpha.toFixed(3)})`);
      c.fillStyle = armGrad;
      c.fill();

      // 透明時に触腕の中心を貫いて透けて見える「白い軸索（メイン神経・血管ライン）」
      c.strokeStyle = `rgba(248, 250, 252, ${(0.45 * (1 - segFlush * 0.6)).toFixed(3)})`;
      c.lineWidth = Math.max(1.5, midSp.r * 0.32);
      c.beginPath();
      c.moveTo(x1, y1);
      c.quadraticCurveTo(cx, cy, x2, y2);
      c.stroke();

      // 触腕表面の色素胞（クロマトフォア）群：収縮時の微細点から赤茶色のマダラ模様へ集約
      const tierColors = [
        [58, 14, 7],
        [128, 29, 16],
        [166, 44, 22],
        [196, 92, 24]
      ];
      const phaseSeed = tIdx * 2.1 + sIdx * 1.3;
      for (let i = 0; i < this.tentacleChromatophores.length; i++) {
        const tc = this.tentacleChromatophores[i];
        const spIdx = Math.min(steps, Math.max(0, Math.round(tc.u * steps)));
        const sp = spinePts[spIdx];
        // 吸盤の反対側（背側〜側面）を中心に赤茶色マダラ模様が濃く集まる本物のイカの配色
        const sideWeight = 1.0 - Math.max(0, tc.v * suckerDir * 0.55);
        const cxPos = sp.px + sp.pnx * tc.v * sp.r;
        const cyPos = sp.py + sp.pny * tc.v * sp.r;
        const locFlush = this._getSquidFlushLevel(cxPos, cyPos);
        const act = Math.max(0, Math.min(1, locFlush * (0.5 + tc.mottle * 0.7) * sideWeight + Math.sin(this.bioTime * 9 + tc.phase + phaseSeed) * 0.08));
        const rad = (tc.baseR + (tc.maxR - tc.baseR) * Math.pow(act, 1.3)) * Math.max(0.45, sp.r / 12);
        const rgb = tierColors[tc.tier];

        if (act > 0.3 && rad > 1.2) {
          c.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${(act * 0.26).toFixed(3)})`;
          c.beginPath();
          c.arc(cxPos, cyPos, rad * 1.5, 0, Math.PI * 2);
          c.fill();
        }
        c.fillStyle = `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${(0.40 + act * 0.52).toFixed(3)})`;
        c.beginPath();
        c.arc(cxPos, cyPos, rad, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();

      // 半透明ゼラチン質の輪郭ハイライト
      c.strokeStyle = `rgba(224, 242, 254, ${(0.40 - segFlush * 0.18).toFixed(3)})`;
      c.lineWidth = 1.2;
      c.stroke();
    } else {
      c.fill();
    }

    // 2. 触腕の縁に沿って並ぶ「吸盤（カップ＋中央穴 ◎）」を3個ずつ描画
    const suckerSteps = [2, 5, 8];
    const holeCenters = [];

    for (const idx of suckerSteps) {
      const sp = spinePts[idx];
      const sRadius = Math.max(3.2, sp.r * 0.44 + 1.4);
      const offsetDist = sp.r + sRadius * 0.62;
      const sx = sp.px + sp.pnx * suckerDir * offsetDist;
      const sy = sp.py + sp.pny * suckerDir * offsetDist;

      if (isRealColor) {
        const cupGrad = c.createRadialGradient(sx - 1, sy - 1, 0.5, sx, sy, sRadius);
        cupGrad.addColorStop(0, 'rgba(255, 250, 245, 0.92)');
        cupGrad.addColorStop(0.62, 'rgba(245, 222, 212, 0.85)');
        cupGrad.addColorStop(1, `rgba(148, 52, 36, ${(0.55 + segFlush * 0.38).toFixed(3)})`);
        c.fillStyle = cupGrad;
      }

      // 吸盤の根元の短い柄と外輪カップ
      c.beginPath();
      c.arc(sx, sy, sRadius, 0, Math.PI * 2);
      c.fill();

      if (sRadius >= 3.6) {
        holeCenters.push({ sx, sy, hr: sRadius * 0.44 });
      }
    }

    // 吸盤の中央のくぼみ（LCD時は白抜きリング、GAME C時はキチン質の角質環と暗赤色の吸盤腔）
    if (holeCenters.length > 0) {
      if (isRealColor) {
        c.fillStyle = '#3b0d06';
        c.strokeStyle = 'rgba(253, 224, 71, 0.65)';
        c.lineWidth = 0.9;
        c.beginPath();
        for (const h of holeCenters) {
          c.moveTo(h.sx + h.hr, h.sy);
          c.arc(h.sx, h.sy, h.hr, 0, Math.PI * 2);
        }
        c.fill();
        c.stroke();
      } else {
        c.save();
        c.globalCompositeOperation = 'destination-out';
        c.beginPath();
        for (const h of holeCenters) {
          c.moveTo(h.sx + h.hr, h.sy);
          c.arc(h.sx, h.sy, h.hr, 0, Math.PI * 2);
        }
        c.fill();
        c.restore();
      }
    }

    // 3. 先端セグメント（isTip）は細くカールした触腕フックを描く
    if (isTip) {
      if (isRealColor) {
        c.strokeStyle = `rgba(${Math.round(210 - segFlush * 65)}, ${Math.round(190 - segFlush * 145)}, ${Math.round(195 - segFlush * 165)}, ${(0.55 + segFlush * 0.4).toFixed(3)})`;
      }
      c.lineWidth = Math.max(3.5, w2 * 0.85);
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x2, y2);
      c.quadraticCurveTo(x2 - 12, y2 - 4, x2 - 17, y2 - 11);
      c.moveTo(x2, y2);
      c.quadraticCurveTo(x2 - 8, y2 + 9, x2 - 14, y2 + 14);
      c.stroke();
    }
  }

  _drawCaughtFlailingDiver(ctx) {
    // 捕まった時に中央上空（イカの懐）で手足をバタバタさせる有名な液晶セグメント
    const isCaught = this.state === 'CAUGHT';
    const frameA = isCaught && (this.caughtFlailTicks % 2 === 1);
    const frameB = isCaught && (this.caughtFlailTicks % 2 === 0);

    const cx = 376, cy = 176;
    const lt = this._isRealColor() ? this._getDiverLighting(cx, cy) : null;

    // 捕獲用の巻き付き触腕＋ダイバーの頭と胴体
    this._drawSegment(ctx, isCaught, (c) => {
      // イカから伸びてダイバーの胴体に巻き付く太い触腕
      c.lineWidth = 12;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(492, 186);
      c.quadraticCurveTo(435, 168, cx + 10, cy + 18);
      c.stroke();

      // ダイバー頭部
      c.beginPath();
      c.arc(cx, cy, 13, 0, Math.PI * 2);
      c.fill();
      c.save();
      c.globalCompositeOperation = 'destination-out';
      c.beginPath();
      c.arc(cx - 2, cy - 1, 5.5, 0, Math.PI * 2);
      c.fill();
      c.restore();

      // 横向きにもがく胴体
      c.beginPath();
      c.roundRect(cx - 12, cy + 12, 24, 26, 6);
      c.fill();
    }, (c) => {
      // イカの巻き付き触腕
      c.strokeStyle = '#9f1239';
      c.lineWidth = 12;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(492, 186);
      c.quadraticCurveTo(435, 168, cx + 10, cy + 18);
      c.stroke();

      // 胴体（時間帯・天候の光で照らされる潜水服）
      const suitGrad = c.createLinearGradient(
        cx - lt.nx * 12, cy + 25 - lt.ny * 13,
        cx + lt.nx * 12, cy + 25 + lt.ny * 13
      );
      suitGrad.addColorStop(0, lt.suitLit);
      suitGrad.addColorStop(0.5, lt.suitMid);
      suitGrad.addColorStop(1, lt.suitDeep);
      c.fillStyle = suitGrad;
      c.beginPath();
      c.roundRect(cx - 12, cy + 12, 24, 26, 6);
      c.fill();

      // 頭部ヘルメット（光源方向にハイライトが映る銅ヘルメット）
      const helmGrad = c.createRadialGradient(
        cx - lt.nx * 5.2, cy - lt.ny * 5.2, 1.8,
        cx, cy, 13
      );
      helmGrad.addColorStop(0, lt.helmSpec);
      helmGrad.addColorStop(0.38, lt.helmMid);
      helmGrad.addColorStop(0.78, lt.helmDark);
      helmGrad.addColorStop(1, lt.helmDeep);
      c.fillStyle = helmGrad;
      c.beginPath();
      c.arc(cx, cy, 13, 0, Math.PI * 2);
      c.fill();

      // 覗き窓
      const visorGrad = c.createRadialGradient(cx - 2 - lt.nx * 2, cy - 1 - lt.ny * 2, 0.8, cx - 2, cy - 1, 5.5);
      visorGrad.addColorStop(0, lt.visorSpec);
      visorGrad.addColorStop(0.55, lt.visorMid);
      visorGrad.addColorStop(1, lt.visorDeep);
      c.fillStyle = visorGrad;
      c.beginPath();
      c.arc(cx - 2, cy - 1, 5.5, 0, Math.PI * 2);
      c.fill();

      // 光源側のリムハイライト＆水中コースティクス
      this._drawDiverDirectionalRimAndCaustics(c, cx, cy, 13, 24, 26, lt, true);
    }, 0.45, {
      isDiver: true,
      pivotX: cx,
      pivotY: cy,
      isUnderwater: true,
      footOffsetY: 52,
      drawGroundShadow: false
    });

    const drawFlailLimbsA = (c) => {
      c.lineWidth = 6.5;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(cx - 10, cy + 16);
      c.lineTo(cx - 32, cy - 2);
      c.moveTo(cx + 10, cy + 20);
      c.lineTo(cx + 32, cy + 32);
      c.moveTo(cx - 8, cy + 36);
      c.lineTo(cx - 24, cy + 58);
      c.moveTo(cx + 8, cy + 36);
      c.lineTo(cx + 28, cy + 44);
      c.stroke();
    };

    const drawFlailLimbsB = (c) => {
      c.lineWidth = 6.5;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(cx - 10, cy + 20);
      c.lineTo(cx - 32, cy + 32);
      c.moveTo(cx + 10, cy + 16);
      c.lineTo(cx + 32, cy - 4);
      c.moveTo(cx - 8, cy + 36);
      c.lineTo(cx - 28, cy + 44);
      c.moveTo(cx + 8, cy + 36);
      c.lineTo(cx + 22, cy + 58);
      c.stroke();
    };

    // バタバタ手足フレームA（左腕上げ・右足上げ）
    this._drawSegment(ctx, frameA, drawFlailLimbsA, (c) => {
      c.strokeStyle = lt ? lt.suitMid : '#9c8b67';
      drawFlailLimbsA(c);
    }, 0.42, {
      isDiver: true,
      pivotX: cx,
      pivotY: cy,
      isUnderwater: true,
      footOffsetY: 52,
      drawGroundShadow: false
    });

    // バタバタ手足フレームB（右腕上げ・左足上げ）
    this._drawSegment(ctx, frameB, drawFlailLimbsB, (c) => {
      c.strokeStyle = lt ? lt.suitMid : '#9c8b67';
      drawFlailLimbsB(c);
    }, 0.42, {
      isDiver: true,
      pivotX: cx,
      pivotY: cy,
      isUnderwater: true,
      footOffsetY: 52,
      drawGroundShadow: false
    });
  }

  /* --------------------------------------------------------------------------
     7-Segment Digital Display & LCD Status Text
     -------------------------------------------------------------------------- */
  _drawTopRightHudSegments(ctx) {
    // モード表示 (GAME A / GAME B / GAME C / TIME / BONUS)
    this._drawLcdLabel(ctx, 324, 26, 'GAME A', this.state !== 'TIME' && this.gameMode === 'A', 12.5);
    this._drawLcdLabel(ctx, 324, 44, 'GAME B', this.state !== 'TIME' && this.gameMode === 'B', 12.5);
    this._drawLcdLabel(ctx, 324, 62, 'GAME C', this.state !== 'TIME' && this.gameMode === 'C', 12.5);
    this._drawLcdLabel(ctx, 412, 32, 'TIME', this.state === 'TIME');
    this._drawLcdLabel(ctx, 412, 54, 'BONUS', this.bonusTimer > 0 || this.state === 'UNLOADING');

    // GAME OVER セグメント（画面中央上）
    this._drawLcdLabel(ctx, 290, 118, 'GAME OVER', this.state === 'GAMEOVER', 22);

    // 4桁の7セグメントデジタル表示
    let digits = [' ', ' ', ' ', '0'];
    let colonLit = false;

    if (this.state === 'TIME') {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, ' ');
      const mm = String(now.getMinutes()).padStart(2, '0');
      digits = [hh[0], hh[1], mm[0], mm[1]];
      colonLit = now.getSeconds() % 2 === 0;
    } else {
      const s = String(Math.min(9999, this.score)).padStart(4, ' ');
      digits = [s[0], s[1], s[2], s[3]];
    }

    const startX = 508;
    const startY = 20;
    const spacing = 46;

    for (let i = 0; i < 4; i++) {
      const dx = startX + i * spacing + (i >= 2 ? 10 : 0);
      this._drawSevenSegmentDigit(ctx, dx, startY, digits[i]);
    }

    // 時計コロン（:）セグメント
    this._drawSegment(ctx, colonLit, (c) => {
      c.beginPath();
      c.arc(startX + spacing * 2 + 1, startY + 18, 3.2, 0, Math.PI * 2);
      c.arc(startX + spacing * 2 - 1, startY + 38, 3.2, 0, Math.PI * 2);
      c.fill();
    }, null, 0.35, 'hud');
  }

  _drawLcdLabel(ctx, x, y, text, isLit, fontSize = 14) {
    this._drawSegment(ctx, isLit, (c) => {
      c.font = `900 ${fontSize}px "Arial Black", Impact, sans-serif`;
      c.letterSpacing = '1px';
      c.fillText(text, x, y);
    }, (c) => {
      c.font = `900 ${fontSize}px "Arial Black", Impact, sans-serif`;
      c.letterSpacing = '1px';
      c.fillStyle = '#fef08a';
      c.fillText(text, x, y);
    }, 0.35, 'hud');
  }

  _drawSevenSegmentDigit(ctx, x, y, char) {
    // 7セグメント定義: [top, topRight, botRight, bot, botLeft, topLeft, mid]
    const map = {
      '0': [1, 1, 1, 1, 1, 1, 0],
      '1': [0, 1, 1, 0, 0, 0, 0],
      '2': [1, 1, 0, 1, 1, 0, 1],
      '3': [1, 1, 1, 1, 0, 0, 1],
      '4': [0, 1, 1, 0, 0, 1, 1],
      '5': [1, 0, 1, 1, 0, 1, 1],
      '6': [1, 0, 1, 1, 1, 1, 1],
      '7': [1, 1, 1, 0, 0, 0, 0],
      '8': [1, 1, 1, 1, 1, 1, 1],
      '9': [1, 1, 1, 1, 0, 1, 1],
      ' ': [0, 0, 0, 0, 0, 0, 0]
    };
    const active = map[char] || map[' '];
    const w = 28, h = 52, t = 6.2;

    const segPolys = [
      // 0: top
      [[x + 3, y], [x + w - 3, y], [x + w - 7, y + t], [x + 7, y + t]],
      // 1: topRight
      [[x + w, y + 2], [x + w, y + h / 2 - 2], [x + w - t, y + h / 2 - 5], [x + w - t, y + 7]],
      // 2: botRight
      [[x + w, y + h / 2 + 2], [x + w, y + h - 2], [x + w - t, y + h - 7], [x + w - t, y + h / 2 + 5]],
      // 3: bot
      [[x + 7, y + h - t], [x + w - 7, y + h - t], [x + w - 3, y + h], [x + 3, y + h]],
      // 4: botLeft
      [[x, y + h / 2 + 2], [x + t, y + h / 2 + 5], [x + t, y + h - 7], [x, y + h - 2]],
      // 5: topLeft
      [[x, y + 2], [x + t, y + 7], [x + t, y + h / 2 - 5], [x, y + h / 2 - 2]],
      // 6: mid
      [[x + 4, y + h / 2], [x + 8, y + h / 2 - t / 2], [x + w - 8, y + h / 2 - t / 2], [x + w - 4, y + h / 2], [x + w - 8, y + h / 2 + t / 2], [x + 8, y + h / 2 + t / 2]]
    ];

    for (let s = 0; s < 7; s++) {
      const pts = segPolys[s];
      this._drawSegment(ctx, Boolean(active[s]), (c) => {
        c.beginPath();
        c.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) {
          c.lineTo(pts[i][0], pts[i][1]);
        }
        c.closePath();
        c.fill();
      }, null, 0.35, 'hud');
    }
  }

  /* --------------------------------------------------------------------------
     Main Animation Loop
     -------------------------------------------------------------------------- */
  _loop(ts) {
    const dt = Math.min(0.05, Math.max(0.001, (ts - this._lastTime) / 1000));
    this._lastTime = ts;

    this._update(dt);
    this._render();

    requestAnimationFrame(nextTs => this._loop(nextTs));
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.squidGame = new SquidGameWatch();
});
