// ============================================
// FILE: app/routes/app.duplicate-barcodes.jsx
// ============================================

import { useState } from "react";
import { useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

// Named export for the loader
export async function loader({ request }) {
  try {
    const { admin } = await authenticate.admin(request);

    console.log("Fetching all products to find duplicate barcodes...");

    let cursor = null;
    let hasNextPage = true;
    let fetchedProducts = 0;

    // Map to store Barcode -> Array of variant details
    const barcodeMap = new Map();

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
            duplicates: [],
            totalProductsScanned: 0,
            totalVariantsScanned: 0,
            error: `GraphQL error: ${json.errors[0].message}`,
          };
        }

        if (!json.data?.products) {
          console.error("Failed to fetch products - no data returned");
          return {
            duplicates: [],
            totalProductsScanned: 0,
            totalVariantsScanned: 0,
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
            const barcode = variant.barcode?.trim();

            // Skip empty barcodes
            if (!barcode) continue;

            // Initialize array for this barcode if it doesn't exist
            if (!barcodeMap.has(barcode)) {
              barcodeMap.set(barcode, []);
            }

            // Add variant details to the barcode map
            barcodeMap.get(barcode).push({
              barcode: barcode,
              productId: product.id,
              productTitle: product.title,
              productStatus: product.status,
              productImage: product.images?.nodes?.[0]?.url || null,
              variantId: variant.id,
              variantTitle: variant.title,
              sku: variant.sku || "N/A",
              inventoryQuantity: variant.inventoryQuantity || 0,
              price: variant.price,
              totalInventory: product.totalInventory,
            });
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

      // Filter out barcodes that only appear once (not duplicates)
      const duplicates = [];
      let totalVariantsScanned = 0;
      let totalVariantsWithBarcodes = 0;

      for (const [barcode, variants] of barcodeMap.entries()) {
        totalVariantsWithBarcodes += variants.length;
        totalVariantsScanned += variants.length;

        if (variants.length > 1) {
          duplicates.push({
            barcode: barcode,
            count: variants.length,
            variants: variants,
          });
        }
      }

      // Sort by count (most duplicates first)
      duplicates.sort((a, b) => b.count - a.count);

      console.log(`✨ Found ${duplicates.length} duplicate barcodes out of ${barcodeMap.size} unique barcodes`);

      let error = null;

      if (fetchedProducts === 0) {
        error = "No products were found. Make sure your app has read_products permission.";
      } else if (duplicates.length === 0) {
        error = null; // No duplicates is not an error, it's good news!
      }

      return {
        duplicates,
        totalProductsScanned: fetchedProducts,
        totalVariantsScanned,
        totalVariantsWithBarcodes,
        totalUniqueBarcodes: barcodeMap.size,
        error,
      };
    } catch (innerError) {
      console.error("Error while finding duplicate barcodes:", innerError);
      console.error("Error stack:", innerError.stack);
      return {
        duplicates: [],
        totalProductsScanned: 0,
        totalVariantsScanned: 0,
        totalVariantsWithBarcodes: 0,
        error: `Error finding duplicates: ${innerError.message}`,
      };
    }
  } catch (outerError) {
    console.error("Error in loader function:", outerError);
    console.error("Error stack:", outerError.stack);
    return {
      duplicates: [],
      totalProductsScanned: 0,
      totalVariantsScanned: 0,
      totalVariantsWithBarcodes: 0,
      error: `Critical error: ${outerError.message}`,
    };
  }
}

// Default export for the component
export default function DuplicateBarcodes() {
  const { duplicates, totalProductsScanned, totalVariantsScanned, totalVariantsWithBarcodes, totalUniqueBarcodes, error } = useLoaderData();
  const navigation = useNavigation();
  const [expandedBarcode, setExpandedBarcode] = useState(null);

  const isLoading = navigation.state === "loading";

  const toggleExpand = (barcode) => {
    setExpandedBarcode(expandedBarcode === barcode ? null : barcode);
  };

  return (
    <s-page heading="Duplicate Barcode Finder">
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
                  Analyzing all products and variants to find duplicate barcodes.
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
                  <s-text subdued size="small">Variants with Barcodes</s-text>
                  <s-heading size="medium">{totalVariantsWithBarcodes || 0}</s-heading>
                </div>
                <div>
                  <s-text subdued size="small">Unique Barcodes</s-text>
                  <s-heading size="medium">{totalUniqueBarcodes || 0}</s-heading>
                </div>
                <div>
                  <s-text subdued size="small">Duplicate Barcodes Found</s-text>
                  <s-heading size="medium" tone={duplicates.length > 0 ? "critical" : "success"}>
                    {duplicates.length || 0}
                  </s-heading>
                </div>
              </div>
            </s-box>

            {/* Results */}
            {duplicates.length === 0 ? (
              <s-box
                padding="extraLarge"
                style={{
                  textAlign: "center",
                  backgroundColor: "#f0fdf4",
                  borderRadius: "8px",
                  border: "2px solid #86efac",
                }}
              >
                <s-heading size="large">✅ No Duplicate Barcodes Found!</s-heading>
                <s-box marginTop="base">
                  <s-text>
                    All barcodes in your store are unique. Your inventory tracking is well-organized.
                  </s-text>
                </s-box>
              </s-box>
            ) : (
              <>
                <s-box marginBottom="base">
                  <s-heading>
                    Found <strong>{duplicates.length}</strong> Duplicate Barcode{duplicates.length !== 1 ? "s" : ""}
                  </s-heading>
                  <s-text subdued>
                    Click on any barcode to expand and see all variants using that barcode
                  </s-text>
                </s-box>

                <s-box
                  marginTop="base"
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                  background="subdued"
                >
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid #ddd" }}>
                        <th style={{ textAlign: "left", padding: "12px", width: "40px" }}></th>
                        <th style={{ textAlign: "left", padding: "12px" }}>Barcode</th>
                        <th style={{ textAlign: "left", padding: "12px" }}>Duplicate Count</th>
                        <th style={{ textAlign: "left", padding: "12px" }}>Status</th>
                      </tr>
                    </thead>

                    <tbody>
                      {duplicates.map((duplicate) => (
                        <>
                          <tr
                            key={duplicate.barcode}
                            style={{
                              borderBottom: "1px solid #eee",
                              cursor: "pointer",
                              backgroundColor: expandedBarcode === duplicate.barcode ? "#f9fafb" : "white",
                            }}
                            onClick={() => toggleExpand(duplicate.barcode)}
                          >
                            <td style={{ padding: "12px", textAlign: "center" }}>
                              <span style={{ fontSize: "18px" }}>
                                {expandedBarcode === duplicate.barcode ? "▼" : "▶"}
                              </span>
                            </td>
                            <td style={{ padding: "12px", fontFamily: "monospace", fontWeight: "500" }}>
                              {duplicate.barcode}
                            </td>
                            <td style={{ padding: "12px" }}>
                              <span
                                style={{
                                  backgroundColor: "#fee2e2",
                                  color: "#991b1b",
                                  padding: "4px 12px",
                                  borderRadius: "12px",
                                  fontWeight: "600",
                                  fontSize: "13px",
                                }}
                              >
                                {duplicate.count} variants
                              </span>
                            </td>
                            <td style={{ padding: "12px" }}>
                              <s-text tone="critical" size="small">⚠️ Needs attention</s-text>
                            </td>
                          </tr>

                          {/* Expanded Details */}
                          {expandedBarcode === duplicate.barcode && (
                            <tr>
                              <td colSpan={4} style={{ padding: "0", backgroundColor: "#f9fafb" }}>
                                <div style={{ padding: "16px", paddingLeft: "60px" }}>
                                  <table style={{ width: "100%", borderCollapse: "collapse", backgroundColor: "white", borderRadius: "4px", overflow: "hidden" }}>
                                    <thead>
                                      <tr style={{ backgroundColor: "#f3f4f6" }}>
                                        <th style={{ textAlign: "left", padding: "10px", fontSize: "13px", fontWeight: "600" }}>Image</th>
                                        <th style={{ textAlign: "left", padding: "10px", fontSize: "13px", fontWeight: "600" }}>Product Name</th>
                                        <th style={{ textAlign: "left", padding: "10px", fontSize: "13px", fontWeight: "600" }}>Variant</th>
                                        <th style={{ textAlign: "left", padding: "10px", fontSize: "13px", fontWeight: "600" }}>SKU</th>
                                        <th style={{ textAlign: "left", padding: "10px", fontSize: "13px", fontWeight: "600" }}>Product ID</th>
                                        <th style={{ textAlign: "left", padding: "10px", fontSize: "13px", fontWeight: "600" }}>Variant ID</th>
                                        <th style={{ textAlign: "left", padding: "10px", fontSize: "13px", fontWeight: "600" }}>Inventory</th>
                                        <th style={{ textAlign: "left", padding: "10px", fontSize: "13px", fontWeight: "600" }}>Price</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {duplicate.variants.map((variant, vIndex) => (
                                        <tr
                                          key={variant.variantId}
                                          style={{
                                            borderBottom: vIndex < duplicate.variants.length - 1 ? "1px solid #f3f4f6" : "none",
                                          }}
                                        >
                                          <td style={{ padding: "10px" }}>
                                            {variant.productImage ? (
                                              <img
                                                src={variant.productImage}
                                                width="40"
                                                height="40"
                                                style={{ borderRadius: "4px", objectFit: "cover" }}
                                                alt={variant.productTitle}
                                              />
                                            ) : (
                                              <div
                                                style={{
                                                  width: "40px",
                                                  height: "40px",
                                                  backgroundColor: "#e5e7eb",
                                                  borderRadius: "4px",
                                                  display: "flex",
                                                  alignItems: "center",
                                                  justifyContent: "center",
                                                  fontSize: "10px",
                                                  color: "#6b7280",
                                                }}
                                              >
                                                No img
                                              </div>
                                            )}
                                          </td>
                                          <td style={{ padding: "10px", fontSize: "13px" }}>
                                            {variant.productTitle}
                                          </td>
                                          <td style={{ padding: "10px", fontSize: "13px", color: "#6b7280" }}>
                                            {variant.variantTitle}
                                          </td>
                                          <td style={{ padding: "10px", fontSize: "12px", fontFamily: "monospace", color: "#6b7280" }}>
                                            {variant.sku}
                                          </td>
                                          <td style={{ padding: "10px", fontSize: "11px", fontFamily: "monospace", color: "#6b7280" }}>
                                            {variant.productId.replace("gid://shopify/Product/", "")}
                                          </td>
                                          <td style={{ padding: "10px", fontSize: "11px", fontFamily: "monospace", color: "#6b7280" }}>
                                            {variant.variantId.replace("gid://shopify/ProductVariant/", "")}
                                          </td>
                                          <td style={{ padding: "10px", fontSize: "13px" }}>
                                            {variant.inventoryQuantity}
                                          </td>
                                          <td style={{ padding: "10px", fontSize: "13px", fontWeight: "500" }}>
                                            ${variant.price}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </td>
                            </tr>
                          )}
                        </>
                      ))}
                    </tbody>
                  </table>
                </s-box>
              </>
            )}
          </>
        )}
      </s-section>
    </s-page>
  );
}