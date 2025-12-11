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

// Action to handle:
// - product deletion (not used in UI anymore, but kept in case)
// - SKU removal / re-assignment (single or multiple SKUs)
// - VARIANT deletion (new bulk delete by selected variants)
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productId = formData.get("productId");
  const actionType = formData.get("actionType");
  const sku = formData.get("sku");
  const skusJson = formData.get("skus");          // JSON array of SKUs for bulk
  const variantGroupsJson = formData.get("variantGroups"); // JSON array of { productId, variantIds }

  // ============================
  // DELETE PRODUCT (still supported, but not used by UI now)
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

  // ========================================================
  // REMOVE SKU / RE-ASSIGN SKU (single or multiple SKUs)
  // ========================================================
  if (actionType === "removeSku" || actionType === "reassignSku") {
    // Build list of SKUs to process (support both single + bulk)
    let skuList = [];

    if (skusJson) {
      try {
        const parsed = JSON.parse(skusJson);
        if (Array.isArray(parsed)) {
          skuList = parsed;
        } else if (typeof parsed === "string") {
          skuList = [parsed];
        }
      } catch (e) {
        console.error("Failed to parse skus JSON:", skusJson, e);
      }
    } else if (sku) {
      skuList = [sku];
    }

    skuList = skuList.map((s) => s && s.trim()).filter(Boolean);

    if (skuList.length === 0) {
      return {
        success: false,
        error: "No SKU(s) provided",
      };
    }

    const isReassign = actionType === "reassignSku";

    try {
      console.log(
        `${isReassign ? "🔁 Re-assigning" : "🔧 Removing"} SKUs for: ${skuList.join(
          ", "
        )}`
      );

      const variantsByProduct = new Map();

      // Collect variants for all SKUs
      for (const currentSku of skuList) {
        let cursor = null;
        let hasNextPage = true;

        while (hasNextPage) {
          const response = await admin.graphql(VARIANTS_BY_SKU_QUERY, {
            variables: {
              query: `sku:${currentSku}`,
              cursor,
            },
          });

          const json = await response.json();

          if (json.errors) {
            console.error(
              `GraphQL errors while searching variants by SKU "${currentSku}":`,
              json.errors
            );
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
            if (node.sku.trim() !== currentSku) continue;

            const productIdForVariant = node.product.id;

            if (!variantsByProduct.has(productIdForVariant)) {
              variantsByProduct.set(productIdForVariant, []);
            }

            let newSkuValue = "";

            if (isReassign) {
              // Extract numeric part of variant ID for pattern IC-{variantID}
              const variantGid = node.id; // gid://shopify/ProductVariant/1234567890
              const numericId = variantGid.split("/").pop();
              newSkuValue = `IC-${numericId}`;
            } else {
              // remove: clear SKU
              newSkuValue = "";
            }

            variantsByProduct.get(productIdForVariant).push({
              id: node.id,
              inventoryItem: {
                sku: newSkuValue,
              },
            });
          }

          hasNextPage = conn.pageInfo?.hasNextPage;
          cursor = conn.pageInfo?.endCursor || null;
        }
      }

      if (variantsByProduct.size === 0) {
        console.log(`No variants found for SKUs: ${skuList.join(", ")}`);
        return {
          success: false,
          error: `No variants found for selected SKU(s)`,
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
            `GraphQL errors while bulk-updating SKUs for product ${productIdForVariant}:`,
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
        `✅ ${
          isReassign ? "Re-assigned" : "Removed"
        } SKUs for ${totalUpdated} variants across ${
          variantsByProduct.size
        } product(s) for SKUs: ${skuList.join(", ")}`
      );

      return {
        success: true,
        mode: isReassign ? "reassign" : "remove",
        skus: skuList,
        variantsUpdated: totalUpdated,
      };
    } catch (error) {
      console.error(
        `Error ${isReassign ? "re-assigning" : "removing"} SKUs:`,
        error
      );
      return {
        success: false,
        error: `Error ${isReassign ? "re-assigning" : "removing"} SKUs: ${
          error.message
        }`,
      };
    }
  }

  // ========================================================
  // DELETE VARIANTS (bulk by product using productVariantsBulkDelete)
  // ========================================================
  if (actionType === "deleteVariants") {
    let variantGroups = [];

    if (variantGroupsJson) {
      try {
        const parsed = JSON.parse(variantGroupsJson);
        if (Array.isArray(parsed)) {
          variantGroups = parsed;
        }
      } catch (e) {
        console.error("Failed to parse variantGroups JSON:", variantGroupsJson, e);
      }
    }

    // Each group should look like: { productId: string, variantIds: string[] }
    variantGroups = variantGroups
      .filter(
        (g) =>
          g &&
          typeof g.productId === "string" &&
          Array.isArray(g.variantIds) &&
          g.variantIds.length > 0
      )
      .map((g) => ({
        productId: g.productId.trim(),
        variantIds: g.variantIds.map((id) => id && id.trim()).filter(Boolean),
      }));

    if (variantGroups.length === 0) {
      return {
        success: false,
        error: "No variant groups provided for deletion",
      };
    }

    try {
      console.log(
        `🗑️ Deleting variants with productVariantsBulkDelete for ${variantGroups.length} product(s)...`
      );

      const BULK_DELETE_VARIANTS_MUTATION = `#graphql
        mutation bulkDeleteProductVariants($productId: ID!, $variantsIds: [ID!]!) {
          productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
            product {
              id
              title
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      let totalDeleted = 0;

      for (const group of variantGroups) {
        const response = await admin.graphql(BULK_DELETE_VARIANTS_MUTATION, {
          variables: {
            productId: group.productId,
            variantsIds: group.variantIds,
          },
        });

        const json = await response.json();

        if (json.errors) {
          console.error(
            `GraphQL errors while bulk deleting variants for product ${group.productId}:`,
            json.errors
          );
          return {
            success: false,
            error: `GraphQL delete error: ${json.errors[0].message}`,
          };
        }

        const payload = json.data?.productVariantsBulkDelete;
        const userErrors = payload?.userErrors || [];

        if (userErrors.length > 0) {
          console.error("productVariantsBulkDelete userErrors:", userErrors);
          return {
            success: false,
            error: userErrors[0].message,
          };
        }

        totalDeleted += group.variantIds.length;
      }

      console.log(`✅ Deleted ${totalDeleted} variant(s) across ${variantGroups.length} product(s).`);

      return {
        success: true,
        deletedVariants: totalDeleted,
      };
    } catch (error) {
      console.error("Error deleting variants:", error);
      return {
        success: false,
        error: `Error deleting variants: ${error.message}`,
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
  const {
    duplicates,
    totalProductsScanned,
    totalVariantsScanned,
    totalUniqueSKUs,
    error,
  } = useLoaderData();
  const navigation = useNavigation();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();

  const [expandedSKU, setExpandedSKU] = useState(null);

  // Checkbox selection (multi-SKU for bulk SKU operations)
  const [selectedSkus, setSelectedSkus] = useState([]);

  // Variant selection, grouped by SKU: { [sku: string]: string[] variantIds }
  const [selectedVariantsBySku, setSelectedVariantsBySku] = useState({});

  // Modal states
  const [showModal, setShowModal] = useState(false);
  const [modalState, setModalState] = useState("confirm"); // "confirm", "deleting"
  // "removeSku" | "reassignSku" | "deleteVariants" | "deleteProduct" (kept for completeness)
  const [modalAction, setModalAction] = useState(null);
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [selectedSkuInfo, setSelectedSkuInfo] = useState(null); // { skus: string[], totalVariants: number }
  const [selectedVariantInfo, setSelectedVariantInfo] = useState(null); // { sku, variantIds, variantGroups, count }

  const isLoading = navigation.state === "loading";

  const toggleExpand = (sku) => {
    setExpandedSKU(expandedSKU === sku ? null : sku);
  };

  // Helpers for SKU selection
  const isSkuSelected = (sku) => selectedSkus.includes(sku);

  const toggleSkuSelection = (sku) => {
    setSelectedSkus((prev) =>
      prev.includes(sku) ? prev.filter((s) => s !== sku) : [...prev, sku]
    );
  };

  const selectAllSkus = () => {
    setSelectedSkus(duplicates.map((d) => d.sku));
  };

  const clearAllSkus = () => {
    setSelectedSkus([]);
  };

  const allSelected =
    duplicates.length > 0 && selectedSkus.length === duplicates.length;
  const someSelected =
    selectedSkus.length > 0 && selectedSkus.length < duplicates.length;

  // Build info for selected SKUs (for modal text)
  const buildSelectedSkuInfo = () => {
    const selectedDuplicates = duplicates.filter((d) =>
      selectedSkus.includes(d.sku)
    );
    const totalVariants = selectedDuplicates.reduce(
      (sum, d) => sum + d.count,
      0
    );
    const skus = selectedDuplicates.map((d) => d.sku);
    return {
      skus,
      totalVariants,
    };
  };

  // Helpers for variant selection per SKU
  const getSelectedVariantsForSku = (sku) =>
    selectedVariantsBySku[sku] || [];

  const isVariantSelected = (sku, variantId) =>
    (selectedVariantsBySku[sku] || []).includes(variantId);

  const toggleVariantSelection = (sku, variantId) => {
    setSelectedVariantsBySku((prev) => {
      const current = prev[sku] || [];
      let nextForSku;
      if (current.includes(variantId)) {
        nextForSku = current.filter((id) => id !== variantId);
      } else {
        nextForSku = [...current, variantId];
      }
      return {
        ...prev,
        [sku]: nextForSku,
      };
    });
  };

  const clearSelectedVariantsForSku = (sku) => {
    setSelectedVariantsBySku((prev) => {
      const copy = { ...prev };
      delete copy[sku];
      return copy;
    });
  };

  // Bulk Clear SKUs (by selected SKUs)
  const handleBulkRemoveSkuClick = () => {
    const info = buildSelectedSkuInfo();
    if (!info.skus.length) return;
    setSelectedSkuInfo(info);
    setSelectedProduct(null);
    setSelectedVariantInfo(null);
    setModalAction("removeSku");
    setModalState("confirm");
    setShowModal(true);
  };

  // Bulk Reassign SKUs (by selected SKUs)
  const handleBulkReassignSkuClick = () => {
    const info = buildSelectedSkuInfo();
    if (!info.skus.length) return;
    setSelectedSkuInfo(info);
    setSelectedProduct(null);
    setSelectedVariantInfo(null);
    setModalAction("reassignSku");
    setModalState("confirm");
    setShowModal(true);
  };

  // Bulk delete variants for a given SKU group
  const handleBulkDeleteVariantsClick = (sku, variantIds) => {
    if (!variantIds.length) return;

    // Find the duplicate entry for this SKU
    const duplicate = duplicates.find((d) => d.sku === sku);
    if (!duplicate) return;

    // Group selected variant IDs by productId (required by productVariantsBulkDelete)
    const groupsMap = new Map();

    variantIds.forEach((id) => {
      const v = duplicate.variants.find((vv) => vv.variantId === id);
      if (!v) return;
      const productId = v.productId;
      if (!groupsMap.has(productId)) {
        groupsMap.set(productId, []);
      }
      groupsMap.get(productId).push(v.variantId);
    });

    const variantGroups = Array.from(groupsMap.entries()).map(
      ([productId, ids]) => ({
        productId,
        variantIds: ids,
      })
    );

    if (variantGroups.length === 0) return;

    setSelectedVariantInfo({
      sku,
      variantIds,
      variantGroups,
      count: variantIds.length,
    });
    setSelectedProduct(null);
    setSelectedSkuInfo(null);
    setModalAction("deleteVariants");
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
    } else if (
      (modalAction === "removeSku" || modalAction === "reassignSku") &&
      selectedSkuInfo &&
      selectedSkuInfo.skus?.length
    ) {
      setModalState("deleting");
      fetcher.submit(
        {
          actionType: modalAction,
          skus: JSON.stringify(selectedSkuInfo.skus),
        },
        { method: "post" }
      );
    } else if (modalAction === "deleteVariants" && selectedVariantInfo) {
      setModalState("deleting");
      fetcher.submit(
        {
          actionType: "deleteVariants",
          variantGroups: JSON.stringify(selectedVariantInfo.variantGroups),
        },
        { method: "post" }
      );
    }
  };

  const handleCancelDelete = () => {
    setShowModal(false);
    setSelectedProduct(null);
    setSelectedSkuInfo(null);
    setSelectedVariantInfo(null);
    setModalAction(null);
    setModalState("confirm");
  };

  // Handle fetcher completion (only after an operation is in progress)
  useEffect(() => {
    if (modalState === "deleting" && fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        // Operation successful, revalidate list in the background
        revalidator.revalidate();

        // Clear selection based on action type
        if (
          modalAction === "removeSku" ||
          modalAction === "reassignSku"
        ) {
          setSelectedSkus([]);
        } else if (
          modalAction === "deleteVariants" &&
          selectedVariantInfo?.sku
        ) {
          clearSelectedVariantsForSku(selectedVariantInfo.sku);
        }
      }

      // Close modal and reset state
      setShowModal(false);
      setSelectedProduct(null);
      setSelectedSkuInfo(null);
      setSelectedVariantInfo(null);
      setModalAction(null);
      setModalState("confirm");
    }
  }, [
    fetcher.state,
    fetcher.data,
    modalState,
    modalAction,
    selectedVariantInfo,
    revalidator,
  ]);

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
        {showModal &&
          (selectedProduct || selectedSkuInfo || selectedVariantInfo) && (
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
                          ? "Clear SKU from Variants?"
                          : modalAction === "reassignSku"
                          ? "Re-assign SKUs?"
                          : "Delete Variants?"}
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

                      {modalAction !== "deleteProduct" && selectedSkuInfo && (
                        <>
                          <s-text>
                            <strong>
                              {selectedSkuInfo.skus.length} SKU
                              {selectedSkuInfo.skus.length !== 1 ? "s" : ""} selected
                            </strong>
                          </s-text>
                          <s-box marginTop="small">
                            <s-text subdued size="small">
                              Total variants affected: {selectedSkuInfo.totalVariants}
                            </s-text>
                          </s-box>
                          {selectedSkuInfo.skus.length > 0 && (
                            <s-box marginTop="small">
                              <s-text subdued size="small">
                                {selectedSkuInfo.skus.slice(0, 5).join(", ")}
                                {selectedSkuInfo.skus.length > 5
                                  ? ` + ${selectedSkuInfo.skus.length - 5} more`
                                  : ""}
                              </s-text>
                            </s-box>
                          )}
                        </>
                      )}

                      {modalAction === "deleteVariants" &&
                        selectedVariantInfo &&
                        !selectedSkuInfo && (
                          <>
                            <s-text>
                              <strong>
                                {selectedVariantInfo.count} variant
                                {selectedVariantInfo.count !== 1 ? "s" : ""} selected
                              </strong>
                            </s-text>
                            <s-box marginTop="small">
                              <s-text subdued size="small">
                                Under SKU: {selectedVariantInfo.sku}
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
                          This will clear the SKU field from all matching variants of the
                          selected SKUs. The variants will remain, but their SKU will be
                          empty.
                        </s-text>
                      ) : modalAction === "reassignSku" ? (
                        <s-text subdued>
                          This will assign new SKUs to all matching variants of the
                          selected SKUs using the pattern{" "}
                          <code>IC-{"{variantID}"}</code>.
                        </s-text>
                      ) : (
                        <s-text subdued>
                          This will permanently delete the selected variants from your
                          store. This cannot be undone.
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
                          ? "Yes, Clear SKUs"
                          : modalAction === "reassignSku"
                          ? "Yes, Re-assign SKUs"
                          : "Yes, Delete Variants"}
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
                          ? "Clearing SKUs..."
                          : modalAction === "reassignSku"
                          ? "Re-assigning SKUs..."
                          : "Deleting Variants..."}
                      </s-heading>
                      <s-box marginTop="small">
                        <s-text subdued>
                          {modalAction === "deleteProduct" && selectedProduct
                            ? `Removing "${selectedProduct.productTitle}" from your store`
                            : modalAction === "removeSku" && selectedSkuInfo
                            ? `Clearing SKUs for ${selectedSkuInfo.skus.length} duplicate SKU${
                                selectedSkuInfo.skus.length !== 1 ? "s" : ""
                              }`
                            : modalAction === "reassignSku" && selectedSkuInfo
                            ? `Assigning SKUs in pattern IC-{variantID} for ${selectedSkuInfo.skus.length} duplicate SKU${
                                selectedSkuInfo.skus.length !== 1 ? "s" : ""
                              }`
                            : modalAction === "deleteVariants" && selectedVariantInfo
                            ? `Deleting ${selectedVariantInfo.count} variant${
                                selectedVariantInfo.count !== 1 ? "s" : ""
                              } under SKU "${selectedVariantInfo.sku}"`
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
                    Select SKUs for bulk clear/re-assign, or expand a SKU to select and
                    delete individual variants.
                  </s-text>
                </s-box>

                {/* Bulk actions bar for SKUs */}
                {selectedSkus.length > 0 && (
                  <s-box
                    marginBottom="base"
                    padding="small"
                    borderWidth="base"
                    borderRadius="base"
                    background="subdued"
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: "12px",
                        flexWrap: "wrap",
                      }}
                    >
                      <div>
                        <s-text>
                          <strong>{selectedSkus.length}</strong> SKU
                          {selectedSkus.length !== 1 ? "s" : ""} selected
                        </s-text>
                      </div>
                      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                        <button
                          type="button"
                          onClick={handleBulkReassignSkuClick}
                          disabled={showModal}
                          style={{
                            backgroundColor: showModal ? "#9ca3af" : "#10b981",
                            color: "white",
                            border: "none",
                            padding: "6px 12px",
                            borderRadius: "4px",
                            fontSize: "12px",
                            fontWeight: "500",
                            cursor: showModal ? "not-allowed" : "pointer",
                            transition: "background-color 0.2s",
                          }}
                          onMouseEnter={(e) => {
                            if (!showModal) e.target.style.backgroundColor = "#059669";
                          }}
                          onMouseLeave={(e) => {
                            if (!showModal) e.target.style.backgroundColor = "#10b981";
                          }}
                        >
                          Re-assign SKUs
                        </button>
                        <button
                          type="button"
                          onClick={handleBulkRemoveSkuClick}
                          disabled={showModal}
                          style={{
                            backgroundColor: showModal ? "#9ca3af" : "#2563eb",
                            color: "white",
                            border: "none",
                            padding: "6px 12px",
                            borderRadius: "4px",
                            fontSize: "12px",
                            fontWeight: "500",
                            cursor: showModal ? "not-allowed" : "pointer",
                            transition: "background-color 0.2s",
                          }}
                          onMouseEnter={(e) => {
                            if (!showModal) e.target.style.backgroundColor = "#1d4ed8";
                          }}
                          onMouseLeave={(e) => {
                            if (!showModal) e.target.style.backgroundColor = "#2563eb";
                          }}
                        >
                          Clear SKU from Variants
                        </button>
                        <button
                          type="button"
                          onClick={clearAllSkus}
                          style={{
                            backgroundColor: "transparent",
                            color: "#6b7280",
                            border: "none",
                            padding: "6px 8px",
                            borderRadius: "4px",
                            fontSize: "12px",
                            fontWeight: "500",
                            cursor: "pointer",
                            textDecoration: "underline",
                          }}
                        >
                          Clear selection
                        </button>
                      </div>
                    </div>
                  </s-box>
                )}

                <s-box
                  marginTop="base"
                  padding="base"
                  borderWidth="base"
                  borderRadius="base"
                  background="subdued"
                >
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid " +
                        "#ddd" }}>
                        <th
                          style={{
                            textAlign: "center",
                            padding: "12px",
                            width: "40px",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={allSelected}
                            ref={(input) => {
                              if (input) {
                                input.indeterminate = someSelected;
                              }
                            }}
                            onChange={(e) => {
                              if (e.target.checked) {
                                selectAllSkus();
                              } else {
                                clearAllSkus();
                              }
                            }}
                          />
                        </th>
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
                        <th style={{ textAlign: "left", padding: "12px" }}>Status</th>
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
                            {/* Checkbox */}
                            <td
                              style={{
                                padding: "12px",
                                textAlign: "center",
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                checked={isSkuSelected(duplicate.sku)}
                                onChange={() => toggleSkuSelection(duplicate.sku)}
                              />
                            </td>

                            {/* Expand icon */}
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

                            {/* SKU */}
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

                            {/* Count */}
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

                            {/* Status */}
                            <td
                              style={{ padding: "12px", cursor: "pointer" }}
                              onClick={() => toggleExpand(duplicate.sku)}
                            >
                              <s-text tone="critical" size="small">
                                ⚠️ Needs attention
                              </s-text>
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
                                  {/* Bulk bar for variant selection under this SKU */}
                                  {getSelectedVariantsForSku(duplicate.sku).length >
                                    0 && (
                                    <s-box
                                      marginBottom="small"
                                      padding="small"
                                      borderWidth="base"
                                      borderRadius="base"
                                      background="subdued"
                                    >
                                      <div
                                        style={{
                                          display: "flex",
                                          alignItems: "center",
                                          justifyContent: "space-between",
                                          gap: "8px",
                                          flexWrap: "wrap",
                                        }}
                                      >
                                        <s-text size="small">
                                          <strong>
                                            {
                                              getSelectedVariantsForSku(
                                                duplicate.sku
                                              ).length
                                            }
                                          </strong>{" "}
                                          variant
                                          {getSelectedVariantsForSku(duplicate.sku)
                                            .length !== 1
                                            ? "s"
                                            : ""}{" "}
                                          selected under SKU {duplicate.sku}
                                        </s-text>
                                        <div
                                          style={{
                                            display: "flex",
                                            gap: "8px",
                                            flexWrap: "wrap",
                                          }}
                                        >
                                          <button
                                            type="button"
                                            onClick={() =>
                                              handleBulkDeleteVariantsClick(
                                                duplicate.sku,
                                                getSelectedVariantsForSku(
                                                  duplicate.sku
                                                )
                                              )
                                            }
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
                                              transition: "background-color 0.2s",
                                            }}
                                            onMouseEnter={(e) => {
                                              if (!showModal)
                                                e.target.style.backgroundColor =
                                                  "#b91c1c";
                                            }}
                                            onMouseLeave={(e) => {
                                              if (!showModal)
                                                e.target.style.backgroundColor =
                                                  "#dc2626";
                                            }}
                                          >
                                            Delete selected variants
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() =>
                                              clearSelectedVariantsForSku(
                                                duplicate.sku
                                              )
                                            }
                                            style={{
                                              backgroundColor: "transparent",
                                              color: "#6b7280",
                                              border: "none",
                                              padding: "4px 8px",
                                              borderRadius: "4px",
                                              fontSize: "11px",
                                              fontWeight: "500",
                                              cursor: "pointer",
                                              textDecoration: "underline",
                                            }}
                                          >
                                            Clear selection
                                          </button>
                                        </div>
                                      </div>
                                    </s-box>
                                  )}

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
                                            textAlign: "center",
                                            padding: "10px",
                                            fontSize: "13px",
                                            fontWeight: "600",
                                            width: "40px",
                                          }}
                                        >
                                          {/* Variant checkbox column */}
                                        </th>
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
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {duplicate.variants.map((variant, vIndex) => (
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
                                          {/* Variant checkbox */}
                                          <td
                                            style={{
                                              padding: "10px",
                                              textAlign: "center",
                                            }}
                                            onClick={(e) => e.stopPropagation()}
                                          >
                                            <input
                                              type="checkbox"
                                              checked={isVariantSelected(
                                                duplicate.sku,
                                                variant.variantId
                                              )}
                                              onChange={() =>
                                                toggleVariantSelection(
                                                  duplicate.sku,
                                                  variant.variantId
                                                )
                                              }
                                            />
                                          </td>

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
