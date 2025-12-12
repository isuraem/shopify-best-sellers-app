// ============================================
// FILE: app/routes/app.missing-skus.jsx
// ============================================

import { useEffect, useMemo, useRef, useState } from "react";
import {
  useLoaderData,
  useNavigation,
  useFetcher,
  useRevalidator,
} from "react-router";
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
                nodes { url }
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

      while (hasNextPage) {
        console.log(
          `📦 Fetching products page... (total so far: ${fetchedProducts})`,
        );

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

        console.log(
          `✅ Fetched ${products.length} products in this page, total so far: ${fetchedProducts}`,
        );

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

        console.log(
          `🔄 hasNextPage: ${hasNextPage}, cursor: ${cursor ? "present" : "null"}`,
        );

        if (hasNextPage) await new Promise((r) => setTimeout(r, 100));
      }

      console.log(`🎉 FINAL: Fetched ${fetchedProducts} products total`);
      console.log(
        `📊 Total variants: ${totalVariants}, With SKUs: ${variantsWithSKUs}, Missing SKUs: ${missingSKUs.length}`,
      );

      let error = null;

      if (fetchedProducts === 0) {
        error =
          "No products were found. Make sure your app has read_products permission.";
      } else if (missingSKUs.length === 0) {
        error = null;
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

// Action to handle bulk SKU updates
export async function action({ request }) {
  try {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();

    const variants = JSON.parse(formData.get("variants") || "[]");

    if (!Array.isArray(variants) || variants.length === 0) {
      return { success: false, error: "No variants provided." };
    }

    console.log(`📝 Adding SKUs to ${variants.length} variants...`);

    const UPDATE_VARIANTS_BULK = `#graphql
      mutation productVariantsBulkUpdate(
        $productId: ID!
        $variants: [ProductVariantsBulkInput!]!
      ) {
        productVariantsBulkUpdate(
          productId: $productId
          variants: $variants
          allowPartialUpdates: true
        ) {
          productVariants {
            id
            inventoryItem { sku }
          }
          userErrors { field message }
        }
      }
    `;

    let successCount = 0;
    let failedCount = 0;
    const errors = [];

    const grouped = new Map();
    for (const item of variants) {
      if (!item?.productId || !item?.variantId) continue;
      if (!grouped.has(item.productId)) grouped.set(item.productId, []);
      grouped.get(item.productId).push(item.variantId);
    }

    for (const [productId, variantIds] of grouped.entries()) {
      const variantsInput = variantIds.map((variantId) => {
        const numericId = variantId.replace("gid://shopify/ProductVariant/", "");
        const newSKU = `IC-${numericId}`;
        return {
          id: variantId,
          inventoryItem: { sku: newSKU },
        };
      });

      try {
        const response = await admin.graphql(UPDATE_VARIANTS_BULK, {
          variables: { productId, variants: variantsInput },
        });

        const json = await response.json();

        const userErrors =
          json.data?.productVariantsBulkUpdate?.userErrors || [];
        if (userErrors.length > 0) {
          failedCount += userErrors.length;
          for (const e of userErrors) {
            errors.push({ productId, error: e.message, field: e.field });
          }
        }

        const updated =
          json.data?.productVariantsBulkUpdate?.productVariants || [];
        successCount += updated.length;

        await new Promise((resolve) => setTimeout(resolve, 150));
      } catch (err) {
        failedCount += variantIds.length;
        errors.push({ productId, error: err.message });
      }
    }

    return { success: true, successCount, failedCount, errors };
  } catch (error) {
    console.error("Error in action:", error);
    return { success: false, error: error.message };
  }
}

/* ---------------- Modal Components ---------------- */

function BlockingModal({ open, title, message }) {
  if (!open) return null;
  return (
    <div className="modalOverlay">
      <div className="modalCard">
        <div className="modalHeader">
          <s-heading size="medium">{title}</s-heading>
        </div>
        <div
          className="modalBody"
          style={{ display: "flex", gap: 12, alignItems: "center" }}
        >
          <span className="bigSpinner" />
          <div>
            <s-text subdued>{message}</s-text>
          </div>
        </div>
      </div>
    </div>
  );
}

// Default export for the component
export default function MissingSKUs() {
  const {
    missingSKUs,
    totalProductsScanned,
    totalVariantsScanned,
    variantsWithSKUs,
    error,
  } = useLoaderData();

  const navigation = useNavigation();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

  const [searchTerm, setSearchTerm] = useState("");
  const [selectedVariants, setSelectedVariants] = useState(new Set());
  const [clientError, setClientError] = useState(null);

  // ✅ NEW: ensure we only handle one fetcher result per submit
  const handledFetcherResultRef = useRef(false);

  const isLoading = navigation.state === "loading";
  const isUpdating = fetcher.state !== "idle";

  // ✅ reset one-time handler when a new submission starts
  useEffect(() => {
    if (fetcher.state === "submitting" || fetcher.state === "loading") {
      handledFetcherResultRef.current = false;
      setClientError(null);
    }
  }, [fetcher.state]);

  // Filter missing SKUs based on search term
  const filteredMissingSKUs = useMemo(() => {
    return missingSKUs.filter((item) => {
      if (!searchTerm) return true;
      const search = searchTerm.toLowerCase();
      return (
        item.productTitle.toLowerCase().includes(search) ||
        item.variantTitle.toLowerCase().includes(search) ||
        item.barcode.toLowerCase().includes(search)
      );
    });
  }, [missingSKUs, searchTerm]);

  const missingPercentage =
    totalVariantsScanned > 0
      ? ((missingSKUs.length / totalVariantsScanned) * 100).toFixed(1)
      : 0;

  // Handle select all checkbox
  const handleSelectAll = (e) => {
    if (e.target.checked) {
      const allIds = new Set(filteredMissingSKUs.map((v) => v.variantId));
      setSelectedVariants(allIds);
    } else {
      setSelectedVariants(new Set());
    }
  };

  // Handle individual checkbox
  const handleSelectVariant = (variantId) => {
    const newSelected = new Set(selectedVariants);
    if (newSelected.has(variantId)) newSelected.delete(variantId);
    else newSelected.add(variantId);
    setSelectedVariants(newSelected);
  };

  // ✅ No confirmation: submit immediately
  const handleBulkUpdate = () => {
    if (selectedVariants.size === 0) return;

    const byVariantId = new Map(missingSKUs.map((v) => [v.variantId, v]));
    const payload = Array.from(selectedVariants).map((variantId) => {
      const row = byVariantId.get(variantId);
      return { productId: row.productId, variantId: row.variantId };
    });

    const formData = new FormData();
    formData.append("variants", JSON.stringify(payload));

    fetcher.submit(formData, { method: "post" });
  };

  // ✅ handle update completion ONCE, then re-fetch missing skus once
  useEffect(() => {
    if (fetcher.state !== "idle") return;
    if (!fetcher.data) return;

    if (handledFetcherResultRef.current) return;
    handledFetcherResultRef.current = true;

    if (!fetcher.data?.success) {
      setClientError(fetcher.data?.error || "Update failed.");
      return;
    }

    setSelectedVariants(new Set());
    revalidator.revalidate(); // ✅ refresh missing SKUs list
  }, [fetcher.state, fetcher.data, revalidator]);

  const allSelected =
    filteredMissingSKUs.length > 0 &&
    selectedVariants.size === filteredMissingSKUs.length;

  return (
    <s-page heading="Missing SKU Finder">
      <s-section>
        {(error || clientError) && (
          <s-box marginBottom="base">
            <s-text tone="critical">{error || clientError}</s-text>
          </s-box>
        )}

        <BlockingModal
          open={isUpdating}
          title="Updating SKUs…"
          message="Please keep this tab open while we update the selected variants."
        />

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
                  ⏳ This process may take 1-3 minutes depending on your catalog
                  size.
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
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns:
                    "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: "16px",
                }}
              >
                <div>
                  <s-text subdued size="small">
                    Products Scanned
                  </s-text>
                  <s-heading size="medium">{totalProductsScanned || 0}</s-heading>
                </div>
                <div>
                  <s-text subdued size="small">
                    Total Variants
                  </s-text>
                  <s-heading size="medium">{totalVariantsScanned || 0}</s-heading>
                </div>
                <div>
                  <s-text subdued size="small">
                    Variants with SKUs
                  </s-text>
                  <s-heading size="medium">{variantsWithSKUs || 0}</s-heading>
                </div>
                <div>
                  <s-text subdued size="small">
                    Missing SKUs
                  </s-text>
                  <s-heading
                    size="medium"
                    tone={missingSKUs.length > 0 ? "critical" : "success"}
                  >
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
                    Every variant in your store has a SKU assigned. Excellent
                    inventory management!
                  </s-text>
                </s-box>
              </s-box>
            ) : (
              <>
                <s-box marginBottom="base">
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      gap: "16px",
                      flexWrap: "wrap",
                    }}
                  >
                    <div>
                      <s-heading>
                        Found <strong>{missingSKUs.length}</strong> Variant
                        {missingSKUs.length !== 1 ? "s" : ""} Missing SKUs
                      </s-heading>
                      <s-text subdued>
                        {filteredMissingSKUs.length !== missingSKUs.length && (
                          <>
                            Showing {filteredMissingSKUs.length} of{" "}
                            {missingSKUs.length} results
                          </>
                        )}
                        {selectedVariants.size > 0 && (
                          <>
                            {" "}
                            • <strong>{selectedVariants.size}</strong> selected
                          </>
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

                {/* Bulk Action Bar */}
                {selectedVariants.size > 0 && (
                  <s-box
                    marginBottom="base"
                    padding="base"
                    style={{
                      backgroundColor: "#dbeafe",
                      borderRadius: "8px",
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <s-text>
                        <strong>{selectedVariants.size}</strong> variant
                        {selectedVariants.size !== 1 ? "s" : ""} selected
                      </s-text>
                      <s-text subdued size="small">
                        {" "}
                        • SKU pattern: IC-{"{variantid}"}
                      </s-text>
                    </div>
                    <button
                      onClick={handleBulkUpdate}
                      disabled={isUpdating}
                      style={{
                        padding: "10px 20px",
                        backgroundColor: isUpdating ? "#9ca3af" : "#2563eb",
                        color: "white",
                        border: "none",
                        borderRadius: "6px",
                        fontSize: "14px",
                        fontWeight: "600",
                        cursor: isUpdating ? "not-allowed" : "pointer",
                        display: "flex",
                        alignItems: "center",
                        gap: "8px",
                      }}
                    >
                      ✨ Add SKUs to Selected
                    </button>
                  </s-box>
                )}

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
                          <th
                            style={{
                              textAlign: "left",
                              padding: "12px",
                              width: "40px",
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={allSelected}
                              onChange={handleSelectAll}
                              style={{
                                width: "18px",
                                height: "18px",
                                cursor: "pointer",
                              }}
                            />
                          </th>
                          <th style={{ textAlign: "left", padding: "12px" }}>
                            Image
                          </th>
                          <th style={{ textAlign: "left", padding: "12px" }}>
                            Product Name
                          </th>
                          <th style={{ textAlign: "left", padding: "12px" }}>
                            Variant
                          </th>
                          <th style={{ textAlign: "left", padding: "12px" }}>
                            Barcode
                          </th>
                          <th style={{ textAlign: "left", padding: "12px" }}>
                            Variant ID
                          </th>
                          <th style={{ textAlign: "left", padding: "12px" }}>
                            New SKU
                          </th>
                          <th style={{ textAlign: "left", padding: "12px" }}>
                            Inventory
                          </th>
                          <th style={{ textAlign: "left", padding: "12px" }}>
                            Price
                          </th>
                        </tr>
                      </thead>

                      <tbody>
                        {filteredMissingSKUs.map((variant) => {
                          const numericId = variant.variantId.replace(
                            "gid://shopify/ProductVariant/",
                            "",
                          );
                          const newSKU = `IC-${numericId}`;
                          const isSelected = selectedVariants.has(
                            variant.variantId,
                          );

                          return (
                            <tr
                              key={variant.variantId}
                              style={{
                                borderBottom: "1px solid #eee",
                                backgroundColor: isSelected ? "#eff6ff" : "white",
                              }}
                            >
                              <td style={{ padding: "12px" }}>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={() =>
                                    handleSelectVariant(variant.variantId)
                                  }
                                  style={{
                                    width: "18px",
                                    height: "18px",
                                    cursor: "pointer",
                                  }}
                                />
                              </td>
                              <td style={{ padding: "12px" }}>
                                {variant.productImage ? (
                                  <img
                                    src={variant.productImage}
                                    width="50"
                                    height="50"
                                    style={{
                                      borderRadius: "6px",
                                      objectFit: "cover",
                                    }}
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
                              <td
                                style={{
                                  padding: "12px",
                                  fontSize: "13px",
                                  color: "#6b7280",
                                }}
                              >
                                {variant.variantTitle}
                              </td>
                              <td
                                style={{
                                  padding: "12px",
                                  fontSize: "13px",
                                  fontFamily: "monospace",
                                }}
                              >
                                {variant.barcode}
                              </td>
                              <td
                                style={{
                                  padding: "12px",
                                  fontSize: "11px",
                                  fontFamily: "monospace",
                                  color: "#6b7280",
                                }}
                              >
                                {numericId}
                              </td>
                              <td style={{ padding: "12px" }}>
                                <code
                                  style={{
                                    backgroundColor: "#f3f4f6",
                                    padding: "4px 8px",
                                    borderRadius: "4px",
                                    fontSize: "12px",
                                    fontWeight: "600",
                                    color: "#059669",
                                  }}
                                >
                                  {newSKU}
                                </code>
                              </td>
                              <td style={{ padding: "12px", fontSize: "13px" }}>
                                {variant.inventoryQuantity}
                              </td>
                              <td
                                style={{
                                  padding: "12px",
                                  fontSize: "13px",
                                  fontWeight: "500",
                                }}
                              >
                                ${variant.price}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </s-box>

                {/* Summary at bottom */}
                {filteredMissingSKUs.length > 0 && (
                  <s-box
                    marginTop="base"
                    padding="base"
                    style={{ backgroundColor: "#fee2e2", borderRadius: "6px" }}
                  >
                    <s-text>
                      <strong>💡 Tip:</strong> Select variants using checkboxes
                      and click "Add SKUs to Selected" to automatically assign
                      SKUs with the pattern IC-{"{variantid}"}.
                    </s-text>
                  </s-box>
                )}
              </>
            )}
          </>
        )}
      </s-section>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }

        .modalOverlay {
          position: fixed;
          inset: 0;
          background: rgba(0,0,0,0.45);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 9999;
          padding: 16px;
        }

        .modalCard {
          width: 100%;
          max-width: 520px;
          background: #fff;
          border-radius: 12px;
          box-shadow: 0 20px 50px rgba(0,0,0,0.25);
          overflow: hidden;
        }

        .modalHeader {
          padding: 16px 18px;
          border-bottom: 1px solid #e5e7eb;
          background: #f9fafb;
        }

        .modalBody {
          padding: 16px 18px;
        }

        .bigSpinner {
          width: 18px;
          height: 18px;
          border: 3px solid #9ca3af;
          border-top-color: transparent;
          border-radius: 50%;
          animation: spin 0.7s linear infinite;
        }
      `}</style>
    </s-page>
  );
}
