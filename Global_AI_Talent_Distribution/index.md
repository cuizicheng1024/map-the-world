---
title: Global AI Talent Distribution
---

# Global AI Talent Distribution

## 目标

### 人 + 公司实体（知识图谱）

把人、公司、投资机构抽象为节点（Node），用边（Edge）表达关系：任职、共事、衍生创业、投资等。点击节点可跳转到迁徙地图并自动过滤。

## Demo

- 3D 地球：[`app/cesium.html`](file:///Users/bytedance/Desktop/Trae/resume/map-the-world/Global_AI_Talent_Distribution/app/cesium.html)
- 关系网：[`app/graph.html`](file:///Users/bytedance/Desktop/Trae/resume/map-the-world/Global_AI_Talent_Distribution/app/graph.html)

GitHub Pages 部署后，访问路径通常为：

- `/Global_AI_Talent_Distribution/app/cesium.html`
- `/Global_AI_Talent_Distribution/app/graph.html`

## 数据协议

### 迁徙数据（GeoJSON）

文件：[`data/movements.geojson`](file:///Users/cui/Documents/trae_projects/myresume/map-the-world/Global_AI_Talent_Distribution/data/movements.geojson)

每条记录是一条“某人某年在某城市某公司”的点要素：

- `properties.person_id`：建议 slug（可稳定引用）
- `properties.person_name`
- `properties.org_id`
- `properties.org_name`
- `properties.city`
- `properties.country`：国家/地区代码
- `properties.year`：整数年份
- `geometry.coordinates`：`[lon, lat]`

### 关系网（Graph JSON）

文件：[`data/relations.json`](file:///Users/cui/Documents/trae_projects/myresume/map-the-world/Global_AI_Talent_Distribution/data/relations.json)

- `nodes[]`：`{ id, label, kind }`，kind 取 `person | org | investor`
- `edges[]`：`{ from, to, type, label }`，type 取 `works_at | founded | invested`（可扩展）

## 数据清洗脚手架（从文本到 GeoJSON）

示例输入：[`data/sample_raw.jsonl`](file:///Users/cui/Documents/trae_projects/myresume/map-the-world/Global_AI_Talent_Distribution/data/sample_raw.jsonl)

地名到经纬度缓存：[`data/geocode_cache.json`](file:///Users/cui/Documents/trae_projects/myresume/map-the-world/Global_AI_Talent_Distribution/data/geocode_cache.json)

脚本：[`scripts/normalize.py`](file:///Users/cui/Documents/trae_projects/myresume/map-the-world/Global_AI_Talent_Distribution/scripts/normalize.py)

运行方式（在仓库根目录 map-the-world 下）：

```bash
python3 Global_AI_Talent_Distribution/scripts/normalize.py \
  --in Global_AI_Talent_Distribution/data/sample_raw.jsonl \
  --geocode Global_AI_Talent_Distribution/data/geocode_cache.json \
  --out Global_AI_Talent_Distribution/data/movements.generated.geojson
```

产出文件 `movements.generated.geojson` 可直接替换 `movements.geojson` 来驱动地图渲染。
