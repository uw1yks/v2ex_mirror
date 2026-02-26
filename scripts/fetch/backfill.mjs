import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const NODES_DIR = path.join(DATA_DIR, "nodes");
const TOPICS_DIR = path.join(DATA_DIR, "topics");
const REPLIES_DIR = path.join(DATA_DIR, "replies");
const META_DIR = path.join(DATA_DIR, "meta");
const REPORT_FILE = path.join(META_DIR, "backfill_last_run.json");

const BASE = "https://www.v2ex.com/api";
const CONFIG = {
  nodeLimit: Number(process.env.BACKFILL_NODE_LIMIT ?? 40),
  pagesPerNode: Number(process.env.BACKFILL_PAGES_PER_NODE ?? 3),
  maxTopics: Number(process.env.BACKFILL_MAX_TOPICS ?? 2000),
  intervalMs: Number(process.env.FETCH_INTERVAL_MS ?? 350),
  retries: Number(process.env.FETCH_RETRIES ?? 3),
  forceRefresh: String(process.env.BACKFILL_FORCE_REFRESH ?? "false").toLowerCase() === "true"
};

const endpoints = {
  nodes: `${BASE}/nodes/all.json`,
  nodeTopics: (nodeName, p) => `${BASE}/topics/show.json?node_name=${encodeURIComponent(nodeName)}&p=${p}`,
  topicById: (id) => `${BASE}/topics/show.json?id=${id}`,
  repliesByTopicId: (id) => `${BASE}/replies/show.json?topic_id=${id}`
};

let nextAllowedAt = 0;

async function main() {
  const startedAt = new Date().toISOString();
  await ensureDirs([NODES_DIR, TOPICS_DIR, REPLIES_DIR, META_DIR]);

  const report = {
    started_at: startedAt,
    finished_at: null,
    config: CONFIG,
    nodes: {
      scanned: 0,
      selected: 0
    },
    candidates: 0,
    topic_detail_fetched: 0,
    topic_detail_skipped: 0,
    replies_fetched: 0,
    replies_skipped: 0,
    failed: []
  };

  const nodes = await loadNodes();
  report.nodes.scanned = nodes.length;
  const selectedNodes = nodes.slice(0, CONFIG.nodeLimit);
  report.nodes.selected = selectedNodes.length;

  const candidateIds = await collectCandidateTopicIds(selectedNodes);
  report.candidates = candidateIds.length;

  for (const topicId of candidateIds) {
    const topicFile = path.join(TOPICS_DIR, `${topicId}.json`);
    const repliesFile = path.join(REPLIES_DIR, `${topicId}.json`);
    const existingTopicDoc = await readJson(topicFile, null);
    const existingRepliesDoc = await readJson(repliesFile, null);

    try {
      let topic = existingTopicDoc?.topic ?? null;
      if (!topic || CONFIG.forceRefresh) {
        topic = await fetchTopic(topicId);
        if (!topic) throw new Error(`Empty topic payload for ${topicId}`);
        await writeJsonAtomic(topicFile, {
          topic,
          meta: {
            fetched_at: new Date().toISOString(),
            source: endpoints.topicById(topicId),
            reason: "backfill"
          }
        });
        report.topic_detail_fetched += 1;
      } else {
        report.topic_detail_skipped += 1;
      }

      const shouldFetchReplies =
        CONFIG.forceRefresh ||
        !existingRepliesDoc ||
        Number(existingRepliesDoc?.meta?.reply_count ?? -1) !== Number(topic?.replies ?? -2);

      if (shouldFetchReplies && topic) {
        const replies = await fetchReplies(topicId);
        await writeJsonAtomic(repliesFile, {
          replies,
          meta: {
            fetched_at: new Date().toISOString(),
            source: endpoints.repliesByTopicId(topicId),
            reply_count: Number(topic.replies ?? replies.length),
            reason: "backfill"
          }
        });
        report.replies_fetched += 1;
      } else {
        report.replies_skipped += 1;
      }
    } catch (error) {
      report.failed.push({ topic_id: topicId, error: String(error.message ?? error) });
      console.error(`[backfill topic ${topicId}] ${error.message ?? error}`);
    }
  }

  report.finished_at = new Date().toISOString();
  await writeJsonAtomic(REPORT_FILE, report);
  console.log(
    `Backfill done. nodes=${report.nodes.selected} candidates=${report.candidates} topicFetched=${report.topic_detail_fetched} repliesFetched=${report.replies_fetched} failed=${report.failed.length}`
  );
}

async function loadNodes() {
  const localPath = path.join(NODES_DIR, "all.json");
  const local = await readJson(localPath, null);
  if (Array.isArray(local) && local.length > 0) {
    return sortNodes(local);
  }
  const remote = await fetchJsonWithRetry(endpoints.nodes);
  await writeJsonAtomic(localPath, remote);
  return sortNodes(remote);
}

function sortNodes(nodes) {
  return [...(Array.isArray(nodes) ? nodes : [])]
    .filter((n) => n?.name)
    .sort((a, b) => Number(b?.topics ?? 0) - Number(a?.topics ?? 0));
}

async function collectCandidateTopicIds(nodes) {
  const set = new Set();
  for (const node of nodes) {
    for (let p = 1; p <= CONFIG.pagesPerNode; p += 1) {
      const url = endpoints.nodeTopics(node.name, p);
      try {
        const pageTopics = await fetchJsonWithRetry(url);
        if (!Array.isArray(pageTopics) || pageTopics.length === 0) {
          if (p === 1) {
            console.warn(`[backfill node ${node.name}] empty first page`);
          }
          break;
        }
        for (const topic of pageTopics) {
          const id = Number(topic?.id);
          if (Number.isFinite(id) && id > 0) set.add(id);
          if (set.size >= CONFIG.maxTopics) return [...set];
        }
      } catch (error) {
        console.error(`[backfill node ${node.name} p=${p}] ${error.message ?? error}`);
        break;
      }
    }
  }
  return [...set];
}

async function fetchTopic(topicId) {
  const data = await fetchJsonWithRetry(endpoints.topicById(topicId));
  if (!Array.isArray(data) || data.length === 0) return null;
  return data[0];
}

async function fetchReplies(topicId) {
  const data = await fetchJsonWithRetry(endpoints.repliesByTopicId(topicId));
  return Array.isArray(data) ? data : [];
}

async function fetchJsonWithRetry(url) {
  let lastError = null;
  for (let i = 0; i < CONFIG.retries; i += 1) {
    try {
      await waitRateLimit();
      const response = await fetch(url, {
        headers: {
          "User-Agent": "v2ex-mirror/0.1 (+https://github.com/)"
        }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
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
  if (now < nextAllowedAt) await sleep(nextAllowedAt - now);
  nextAllowedAt = Date.now() + CONFIG.intervalMs;
}

async function ensureDirs(dirs) {
  await Promise.all(dirs.map((dir) => fs.mkdir(dir, { recursive: true })));
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
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

