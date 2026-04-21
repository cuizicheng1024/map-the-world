# Global AI Talent Distribution

> 基于 Cesium 3D 地球与 Canvas 关系网的交互式可视化，展示 1912–2026 年间全球 82 位 AI 关键人物的城市迁徙轨迹与组织关联。

## 快速体验

```bash
cd Global_AI_Talent_Distribution
python3 -m http.server 8080
# 浏览器访问：
# 3D 地球：http://localhost:8080/app/cesium.html
# 关系网：http://localhost:8080/app/graph.html
```

## 核心特性

- **Cesium 3D 地球**：支持年份时间轴、播放/暂停、速度调节、人物/公司/城市过滤
- **Kimi 月之暗面品牌配色**：深空黑 + 月辉青 + 暗面红，星空氛围动效
- **知识图谱交互**：单击节点弹出人物 AI 贡献简介，并高亮关联节点与边
- **数据基础**：CSV → GeoJSON + Graph 自动合并脚本（含本地地理编码缓存）

## 数据流程

1. 准备城市履历 CSV（`ai_people_city_matrix_1912_2026_ffill_expanded_cn_llm.csv`）
2. 运行合并脚本：
   ```bash
   python3 scripts/merge_city_matrix.py --csv your.csv
   ```
3. 输出：`data/movements.geojson` + `data/relations.json`
4. 前端直接加载渲染

## 文件结构

```
app/
├── cesium.html      # 3D 地球主页面
├── cesium.js        # 年份过滤、播放控制、Kimi 配色
├── graph.html       # 关系网页面
├── graph.js         # 单击弹窗 + 高亮关联
├── kimi.css         # 月之暗面品牌色板 & 星点动画
└── common.js        # 通用工具（URL 参数 / fetch / debounce）

data/
├── movements.geojson
├── relations.json
└── geocode_cache.json

scripts/
└── merge_city_matrix.py
```

## 更新日志

- 2026-04-21：新增 Cesium 3D 地球与 Kimi 品牌配色；graph 节点单击弹窗 & 高亮关联
