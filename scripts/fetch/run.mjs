import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const INDEX_DIR = path.join(DATA_DIR, "index");
const NODES_DIR = path.join(DATA_DIR, "nodes");
const TOPICS_DIR = path.join(DATA_DIR, "topics");
const REPLIES_DIR = path.join(DATA_DIR, "replies");
const META_DIR = path.join(DATA_DIR, "meta");
const STATE_FILE = path.join(META_DIR, "state.json");
const LAST_RUN_FILE = path.join(META_DIR, "last_run.json");
const HOT_POOL_FILE = path.join(INDEX_DIR, "hot_pool.json");

const BASE_V1 = "https://www.v2ex.com/api";
const BASE_V2 = "https://www.v2ex.com/api/v2";
const CONFIG = {
  concurrency: Number(process.env.FETCH_CONCURRENCY ?? 2),
  intervalMs: Number(process.env.FETCH_INTERVAL_MS ?? 350),
  refreshTtlHours: Number(process.env.TOPIC_REFRESH_TTL_HOURS ?? 24),
  retries: 3,
  hotPoolLimit: Number(process.env.HOT_POOL_LIMIT ?? 600),
  hotPoolTtlDays: Number(process.env.HOT_POOL_TTL_DAYS ?? 30)
};

const endpoints = {
  latest: `${BASE_V1}/topics/latest.json`,
  hot: `${BASE_V1}/topics/hot.json`,
  nodes: `${BASE_V1}/nodes/all.json`,
  topicById: (id) => `${BASE_V1}/topics/show.json?id=${id}`,
  repliesByTopicId: (id) => `${BASE_V1}/replies/show.json?topic_id=${id}`,
  v2Replies: (id, p) => `${BASE_V2}/topics/${id}/replies?p=${p}`
};

let nextAllowedAt = 0;

async function main() {
  const startedAt = new Date().toISOString();
  await ensureDirs([INDEX_DIR, NODES_DIR, TOPICS_DIR, REPLIES_DIR, META_DIR]);

  const previousState = await readJson(STATE_FILE, {});
  const report = {
    started_at: startedAt,
    finished_at: null,
    config: CONFIG,
    lists: {},
    topics: {
      candidates: 0,
      refreshed: 0,
      skipped: 0,
      failed: []
    }
  };

  const latest = await fetchAndPersistList("latest", endpoints.latest, path.join(INDEX_DIR, "latest.json"), report);
  const hot = await fetchAndPersistList("hot", endpoints.hot, path.join(INDEX_DIR, "hot.json"), report);
  const hotPool = await updateHotPool(hot);
  report.lists.hot_pool = { status: "updated", count: hotPool.length, source: HOT_POOL_FILE };
  await fetchAndPersistList("nodes", endpoints.nodes, path.join(NODES_DIR, "all.json"), report);

  const candidates = dedupeTopicIds([...(latest ?? []), ...(hotPool ?? [])]);
  report.topics.candidates = candidates.length;

  const ttlMs = CONFIG.refreshTtlHours * 60 * 60 * 1000;
  const now = Date.now();

  for (const topicId of candidates) {
    const topicFile = path.join(TOPICS_DIR, `${topicId}.json`);
    const repliesFile = path.join(REPLIES_DIR, `${topicId}.json`);
    const existingTopicDoc = await readJson(topicFile, null);
    const existingRepliesDoc = await readJson(repliesFile, null);
    const listSnapshot = snapshotFromLists(topicId, latest, hot);

    const shouldRefreshTopic = decideRefreshTopic({
      existingTopicDoc,
      listSnapshot,
      now,
      ttlMs
    });

    try {
      let topic = existingTopicDoc?.topic ?? null;

      if (shouldRefreshTopic) {
        topic = await fetchTopic(topicId);
        if (!topic) {
          throw new Error(`Empty topic payload for ${topicId}`);
        }
        const topicDoc = {
          topic,
          meta: {
            fetched_at: new Date().toISOString(),
            source: endpoints.topicById(topicId),
            list_snapshot: listSnapshot
          }
        };
        await writeJsonAtomic(topicFile, topicDoc);
        report.topics.refreshed += 1;
      } else {
        report.topics.skipped += 1;
      }

      const shouldRefreshReplies =
        shouldRefreshTopic ||
        !existingRepliesDoc ||
        Number(existingRepliesDoc?.meta?.reply_count ?? -1) !== Number(topic?.replies ?? -2);

      if (shouldRefreshReplies && topic) {
        const replies = await fetchReplies(topicId);
        const totalCount = Number(topic.replies ?? replies.length);
        const fetchedCount = Array.isArray(replies) ? replies.length : 0;
        const repliesDoc = {
          replies,
          meta: {
            fetched_at: new Date().toISOString(),
            source: endpoints.repliesByTopicId(topicId),
            reply_count: totalCount,
            total_count: totalCount,
            fetched_count: fetchedCount,
            partial: fetchedCount < totalCount
          }
        };
        await writeJsonAtomic(repliesFile, repliesDoc);
      }
    } catch (error) {
      report.topics.failed.push({
        topic_id: topicId,
        error: String(error.message ?? error)
      });
      console.error(`[topic ${topicId}] ${error.message ?? error}`);
    }
  }

  const nextState = {
    last_success_at: new Date().toISOString(),
    candidate_topic_ids: candidates,
    refreshed_topic_count: report.topics.refreshed,
    failed_topic_count: report.topics.failed.length,
    previous_last_success_at: previousState.last_success_at ?? null
  };

  report.finished_at = new Date().toISOString();
  await writeJsonAtomic(STATE_FILE, nextState);
  await writeJsonAtomic(LAST_RUN_FILE, report);

  console.log(
    `Sync done. candidates=${report.topics.candidates} refreshed=${report.topics.refreshed} skipped=${report.topics.skipped} failed=${report.topics.failed.length}`
  );
}

async function updateHotPool(currentHot) {
  const prevPool = await readJson(HOT_POOL_FILE, []);
  const merged = mergeTopicLists(prevPool, currentHot ?? []);
  const ttlMs = CONFIG.hotPoolTtlDays * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const pruned = merged.filter((item) => {
    const ts = Number(item?.last_touched ?? item?.last_modified ?? item?.created ?? 0) * 1000;
    if (!Number.isFinite(ts) || ts <= 0) return true;
    return now - ts <= ttlMs;
  });
  const limited = pruned.slice(0, Math.max(1, CONFIG.hotPoolLimit));
  await writeJsonAtomic(HOT_POOL_FILE, limited);
  return limited;
}

function mergeTopicLists(a, b) {
  const map = new Map();
  for (const item of [...(a ?? []), ...(b ?? [])]) {
    const id = Number(item?.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const prev = map.get(id);
    if (!prev) {
      map.set(id, item);
      continue;
    }
    const prevScore = topicFreshness(prev);
    const curScore = topicFreshness(item);
    if (curScore >= prevScore) map.set(id, item);
  }
  return [...map.values()].sort((x, y) => topicFreshness(y) - topicFreshness(x));
}

function topicFreshness(topic) {
  return Number(topic?.last_touched ?? topic?.last_modified ?? topic?.created ?? 0);
}

async function fetchAndPersistList(name, url, filePath, report) {
  const fallback = await readJson(filePath, []);
  try {
    const data = await fetchJsonWithRetry(url);
    await writeJsonAtomic(filePath, data);
    report.lists[name] = {
      status: "fetched",
      count: Array.isArray(data) ? data.length : 0,
      source: url
    };
    return data;
  } catch (error) {
    report.lists[name] = {
      status: "fallback",
      count: Array.isArray(fallback) ? fallback.length : 0,
      source: url,
      error: String(error.message ?? error)
    };
    console.error(`[list:${name}] fallback to existing data: ${error.message ?? error}`);
    return fallback;
  }
}

function decideRefreshTopic({ existingTopicDoc, listSnapshot, now, ttlMs }) {
  if (!existingTopicDoc?.topic) return true;
  const prevFetchedAt = Date.parse(existingTopicDoc?.meta?.fetched_at ?? "");
  if (!Number.isFinite(prevFetchedAt)) return true;
  if (now - prevFetchedAt > ttlMs) return true;

  const prev = existingTopicDoc?.meta?.list_snapshot ?? {};
  const sameReplies = Number(prev.replies ?? -1) === Number(listSnapshot.replies ?? -2);
  const sameTouched = Number(prev.last_modified ?? -1) === Number(listSnapshot.last_modified ?? -2);
  return !(sameReplies && sameTouched);
}

function dedupeTopicIds(items) {
  const set = new Set();
  for (const item of items) {
    const id = Number(item?.id);
    if (Number.isFinite(id) && id > 0) set.add(id);
  }
  return [...set];
}

function snapshotFromLists(topicId, latest, hot) {
  const hit = [...(latest ?? []), ...(hot ?? [])].find((t) => Number(t?.id) === Number(topicId));
  return {
    id: Number(topicId),
    replies: Number(hit?.replies ?? 0),
    last_modified: Number(hit?.last_modified ?? hit?.last_touched ?? 0)
  };
}

async function fetchTopic(topicId) {
  const data = await fetchJsonWithRetry(endpoints.topicById(topicId));
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0];
}

async function fetchReplies(topicId) {
  const token = process.env.V2EX_TOKEN;
  if (!token) {
    const data = await fetchJsonWithRetry(endpoints.repliesByTopicId(topicId));
    return Array.isArray(data) ? data : [];
  }

  const all = [];
  for (let p = 1; p <= 50; p += 1) {
    const page = await fetchJsonWithRetry(endpoints.v2Replies(topicId, p), {
      authToken: token
    });
    const items = Array.isArray(page?.result) ? page.result : Array.isArray(page) ? page : [];
    if (!items.length) break;
    all.push(...items);
    if (items.length < 50) break;
  }
  return all;
}

async function fetchJsonWithRetry(url, options = {}) {
  let lastError = null;
  for (let i = 0; i < CONFIG.retries; i += 1) {
    try {
      await waitRateLimit();
      const response = await fetch(url, {
        headers: {
          "User-Agent": "v2ex-mirror/0.1 (+https://github.com/)",
          ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {})
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      const backoff = CONFIG.intervalMs * (i + 1) * 2;
      await sleep(backoff);
    }
  }
  throw lastError ?? new Error(`Request failed: ${url}`);
}

async function waitRateLimit() {
  const now = Date.now();
  if (now < nextAllowedAt) {
    await sleep(nextAllowedAt - now);
  }
  nextAllowedAt = Date.now() + CONFIG.intervalMs;
}

async function readJson(file, fallback) {
  try {
    const txt = await fs.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(file, data) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

async function ensureDirs(dirs) {
  await Promise.all(dirs.map((dir) => fs.mkdir(dir, { recursive: true })));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
