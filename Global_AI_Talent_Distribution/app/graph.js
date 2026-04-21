/* graph.js 单击节点弹窗 + 高亮关联节点 */
import { getQueryParam } from './utils.js';

let nodes, edges, g, width, height, svg, simulation, adj, highlightSet;
const focusParam = getQueryParam('focus');

function initGraph() {
  fetch('../data/relations.json')
    .then(r => r.json())
    .then(data => {
      nodes = data.nodes;
      edges = data.edges;
      buildAdjacency();
      drawGraph();
      if (focusParam) applyFocus(focusParam);
    });
}

function buildAdjacency() {
  adj = new Map();
  nodes.forEach(n => adj.set(n.id, new Set()));
  edges.forEach(e => {
    adj.get(e.from).add(e.to);
    adj.get(e.to).add(e.from);
  });
}

function drawGraph() {
  const container = document.getElementById('graph');
  width = container.clientWidth;
  height = container.clientHeight;
  svg = d3.select('#graph')
    .append('svg')
    .attr('width', width)
    .attr('height', height);

  simulation = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(edges).id(d => d.id).distance(80))
    .force('charge', d3.forceManyBody().strength(-200))
    .force('center', d3.forceCenter(width / 2, height / 2));

  const link = svg.append('g')
    .selectAll('line')
    .data(edges)
    .join('line')
    .attr('stroke', '#555')
    .attr('stroke-width', 1);

  const node = svg.append('g')
    .selectAll('circle')
    .data(nodes)
    .join('circle')
    .attr('r', 6)
    .attr('fill', d => d.kind === 'person' ? '#00E5FF' : '#FF3B91')
    .call(drag(simulation))
    .on('click', showDetail);

  const label = svg.append('g')
    .selectAll('text')
    .data(nodes)
    .join('text')
    .text(d => d.label)
    .attr('font-size', 10)
    .attr('dx', 8)
    .attr('dy', 3)
    .attr('fill', '#E6E6EA');

  simulation.on('tick', () => {
    link
      .attr('x1', d => d.source.x)
      .attr('y1', d => d.source.y)
      .attr('x2', d => d.target.x)
      .attr('y2', d => d.target.y);
    node
      .attr('cx', d => d.x)
      .attr('cy', d => d.y);
    label
      .attr('x', d => d.x)
      .attr('y', d => d.y);
  });
}

function showDetail(event, d) {
  // 高亮当前节点与相邻节点/边
  highlightSet = new Set([d.id, ...adj.get(d.id)]);
  svg.selectAll('circle').attr('opacity', n => highlightSet.has(n.id) ? 1 : 0.2);
  svg.selectAll('line').attr('opacity', e => (highlightSet.has(e.from) && highlightSet.has(e.to)) ? 1 : 0.1);

  // 弹窗：人物详情（AI 贡献）
  if (d.kind === 'person') {
    const detail = d.contribution || '暂无简介';
    const popup = document.createElement('div');
    popup.id = 'detail-popup';
    popup.style.position = 'absolute';
    popup.style.left = (event.pageX + 12) + 'px';
    popup.style.top  = (event.pageY + 12) + 'px';
    popup.style.background = 'rgba(26,26,29,0.95)';
    popup.style.border = '1px solid #00E5FF';
    popup.style.borderRadius = '8px';
    popup.style.padding = '10px 14px';
    popup.style.maxWidth = '260px';
    popup.style.color = '#E6E6EA';
    popup.style.fontSize = '13px';
    popup.style.zIndex = 20;
    popup.innerHTML = `<strong>${d.label}</strong><br/><span style="opacity:0.8">${detail}</span>`;
    document.body.appendChild(popup);

    // 点击空白关闭
    const close = e => {
      if (popup && !popup.contains(e.target)) {
        document.body.removeChild(popup);
        svg.selectAll('circle, line').attr('opacity', 1);
        document.removeEventListener('click', close);
      }
    };
    setTimeout(() => document.addEventListener('click', close), 100);
  }
}

function drag(sim) {
  function dragstarted(event, d) {
    if (!event.active) sim.alphaTarget(0.3).restart();
    d.fx = d.x; d.fy = d.y;
  }
  function dragged(event, d) {
    d.fx = event.x; d.fy = event.y;
  }
  function dragended(event, d) {
    if (!event.active) sim.alphaTarget(0);
    d.fx = null; d.fy = null;
  }
  return d3.drag()
    .on('start', dragstarted)
    .on('drag', dragged)
    .on('end', dragended);
}

function applyFocus(focus) {
  const [type, keyword] = focus.split(':');
  if (!keyword) return;
  const target = nodes.find(n => n.label.toLowerCase().includes(keyword.toLowerCase()));
  if (!target) return;
  // 模拟点击高亮
  showDetail({ pageX: width / 2, pageY: height / 2 }, target);
}

initGraph();