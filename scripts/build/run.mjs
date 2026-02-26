import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const DATA_DIR = path.join(ROOT, "data");
const DIST_DIR = path.join(ROOT, "dist");
const PAGE_SIZE = 30;

const RAW_BASE_PATH = process.env.SITE_BASE_PATH ?? "";
const BASE_PATH = normalizeBasePath(RAW_BASE_PATH);
const DEFAULT_BASE_URL = BASE_PATH ? `https://example.com${BASE_PATH}` : "https://example.com";
const SITE_BASE_URL = (process.env.SITE_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");

async function main() {
  const latest = await readJson(path.join(DATA_DIR, "index", "latest.json"), []);
  const hot = await readJson(path.join(DATA_DIR, "index", "hot.json"), []);
  const nodes = await readJson(path.join(DATA_DIR, "nodes", "all.json"), []);
  const state = await readJson(path.join(DATA_DIR, "meta", "state.json"), {});

  const topicDocs = await readTopicDocs(path.join(DATA_DIR, "topics"));
  const topicMap = new Map(topicDocs.map((doc) => [Number(doc?.topic?.id), doc.topic]));
  const nodeBuckets = groupByNode([...topicMap.values()]);

  await fs.rm(DIST_DIR, { recursive: true, force: true });
  await fs.mkdir(DIST_DIR, { recursive: true });

  await copyStaticAssets();
  await buildIndexPages({
    title: "V2EX 镜像 - 最新",
    basePath: "/",
    items: latest,
    topicMap,
    heading: "最新帖子",
    state
  });
  await buildIndexPages({
    title: "V2EX 镜像 - 最热",
    basePath: "/hot",
    items: hot,
    topicMap,
    heading: "热门帖子",
    state
  });
  await buildNodesPage(nodes, nodeBuckets, state);
  await buildNodeTopicPages(nodes, nodeBuckets, state);
  await buildTopicPages(topicMap, state);
  await buildAboutPage(state);
  await buildSitemap(topicMap);

  console.log(
    `Build done. latest=${latest.length} hot=${hot.length} nodes=${nodes.length} topics=${topicMap.size} basePath=${BASE_PATH || "/"}`
  );
}

async function buildIndexPages({ title, basePath, items, topicMap, heading, state }) {
  const pages = paginate(items, PAGE_SIZE);
  for (let i = 0; i < pages.length; i += 1) {
    const pageNo = i + 1;
    const rows = pages[i]
      .map((item) => {
        const id = Number(item?.id ?? 0);
        const topic = topicMap.get(id) ?? item;
        const replies = Number(topic?.replies ?? item?.replies ?? 0);
        const node = topic?.node?.name
          ? `<a href="${url(`/nodes/${escapeAttr(topic.node.name)}/`)}">${escapeHtml(topic.node.title ?? topic.node.name)}</a>`
          : "-";
        const author = escapeHtml(topic?.member?.username ?? "-");
        return `<li class="topic-item">
  <a class="topic-title" href="${url(`/t/${id}/`)}">${escapeHtml(topic?.title ?? "(无标题)")}</a>
  <div class="meta">#${id} · ${node} · ${author} · 回复 ${replies}</div>
</li>`;
      })
      .join("\n");

    const pager = paginationHtml(basePath, pageNo, pages.length);
    const html = layout({
      pageTitle: `${title}${pages.length > 1 ? ` - 第 ${pageNo} 页` : ""}`,
      body: `
<h1>${escapeHtml(heading)}</h1>
${siteNav(basePath)}
<ul class="topic-list">
${rows}
</ul>
${pager}
${syncInfo(state)}
`
    });

    const outDir =
      basePath === "/"
        ? pageNo === 1
          ? DIST_DIR
          : path.join(DIST_DIR, "page", String(pageNo))
        : pageNo === 1
          ? path.join(DIST_DIR, trimStartSlash(basePath))
          : path.join(DIST_DIR, trimStartSlash(basePath), "page", String(pageNo));

    await writeFile(path.join(outDir, "index.html"), html);
  }
}

async function buildNodesPage(nodes, nodeBuckets, state) {
  const rows = nodes
    .map((node) => {
      const count = nodeBuckets.get(node.name)?.length ?? 0;
      return `<li class="node-item">
  <a href="${url(`/nodes/${escapeAttr(node.name)}/`)}">${escapeHtml(node.title ?? node.name)}</a>
  <span class="meta">${escapeHtml(node.name)} · 本地镜像帖子 ${count}</span>
</li>`;
    })
    .join("\n");

  const html = layout({
    pageTitle: "V2EX 镜像 - 节点",
    body: `
<h1>节点列表</h1>
${siteNav("/nodes")}
<ul class="node-list">
${rows}
</ul>
${syncInfo(state)}
`
  });
  await writeFile(path.join(DIST_DIR, "nodes", "index.html"), html);
}

async function buildNodeTopicPages(nodes, nodeBuckets, state) {
  for (const node of nodes) {
    const topics = (nodeBuckets.get(node.name) ?? []).sort(
      (a, b) => Number(b.last_modified ?? 0) - Number(a.last_modified ?? 0)
    );
    const rows = topics
      .map(
        (topic) => `<li class="topic-item">
  <a class="topic-title" href="${url(`/t/${topic.id}/`)}">${escapeHtml(topic.title ?? "(无标题)")}</a>
  <div class="meta">#${topic.id} · ${escapeHtml(topic.member?.username ?? "-")} · 回复 ${Number(topic.replies ?? 0)}</div>
</li>`
      )
      .join("\n");

    const html = layout({
      pageTitle: `V2EX 镜像 - ${node.title ?? node.name}`,
      body: `
<h1>节点: ${escapeHtml(node.title ?? node.name)}</h1>
${siteNav(`/nodes/${node.name}`)}
<ul class="topic-list">
${rows || '<li class="empty">当前镜像中暂无该节点帖子</li>'}
</ul>
${syncInfo(state)}
`
    });
    await writeFile(path.join(DIST_DIR, "nodes", node.name, "index.html"), html);
  }
}

async function buildTopicPages(topicMap, state) {
  const repliesDir = path.join(DATA_DIR, "replies");
  for (const [id, topic] of topicMap.entries()) {
    const repliesDoc = await readJson(path.join(repliesDir, `${id}.json`), { replies: [] });
    const replies = Array.isArray(repliesDoc.replies) ? repliesDoc.replies : [];
    const replyRows = replies
      .map(
        (reply) => `<li class="reply-item">
  <div class="meta">#${reply.id} · ${escapeHtml(reply.member?.username ?? "-")}</div>
  <article class="content">${reply.content_rendered ?? `<p>${escapeHtml(reply.content ?? "")}</p>`}</article>
</li>`
      )
      .join("\n");

    const nodeName = topic.node?.name ?? "";
    const html = layout({
      pageTitle: `V2EX 镜像 - ${topic.title ?? id}`,
      body: `
<h1>${escapeHtml(topic.title ?? "(无标题)")}</h1>
${siteNav(`/t/${id}`)}
<div class="meta-line">
  <span>#${id}</span>
  <span>作者 ${escapeHtml(topic.member?.username ?? "-")}</span>
  <span>节点 <a href="${url(`/nodes/${escapeAttr(nodeName)}/`)}">${escapeHtml(topic.node?.title ?? nodeName || "-")}</a></span>
  <span>回复 ${Number(topic.replies ?? 0)}</span>
  <a href="${escapeAttr(topic.url ?? `https://www.v2ex.com/t/${id}`)}" target="_blank" rel="noopener noreferrer">原帖</a>
</div>
<article class="content">${topic.content_rendered ?? `<p>${escapeHtml(topic.content ?? "")}</p>`}</article>
<h2>回复</h2>
<ul class="reply-list">
${replyRows || '<li class="empty">暂无回复</li>'}
</ul>
${syncInfo(state)}
`
    });
    await writeFile(path.join(DIST_DIR, "t", String(id), "index.html"), html);
  }
}

async function buildAboutPage(state) {
  const html = layout({
    pageTitle: "V2EX 镜像 - 关于",
    body: `
<h1>关于本站</h1>
${siteNav("/about")}
<p>这是一个非官方的 V2EX 只读镜像站，用于浏览公开帖子内容。</p>
<p>数据来源于 V2EX 公开 API，内容版权归原作者与 V2EX 所有。</p>
<p>本站不提供登录、发帖、回帖等功能。</p>
${syncInfo(state)}
`
  });
  await writeFile(path.join(DIST_DIR, "about", "index.html"), html);
}

async function buildSitemap(topicMap) {
  const paths = ["/", "/hot/", "/nodes/", "/about/", ...[...topicMap.keys()].map((id) => `/t/${id}/`)];
  const body = paths
    .map((p) => `<url><loc>${escapeXml(absoluteUrl(p))}</loc></url>`)
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`;
  await writeFile(path.join(DIST_DIR, "sitemap.xml"), xml);
}

function groupByNode(topics) {
  const map = new Map();
  for (const topic of topics) {
    const nodeName = topic?.node?.name;
    if (!nodeName) continue;
    if (!map.has(nodeName)) map.set(nodeName, []);
    map.get(nodeName).push(topic);
  }
  return map;
}

function siteNav(current) {
  const links = [
    ["/", "最新"],
    ["/hot/", "最热"],
    ["/nodes/", "节点"],
    ["/about/", "关于"]
  ];
  const currentNormalized = normalizeSlash(current);
  return `<nav class="nav">${links
    .map(([href, label]) => `<a class="${normalizeSlash(href) === currentNormalized ? "active" : ""}" href="${url(href)}">${label}</a>`)
    .join("")}</nav>`;
}

function syncInfo(state) {
  const ts = state?.last_success_at
    ? new Date(state.last_success_at).toLocaleString("zh-CN", { hour12: false })
    : "未知";
  return `<footer class="sync-info">最后同步时间: ${escapeHtml(ts)} · 数据来源: V2EX 公开 API</footer>`;
}

function paginationHtml(basePath, pageNo, totalPages) {
  if (totalPages <= 1) return "";
  const prev = pageNo > 1 ? pagePath(basePath, pageNo - 1) : null;
  const next = pageNo < totalPages ? pagePath(basePath, pageNo + 1) : null;
  return `<div class="pager">
  <span>第 ${pageNo} / ${totalPages} 页</span>
  ${prev ? `<a href="${url(prev)}">上一页</a>` : '<span class="disabled">上一页</span>'}
  ${next ? `<a href="${url(next)}">下一页</a>` : '<span class="disabled">下一页</span>'}
</div>`;
}

function pagePath(basePath, pageNo) {
  if (basePath === "/") return pageNo === 1 ? "/" : `/page/${pageNo}/`;
  return pageNo === 1 ? normalizeSlash(basePath) : `${normalizeSlash(basePath)}page/${pageNo}/`;
}

function absoluteUrl(localPath) {
  return `${SITE_BASE_URL}${url(localPath)}`;
}

function url(localPath) {
  const p = localPath.startsWith("/") ? localPath : `/${localPath}`;
  return `${BASE_PATH}${p}`.replace(/\/{2,}/g, "/");
}

function normalizeBasePath(p) {
  const trimmed = String(p ?? "").trim();
  if (!trimmed || trimmed === "/") return "";
  const start = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return start.endsWith("/") ? start.slice(0, -1) : start;
}

function normalizeSlash(p) {
  return p.endsWith("/") ? p : `${p}/`;
}

function trimStartSlash(p) {
  return p.startsWith("/") ? p.slice(1) : p;
}

function paginate(items, size) {
  if (!items.length) return [[]];
  const pages = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  return pages;
}

function layout({ pageTitle, body }) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="V2EX 只读镜像站">
  <link rel="stylesheet" href="${url("/assets/style.css")}">
</head>
<body>
  <main class="container">
    ${body}
  </main>
</body>
</html>`;
}

async function copyStaticAssets() {
  const srcDir = path.join(ROOT, "site", "assets");
  const outDir = path.join(DIST_DIR, "assets");
  await fs.mkdir(outDir, { recursive: true });
  const files = await fs.readdir(srcDir);
  for (const file of files) {
    const src = path.join(srcDir, file);
    const dst = path.join(outDir, file);
    await fs.copyFile(src, dst);
  }
}

function escapeHtml(input) {
  return String(input ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(input) {
  return escapeHtml(input).replaceAll("`", "&#96;");
}

function escapeXml(input) {
  return String(input ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function readJson(file, fallback) {
  try {
    const txt = await fs.readFile(file, "utf8");
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

async function readTopicDocs(dir) {
  try {
    const files = await fs.readdir(dir);
    const docs = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const doc = await readJson(path.join(dir, file), null);
      if (doc?.topic?.id) docs.push(doc);
    }
    return docs;
  } catch {
    return [];
  }
}

async function writeFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

