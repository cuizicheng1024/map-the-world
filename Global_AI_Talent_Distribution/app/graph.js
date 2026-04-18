import { debounce, fetchJson } from "./common.js";

const DATA_PATH = "../data/relations.json";

function normalizeText(s) {
  return String(s ?? "")
    .trim()
    .toLowerCase();
}

function nodeColor(type) {
  if (type === "person") return { background: "rgba(34, 211, 238, 0.22)", border: "rgba(125, 211, 252, 0.8)" };
  if (type === "org") return { background: "rgba(99, 102, 241, 0.18)", border: "rgba(165, 180, 252, 0.75)" };
  if (type === "investor") return { background: "rgba(245, 158, 11, 0.16)", border: "rgba(253, 230, 138, 0.75)" };
  return { background: "rgba(148, 163, 184, 0.12)", border: "rgba(148, 163, 184, 0.45)" };
}

function edgeColor(type) {
  if (type === "works_at") return "rgba(125, 211, 252, 0.45)";
  if (type === "founded") return "rgba(165, 180, 252, 0.55)";
  if (type === "invested") return "rgba(253, 230, 138, 0.55)";
  return "rgba(148, 163, 184, 0.45)";
}

function openMapForNode(node) {
  const kind = node.kind;
  const id = node.id;
  const url = new URL("./map.html", window.location.href);
  if (kind === "person") url.searchParams.set("focus", `person:${id}`);
  if (kind === "org") url.searchParams.set("focus", `org:${id}`);
  window.open(url.toString(), "_blank");
}

async function main() {
  const root = document.getElementById("graph");
  const searchInput = document.getElementById("searchInput");
  root.textContent = "关系网加载中...";
  if (!window.vis) {
    root.textContent = "关系网依赖的 vis-network 脚本未能加载（可能被网络拦截）。请刷新重试，或使用更稳定的网络环境。";
    return;
  }

  const raw = await fetchJson(DATA_PATH);
  const nodes = (raw.nodes ?? []).map((n) => {
    const c = nodeColor(n.kind);
    return {
      id: n.id,
      label: n.label ?? n.id,
      kind: n.kind ?? "node",
      group: n.kind ?? "node",
      color: c,
      font: { color: "rgba(230,237,243,0.92)" },
      shape: "dot",
      size: n.kind === "person" ? 14 : 12,
    };
  });

  const edges = (raw.edges ?? []).map((e) => {
    return {
      from: e.from,
      to: e.to,
      label: e.label ?? "",
      arrows: e.type === "invested" ? "to" : "",
      color: { color: edgeColor(e.type) },
      font: { color: "rgba(230,237,243,0.6)", size: 11, align: "middle" },
      smooth: { type: "dynamic" },
    };
  });

  const network = new vis.Network(
    root,
    { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(edges) },
    {
      autoResize: true,
      interaction: { hover: true, tooltipDelay: 120 },
      physics: {
        stabilization: { enabled: true, iterations: 220, fit: true },
        barnesHut: { gravitationalConstant: -12000, springLength: 170, springConstant: 0.05 },
      },
    }
  );
  root.textContent = "";
  window.setTimeout(() => {
    try {
      network.fit({ animation: { duration: 250 } });
    } catch (_) {
      // noop
    }
  }, 60);
  network.once("stabilizationIterationsDone", () => {
    network.fit({ animation: { duration: 250 } });
  });

  network.on("doubleClick", (params) => {
    const nodeId = params?.nodes?.[0];
    if (!nodeId) return;
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;
    openMapForNode(node);
  });

  const search = debounce(() => {
    const q = normalizeText(searchInput.value);
    if (!q) {
      network.setSelection({ nodes: [] });
      network.fit({ animation: { duration: 250 } });
      return;
    }
    const hit = nodes.find((n) => normalizeText(n.label).includes(q) || normalizeText(n.id).includes(q));
    if (!hit) return;
    network.selectNodes([hit.id]);
    network.focus(hit.id, { scale: 1.2, animation: { duration: 250 } });
  }, 120);

  searchInput.addEventListener("input", search);
}

main().catch((e) => {
  const root = document.getElementById("graph");
  root.textContent = String(e?.message ?? e);
});
