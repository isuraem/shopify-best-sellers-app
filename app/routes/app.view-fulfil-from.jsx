// ============================================
// FILE: app/routes/app.view-fulfil-from.jsx
// ============================================

import { useState, useEffect } from "react";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";

// Loader to fetch all variants with fulfil_from metafield
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);

  try {
    let cursor = null;
    let hasNextPage = true;
    const usVariants = [];
    const cnVariants = [];
    const noMetafieldVariants = [];

    const PRODUCTS_QUERY = `#graphql
      query getProductsWithMetafields($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              images(first: 1) {
                nodes {
                  url
                }
              }
              variants(first: 100) {
                edges {
                  node {
                    id
                    sku
                    title
                    metafield(namespace: "custom", key: "fulfil_from") {
                      value
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    console.log("Fetching all products with fulfil_from metafield...");

    // Fetch all Shopify variants with metafields
    while (hasNextPage) {
      const response = await admin.graphql(PRODUCTS_QUERY, {
        variables: { cursor },
      });

      const json = await response.json();

      if (json.errors) {
        return {
          success: false,
          error: `GraphQL error: ${json.errors[0].message}`,
        };
      }

      const products = json.data?.products?.edges || [];

      for (const productEdge of products) {
        const product = productEdge.node;

        if (!product.variants?.edges?.length) continue;

        for (const variantEdge of product.variants.edges) {
          const variant = variantEdge.node;
          const sku = variant.sku?.trim();

          if (!sku) continue;

          const fulfilFrom = variant.metafield?.value;

          const variantData = {
            variantId: variant.id,
            productId: product.id,
            productTitle: product.title,
            productImage: product.images?.nodes?.[0]?.url || null,
            variantTitle: variant.title,
            sku: sku,
            fulfilFrom: fulfilFrom || null,
          };

          if (fulfilFrom === "US") {
            usVariants.push(variantData);
          } else if (fulfilFrom === "CN") {
            cnVariants.push(variantData);
          } else {
            noMetafieldVariants.push(variantData);
          }
        }
      }

      hasNextPage = json.data.products.pageInfo.hasNextPage;
      cursor = json.data.products.pageInfo.endCursor || null;

      if (hasNextPage) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    console.log(`Fetched - US: ${usVariants.length}, CN: ${cnVariants.length}, No Metafield: ${noMetafieldVariants.length}`);

    return {
      success: true,
      usVariants,
      cnVariants,
      noMetafieldVariants,
      totalVariants: usVariants.length + cnVariants.length + noMetafieldVariants.length,
    };
  } catch (error) {
    console.error("Error fetching variants:", error);
    return {
      success: false,
      error: `Error fetching variants: ${error.message}`,
    };
  }
}

// Component
export default function ViewFulfilFrom() {
  const data = useLoaderData();
  const [selectedTab, setSelectedTab] = useState("us");
  const [searchTerm, setSearchTerm] = useState("");
  const [filteredVariants, setFilteredVariants] = useState([]);

  // Get current tab data
  const getCurrentTabData = () => {
    if (!data.success) return [];
    
    switch (selectedTab) {
      case "us":
        return data.usVariants || [];
      case "cn":
        return data.cnVariants || [];
      case "none":
        return data.noMetafieldVariants || [];
      default:
        return [];
    }
  };

  // Filter variants based on search term
  useEffect(() => {
    const currentData = getCurrentTabData();
    
    if (!searchTerm.trim()) {
      setFilteredVariants(currentData);
      return;
    }

    const searchLower = searchTerm.toLowerCase();
    const filtered = currentData.filter(variant => 
      variant.sku?.toLowerCase().includes(searchLower) ||
      variant.productTitle?.toLowerCase().includes(searchLower) ||
      variant.variantTitle?.toLowerCase().includes(searchLower)
    );

    setFilteredVariants(filtered);
  }, [searchTerm, selectedTab, data]);

  if (!data.success) {
    return (
      <s-page heading="View Fulfil From Variants">
        <s-section>
          <s-box padding="large" borderWidth="base" borderRadius="base" background="critical">
            <s-text tone="critical">{data.error}</s-text>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="View Fulfil From Variants">
      <s-section>
        {/* Summary Stats */}
        <s-box
          marginBottom="base"
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
            <div>
              <s-text subdued size="small">Total Variants</s-text>
              <s-heading size="medium">{data.totalVariants || 0}</s-heading>
            </div>
            <div>
              <s-text subdued size="small">US Fulfillment</s-text>
              <s-heading size="medium" style={{ color: "#3b82f6" }}>{data.usVariants?.length || 0}</s-heading>
            </div>
            <div>
              <s-text subdued size="small">CN Fulfillment</s-text>
              <s-heading size="medium" style={{ color: "#ef4444" }}>{data.cnVariants?.length || 0}</s-heading>
            </div>
            <div>
              <s-text subdued size="small">No Metafield Set</s-text>
              <s-heading size="medium" style={{ color: "#6b7280" }}>{data.noMetafieldVariants?.length || 0}</s-heading>
            </div>
          </div>

          <s-box marginTop="base" style={{ textAlign: "center" }}>
            <s-button onClick={() => window.location.reload()}>
              Refresh Data
            </s-button>
          </s-box>
        </s-box>

        {/* Search Bar */}
        <s-box marginBottom="base">
          <input
            type="text"
            placeholder="Search by SKU, Product, or Variant..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            style={{
              width: "100%",
              padding: "12px 16px",
              fontSize: "14px",
              borderRadius: "8px",
              border: "1px solid #d1d5db",
              outline: "none",
            }}
          />
        </s-box>

        {/* Tabs */}
        <s-box marginBottom="base">
          <div style={{ display: "flex", gap: "8px", borderBottom: "2px solid #e5e7eb" }}>
            <button
              onClick={() => setSelectedTab("us")}
              style={{
                padding: "12px 20px",
                border: "none",
                background: selectedTab === "us" ? "#3b82f6" : "transparent",
                color: selectedTab === "us" ? "white" : "#6b7280",
                fontWeight: "600",
                cursor: "pointer",
                borderRadius: "4px 4px 0 0",
              }}
            >
              🇺🇸 US ({data.usVariants?.length || 0})
            </button>
            <button
              onClick={() => setSelectedTab("cn")}
              style={{
                padding: "12px 20px",
                border: "none",
                background: selectedTab === "cn" ? "#ef4444" : "transparent",
                color: selectedTab === "cn" ? "white" : "#6b7280",
                fontWeight: "600",
                cursor: "pointer",
                borderRadius: "4px 4px 0 0",
              }}
            >
              🇨🇳 CN ({data.cnVariants?.length || 0})
            </button>
            <button
              onClick={() => setSelectedTab("none")}
              style={{
                padding: "12px 20px",
                border: "none",
                background: selectedTab === "none" ? "#6b7280" : "transparent",
                color: selectedTab === "none" ? "white" : "#6b7280",
                fontWeight: "600",
                cursor: "pointer",
                borderRadius: "4px 4px 0 0",
              }}
            >
              ❓ No Metafield ({data.noMetafieldVariants?.length || 0})
            </button>
          </div>
        </s-box>

        {/* Tab Content */}
        <s-box
          padding="base"
          borderWidth="base"
          borderRadius="base"
          background="subdued"
        >
          {filteredVariants.length === 0 ? (
            <s-box padding="large" style={{ textAlign: "center" }}>
              <s-text subdued>
                {searchTerm ? "No variants found matching your search" : "No variants in this category"}
              </s-text>
            </s-box>
          ) : (
            <>
              {/* Results count */}
              <s-box marginBottom="base">
                <s-text subdued size="small">
                  Showing {filteredVariants.length} {filteredVariants.length === 1 ? 'variant' : 'variants'}
                  {searchTerm && ` matching "${searchTerm}"`}
                </s-text>
              </s-box>

              {/* Table */}
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", backgroundColor: "white" }}>
                  <thead>
                    <tr style={{ borderBottom: "2px solid #ddd" }}>
                      <th style={{ textAlign: "left", padding: "10px", minWidth: "60px" }}>Image</th>
                      <th style={{ textAlign: "left", padding: "10px", minWidth: "120px" }}>SKU</th>
                      <th style={{ textAlign: "left", padding: "10px", minWidth: "200px" }}>Product</th>
                      <th style={{ textAlign: "left", padding: "10px", minWidth: "150px" }}>Variant</th>
                      <th style={{ textAlign: "left", padding: "10px", minWidth: "100px" }}>Fulfil From</th>
                      <th style={{ textAlign: "left", padding: "10px", minWidth: "150px" }}>Variant ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredVariants.map((item, index) => (
                      <tr key={index} style={{ borderBottom: "1px solid #eee" }}>
                        <td style={{ padding: "10px" }}>
                          {item.productImage ? (
                            <img 
                              src={item.productImage} 
                              width="50" 
                              height="50"
                              style={{ borderRadius: "4px", objectFit: "cover" }} 
                              alt="" 
                            />
                          ) : (
                            <div style={{ 
                              width: "50px", 
                              height: "50px", 
                              backgroundColor: "#e5e7eb", 
                              borderRadius: "4px",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              fontSize: "20px"
                            }}>
                              📦
                            </div>
                          )}
                        </td>
                        <td style={{ padding: "10px", fontFamily: "monospace", fontWeight: "600", fontSize: "13px" }}>
                          {item.sku}
                        </td>
                        <td style={{ padding: "10px", fontSize: "13px" }}>
                          {item.productTitle}
                        </td>
                        <td style={{ padding: "10px", fontSize: "12px", color: "#6b7280" }}>
                          {item.variantTitle}
                        </td>
                        <td style={{ padding: "10px" }}>
                          {item.fulfilFrom ? (
                            <span style={{
                              backgroundColor: item.fulfilFrom === "US" ? "#dbeafe" : "#fee2e2",
                              color: item.fulfilFrom === "US" ? "#1e40af" : "#991b1b",
                              padding: "6px 12px",
                              borderRadius: "6px",
                              fontSize: "12px",
                              fontWeight: "600",
                              display: "inline-block",
                            }}>
                              {item.fulfilFrom === "US" ? "🇺🇸 US" : "🇨🇳 CN"}
                            </span>
                          ) : (
                            <span style={{
                              color: "#9ca3af",
                              fontSize: "12px",
                              fontStyle: "italic",
                            }}>
                              Not Set
                            </span>
                          )}
                        </td>
                        <td style={{ padding: "10px", fontSize: "11px", fontFamily: "monospace", color: "#6b7280" }}>
                          {item.variantId.replace("gid://shopify/ProductVariant/", "")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </s-box>

        {/* Export Options */}
        <s-box marginTop="base" style={{ textAlign: "center" }}>
          <s-text subdued size="small">
            Tip: You can use the search bar to filter variants and export specific SKUs
          </s-text>
        </s-box>
      </s-section>
    </s-page>
  );
}