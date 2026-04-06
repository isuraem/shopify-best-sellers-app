// app/routes/app.order-dashboard.jsx

import { useLoaderData, Form, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState, useEffect, useRef } from "react";

const DATA_START_STR = "2026-04-01";

export async function loader({ request }) {
  await authenticate.admin(request);

  const url      = new URL(request.url);
  const page     = Math.max(1, parseInt(url.searchParams.get("page")     ?? "1", 10));
  const type     = url.searchParams.get("type")     ?? "";
  const search   = url.searchParams.get("search")   ?? "";
  const dateFrom = url.searchParams.get("dateFrom") ?? "";
  const dateTo   = url.searchParams.get("dateTo")   ?? "";
  const perPage  = 20;

  const DATA_START = new Date(DATA_START_STR + "T00:00:00.000Z");

  let fromDate = dateFrom ? new Date(dateFrom + "T00:00:00.000Z") : DATA_START;
  if (fromDate < DATA_START) fromDate = DATA_START;
  const toDate = dateTo ? new Date(dateTo + "T23:59:59.999Z") : null;

  const where = {
    createdAt: {
      gte: fromDate,
      ...(toDate ? { lte: toDate } : {}),
    },
    ...(type ? { type: { contains: type, mode: "insensitive" } } : {}),
    ...(search ? {
      OR: [
        { name:      { contains: search, mode: "insensitive" } },
        { email:     { contains: search, mode: "insensitive" } },
        { instagram: { contains: search, mode: "insensitive" } },
      ],
    } : {}),
  };

  const allForAnalytics = await prisma.customOrder.findMany({
    where: { createdAt: { gte: DATA_START } },
    select: { createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const dailyMap = {};
  for (let i = 89; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dailyMap[d.toISOString().split("T")[0]] = 0;
  }
  for (const o of allForAnalytics) {
    const key = new Date(o.createdAt).toISOString().split("T")[0];
    if (key in dailyMap) dailyMap[key]++;
  }
  const dailyData = Object.entries(dailyMap).map(([date, count]) => ({ date, count }));

  const monthlyMap = {};
  for (const o of allForAnalytics) {
    const d = new Date(o.createdAt);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    monthlyMap[key] = (monthlyMap[key] || 0) + 1;
  }
  const monthlyData = Object.entries(monthlyMap).sort().map(([month, count]) => ({ month, count }));

  const yearlyMap = {};
  for (const o of allForAnalytics) {
    const year = String(new Date(o.createdAt).getFullYear());
    yearlyMap[year] = (yearlyMap[year] || 0) + 1;
  }
  const yearlyData = Object.entries(yearlyMap).sort().map(([year, count]) => ({ year, count }));

  const [orders, total, stats, totalAll] = await Promise.all([
    prisma.customOrder.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip:    (page - 1) * perPage,
      take:    perPage,
    }),
    prisma.customOrder.count({ where }),
    prisma.customOrder.groupBy({
      by:      ["type"],
      _count:  { id: true },
      orderBy: { _count: { id: "desc" } },
    }),
    prisma.customOrder.count({ where: { createdAt: { gte: DATA_START } } }),
  ]);

  return {
    orders, total, totalAll, page, perPage,
    totalPages: Math.ceil(total / perPage),
    stats,
    filters:   { type, search, dateFrom, dateTo },
    dataStart: DATA_START_STR,
    analytics: { dailyData, monthlyData, yearlyData },
  };
}

const TYPE_COLORS = {
  "Custom Pendant": "#179BD7",
  "Custom Set":     "#9b5de5",
  "Custom Grillz":  "#f15bb5",
  "Custom Rings":   "#f59e0b",
};

function TypeBadge({ type }) {
  const bg   = TYPE_COLORS[type] ?? "#888";
  const dark = type === "Custom Rings";
  return (
    <span style={{
      background: bg, color: dark ? "#000" : "#fff",
      padding: "2px 10px", borderRadius: 99,
      fontSize: 11, fontWeight: 700,
      letterSpacing: "0.04em", whiteSpace: "nowrap",
    }}>
      {type}
    </span>
  );
}

// ── Analytics Charts ──────────────────────────────────────────────────────────
function AnalyticsCharts({ analytics }) {
  const { dailyData, monthlyData, yearlyData } = analytics;
  const [activeTab, setActiveTab] = useState("daily");
  const [days, setDays]           = useState(10);
  const canvasRef   = useRef(null);
  const chartRef    = useRef(null);

  const ACCENT = "#179BD7";

  const slicedDaily = dailyData.slice(-days);

  const getChartConfig = () => {
    if (activeTab === "daily") {
      return {
        labels: slicedDaily.map(d => {
          const [, m, day] = d.date.split("-");
          return `${day}/${m}`;
        }),
        values: slicedDaily.map(d => d.count),
      };
    }
    if (activeTab === "monthly") {
      return {
        labels: monthlyData.map(d => {
          const [y, m] = d.month.split("-");
          return new Date(+y, +m - 1).toLocaleString("default", { month: "short", year: "2-digit" });
        }),
        values: monthlyData.map(d => d.count),
      };
    }
    return {
      labels: yearlyData.map(d => d.year),
      values: yearlyData.map(d => d.count),
    };
  };

  useEffect(() => {
    const build = () => {
      if (!canvasRef.current || !window.Chart) return;
      if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; }

      const { labels, values } = getChartConfig();
      const ctx = canvasRef.current.getContext("2d");

      const fill = ctx.createLinearGradient(0, 0, 0, 220);
      fill.addColorStop(0, "rgba(23,155,215,0.18)");
      fill.addColorStop(1, "rgba(23,155,215,0)");

      chartRef.current = new window.Chart(ctx, {
        type: "line",
        data: {
          labels,
          datasets: [{
            data:             values,
            borderColor:      ACCENT,
            borderWidth:      2.5,
            backgroundColor:  fill,
            fill:             true,
            tension:          0.42,
            pointRadius:      values.length <= 14 ? 4 : 0,
            pointHoverRadius: 6,
            pointBackgroundColor: "#fff",
            pointBorderColor:     ACCENT,
            pointBorderWidth:     2,
          }],
        },
        options: {
          responsive:          true,
          maintainAspectRatio: false,
          animation:           { duration: 400, easing: "easeInOutQuart" },
          interaction:         { intersect: false, mode: "index" },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "#1a1a2e",
              titleColor:      "#fff",
              bodyColor:       "rgba(255,255,255,0.7)",
              padding:         10,
              cornerRadius:    8,
              displayColors:   false,
              callbacks: {
                title: (items) => {
                  if (activeTab === "daily") {
                    const entry = slicedDaily[items[0].dataIndex];
                    return entry ? entry.date : items[0].label;
                  }
                  return items[0].label;
                },
                label: (item) => `  ${item.raw} order${item.raw !== 1 ? "s" : ""}`,
              },
            },
          },
          scales: {
            x: {
              grid:   { display: false },
              border: { display: false },
              ticks: {
                font:          { size: 11 },
                color:         "#a0aec0",
                maxRotation:   0,
                autoSkip:      true,
                maxTicksLimit: 10,
              },
            },
            y: {
              beginAtZero: true,
              grid:        { color: "rgba(0,0,0,0.05)" },
              border:      { display: false },
              ticks: {
                font:          { size: 11 },
                color:         "#a0aec0",
                precision:     0,
                stepSize:      1,
                maxTicksLimit: 6,
              },
            },
          },
        },
      });
    };

    if (window.Chart) {
      build();
    } else {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js";
      s.onload = build;
      document.head.appendChild(s);
    }
    return () => { if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null; } };
  }, [activeTab, days]);

  const { values } = getChartConfig();
  const total = values.reduce((a, b) => a + b, 0);
  const peak  = Math.max(...values, 0);
  const avg   = values.length ? Math.round(total / values.length) : 0;

  const tabs       = [{ id: "daily", label: "Daily" }, { id: "monthly", label: "Monthly" }, { id: "yearly", label: "Yearly" }];
  const dayPresets = [7, 10, 14, 30, 60, 90];

  return (
    <div style={{
      background: "#fff",
      border: "1px solid #e8ecf0",
      borderRadius: 14,
      marginBottom: 16,
      overflow: "hidden",
    }}>

      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", flexWrap: "wrap",
        gap: 12, padding: "16px 20px",
        borderBottom: "1px solid #f0f2f5",
      }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: "#1a202c" }}>Orders over time</div>
          <div style={{ fontSize: 11, color: "#a0aec0", marginTop: 1 }}>Submission trends</div>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", background: "#f4f6f8", borderRadius: 8, padding: 3, gap: 2 }}>
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              style={{
                padding: "5px 14px", borderRadius: 6, border: "none",
                cursor: "pointer", fontSize: 12, fontWeight: 600,
                background: activeTab === t.id ? "#fff"       : "transparent",
                color:      activeTab === t.id ? ACCENT       : "#718096",
                boxShadow:  activeTab === t.id ? "0 1px 3px rgba(0,0,0,0.08)" : "none",
                transition: "all 0.15s",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Stat pills */}
        <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
          {[
            { label: "Total", value: total, bg: "#e8f7ff", color: "#0369a1" },
            { label: "Peak",  value: peak,  bg: "#f0fdf4", color: "#15803d" },
            { label: "Avg",   value: avg,   bg: "#faf5ff", color: "#7c3aed" },
          ].map(s => (
            <div key={s.label} style={{ background: s.bg, borderRadius: 8, padding: "5px 12px", textAlign: "center" }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: s.color, lineHeight: 1.2 }}>{s.value}</div>
              <div style={{ fontSize: 10, color: s.color, opacity: 0.7, fontWeight: 600 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Day slider — daily only */}
      {activeTab === "daily" && (
        <div style={{
          display: "flex", alignItems: "center", gap: 12,
          padding: "10px 20px", borderBottom: "1px solid #f0f2f5",
          background: "#fafbfc",
        }}>
          <span style={{ fontSize: 12, color: "#718096", fontWeight: 600, whiteSpace: "nowrap" }}>
            Last {days} days
          </span>
          <input
            type="range" min={7} max={90} step={1} value={days}
            onChange={e => setDays(Number(e.target.value))}
            style={{ flex: 1, accentColor: ACCENT }}
          />
          <div style={{ display: "flex", gap: 4 }}>
            {dayPresets.map(d => (
              <button
                key={d}
                onClick={() => setDays(d)}
                style={{
                  padding: "3px 8px", borderRadius: 5, border: "none",
                  cursor: "pointer", fontSize: 11, fontWeight: 700,
                  background: days === d ? ACCENT   : "#edf2f7",
                  color:      days === d ? "#fff"   : "#718096",
                  transition: "all 0.12s",
                }}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Chart */}
      <div style={{ padding: "20px 20px 16px", position: "relative", height: 240 }}>
        <canvas ref={canvasRef} />
      </div>

    </div>
  );
}

// ── Detail Drawer ─────────────────────────────────────────────────────────────
function getOrderSections(order) {
  const type    = order.type;
  const contact = [["Name", order.name], ["Email", order.email], ["Phone", order.phone], ["Country", order.country], ["Instagram", order.instagram ? `@${order.instagram}` : null]];
  const pendant = [["Pendant Type", order.pendantType], ["Pendant Size", order.pendantSize], ["Pendant Color", order.pendantColor]];
  const chain   = [["Link Type", order.chainLinkType], ["Thickness", order.chainThickness], ["Length", order.chainLength], ["Chain Color", order.chainColor]];
  const grillz  = [["Number of Teeth", order.grillzTeeth], ["Color", order.grillzColor]];
  const ring    = [["Ring Size", order.ringSize], ["Ring Color", order.ringColor]];
  const meta    = [["Comments", order.comments], ["Source Page", order.sourcePage], ["Submitted", new Date(order.submittedAt).toLocaleString()]];
  switch (type) {
    case "Custom Pendant": return [{ title: "💎 Pendant Details", rows: pendant }, { title: "👤 Customer", rows: contact }, { title: "📝 Notes", rows: meta }];
    case "Custom Set":     return [{ title: "💎 Pendant", rows: pendant }, { title: "⛓️ Chain", rows: chain }, { title: "👤 Customer", rows: contact }, { title: "📝 Notes", rows: meta }];
    case "Custom Grillz":  return [{ title: "😬 Grillz Details", rows: grillz }, { title: "👤 Customer", rows: contact }, { title: "📝 Notes", rows: meta }];
    case "Custom Rings":   return [{ title: "💍 Ring Details", rows: ring }, { title: "👤 Customer", rows: contact }, { title: "📝 Notes", rows: meta }];
    default:               return [{ title: "👤 Customer", rows: contact }, { title: "📝 Notes", rows: meta }];
  }
}

function OrderDrawer({ order, onClose }) {
  if (!order) return null;
  const sections = getOrderSections(order);
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000 }} />
      <aside style={{ position: "fixed", top: 0, right: 0, bottom: 0, width: "min(480px, 100vw)", background: "#fff", zIndex: 1001, display: "flex", flexDirection: "column", boxShadow: "-4px 0 24px rgba(0,0,0,0.12)", overflowY: "auto" }}>
        <div style={{ padding: "20px 24px", borderBottom: "1px solid #e8ecf0", display: "flex", alignItems: "center", gap: 12, position: "sticky", top: 0, background: "#fff", zIndex: 1 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{order.name}</div>
            <div style={{ fontSize: 13, color: "#666", marginTop: 2 }}>{order.email}</div>
          </div>
          <TypeBadge type={order.type} />
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 22, lineHeight: 1, color: "#888", padding: "0 4px" }}>✕</button>
        </div>
        {order.fileUrl && (
          <div style={{ padding: "16px 24px 0" }}>
            <a href={order.fileUrl} target="_blank" rel="noopener noreferrer">
              <img src={order.fileUrl} alt="Reference" style={{ width: "100%", maxHeight: 220, objectFit: "contain", borderRadius: 8, border: "1px solid #e8ecf0" }} onError={e => (e.currentTarget.style.display = "none")} />
            </a>
          </div>
        )}
        <div style={{ padding: "0 24px 16px" }}>
          {sections.map((section, si) => (
            <div key={si} style={{ marginTop: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: "0.08em", padding: "6px 0", borderBottom: "2px solid #f0f0f0", marginBottom: 4 }}>{section.title}</div>
              {section.rows.map(([label, value], i) => {
                if (!value) return null;
                return (
                  <div key={i} style={{ display: "flex", gap: 12, padding: "7px 0", borderBottom: "1px solid #f7f7f7", fontSize: 14 }}>
                    <span style={{ minWidth: 120, color: "#888", fontWeight: 500 }}>{label}</span>
                    <span style={{ flex: 1, wordBreak: "break-word" }}>{value}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div style={{ padding: "16px 24px", marginTop: "auto", display: "flex", gap: 10 }}>
          {order.instagram && (
            <a href={`https://instagram.com/${order.instagram}`} target="_blank" rel="noopener noreferrer" style={{ flex: 1, textAlign: "center", background: "#e1306c", color: "#fff", padding: "10px 0", borderRadius: 6, textDecoration: "none", fontWeight: 600, fontSize: 14 }}>Instagram</a>
          )}
        </div>
      </aside>
    </>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function OrderDashboard() {
  const { orders, total, totalAll, page, totalPages, stats, filters, dataStart, analytics } = useLoaderData();
  const [selected, setSelected] = useState(null);
  const navigate  = useNavigate();
  const todayStr  = new Date().toISOString().split("T")[0];

  const nDaysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    const s = d.toISOString().split("T")[0];
    return s < dataStart ? dataStart : s;
  };

  const presets = [
    { label: "Today",    from: todayStr,     to: todayStr },
    { label: "Last 7d",  from: nDaysAgo(7),  to: todayStr },
    { label: "Last 30d", from: nDaysAgo(30), to: todayStr },
    { label: "Last 90d", from: nDaysAgo(90), to: todayStr },
  ];

  const presetNav = (from, to) =>
    navigate(`?dateFrom=${from}&dateTo=${to}&type=${filters.type}&search=${filters.search}`);

  const hasActiveFilter =
    filters.search || filters.type || filters.dateTo ||
    (filters.dateFrom && filters.dateFrom !== dataStart);

  const kpis = [
    { label: "Total Orders", value: totalAll, color: "#179BD7" },
    ...stats.map(s => ({ label: s.type, value: s._count.id, color: TYPE_COLORS[s.type] ?? "#888" })),
  ];

  return (
    <s-page heading="Custom Orders Dashboard">
      <s-section>

        {/* Banner */}
        <s-box marginBottom="base">
          <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", borderLeft: "4px solid #f59e0b", borderRadius: 8, padding: "12px 16px", display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span style={{ fontSize: 18, lineHeight: 1.3 }}>📅</span>
            <div style={{ fontSize: 13, color: "#78350f", lineHeight: 1.7 }}>
              <strong>Order data is available from April 1, 2026 onwards.</strong>
              {" "}The date filter is blocked before <strong>Apr 1, 2026</strong>.
            </div>
          </div>
        </s-box>

        {/* KPI cards */}
        <s-box marginBottom="base">
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {kpis.map(({ label, value, color }) => (
              <div key={label} style={{ background: "#fff", borderRadius: 10, padding: "18px 24px", flex: "1 1 160px", minWidth: 140, borderTop: `4px solid ${color}`, boxShadow: "0 1px 4px rgba(0,0,0,0.08)" }}>
                <div style={{ fontSize: 28, fontWeight: 800, color }}>{value}</div>
                <div style={{ fontSize: 12, color: "#888", marginTop: 4, fontWeight: 600 }}>{label}</div>
              </div>
            ))}
          </div>
        </s-box>

        {/* Analytics chart */}
        <AnalyticsCharts analytics={analytics} />

        {/* Filter bar */}
        <s-box marginBottom="base" padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <Form method="get">
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
              <input name="search" defaultValue={filters.search} placeholder="Search name, email, instagram…"
                style={{ flex: "1 1 200px", padding: "8px 12px", borderRadius: 6, border: "1px solid #e0e0e0", fontSize: 13 }} />
              <select name="type" defaultValue={filters.type}
                style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid #e0e0e0", fontSize: 13, minWidth: 150 }}>
                <option value="">All types</option>
                {["Custom Pendant", "Custom Set", "Custom Grillz", "Custom Rings"].map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, color: "#666", fontWeight: 600 }}>From</span>
                <input type="date" name="dateFrom" defaultValue={filters.dateFrom || dataStart} min={dataStart}
                  style={{ padding: "7px 10px", borderRadius: 6, border: "1px solid #e0e0e0", fontSize: 13 }} />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, color: "#666", fontWeight: 600 }}>To</span>
                <input type="date" name="dateTo" defaultValue={filters.dateTo || todayStr} min={dataStart}
                  style={{ padding: "7px 10px", borderRadius: 6, border: "1px solid #e0e0e0", fontSize: 13 }} />
              </div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {presets.map(({ label, from, to }) => (
                  <button key={label} type="button" onClick={() => presetNav(from, to)}
                    style={{ padding: "5px 10px", borderRadius: 6, fontSize: 12, fontWeight: 600, border: "1px solid #d1d5db", background: "#fff", color: "#444", whiteSpace: "nowrap", cursor: "pointer" }}>
                    {label}
                  </button>
                ))}
              </div>
              <button type="submit" style={{ background: "#179BD7", color: "#fff", border: "none", padding: "8px 16px", borderRadius: 6, cursor: "pointer", fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>
                Apply
              </button>
              {hasActiveFilter && (
                <button type="button" onClick={() => navigate("/app/order-dashboard")}
                  style={{ fontSize: 13, color: "#888", whiteSpace: "nowrap", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                  Clear all
                </button>
              )}
              <span style={{ marginLeft: "auto", fontSize: 13, color: "#888", whiteSpace: "nowrap" }}>
                {total} result{total !== 1 ? "s" : ""}
              </span>
            </div>
          </Form>
        </s-box>

        {/* Table */}
        <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
          {orders.length === 0 ? (
            <div style={{ padding: "60px 24px", textAlign: "center" }}>
              <s-text subdued>No orders found for the selected filters or date range.</s-text>
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", backgroundColor: "white" }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid #e8ecf0" }}>
                    {["Date", "Type", "Name", "Email", "Instagram", "Item", "Color"].map(h => (
                      <th key={h} style={{ padding: "12px 14px", textAlign: "left", fontSize: 11, fontWeight: 700, color: "#888", textTransform: "uppercase", letterSpacing: "0.06em", background: "#fafbfc" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {orders.map(order => (
                    <tr key={order.id} onClick={() => setSelected(order)} style={{ cursor: "pointer", borderBottom: "1px solid #f0f2f5" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#f4f9fd")}
                      onMouseLeave={e => (e.currentTarget.style.background = "")}>
                      <td style={{ padding: "12px 14px", fontSize: 13 }}>{new Date(order.createdAt).toLocaleDateString()}</td>
                      <td style={{ padding: "12px 14px" }}><TypeBadge type={order.type} /></td>
                      <td style={{ padding: "12px 14px", fontSize: 13, fontWeight: 600 }}>{order.name}</td>
                      <td style={{ padding: "12px 14px", fontSize: 13 }}>{order.email}</td>
                      <td style={{ padding: "12px 14px", fontSize: 13 }}>{order.instagram ? `@${order.instagram}` : "—"}</td>
                      <td style={{ padding: "12px 14px", fontSize: 13 }}>{order.pendantType || order.grillzTeeth || order.ringSize || "—"}</td>
                      <td style={{ padding: "12px 14px", fontSize: 13 }}>{order.pendantColor || order.grillzColor || order.ringColor || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {totalPages > 1 && (
            <div style={{ padding: "14px 20px", borderTop: "1px solid #f0f2f5", display: "flex", gap: 8, justifyContent: "center" }}>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                <a key={p} href="#" onClick={(e) => { e.preventDefault(); navigate(`?page=${p}&type=${filters.type}&search=${filters.search}&dateFrom=${filters.dateFrom || dataStart}&dateTo=${filters.dateTo || todayStr}`); }}
                  style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 32, height: 32, borderRadius: 6, fontSize: 13, fontWeight: 600, background: p === page ? "#179BD7" : "#f0f2f5", color: p === page ? "#fff" : "#444", textDecoration: "none" }}>
                  {p}
                </a>
              ))}
            </div>
          )}
        </s-box>

        {orders.length > 0 && (
          <s-box marginTop="base" style={{ textAlign: "center" }}>
            <s-text subdued size="small">💡 Click any row to view full order details</s-text>
          </s-box>
        )}

      </s-section>

      <OrderDrawer order={selected} onClose={() => setSelected(null)} />
    </s-page>
  );
}