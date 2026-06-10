/* 羽田ライブ配信の発見スクリプト
 *
 * YouTube Data API の search (eventType=live) で「今ライブ中の羽田配信」を
 * パーソナライズ抜きで横断検索し、feeds.json に未登録のチャンネルを
 * discovery.json に書き出す。週 1 + 手動実行想定。
 *
 * quota: QUERIES 数 × 100 units + videos.list 数 units (~301 units/回)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const API = 'https://www.googleapis.com/youtube/v3';
const KEY = process.env.YT_API_KEY;
if (!KEY) {
  console.error('YT_API_KEY が未設定です');
  process.exit(1);
}

const QUERIES = ['羽田空港 ライブ', 'haneda airport live', 'haneda live'];

const { feeds, excludedChannels = [] } = JSON.parse(readFileSync(new URL('./feeds.json', import.meta.url), 'utf8'));
const prev = existsSync('live.json') ? JSON.parse(readFileSync('live.json', 'utf8')) : {};
// excludedChannels: 意図的に掲載をやめたチャンネル (feeds から消すと「新候補」として
// 毎週再提案されてしまうため、known 扱いに含めて discovery から除外する)
const knownChannels = new Set([
  ...feeds.map((f) => f.channelId).filter(Boolean),
  ...excludedChannels.map((e) => e.channelId).filter(Boolean),
  ...Object.values(prev.channelIds || {}),
]);

let units = 0;
async function yt(path, params, cost) {
  units += cost;
  const res = await fetch(`${API}/${path}?` + new URLSearchParams({ ...params, key: KEY }));
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/* ---- 1. ライブ横断検索 ---- */
const hits = new Map(); // videoId -> hit
for (const q of QUERIES) {
  const r = await yt('search', { part: 'snippet', q, eventType: 'live', type: 'video', maxResults: '25', relevanceLanguage: 'ja' }, 100);
  for (const it of r.items || []) {
    const vid = it.id?.videoId;
    if (!vid || hits.has(vid)) continue;
    hits.set(vid, {
      videoId: vid,
      title: it.snippet?.title || '',
      channelId: it.snippet?.channelId || null,
      channelTitle: it.snippet?.channelTitle || '',
      foundBy: q,
    });
  }
}

/* ---- 2. 未登録チャンネルに絞り、embeddable と同時視聴者数を確認 ---- */
const fresh = [...hits.values()].filter((h) => h.channelId && !knownChannels.has(h.channelId));
const meta = new Map();
const ids = fresh.map((h) => h.videoId);
for (let i = 0; i < ids.length; i += 50) {
  const r = await yt('videos', { part: 'snippet,status,liveStreamingDetails', id: ids.slice(i, i + 50).join(',') }, 1);
  for (const it of r.items || []) {
    meta.set(it.id, {
      live: it.snippet?.liveBroadcastContent === 'live',
      embeddable: it.status?.embeddable !== false,
      viewers: it.liveStreamingDetails?.concurrentViewers ?? null,
    });
  }
}

const candidates = fresh
  .map((h) => ({ ...h, ...(meta.get(h.videoId) || { live: false, embeddable: null, viewers: null }) }))
  .filter((h) => h.live)
  .sort((a, b) => (Number(b.viewers) || 0) - (Number(a.viewers) || 0));

/* ---- 3. 出力 ---- */
writeFileSync('discovery.json', JSON.stringify({
  generated_at: new Date().toISOString(),
  queries: QUERIES,
  quota_units: units,
  known_channels: knownChannels.size,
  candidates,
}, null, 2) + '\n');

console.log(`未登録チャンネルのライブ候補 ${candidates.length} 件 / quota ${units} units`);
for (const c of candidates) {
  console.log(`  ${c.embeddable ? '✅' : '⛔'} ${c.channelTitle} | ${c.title.slice(0, 60)} | viewers=${c.viewers ?? '?'} | https://youtube.com/watch?v=${c.videoId}`);
}
