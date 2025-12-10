// ============================================
// FILE: app/routes/app.duplicate-skus.jsx
// ============================================

import { useState, useEffect } from "react";
import { useLoaderData, useNavigation, useFetcher, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";

// Named export for the loader
export async function loader({ request }) {
  try {
    const { admin } = await authenticate.admin(request);

    console.log("Fetching all products to find duplicate SKUs...");

    let cursor = null;
    let hasNextPage = true;
    let fetchedProducts = 0;

    // Map to store SKU -> Array of variant details
    const skuMap = new Map();

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
            const sku = variant.sku?.trim();

            // Skip empty SKUs
            if (!sku) continue;

            // Initialize array for this SKU if it doesn't exist
            if (!skuMap.has(sku)) {
              skuMap.set(sku, []);
            }

            // Add variant details to the SKU map
            skuMap.get(sku).push({
              sku: sku,
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

        hasNextPage = json.data.products.pageInfo.hasNextPage;
        cursor = json.data.products.pageInfo.endCursor || null;

        console.log(`🔄 hasNextPage: ${hasNextPage}, cursor: ${cursor ? "present" : "null"}`);

        if (hasNextPage) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }

      console.log(`🎉 FINAL: Fetched ${fetchedProducts} products total`);

      // Filter out SKUs that only appear once (not duplicates)
      const duplicates = [];
      let totalVariantsScanned = 0;

      for (const [sku, variants] of skuMap.entries()) {
        totalVariantsScanned += variants.length;

        if (variants.length > 1) {
          duplicates.push({
            sku: sku,
            count: variants.length,
            variants: variants,
          });
        }
      }

      // Sort by count (most duplicates first)
      duplicates.sort((a, b) => b.count - a.count);

      console.log(`✨ Found ${duplicates.length} duplicate SKUs out of ${skuMap.size} unique SKUs`);

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
        totalUniqueSKUs: skuMap.size,
        error,
      };
    } catch (innerError) {
      console.error("Error while finding duplicate SKUs:", innerError);
      console.error("Error stack:", innerError.stack);
      return {
        duplicates: [],
        totalProductsScanned: 0,
        totalVariantsScanned: 0,
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
      error: `Critical error: ${outerError.message}`,
    };
  }
}

// Action to handle product deletion, SKU removal, and SKU re-assignment
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = formData.get("productId");
  const actionType = formData.get("actionType");
  const sku = formData.get("sku");

  // ============================
  // DELETE PRODUCT
  // ============================
  if (actionType === "deleteProduct") {
    if (!productId) {
      return {
        success: false,
        error: "No product ID provided",
      };
    }

    try {
      console.log(`🗑️ Attempting to delete product: ${productId}`);

      const DELETE_PRODUCT_MUTATION = `#graphql
        mutation deleteProduct($input: ProductDeleteInput!) {
          productDelete(input: $input) {
            deletedProductId
            userErrors {
              field
              message
            }
          }
        }
      `;

      const response = await admin.graphql(DELETE_PRODUCT_MUTATION, {
        variables: {
          input: {
            id: productId,
          },
        },
      });

      const json = await response.json();

      if (json.data?.productDelete?.userErrors?.length > 0) {
        const errorMessage = json.data.productDelete.userErrors[0].message;
        console.error("Delete error:", errorMessage);
        return {
          success: false,
          error: errorMessage,
        };
      }

      if (json.data?.productDelete?.deletedProductId) {
        console.log(`✅ Successfully deleted product: ${productId}`);
        return {
          success: true,
          deletedProductId: json.data.productDelete.deletedProductId,
        };
      }

      return {
        success: false,
        error: "Unknown error occurred while deleting product",
      };
    } catch (error) {
      console.error("Error deleting product:", error);
      return {
        success: false,
        error: `Error deleting product: ${error.message}`,
      };
    }
  }

  // Common query + mutation for SKU-related operations
  const VARIANTS_BY_SKU_QUERY = `#graphql
    query getVariantsBySku($query: String!, $cursor: String) {
      productVariants(first: 100, query: $query, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        edges {
          node {
            id
            sku
            product {
              id
              title
            }
            inventoryItem {
              id
              sku
            }
          }
        }
      }
    }
  `;

  const BULK_UPDATE_MUTATION = `#graphql
    mutation bulkUpdateVariants(
      $productId: ID!,
      $variants: [ProductVariantsBulkInput!]!
    ) {
      productVariantsBulkUpdate(productId: $productId, variants: $variants) {
        productVariants {
          id
          sku
          inventoryItem {
            sku
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  // ============================
  // REMOVE SKU FROM VARIANTS
  // ============================
  if (actionType === "removeSku") {
    if (!sku) {
      return {
        success: false,
        error: "No SKU provided",
      };
    }

    try {
      console.log(`🔧 Removing SKU "${sku}" from all matching variants...`);

      let cursor = null;
      let hasNextPage = true;
      const variantsByProduct = new Map();

      while (hasNextPage) {
        const response = await admin.graphql(VARIANTS_BY_SKU_QUERY, {
          variables: {
            query: `sku:${sku}`,
            cursor,
          },
        });

        const json = await response.json();

        if (json.errors) {
          console.error("GraphQL errors while searching variants by SKU:", json.errors);
          return {
            success: false,
            error: `GraphQL search error: ${json.errors[0].message}`,
          };
        }

        const conn = json.data?.productVariants;
        if (!conn) break;

        const edges = conn.edges || [];
        for (const edge of edges) {
          const node = edge.node;
          if (!node?.sku) continue;
          if (node.sku.trim() !== sku) continue;

          const productIdForVariant = node.product.id;

          if (!variantsByProduct.has(productIdForVariant)) {
            variantsByProduct.set(productIdForVariant, []);
          }

          variantsByProduct.get(productIdForVariant).push({
            id: node.id,
            inventoryItem: {
              sku: "", // clear SKU
            },
          });
        }

        hasNextPage = conn.pageInfo?.hasNextPage;
        cursor = conn.pageInfo?.endCursor || null;
      }

      if (variantsByProduct.size === 0) {
        console.log(`No variants found with SKU "${sku}"`);
        return {
          success: false,
          error: `No variants found with SKU "${sku}"`,
        };
      }

      let totalUpdated = 0;

      for (const [productIdForVariant, variantInputs] of variantsByProduct.entries()) {
        const response = await admin.graphql(BULK_UPDATE_MUTATION, {
          variables: {
            productId: productIdForVariant,
            variants: variantInputs,
          },
        });

        const json = await response.json();

        if (json.errors) {
          console.error(
            `GraphQL errors while clearing SKU for product ${productIdForVariant}:`,
            json.errors
          );
          return {
            success: false,
            error: `GraphQL bulk update error: ${json.errors[0].message}`,
          };
        }

        const payload = json.data?.productVariantsBulkUpdate;
        const userErrors = payload?.userErrors || [];

        if (userErrors.length > 0) {
          console.error("Bulk update userErrors:", userErrors);
          return {
            success: false,
            error: userErrors[0].message,
          };
        }

        totalUpdated += payload?.productVariants?.length || 0;
      }

      console.log(
        `✅ Removed SKU "${sku}" from ${totalUpdated} variants across ${variantsByProduct.size} product(s)`
      );

      return {
        success: true,
        clearedSku: sku,
        variantsUpdated: totalUpdated,
      };
    } catch (error) {
      console.error("Error removing SKU:", error);
      return {
        success: false,
        error: `Error removing SKU: ${error.message}`,
      };
    }
  }

  // ============================
  // RE-ASSIGN SKUs (ic-{variantID})
  // ============================
  if (actionType === "reassignSku") {
    if (!sku) {
      return {
        success: false,
        error: "No SKU provided",
      };
    }

    try {
      console.log(`🔁 Re-assigning SKU "${sku}" to pattern ic-{variantID}...`);

      let cursor = null;
      let hasNextPage = true;
      const variantsByProduct = new Map();

      while (hasNextPage) {
        const response = await admin.graphql(VARIANTS_BY_SKU_QUERY, {
          variables: {
            query: `sku:${sku}`,
            cursor,
          },
        });

        const json = await response.json();

        if (json.errors) {
          console.error("GraphQL errors while searching variants by SKU:", json.errors);
          return {
            success: false,
            error: `GraphQL search error: ${json.errors[0].message}`,
          };
        }

        const conn = json.data?.productVariants;
        if (!conn) break;

        const edges = conn.edges || [];
        for (const edge of edges) {
          const node = edge.node;
          if (!node?.sku) continue;
          if (node.sku.trim() !== sku) continue;

          const productIdForVariant = node.product.id;

          if (!variantsByProduct.has(productIdForVariant)) {
            variantsByProduct.set(productIdForVariant, []);
          }

          // Extract numeric part of variant ID for pattern ic-{variantID}
          const variantGid = node.id; // gid://shopify/ProductVariant/1234567890
          const numericId = variantGid.split("/").pop();
          const newSku = `IC-${numericId}`;

          variantsByProduct.get(productIdForVariant).push({
            id: node.id,
            inventoryItem: {
              sku: newSku,
            },
          });
        }

        hasNextPage = conn.pageInfo?.hasNextPage;
        cursor = conn.pageInfo?.endCursor || null;
      }

      if (variantsByProduct.size === 0) {
        console.log(`No variants found with SKU "${sku}"`);
        return {
          success: false,
          error: `No variants found with SKU "${sku}"`,
        };
      }

      let totalUpdated = 0;

      for (const [productIdForVariant, variantInputs] of variantsByProduct.entries()) {
        const response = await admin.graphql(BULK_UPDATE_MUTATION, {
          variables: {
            productId: productIdForVariant,
            variants: variantInputs,
          },
        });

        const json = await response.json();

        if (json.errors) {
          console.error(
            `GraphQL errors while re-assigning SKU for product ${productIdForVariant}:`,
            json.errors
          );
          return {
            success: false,
            error: `GraphQL bulk update error: ${json.errors[0].message}`,
          };
        }

        const payload = json.data?.productVariantsBulkUpdate;
        const userErrors = payload?.userErrors || [];

        if (userErrors.length > 0) {
          console.error("Bulk update userErrors:", userErrors);
          return {
            success: false,
            error: userErrors[0].message,
          };
        }

        totalUpdated += payload?.productVariants?.length || 0;
      }

      console.log(
        `✅ Re-assigned SKU "${sku}" to ic-{variantID} pattern on ${totalUpdated} variants across ${variantsByProduct.size} product(s)`
      );

      return {
        success: true,
        reassignBaseSku: sku,
        variantsUpdated: totalUpdated,
      };
    } catch (error) {
      console.error("Error re-assigning SKU:", error);
      return {
        success: false,
        error: `Error re-assigning SKU: ${error.message}`,
      };
    }
  }

  return {
    success: false,
    error: "Invalid action type",
  };
}

// Default export for the component
export default function DuplicateSKUs() {
  const { duplicates, totalProductsScanned, totalVariantsScanned, totalUniqueSKUs, error } =
    useLoaderData();
  const navigation = useNavigation();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

  const [expandedSKU, setExpandedSKU] = useState(null);

  // Modal states
  const [showModal, setShowModal] = useState(false);
  const [modalState, setModalState] = useState("confirm"); // "confirm", "deleting"
  const [modalAction, setModalAction] = useState(null); // "deleteProduct" | "removeSku" | "reassignSku"
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedSku, setSelectedSku] = useState(null);

  const isLoading = navigation.state === "loading";

  const toggleExpand = (sku) => {
    setExpandedSKU(expandedSKU === sku ? null : sku);
  };

  const handleDeleteClick = (productId, productTitle) => {
    setSelectedProduct({ productId, productTitle });
    setSelectedSku(null);
    setModalAction("deleteProduct");
    setModalState("confirm");
    setShowModal(true);
  };

  const handleRemoveSkuClick = (sku, count) => {
    setSelectedSku({ sku, count });
    setSelectedProduct(null);
    setModalAction("removeSku");
    setModalState("confirm");
    setShowModal(true);
  };

  const handleReassignSkuClick = (sku, count) => {
    setSelectedSku({ sku, count });
    setSelectedProduct(null);
    setModalAction("reassignSku");
    setModalState("confirm");
    setShowModal(true);
  };

  const handleConfirm = () => {
    if (modalAction === "deleteProduct" && selectedProduct) {
      setModalState("deleting");
      fetcher.submit(
        {
          actionType: "deleteProduct",
          productId: selectedProduct.productId,
        },
        { method: "post" }
      );
    } else if (modalAction === "removeSku" && selectedSku) {
      setModalState("deleting");
      fetcher.submit(
        {
          actionType: "removeSku",
          sku: selectedSku.sku,
        },
        { method: "post" }
      );
    } else if (modalAction === "reassignSku" && selectedSku) {
      setModalState("deleting");
      fetcher.submit(
        {
          actionType: "reassignSku",
          sku: selectedSku.sku,
        },
        { method: "post" }
      );
    }
  };

  const handleCancelDelete = () => {
    setShowModal(false);
    setSelectedProduct(null);
    setSelectedSku(null);
    setModalAction(null);
    setModalState("confirm");
  };

  // Handle fetcher completion (only after an operation is in progress)
  useEffect(() => {
    if (modalState === "deleting" && fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        // Operation successful, revalidate list in the background
        revalidator.revalidate();
      }

      // Close modal and reset state
      setShowModal(false);
      setSelectedProduct(null);
      setSelectedSku(null);
      setModalAction(null);
      setModalState("confirm");
    }
  }, [fetcher.state, fetcher.data, modalState, revalidator]);

  return (
    <s-page heading="Duplicate SKU Finder">
      <s-section>
        {error && (
          <s-box marginBottom="base">
            <s-text tone="critical">{error}</s-text>
          </s-box>
        )}

        {fetcher.data?.error && !showModal && (
          <s-box marginBottom="base">
            <s-text tone="critical">Action Error: {fetcher.data.error}</s-text>
          </s-box>
        )}

        {/* Custom Confirmation/Loading Modal */}
        {showModal && (selectedProduct || selectedSku) && (
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              backgroundColor: "rgba(0, 0, 0, 0.6)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 9999,
            }}
            onClick={(e) => {
              // Close modal if clicking outside (only in confirm state)
              if (modalState === "confirm" && e.target === e.currentTarget) {
                handleCancelDelete();
              }
            }}
          >
            <div
              style={{
                backgroundColor: "white",
                padding: "40px",
                borderRadius: "12px",
                boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
                minWidth: "450px",
                maxWidth: "500px",
              }}
            >
              {/* Confirmation State */}
              {modalState === "confirm" && (
                <>
                  <div style={{ textAlign: "center", marginBottom: "24px" }}>
                    <div
                      style={{
                        fontSize: "48px",
                        marginBottom: "16px",
                      }}
                    >
                      ⚠️
                    </div>
                    <s-heading size="large">
                      {modalAction === "deleteProduct"
                        ? "Delete Product?"
                        : modalAction === "removeSku"
                        ? "Remove SKU from Variants?"
                        : "Re-assign SKUs?"}
                    </s-heading>
                  </div>

                  <div
                    style={{
                      backgroundColor: "#f9fafb",
                      padding: "16px",
                      borderRadius: "8px",
                      marginBottom: "24px",
                    }}
                  >
                    {modalAction === "deleteProduct" && selectedProduct && (
                      <s-text>
                        <strong>{selectedProduct.productTitle}</strong>
                      </s-text>
                    )}

                    {modalAction !== "deleteProduct" && selectedSku && (
                      <>
                        <s-text>
                          <strong>SKU: {selectedSku.sku}</strong>
                        </s-text>
                        <s-box marginTop="small">
                          <s-text subdued size="small">
                            This SKU is currently used by {selectedSku.count} variant
                            {selectedSku.count !== 1 ? "s" : ""}.
                          </s-text>
                        </s-box>
                      </>
                    )}
                  </div>

                  <s-box marginBottom="large">
                    {modalAction === "deleteProduct" ? (
                      <s-text subdued>
                        This action cannot be undone. The product will be permanently
                        removed from your store.
                      </s-text>
                    ) : modalAction === "removeSku" ? (
                      <s-text subdued>
                        This will clear this SKU from all matching variants. The variants
                        will remain, but their SKU field will be empty.
                      </s-text>
                    ) : (
                      <s-text subdued>
                        This will assign new SKUs to all matching variants using the
                        pattern <code>ic-{"{variantID}"}</code>.
                      </s-text>
                    )}
                  </s-box>

                  <div
                    style={{
                      display: "flex",
                      gap: "12px",
                      justifyContent: "flex-end",
                    }}
                  >
                    <button
                      onClick={handleCancelDelete}
                      style={{
                        backgroundColor: "#f3f4f6",
                        color: "#374151",
                        border: "none",
                        padding: "10px 24px",
                        borderRadius: "6px",
                        fontSize: "14px",
                        fontWeight: "500",
                        cursor: "pointer",
                        transition: "background-color 0.2s",
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.backgroundColor = "#e5e7eb";
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.backgroundColor = "#f3f4f6";
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      onClick={handleConfirm}
                      style={{
                        backgroundColor: "#dc2626",
                        color: "white",
                        border: "none",
                        padding: "10px 24px",
                        borderRadius: "6px",
                        fontSize: "14px",
                        fontWeight: "500",
                        cursor: "pointer",
                        transition: "background-color 0.2s",
                      }}
                      onMouseEnter={(e) => {
                        e.target.style.backgroundColor = "#b91c1c";
                      }}
                      onMouseLeave={(e) => {
                        e.target.style.backgroundColor = "#dc2626";
                      }}
                    >
                      {modalAction === "deleteProduct"
                        ? "Yes, Delete Product"
                        : modalAction === "removeSku"
                        ? "Yes, Remove from Variants"
                        : "Yes, Re-assign SKUs"}
                    </button>
                  </div>
                </>
              )}

              {/* Deleting / Processing State */}
              {modalState === "deleting" && (
                <div style={{ textAlign: "center" }}>
                  <s-spinner size="large" />
                  <s-box marginTop="large">
                    <s-heading size="medium">
                      {modalAction === "deleteProduct"
                        ? "Deleting Product..."
                        : modalAction === "removeSku"
                        ? "Removing SKU..."
                        : "Re-assigning SKUs..."}
                    </s-heading>
                    <s-box marginTop="small">
                      <s-text subdued>
                        {modalAction === "deleteProduct" && selectedProduct
                          ? `Removing "${selectedProduct.productTitle}" from your store`
                          : modalAction === "removeSku" && selectedSku
                          ? `Clearing SKU "${selectedSku.sku}" from matching variants`
                          : modalAction === "reassignSku" && selectedSku
                          ? `Assigning SKUs in pattern ic-{variantID} for duplicates of "${selectedSku.sku}"`
                          : "Processing..."}
                      </s-text>
                    </s-box>
                  </s-box>
                </div>
              )}
            </div>
          </div>
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
                  Analyzing all products and variants to find duplicate SKUs.
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
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
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
                    Variants Scanned
                  </s-text>
                  <s-heading size="medium">{totalVariantsScanned || 0}</s-heading>
                </div>
                <div>
                  <s-text subdued size="small">
                    Unique SKUs
                  </s-text>
                  <s-heading size="medium">{totalUniqueSKUs || 0}</s-heading>
                </div>
                <div>
                  <s-text subdued size="small">
                    Duplicate SKUs Found
                  </s-text>
                  <s-heading
                    size="medium"
                    tone={duplicates.length > 0 ? "critical" : "success"}
                  >
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
                <s-heading size="large">✅ No Duplicate SKUs Found!</s-heading>
                <s-box marginTop="base">
                  <s-text>
                    All SKUs in your store are unique. Your inventory is well-organized.
                  </s-text>
                </s-box>
              </s-box>
            ) : (
              <>
                <s-box marginBottom="base">
                  <s-heading>
                    Found <strong>{duplicates.length}</strong> Duplicate SKU
                    {duplicates.length !== 1 ? "s" : ""}
                  </s-heading>
                  <s-text subdued>
                    Click on any SKU to expand and see all variants using that SKU
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
                        <th
                          style={{
                            textAlign: "left",
                            padding: "12px",
                            width: "40px",
                          }}
                        ></th>
                        <th style={{ textAlign: "left", padding: "12px" }}>SKU</th>
                        <th style={{ textAlign: "left", padding: "12px" }}>
                          Duplicate Count
                        </th>
                        {/* <th style={{ textAlign: "left", padding: "12px" }}>
                          Status
                        </th> */}
                        <th style={{ textAlign: "left", padding: "12px" }}>
                          Actions
                        </th>
                      </tr>
                    </thead>

                    <tbody>
                      {duplicates.map((duplicate) => (
                        <>
                          <tr
                            key={duplicate.sku}
                            style={{
                              borderBottom: "1px solid #eee",
                              backgroundColor:
                                expandedSKU === duplicate.sku ? "#f9fafb" : "white",
                            }}
                          >
                            <td
                              style={{
                                padding: "12px",
                                textAlign: "center",
                                cursor: "pointer",
                              }}
                              onClick={() => toggleExpand(duplicate.sku)}
                            >
                              <span style={{ fontSize: "18px" }}>
                                {expandedSKU === duplicate.sku ? "▼" : "▶"}
                              </span>
                            </td>
                            <td
                              style={{
                                padding: "12px",
                                fontFamily: "monospace",
                                fontWeight: "500",
                                cursor: "pointer",
                              }}
                              onClick={() => toggleExpand(duplicate.sku)}
                            >
                              {duplicate.sku}
                            </td>
                            <td
                              style={{ padding: "12px", cursor: "pointer" }}
                              onClick={() => toggleExpand(duplicate.sku)}
                            >
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
                            {/* <td
                              style={{ padding: "12px", cursor: "pointer" }}
                              onClick={() => toggleExpand(duplicate.sku)}
                            >
                              <s-text tone="critical" size="small">
                                ⚠️ Needs attention
                              </s-text>
                            </td> */}
                            <td style={{ padding: "12px" }}>
                              <div
                                style={{
                                  display: "flex",
                                  gap: "8px",
                                  flexWrap: "wrap",
                                }}
                              >
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleReassignSkuClick(
                                      duplicate.sku,
                                      duplicate.count
                                    );
                                  }}
                                  disabled={showModal}
                                  style={{
                                    backgroundColor: showModal
                                      ? "#9ca3af"
                                      : "#10b981",
                                    color: "white",
                                    border: "none",
                                    padding: "6px 12px",
                                    borderRadius: "4px",
                                    fontSize: "12px",
                                    fontWeight: "500",
                                    cursor: showModal
                                      ? "not-allowed"
                                      : "pointer",
                                    transition: "background-color 0.2s",
                                  }}
                                  onMouseEnter={(e) => {
                                    if (!showModal)
                                      e.target.style.backgroundColor = "#059669";
                                  }}
                                  onMouseLeave={(e) => {
                                    if (!showModal)
                                      e.target.style.backgroundColor = "#10b981";
                                  }}
                                >
                                  Re-assign SKUs
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRemoveSkuClick(
                                      duplicate.sku,
                                      duplicate.count
                                    );
                                  }}
                                  disabled={showModal}
                                  style={{
                                    backgroundColor: showModal
                                      ? "#9ca3af"
                                      : "#2563eb",
                                    color: "white",
                                    border: "none",
                                    padding: "6px 12px",
                                    borderRadius: "4px",
                                    fontSize: "12px",
                                    fontWeight: "500",
                                    cursor: showModal
                                      ? "not-allowed"
                                      : "pointer",
                                    transition: "background-color 0.2s",
                                  }}
                                  onMouseEnter={(e) => {
                                    if (!showModal)
                                      e.target.style.backgroundColor = "#1d4ed8";
                                  }}
                                  onMouseLeave={(e) => {
                                    if (!showModal)
                                      e.target.style.backgroundColor = "#2563eb";
                                  }}
                                >
                                  Clear SKU from Variants
                                </button>
                              </div>
                            </td>
                          </tr>

                          {/* Expanded Details */}
                          {expandedSKU === duplicate.sku && (
                            <tr>
                              <td
                                colSpan={5}
                                style={{
                                  padding: "0",
                                  backgroundColor: "#f9fafb",
                                }}
                              >
                                <div
                                  style={{
                                    padding: "16px",
                                    paddingLeft: "60px",
                                  }}
                                >
                                  <table
                                    style={{
                                      width: "100%",
                                      borderCollapse: "collapse",
                                      backgroundColor: "white",
                                      borderRadius: "4px",
                                      overflow: "hidden",
                                    }}
                                  >
                                    <thead>
                                      <tr style={{ backgroundColor: "#f3f4f6" }}>
                                        <th
                                          style={{
                                            textAlign: "left",
                                            padding: "10px",
                                            fontSize: "13px",
                                            fontWeight: "600",
                                          }}
                                        >
                                          Image
                                        </th>
                                        <th
                                          style={{
                                            textAlign: "left",
                                            padding: "10px",
                                            fontSize: "13px",
                                            fontWeight: "600",
                                          }}
                                        >
                                          Product Name
                                        </th>
                                        <th
                                          style={{
                                            textAlign: "left",
                                            padding: "10px",
                                            fontSize: "13px",
                                            fontWeight: "600",
                                          }}
                                        >
                                          Variant
                                        </th>
                                        <th
                                          style={{
                                            textAlign: "left",
                                            padding: "10px",
                                            fontSize: "13px",
                                            fontWeight: "600",
                                          }}
                                        >
                                          Barcode
                                        </th>
                                        <th
                                          style={{
                                            textAlign: "left",
                                            padding: "10px",
                                            fontSize: "13px",
                                            fontWeight: "600",
                                          }}
                                        >
                                          Product ID
                                        </th>
                                        <th
                                          style={{
                                            textAlign: "left",
                                            padding: "10px",
                                            fontSize: "13px",
                                            fontWeight: "600",
                                          }}
                                        >
                                          Variant ID
                                        </th>
                                        <th
                                          style={{
                                            textAlign: "left",
                                            padding: "10px",
                                            fontSize: "13px",
                                            fontWeight: "600",
                                          }}
                                        >
                                          Inventory
                                        </th>
                                        <th
                                          style={{
                                            textAlign: "left",
                                            padding: "10px",
                                            fontSize: "13px",
                                            fontWeight: "600",
                                          }}
                                        >
                                          Price
                                        </th>
                                        <th
                                          style={{
                                            textAlign: "center",
                                            padding: "10px",
                                            fontSize: "13px",
                                            fontWeight: "600",
                                          }}
                                        >
                                          Actions
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {duplicate.variants.map(
                                        (variant, vIndex) => (
                                          <tr
                                            key={variant.variantId}
                                            style={{
                                              borderBottom:
                                                vIndex <
                                                duplicate.variants.length - 1
                                                  ? "1px solid #f3f4f6"
                                                  : "none",
                                            }}
                                          >
                                            <td style={{ padding: "10px" }}>
                                              {variant.productImage ? (
                                                <img
                                                  src={variant.productImage}
                                                  width="40"
                                                  height="40"
                                                  style={{
                                                    borderRadius: "4px",
                                                    objectFit: "cover",
                                                  }}
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
                                            <td
                                              style={{
                                                padding: "10px",
                                                fontSize: "13px",
                                              }}
                                            >
                                              {variant.productTitle}
                                            </td>
                                            <td
                                              style={{
                                                padding: "10px",
                                                fontSize: "13px",
                                                color: "#6b7280",
                                              }}
                                            >
                                              {variant.variantTitle}
                                            </td>
                                            <td
                                              style={{
                                                padding: "10px",
                                                fontSize: "12px",
                                                fontFamily: "monospace",
                                                color: "#6b7280",
                                              }}
                                            >
                                              {variant.barcode}
                                            </td>
                                            <td
                                              style={{
                                                padding: "10px",
                                                fontSize: "11px",
                                                fontFamily: "monospace",
                                                color: "#6b7280",
                                              }}
                                            >
                                              {variant.productId.replace(
                                                "gid://shopify/Product/",
                                                ""
                                              )}
                                            </td>
                                            <td
                                              style={{
                                                padding: "10px",
                                                fontSize: "11px",
                                                fontFamily: "monospace",
                                                color: "#6b7280",
                                              }}
                                            >
                                              {variant.variantId.replace(
                                                "gid://shopify/ProductVariant/",
                                                ""
                                              )}
                                            </td>
                                            <td
                                              style={{
                                                padding: "10px",
                                                fontSize: "13px",
                                              }}
                                            >
                                              {variant.inventoryQuantity}
                                            </td>
                                            <td
                                              style={{
                                                padding: "10px",
                                                fontSize: "13px",
                                                fontWeight: "500",
                                              }}
                                            >
                                              ${variant.price}
                                            </td>
                                            <td
                                              style={{
                                                padding: "10px",
                                                textAlign: "center",
                                              }}
                                            >
                                              <button
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  handleDeleteClick(
                                                    variant.productId,
                                                    variant.productTitle
                                                  );
                                                }}
                                                disabled={showModal}
                                                style={{
                                                  backgroundColor: showModal
                                                    ? "#9ca3af"
                                                    : "#dc2626",
                                                  color: "white",
                                                  border: "none",
                                                  padding: "6px 12px",
                                                  borderRadius: "4px",
                                                  fontSize: "12px",
                                                  fontWeight: "500",
                                                  cursor: showModal
                                                    ? "not-allowed"
                                                    : "pointer",
                                                  transition:
                                                    "background-color 0.2s",
                                                }}
                                                onMouseEnter={(e) => {
                                                  if (!showModal) {
                                                    e.target.style.backgroundColor =
                                                      "#b91c1c";
                                                  }
                                                }}
                                                onMouseLeave={(e) => {
                                                  if (!showModal) {
                                                    e.target.style.backgroundColor =
                                                      "#dc2626";
                                                  }
                                                }}
                                              >
                                                🗑️ Delete Product
                                              </button>
                                            </td>
                                          </tr>
                                        )
                                      )}
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
