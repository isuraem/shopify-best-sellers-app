// app/routes/app.order-dashboard.jsx

import { useLoaderData, Form, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { useState } from "react";

// ── Constants ─────────────────────────────────────────────────────────────────
// Orders only exist from this date — block anything before it
const DATA_START_STR = "2026-04-01";

// ── Loader ────────────────────────────────────────────────────────────────────
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

  // Clamp: never allow querying before DATA_START
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
    // Total KPI always floored to DATA_START
    prisma.customOrder.count({ where: { createdAt: { gte: DATA_START } } }),
  ]);

  return {
    orders,
    total,
    totalAll,
    page,
    perPage,
    totalPages: Math.ceil(total / perPage),
    stats,
    filters:   { type, search, dateFrom, dateTo },
    dataStart: DATA_START_STR,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
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

// ── Detail Drawer ─────────────────────────────────────────────────────────────
// Build type-specific sections
function getOrderSections(order) {
  const type = order.type;

  const contact = [
    ["Name",      order.name],
    ["Email",     order.email],
    ["Phone",     order.phone],
    ["Country",   order.country],
    ["Instagram", order.instagram ? `@${order.instagram}` : null],
  ];

  const pendant = [
    ["Pendant Type",  order.pendantType],
    ["Pendant Size",  order.pendantSize],
    ["Pendant Color", order.pendantColor],
  ];

  const chain = [
    ["Link Type",      order.chainLinkType],
    ["Thickness",      order.chainThickness],
    ["Length",         order.chainLength],
    ["Chain Color",    order.chainColor],
  ];

  const grillz = [
    ["Number of Teeth", order.grillzTeeth],
    ["Color",           order.grillzColor],
  ];

  const ring = [
    ["Ring Size",  order.ringSize],
    ["Ring Color", order.ringColor],
  ];

  const meta = [
    ["Comments",    order.comments],
    ["Source Page", order.sourcePage],
    ["Submitted",   new Date(order.submittedAt).toLocaleString()],
  ];

  switch (type) {
    case "Custom Pendant":
      return [
        { title: "💎 Pendant Details", rows: pendant },
        { title: "👤 Customer",        rows: contact },
        { title: "📝 Notes",           rows: meta    },
      ];
    case "Custom Set":
      return [
        { title: "💎 Pendant",  rows: pendant },
        { title: "⛓️ Chain",    rows: chain   },
        { title: "👤 Customer", rows: contact },
        { title: "📝 Notes",    rows: meta    },
      ];
    case "Custom Grillz":
      return [
        { title: "😬 Grillz Details", rows: grillz },
        { title: "👤 Customer",       rows: contact },
        { title: "📝 Notes",          rows: meta    },
      ];
    case "Custom Rings":
      return [
        { title: "💍 Ring Details", rows: ring    },
        { title: "👤 Customer",     rows: contact },
        { title: "📝 Notes",        rows: meta    },
      ];
    default:
      return [
        { title: "👤 Customer", rows: contact },
        { title: "📝 Notes",    rows: meta    },
      ];
  }
}

function OrderDrawer({ order, onClose }) {
  if (!order) return null;
  const sections = getOrderSections(order);

  return (
    <>
      <div onClick={onClose} style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.4)", zIndex: 1000,
      }} />
      <aside style={{
        position: "fixed", top: 0, right: 0, bottom: 0,
        width: "min(480px, 100vw)", background: "#fff",
        zIndex: 1001, display: "flex", flexDirection: "column",
        boxShadow: "-4px 0 24px rgba(0,0,0,0.12)", overflowY: "auto",
      }}>
        {/* header */}
        <div style={{
          padding: "20px 24px", borderBottom: "1px solid #e8ecf0",
          display: "flex", alignItems: "center", gap: 12,
          position: "sticky", top: 0, background: "#fff", zIndex: 1,
        }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 700 }}>{order.name}</div>
            <div style={{ fontSize: 13, color: "#666", marginTop: 2 }}>{order.email}</div>
          </div>
          <TypeBadge type={order.type} />
          <button onClick={onClose} style={{
            background: "none", border: "none", cursor: "pointer",
            fontSize: 22, lineHeight: 1, color: "#888", padding: "0 4px",
          }}>✕</button>
        </div>

        {/* image */}
        {order.fileUrl && (
          <div style={{ padding: "16px 24px 0" }}>
            <a href={order.fileUrl} target="_blank" rel="noopener noreferrer">
              <img src={order.fileUrl} alt="Reference" style={{
                width: "100%", maxHeight: 220, objectFit: "contain",
                borderRadius: 8, border: "1px solid #e8ecf0",
              }} onError={e => (e.currentTarget.style.display = "none")} />
            </a>
          </div>
        )}

        {/* type-specific sections */}
        <div style={{ padding: "0 24px 16px" }}>
          {sections.map((section, si) => (
            <div key={si} style={{ marginTop: 16 }}>
              {/* section header */}
              <div style={{
                fontSize: 11, fontWeight: 700, color: "#888",
                textTransform: "uppercase", letterSpacing: "0.08em",
                padding: "6px 0", borderBottom: "2px solid #f0f0f0",
                marginBottom: 4,
              }}>
                {section.title}
              </div>
              {section.rows.map(([label, value], i) => {
                if (!value) return null;
                return (
                  <div key={i} style={{
                    display: "flex", gap: 12, padding: "7px 0",
                    borderBottom: "1px solid #f7f7f7", fontSize: 14,
                  }}>
                    <span style={{ minWidth: 120, color: "#888", fontWeight: 500 }}>{label}</span>
                    <span style={{ flex: 1, wordBreak: "break-word" }}>{value}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        {/* actions */}
        <div style={{ padding: "16px 24px", marginTop: "auto", display: "flex", gap: 10 }}>
          {order.instagram && (
            <a href={`https://instagram.com/${order.instagram}`}
              target="_blank" rel="noopener noreferrer" style={{
                flex: 1, textAlign: "center", background: "#e1306c", color: "#fff",
                padding: "10px 0", borderRadius: 6, textDecoration: "none",
                fontWeight: 600, fontSize: 14,
              }}>Instagram</a>
          )}
        </div>
      </aside>
    </>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function OrderDashboard() {
  const {
    orders, total, totalAll, page, totalPages,
    stats, filters, dataStart,
  } = useLoaderData();

  const [selected, setSelected] = useState(null);
  const navigate = useNavigate();

  const todayStr = new Date().toISOString().split("T")[0];

  // Clamp preset dates so they never go before dataStart
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
    ...stats.map(s => ({
      label: s.type,
      value: s._count.id,
      color: TYPE_COLORS[s.type] ?? "#888",
    })),
  ];

  return (
    <s-page heading="Custom Orders Dashboard">
      <s-section>

        {/* ── Guideline banner ── */}
        <s-box marginBottom="base">
          <div style={{
            background: "#fffbeb", border: "1px solid #fcd34d",
            borderLeft: "4px solid #f59e0b", borderRadius: 8,
            padding: "12px 16px", display: "flex", gap: 10, alignItems: "flex-start",
          }}>
            <span style={{ fontSize: 18, lineHeight: 1.3 }}>📅</span>
            <div style={{ fontSize: 13, color: "#78350f", lineHeight: 1.7 }}>
              <strong>Order data is available from April 1, 2026 onwards.</strong>
              {" "}Orders submitted before this date were not tracked in the system —
              the date filter is blocked before <strong>Apr 1, 2026</strong>.
              Use the <em>From / To</em> pickers or the quick presets
              (<em>Today, Last 7d, Last 30d, Last 90d</em>) to narrow results by submission date.
            </div>
          </div>
        </s-box>

        {/* ── KPI cards ── */}
        <s-box marginBottom="base">
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
            {kpis.map(({ label, value, color }) => (
              <div key={label} style={{
                background: "#fff", borderRadius: 10, padding: "18px 24px",
                flex: "1 1 160px", minWidth: 140,
                borderTop: `4px solid ${color}`,
                boxShadow: "0 1px 4px rgba(0,0,0,0.08)",
              }}>
                <div style={{ fontSize: 28, fontWeight: 800, color }}>{value}</div>
                <div style={{ fontSize: 12, color: "#888", marginTop: 4, fontWeight: 600 }}>{label}</div>
              </div>
            ))}
          </div>
        </s-box>

        {/* ── Filter bar ── */}
        <s-box marginBottom="base" padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <Form method="get">

            {/* Row 1 — search + type */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 10 }}>
              <input
                name="search"
                defaultValue={filters.search}
                placeholder="Search name, email, instagram…"
                style={{
                  flex: "1 1 200px", padding: "8px 12px",
                  borderRadius: 6, border: "1px solid #e0e0e0", fontSize: 13,
                }}
              />
              <select
                name="type"
                defaultValue={filters.type}
                style={{
                  padding: "8px 12px", borderRadius: 6,
                  border: "1px solid #e0e0e0", fontSize: 13, minWidth: 150,
                }}
              >
                <option value="">All types</option>
                {["Custom Pendant", "Custom Set", "Custom Grillz", "Custom Rings"].map(t => (
                  <option key={t} value={t}>{t}</option>
                ))}
              </select>
            </div>

            {/* Row 2 — date range + presets + apply */}
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, color: "#666", fontWeight: 600 }}>From</span>
                <input
                  type="date"
                  name="dateFrom"
                  defaultValue={filters.dateFrom || dataStart}
                  min={dataStart}
                  style={{
                    padding: "7px 10px", borderRadius: 6,
                    border: "1px solid #e0e0e0", fontSize: 13,
                  }}
                />
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 12, color: "#666", fontWeight: 600 }}>To</span>
                <input
                  type="date"
                  name="dateTo"
                  defaultValue={filters.dateTo || todayStr}
                  min={dataStart}
                  style={{
                    padding: "7px 10px", borderRadius: 6,
                    border: "1px solid #e0e0e0", fontSize: 13,
                  }}
                />
              </div>

              {/* Quick presets */}
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                {presets.map(({ label, from, to }) => (
                  <button key={label} type="button" onClick={() => presetNav(from, to)} style={{
                    padding: "5px 10px", borderRadius: 6,
                    fontSize: 12, fontWeight: 600,
                    border: "1px solid #d1d5db",
                    background: "#fff", color: "#444",
                    whiteSpace: "nowrap", cursor: "pointer",
                  }}>
                    {label}
                  </button>
                ))}
              </div>

              <button type="submit" style={{
                background: "#179BD7", color: "#fff",
                border: "none", padding: "8px 16px",
                borderRadius: 6, cursor: "pointer",
                fontWeight: 600, fontSize: 13, whiteSpace: "nowrap",
              }}>
                Apply
              </button>

              {hasActiveFilter && (
                <button type="button" onClick={() => navigate("/app/order-dashboard")} style={{ fontSize: 13, color: "#888", whiteSpace: "nowrap", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
                  Clear all
                </button>
              )}

              <span style={{ marginLeft: "auto", fontSize: 13, color: "#888", whiteSpace: "nowrap" }}>
                {total} result{total !== 1 ? "s" : ""}
              </span>
            </div>

          </Form>
        </s-box>

        {/* ── Table ── */}
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
                      <th key={h} style={{
                        padding: "12px 14px", textAlign: "left",
                        fontSize: 11, fontWeight: 700, color: "#888",
                        textTransform: "uppercase", letterSpacing: "0.06em",
                        background: "#fafbfc",
                      }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {orders.map(order => (
                    <tr
                      key={order.id}
                      onClick={() => setSelected(order)}
                      style={{ cursor: "pointer", borderBottom: "1px solid #f0f2f5" }}
                      onMouseEnter={e => (e.currentTarget.style.background = "#f4f9fd")}
                      onMouseLeave={e => (e.currentTarget.style.background = "")}
                    >
                      <td style={{ padding: "12px 14px", fontSize: 13 }}>
                        {new Date(order.createdAt).toLocaleDateString()}
                      </td>
                      <td style={{ padding: "12px 14px" }}>
                        <TypeBadge type={order.type} />
                      </td>
                      <td style={{ padding: "12px 14px", fontSize: 13, fontWeight: 600 }}>{order.name}</td>
                      <td style={{ padding: "12px 14px", fontSize: 13 }}>{order.email}</td>
                      <td style={{ padding: "12px 14px", fontSize: 13 }}>
                        {order.instagram ? `@${order.instagram}` : "—"}
                      </td>
                      <td style={{ padding: "12px 14px", fontSize: 13 }}>
                        {order.pendantType || order.grillzTeeth || order.ringSize || "—"}
                      </td>
                      <td style={{ padding: "12px 14px", fontSize: 13 }}>
                        {order.pendantColor || order.grillzColor || order.ringColor || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination — carry all active filters */}
          {totalPages > 1 && (
            <div style={{
              padding: "14px 20px", borderTop: "1px solid #f0f2f5",
              display: "flex", gap: 8, justifyContent: "center",
            }}>
              {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                <a
                  key={p}
                  href="#" onClick={(e) => { e.preventDefault(); navigate(`?page=${p}&type=${filters.type}&search=${filters.search}&dateFrom=${filters.dateFrom || dataStart}&dateTo=${filters.dateTo || todayStr}`); }}
                  style={{
                    display: "inline-flex", alignItems: "center", justifyContent: "center",
                    width: 32, height: 32, borderRadius: 6,
                    fontSize: 13, fontWeight: 600,
                    background: p === page ? "#179BD7" : "#f0f2f5",
                    color:      p === page ? "#fff"    : "#444",
                    textDecoration: "none",
                  }}
                >
                  {p}
                </a>
              ))}
            </div>
          )}
        </s-box>

        {orders.length > 0 && (
          <s-box marginTop="base" style={{ textAlign: "center" }}>
            <s-text subdued size="small">
              💡 Click any row to view full order details
            </s-text>
          </s-box>
        )}

      </s-section>

      <OrderDrawer order={selected} onClose={() => setSelected(null)} />

      <style>{`
        @media (max-width: 768px) { .hide-sm { display: none !important; } }
      `}</style>
    </s-page>
  );
}