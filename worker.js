/**
 * SQUID (スクイッド - 昭和80年代ポケットゲーム風 液晶ゲーム)
 * グローバルランキング & プレイヤー地名記録用 Cloudflare Worker
 *
 * 【デプロイ手順（2通りのどちらでも動作します）】
 *
 * 方法A: GitHub連携でサイトごとCloudflare Workers / Pagesとしてデプロイする場合
 *   1. GitHubリポジトリを Cloudflare Workers & Pages に接続してデプロイ
 *   2. KV名前空間（名前例: `SQUID_KV` または `SCORES`）を作成し、バインディング変数名 `SQUID_KV`（または `SCORES`）でバインド
 *   ※ 同一オリジンの `/api/scores` が自動的に使われます（KV未バインド時でもエッジメモリ上で即時動作します）
 *
 * 方法B: ランキングAPI単体のWorkerとしてデプロイする場合（bowling等と同じ方式）
 *   1. Cloudflare Dashboard -> Workers & Pages -> Workerを作成（名前例: `squid-api`）
 *   2. KV名前空間 `SQUID_KV`（または `SCORES`）を作成し、Workerにバインド
 *   3. この `worker.js` のコードを貼り付けてデプロイ
 */

// KV未設定時でもエラーにならず動作するエッジメモリフォールバック
const memStore = globalThis.__SQUID_MEM_STORE || (globalThis.__SQUID_MEM_STORE = {
  SQUID_LEADERBOARD: "[]",
  SQUID_PLAYER_STATS: "{}"
});

function getStorage(env) {
  const kv = env?.SQUID_KV || env?.SCORES || env?.LEADERBOARD || env?.KV;
  if (kv) {
    return {
      type: "kv",
      async get(key) {
        return await kv.get(key);
      },
      async put(key, val) {
        return await kv.put(key, val);
      }
    };
  }
  return {
    type: "memory",
    async get(key) {
      return memStore[key] || null;
    },
    async put(key, val) {
      memStore[key] = val;
    }
  };
}

function inferTimezoneByLocation(country, city, region) {
  const c = String(country || '').toUpperCase();
  const cityStr = String(city || '').toLowerCase();
  const regStr = String(region || '').toLowerCase();

  if (c === "US" || cityStr.includes("houston") || regStr.includes("texas")) return "America/Chicago";
  if (cityStr.includes("new york")) return "America/New_York";
  if (cityStr.includes("los angeles") || cityStr.includes("california")) return "America/Los_Angeles";
  if (c === "SG" || cityStr.includes("singapore")) return "Asia/Singapore";
  if (c === "AU" || cityStr.includes("fremantle") || regStr.includes("western australia") || cityStr.includes("perth")) return "Australia/Perth";
  if (cityStr.includes("sydney") || cityStr.includes("melbourne")) return "Australia/Sydney";
  if (c === "GB" || c === "UK" || cityStr.includes("london")) return "Europe/London";
  if (c === "FR" || cityStr.includes("paris")) return "Europe/Paris";
  if (c === "DE" || cityStr.includes("berlin")) return "Europe/Berlin";
  if (c === "JP") return "Asia/Tokyo";
  return null;
}

function extractLocation(request, body = {}) {
  const cf = request.cf || {};
  const country = (cf.country && cf.country !== "XX" && cf.country !== "T1")
    ? cf.country
    : (body.clientCountry || "JP");
  const region = cf.region || body.clientRegion || "";
  const city = cf.city || body.clientCity || region || "Unknown";

  let displayCity = city;
  if (city && city !== "Unknown" && region && region !== city && region !== "Unknown") {
    displayCity = `${city}, ${region}`;
  } else if (city === "Unknown" && region && region !== "Unknown") {
    displayCity = region;
  }

  // 拡張テレメトリー情報 (回線・ISP・タイムゾーン・標高・端末等)
  const clientTelemetry = body.telemetry || {};
  const isp = cf.asOrganization || cf.asn ? `${cf.asOrganization || ''} (AS${cf.asn || ''})`.trim() : (clientTelemetry.isp || null);
  const inferredTz = inferTimezoneByLocation(country, city, region);
  const timezone = cf.timezone || clientTelemetry.timezone || inferredTz || (country === "JP" ? "Asia/Tokyo" : null);
  const latitude = typeof cf.latitude === "number" ? cf.latitude : (clientTelemetry.lat || null);
  const longitude = typeof cf.longitude === "number" ? cf.longitude : (clientTelemetry.lon || null);
  const altitude = (typeof clientTelemetry.altitude === "number") ? clientTelemetry.altitude : null;

  return {
    country: String(country).substring(0, 8),
    region: String(region || "Unknown").substring(0, 40),
    city: String(city || "Unknown").substring(0, 40),
    display: String(displayCity || "Unknown").substring(0, 60),
    isp: isp ? String(isp).substring(0, 80) : null,
    timezone: timezone ? String(timezone).substring(0, 40) : null,
    lat: latitude,
    lon: longitude,
    altitude: altitude,
    device: clientTelemetry.device || null,
    os: clientTelemetry.os || null,
    browser: clientTelemetry.browser || null,
    inputType: clientTelemetry.inputType || null,
    battery: clientTelemetry.battery || null,
    connection: clientTelemetry.connection || null
  };
}

export async function handleApiRequest(request, env) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const store = getStorage(env);
  const url = new URL(request.url);

  if (request.method === "GET") {
    try {
      const mode = url.searchParams.get("mode");
      const gameModeFilter = url.searchParams.get("gameMode"); // "A", "B", or "ALL"

      // 現在のアクセス元地名および回線・ISP・タイムゾーンを返すエンドポイント
      if (mode === "whoami") {
        const loc = extractLocation(request);
        const cf = request.cf || {};
        return new Response(JSON.stringify({
          ...loc,
          isp: cf.asOrganization || cf.asn ? `${cf.asOrganization || ''} (AS${cf.asn || ''})`.trim() : "Unknown ISP",
          timezone: cf.timezone || "Asia/Tokyo",
          lat: cf.latitude || null,
          lon: cf.longitude || null,
          storage: store.type
        }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const rawLb = await store.get("SQUID_LEADERBOARD");
      let leaderboard = rawLb ? JSON.parse(rawLb) : [];

      // --- アベレージ・累計ランキングモード ---
      if (mode === "average") {
        const statsData = await store.get("SQUID_PLAYER_STATS");
        const stats = statsData ? JSON.parse(statsData) : {};

        const avgRanking = Object.values(stats)
          .filter(p => p.count >= 1)
          .map(p => ({
            name: p.name,
            avg: Math.round((p.total / p.count) * 10) / 10,
            best: p.best,
            games: p.count,
            city: (p.city && p.city !== "Unknown") ? p.city : null,
            country: p.country || "JP"
          }))
          .sort((a, b) => {
            if (b.avg !== a.avg) return b.avg - a.avg;
            return b.best - a.best;
          })
          .slice(0, 50);

        return new Response(JSON.stringify(avgRanking), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // --- 地域別ランキングモード ---
      if (mode === "regional") {
        const cityMap = new Map();
        for (const entry of leaderboard) {
          const rawCity = entry.location?.display || entry.location?.city || entry.city;
          const city = (rawCity && rawCity !== "Unknown") ? rawCity : null;
          if (!city) continue;

          const loc = entry.location || {};
          const entryTz = loc.timezone || inferTimezoneByLocation(entry.location?.country || entry.country, entry.city || loc.city, loc.region);
          if (!cityMap.has(city)) {
            cityMap.set(city, {
              city,
              total: 0,
              count: 0,
              best: 0,
              topPlayer: entry.name,
              country: entry.location?.country || entry.country || "JP",
              isp: loc.isp || null,
              timezone: entryTz,
              altitude: loc.altitude ?? null,
              device: loc.device || null,
              os: loc.os || null,
              browser: loc.browser || null,
              inputType: loc.inputType || null,
              battery: loc.battery || null,
              connection: loc.connection || null,
              lat: loc.lat || null,
              lon: loc.lon || null
            });
          }
          const rec = cityMap.get(city);
          rec.total += entry.score;
          rec.count += 1;
          if (entry.score > rec.best) {
            rec.best = entry.score;
            rec.topPlayer = entry.name;
            if (loc.isp) rec.isp = loc.isp;
            if (entryTz) rec.timezone = entryTz;
            if (loc.altitude != null) rec.altitude = loc.altitude;
            if (loc.device) rec.device = loc.device;
            if (loc.os) rec.os = loc.os;
            if (loc.browser) rec.browser = loc.browser;
            if (loc.inputType) rec.inputType = loc.inputType;
            if (loc.battery) rec.battery = loc.battery;
            if (loc.connection) rec.connection = loc.connection;
          }
        }

        const regional = Array.from(cityMap.values())
          .map(r => ({
            city: r.city,
            country: r.country,
            avg: Math.round((r.total / r.count) * 10) / 10,
            count: r.count,
            best: r.best,
            topPlayer: r.topPlayer,
            telemetry: {
              isp: r.isp,
              timezone: r.timezone,
              altitude: r.altitude,
              device: r.device,
              os: r.os,
              browser: r.browser,
              inputType: r.inputType,
              battery: r.battery,
              connection: r.connection,
              lat: r.lat,
              lon: r.lon
            }
          }))
          .sort((a, b) => {
            if (b.best !== a.best) return b.best - a.best;
            return b.avg - a.avg;
          })
          .slice(0, 50);

        return new Response(JSON.stringify(regional), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // --- 個人ハイスコアランキング（デフォルト）---
      if (gameModeFilter && (gameModeFilter === "A" || gameModeFilter === "B" || gameModeFilter === "C")) {
        leaderboard = leaderboard.filter(e => (e.gameMode || "A") === gameModeFilter);
      }

      const formatted = leaderboard.map(entry => {
        const loc = entry.location || {};
        const cityDisplay = (loc.display && loc.display !== "Unknown")
          ? loc.display
          : ((loc.city && loc.city !== "Unknown") ? loc.city : (entry.city || null));
        const entryTz = loc.timezone || inferTimezoneByLocation(loc.country || entry.country, loc.city || entry.city, loc.region);
        return {
          name: entry.name,
          score: entry.score,
          gameMode: entry.gameMode || "A",
          bags: entry.bags || 0,
          date: entry.date,
          city: cityDisplay,
          region: (loc.region && loc.region !== "Unknown") ? loc.region : null,
          country: loc.country || entry.country || "JP",
          telemetry: {
            isp: loc.isp || null,
            timezone: entryTz,
            altitude: loc.altitude ?? null,
            device: loc.device || null,
            os: loc.os || null,
            browser: loc.browser || null,
            inputType: loc.inputType || null,
            battery: loc.battery || null,
            connection: loc.connection || null,
            lat: loc.lat || null,
            lon: loc.lon || null
          }
        };
      });

      return new Response(JSON.stringify(formatted), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Failed to fetch scores.", detail: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  if (request.method === "POST") {
    try {
      const body = await request.json();
      if (!body.name || typeof body.score !== "number" || isNaN(body.score)) {
        return new Response(JSON.stringify({ error: "Invalid data." }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      const location = extractLocation(request, body);
      // プレイヤーが任意で地名（市区町村など）を補足入力した場合はそれを優先利用
      if (body.customPlace && String(body.customPlace).trim()) {
        const cleanPlace = String(body.customPlace).trim().substring(0, 24);
        location.city = cleanPlace;
        location.display = cleanPlace;
      }

      const name = String(body.name).trim().substring(0, 12) || "DIVER";
      const score = Math.min(99999, Math.max(0, Math.floor(body.score)));
      const gameMode = (body.gameMode === "B" || body.gameMode === "C") ? body.gameMode : "A";
      const bags = Math.max(0, Math.floor(body.bags || 0));
      const date = body.date || new Date().toISOString();
      const playerId = body.playerId ? String(body.playerId).substring(0, 64) : null;

      // --- PLAYER_STATS 更新 ---
      if (playerId) {
        const statsData = await store.get("SQUID_PLAYER_STATS");
        const stats = statsData ? JSON.parse(statsData) : {};
        const prev = stats[playerId] || { total: 0, count: 0, best: 0 };

        stats[playerId] = {
          name,
          total: prev.total + score,
          count: prev.count + 1,
          best: Math.max(prev.best, score),
          city: location.display !== "Unknown" ? location.display : (prev.city || "Unknown"),
          country: location.country || prev.country || "JP",
          lastDate: date
        };

        const allStats = Object.entries(stats);
        if (allStats.length > 5000) {
          allStats.sort((a, b) => b[1].best - a[1].best);
          await store.put("SQUID_PLAYER_STATS", JSON.stringify(Object.fromEntries(allStats.slice(0, 5000))));
        } else {
          await store.put("SQUID_PLAYER_STATS", JSON.stringify(stats));
        }
      }

      // --- LEADERBOARD 更新 ---
      const lbData = await store.get("SQUID_LEADERBOARD");
      let leaderboard = lbData ? JSON.parse(lbData) : [];

      const newEntry = {
        name,
        score,
        gameMode,
        bags,
        date,
        location,
        playerId
      };

      // 同一プレイヤー（playerIdまたはname）かつ同一ゲームモード(A/B)で自己ベスト更新
      const existingIdx = leaderboard.findIndex(e => {
        const sameMode = (e.gameMode || "A") === gameMode;
        if (!sameMode) return false;
        if (playerId && e.playerId) return e.playerId === playerId && e.name === name;
        return e.name === name;
      });

      let updated = false;
      if (existingIdx !== -1) {
        // スコアが自己ベストを更新した場合のみスコアを更新
        if (score >= leaderboard[existingIdx].score) {
          leaderboard[existingIdx] = newEntry;
          updated = true;
        } else {
          // 自己ベスト更新でない場合でも、最新プレイ時の位置情報・テレメトリー・プレイ日時を常に最新へ更新！
          leaderboard[existingIdx].location = location;
          leaderboard[existingIdx].lastDate = date;
          updated = true;
        }
      } else {
        leaderboard.push(newEntry);
        updated = true;
      }

      leaderboard.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return new Date(a.date) - new Date(b.date);
      });

      leaderboard = leaderboard.slice(0, 150);
      await store.put("SQUID_LEADERBOARD", JSON.stringify(leaderboard));

      const rank = leaderboard.findIndex(e => e.name === name && (e.gameMode || "A") === gameMode) + 1;

      return new Response(JSON.stringify({
        success: true,
        updated,
        rank,
        location,
        storage: store.type
      }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Failed to save score.", detail: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  return new Response("Method not allowed", { status: 405, headers: corsHeaders });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const isApiPath =
      url.pathname.startsWith("/api/") ||
      url.pathname === "/ranking" ||
      url.pathname === "/submit" ||
      url.searchParams.has("mode") ||
      url.searchParams.has("gameMode") ||
      request.method === "POST" ||
      request.method === "OPTIONS";

    // URLリライト: /map へのアクセスを /map.html に転送または直接書き換え
    if (url.pathname === "/map") {
      const mapUrl = new URL("/map.html", request.url);
      return env.ASSETS.fetch(new Request(mapUrl, request));
    }

    // APIリクエスト、または静的アセットバインディングが存在しない場合（単体API Worker構成）
    if (isApiPath || !env?.ASSETS) {
      return handleApiRequest(request, env);
    }

    // 静的ファイル配信（Cloudflare Workers with Static Assets 構成：キャッシュ無効化ヘッダを付与）
    const assetRes = await env.ASSETS.fetch(request);
    const headers = new Headers(assetRes.headers);
    headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
    headers.set("Pragma", "no-cache");
    return new Response(assetRes.body, {
      status: assetRes.status,
      statusText: assetRes.statusText,
      headers
    });
  }
};
