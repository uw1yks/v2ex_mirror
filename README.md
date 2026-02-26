# V2EX Mirror (Read-Only)

基于 GitHub Actions + GitHub Pages 的 V2EX 只读镜像站。

## 功能

- 每小时抓取一次 `最新` / `最热` / `节点列表` / `帖子详情` / `回复`
- 增量更新本地 JSON 数据
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
- `force_refresh`

## 目录

- `scripts/fetch/run.mjs` 抓取与增量同步
- `scripts/build/run.mjs` 静态页面构建
- `.github/workflows/sync.yml` 每小时任务和部署
- `data/` 抓取数据与状态文件

## 注意

- 本项目是非官方只读镜像，内容版权归原作者与 V2EX 所有。
- 抓取逻辑已内置限速与重试，避免高频请求。
