import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import main, { type Input, type Output } from './src/yt/solver/main.ts';
import { preprocessPlayer, getFromPrepared } from './src/yt/solver/solvers.ts';

const app = new Application();
const router = new Router();

const PLAYER_VARIANTS: Record<string, string> = {
  'main': 'player_ias.vflset/en_US/base.js',
  'tcc': 'player_ias_tcc.vflset/en_US/base.js',
  'tce': 'player_ias_tce.vflset/en_US/base.js',
  'es5': 'player_es5.vflset/en_US/base.js',
  'es6': 'player_es6.vflset/en_US/base.js',
  'tv': 'tv-player-ias.vflset/tv-player-ias.js',
  'tv_es6': 'tv-player-es6.vflset/tv-player-es6.js',
  'phone': 'player-plasma-ias-phone-en_US.vflset/base.js',
  'tablet': 'player-plasma-ias-tablet-en_US.vflset/base.js'
};

const cache = new Map<string, { data: string; lastAccess: number }>();
const CACHE_DIR = '/tmp/yt_player_cache';
const CACHE_TTL = 1000 * 60 * 60 * 24 * 14;

// 预编译缓存：只存储函数对象，不存储大字符串以防止内存泄漏
const precompilationCache = new Map<string, {
  solvers: { n: ((val: string) => string) | null; sig: ((val: string) => string) | null };
  signatureTimestamp: number | null;
  lastAccess: number
}>();
const PRECOMPILATION_TTL = 1000 * 60 * 60 * 24 * 7; // 7天

// --- 自动更新相关 ---
let latestPlayerId: string | null = null;
const UPDATE_INTERVAL = 1000 * 60 * 60 * 24; // 24小时

function getCacheKey(player: string, variant: string) {
  return `${player}_${variant}`;
}

// 从 player 代码中提取 signatureTimestamp
function extractSignatureTimestamp(playerCode: string): number | null {
  const match = playerCode.match(/signatureTimestamp\s*[:=]\s*(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// 自动获取最新 Player ID 并预热
async function updateLatestPlayer() {
  console.log('[AutoUpdate] Checking for new player version...');
  try {
    const response = await fetch("https://www.youtube.com/iframe_api");
    if (!response.ok) {
      throw new Error(`Failed to fetch iframe_api: ${response.status}`);
    }
    const text = await response.text();

    // 正则匹配: player\/([a-z0-9]{8})\/
    const match = text.match('player\\\\/([a-z0-9]{8})\\\\/');

    if (match && match[1]) {
      const newId = match[1];
      if (newId !== latestPlayerId) {
        console.log(`[AutoUpdate] New player found: ${newId} (Old: ${latestPlayerId || 'none'})`);
        latestPlayerId = newId;

        // 立即预热 (默认预热 main 变体)
        console.log(`[AutoUpdate] Warming up cache for ${newId}...`);
        await getPrecompiledCached(newId, 'main');
        console.log(`[AutoUpdate] Warmup complete for ${newId}`);
      } else {
        console.log(`[AutoUpdate] Player ID is up to date: ${latestPlayerId}`);
      }
    } else {
      console.error('[AutoUpdate] Could not find player ID in iframe_api response');
    }
  } catch (error) {
    console.error('[AutoUpdate] Error updating player ID:', error);
  }
}

async function getPrecompiledCached(player: string, variant = 'main'): Promise<{ solvers: { n: ((val: string) => string) | null; sig: ((val: string) => string) | null }; signatureTimestamp: number | null }> {
  const key = getCacheKey(player, variant);
  const now = Date.now();

  // 检查预编译缓存
  const cached = precompilationCache.get(key);
  if (cached && (now - cached.lastAccess) < PRECOMPILATION_TTL) {
    cached.lastAccess = now;
    // console.log(`Precompilation cache hit: ${key}`);
    return {
      solvers: cached.solvers,
      signatureTimestamp: cached.signatureTimestamp
    };
  }

  // 获取原始 player 代码
  const playerCode = await getPlayerCached(player, variant);

  // 提取 signatureTimestamp
  const signatureTimestamp = extractSignatureTimestamp(playerCode);

  // 进行预编译
  console.log(`Precompiling player: ${key}`);
  const preprocessed = preprocessPlayer(playerCode);

  // 创建函数对象
  const solvers = getFromPrepared(preprocessed);

  // 只缓存函数对象，让 preprocessed 字符串（3.5MB）被 GC 回收
  precompilationCache.set(key, { solvers, signatureTimestamp, lastAccess: now });
  console.log(`Precompilation cached: ${key}, signatureTimestamp: ${signatureTimestamp}`);

  return {
    solvers,
    signatureTimestamp
  };
}

async function cleanExpiredCache() {
  const now = Date.now();

  // 清理原始 player 代码缓存
  for (const [key, value] of cache.entries()) {
    if (now - value.lastAccess > CACHE_TTL) {
      cache.delete(key);
      console.log(`Cleaned memory cache: ${key}`);
    }
  }

  // 清理预编译缓存
  for (const [key, value] of precompilationCache.entries()) {
    if (now - value.lastAccess > PRECOMPILATION_TTL) {
      precompilationCache.delete(key);
      console.log(`Cleaned precompilation cache: ${key}`);
    }
  }

  try {
    for await (const entry of Deno.readDir(CACHE_DIR)) {
      if (entry.isFile) {
        const filePath = `${CACHE_DIR}/${entry.name}`;
        try {
          const fileInfo = await Deno.stat(filePath);
          if (fileInfo.mtime && now - fileInfo.mtime.getTime() > CACHE_TTL) {
            await Deno.remove(filePath);
            console.log(`Cleaned disk cache: ${entry.name}`);
          }
        } catch (error) {
          console.error(`Failed to clean file: ${entry.name}`, error);
        }
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      console.error('Failed to clean disk cache:', error);
    }
  }
}

async function getPlayerCached(player: string, variant = 'main'): Promise<string> {
  const key = getCacheKey(player, variant);
  const now = Date.now();

  const memCache = cache.get(key);
  if (memCache && (now - memCache.lastAccess) < CACHE_TTL) {
    memCache.lastAccess = now;
    return memCache.data;
  }

  const diskPath = `${CACHE_DIR}/${key}.js`;
  try {
    const fileInfo = await Deno.stat(diskPath);

    if (fileInfo.mtime && now - fileInfo.mtime.getTime() < CACHE_TTL) {
      const data = await Deno.readTextFile(diskPath);
      cache.set(key, { data, lastAccess: now });
      console.log(`Loaded from disk cache: ${key}`);
      return data;
    } else {
      await Deno.remove(diskPath);
      console.log(`Disk cache expired: ${key}`);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      // debug log removed to reduce noise
    } else {
      console.error(`Failed to read disk cache: ${key}`, error);
    }
  }

  const path = PLAYER_VARIANTS[variant];
  if (!path) {
    throw new Error(`Unknown variant: ${variant}`);
  }

  const url = `https://www.youtube.com/s/player/${player}/${path}`;
  console.log(`Downloading player: ${key}`);
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download player: ${response.status} ${response.statusText}`);
  }

  const data = await response.text();

  cache.set(key, { data, lastAccess: now });

  await Deno.mkdir(CACHE_DIR, { recursive: true });
  await Deno.writeTextFile(diskPath, data);
  console.log(`Cache saved: ${key}`);

  return data;
}

router.get('/decode', async (ctx) => {
  try {
    const params = ctx.request.url.searchParams;
    let player = params.get('player'); // Changed to let
    const n = params.get('n');
    const sig = params.get('sig');
    const variant = params.get('variant') || 'main';

    // 如果未提供 player 参数，尝试使用自动获取的 latestPlayerId
    if (!player) {
      if (latestPlayerId) {
        player = latestPlayerId;
      } else {
        ctx.response.status = 400;
        ctx.response.body = {
          type: "error" as const,
          error: "Missing 'player' parameter and server hasn't fetched latest version yet."
        };
        return;
      }
    }

    if (!n && !sig) {
      ctx.response.status = 400;
      ctx.response.body = {
        type: "error" as const,
        error: "Provide at least 'n' or 'sig' parameters"
      };
      return;
    }

    // 使用预编译缓存（首次会触发预编译和函数创建）
    const { solvers } = await getPrecompiledCached(player, variant);

    const requests: { type: "n" | "sig"; challenges: string[] }[] = [];
    if (n && n.trim()) {
      requests.push({
        type: "n" as const,
        challenges: n.split(',').map(s => s.trim()).filter(Boolean)
      });
    }
    if (sig && sig.trim()) {
      requests.push({
        type: "sig" as const,
        challenges: sig.split(',').map(s => s.trim()).filter(Boolean)
      });
    }

    // 直接使用缓存的 solvers，不再需要传入 preprocessed 字符串
    const result: Output = main("", solvers, requests);

    // 在结果中通过 meta 信息告知客户端使用了哪个 player ID
    // Typescript might complain if Output type doesn't support extra fields, 
    // but JS runtime will allow it. Or wrap it.
    ctx.response.body = {
      ...result,
      meta: {
        player_id: player,
        source: params.get('player') ? 'param' : 'auto_latest'
      }
    };

  } catch (error) {
    console.error('Decode error:', error);
    ctx.response.status = 500;
    ctx.response.body = {
      type: "error" as const,
      error: error instanceof Error ? error.message : String(error)
    };
  }
});

router.get('/cache/status', (ctx) => {
  const now = Date.now();
  const memUsage = Deno.memoryUsage();

  const entries = Array.from(cache.entries()).map(([key, value]) => ({
    key,
    age_hours: ((now - value.lastAccess) / (1000 * 60 * 60)).toFixed(1),
    size_kb: (value.data.length / 1024).toFixed(1),
    expires_in_days: ((CACHE_TTL - (now - value.lastAccess)) / (1000 * 60 * 60 * 24)).toFixed(1)
  }));

  const precompilationEntries = Array.from(precompilationCache.entries()).map(([key, value]) => ({
    key,
    age_hours: ((now - value.lastAccess) / (1000 * 60 * 60)).toFixed(1),
    has_solvers: value.solvers ? true : false,
    signatureTimestamp: value.signatureTimestamp,
    expires_in_days: ((PRECOMPILATION_TTL - (now - value.lastAccess)) / (1000 * 60 * 60 * 24)).toFixed(1)
  }));

  ctx.response.body = {
    // 新增 latest_player 状态
    latest_player_auto: latestPlayerId,
    memory_entries: entries.length,
    precompilation_entries: precompilationEntries.length,
    entries,
    precompilation: precompilationEntries,
    cache_ttl_days: 14,
    precompilation_ttl_days: 7,
    cache_dir: CACHE_DIR,
    memory_optimization: "Preprocessed strings removed from cache to prevent OOM",
    memory_usage: {
      heap_used_mb: (memUsage.heapUsed / 1024 / 1024).toFixed(1),
      heap_total_mb: (memUsage.heapTotal / 1024 / 1024).toFixed(1),
      external_mb: (memUsage.external / 1024 / 1024).toFixed(1),
      rss_mb: (memUsage.rss / 1024 / 1024).toFixed(1)
    }
  };
});

router.post('/cache/clean', async (ctx) => {
  await cleanExpiredCache();
  ctx.response.body = { status: 'expired_cache_cleaned' };
});

router.post('/cache/clear', async (ctx) => {
  cache.clear();
  precompilationCache.clear();
  latestPlayerId = null; // 清除自动获取的ID
  try {
    for await (const entry of Deno.readDir(CACHE_DIR)) {
      if (entry.isFile) {
        await Deno.remove(`${CACHE_DIR}/${entry.name}`);
      }
    }
  } catch (error) {
    // Ignore directory not found errors
  }
  ctx.response.body = { status: 'all_cache_cleared' };
});

// 手动触发更新的接口
router.post('/update-player', async (ctx) => {
  await updateLatestPlayer();
  ctx.response.body = {
    status: 'ok',
    latest_player: latestPlayerId
  };
});

router.get('/health', (ctx) => {
  ctx.response.body = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    latest_player: latestPlayerId
  };
});

router.get('/variants', (ctx) => {
  ctx.response.body = Object.keys(PLAYER_VARIANTS);
});

router.get('/latest-player', (ctx) => {
  const variant = ctx.request.url.searchParams.get('variant') || 'main';

  if (!latestPlayerId) {
    ctx.response.status = 404;
    ctx.response.body = {
      error: 'Latest player not available yet. Server is still initializing or failed to fetch.'
    };
    return;
  }

  const key = getCacheKey(latestPlayerId, variant);
  const cached = precompilationCache.get(key);

  if (!cached) {
    ctx.response.status = 404;
    ctx.response.body = {
      error: `Player ${latestPlayerId} with variant ${variant} not cached yet. Try calling /warmup first.`
    };
    return;
  }

  ctx.response.body = {
    player: latestPlayerId,
    variant: variant,
    signatureTimestamp: cached.signatureTimestamp
  };
});

router.get('/warmup', async (ctx) => {
  try {
    const params = ctx.request.url.searchParams;
    let player = params.get('player');
    const variant = params.get('variant') || 'main';

    if (!player) {
      if (latestPlayerId) {
        player = latestPlayerId;
      } else {
        ctx.response.status = 400;
        ctx.response.body = {
          type: "error" as const,
          error: "Missing 'player' parameter"
        };
        return;
      }
    }

    await getPrecompiledCached(player, variant);

    ctx.response.body = {
      status: 'warmed_up',
      player,
      variant
    };
  } catch (error) {
    console.error('Warmup error:', error);
    ctx.response.status = 500;
    ctx.response.body = {
      type: "error" as const,
      error: error instanceof Error ? error.message : String(error)
    };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

const PORT = Number(Deno.env.get('PORT')) || 4009;

console.log(`YouTube decode service started on port ${PORT}`);
console.log(`API: http://localhost:${PORT}/decode`);
console.log(`Cache status: http://localhost:${PORT}/cache/status`);

// 启动定时任务
setInterval(cleanExpiredCache, 1000 * 60 * 60); // 1小时清理一次缓存
setInterval(updateLatestPlayer, UPDATE_INTERVAL); // 24小时更新一次Player

// 启动时立即执行任务
console.log("Initializing: Cleaning cache and fetching latest player...");
await cleanExpiredCache();
await updateLatestPlayer(); // 阻塞启动，直到获取到最新 ID (可选，不想阻塞可以去掉 await)

await app.listen({ port: PORT });
