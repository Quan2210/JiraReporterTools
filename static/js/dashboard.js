import { $, applyStatus, el } from "./dom.js";
import { statusColor } from "./lib/color.js";
import { formatBucket } from "./lib/dates.js";
import { buildPivot, OTHER_LABEL } from "./lib/pivot.js";
import { meta } from "./meta.js";
import { store } from "./store.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const PALETTE = ["#4C78A8", "#F58518", "#54A24B", "#E45756", "#72B7B2", "#B279A2", "#FF9DA6", "#9D755D", "#EECA3B", "#79706E"];
const BUCKETS = [["day", "ngày"], ["week", "tuần"], ["month", "tháng"]];
const isDate = (type) => type === "date" || type === "datetime";
const label = (v) => formatBucket(v);
const fmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children.filter(Boolean));
  return node;
}

export function createDashboard({ table, onDrill }) {
  const sel = { x: $("dash-x"), y: $("dash-y"), measure: $("dash-measure"), order: $("dash-order"), kind: $("dash-kind"),
    xb: $("dash-x-bucket"), yb: $("dash-y-bucket") };

  function fillSelects() {
    const cols = table.columns();
    const keep = { x: sel.x.value, y: sel.y.value, m: sel.measure.value };
    const colOptions = () => cols.map((c) => el("option", { value: c.id, text: c.name }));
    sel.x.replaceChildren(...colOptions());
    sel.y.replaceChildren(...colOptions());
    const pick = (select, wanted, fallbacks) => {
      const id = [wanted, ...fallbacks].find((v) => v && cols.some((c) => c.id === v)) ?? cols[0]?.id;
      if (id) select.value = id;
    };
    pick(sel.x, keep.x, ["status", "issuekey"]);
    pick(sel.y, keep.y, ["assignee", "reporter", cols[1]?.id]);
    const numeric = cols.filter((c) => c.type === "number");
    sel.measure.replaceChildren(
      el("option", { value: "count", text: "Số issue" }),
      ...numeric.map((c) => el("option", { value: `sum:${c.id}`, text: `Tổng ${c.name}` })));
    sel.measure.value = [...sel.measure.options].some((o) => o.value === keep.m) ? keep.m : "count";
    for (const [select, bucketSel, wrapId] of [[sel.x, sel.xb, "dash-x-bucket-wrap"], [sel.y, sel.yb, "dash-y-bucket-wrap"]]) {
      bucketSel.replaceChildren(...BUCKETS.map(([v, t]) => el("option", { value: v, text: t })));
      $(wrapId).hidden = !isDate(cols.find((c) => c.id === select.value)?.type);
    }
  }

  function axis(select, bucketSel) {
    const col = table.columns().find((c) => c.id === select.value);
    return { col: select.value, type: col?.type, bucket: bucketSel.value || "day", name: col?.name ?? "" };
  }

  function axisColor(a, value, index) {
    if (value === OTHER_LABEL) return "#9AA0A6";
    if (a.col === "status") return statusColor(value, store.profile.statusColors, meta.statusCategories) || PALETTE[index % PALETTE.length];
    return PALETTE[index % PALETTE.length];
  }

  function matrixView(p, x, y, measure) {
    const value = (cell) => (measure === "count" ? cell.count : cell.sum);
    const head = el("tr", {}, el("th", { text: `${y.name} ↓ / ${x.name} →` }),
      ...p.xs.map((xv) => {
        const color = x.col === "status" ? statusColor(xv, store.profile.statusColors, meta.statusCategories) : null;
        const th = el("th", { text: label(xv) });
        if (color) applyStatus(th, color);
        return th;
      }),
      el("th", { class: "tot", text: "Tổng" }));
    const rows = p.ys.map((yv) => {
      const rowTot = p.rowTotal(yv);
      const color = y.col === "status" ? statusColor(yv, store.profile.statusColors, meta.statusCategories) : null;
      const head = el("th", { text: label(yv) });
      if (color) applyStatus(head, color);
      return el("tr", {}, head,
        ...p.xs.map((xv) => {
          const cell = p.get(xv, yv);
          const pct = p.max ? Math.round(12 + 50 * (cell.count / p.max)) : 0;
          return el("td", {
            class: cell.count ? "hit" : "",
            title: cell.count ? `${cell.count} issue — click để xem` : "",
            style: cell.count ? { background: `color-mix(in srgb, var(--accent) ${pct}%, transparent)` } : {},
            onclick: cell.count ? () => onDrill(cell.keys, `${x.name} = ${label(xv)}, ${y.name} = ${label(yv)}`) : undefined,
            text: cell.count ? fmt(value(cell)) : "",
          });
        }),
        el("td", { class: "tot", text: fmt(measure === "count" ? rowTot.count : rowTot.sum) }));
    });
    const colRow = el("tr", {}, el("th", { class: "tot", text: "Tổng" }),
      ...p.xs.map((xv) => { const t = p.colTotal(xv); return el("td", { class: "tot", text: fmt(measure === "count" ? t.count : t.sum) }); }),
      el("td", { class: "tot", text: String(p.issueCount) + (measure === "count" ? "" : " issue") }));
    return el("table", { class: "pivot" }, el("thead", {}, head), el("tbody", {}, ...rows, colRow));
  }

  function barsView(p, x, y, measure) {
    const value = (cell) => (measure === "count" ? cell.count : cell.sum);
    const totals = p.xs.map((xv) => p.ys.reduce((n, yv) => n + value(p.get(xv, yv)), 0));
    const maxTotal = Math.max(1, ...totals);
    const W = Math.max(640, p.xs.length * 64 + 80), H = 340, L = 48, B = 80, T = 12, R = 10;
    const plotW = W - L - R, plotH = H - T - B;
    const slot = plotW / Math.max(1, p.xs.length);
    const barW = Math.min(48, slot * 0.7);
    const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": `${y.name} theo ${x.name}` });
    for (let i = 0; i <= 4; i++) {
      const v = (maxTotal * i) / 4;
      const yy = T + plotH - (plotH * i) / 4;
      root.append(svg("line", { x1: L, x2: W - R, y1: yy, y2: yy, class: "axis" }),
        svg("text", { x: L - 6, y: yy + 4, "text-anchor": "end" }, document.createTextNode(fmt(Math.round(v * 100) / 100))));
    }
    p.xs.forEach((xv, i) => {
      let top = T + plotH;
      const cx = L + slot * i + slot / 2;
      p.ys.forEach((yv, j) => {
        const v = value(p.get(xv, yv));
        if (!v) return;
        const h = (plotH * v) / maxTotal;
        top -= h;
        root.append(svg("rect", { x: cx - barW / 2, y: top, width: barW, height: h, fill: axisColor(y, yv, j) },
          svg("title", {}, document.createTextNode(`${label(xv)} · ${label(yv)}: ${fmt(v)}`))));
      });
      const shown = label(xv);
      const short = shown.length > 14 ? `${shown.slice(0, 13)}…` : shown;
      root.append(svg("text", { x: cx, y: T + plotH + 14, "text-anchor": "end", transform: `rotate(-35 ${cx} ${T + plotH + 14})` },
        document.createTextNode(short), svg("title", {}, document.createTextNode(shown))));
      root.append(svg("text", { x: cx, y: top - 3, "text-anchor": "middle" }, document.createTextNode(fmt(totals[i]))));
    });
    const legend = el("div", { class: "legend" }, ...p.ys.map((yv, j) => el("span", {}, el("i", { style: { background: axisColor(y, yv, j) } }), label(yv))));
    return el("div", {}, root, legend);
  }

  function render() {
    const out = $("dash-out");
    if (!table.hasResult() || !table.columns().length) { out.replaceChildren(el("p", { class: "muted", text: "Chạy báo cáo để xem dashboard." })); return; }
    const x = axis(sel.x, sel.xb);
    const y = axis(sel.y, sel.yb);
    $("dash-x-bucket-wrap").hidden = !isDate(x.type);
    $("dash-y-bucket-wrap").hidden = !isDate(y.type);
    const measure = sel.measure.value.startsWith("sum:") ? "sum" : "count";
    const sumCol = measure === "sum" ? sel.measure.value.slice(4) : null;
    const rows = table.visibleRows();
    const p = buildPivot(rows, { x, y, sumCol, order: sel.order.value });
    $("dash-note").textContent = `${p.issueCount} issue` + (p.multiValued
      ? " — issue có nhiều giá trị ở một trục (label, sprint…) được tính ở từng giá trị nên tổng các ô có thể lớn hơn số issue."
      : "");
    out.replaceChildren(sel.kind.value === "bars" ? barsView(p, x, y, measure) : matrixView(p, x, y, measure));
  }

  for (const s of Object.values(sel)) s.addEventListener("change", render);

  return { render, refresh() { fillSelects(); render(); } };
}
