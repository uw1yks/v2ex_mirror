# V2EX Mirror (Read-Only)

基于 GitHub Actions + GitHub Pages 的 V2EX 只读镜像站。

## 功能

- 每小时抓取一次 `最新` / `最热` / `节点列表` / `帖子详情` / `回复`
- 增量更新本地 JSON 数据
- `hot` 页面使用滚动热门池（默认保留最近 30 天、最多 600 条）
- 生成静态 HTML 并部署到 GitHub Pages

## 本地运行

```bash
npm install
npm run sync
npm run build
```

构建产物位于 `dist/`。

## 历史回填

用于给节点页补更多旧帖子：

```bash
npm run backfill
npm run build
```

也可以在 GitHub Actions 手动触发 `Backfill Historical Topics`，支持输入：

- `node_limit`
- `pages_per_node`
- `max_topics`
- `repair_partial_limit`
- `force_refresh`

其中 `repair_partial_limit` 会优先扫描并修复历史缓存里回复不完整的帖子，即使这些帖子已经不在当前节点前几页里。

## API 2.0（可选）

未设置 `V2EX_TOKEN` 时，项目会使用 API v1 的兼容写法抓取完整回复；设置 `V2EX_TOKEN` 后，则会优先使用 API 2.0 分页抓取。

## 目录

- `scripts/fetch/run.mjs` 抓取与增量同步
- `scripts/build/run.mjs` 静态页面构建
- `.github/workflows/sync.yml` 每小时任务和部署
- `data/` 抓取数据与状态文件

## 注意

- 本项目是非官方只读镜像，内容版权归原作者与 V2EX 所有。
- 抓取逻辑已内置限速与重试，避免高频请求。
