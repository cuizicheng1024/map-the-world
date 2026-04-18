# Global AI Talent Distribution

这个目录是一个可直接部署到 GitHub Pages 的静态项目，用来把 “AI 人才流动（时间 + 空间）” 和 “人 / 公司关系网（知识图谱）” 做成可交互的可视化 Demo。

## 你能看到什么

- 时间轴动态地图：按年份播放/拖动，展示每一年“谁在什么城市、哪个公司”
- 知识图谱：把人、公司、投资机构抽象为节点，用边表达关系；双击节点可跳转到地图并自动过滤

## 入口

- 文档页：`/Global_AI_Talent_Distribution/`
- 时间轴地图：`/Global_AI_Talent_Distribution/app/map.html`
- 关系网：`/Global_AI_Talent_Distribution/app/graph.html`

本地预览（在 `map-the-world` 目录下）：

```bash
python3 -m http.server 5173
```

然后打开：

- http://localhost:5173/Global_AI_Talent_Distribution/app/map.html
- http://localhost:5173/Global_AI_Talent_Distribution/app/graph.html

## 数据文件

### 迁徙数据（GeoJSON）

文件：`data/movements.geojson`

每一条 Feature 是一个点：表示“某人某年在某城市某公司”。

- `properties.person_name`：姓名
- `properties.person_id`：稳定 ID（当前允许直接用姓名；后续可替换为 hash / wikidata QID / 企业统一 ID）
- `properties.org_name / org_id`：公司/机构
- `properties.city / country`：城市与国家/地区
- `properties.year`：年份（整数）
- `geometry.coordinates`：`[lon, lat]`

### 关系网（Graph JSON）

文件：`data/relations.json`

- `nodes[]`：`{ id, label, kind }`，kind 取 `person | org | investor`
- `edges[]`：`{ from, to, type, label }`，type 取 `works_at | founded | invested`（可扩展）

## 地图实现

前端在 `app/` 目录：

- `map.html + map.js`：Leaflet + 时间轴 UI + 迁徙连线（大圆插值折线）
- `graph.html + graph.js`：vis-network 渲染知识图谱

数据由浏览器直接 fetch：

- `../data/movements.geojson`
- `../data/relations.json`

## 数据扩充（使用 MiMo）

当你需要“把人物库扩到几十/上百/上千”，推荐把“检索/总结/结构化抽取”交给模型做，但仍然要对结果进行抽样校验。

### Key 放置

本项目默认从两个地方读取 `MIMO_API_KEY`：

- 环境变量 `MIMO_API_KEY`
- 或者仓库上一级目录的 `.trae/.env`（不会提交到仓库；仓库已忽略 `.trae/` 与 `*.env`）

### 一键扩充脚本

脚本：`scripts/expand_people_cn_with_mimo.py`

它会调用 MiMo 的 OpenAI 兼容接口，生成一批 “国内 AI 工业界人物” 记录，并合并进：

- `data/movements.geojson`
- `data/relations.json`

运行：

```bash
python3 Global_AI_Talent_Distribution/scripts/expand_people_cn_with_mimo.py --count 80
```

参数：

- `--count`：目标条数下限（模型输出可能略有浮动）
- `--model`：默认 `mimo-v2-flash`，可用环境变量 `MIMO_MODEL` 覆盖
- `MIMO_BASE_URL`：默认 `https://api.xiaomimimo.com/v1`

## 质量与风控建议

这个项目的关键不是“把数据做多”，而是“让数据可追溯、可校验、可维护”。

- 记录 `source` 与可选的 `source_url`：后续可把每条人物/公司信息链接到新闻/官网/百科/论文等
- 把“自动生成”与“人工确认”分层：例如新增 `status = generated | verified`
- 避免写入敏感信息：只保留公开渠道可验证的信息（公司、城市、年份、公开职位）

