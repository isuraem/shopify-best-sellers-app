// ============================================
// FILE: app/routes/app.missing-skus.jsx
// ============================================

import { useState } from "react";
import { useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

// Named export for the loader
export async function loader({ request }) {
  try {
    const { admin } = await authenticate.admin(request);

    console.log("Fetching all products to find missing SKUs...");

    let cursor = null;
    let hasNextPage = true;
    let fetchedProducts = 0;

    const missingSKUs = [];

    const PRODUCTS_QUERY = `#graphql
      query getProductsWithVariants($cursor: String) {
        products(first: 250, after: $cursor) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              status
              totalInventory
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
                    barcode
                    title
                    inventoryQuantity
                    price
                  }
                }
              }
            }
          }
        }
      }
    `;

    try {
      let totalVariants = 0;
      let variantsWithSKUs = 0;

      // Fetch all products
      while (hasNextPage) {
        console.log(`📦 Fetching products page... (total so far: ${fetchedProducts})`);

        const response = await admin.graphql(PRODUCTS_QUERY, {
          variables: { cursor },
        });

        const json = await response.json();

        if (json.errors) {
          console.error("GraphQL errors:", json.errors);
          return {
            missingSKUs: [],
            totalProductsScanned: 0,
            totalVariantsScanned: 0,
            variantsWithSKUs: 0,
            error: `GraphQL error: ${json.errors[0].message}`,
          };
        }

        if (!json.data?.products) {
          console.error("Failed to fetch products - no data returned");
          return {
            missingSKUs: [],
            totalProductsScanned: 0,
            totalVariantsScanned: 0,
            variantsWithSKUs: 0,
            error: "Failed to fetch products. Check app scopes (read_products).",
          };
        }

        const products = json.data.products.edges;
        fetchedProducts += products.length;

        console.log(`✅ Fetched ${products.length} products in this page, total so far: ${fetchedProducts}`);

        // Process each product and its variants
        for (const productEdge of products) {
          const product = productEdge.node;

          if (!product.variants?.edges?.length) continue;

          for (const variantEdge of product.variants.edges) {
            const variant = variantEdge.node;
            totalVariants++;

            const sku = variant.sku?.trim();

            if (sku) {
              variantsWithSKUs++;
            } else {
              // This variant is missing a SKU
              missingSKUs.push({
                productId: product.id,
                productTitle: product.title,
                productStatus: product.status,
                productImage: product.images?.nodes?.[0]?.url || null,
                variantId: variant.id,
                variantTitle: variant.title,
                barcode: variant.barcode || "N/A",
                inventoryQuantity: variant.inventoryQuantity || 0,
                price: variant.price,
                totalInventory: product.totalInventory,
              });
            }
          }
        }

        hasNextPage = json.data.products.pageInfo.hasNextPage;
        cursor = json.data.products.pageInfo.endCursor || null;

        console.log(`🔄 hasNextPage: ${hasNextPage}, cursor: ${cursor ? "present" : "null"}`);

        if (hasNextPage) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      console.log(`🎉 FINAL: Fetched ${fetchedProducts} products total`);
      console.log(`📊 Total variants: ${totalVariants}, With SKUs: ${variantsWithSKUs}, Missing SKUs: ${missingSKUs.length}`);

      let error = null;

      if (fetchedProducts === 0) {
        error = "No products were found. Make sure your app has read_products permission.";
      } else if (missingSKUs.length === 0) {
        error = null; // No missing SKUs is great!
      }

      return {
        missingSKUs,
        totalProductsScanned: fetchedProducts,
        totalVariantsScanned: totalVariants,
        variantsWithSKUs,
        error,
      };
    } catch (innerError) {
      console.error("Error while finding missing SKUs:", innerError);
      console.error("Error stack:", innerError.stack);
      return {
        missingSKUs: [],
        totalProductsScanned: 0,
        totalVariantsScanned: 0,
        variantsWithSKUs: 0,
        error: `Error finding missing SKUs: ${innerError.message}`,
      };
    }
  } catch (outerError) {
    console.error("Error in loader function:", outerError);
    console.error("Error stack:", outerError.stack);
    return {
      missingSKUs: [],
      totalProductsScanned: 0,
      totalVariantsScanned: 0,
      variantsWithSKUs: 0,
      error: `Critical error: ${outerError.message}`,
    };
  }
}

// Default export for the component
export default function MissingSKUs() {
  const { missingSKUs, totalProductsScanned, totalVariantsScanned, variantsWithSKUs, error } = useLoaderData();
  const navigation = useNavigation();
  const [searchTerm, setSearchTerm] = useState("");

  const isLoading = navigation.state === "loading";

  // Filter missing SKUs based on search term
  const filteredMissingSKUs = missingSKUs.filter((item) => {
    if (!searchTerm) return true;
    const search = searchTerm.toLowerCase();
    return (
      item.productTitle.toLowerCase().includes(search) ||
      item.variantTitle.toLowerCase().includes(search) ||
      item.barcode.toLowerCase().includes(search)
    );
  });

  const missingPercentage = totalVariantsScanned > 0 
    ? ((missingSKUs.length / totalVariantsScanned) * 100).toFixed(1)
    : 0;

  return (
    <s-page heading="Missing SKU Finder">
      <s-section>
        {error && (
          <s-box marginBottom="base">
            <s-text tone="critical">{error}</s-text>
          </s-box>
        )}

        {/* Loading State */}
        {isLoading ? (
          <s-box
            padding="extraLarge"
            style={{
              textAlign: "center",
              backgroundColor: "#f9fafb",
              borderRadius: "8px",
            }}
          >
            <s-spinner size="large" />
            <s-box marginTop="base">
              <s-heading size="medium">Scanning Products...</s-heading>
              <s-box marginTop="small">
                <s-text subdued>
                  Analyzing all products and variants to find missing SKUs.
                </s-text>
              </s-box>
              <s-box marginTop="small">
                <s-text subdued size="small">
                  ⏳ This process may take 1-3 minutes depending on your catalog size.
                </s-text>
              </s-box>
            </s-box>
          </s-box>
        ) : (
          <>
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
                  <s-text subdued size="small">Products Scanned</s-text>
                  <s-heading size="medium">{totalProductsScanned || 0}</s-heading>
                </div>
                <div>
                  <s-text subdued size="small">Total Variants</s-text>
                  <s-heading size="medium">{totalVariantsScanned || 0}</s-heading>
                </div>
                <div>
                  <s-text subdued size="small">Variants with SKUs</s-text>
                  <s-heading size="medium">{variantsWithSKUs || 0}</s-heading>
                </div>
                <div>
                  <s-text subdued size="small">Missing SKUs</s-text>
                  <s-heading size="medium" tone={missingSKUs.length > 0 ? "critical" : "success"}>
                    {missingSKUs.length || 0} ({missingPercentage}%)
                  </s-heading>
                </div>
              </div>
            </s-box>

            {/* Results */}
            {missingSKUs.length === 0 ? (
              <s-box
                padding="extraLarge"
                style={{
                  textAlign: "center",
                  backgroundColor: "#f0fdf4",
                  borderRadius: "8px",
                  border: "2px solid #86efac",
                }}
              >
                <s-heading size="large">✅ All Variants Have SKUs!</s-heading>
                <s-box marginTop="base">
                  <s-text>
                    Every variant in your store has a SKU assigned. Excellent inventory management!
                  </s-text>
                </s-box>
              </s-box>
            ) : (
              <>
                <s-box marginBottom="base">
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div>
                      <s-heading>
                        Found <strong>{missingSKUs.length}</strong> Variant{missingSKUs.length !== 1 ? "s" : ""} Missing SKUs
                      </s-heading>
                      <s-text subdued>
                        {filteredMissingSKUs.length !== missingSKUs.length && (
                          <>Showing {filteredMissingSKUs.length} of {missingSKUs.length} results</>
                        )}
                      </s-text>
                    </div>
                    
                    {/* Search Box */}
                    <div style={{ minWidth: "300px" }}>
                      <input
                        type="text"
                        placeholder="Search by product, variant, or barcode..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        style={{
                          width: "100%",
                          padding: "10px 12px",
                          borderRadius: "6px",
                          border: "1px solid #d1d5db",
                          fontSize: "14px",
                        }}
                      />
                    </div>
                  </div>
                </s-box>

                <s-box
                  marginTop="base"
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                  background="subdued"
                >
                  {filteredMissingSKUs.length === 0 ? (
                    <s-box padding="large" style={{ textAlign: "center" }}>
                      <s-text subdued>No results found for "{searchTerm}"</s-text>
                    </s-box>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse" }}>
                      <thead>
                        <tr style={{ borderBottom: "2px solid #ddd" }}>
                          <th style={{ textAlign: "left", padding: "12px" }}>Image</th>
                          <th style={{ textAlign: "left", padding: "12px" }}>Product Name</th>
                          <th style={{ textAlign: "left", padding: "12px" }}>Variant</th>
                          <th style={{ textAlign: "left", padding: "12px" }}>Barcode</th>
                          <th style={{ textAlign: "left", padding: "12px" }}>Product ID</th>
                          <th style={{ textAlign: "left", padding: "12px" }}>Variant ID</th>
                          <th style={{ textAlign: "left", padding: "12px" }}>Inventory</th>
                          <th style={{ textAlign: "left", padding: "12px" }}>Price</th>
                          <th style={{ textAlign: "left", padding: "12px" }}>Status</th>
                        </tr>
                      </thead>

                      <tbody>
                        {filteredMissingSKUs.map((variant) => (
                          <tr
                            key={variant.variantId}
                            style={{
                              borderBottom: "1px solid #eee",
                              backgroundColor: "white",
                            }}
                          >
                            <td style={{ padding: "12px" }}>
                              {variant.productImage ? (
                                <img
                                  src={variant.productImage}
                                  width="50"
                                  height="50"
                                  style={{ borderRadius: "6px", objectFit: "cover" }}
                                  alt={variant.productTitle}
                                />
                              ) : (
                                <div
                                  style={{
                                    width: "50px",
                                    height: "50px",
                                    backgroundColor: "#e5e7eb",
                                    borderRadius: "6px",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontSize: "11px",
                                    color: "#6b7280",
                                  }}
                                >
                                  No img
                                </div>
                              )}
                            </td>
                            <td style={{ padding: "12px", fontSize: "14px" }}>
                              <strong>{variant.productTitle}</strong>
                            </td>
                            <td style={{ padding: "12px", fontSize: "13px", color: "#6b7280" }}>
                              {variant.variantTitle}
                            </td>
                            <td style={{ padding: "12px", fontSize: "13px", fontFamily: "monospace" }}>
                              {variant.barcode}
                            </td>
                            <td style={{ padding: "12px", fontSize: "11px", fontFamily: "monospace", color: "#6b7280" }}>
                              {variant.productId.replace("gid://shopify/Product/", "")}
                            </td>
                            <td style={{ padding: "12px", fontSize: "11px", fontFamily: "monospace", color: "#6b7280" }}>
                              {variant.variantId.replace("gid://shopify/ProductVariant/", "")}
                            </td>
                            <td style={{ padding: "12px", fontSize: "13px" }}>
                              {variant.inventoryQuantity}
                            </td>
                            <td style={{ padding: "12px", fontSize: "13px", fontWeight: "500" }}>
                              ${variant.price}
                            </td>
                            <td style={{ padding: "12px" }}>
                              <span
                                style={{
                                  backgroundColor: "#fee2e2",
                                  color: "#991b1b",
                                  padding: "4px 10px",
                                  borderRadius: "12px",
                                  fontSize: "12px",
                                  fontWeight: "500",
                                }}
                              >
                                ⚠️ No SKU
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </s-box>

                {/* Summary at bottom */}
                {filteredMissingSKUs.length > 0 && (
                  <s-box marginTop="base" padding="base" style={{ backgroundColor: "#fee2e2", borderRadius: "6px" }}>
                    <s-text>
                      <strong>💡 Tip:</strong> SKUs are essential for inventory management, order fulfillment, and integration with external systems. Consider adding unique SKUs to these variants.
                    </s-text>
                  </s-box>
                )}
              </>
            )}
          </>
        )}
      </s-section>
    </s-page>
  );
}