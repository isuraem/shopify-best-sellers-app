// ============================================
// FILE: app/routes/app.view-fulfil-from.jsx
// ============================================

import { useState, useEffect } from "react";
import { useLoaderData, useFetcher } from "react-router";
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
                    inventoryItem {
                      id
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    // Fetch all locations
    const LOCATIONS_QUERY = `#graphql
      query getLocations {
        locations(first: 100) {
          edges {
            node {
              id
              name
              isActive
            }
          }
        }
      }
    `;

    console.log("Fetching locations...");
    const locationsResponse = await admin.graphql(LOCATIONS_QUERY);
    const locationsJson = await locationsResponse.json();
    
    const locations = locationsJson.data?.locations?.edges
      ?.filter(edge => edge.node.isActive)
      ?.map(edge => ({
        id: edge.node.id,
        name: edge.node.name,
      })) || [];

    console.log(`Found ${locations.length} active locations`);

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
            inventoryItemId: variant.inventoryItem?.id,
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

    // Fetch inventory locations for US variants only (to reduce cost)
    console.log("Fetching inventory locations for US variants...");
    const allInventoryItemIds = usVariants
      .map(v => v.inventoryItemId)
      .filter(Boolean);

    const inventoryLocationsMap = {};

    // Fetch in batches of 50 inventory items
    const batchSize = 50;
    for (let i = 0; i < allInventoryItemIds.length; i += batchSize) {
      const batchIds = allInventoryItemIds.slice(i, i + batchSize);
      
      const INVENTORY_QUERY = `#graphql
        query getInventoryLevels($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on InventoryItem {
              id
              inventoryLevels(first: 10) {
                edges {
                  node {
                    location {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
        }
      `;

      try {
        const invResponse = await admin.graphql(INVENTORY_QUERY, {
          variables: { ids: batchIds },
        });

        const invJson = await invResponse.json();

        if (invJson.data?.nodes) {
          invJson.data.nodes.forEach(node => {
            if (node && node.id) {
              const locationNames = node.inventoryLevels?.edges
                ?.map(edge => edge.node.location.name)
                .filter(Boolean) || [];
              inventoryLocationsMap[node.id] = locationNames;
            }
          });
        }

        // Small delay between batches
        if (i + batchSize < allInventoryItemIds.length) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      } catch (err) {
        console.error(`Error fetching inventory batch ${i}:`, err);
      }
    }

    // Add inventory locations to US variants
    usVariants.forEach(variant => {
      variant.inventoryLocations = inventoryLocationsMap[variant.inventoryItemId] || [];
    });

    console.log("Inventory locations fetched successfully");

    return {
      success: true,
      usVariants,
      cnVariants,
      noMetafieldVariants,
      totalVariants: usVariants.length + cnVariants.length + noMetafieldVariants.length,
      locations,
    };
  } catch (error) {
    console.error("Error fetching variants:", error);
    return {
      success: false,
      error: `Error fetching variants: ${error.message}`,
    };
  }
}

// Action to handle location transformation - OPTIMIZED with parallel processing
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);

  try {
    const formData = await request.formData();
    const locationId = formData.get("locationId");
    const variantsData = JSON.parse(formData.get("variantsData"));

    console.log(`Setting location ${locationId} for ${variantsData.length} variants...`);

    const results = {
      success: 0,
      failed: 0,
      errors: [],
      skipped: 0,
    };

    // Filter out variants without inventory item IDs
    const validVariants = variantsData.filter(v => v.inventoryItemId);

    if (validVariants.length === 0) {
      return {
        success: false,
        error: "No valid inventory items found for the selected variants",
      };
    }

    console.log(`Processing ${validVariants.length} inventory items...`);

    const ACTIVATE_MUTATION = `#graphql
      mutation inventoryActivate($inventoryItemId: ID!, $locationId: ID!) {
        inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId) {
          inventoryLevel {
            id
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    // Process in parallel batches for speed - 15 at a time
    const batchSize = 15;
    const maxTime = 25000; // 25 seconds max
    const startTime = Date.now();

    for (let i = 0; i < validVariants.length; i += batchSize) {
      // Check timeout
      if (Date.now() - startTime > maxTime) {
        console.log(`Timeout approaching, processed ${i} of ${validVariants.length}`);
        results.skipped = validVariants.length - i;
        results.errors.push(`⏱️ Processed ${i}/${validVariants.length} variants before timeout. Please click Transform again to process remaining ${results.skipped} variants.`);
        break;
      }

      const batch = validVariants.slice(i, i + batchSize);
      
      // Process entire batch in parallel
      const batchResults = await Promise.all(
        batch.map(async (variant) => {
          try {
            const activateResponse = await admin.graphql(ACTIVATE_MUTATION, {
              variables: {
                inventoryItemId: variant.inventoryItemId,
                locationId: locationId,
              },
            });

            const activateJson = await activateResponse.json();

            if (activateJson.data?.inventoryActivate?.userErrors?.length > 0) {
              const errorMsg = activateJson.data.inventoryActivate.userErrors[0].message;
              if (errorMsg.toLowerCase().includes("already") || 
                  errorMsg.toLowerCase().includes("stocked") ||
                  errorMsg.toLowerCase().includes("active")) {
                return { success: true, sku: variant.sku };
              } else {
                return { 
                  success: false, 
                  sku: variant.sku, 
                  error: errorMsg 
                };
              }
            } else if (activateJson.data?.inventoryActivate?.inventoryLevel) {
              return { success: true, sku: variant.sku };
            } else if (activateJson.errors && activateJson.errors.length > 0) {
              return { 
                success: false, 
                sku: variant.sku, 
                error: activateJson.errors[0].message 
              };
            } else {
              return { 
                success: false, 
                sku: variant.sku, 
                error: "Unknown error" 
              };
            }
          } catch (err) {
            return { 
              success: false, 
              sku: variant.sku, 
              error: err.message 
            };
          }
        })
      );

      // Collect results
      batchResults.forEach(result => {
        if (result.success) {
          results.success++;
        } else {
          results.failed++;
          if (results.errors.length < 15) {
            results.errors.push(`SKU ${result.sku}: ${result.error}`);
          }
        }
      });

      // Progress log
      console.log(`Processed ${Math.min(i + batchSize, validVariants.length)}/${validVariants.length} variants`);

      // Tiny delay to avoid overwhelming the API
      if (i + batchSize < validVariants.length && Date.now() - startTime < maxTime) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    console.log(`Transformation complete - Success: ${results.success}, Failed: ${results.failed}, Skipped: ${results.skipped}`);

    return {
      success: true,
      results,
    };

  } catch (error) {
    console.error("Error in action:", error);
    return {
      success: false,
      error: error.message,
    };
  }
}

// Component
export default function ViewFulfilFrom() {
  const data = useLoaderData();
  const fetcher = useFetcher();
  const [selectedTab, setSelectedTab] = useState("us");
  const [searchTerm, setSearchTerm] = useState("");
  const [filteredVariants, setFilteredVariants] = useState([]);
  const [selectedLocation, setSelectedLocation] = useState("");
  const [isTransforming, setIsTransforming] = useState(false);

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

  // Handle transformation
  const handleTransform = async () => {
    if (!selectedLocation) {
      alert("Please select a location first");
      return;
    }

    if (filteredVariants.length === 0) {
      alert("No variants to transform");
      return;
    }

    const locationName = data.locations?.find(l => l.id === selectedLocation)?.name || "selected location";
    
    const confirmMsg = `Are you sure you want to set location "${locationName}" for ${filteredVariants.length} US variant(s)?\n\nThis will add the location to their inventory without removing existing locations.`;
    
    if (!confirm(confirmMsg)) {
      return;
    }

    setIsTransforming(true);

    // Send full variant data including inventoryItemId
    const variantsData = filteredVariants.map(v => ({
      variantId: v.variantId,
      inventoryItemId: v.inventoryItemId,
      sku: v.sku,
    }));

    fetcher.submit(
      {
        locationId: selectedLocation,
        variantsData: JSON.stringify(variantsData),
      },
      { method: "post" }
    );
  };

  // Handle fetcher state changes
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) {
      setIsTransforming(false);
      
      if (fetcher.data.success && fetcher.data.results) {
        const { results } = fetcher.data;
        let message = `✅ Transformation complete!\n\n✓ Success: ${results.success}\n✗ Failed: ${results.failed}`;
        
        if (results.skipped > 0) {
          message += `\n⏱️ Skipped: ${results.skipped} (timeout)\n\n⚠️ Please click Transform again to process remaining variants.`;
        }
        
        if (results.errors.length > 0 && results.errors.length <= 15) {
          message += `\n\nErrors:\n${results.errors.join('\n')}`;
        } else if (results.errors.length > 15) {
          message += `\n\nShowing first 15 errors:\n${results.errors.slice(0, 15).join('\n')}`;
        }
        
        alert(message);
        
        // Reload page to show updated locations
        if (results.success > 0) {
          setTimeout(() => {
            window.location.reload();
          }, 1000);
        }
      } else if (!fetcher.data.success) {
        alert(`❌ Error: ${fetcher.data.error}`);
      }
    }
  }, [fetcher.state, fetcher.data]);

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

          {/* Location Selection - Only show for US tab */}
          {selectedTab === "us" && (
            <s-box 
              marginTop="base" 
              padding="base" 
              borderWidth="base" 
              borderRadius="base"
              style={{ backgroundColor: "#f9fafb" }}
            >
              <s-text weight="bold" size="small" style={{ display: "block", marginBottom: "12px" }}>
                🏢 Set Inventory Location for US Variants
              </s-text>
              
              <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
                <select
                  value={selectedLocation}
                  onChange={(e) => setSelectedLocation(e.target.value)}
                  disabled={isTransforming}
                  style={{
                    flex: "1",
                    minWidth: "200px",
                    padding: "10px 12px",
                    fontSize: "14px",
                    borderRadius: "6px",
                    border: "1px solid #d1d5db",
                    backgroundColor: "white",
                    cursor: isTransforming ? "not-allowed" : "pointer",
                    outline: "none",
                  }}
                >
                  <option value="">Select a location...</option>
                  {data.locations?.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name}
                    </option>
                  ))}
                </select>

                <button
                  onClick={handleTransform}
                  disabled={!selectedLocation || isTransforming || filteredVariants.length === 0}
                  style={{
                    padding: "10px 24px",
                    fontSize: "14px",
                    fontWeight: "600",
                    borderRadius: "6px",
                    border: "none",
                    backgroundColor: !selectedLocation || isTransforming || filteredVariants.length === 0 ? "#d1d5db" : "#3b82f6",
                    color: "white",
                    cursor: !selectedLocation || isTransforming || filteredVariants.length === 0 ? "not-allowed" : "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {isTransforming ? "⏳ Processing..." : "🔄 Transform"}
                </button>
              </div>

              <s-text subdued size="small" style={{ display: "block", marginTop: "8px" }}>
                {searchTerm 
                  ? `Will apply to ${filteredVariants.length} filtered variant(s)`
                  : `Will apply to all ${filteredVariants.length} US variant(s)`
                }
              </s-text>
            </s-box>
          )}

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
                      {selectedTab === "us" && (
                        <th style={{ textAlign: "left", padding: "10px", minWidth: "200px" }}>Inventory Locations</th>
                      )}
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
                        {selectedTab === "us" && (
                          <td style={{ padding: "10px" }}>
                            {item.inventoryLocations && item.inventoryLocations.length > 0 ? (
                              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>
                                {item.inventoryLocations.map((location, idx) => (
                                  <span 
                                    key={idx}
                                    style={{
                                      backgroundColor: "#f3f4f6",
                                      color: "#374151",
                                      padding: "4px 8px",
                                      borderRadius: "4px",
                                      fontSize: "11px",
                                      fontWeight: "500",
                                      display: "inline-block",
                                      border: "1px solid #e5e7eb",
                                    }}
                                  >
                                    📍 {location}
                                  </span>
                                ))}
                              </div>
                            ) : (
                              <span style={{
                                color: "#9ca3af",
                                fontSize: "12px",
                                fontStyle: "italic",
                              }}>
                                No locations
                              </span>
                            )}
                          </td>
                        )}
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
            💡 Tip: You can use the search bar to filter variants and apply location to specific groups
          </s-text>
        </s-box>
      </s-section>
    </s-page>
  );
}