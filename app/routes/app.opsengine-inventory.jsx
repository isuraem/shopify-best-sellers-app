// ============================================
// FILE: app/routes/app.opsengine-inventory.jsx
// ============================================

import { useState, useEffect } from "react";
import { useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

// ─────────────────────────────────────────────
// LOADER
// ─────────────────────────────────────────────
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  try {
    // ── 1. Find the "opsengine" location ──────────────────────────────────
    const LOC_QUERY = `#graphql
      query findLocation {
        locations(first: 50, query: "name:opsengine") {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    `;

    const locResponse = await admin.graphql(LOC_QUERY);
    const locJson = await locResponse.json();

    if (locJson.errors) {
      return { success: false, error: `GraphQL error: ${locJson.errors[0].message}` };
    }

    const locationEdges = locJson.data?.locations?.edges || [];
    if (locationEdges.length === 0) {
      return {
        success: false,
        error: 'Location "opsengine" was not found. Check the location name in your Shopify admin.',
      };
    }

    const location = locationEdges[0].node;
    console.log(`✅ Found location: ${location.name} (${location.id})`);

    // ── 2. Fetch all inventory levels at this location ────────────────────
    const INV_QUERY = `#graphql
      query getLocationInventory($locationId: ID!, $cursor: String) {
        location(id: $locationId) {
          inventoryLevels(first: 250, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            edges {
              node {
                quantities(names: ["available"]) {
                  name
                  quantity
                }
                item {
                  id
                  sku
                  variant {
                    id
                    title
                    product {
                      id
                      title
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    let invCursor = null;
    let hasNextInvPage = true;
    const allInventoryItems = [];

    while (hasNextInvPage) {
      const invResponse = await admin.graphql(INV_QUERY, {
        variables: { locationId: location.id, cursor: invCursor },
      });
      const invJson = await invResponse.json();

      if (invJson.errors) {
        return { success: false, error: `GraphQL error: ${invJson.errors[0].message}` };
      }

      const levels = invJson.data?.location?.inventoryLevels?.edges || [];

      for (const edge of levels) {
        const node = edge.node;
        const availableQty =
          node.quantities?.find((q) => q.name === "available")?.quantity ?? 0;
        const item = node.item;

        // Skip items with no SKU or no linked variant/product
        if (!item?.sku || !item?.variant?.product) continue;

        allInventoryItems.push({
          inventoryItemId: item.id,
          sku: item.sku,
          variantId: item.variant.id,
          variantTitle: item.variant.title,
          productId: item.variant.product.id,
          productTitle: item.variant.product.title,
          availableInventory: availableQty,
          // sales filled in below
          netSales30: 0,
          netSales90: 0,
        });
      }

      hasNextInvPage = invJson.data.location.inventoryLevels.pageInfo.hasNextPage;
      invCursor = invJson.data.location.inventoryLevels.pageInfo.endCursor || null;

      if (hasNextInvPage) await new Promise((r) => setTimeout(r, 100));
    }

    console.log(`📦 Found ${allInventoryItems.length} inventory items at ${location.name}`);

    // ── 3. Fetch net sales (last 90 days covers both windows) ─────────────
    const variantIds = new Set(allInventoryItems.map((i) => i.variantId));
    const now = new Date();
    const date90 = new Date(now);
    date90.setDate(date90.getDate() - 90);
    const date30 = new Date(now);
    date30.setDate(date30.getDate() - 30);

    const iso90 = date90.toISOString();

    // gross sold per variant (last 90 days)
    const grossSold90 = {};  // variantId → qty
    const grossSold30 = {};  // variantId → qty

    const ORDERS_QUERY = `#graphql
      query getOrders($cursor: String, $query: String) {
        orders(first: 250, after: $cursor, query: $query) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              createdAt
              lineItems(first: 250) {
                edges {
                  node {
                    variant {
                      id
                    }
                    quantity
                    refundableQuantity
                  }
                }
              }
              refunds {
                refundLineItems(first: 250) {
                  edges {
                    node {
                      quantity
                      lineItem {
                        variant {
                          id
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    let orderCursor = null;
    let hasNextOrderPage = true;
    let orderCount = 0;

    // We'll accumulate gross sales and refunds separately, then compute net
    const refunded90 = {};
    const refunded30 = {};

    while (hasNextOrderPage) {
      const ordersResponse = await admin.graphql(ORDERS_QUERY, {
        variables: {
          cursor: orderCursor,
          query: `created_at:>=${iso90} status:any`,
        },
      });
      const ordersJson = await ordersResponse.json();

      if (ordersJson.errors) {
        console.error("Orders query error:", ordersJson.errors);
        break;
      }

      const orders = ordersJson.data?.orders?.edges || [];
      orderCount += orders.length;

      for (const orderEdge of orders) {
        const order = orderEdge.node;
        const orderDate = new Date(order.createdAt);
        const isWithin30 = orderDate >= date30;

        // ── Gross sold ──
        for (const liEdge of order.lineItems?.edges || []) {
          const li = liEdge.node;
          const vid = li.variant?.id;
          if (!vid || !variantIds.has(vid)) continue;

          const qty = li.quantity || 0;
          grossSold90[vid] = (grossSold90[vid] || 0) + qty;
          if (isWithin30) grossSold30[vid] = (grossSold30[vid] || 0) + qty;
        }

        // ── Refunded ──
        for (const refund of order.refunds || []) {
          for (const rliEdge of refund.refundLineItems?.edges || []) {
            const rli = rliEdge.node;
            const vid = rli.lineItem?.variant?.id;
            if (!vid || !variantIds.has(vid)) continue;

            const qty = rli.quantity || 0;
            refunded90[vid] = (refunded90[vid] || 0) + qty;
            if (isWithin30) refunded30[vid] = (refunded30[vid] || 0) + qty;
          }
        }
      }

      hasNextOrderPage = ordersJson.data.orders.pageInfo.hasNextPage;
      orderCursor = ordersJson.data.orders.pageInfo.endCursor || null;

      if (hasNextOrderPage) await new Promise((r) => setTimeout(r, 100));
    }

    console.log(`📊 Processed ${orderCount} orders for net sales calculation`);

    // ── 4. Merge net sales into inventory items ───────────────────────────
    const result = allInventoryItems.map((item) => ({
      ...item,
      netSales30: Math.max(
        0,
        (grossSold30[item.variantId] || 0) - (refunded30[item.variantId] || 0)
      ),
      netSales90: Math.max(
        0,
        (grossSold90[item.variantId] || 0) - (refunded90[item.variantId] || 0)
      ),
    }));

    return {
      success: true,
      items: result,
      locationName: location.name,
      locationId: location.id,
      totalItems: result.length,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    console.error("Error in opsengine-inventory loader:", error);
    return { success: false, error: `Unexpected error: ${error.message}` };
  }
}

// ─────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────
export default function OpsengineInventory() {
  const data = useLoaderData();
  const navigation = useNavigation();

  const isLoading = navigation.state === "loading";

  // ── Local state ──
  const [searchInput, setSearchInput] = useState("");
  const [sortConfig, setSortConfig] = useState({ key: null, direction: "desc" });
  const [filterZeroInventory, setFilterZeroInventory] = useState(false);

  // Derived filtered + sorted list
  const [displayItems, setDisplayItems] = useState([]);

  useEffect(() => {
    if (!data.success || !data.items) {
      setDisplayItems([]);
      return;
    }

    let items = [...data.items];

    // text filter
    if (searchInput.trim()) {
      const q = searchInput.toLowerCase();
      items = items.filter(
        (i) =>
          i.productTitle?.toLowerCase().includes(q) ||
          i.sku?.toLowerCase().includes(q) ||
          i.variantTitle?.toLowerCase().includes(q)
      );
    }

    // zero inventory filter
    if (filterZeroInventory) {
      items = items.filter((i) => i.availableInventory <= 0);
    }

    // sorting
    if (sortConfig.key) {
      items.sort((a, b) => {
        const valA = a[sortConfig.key] ?? 0;
        const valB = b[sortConfig.key] ?? 0;
        if (typeof valA === "string") {
          return sortConfig.direction === "asc"
            ? valA.localeCompare(valB)
            : valB.localeCompare(valA);
        }
        return sortConfig.direction === "asc" ? valA - valB : valB - valA;
      });
    }

    setDisplayItems(items);
  }, [data, searchInput, sortConfig, filterZeroInventory]);

  const handleSort = (key) => {
    setSortConfig((prev) =>
      prev.key === key
        ? { key, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { key, direction: "desc" }
    );
  };

  const sortIcon = (key) => {
    if (sortConfig.key !== key) return " ↕";
    return sortConfig.direction === "asc" ? " ↑" : " ↓";
  };

  // ── CSV export ──
  const handleExportCsv = () => {
    const headers = ["Product Title", "SKU", "Variant", "Net Sold (30d)", "Net Sold (90d)", "Available Inventory"];
    const rows = displayItems.map((item) => [
      `"${(item.productTitle || "").replace(/"/g, '""')}"`,
      `"${(item.sku || "").replace(/"/g, '""')}"`,
      `"${(item.variantTitle || "").replace(/"/g, '""')}"`,
      item.netSales30,
      item.netSales90,
      item.availableInventory,
    ]);

    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const timestamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `opsengine-inventory-${timestamp}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // ── Summary numbers ──
  const totalInventory = displayItems.reduce((s, i) => s + i.availableInventory, 0);
  const totalSales30 = displayItems.reduce((s, i) => s + i.netSales30, 0);
  const totalSales90 = displayItems.reduce((s, i) => s + i.netSales90, 0);

  if (!data.success) {
    return (
      <s-page heading="Opsengine Inventory">
        <s-section>
          <s-box padding="large" borderWidth="base" borderRadius="base" background="critical">
            <s-text tone="critical">{data.error}</s-text>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Opsengine Inventory">
      <s-section>

        {/* ── Header / meta ── */}
        <s-box marginBottom="base" padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "12px" }}>
            <div>
              <s-heading size="medium">📍 Location: {data.locationName}</s-heading>
              <s-text subdued size="small">
                Last fetched: {data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : "—"}
              </s-text>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button
                onClick={handleExportCsv}
                disabled={displayItems.length === 0}
                style={{
                  padding: "8px 16px",
                  backgroundColor: displayItems.length === 0 ? "#9ca3af" : "#10b981",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "13px",
                  fontWeight: "600",
                  cursor: displayItems.length === 0 ? "not-allowed" : "pointer",
                }}
              >
                ⬇️ Export CSV ({displayItems.length})
              </button>
              <a
                href="."
                style={{
                  padding: "8px 16px",
                  backgroundColor: "#4b5563",
                  color: "white",
                  textDecoration: "none",
                  borderRadius: "6px",
                  fontSize: "13px",
                  fontWeight: "600",
                }}
              >
                🔄 Refresh
              </a>
            </div>
          </div>
        </s-box>

        {/* ── Summary stats ── */}
        <s-box marginBottom="base" padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "16px" }}>
            <StatCard label="Total SKUs" value={data.totalItems} color="#3b82f6" />
            <StatCard label="Filtered Rows" value={displayItems.length} color="#6366f1" />
            <StatCard label="Total Available" value={totalInventory} color="#10b981" />
            <StatCard label="Net Sold (30d)" value={totalSales30} color="#f59e0b" />
            <StatCard label="Net Sold (90d)" value={totalSales90} color="#ef4444" />
          </div>
        </s-box>

        {/* ── Toolbar ── */}
        <s-box marginBottom="base" padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="text"
              placeholder="Filter by product title, SKU, or variant…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              style={{
                flex: 1,
                minWidth: "240px",
                padding: "10px 14px",
                fontSize: "13px",
                borderRadius: "8px",
                border: "1px solid #d1d5db",
                outline: "none",
              }}
            />
            <label style={{ display: "flex", alignItems: "center", gap: "6px", fontSize: "13px", color: "#374151", cursor: "pointer", userSelect: "none" }}>
              <input
                type="checkbox"
                checked={filterZeroInventory}
                onChange={(e) => setFilterZeroInventory(e.target.checked)}
              />
              Show zero-inventory only
            </label>
            {searchInput && (
              <button
                onClick={() => setSearchInput("")}
                style={{
                  padding: "8px 14px",
                  backgroundColor: "#6b7280",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  fontSize: "13px",
                  cursor: "pointer",
                }}
              >
                Clear
              </button>
            )}
          </div>
        </s-box>

        {/* ── Loading overlay ── */}
        {isLoading && (
          <s-box padding="xlarge" borderWidth="base" borderRadius="base" background="subdued" style={{ textAlign: "center" }}>
            <div style={{
              display: "inline-block", width: "24px", height: "24px",
              border: "3px solid #e5e7eb", borderTopColor: "#3b82f6",
              borderRadius: "50%", animation: "spin 1s linear infinite",
              marginBottom: "12px",
            }} />
            <s-heading size="medium">Loading inventory…</s-heading>
          </s-box>
        )}

        {/* ── Table ── */}
        {!isLoading && (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            {displayItems.length === 0 ? (
              <s-box padding="large" style={{ textAlign: "center" }}>
                <s-text subdued>No items match your current filter.</s-text>
              </s-box>
            ) : (
              <>
                <s-box marginBottom="small">
                  <s-text subdued size="small">
                    Showing {displayItems.length} of {data.totalItems} SKUs
                    {searchInput && ` matching "${searchInput}"`}
                    {filterZeroInventory && " · zero-inventory only"}
                    {sortConfig.key && ` · sorted by ${sortConfig.key} (${sortConfig.direction})`}
                  </s-text>
                </s-box>

                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", backgroundColor: "white", fontSize: "13px" }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid #e5e7eb", backgroundColor: "#f9fafb" }}>
                        <Th label="Product Title" sortKey="productTitle" sortConfig={sortConfig} onSort={handleSort} minWidth="220px" />
                        <Th label="SKU" sortKey="sku" sortConfig={sortConfig} onSort={handleSort} minWidth="130px" mono />
                        <Th label="Variant" sortKey="variantTitle" sortConfig={sortConfig} onSort={handleSort} minWidth="120px" />
                        <Th label="Net Sold (30d)" sortKey="netSales30" sortConfig={sortConfig} onSort={handleSort} minWidth="120px" align="right" />
                        <Th label="Net Sold (90d)" sortKey="netSales90" sortConfig={sortConfig} onSort={handleSort} minWidth="120px" align="right" />
                        <Th label="Available" sortKey="availableInventory" sortConfig={sortConfig} onSort={handleSort} minWidth="100px" align="right" />
                      </tr>
                    </thead>
                    <tbody>
                      {displayItems.map((item, idx) => (
                        <tr
                          key={item.inventoryItemId + idx}
                          style={{
                            borderBottom: "1px solid #f3f4f6",
                            backgroundColor: idx % 2 === 0 ? "white" : "#fafafa",
                          }}
                        >
                          <td style={{ padding: "10px 12px", fontWeight: "600" }}>{item.productTitle}</td>
                          <td style={{ padding: "10px 12px", fontFamily: "monospace", fontWeight: "700", color: "#1d4ed8" }}>{item.sku}</td>
                          <td style={{ padding: "10px 12px", color: "#6b7280" }}>{item.variantTitle}</td>
                          <SalesCell value={item.netSales30} />
                          <SalesCell value={item.netSales90} />
                          <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: "700", color: item.availableInventory > 0 ? "#065f46" : "#991b1b" }}>
                            <span style={{
                              backgroundColor: item.availableInventory > 0 ? "#d1fae5" : "#fee2e2",
                              padding: "3px 8px",
                              borderRadius: "4px",
                            }}>
                              {item.availableInventory}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </s-box>
        )}

      </s-section>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        th { user-select: none; }
        th:hover { background-color: #f3f4f6; }
      `}</style>
    </s-page>
  );
}

// ─────────────────────────────────────────────
// Small helper components
// ─────────────────────────────────────────────

function StatCard({ label, value, color }) {
  return (
    <div style={{ padding: "12px 16px", backgroundColor: "white", borderRadius: "8px", border: "1px solid #e5e7eb" }}>
      <div style={{ fontSize: "11px", color: "#9ca3af", fontWeight: "600", textTransform: "uppercase", marginBottom: "4px" }}>{label}</div>
      <div style={{ fontSize: "22px", fontWeight: "800", color }}>{value?.toLocaleString()}</div>
    </div>
  );
}

function Th({ label, sortKey, sortConfig, onSort, minWidth, align = "left", mono = false }) {
  const isActive = sortConfig.key === sortKey;
  return (
    <th
      onClick={() => onSort(sortKey)}
      style={{
        textAlign: align,
        padding: "10px 12px",
        minWidth,
        cursor: "pointer",
        fontWeight: "700",
        fontSize: "12px",
        color: isActive ? "#1d4ed8" : "#374151",
        fontFamily: mono ? "monospace" : "inherit",
        whiteSpace: "nowrap",
      }}
    >
      {label}
      <span style={{ color: "#9ca3af" }}>
        {isActive ? (sortConfig.direction === "asc" ? " ↑" : " ↓") : " ↕"}
      </span>
    </th>
  );
}

function SalesCell({ value }) {
  return (
    <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: "700", color: value > 0 ? "#92400e" : "#9ca3af" }}>
      {value > 0 ? (
        <span style={{ backgroundColor: "#fef3c7", padding: "3px 8px", borderRadius: "4px" }}>
          {value}
        </span>
      ) : (
        <span style={{ color: "#d1d5db" }}>0</span>
      )}
    </td>
  );
}