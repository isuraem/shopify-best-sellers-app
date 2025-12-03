// ============================================
// FILE: app/routes/app.best-sellers.jsx
// ============================================

import { useState, useEffect } from "react"; 
import { useLoaderData, useFetcher, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  try {
    const { admin } = await authenticate.admin(request);

    console.log("Fetching top-selling products by sold units...");

    // Get date range from URL parameters or use defaults
    const url = new URL(request.url);
    const monthsParam = url.searchParams.get("months");
    const months = monthsParam ? parseInt(monthsParam) : 12; // Default 12 months

    // Define date range based on months parameter
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - months);
    
    const dateQuery = `processed_at:>='${startDate.toISOString().split('T')[0]}'`;
    console.log(`Fetching orders from ${startDate.toISOString().split('T')[0]} to ${endDate.toISOString().split('T')[0]} (${months} months)`);

    let cursor = null;
    let fetchedOrders = 0;
    let hasNextPage = true;

    // Map of productId -> aggregated stats
    const productStats = new Map();

    // REDUCED BATCH SIZE: 100 orders per query to stay under cost limit
    const ORDERS_QUERY = `#graphql
      query getOrdersForTopSellers($cursor: String, $query: String) {
        orders(
          first: 100
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

    // Updated query to include ruleSet to identify smart collections
    const COLLECTIONS_QUERY = `#graphql
      query getCollections {
        collections(first: 250) {
          edges {
            node {
              id
              title
              ruleSet {
                rules {
                  column
                }
              }
            }
          }
        }
      }
    `;

    try {
      // Fetch collections
      console.log("Fetching collections...");
      const collectionsResponse = await admin.graphql(COLLECTIONS_QUERY);
      const collectionsJson = await collectionsResponse.json();
      
      if (collectionsJson.errors) {
        console.error("GraphQL errors fetching collections:", collectionsJson.errors);
        throw new Error("Failed to fetch collections");
      }
      
      // Filter out smart collections (collections with rules)
      const allCollections = collectionsJson.data?.collections?.edges?.map(e => ({
        id: e.node.id,
        title: e.node.title,
        isSmart: e.node.ruleSet && e.node.ruleSet.rules && e.node.ruleSet.rules.length > 0
      })) || [];

      // Only manual collections can have products added
      const manualCollections = allCollections.filter(c => !c.isSmart);

      // Find "Best Sellers" manual collection
      const bestSellersCollection = manualCollections.find(c => 
        c.title.toLowerCase() === "best sellers" || 
        c.title.toLowerCase() === "bestsellers"
      );

      console.log(`Fetched ${allCollections.length} total collections (${manualCollections.length} manual, ${allCollections.length - manualCollections.length} smart)`);

      // Fetch all orders within date range (no MAX_ORDERS limit)
      while (hasNextPage) {
        console.log(`Fetching orders page... (total so far: ${fetchedOrders})`);
        
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
            collections: manualCollections,
            collectionName: null,
            selectedMonths: months,
            bestSellersCollectionId: bestSellersCollection?.id || null,
            error: `GraphQL error: ${json.errors[0].message}`,
          };
        }

        if (!json.data?.orders) {
          console.error("Failed to fetch orders - no data returned", JSON.stringify(json, null, 2));
          return {
            products: [],
            collections: manualCollections,
            collectionName: null,
            selectedMonths: months,
            bestSellersCollectionId: bestSellersCollection?.id || null,
            error: "Failed to fetch orders for analytics. Check app scopes (read_orders / read_all_orders).",
          };
        }

        const orders = json.data.orders.edges;
        fetchedOrders += orders.length;

        console.log(
          `Fetched ${orders.length} orders in this page, total so far: ${fetchedOrders}`
        );

        // Log the date of the last order in this batch for debugging
        if (orders.length > 0) {
          const lastOrderDate = orders[orders.length - 1].node.processedAt;
          console.log(`Last order in this batch: ${lastOrderDate}`);
        }

        for (const orderEdge of orders) {
          const order = orderEdge.node;

          if (!order.lineItems?.edges?.length) continue;

          for (const lineEdge of order.lineItems.edges) {
            const line = lineEdge.node;
            const quantity = line.quantity || 0;

            // Skip zero-qty lines
            if (quantity <= 0) continue;

            const product = line.product;

            // If the product still exists, aggregate by product.id
            if (product) {
              const pid = product.id;

              if (!productStats.has(pid)) {
                productStats.set(pid, {
                  id: pid,
                  title: product.title,
                  totalInventory: product.totalInventory,
                  imageUrl: product.images?.nodes?.[0]?.url || null,
                  collections:
                    product.collections?.edges?.map((e) => e.node.title) || [],
                  soldUnits: 0,
                });
              }

              const entry = productStats.get(pid);
              entry.soldUnits += quantity;
            } else {
              // Product might have been deleted, but we can still track it by line item
              const fallbackId = `line-${line.id}`;

              if (!productStats.has(fallbackId)) {
                productStats.set(fallbackId, {
                  id: fallbackId,
                  title: line.name || line.sku || "Unknown product",
                  totalInventory: null,
                  imageUrl: null,
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

        console.log(`hasNextPage: ${hasNextPage}, cursor: ${cursor ? 'present' : 'null'}`);

        // Add a small delay to avoid hitting rate limits
        if (hasNextPage) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }

      console.log(`FINAL: Fetched ${fetchedOrders} orders total`);

      // Turn the map into a sorted array, desc by soldUnits
      const productsArray = Array.from(productStats.values())
        .filter((p) => p.soldUnits > 0)
        .sort((a, b) => b.soldUnits - a.soldUnits)
        .slice(0, 150)
        .map((p, index) => ({
          ...p,
          rank: index + 1,
        }));

      console.log(
        `Computed ${productsArray.length} products, sorted by sold units from orders`
      );

      let error = null;
      let collectionName = `All orders - Last ${months} months (top sellers by units sold)`;

      if (fetchedOrders === 0) {
        error =
          "No orders were found. Make sure your app has read_orders permission and your store has orders.";
        collectionName = null;
      } else if (productsArray.length === 0) {
        error =
          "Orders were found, but no line items with quantity > 0 could be aggregated. This can happen if all items are non-product line items.";
      }

      return {
        products: productsArray,
        collections: manualCollections,
        collectionName,
        selectedMonths: months,
        bestSellersCollectionId: bestSellersCollection?.id || null,
        error,
      };
    } catch (innerError) {
      console.error("Error in try block while computing top sellers:", innerError);
      console.error("Error stack:", innerError.stack);
      return {
        products: [],
        collections: [],
        collectionName: null,
        selectedMonths: months,
        bestSellersCollectionId: null,
        error: `Error computing top sellers: ${innerError.message}`,
      };
    }
  } catch (outerError) {
    console.error("Error in loader function:", outerError);
    console.error("Error stack:", outerError.stack);
    return {
      products: [],
      collections: [],
      collectionName: null,
      selectedMonths: 12,
      bestSellersCollectionId: null,
      error: `Critical error: ${outerError.message}`,
    };
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const productIds = JSON.parse(formData.get("productIds"));
  const collectionId = formData.get("collectionId");
  const assignmentMode = formData.get("assignmentMode");

  const GET_COLLECTION_QUERY = `#graphql
    query getCollectionProducts($id: ID!) {
      collection(id: $id) {
        id
        title
        products(first: 250) {
          edges {
            node {
              id
            }
          }
        }
      }
    }
  `;

  const ADD_PRODUCTS_MUTATION = `#graphql
    mutation addProductsToCollection($id: ID!, $productIds: [ID!]!) {
      collectionAddProducts(id: $id, productIds: $productIds) {
        collection {
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

  const REMOVE_PRODUCTS_MUTATION = `#graphql
    mutation removeProductsFromCollection($id: ID!, $productIds: [ID!]!) {
      collectionRemoveProducts(id: $id, productIds: $productIds) {
        job {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  try {
    const collectionResponse = await admin.graphql(GET_COLLECTION_QUERY, {
      variables: { id: collectionId },
    });
    const collectionJson = await collectionResponse.json();
    
    const existingProductIds = 
      collectionJson.data?.collection?.products?.edges?.map(e => e.node.id) || [];
    const existingProductIdsSet = new Set(existingProductIds);

    if (assignmentMode === "replace") {
      if (existingProductIds.length > 0) {
        const removeResponse = await admin.graphql(REMOVE_PRODUCTS_MUTATION, {
          variables: {
            id: collectionId,
            productIds: existingProductIds,
          },
        });

        const removeJson = await removeResponse.json();

        if (removeJson.data?.collectionRemoveProducts?.userErrors?.length > 0) {
          return {
            success: false,
            error: removeJson.data.collectionRemoveProducts.userErrors[0].message,
          };
        }
      }

      const response = await admin.graphql(ADD_PRODUCTS_MUTATION, {
        variables: {
          id: collectionId,
          productIds: productIds,
        },
      });

      const json = await response.json();

      if (json.data?.collectionAddProducts?.userErrors?.length > 0) {
        return {
          success: false,
          error: json.data.collectionAddProducts.userErrors[0].message,
        };
      }

      return {
        success: true,
        message: `Successfully replaced collection with ${productIds.length} product(s) (removed ${existingProductIds.length} existing)`,
      };
    } else {
      const productsToAdd = productIds.filter(id => !existingProductIdsSet.has(id));
      
      const skippedCount = productIds.length - productsToAdd.length;

      if (productsToAdd.length === 0) {
        return {
          success: true,
          message: `All ${productIds.length} product(s) are already in this collection`,
        };
      }

      const response = await admin.graphql(ADD_PRODUCTS_MUTATION, {
        variables: {
          id: collectionId,
          productIds: productsToAdd,
        },
      });

      const json = await response.json();

      if (json.data?.collectionAddProducts?.userErrors?.length > 0) {
        return {
          success: false,
          error: json.data.collectionAddProducts.userErrors[0].message,
        };
      }

      let message = `Successfully added ${productsToAdd.length} product(s) to collection`;
      if (skippedCount > 0) {
        message += ` (${skippedCount} already in collection)`;
      }

      return {
        success: true,
        message,
      };
    }
  } catch (e) {
    console.error("Error adding products to collection", e);
    return {
      success: false,
      error: "Failed to add products to collection",
    };
  }
};

export default function BestSellers() {
  const { products, collections, collectionName, selectedMonths, bestSellersCollectionId, error } = useLoaderData();
  const fetcher = useFetcher();
  const navigation = useNavigation();
  
  const [selectedProducts, setSelectedProducts] = useState(new Set());
  const [showModal, setShowModal] = useState(false);
  const [selectedCollection, setSelectedCollection] = useState(bestSellersCollectionId || "");
  const [assignmentMode, setAssignmentMode] = useState("add");
  const [months, setMonths] = useState(selectedMonths || 12);

  const isLoading = navigation.state === "loading";

  // Update selected collection when bestSellersCollectionId changes
  useEffect(() => {
    if (bestSellersCollectionId && !selectedCollection) {
      setSelectedCollection(bestSellersCollectionId);
    }
  }, [bestSellersCollectionId, selectedCollection]);

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

  const handleAssignCollection = () => {
    if (!selectedCollection) {
      alert("Please select a collection");
      return;
    }

    const productIdsArray = Array.from(selectedProducts).filter(id => !id.startsWith('line-'));

    fetcher.submit(
      {
        productIds: JSON.stringify(productIdsArray),
        collectionId: selectedCollection,
        assignmentMode: assignmentMode,
      },
      { method: "post" }
    );
  };

  const handleMonthsChange = (e) => {
    const newMonths = e.target.value;
    setMonths(newMonths);
    // Navigate to same route with new months parameter
    window.location.href = `/app/best-sellers?months=${newMonths}`;
  };

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && showModal) {
      if (fetcher.data.success || fetcher.data.error) {
        const timer = setTimeout(() => {
          setShowModal(false);
          setSelectedProducts(new Set());
          setSelectedCollection(bestSellersCollectionId || "");
          setAssignmentMode("add");
        }, 2000);
        
        return () => clearTimeout(timer);
      }
    }
  }, [fetcher.state, fetcher.data, showModal, bestSellersCollectionId]);

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

        {/* Warning if no manual "Best Sellers" collection found */}
        {!bestSellersCollectionId && collections.length > 0 && (
          <s-box marginBottom="base">
            <s-text tone="warning">
              No manual "Best Sellers" collection found. Smart/automated collections can't have products manually added. 
              Please create a manual collection named "Best Sellers" or select a different manual collection.
            </s-text>
          </s-box>
        )}

        {/* Date Range Selector */}
        <s-box marginBottom="base">
          <label style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <s-text><strong>Date Range:</strong></s-text>
            <select
              value={months}
              onChange={handleMonthsChange}
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
              <option value="1">Last 1 month</option>
              <option value="3">Last 3 months</option>
              <option value="6">Last 6 months</option>
              <option value="12">Last 12 months</option>
              <option value="24">Last 24 months</option>
              <option value="36">Last 36 months</option>
            </select>
            {isLoading && (
              <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <s-spinner size="small" />
                <s-text subdued>Loading products...</s-text>
              </span>
            )}
          </label>
        </s-box>

        {/* Loading State */}
        {isLoading && (
          <s-box padding="large" style={{ textAlign: "center" }}>
            <s-spinner size="large" />
            <s-box marginTop="base">
              <s-heading size="small">Loading Products...</s-heading>
              <s-text subdued>Fetching order data from the last {months} months. This may take a minute.</s-text>
            </s-box>
          </s-box>
        )}

        {/* Content (hidden when loading) */}
        {!isLoading && (
          <>
            <s-box marginBottom="base" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <s-heading>
                  Showing Top <strong>{products.length}</strong> Products by Units Sold
                </s-heading>
                <s-text subdued>
                  Source: {collectionName || "N/A"} (ranked by total units sold from recent orders)
                </s-text>
              </div>
              
              {selectedProducts.size > 0 && (
                <s-button onClick={handleMoveToClick}>
                  Move to ({selectedProducts.size})
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
                      Collections
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
                        {product.collections?.length
                          ? product.collections.join(", ")
                          : "No collection"}
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
            <s-heading>Assign to Collection</s-heading>
            
            <s-box marginTop="base" marginBottom="base">
              <s-text>
                <strong>{selectedProducts.size}</strong> product(s) selected
              </s-text>
            </s-box>

            <s-box marginTop="base" marginBottom="base">
              <label style={{ display: "block", marginBottom: "8px" }}>
                <s-text>Select Collection (Manual Collections Only):</s-text>
              </label>
              <select
                value={selectedCollection}
                onChange={(e) => setSelectedCollection(e.target.value)}
                style={{
                  width: "100%",
                  padding: "8px",
                  borderRadius: "4px",
                  border: "1px solid #ccc",
                }}
              >
                <option value="">-- Choose a collection --</option>
                {collections.map((collection) => (
                  <option key={collection.id} value={collection.id}>
                    {collection.title}
                  </option>
                ))}
              </select>
              {collections.length === 0 && (
                <s-box marginTop="small">
                  <s-text tone="critical" size="small">
                    No manual collections available. Smart collections cannot have products manually added.
                  </s-text>
                </s-box>
              )}
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
                      Add these products to Collection
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
                      Replace all product in Collection
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
                onClick={handleAssignCollection}
                disabled={!selectedCollection || fetcher.state === "submitting" || collections.length === 0}
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