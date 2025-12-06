// ============================================
// FILE: app/routes/app.best-sellers.jsx
// ============================================

import { useState, useEffect } from "react"; 
import { useLoaderData, useFetcher, useNavigation, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);

    console.log("Fetching top-selling products by sold units...");

    // Get date range from URL parameters or use defaults
    const url = new URL(request.url);
    const monthsParam = url.searchParams.get("months");
    const weeksParam = url.searchParams.get("weeks");
    
    let months = 0;
    let weeks = 0;
    let dateRangeLabel = "";
    
    if (weeksParam) {
      weeks = parseInt(weeksParam);
      dateRangeLabel = `${weeks} week${weeks > 1 ? 's' : ''}`;
    } else if (monthsParam) {
      months = parseInt(monthsParam);
      dateRangeLabel = `${months} month${months > 1 ? 's' : ''}`;
    } else {
      weeks = 1;
      dateRangeLabel = "1 week";
    }

    // Define date range
    const endDate = new Date();
    const startDate = new Date();
    
    if (weeks > 0) {
      startDate.setDate(startDate.getDate() - (weeks * 7));
    } else if (months > 0) {
      startDate.setMonth(startDate.getMonth() - months);
    }
    
    const dateQuery = `processed_at:>='${startDate.toISOString().split('T')[0]}'`;
    console.log(`Fetching orders from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]} (${dateRangeLabel})`);

    let cursor = null;
    let fetchedOrders = 0;
    let hasNextPage = true;

    const productStats = new Map();

    const ORDERS_QUERY = `#graphql
      query getOrdersForTopSellers($cursor: String, $query: String) {
        orders(
          first: 250
          after: $cursor
          sortKey: PROCESSED_AT
          reverse: true
          query: $query
        ) {
          pageInfo {
            hasNextPage
            endCursor
          }
          edges {
            node {
              id
              name
              processedAt
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    quantity
                    name
                    sku
                    product {
                      id
                      title
                      totalInventory
                      tags
                      images(first: 1) {
                        nodes {
                          url
                        }
                      }
                      collections(first: 3) {
                        edges {
                          node {
                            title
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
      }
    `;

    try {
      // Fetch all orders within date range
      while (hasNextPage) {
        console.log(`📦 Fetching orders page... (total so far: ${fetchedOrders})`);
        
        const response = await admin.graphql(ORDERS_QUERY, {
          variables: { 
            cursor,
            query: dateQuery
          },
        });

        const json = await response.json();

        if (json.errors) {
          console.error("GraphQL errors:", json.errors);
          return {
            products: [],
            collectionName: null,
            selectedRange: { weeks, months },
            dateRangeLabel,
            totalOrdersProcessed: 0,
            error: `GraphQL error: ${json.errors[0].message}`,
          };
        }

        if (!json.data?.orders) {
          console.error("Failed to fetch orders - no data returned");
          return {
            products: [],
            collectionName: null,
            selectedRange: { weeks, months },
            dateRangeLabel,
            totalOrdersProcessed: 0,
            error: "Failed to fetch orders for analytics. Check app scopes (read_orders / read_all_orders).",
          };
        }

        const orders = json.data.orders.edges;
        fetchedOrders += orders.length;

        console.log(`✅ Fetched ${orders.length} orders in this page, total so far: ${fetchedOrders}`);

        if (orders.length > 0) {
          const lastOrderDate = orders[orders.length - 1].node.processedAt;
          console.log(`📅 Last order in this batch: ${lastOrderDate}`);
        }

        for (const orderEdge of orders) {
          const order = orderEdge.node;

          if (!order.lineItems?.edges?.length) continue;

          for (const lineEdge of order.lineItems.edges) {
            const line = lineEdge.node;
            const quantity = line.quantity || 0;

            if (quantity <= 0) continue;

            const product = line.product;

            if (product) {
              const pid = product.id;

              if (!productStats.has(pid)) {
                productStats.set(pid, {
                  id: pid,
                  title: product.title,
                  totalInventory: product.totalInventory,
                  imageUrl: product.images?.nodes?.[0]?.url || null,
                  tags: product.tags || [],
                  collections:
                    product.collections?.edges?.map((e) => e.node.title) || [],
                  soldUnits: 0,
                });
              }

              const entry = productStats.get(pid);
              entry.soldUnits += quantity;
            } else {
              const fallbackId = `line-${line.id}`;

              if (!productStats.has(fallbackId)) {
                productStats.set(fallbackId, {
                  id: fallbackId,
                  title: line.name || line.sku || "Unknown product",
                  totalInventory: null,
                  imageUrl: null,
                  tags: [],
                  collections: [],
                  soldUnits: 0,
                });
              }

              const entry = productStats.get(fallbackId);
              entry.soldUnits += quantity;
            }
          }
        }

        hasNextPage = json.data.orders.pageInfo.hasNextPage;
        cursor = json.data.orders.pageInfo.endCursor || null;

        console.log(`🔄 hasNextPage: ${hasNextPage}, cursor: ${cursor ? 'present' : 'null'}`);

        if (hasNextPage) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }

      console.log(`🎉 FINAL: Fetched ${fetchedOrders} orders total`);

      const productsArray = Array.from(productStats.values())
        .filter((p) => p.soldUnits > 0)
        .sort((a, b) => b.soldUnits - a.soldUnits)
        .slice(0, 150)
        .map((p, index) => ({
          ...p,
          rank: index + 1,
        }));

      console.log(`✨ Computed ${productsArray.length} products, sorted by sold units from orders`);

      let error = null;
      let collectionName = `All orders - Last ${dateRangeLabel} (top sellers by units sold)`;

      if (fetchedOrders === 0) {
        error = "No orders were found. Make sure your app has read_orders permission and your store has orders.";
        collectionName = null;
      } else if (productsArray.length === 0) {
        error = "Orders were found, but no line items with quantity > 0 could be aggregated.";
      }

      return {
        products: productsArray,
        collectionName,
        selectedRange: { weeks, months },
        dateRangeLabel,
        totalOrdersProcessed: fetchedOrders,
        error,
      };
    } catch (innerError) {
      console.error("Error in try block while computing top sellers:", innerError);
      console.error("Error stack:", innerError.stack);
      return {
        products: [],
        collectionName: null,
        selectedRange: { weeks: 1, months: 0 },
        dateRangeLabel: "1 week",
        totalOrdersProcessed: 0,
        error: `Error computing top sellers: ${innerError.message}`,
      };
    }
  } catch (outerError) {
    console.error("Error in loader function:", outerError);
    console.error("Error stack:", outerError.stack);
    return {
      products: [],
      collectionName: null,
      selectedRange: { weeks: 1, months: 0 },
      dateRangeLabel: "1 week",
      totalOrdersProcessed: 0,
      error: `Critical error: ${outerError.message}`,
    };
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productIds = JSON.parse(formData.get("productIds"));
  const tagToAdd = formData.get("tagToAdd");
  const assignmentMode = formData.get("assignmentMode");

  if (!tagToAdd || tagToAdd.trim() === "") {
    return {
      success: false,
      error: "Tag name is required",
    };
  }

  const GET_PRODUCTS_WITH_TAG_QUERY = `#graphql
    query getProductsWithTag($query: String!) {
      products(first: 250, query: $query) {
        edges {
          node {
            id
            tags
          }
        }
      }
    }
  `;

  const UPDATE_PRODUCT_TAGS_MUTATION = `#graphql
    mutation productUpdate($input: ProductInput!) {
      productUpdate(input: $input) {
        product {
          id
          tags
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    let addedCount = 0;
    let skippedCount = 0;
    let removedCount = 0;

    if (assignmentMode === "replace") {
      // Step 1: Get all products that currently have this tag
      const currentTaggedResponse = await admin.graphql(GET_PRODUCTS_WITH_TAG_QUERY, {
        variables: { query: `tag:${tagToAdd}` },
      });
      const currentTaggedJson = await currentTaggedResponse.json();
      
      const currentTaggedProducts = currentTaggedJson.data?.products?.edges?.map(e => ({
        id: e.node.id,
        tags: e.node.tags
      })) || [];

      // Step 2: Remove tag from all current products
      for (const product of currentTaggedProducts) {
        const updatedTags = product.tags.filter(tag => tag !== tagToAdd);
        
        const removeResponse = await admin.graphql(UPDATE_PRODUCT_TAGS_MUTATION, {
          variables: {
            input: {
              id: product.id,
              tags: updatedTags,
            },
          },
        });

        const removeJson = await removeResponse.json();

        if (removeJson.data?.productUpdate?.userErrors?.length > 0) {
          console.error(`Error removing tag from ${product.id}:`, removeJson.data.productUpdate.userErrors);
        } else {
          removedCount++;
        }

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Step 3: Add tag to selected products
      for (const productId of productIds) {
        // Get current tags
        const getProductResponse = await admin.graphql(`#graphql
          query getProduct($id: ID!) {
            product(id: $id) {
              id
              tags
            }
          }
        `, {
          variables: { id: productId },
        });

        const productJson = await getProductResponse.json();
        const currentTags = productJson.data?.product?.tags || [];

        // Skip if tag already exists
        if (currentTags.includes(tagToAdd)) {
          skippedCount++;
          continue;
        }

        // Add new tag
        const updatedTags = [...currentTags, tagToAdd];

        const updateResponse = await admin.graphql(UPDATE_PRODUCT_TAGS_MUTATION, {
          variables: {
            input: {
              id: productId,
              tags: updatedTags,
            },
          },
        });

        const updateJson = await updateResponse.json();

        if (updateJson.data?.productUpdate?.userErrors?.length > 0) {
          console.error(`Error adding tag to ${productId}:`, updateJson.data.productUpdate.userErrors);
        } else {
          addedCount++;
        }

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      return {
        success: true,
        message: `Successfully replaced tag "${tagToAdd}": removed from ${removedCount} product(s), added to ${addedCount} product(s)${skippedCount > 0 ? `, skipped ${skippedCount} (already tagged)` : ''}`,
      };

    } else {
      // "add" mode - just add tags to selected products
      for (const productId of productIds) {
        // Get current tags
        const getProductResponse = await admin.graphql(`#graphql
          query getProduct($id: ID!) {
            product(id: $id) {
              id
              tags
            }
          }
        `, {
          variables: { id: productId },
        });

        const productJson = await getProductResponse.json();
        const currentTags = productJson.data?.product?.tags || [];

        // Skip if tag already exists
        if (currentTags.includes(tagToAdd)) {
          skippedCount++;
          continue;
        }

        // Add new tag
        const updatedTags = [...currentTags, tagToAdd];

        const updateResponse = await admin.graphql(UPDATE_PRODUCT_TAGS_MUTATION, {
          variables: {
            input: {
              id: productId,
              tags: updatedTags,
            },
          },
        });

        const updateJson = await updateResponse.json();

        if (updateJson.data?.productUpdate?.userErrors?.length > 0) {
          console.error(`Error adding tag to ${productId}:`, updateJson.data.productUpdate.userErrors);
        } else {
          addedCount++;
        }

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      let message = `Successfully added tag "${tagToAdd}" to ${addedCount} product(s)`;
      if (skippedCount > 0) {
        message += ` (${skippedCount} already had this tag)`;
      }

      return {
        success: true,
        message,
      };
    }
  } catch (e) {
    console.error("Error managing product tags", e);
    return {
      success: false,
      error: "Failed to manage product tags",
    };
  }
};

export default function BestSellers() {
  const { products, collectionName, selectedRange, dateRangeLabel, totalOrdersProcessed, error } = useLoaderData();
  const fetcher = useFetcher();
  const navigation = useNavigation();
  const navigate = useNavigate();
  
  const [selectedProducts, setSelectedProducts] = useState(new Set());
  const [showModal, setShowModal] = useState(false);
  const [tagToAdd, setTagToAdd] = useState("best-seller");
  const [assignmentMode, setAssignmentMode] = useState("add");
  const [rangeValue, setRangeValue] = useState(
    selectedRange?.weeks ? `weeks-${selectedRange.weeks}` : `months-${selectedRange?.months || 1}`
  );

  const isLoading = navigation.state === "loading";

  const handleSelectAll = () => {
    if (selectedProducts.size === products.length) {
      setSelectedProducts(new Set());
    } else {
      setSelectedProducts(new Set(products.map(p => p.id)));
    }
  };

  const handleSelectProduct = (productId) => {
    const newSelected = new Set(selectedProducts);
    if (newSelected.has(productId)) {
      newSelected.delete(productId);
    } else {
      newSelected.add(productId);
    }
    setSelectedProducts(newSelected);
  };

  const handleMoveToClick = () => {
    setShowModal(true);
  };

  const handleAssignTags = () => {
    if (!tagToAdd || tagToAdd.trim() === "") {
      alert("Please enter a tag name");
      return;
    }

    const productIdsArray = Array.from(selectedProducts).filter(id => !id.startsWith('line-'));

    fetcher.submit(
      {
        productIds: JSON.stringify(productIdsArray),
        tagToAdd: tagToAdd.trim(),
        assignmentMode: assignmentMode,
      },
      { method: "post" }
    );
  };

  const handleRangeChange = (e) => {
    const value = e.target.value;
    setRangeValue(value);
    
    const [type, amount] = value.split('-');
    
    if (type === 'weeks') {
      navigate(`/app/best-sellers?weeks=${amount}`);
    } else {
      navigate(`/app/best-sellers?months=${amount}`);
    }
  };

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && showModal) {
      if (fetcher.data.success || fetcher.data.error) {
        const timer = setTimeout(() => {
          setShowModal(false);
          setSelectedProducts(new Set());
          setTagToAdd("best-seller");
          setAssignmentMode("add");
        }, 3000);
        
        return () => clearTimeout(timer);
      }
    }
  }, [fetcher.state, fetcher.data, showModal]);

  const allSelected = products.length > 0 && selectedProducts.size === products.length;

  return (
    <s-page heading="Top 150 Best Sellers">
      <s-section>
        {error && (
          <s-box marginBottom="base">
            <s-text tone="critical">{error}</s-text>
          </s-box>
        )}

        {fetcher.data?.success && (
          <s-box marginBottom="base">
            <s-text tone="success">{fetcher.data.message}</s-text>
          </s-box>
        )}

        {fetcher.data?.error && (
          <s-box marginBottom="base">
            <s-text tone="critical">{fetcher.data.error}</s-text>
          </s-box>
        )}

        {/* Date Range Selector */}
        <s-box marginBottom="base" style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <s-text><strong>Date Range:</strong></s-text>
            <select
              value={rangeValue}
              onChange={handleRangeChange}
              disabled={isLoading}
              style={{
                padding: "8px 12px",
                borderRadius: "4px",
                border: "1px solid #ccc",
                fontSize: "14px",
                cursor: isLoading ? "not-allowed" : "pointer",
                opacity: isLoading ? 0.6 : 1,
              }}
            >
              <option value="weeks-1">Last 1 week ⚡ (Fastest)</option>
              <option value="months-1">Last 1 month</option>
              <option value="months-3">Last 3 months</option>
              <option value="months-6">Last 6 months</option>
              <option value="months-12">Last 12 months</option>
            </select>
          </label>
          {isLoading && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <s-spinner size="small" />
              <s-text subdued><strong>Loading products...</strong> This may take 1-2 minutes for large stores.</s-text>
            </div>
          )}
        </s-box>

        {/* Loading State */}
        {isLoading ? (
          <s-box padding="extraLarge" style={{ textAlign: "center", backgroundColor: "#f9fafb", borderRadius: "8px" }}>
            <s-spinner size="large" />
            <s-box marginTop="base">
              <s-heading size="medium">Loading Products...</s-heading>
              <s-box marginTop="small">
                <s-text subdued>
                  Analyzing order data from the last {dateRangeLabel} to rank your best sellers.
                </s-text>
              </s-box>
              <s-box marginTop="small">
                <s-text subdued size="small">
                  ⏳ This process may take 1-3 minutes depending on your order volume.
                </s-text>
              </s-box>
            </s-box>
          </s-box>
        ) : (
          <>
            {/* Content */}
            <s-box marginBottom="base" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <s-heading>
                  Showing Top <strong>{products.length}</strong> Products by Units Sold
                </s-heading>
                <s-text subdued>
                  {collectionName || "N/A"} • Analyzed {totalOrdersProcessed || 0} orders
                </s-text>
              </div>
              
              {selectedProducts.size > 0 && (
                <s-button onClick={handleMoveToClick}>
                  Assign Tags ({selectedProducts.size})
                </s-button>
              )}
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
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px" }}>
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={handleSelectAll}
                        style={{ cursor: "pointer" }}
                      />
                    </th>
                    <th style={{ textAlign: "left", padding: "8px" }}>Rank</th>
                    <th style={{ textAlign: "left", padding: "8px" }}>Image</th>
                    <th style={{ textAlign: "left", padding: "8px" }}>
                      Product Name
                    </th>
                    <th style={{ textAlign: "left", padding: "8px" }}>
                      Current Tags
                    </th>
                    <th style={{ textAlign: "left", padding: "8px" }}>
                      Sold Units
                    </th>
                    <th style={{ textAlign: "left", padding: "8px" }}>
                      Inventory
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {products.map((product) => (
                    <tr key={product.id}>
                      <td style={{ padding: "8px" }}>
                        <input
                          type="checkbox"
                          checked={selectedProducts.has(product.id)}
                          onChange={() => handleSelectProduct(product.id)}
                          style={{ cursor: "pointer" }}
                        />
                      </td>
                      <td style={{ padding: "8px", fontWeight: "bold" }}>
                        #{product.rank}
                      </td>
                      <td style={{ padding: "8px" }}>
                        {product.imageUrl && (
                          <img
                            src={product.imageUrl}
                            width="60"
                            style={{ borderRadius: "6px" }}
                            alt={product.title}
                          />
                        )}
                      </td>
                      <td style={{ padding: "8px" }}>{product.title}</td>
                      <td style={{ padding: "8px" }}>
                        {product.tags?.length
                          ? product.tags.join(", ")
                          : "No tags"}
                      </td>
                      <td style={{ padding: "8px" }}>{product.soldUnits}</td>
                      <td style={{ padding: "8px" }}>
                        {product.totalInventory ?? 0}
                      </td>
                    </tr>
                  ))}

                  {products.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        style={{ padding: "16px", textAlign: "center" }}
                      >
                        No sold products to display yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </s-box>
          </>
        )}
      </s-section>

      {/* Modal */}
      {showModal && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 1000,
          }}
          onClick={() => setShowModal(false)}
        >
          <div
            style={{
              backgroundColor: "white",
              borderRadius: "8px",
              padding: "24px",
              minWidth: "400px",
              maxWidth: "500px",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <s-heading>Assign Tag to Products</s-heading>
            
            <s-box marginTop="base" marginBottom="base">
              <s-text>
                <strong>{selectedProducts.size}</strong> product(s) selected
              </s-text>
            </s-box>

            <s-box marginTop="base" marginBottom="base">
              <label style={{ display: "block", marginBottom: "8px" }}>
                <s-text>Tag Name:</s-text>
              </label>
              <input
                type="text"
                value={tagToAdd}
                onChange={(e) => setTagToAdd(e.target.value)}
                placeholder="e.g., best-seller, featured, trending"
                style={{
                  width: "100%",
                  padding: "8px",
                  borderRadius: "4px",
                  border: "1px solid #ccc",
                  fontSize: "14px",
                }}
              />
              <s-box marginTop="small">
                <s-text subdued size="small">
                  This tag will be used in your condition-based collections
                </s-text>
              </s-box>
            </s-box>

            <s-box marginTop="base" marginBottom="base">
              <label style={{ display: "block", marginBottom: "12px" }}>
                <s-text><strong>Assignment Mode:</strong></s-text>
              </label>
              
              <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <label style={{ display: "flex", alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="assignmentMode"
                    value="add"
                    checked={assignmentMode === "add"}
                    onChange={(e) => setAssignmentMode(e.target.value)}
                    style={{ marginRight: "8px", cursor: "pointer" }}
                  />
                  <div>
                    <s-text><strong>Add to existing</strong></s-text>
                    <br />
                    <s-text subdued style={{ fontSize: "13px" }}>
                      Keep current tags and add new tag to selected products (skip if already tagged)
                    </s-text>
                  </div>
                </label>

                <label style={{ display: "flex", alignItems: "center", cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="assignmentMode"
                    value="replace"
                    checked={assignmentMode === "replace"}
                    onChange={(e) => setAssignmentMode(e.target.value)}
                    style={{ marginRight: "8px", cursor: "pointer" }}
                  />
                  <div>
                    <s-text><strong>Replace all</strong></s-text>
                    <br />
                    <s-text subdued style={{ fontSize: "13px" }}>
                      Remove tag from ALL products, then add to selected products only (skip if already tagged)
                    </s-text>
                  </div>
                </label>
              </div>
            </s-box>

            <s-box
              marginTop="large"
              style={{ display: "flex", gap: "12px", justifyContent: "flex-end" }}
            >
              <s-button onClick={() => setShowModal(false)}>
                Cancel
              </s-button>
              <s-button
                primary
                onClick={handleAssignTags}
                disabled={!tagToAdd.trim() || fetcher.state === "submitting"}
              >
                {fetcher.state === "submitting" ? "Assigning..." : "Continue"}
              </s-button>
            </s-box>
          </div>
        </div>
      )}
    </s-page>
  );
}