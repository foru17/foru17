import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const METRICS = [
  { key: 'x_followers', file: 'x-followers.json', label: 'X Followers', color: '000000', logo: 'x', summary: 'x' },
  { key: 'youtube_subscribers', file: 'youtube-subscribers.json', label: 'YouTube Subscribers', color: 'FF0000', logo: 'youtube', summary: 'yt_subs' },
  { key: 'youtube_views', file: 'youtube-views.json', label: 'YouTube Views', color: 'FF0000', logo: 'youtube', summary: 'yt_views' },
  { key: 'bilibili_followers', file: 'bilibili-followers.json', label: 'Bilibili Followers', color: '00A1D6', logo: 'bilibili', summary: 'bili' },
];
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function redact(value) {
  let text = String(value).replace(/key=[^&\s]+/g, 'key=***');
  const key = process.env.YOUTUBE_API_KEY;
  if (key) text = text.split(key).join('***');
  return text;
}

function log(message) {
  console.log(redact(message));
}

function annotation(level, message) {
  log(`::${level}::${redact(message).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`);
}

function positiveInteger(value) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error('value must be a finite positive integer');
  }
  return value;
}

export function formatCount(value) {
  if (value < 1000) return String(value);
  if (value < 1e6) {
    const thousands = Math.round(value / 100) / 10;
    return thousands >= 1000 ? '1M' : `${thousands}K`;
  }
  return `${(value / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
}

async function request(url, { headers, youtube = false } = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (youtube) {
    // Never include the response body: Google's error.message is the only remote error text logged.
    let json;
    try {
      json = await response.json();
    } catch {
      throw new Error(`HTTP ${response.status}: invalid JSON`);
    }
    if (response.status !== 200 || json?.error) {
      const message = typeof json?.error?.message === 'string' ? `: ${json.error.message}` : '';
      throw new Error(`HTTP ${response.status}${message}`);
    }
    return json;
  }
  if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error('invalid JSON');
  }
}

async function fetchX() {
  const base = process.env.X_API_BASE || 'https://api.fxtwitter.com';
  const fallback = process.env.X_API_FALLBACK || 'https://api.vxtwitter.com';
  let primaryError;
  try {
    const json = await request(`${base.replace(/\/+$/, '')}/luoleiorg`);
    if (json?.code !== 200 || json?.user?.screen_name?.toLowerCase() !== 'luoleiorg') {
      throw new Error('invalid primary code or screen_name');
    }
    return { value: positiveInteger(json.user.followers), source: 'fxtwitter' };
  } catch (error) {
    primaryError = error.message;
  }
  try {
    const json = await request(`${fallback.replace(/\/+$/, '')}/luoleiorg`);
    if (json?.screen_name?.toLowerCase() !== 'luoleiorg') {
      throw new Error('invalid fallback screen_name');
    }
    return { value: positiveInteger(json.followers_count), source: 'vxtwitter' };
  } catch (error) {
    throw new Error(`primary: ${primaryError}; fallback: ${error.message}`);
  }
}

async function fetchYouTube() {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error('YOUTUBE_API_KEY is not set; skipped');
  return request(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=UCFCs9KNL6f2ZMKsoU7rjbkg&key=${encodeURIComponent(key)}`, { youtube: true });
}

function youtubeValue(json, field) {
  const value = json?.items?.[0]?.statistics?.[field];
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`HTTP 200: missing or invalid ${field}`);
  }
  return positiveInteger(Number(value));
}

async function fetchBilibili() {
  const json = await request('https://api.bilibili.com/x/relation/stat?vmid=7388950', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      Referer: 'https://space.bilibili.com/7388950',
    },
  });
  if (json?.code !== 0) throw new Error(`Bilibili code=${json?.code}`);
  return { value: positiveInteger(json?.data?.follower), source: 'bilibili' };
}

async function readExisting(path) {
  try {
    return await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function main() {
  const directory = resolve(process.env.BADGES_DIR || './badges-branch');
  const dryRun = process.env.DRY_RUN === '1';
  const now = new Date();
  let previous = {};
  try {
    const content = await readExisting(join(directory, 'stats.json'));
    if (content) {
      previous = JSON.parse(content.toString('utf8'));
      if (!previous || typeof previous !== 'object' || Array.isArray(previous)) {
        throw new Error('stats.json must contain an object');
      }
    }
  } catch (error) {
    annotation('warning', `stats.json failed: ${error.message}`);
    previous = {};
  }

  // The shared promise (including rejection) caps YouTube at one request per run.
  let youtubePromise;
  const getYouTube = () => (youtubePromise ??= fetchYouTube());
  const providers = {
    x_followers: fetchX,
    youtube_subscribers: async () => ({ value: youtubeValue(await getYouTube(), 'subscriberCount'), source: 'youtube' }),
    youtube_views: async () => ({ value: youtubeValue(await getYouTube(), 'viewCount'), source: 'youtube' }),
    bilibili_followers: fetchBilibili,
  };
  const stats = {};
  const pending = new Map();
  const summaryParts = [];

  for (const metric of METRICS) {
    const old = previous[metric.key] ?? {};
    const hasOldValue = Number.isFinite(old.value) && Number.isInteger(old.value) && old.value > 0;
    let failed = false;
    try {
      const { value, source } = await providers[metric.key]();
      positiveInteger(value);
      if (hasOldValue && old.value >= 1000 && (value < old.value * 0.5 || value > old.value * 3)) {
        throw new Error(`anomaly: old=${old.value} new=${value}`);
      }
      stats[metric.key] = {
        value,
        updated_at: hasOldValue && old.value === value ? old.updated_at : now.toISOString(),
        fail_streak: 0,
        last_error: null,
        source,
      };
      pending.set(metric.file, JSON.stringify({
        schemaVersion: 1,
        label: metric.label,
        message: formatCount(value),
        color: metric.color,
        namedLogo: metric.logo,
        logoColor: 'white',
        style: 'flat-square',
        cacheSeconds: 3600,
      }) + '\n');
    } catch (error) {
      failed = true;
      const reason = redact(error.message);
      annotation('warning', `${metric.key}${reason.startsWith('anomaly:') ? ' ' : ' failed: '}${reason}`);
      stats[metric.key] = {
        value: hasOldValue ? old.value : null,
        updated_at: old.updated_at ?? null,
        fail_streak: (Number.isInteger(old.fail_streak) && old.fail_streak >= 0 ? old.fail_streak : 0) + 1,
        last_error: reason,
        source: old.source ?? null,
      };
    }
    const value = stats[metric.key].value;
    summaryParts.push(`${metric.summary}=${value === null ? 'n/a' : formatCount(value) + (failed ? '(stale)' : '')}`);
  }

  // Preserve the original bytes (including formatting) when the state did not change.
  const stateChanged = METRICS.some(({ key }) => {
    const before = previous[key];
    return !before || Object.keys(stats[key]).some(field => before[field] !== stats[key][field]);
  });
  if (stateChanged) pending.set('stats.json', JSON.stringify(stats, null, 2) + '\n');

  let unhealthy = false;
  for (const metric of METRICS) {
    const state = stats[metric.key];
    const expired = state.value !== null && now.getTime() - Date.parse(state.updated_at) > WEEK_MS;
    if (state.fail_streak >= 8 || expired) {
      unhealthy = true;
      annotation('error', `${metric.key}: fail_streak=${state.fail_streak}${expired ? '; updated_at is older than 7 days' : ''}`);
    }
  }

  // All content is ready before any output file is touched. Never stage failed endpoints.
  for (const [file, content] of pending) {
    const path = join(directory, file);
    try {
      const existing = await readExisting(path);
      if (existing?.equals(Buffer.from(content))) continue;
      if (dryRun) {
        log(`DRY_RUN ${path}: ${content.trimEnd()}`);
        continue;
      }
      await mkdir(directory, { recursive: true });
      await writeFile(`${path}.tmp`, content);
      await rename(`${path}.tmp`, path);
    } catch (error) {
      annotation('warning', `${file} write failed: ${error.message}`);
    }
  }

  const summary = redact(summaryParts.join(' '));
  if (process.env.GITHUB_OUTPUT && !dryRun) {
    try {
      await appendFile(process.env.GITHUB_OUTPUT, `summary=${summary}\n`);
    } catch (error) {
      annotation('warning', `GITHUB_OUTPUT failed: ${error.message}`);
    }
  }
  log(`summary: ${summary}`);
  // Keep ordinary source or filesystem failures nonfatal; only health thresholds fail the job.
  if (unhealthy) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
