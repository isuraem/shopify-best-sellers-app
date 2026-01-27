// ============================================
// FILE: app/routes/app.search-products.jsx
// ============================================

import { useState, useEffect } from "react";
import { useLoaderData, useSearchParams, useNavigation, useFetcher, useRevalidator } from "react-router";
import { authenticate } from "../shopify.server";

// Action to handle variant operations
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");
  const variantGroupsJson = formData.get("variantGroups");

  // Helper: parse variantGroups from JSON
  const parseVariantGroups = () => {
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

    return variantGroups;
  };

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
  // REASSIGN SELECTED VARIANTS (IC-{variantID})
  // ========================================================
  if (actionType === "reassignVariants") {
    const variantGroups = parseVariantGroups();

    if (variantGroups.length === 0) {
      return {
        success: false,
        error: "No variant groups provided for re-assigning SKUs",
      };
    }

    try {
      console.log(
        `🔁 Re-assigning SKUs (IC-{variantID}) for selected variants across ${variantGroups.length} product(s)...`
      );

      let totalUpdated = 0;

      for (const group of variantGroups) {
        const variantsInput = group.variantIds.map((variantId) => {
          const numericId = variantId.split("/").pop();
          return {
            id: variantId,
            inventoryItem: {
              sku: `IC-${numericId}`,
            },
          };
        });

        const response = await admin.graphql(BULK_UPDATE_MUTATION, {
          variables: {
            productId: group.productId,
            variants: variantsInput,
          },
        });

        const json = await response.json();

        if (json.errors) {
          console.error(
            `GraphQL errors while re-assigning SKUs for product ${group.productId}:`,
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
          console.error("Bulk reassign userErrors:", userErrors);
          return {
            success: false,
            error: userErrors[0].message,
          };
        }

        totalUpdated += group.variantIds.length;
      }

      console.log(
        `✅ Re-assigned SKUs (IC-{variantID}) for ${totalUpdated} selected variants across ${variantGroups.length} product(s).`
      );

      return {
        success: true,
        mode: "reassignVariants",
        variantsUpdated: totalUpdated,
      };
    } catch (error) {
      console.error("Error re-assigning selected variants:", error);
      return {
        success: false,
        error: `Error re-assigning selected variants: ${error.message}`,
      };
    }
  }

  // ========================================================
  // CLEAR SKU FROM SELECTED VARIANTS
  // ========================================================
  if (actionType === "clearVariantSkus") {
    const variantGroups = parseVariantGroups();

    if (variantGroups.length === 0) {
      return {
        success: false,
        error: "No variant groups provided for clearing SKUs",
      };
    }

    try {
      console.log(
        `🔧 Clearing SKUs for selected variants across ${variantGroups.length} product(s)...`
      );

      let totalUpdated = 0;

      for (const group of variantGroups) {
        const variantsInput = group.variantIds.map((variantId) => ({
          id: variantId,
          inventoryItem: {
            sku: "",
          },
        }));

        const response = await admin.graphql(BULK_UPDATE_MUTATION, {
          variables: {
            productId: group.productId,
            variants: variantsInput,
          },
        });

        const json = await response.json();

        if (json.errors) {
          console.error(
            `GraphQL errors while clearing SKUs for product ${group.productId}:`,
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
          console.error("Bulk clear userErrors:", userErrors);
          return {
            success: false,
            error: userErrors[0].message,
          };
        }

        totalUpdated += group.variantIds.length;
      }

      console.log(
        `✅ Cleared SKUs for ${totalUpdated} selected variants across ${variantGroups.length} product(s).`
      );

      return {
        success: true,
        mode: "clearVariantSkus",
        variantsUpdated: totalUpdated,
      };
    } catch (error) {
      console.error("Error clearing SKUs for selected variants:", error);
      return {
        success: false,
        error: `Error clearing SKUs for selected variants: ${error.message}`,
      };
    }
  }

  // ========================================================
  // DELETE VARIANTS (bulk by product using productVariantsBulkDelete)
  // ========================================================
  if (actionType === "deleteVariants") {
    const variantGroups = parseVariantGroups();

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

// Loader to fetch products with ALL variants based on search query
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const searchQuery = url.searchParams.get("search") || "";

  // If no search query, return early without fetching
  if (!searchQuery.trim()) {
    return {
      success: true,
      variants: [],
      searchQuery: "",
      totalVariants: 0,
      noSearch: true,
    };
  }

  try {
    let cursor = null;
    let hasNextPage = true;
    const allVariants = [];

    const PRODUCTS_QUERY = `#graphql
      query getProducts($cursor: String, $query: String) {
        products(first: 250, after: $cursor, query: $query) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              title
              handle
              tags
              status
              images(first: 1) {
                nodes {
                  url
                }
              }
              variants(first: 100) {
                edges {
                  node {
                    id
                    title
                    price
                    sku
                    inventoryQuantity
                  }
                }
              }
            }
          }
        }
      }
    `;

    console.log(`Fetching products with search query: "${searchQuery}"`);

    // Fetch all products matching the search query
    while (hasNextPage) {
      const response = await admin.graphql(PRODUCTS_QUERY, {
        variables: {
          cursor,
          query: searchQuery || null,
        },
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

        // Loop through ALL variants
        if (product.variants?.edges?.length) {
          for (const variantEdge of product.variants.edges) {
            const variant = variantEdge.node;

            allVariants.push({
              productId: product.id,
              variantId: variant.id,
              productTitle: product.title,
              variantTitle: variant.title,
              handle: product.handle,
              tags: product.tags || [],
              status: product.status,
              image: product.images?.nodes?.[0]?.url || null,
              price: variant.price || "0.00",
              sku: variant.sku || "N/A",
              inventory: variant.inventoryQuantity || 0,
            });
          }
        }
      }

      hasNextPage = json.data.products.pageInfo.hasNextPage;
      cursor = json.data.products.pageInfo.endCursor || null;

      if (hasNextPage) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    console.log(`Fetched ${allVariants.length} variants from products`);

    // Fetch sales data for all variants
    console.log("Fetching sales data for variants...");
    const salesData = await fetchSalesData(admin, allVariants);

    // Merge sales data with variants
    const variantsWithSales = allVariants.map(variant => ({
      ...variant,
      totalSales: salesData[variant.variantId] || 0,
    }));

    return {
      success: true,
      variants: variantsWithSales,
      searchQuery,
      totalVariants: variantsWithSales.length,
      noSearch: false,
    };
  } catch (error) {
    console.error("Error fetching products:", error);
    return {
      success: false,
      error: `Error fetching products: ${error.message}`,
    };
  }
}

// Helper function to fetch sales data
async function fetchSalesData(admin, variants) {
  const variantIds = variants.map(v => v.variantId);
  const salesByVariant = {};

  // Initialize all variants with 0 sales
  variantIds.forEach(id => {
    salesByVariant[id] = 0;
  });

  try {
    let cursor = null;
    let hasNextPage = true;
    let orderCount = 0;

    const ORDERS_QUERY = `#graphql
      query getOrders($cursor: String) {
        orders(first: 250, after: $cursor, query: "status:any") {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              lineItems(first: 250) {
                edges {
                  node {
                    variant {
                      id
                    }
                    quantity
                  }
                }
              }
            }
          }
        }
      }
    `;

    // Fetch orders and count sales per variant
    while (hasNextPage) {
      const response = await admin.graphql(ORDERS_QUERY, {
        variables: { cursor },
      });

      const json = await response.json();

      if (json.errors) {
        console.error("Error fetching orders:", json.errors);
        break;
      }

      const orders = json.data?.orders?.edges || [];
      orderCount += orders.length;

      for (const orderEdge of orders) {
        const order = orderEdge.node;
        
        if (order.lineItems?.edges?.length) {
          for (const lineItemEdge of order.lineItems.edges) {
            const lineItem = lineItemEdge.node;
            const variantId = lineItem.variant?.id;
            
            if (variantId && variantIds.includes(variantId)) {
              salesByVariant[variantId] = (salesByVariant[variantId] || 0) + (lineItem.quantity || 0);
            }
          }
        }
      }

      hasNextPage = json.data.orders.pageInfo.hasNextPage;
      cursor = json.data.orders.pageInfo.endCursor || null;

      if (hasNextPage) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    console.log(`Processed ${orderCount} orders for sales data`);
    return salesByVariant;
  } catch (error) {
    console.error("Error fetching sales data:", error);
    return salesByVariant;
  }
}

// Component
export default function SearchProducts() {
  const data = useLoaderData();
  const navigation = useNavigation();
  const fetcher = useFetcher();
  const revalidator = useRevalidator();
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(data.searchQuery || "");
  const [filteredVariants, setFilteredVariants] = useState([]);
  const [filterBy, setFilterBy] = useState("all");
  const [sortBy, setSortBy] = useState("none");
  
  // Variant selection state
  const [selectedVariants, setSelectedVariants] = useState(new Set());
  
  // Modal states
  const [showModal, setShowModal] = useState(false);
  const [modalState, setModalState] = useState("confirm");
  const [modalAction, setModalAction] = useState(null);
  const [selectedVariantInfo, setSelectedVariantInfo] = useState(null);

  // Check if we're currently loading
  const isLoading = navigation.state === "loading" || navigation.state === "submitting";

  // Filter and sort variants
  useEffect(() => {
    if (!data.success || !data.variants || data.noSearch) {
      setFilteredVariants([]);
      return;
    }

    let filtered = [];

    if (!searchInput.trim() || searchInput.trim() === data.searchQuery) {
      if (filterBy === "all") {
        filtered = data.variants;
      } else {
        filtered = data.variants.filter((variant) => {
          const searchLower = data.searchQuery.toLowerCase();
          const productTitleMatch = variant.productTitle?.toLowerCase().includes(searchLower);
          const variantTitleMatch = variant.variantTitle?.toLowerCase().includes(searchLower);
          const tagsMatch = variant.tags?.some((tag) => tag.toLowerCase().includes(searchLower));
          const skuMatch = variant.sku?.toLowerCase().includes(searchLower);

          switch (filterBy) {
            case "title":
              return productTitleMatch || variantTitleMatch;
            case "tags":
              return tagsMatch;
            case "sku":
              return skuMatch;
            default:
              return productTitleMatch || variantTitleMatch || tagsMatch || skuMatch;
          }
        });
      }
    } else {
      const searchLower = searchInput.toLowerCase();
      filtered = data.variants.filter((variant) => {
        const productTitleMatch = variant.productTitle?.toLowerCase().includes(searchLower);
        const variantTitleMatch = variant.variantTitle?.toLowerCase().includes(searchLower);
        const tagsMatch = variant.tags?.some((tag) => tag.toLowerCase().includes(searchLower));
        const skuMatch = variant.sku?.toLowerCase().includes(searchLower);

        switch (filterBy) {
          case "title":
            return productTitleMatch || variantTitleMatch;
          case "tags":
            return tagsMatch;
          case "sku":
            return skuMatch;
          case "all":
          default:
            return productTitleMatch || variantTitleMatch || tagsMatch || skuMatch;
        }
      });
    }

    if (sortBy === "sales-high") {
      filtered = [...filtered].sort((a, b) => (b.totalSales || 0) - (a.totalSales || 0));
    } else if (sortBy === "sales-low") {
      filtered = [...filtered].sort((a, b) => (a.totalSales || 0) - (b.totalSales || 0));
    }

    setFilteredVariants(filtered);
  }, [searchInput, filterBy, sortBy, data.variants, data.success, data.noSearch, data.searchQuery]);

  // Handle search submission
  const handleSearch = (e) => {
    e.preventDefault();
    if (searchInput.trim()) {
      setSearchParams({ search: searchInput.trim() });
    }
  };

  // Clear search
  const handleClearSearch = () => {
    setSearchInput("");
    setSearchParams({});
    setSortBy("none");
    setSelectedVariants(new Set());
  };

  // Variant selection handlers
  const toggleVariantSelection = (variantId) => {
    setSelectedVariants(prev => {
      const newSet = new Set(prev);
      if (newSet.has(variantId)) {
        newSet.delete(variantId);
      } else {
        newSet.add(variantId);
      }
      return newSet;
    });
  };

  const toggleSelectAll = (checked) => {
    if (checked) {
      setSelectedVariants(new Set(filteredVariants.map(v => v.variantId)));
    } else {
      setSelectedVariants(new Set());
    }
  };

  const clearSelection = () => {
    setSelectedVariants(new Set());
  };

  // Build variant groups for bulk operations
  const buildVariantGroups = () => {
    const groupsMap = new Map();
    
    filteredVariants.forEach(variant => {
      if (selectedVariants.has(variant.variantId)) {
        if (!groupsMap.has(variant.productId)) {
          groupsMap.set(variant.productId, new Set());
        }
        groupsMap.get(variant.productId).add(variant.variantId);
      }
    });

    return Array.from(groupsMap.entries()).map(([productId, idsSet]) => ({
      productId,
      variantIds: Array.from(idsSet),
    }));
  };

  // Open modal for bulk actions
  const openBulkActionModal = (action) => {
    const variantGroups = buildVariantGroups();
    if (!variantGroups.length) return;

    setSelectedVariantInfo({
      totalVariants: selectedVariants.size,
      variantGroups,
    });
    setModalAction(action);
    setModalState("confirm");
    setShowModal(true);
  };

  const handleClearSkuClick = () => openBulkActionModal("clearVariantSkus");
  const handleDeleteClick = () => openBulkActionModal("deleteVariants");

  const handleConfirm = () => {
    if (selectedVariantInfo && selectedVariantInfo.variantGroups?.length) {
      setModalState("processing");
      fetcher.submit(
        {
          actionType: modalAction,
          variantGroups: JSON.stringify(selectedVariantInfo.variantGroups),
        },
        { method: "post" }
      );
    }
  };

  const handleCancel = () => {
    setShowModal(false);
    setSelectedVariantInfo(null);
    setModalAction(null);
    setModalState("confirm");
  };

  // Handle fetcher completion
  useEffect(() => {
    if (modalState === "processing" && fetcher.state === "idle" && fetcher.data) {
      if (fetcher.data.success) {
        clearSelection();
        // Revalidate the data instead of reloading
        revalidator.revalidate();
      }
      setShowModal(false);
      setSelectedVariantInfo(null);
      setModalAction(null);
      setModalState("confirm");
    }
  }, [fetcher.state, fetcher.data, modalState, revalidator]);

  const allSelected = filteredVariants.length > 0 && selectedVariants.size === filteredVariants.length;
  const someSelected = selectedVariants.size > 0 && selectedVariants.size < filteredVariants.length;

  if (!data.success) {
    return (
      <s-page heading="Search Products & Variants">
        <s-section>
          <s-box padding="large" borderWidth="base" borderRadius="base" background="critical">
            <s-text tone="critical">{data.error}</s-text>
          </s-box>
        </s-section>
      </s-page>
    );
  }

  return (
    <s-page heading="Search Products & Variants">
      <s-section>
        {/* Search Form */}
        <s-box marginBottom="base" padding="base" borderWidth="base" borderRadius="base" background="subdued">
          <form onSubmit={handleSearch}>
            <div style={{ display: "flex", gap: "12px", marginBottom: "12px" }}>
              <input
                type="text"
                placeholder="Search by product title, variant, tags, or SKU..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                disabled={isLoading}
                style={{
                  flex: 1,
                  padding: "12px 16px",
                  fontSize: "14px",
                  borderRadius: "8px",
                  border: "1px solid #d1d5db",
                  outline: "none",
                  opacity: isLoading ? 0.6 : 1,
                }}
              />
              <button
                type="submit"
                disabled={!searchInput.trim() || isLoading}
                style={{
                  padding: "12px 24px",
                  backgroundColor: searchInput.trim() && !isLoading ? "#3b82f6" : "#9ca3af",
                  color: "white",
                  border: "none",
                  borderRadius: "8px",
                  fontWeight: "600",
                  cursor: searchInput.trim() && !isLoading ? "pointer" : "not-allowed",
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                {isLoading ? (
                  <>
                    <span style={{
                      display: "inline-block",
                      width: "16px",
                      height: "16px",
                      border: "2px solid white",
                      borderTopColor: "transparent",
                      borderRadius: "50%",
                      animation: "spin 0.8s linear infinite",
                    }}></span>
                    Searching...
                  </>
                ) : (
                  <>🔍 Search</>
                )}
              </button>
              {data.searchQuery && !isLoading && (
                <button
                  type="button"
                  onClick={handleClearSearch}
                  style={{
                    padding: "12px 24px",
                    backgroundColor: "#6b7280",
                    color: "white",
                    border: "none",
                    borderRadius: "8px",
                    fontWeight: "600",
                    cursor: "pointer",
                  }}
                >
                  Clear
                </button>
              )}
            </div>

            {/* Filter Options */}
            {!data.noSearch && !isLoading && data.variants.length > 0 && (
              <div style={{ display: "flex", gap: "16px", alignItems: "center", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <s-text subdued size="small">Filter by:</s-text>
                  <div style={{ display: "flex", gap: "8px" }}>
                    {["all", "title", "sku", "tags"].map((option) => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => setFilterBy(option)}
                        style={{
                          padding: "6px 12px",
                          backgroundColor: filterBy === option ? "#3b82f6" : "white",
                          color: filterBy === option ? "white" : "#6b7280",
                          border: "1px solid #d1d5db",
                          borderRadius: "6px",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: "pointer",
                          textTransform: "capitalize",
                        }}
                      >
                        {option}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <s-text subdued size="small">Sort by:</s-text>
                  <div style={{ display: "flex", gap: "8px" }}>
                    {[
                      { value: "none", label: "None" },
                      { value: "sales-high", label: "Sales ↓" },
                      { value: "sales-low", label: "Sales ↑" },
                    ].map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setSortBy(option.value)}
                        style={{
                          padding: "6px 12px",
                          backgroundColor: sortBy === option.value ? "#10b981" : "white",
                          color: sortBy === option.value ? "white" : "#6b7280",
                          border: "1px solid #d1d5db",
                          borderRadius: "6px",
                          fontSize: "12px",
                          fontWeight: "600",
                          cursor: "pointer",
                        }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </form>
        </s-box>

        {/* Bulk Actions Bar */}
        {selectedVariants.size > 0 && !isLoading && !data.noSearch && (
          <s-box marginBottom="base" padding="small" borderWidth="base" borderRadius="base" background="subdued">
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
              <div>
                <s-text>
                  <strong>{selectedVariants.size}</strong> variant{selectedVariants.size !== 1 ? "s" : ""} selected
                </s-text>
              </div>
              <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={handleClearSkuClick}
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
                  }}
                >
                  Delete SKU
                </button>
                <button
                  type="button"
                  onClick={handleDeleteClick}
                  disabled={showModal}
                  style={{
                    backgroundColor: showModal ? "#9ca3af" : "#dc2626",
                    color: "white",
                    border: "none",
                    padding: "6px 12px",
                    borderRadius: "4px",
                    fontSize: "12px",
                    fontWeight: "500",
                    cursor: showModal ? "not-allowed" : "pointer",
                  }}
                >
                  Delete Variants
                </button>
                <button
                  type="button"
                  onClick={clearSelection}
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

        {/* Loading State */}
        {isLoading && (
          <s-box padding="20px" borderWidth="base" borderRadius="base" background="subdued" style={{ textAlign: "center" }}>
            <div style={{
              display: "inline-block",
              width: "20px",
              height: "20px",
              border: "4px solid #e5e7eb",
              borderTopColor: "#4e5054",
              borderRadius: "50%",
              animation: "spin 1s linear infinite",
              marginBottom: "16px",
            }}></div>
            <s-heading size="medium" style={{ marginBottom: "8px" }}>Searching Products...</s-heading>
            <s-text subdued>Please wait while we search for "{searchInput}" and fetch sales data</s-text>
          </s-box>
        )}

        {/* Initial State */}
        {!isLoading && data.noSearch && (
          <s-box padding="xlarge" borderWidth="base" borderRadius="base" background="subdued" style={{ textAlign: "center" }}>
            <s-heading size="large" style={{ marginBottom: "8px" }}>Search Product Variants</s-heading>
            <s-text subdued>Enter a search term above to find products by title, variant, tags, or SKU</s-text>
            <s-box marginTop="large">
              <div style={{
                display: "inline-block",
                textAlign: "left",
                backgroundColor: "white",
                padding: "16px",
                borderRadius: "8px",
                border: "1px solid #e5e7eb",
              }}>
                <s-text subdued size="small" style={{ marginBottom: "8px", display: "block", fontWeight: "600" }}>
                  💡 Search Tips:
                </s-text>
                <ul style={{ margin: 0, paddingLeft: "20px", fontSize: "13px", color: "#6b7280" }}>
                  <li>Search by product name (e.g., "Cuban Chain")</li>
                  <li>Search by SKU (e.g., "CC-001")</li>
                  <li>Search by tags (e.g., "gold", "moissanite")</li>
                  <li>Search by variant options (e.g., "16 inch")</li>
                </ul>
              </div>
            </s-box>
          </s-box>
        )}

        {/* Summary Stats */}
        {!isLoading && !data.noSearch && (
          <s-box marginBottom="base" padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
              <div>
                <s-text subdued size="small">Variants Found in Search</s-text>
                <s-heading size="medium">{data.totalVariants || 0}</s-heading>
              </div>
              <div>
                <s-text subdued size="small">Filtered Results</s-text>
                <s-heading size="medium" style={{ color: "#3b82f6" }}>{filteredVariants.length}</s-heading>
              </div>
              <div>
                <s-text subdued size="small">Total Units Sold</s-text>
                <s-heading size="medium" style={{ color: "#10b981" }}>
                  {filteredVariants.reduce((sum, v) => sum + (v.totalSales || 0), 0)}
                </s-heading>
              </div>
              {data.searchQuery && (
                <div>
                  <s-text subdued size="small">Current Search</s-text>
                  <s-heading size="small" style={{ color: "#6b7280" }}>"{data.searchQuery}"</s-heading>
                </div>
              )}
            </div>
          </s-box>
        )}

        {/* Results Table */}
        {!isLoading && !data.noSearch && (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            {filteredVariants.length === 0 ? (
              <s-box padding="large" style={{ textAlign: "center" }}>
                <s-heading size="medium" style={{ marginBottom: "8px" }}>No variants found</s-heading>
                <s-text subdued>No variants found matching "{data.searchQuery}". Try a different search term.</s-text>
              </s-box>
            ) : (
              <>
                <s-box marginBottom="base">
                  <s-text subdued size="small">
                    Showing {filteredVariants.length} {filteredVariants.length === 1 ? "variant" : "variants"}
                    {searchInput && data.searchQuery === searchInput && ` matching "${searchInput}"`}
                    {filterBy !== "all" && ` (filtered by ${filterBy})`}
                    {sortBy !== "none" && ` (sorted by ${sortBy === "sales-high" ? "sales descending" : "sales ascending"})`}
                  </s-text>
                </s-box>

                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", backgroundColor: "white" }}>
                    <thead>
                      <tr style={{ borderBottom: "2px solid #ddd" }}>
                        <th style={{ textAlign: "center", padding: "10px", width: "40px" }}>
                          <input
                            type="checkbox"
                            checked={allSelected}
                            ref={(input) => {
                              if (input) input.indeterminate = someSelected;
                            }}
                            onChange={(e) => toggleSelectAll(e.target.checked)}
                          />
                        </th>
                        <th style={{ textAlign: "left", padding: "10px", minWidth: "60px" }}>Image</th>
                        <th style={{ textAlign: "left", padding: "10px", minWidth: "200px" }}>Product</th>
                        <th style={{ textAlign: "left", padding: "10px", minWidth: "150px" }}>Variant</th>
                        <th style={{ textAlign: "left", padding: "10px", minWidth: "120px" }}>SKU</th>
                        <th style={{ textAlign: "left", padding: "10px", minWidth: "100px" }}>Total Sales</th>
                        <th style={{ textAlign: "left", padding: "10px", minWidth: "80px" }}>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredVariants.map((variant, index) => (
                        <tr key={index} style={{ borderBottom: "1px solid #eee" }}>
                          <td style={{ padding: "10px", textAlign: "center" }} onClick={(e) => e.stopPropagation()}>
                            <input
                              type="checkbox"
                              checked={selectedVariants.has(variant.variantId)}
                              onChange={() => toggleVariantSelection(variant.variantId)}
                            />
                          </td>
                          <td style={{ padding: "10px" }}>
                            {variant.image ? (
                              <img src={variant.image} width="50" height="50" style={{ borderRadius: "4px", objectFit: "cover" }} alt="" />
                            ) : (
                              <div style={{
                                width: "50px",
                                height: "50px",
                                backgroundColor: "#e5e7eb",
                                borderRadius: "4px",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                fontSize: "20px",
                              }}>📦</div>
                            )}
                          </td>
                          <td style={{ padding: "10px", fontSize: "13px", fontWeight: "600" }}>{variant.productTitle}</td>
                          <td style={{ padding: "10px", fontSize: "12px", color: "#6b7280" }}>{variant.variantTitle}</td>
                          <td style={{ padding: "10px", fontFamily: "monospace", fontWeight: "600", fontSize: "12px" }}>{variant.sku}</td>
                          <td style={{ padding: "10px", fontWeight: "700", fontSize: "14px", color: variant.totalSales > 0 ? "#10b981" : "#9ca3af" }}>
                            {variant.totalSales || 0}
                            {variant.totalSales > 0 && <span style={{ fontSize: "11px", marginLeft: "4px" }}>units</span>}
                          </td>
                          
                          <td style={{ padding: "10px" }}>
                            <span style={{
                              backgroundColor: variant.status === "ACTIVE" ? "#d1fae5" : "#fee2e2",
                              color: variant.status === "ACTIVE" ? "#065f46" : "#991b1b",
                              padding: "4px 8px",
                              borderRadius: "4px",
                              fontSize: "10px",
                              fontWeight: "600",
                              textTransform: "uppercase",
                            }}>{variant.status}</span>
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

        {/* Tips */}
        {!isLoading && !data.noSearch && (
          <s-box marginTop="base" style={{ textAlign: "center" }}>
            <s-text subdued size="small">
              💡 Tip: Select variants using checkboxes, then use bulk actions to Clear SKUs, or Delete variants
            </s-text>
          </s-box>
        )}
      </s-section>

      {/* Confirmation Modal */}
      {showModal && selectedVariantInfo && (
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
            if (modalState === "confirm" && e.target === e.currentTarget) {
              handleCancel();
            }
          }}
        >
          <div style={{
            backgroundColor: "white",
            padding: "40px",
            borderRadius: "12px",
            boxShadow: "0 20px 60px rgba(0, 0, 0, 0.3)",
            minWidth: "450px",
            maxWidth: "500px",
          }}>
            {modalState === "confirm" && (
              <>
                <div style={{ textAlign: "center", marginBottom: "24px" }}>
                  <div style={{ fontSize: "48px", marginBottom: "16px" }}>⚠️</div>
                  <s-heading size="large">
                    {modalAction === "reassignVariants"
                      ? "Re-assign SKUs?"
                      : modalAction === "clearVariantSkus"
                      ? "Clear SKU from Variants?"
                      : "Delete selected variants?"}
                  </s-heading>
                </div>

                <div style={{ backgroundColor: "#f9fafb", padding: "16px", borderRadius: "8px", marginBottom: "24px" }}>
                  <s-text>
                    <strong>{selectedVariantInfo.totalVariants} variant{selectedVariantInfo.totalVariants !== 1 ? "s" : ""} selected</strong>
                  </s-text>
                </div>

                <s-box marginBottom="large">
                  {modalAction === "reassignVariants" ? (
                    <s-text subdued>
                      This will assign new SKUs to all selected variants using the pattern <code>IC-{"{variantID}"}</code>.
                    </s-text>
                  ) : modalAction === "clearVariantSkus" ? (
                    <s-text subdued>
                      This will clear the SKU field from all selected variants. The variants will remain, but their SKU will be empty.
                    </s-text>
                  ) : (
                    <s-text subdued>
                      This will permanently delete the selected variants from your store. This cannot be undone.
                    </s-text>
                  )}
                </s-box>

                <div style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}>
                  <button
                    onClick={handleCancel}
                    style={{
                      backgroundColor: "#f3f4f6",
                      color: "#374151",
                      border: "none",
                      padding: "10px 24px",
                      borderRadius: "6px",
                      fontSize: "14px",
                      fontWeight: "500",
                      cursor: "pointer",
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
                    }}
                  >
                    {modalAction === "reassignVariants"
                      ? "Yes, Re-assign SKUs"
                      : modalAction === "clearVariantSkus"
                      ? "Yes, Clear SKUs"
                      : "Yes, Delete Variants"}
                  </button>
                </div>
              </>
            )}

            {modalState === "processing" && (
              <div style={{ textAlign: "center" }}>
                <div style={{
                  display: "inline-block",
                  width: "48px",
                  height: "48px",
                  border: "4px solid #e5e7eb",
                  borderTopColor: "#3b82f6",
                  borderRadius: "50%",
                  animation: "spin 1s linear infinite",
                  marginBottom: "16px",
                }}></div>
                <s-heading size="medium">
                  {modalAction === "reassignVariants"
                    ? "Re-assigning SKUs..."
                    : modalAction === "clearVariantSkus"
                    ? "Clearing SKUs..."
                    : "Deleting Variants..."}
                </s-heading>
                <s-box marginTop="small">
                  <s-text subdued>
                    Processing {selectedVariantInfo?.totalVariants || 0} variant{(selectedVariantInfo?.totalVariants || 0) !== 1 ? "s" : ""}
                  </s-text>
                </s-box>
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </s-page>
  );
}