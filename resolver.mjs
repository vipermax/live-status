/* 羽田マルチビュー live-status resolver
 *
 * 各フィードの「現在ライブ中の videoId」を解決して live.json を書き出す。
 * GitHub Actions (5 分 cron) から実行される前提。Node 20+、依存パッケージなし。
 *
 * quota 設計 (YouTube Data API v3, default 10,000 units/日):
 *   - channels.list / videos.list = 1 unit。通常回はこれだけ (~300 units/日)
 *   - search.list = 100 units。videoId が死んだ時の再発見のみ。1 実行あたり
 *     MAX_SEARCH 回まで (暴走で quota を焼かないための上限)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const API = 'https://www.googleapis.com/youtube/v3';
const KEY = process.env.YT_API_KEY;
const MAX_SEARCH = 3;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

if (!KEY) {
  console.error('YT_API_KEY が未設定です (repo Settings → Secrets → Actions)');
  process.exit(1);
}

const { feeds } = JSON.parse(readFileSync(new URL('./feeds.json', import.meta.url), 'utf8'));
const prev = existsSync('live.json') ? JSON.parse(readFileSync('live.json', 'utf8')) : {};
const prevFeeds = prev.feeds || {};
const channelIds = { ...(prev.channelIds || {}) };
const now = new Date().toISOString();

let unitsUsed = 0;
let searchUsed = 0;

async function yt(path, params, cost) {
  unitsUsed += cost;
  const res = await fetch(`${API}/${path}?` + new URLSearchParams({ ...params, key: KEY }));
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function jstHour() {
  return Number(new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: 'numeric', hour12: false }).format(new Date()));
}
function feedActiveNow(f) {
  return !f.activeHoursJst || (jstHour() >= f.activeHoursJst[0] && jstHour() < f.activeHoursJst[1]);
}
const cidOf = (f) => f.channelId || channelIds[f.handle] || null;

/* ---- 1. handle → channelId (channels.list forHandle, 結果は live.json にキャッシュ) ---- */
for (const f of feeds) {
  if (!cidOf(f) && f.handle) {
    try {
      const r = await yt('channels', { part: 'id', forHandle: f.handle }, 1);
      if (r.items?.[0]?.id) channelIds[f.handle] = r.items[0].id;
    } catch (e) {
      console.warn(`channelId 解決失敗 ${f.handle}: ${e.message}`);
    }
  }
}

/* ---- 2. 既知 videoId の生存確認 (videos.list 50 件バッチ = 1 unit) ---- */
const candidateOf = (f) => prevFeeds[f.id]?.videoId || f.fallbackVideoId || null;
const vidInfo = new Map();
const allIds = [...new Set(feeds.map(candidateOf).filter(Boolean))];
for (let i = 0; i < allIds.length; i += 50) {
  const r = await yt('videos', { part: 'snippet,status', id: allIds.slice(i, i + 50).join(',') }, 1);
  for (const it of r.items || []) {
    vidInfo.set(it.id, {
      live: it.snippet?.liveBroadcastContent === 'live',
      title: it.snippet?.title || '',
      embeddable: it.status?.embeddable !== false,
    });
  }
}

const out = {};
const dead = [];
for (const f of feeds) {
  const vid = candidateOf(f);
  const info = vid ? vidInfo.get(vid) : null;
  if (info?.live) {
    out[f.id] = { videoId: vid, isLive: true, title: info.title, embeddable: info.embeddable, checkedAt: now };
  } else {
    dead.push(f);
  }
}

/* ---- 3. 死んだフィードの再発見 ---- */

async function scrapeChannelLive(cid) {
  // /channel/<id>/live の canonical から現ライブ videoId を抽出 (quota 0)
  try {
    const res = await fetch(`https://www.youtube.com/channel/${cid}/live`, {
      headers: { 'user-agent': UA, 'accept-language': 'ja,en', cookie: 'CONSENT=YES+1' },
    });
    const html = await res.text();
    const m = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{11})"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const assigned = new Set(Object.values(out).map((e) => e.videoId));
const deadByChannel = new Map();
for (const f of dead) {
  const cid = cidOf(f);
  if (!cid || !feedActiveNow(f)) {
    out[f.id] = { videoId: null, isLive: false, title: null, embeddable: null, checkedAt: now };
    continue;
  }
  if (!deadByChannel.has(cid)) deadByChannel.set(cid, []);
  deadByChannel.get(cid).push(f);
}

for (const [cid, group] of deadByChannel) {
  const channelFeedTotal = feeds.filter((f) => cidOf(f) === cid).length;
  let lives = []; // {videoId, title}

  if (channelFeedTotal === 1) {
    const vid = await scrapeChannelLive(cid);
    if (vid && !assigned.has(vid)) {
      const r = await yt('videos', { part: 'snippet,status', id: vid }, 1);
      const it = r.items?.[0];
      if (it?.snippet?.liveBroadcastContent === 'live') {
        lives = [{ videoId: vid, title: it.snippet.title, embeddable: it.status?.embeddable !== false }];
      }
    }
    // GH runner の IP には YouTube が consent/bot ページを返して scrape が失敗することがある
    // → 取れなかった場合は search.list にフォールバック (quota 100u、MAX_SEARCH の枠内)
    if (!lives.length && searchUsed < MAX_SEARCH) {
      searchUsed += 1;
      try {
        const r = await yt('search', { part: 'snippet', channelId: cid, eventType: 'live', type: 'video', maxResults: '5' }, 100);
        lives = (r.items || [])
          .map((it) => ({ videoId: it.id?.videoId, title: it.snippet?.title || '', embeddable: true }))
          .filter((l) => l.videoId && !assigned.has(l.videoId));
      } catch (e) {
        console.warn(`search フォールバック失敗 ${cid}: ${e.message}`);
      }
    }
  } else if (searchUsed < MAX_SEARCH) {
    // 同一チャンネル複数ライブ → search.list で全ライブ列挙し title で振り分け
    searchUsed += 1;
    try {
      const r = await yt('search', { part: 'snippet', channelId: cid, eventType: 'live', type: 'video', maxResults: '10' }, 100);
      lives = (r.items || [])
        .map((it) => ({ videoId: it.id?.videoId, title: it.snippet?.title || '', embeddable: true }))
        .filter((l) => l.videoId && !assigned.has(l.videoId));
    } catch (e) {
      console.warn(`search 失敗 ${cid}: ${e.message}`);
    }
  } else {
    console.warn(`search 上限 (${MAX_SEARCH}) 到達。channel ${cid} は次回回し`);
  }

  for (const f of group) {
    const re = f.titleMatch ? new RegExp(f.titleMatch, 'i') : null;
    let pick = re ? lives.find((l) => !assigned.has(l.videoId) && re.test(l.title)) : null;
    // titleMatch で決まらず、残りライブと残りフィードが 1:1 なら消去法で割当
    if (!pick) {
      const rest = lives.filter((l) => !assigned.has(l.videoId));
      if (rest.length === 1 && group.filter((g) => !out[g.id]).length === 1) pick = rest[0];
    }
    if (pick) {
      assigned.add(pick.videoId);
      out[f.id] = { videoId: pick.videoId, isLive: true, title: pick.title, embeddable: pick.embeddable, checkedAt: now };
    } else {
      out[f.id] = { videoId: null, isLive: false, title: null, embeddable: null, checkedAt: now };
    }
  }
}

/* ---- 4. 出力 ---- */
writeFileSync('live.json', JSON.stringify({ generated_at: now, channelIds, feeds: out }, null, 2) + '\n');

const liveCount = Object.values(out).filter((e) => e.isLive).length;
console.log(`live ${liveCount}/${feeds.length} 件 / quota ${unitsUsed} units (search ${searchUsed} 回)`);
for (const [id, e] of Object.entries(out)) {
  console.log(`  ${e.isLive ? '●' : '○'} ${id.padEnd(12)} ${e.videoId || '-'} ${e.title ? e.title.slice(0, 60) : ''}`);
}
