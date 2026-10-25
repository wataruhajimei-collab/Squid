/**
 * SQUID (スクイッド - ゲーム&ウォッチ風 液晶ゲーム)
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

  return {
    country: String(country).substring(0, 8),
    region: String(region || "Unknown").substring(0, 40),
    city: String(city || "Unknown").substring(0, 40),
    display: String(displayCity || "Unknown").substring(0, 60)
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

      // 現在のアクセス元地名を返すエンドポイント
      if (mode === "whoami") {
        const loc = extractLocation(request);
        return new Response(JSON.stringify({
          ...loc,
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

          if (!cityMap.has(city)) {
            cityMap.set(city, {
              city,
              total: 0,
              count: 0,
              best: 0,
              topPlayer: entry.name,
              country: entry.location?.country || entry.country || "JP"
            });
          }
          const rec = cityMap.get(city);
          rec.total += entry.score;
          rec.count += 1;
          if (entry.score > rec.best) {
            rec.best = entry.score;
            rec.topPlayer = entry.name;
          }
        }

        const regional = Array.from(cityMap.values())
          .map(r => ({
            city: r.city,
            country: r.country,
            avg: Math.round((r.total / r.count) * 10) / 10,
            count: r.count,
            best: r.best,
            topPlayer: r.topPlayer
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
      if (gameModeFilter && (gameModeFilter === "A" || gameModeFilter === "B")) {
        leaderboard = leaderboard.filter(e => (e.gameMode || "A") === gameModeFilter);
      }

      const formatted = leaderboard.map(entry => {
        const loc = entry.location || {};
        const cityDisplay = (loc.display && loc.display !== "Unknown")
          ? loc.display
          : ((loc.city && loc.city !== "Unknown") ? loc.city : (entry.city || null));
        return {
          name: entry.name,
          score: entry.score,
          gameMode: entry.gameMode || "A",
          bags: entry.bags || 0,
          date: entry.date,
          city: cityDisplay,
          region: (loc.region && loc.region !== "Unknown") ? loc.region : null,
          country: loc.country || entry.country || "JP"
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
      const gameMode = body.gameMode === "B" ? "B" : "A";
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
        if (score >= leaderboard[existingIdx].score) {
          leaderboard[existingIdx] = newEntry;
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

    // APIリクエスト、または静的アセットバインディングが存在しない場合（単体API Worker構成）
    if (isApiPath || !env?.ASSETS) {
      return handleApiRequest(request, env);
    }

    // 静的ファイル配信（Cloudflare Workers with Static Assets 構成）
    return env.ASSETS.fetch(request);
  }
};
