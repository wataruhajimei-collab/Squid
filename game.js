'use strict';

/**
 * ============================================================================
 * SQUID (スクイッド) - Game & Watch Wide Screen (Model SQ-22)
 * Faithful tribute to 1981 Nintendo Game & Watch "Octopus" (OC-22)
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
   2. MAIN GAME ENGINE (SQUID - OC-22 Exact Mechanics + LCD Renderer)
   ============================================================================ */
class SquidGameWatch {
  constructor() {
    this.canvas = document.getElementById('lcdCanvas');
    this.ctx = this.canvas.getContext('2d');
    this.sound = new PiezoSoundEngine();

    // モード状態: 'TIME' (時計&デモ画面), 'PLAYING', 'CAUGHT' (捕まりバタバタ中), 'UNLOADING' (船上+3点演出中), 'BONUS' (200/500点復活演出), 'GAMEOVER'
    this.state = 'TIME';
    this.gameMode = 'A'; // 'A' or 'B'

    // スコア＆統計
    this.score = 0;
    this.bagsReturned = 0;
    this.treasuresGrabbed = 0;
    this.highScoreA = Number(localStorage.getItem(STORAGE_KEYS.HIGH_A) || 0);
    this.highScoreB = Number(localStorage.getItem(STORAGE_KEYS.HIGH_B) || 0);

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
    this._bindUI();
    this._initStartModal();
    this._updateProfilePill();
    this._detectPlayerLocation();
    this._resetDemoState();

    requestAnimationFrame(ts => this._loop(ts));
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

    // システムボタン (GAME A / GAME B / TIME)
    btnGameA?.addEventListener('click', () => this.startGame('A'));
    btnGameB?.addEventListener('click', () => this.startGame('B'));
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
        const gMode = entry.gameMode === 'B' ? 'B' : 'A';
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
    this.gameMode = mode === 'B' ? 'B' : 'A';
    this.state = 'PLAYING';
    this.score = 0;
    this.bagsReturned = 0;
    this.treasuresGrabbed = 0;
    this.lives = 3;
    this.bonus200Triggered = false;
    this.bonus500Triggered = false;

    this.diverPos = 0;
    this.hasBag = false;
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

    // 捕まり中・船上荷下ろし中・ボーナス演出中は入力を受け付けない（本家OC-22仕様）
    if (this.state !== 'PLAYING') return;

    if (navigator.vibrate) {
      try { navigator.vibrate(10); } catch (_) {}
    }

    if (dir === 'RIGHT') {
      if (this.diverPos < 5) {
        this.diverPos += 1;
        this.grabAnimPhase = 0;
        this.sound.step();
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
        this._checkCollisionImmediate();
      } else if (this.diverPos === 1) {
        // 本家オクトパス仕様：財宝袋(hasBag)を持っている時だけ船上(pos=0)へ上がって+3点ボーナス！
        if (this.hasBag) {
          this.diverPos = 0;
          this.state = 'UNLOADING';
          this.unloadTicksLeft = 3;
          this.unloadTimer = 0;
          this.bagsReturned += 1;
          this._setStatusText('🙌 生還成功！ +3 PTS BONUS!');
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
    this.hasBag = true;
    this.treasuresGrabbed += 1;
    this.grabAnimPhase = 1;
    this.grabAnimTimer = 0.22;
    this.sound.grabTreasure();
    this._addScore(1);
    this._setStatusText(`💰 財宝ゲット (+1点)！ 続けて取るか LEFT ◀ で船へ戻ろう！`);
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
    }

    // 200点・500点到達でミス帳消し（潜水夫が3人に完全復活する本家ボーナス仕様！）
    const crossed200 = !this.bonus200Triggered && prev < 200 && this.score >= 200;
    const crossed500 = !this.bonus500Triggered && prev < 500 && this.score >= 500;
    const crossed1000 = Math.floor(prev / 1000) < Math.floor(this.score / 1000);

    if (crossed200 || crossed500 || crossed1000) {
      if (crossed200) this.bonus200Triggered = true;
      if (crossed500) this.bonus500Triggered = true;
      this.lives = 3;
      this.bonusTimer = 2.0;
      this.sound.bonusLifeFanfare();
      this._setStatusText(`🎉 ${this.score >= 500 ? '500' : '200'} PTS BONUS! 潜水夫が全員復活 (3 LIVES)！`);
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
    if (navigator.vibrate) {
      try { navigator.vibrate([60, 40, 80]); } catch (_) {}
    }
    this.sound.caughtFlail(0);
    this._setStatusText('🦑 イカの足に捕まった！ MISS!');
  }

  /* --------------------------------------------------------------------------
     Main Update Loop (Authentic LCD Clock Tick & Tentacle Patterns)
     -------------------------------------------------------------------------- */
  _getTickInterval() {
    if (this.state === 'TIME') return 0.42;
    // 本家オクトパス同様、スコアが100点刻みで上がるごとに少しずつ加速し、100点台突入直後に少し緩む波を作る
    const base = this.gameMode === 'B' ? 0.31 : 0.43;
    const withinHundred = this.score % 100;
    const hundredTier = Math.min(5, Math.floor(this.score / 100));
    const speedUp = (withinHundred / 100) * 0.09 + hundredTier * 0.018;
    return Math.max(0.17, base - speedUp);
  }

  _update(dt) {
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

    // 1. 船上での+3点ボーナス荷下ろしステート
    if (this.state === 'UNLOADING') {
      this.unloadTimer += dt;
      if (this.unloadTimer >= 0.26) {
        this.unloadTimer = 0;
        if (this.unloadTicksLeft > 0) {
          this.sound.boatBonusTick(3 - this.unloadTicksLeft);
          this._addScore(1);
          this.unloadTicksLeft -= 1;
        } else {
          this.hasBag = false;
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
        // 先端到達後、次のティックですぐ引っ込む
      } else if (t.len <= 0) {
        t.len = 0;
        t.dir = 1;
        t.wait = isGameB ? 0 : 1;
      } else {
        // GAME B または高スコア時は、縮む途中で再び伸び始める「フェイント（切り返し）」が時折発生！（本家オクトパス名物）
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
     3. AUTHENTIC 1981 LCD SCREEN RENDERER (Canvas 720x480)
     -------------------------------------------------------------------------- */
  _render() {
    const ctx = this.ctx;
    const W = this.canvas.width;  // 720
    const H = this.canvas.height; // 480

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

    // 2. カラー印刷オーバーレイ層（海面・サルベージ船・海底岩礁・沈没船・黄金の宝箱）
    this._drawColorFoilOverlay(ctx);

    // 3. 全ての液晶セグメント描画（非点灯ゴースト＋点灯セグメント＆反射影）
    this._drawAllLcdSegments(ctx);
  }

  _drawColorFoilOverlay(ctx) {
    ctx.save();

    // --- 海面の波ライン（シアンブルー印刷） ---
    ctx.strokeStyle = 'rgba(26, 112, 138, 0.58)';
    ctx.fillStyle = 'rgba(34, 132, 160, 0.16)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 108);
    for (let x = 0; x <= 720; x += 48) {
      ctx.quadraticCurveTo(x + 24, 96, x + 48, 108);
    }
    ctx.lineTo(720, 480);
    ctx.lineTo(0, 480);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(0, 108);
    for (let x = 0; x <= 720; x += 48) {
      ctx.quadraticCurveTo(x + 24, 96, x + 48, 108);
    }
    ctx.stroke();

    // --- 左上のサルベージ船（赤茶色の船体プリント） ---
    ctx.fillStyle = 'rgba(138, 48, 34, 0.72)';
    ctx.strokeStyle = 'rgba(72, 24, 16, 0.85)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(22, 82);
    ctx.lineTo(232, 82);
    ctx.lineTo(208, 116);
    ctx.lineTo(42, 116);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // 船の白いラインと操舵室フレーム
    ctx.strokeStyle = 'rgba(235, 225, 195, 0.65)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(32, 92);
    ctx.lineTo(220, 92);
    ctx.stroke();

    // 船から海中へ垂れるロープ梯子（pos=1用）
    ctx.strokeStyle = 'rgba(92, 58, 30, 0.55)';
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

    // --- 右奥の沈没船シルエット（背景プリント） ---
    ctx.save();
    ctx.strokeStyle = 'rgba(42, 88, 98, 0.25)';
    ctx.fillStyle = 'rgba(42, 88, 98, 0.10)';
    ctx.lineWidth = 3;
    // 傾いたマスト
    ctx.beginPath();
    ctx.moveTo(570, 290);
    ctx.lineTo(635, 115);
    ctx.moveTo(582, 165);
    ctx.lineTo(662, 195);
    ctx.stroke();
    // 沈没船の船尾楼
    ctx.beginPath();
    ctx.moveTo(510, 385);
    ctx.lineTo(695, 340);
    ctx.lineTo(710, 445);
    ctx.lineTo(490, 445);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // --- 左側〜海底の岩礁と海藻プリント ---
    ctx.fillStyle = 'rgba(54, 78, 52, 0.34)';
    ctx.strokeStyle = 'rgba(40, 58, 38, 0.52)';
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

    // 海藻の揺らぎシルエット
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

    // --- 右下の開いた黄金の宝箱（プリント層） ---
    const cx = 612, cy = 382;
    // 宝箱の箱本体
    ctx.fillStyle = 'rgba(138, 72, 24, 0.78)';
    ctx.strokeStyle = 'rgba(65, 32, 10, 0.9)';
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

    // 中の金貨・財宝の輝き
    ctx.fillStyle = 'rgba(235, 185, 35, 0.88)';
    ctx.beginPath();
    ctx.ellipse(cx + 44, cy + 18, 34, 11, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(120, 80, 10, 0.8)';
    ctx.lineWidth = 1.8;
    ctx.stroke();

    // 宝箱の金具バンド
    ctx.strokeStyle = 'rgba(215, 175, 65, 0.85)';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.moveTo(cx + 22, cy + 16);
    ctx.lineTo(cx + 22, cy + 64);
    ctx.moveTo(cx + 64, cy + 16);
    ctx.lineTo(cx + 64, cy + 64);
    ctx.stroke();

    ctx.restore();
  }

  // 液晶セグメント描画ヘルパー（非点灯ゴースト＋点灯時の反射影＆濃色インク）
  _drawSegment(ctx, isLit, pathFn) {
    ctx.save();
    if (isLit) {
      // 1. 反射板へのドロップシャドウ
      ctx.save();
      ctx.translate(2.2, 2.8);
      ctx.fillStyle = 'rgba(24, 32, 18, 0.18)';
      ctx.strokeStyle = 'rgba(24, 32, 18, 0.18)';
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
    });
  }

  _drawBoatBowDiver(ctx, x, y, isLit, isUnloading) {
    // 船首に立つダイバー本体
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
    });

    // 生還時に宝袋を高々と掲げる腕＆宝袋セグメント（+3点ボーナス時）
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
    });
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
      c.lineWidth = 7;
      if (pose === 'rope') {
        // ロープを掴む腕と足
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
        // 歩く足（鉛ブーツ）
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
        // chest (宝箱前)
        c.beginPath();
        c.moveTo(x - 10, y + 20);
        c.lineTo(x - 24, y + 32);
        c.moveTo(x - 6, y + 41);
        c.lineTo(x - 15, y + 65);
        c.moveTo(x + 6, y + 41);
        c.lineTo(x + 14, y + 65);
        c.stroke();
      }
    });

    // 腰にぶら下げる「宝袋（TREASURE BAG）」独立液晶セグメント
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

  _drawTreasureGrabArms(ctx, x, y, reach1Lit, reach2Lit) {
    // 腕セグメント1：右下の宝箱の中に手を突っ込む
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
    });

    // 腕セグメント2：宝箱から引き上げて自分の袋へ詰める
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
    });
  }

  _drawGiantSquidBody(ctx) {
    // 巨大イカ（ダイオウイカ）の頭部・外套膜・三角エンペラ（常時点灯セグメント）
    const squidLit = true;
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
      const eyeShift = (this.tickCount % 2 === 0) ? -3 : 3;
      c.beginPath();
      c.arc(526 + eyeShift, 190, 7.5, 0, Math.PI * 2);
      c.arc(572 + eyeShift, 200, 7.5, 0, Math.PI * 2);
      c.fill();

      // 漏斗（イカの墨吐き管）
      c.beginPath();
      c.roundRect(604, 216, 22, 14, 5);
      c.fill();
      c.restore();
    });
  }

  _drawSquidTentacles(ctx) {
    // 4本の触腕それぞれのセグメント座標定義
    // 各セグメントは太い曲線＋吸盤突起で描かれ、最後のセグメント(maxLen-1)はダイバーを捕まえる触腕先端になる
    const paths = [
      // 足0 (左端: 4セグメント -> pos 2 [x:194, y:294] を襲う)
      [
        { x1: 496, y1: 198, x2: 422, y2: 214, w: 15 },
        { x1: 414, y1: 216, x2: 340, y2: 238, w: 13 },
        { x1: 332, y1: 241, x2: 266, y2: 268, w: 11 },
        { x1: 258, y1: 272, x2: 210, y2: 292, w: 10, isTip: true }
      ],
      // 足1 (中左: 5セグメント -> pos 3 [x:304, y:344] を襲う)
      [
        { x1: 522, y1: 210, x2: 472, y2: 236, w: 15 },
        { x1: 465, y1: 240, x2: 420, y2: 266, w: 13.5 },
        { x1: 413, y1: 270, x2: 374, y2: 296, w: 12 },
        { x1: 368, y1: 300, x2: 338, y2: 324, w: 10.5 },
        { x1: 332, y1: 328, x2: 312, y2: 344, w: 10, isTip: true }
      ],
      // 足2 (中右: 4セグメント -> pos 4 [x:420, y:362] を襲う)
      [
        { x1: 556, y1: 218, x2: 522, y2: 254, w: 15 },
        { x1: 517, y1: 260, x2: 484, y2: 296, w: 13 },
        { x1: 479, y1: 302, x2: 452, y2: 332, w: 11 },
        { x1: 447, y1: 338, x2: 430, y2: 358, w: 10, isTip: true }
      ],
      // 足3 (右端/宝箱前: 3セグメント -> pos 5 [x:534, y:368] を襲う)
      [
        { x1: 590, y1: 222, x2: 580, y2: 270, w: 15 },
        { x1: 578, y1: 278, x2: 564, y2: 322, w: 12.5 },
        { x1: 560, y1: 328, x2: 546, y2: 362, w: 10.5, isTip: true }
      ]
    ];

    for (let tIdx = 0; tIdx < 4; tIdx++) {
      const t = this.tentacles[tIdx];
      const segs = paths[tIdx];

      for (let sIdx = 0; sIdx < segs.length; sIdx++) {
        const seg = segs[sIdx];
        const isLit = t.len > sIdx;

        this._drawSegment(ctx, isLit, (c) => {
          c.lineWidth = seg.w;
          c.lineCap = 'round';
          c.beginPath();
          const mx = (seg.x1 + seg.x2) * 0.5 + (sIdx % 2 === 0 ? -6 : 6);
          const my = (seg.y1 + seg.y2) * 0.5 - 4;
          c.moveTo(seg.x1, seg.y1);
          c.quadraticCurveTo(mx, my, seg.x2, seg.y2);
          c.stroke();

          // イカの吸盤ドット
          c.beginPath();
          c.arc(mx + 4, my + 7, seg.w * 0.32, 0, Math.PI * 2);
          c.arc(seg.x2 + 3, seg.y2 + 5, seg.w * 0.28, 0, Math.PI * 2);
          c.fill();

          // 先端セグメントはイカの触腕フック（二股の捕獲先端）を描く
          if (seg.isTip) {
            c.lineWidth = 6.5;
            c.beginPath();
            c.moveTo(seg.x2, seg.y2);
            c.lineTo(seg.x2 - 14, seg.y2 - 6);
            c.moveTo(seg.x2, seg.y2);
            c.lineTo(seg.x2 - 8, seg.y2 + 12);
            c.stroke();
          }
        });
      }
    }
  }

  _drawCaughtFlailingDiver(ctx) {
    // 捕まった時に中央上空（イカの懐）で手足をバタバタさせる有名な液晶セグメント
    const isCaught = this.state === 'CAUGHT';
    const frameA = isCaught && (this.caughtFlailTicks % 2 === 1);
    const frameB = isCaught && (this.caughtFlailTicks % 2 === 0);

    const cx = 376, cy = 176;

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
    });

    // バタバタ手足フレームA（左腕上げ・右足上げ）
    this._drawSegment(ctx, frameA, (c) => {
      c.lineWidth = 6.5;
      c.lineCap = 'round';
      c.beginPath();
      // 左腕上・右腕下
      c.moveTo(cx - 10, cy + 16);
      c.lineTo(cx - 32, cy - 2);
      c.moveTo(cx + 10, cy + 20);
      c.lineTo(cx + 32, cy + 32);
      // 左足下・右足上
      c.moveTo(cx - 8, cy + 36);
      c.lineTo(cx - 24, cy + 58);
      c.moveTo(cx + 8, cy + 36);
      c.lineTo(cx + 28, cy + 44);
      c.stroke();
    });

    // バタバタ手足フレームB（右腕上げ・左足上げ）
    this._drawSegment(ctx, frameB, (c) => {
      c.lineWidth = 6.5;
      c.lineCap = 'round';
      c.beginPath();
      // 左腕下・右腕上
      c.moveTo(cx - 10, cy + 20);
      c.lineTo(cx - 32, cy + 32);
      c.moveTo(cx + 10, cy + 16);
      c.lineTo(cx + 32, cy - 4);
      // 左足上・右足下
      c.moveTo(cx - 8, cy + 36);
      c.lineTo(cx - 28, cy + 44);
      c.moveTo(cx + 8, cy + 36);
      c.lineTo(cx + 22, cy + 58);
      c.stroke();
    });
  }

  /* --------------------------------------------------------------------------
     7-Segment Digital Display & LCD Status Text
     -------------------------------------------------------------------------- */
  _drawTopRightHudSegments(ctx) {
    // モード表示 (GAME A / GAME B / TIME)
    this._drawLcdLabel(ctx, 326, 32, 'GAME A', this.state !== 'TIME' && this.gameMode === 'A');
    this._drawLcdLabel(ctx, 326, 54, 'GAME B', this.state !== 'TIME' && this.gameMode === 'B');
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
    });
  }

  _drawLcdLabel(ctx, x, y, text, isLit, fontSize = 14) {
    this._drawSegment(ctx, isLit, (c) => {
      c.font = `900 ${fontSize}px "Arial Black", Impact, sans-serif`;
      c.letterSpacing = '1px';
      c.fillText(text, x, y);
    });
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
      });
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
