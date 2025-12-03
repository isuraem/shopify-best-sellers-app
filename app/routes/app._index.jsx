import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import { useState, useEffect } from "react";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // Get parameters from URL
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || null;
  const direction = url.searchParams.get("direction") || "next";
  const selectedCollectionId = url.searchParams.get("collectionId") || null;
  const limit = 50; // Products per page

  const BEST_SELLERS_TITLE = "Best Sellers";

  // First, fetch all collections for the dropdown
  const collectionsResponse = await admin.graphql(
    `#graphql
      query getAllCollections {
        collections(first: 250, sortKey: TITLE) {
          nodes {
            id
            title
            ruleSet {
              appliedDisjunctively
            }
          }
        }
      }
    `
  );

  const collectionsData = await collectionsResponse.json();
  const allCollections = collectionsData.data.collections.nodes || [];

  // Determine which collection to load
  let targetCollectionId = selectedCollectionId;
  
  if (!targetCollectionId) {
    // Try to find "Best Sellers" manual collection first
    const bestSellersManual = allCollections.find(
      c => c.title === BEST_SELLERS_TITLE && !c.ruleSet
    );
    
    if (bestSellersManual) {
      targetCollectionId = bestSellersManual.id;
    } else {
      // Fall back to "Best Sellers" smart collection
      const bestSellersSmart = allCollections.find(
        c => c.title === BEST_SELLERS_TITLE && c.ruleSet
      );
      
      if (bestSellersSmart) {
        targetCollectionId = bestSellersSmart.id;
      } else if (allCollections.length > 0) {
        // If no "Best Sellers" found, use first collection
        targetCollectionId = allCollections[0].id;
      }
    }
  }

  // Build pagination arguments
  const paginationArgs = direction === "next" 
    ? `first: ${limit}${cursor ? `, after: "${cursor}"` : ''}`
    : `last: ${limit}${cursor ? `, before: "${cursor}"` : ''}`;

  // Fetch the selected collection's products
  let collection = null;
  let productCount = 0;
  let pageInfo = null;

  if (targetCollectionId) {
    const response = await admin.graphql(
      `#graphql
        query getCollectionProducts($id: ID!) {
          collection(id: $id) {
            id
            title
            productsCount {
              count
            }
            ruleSet {
              appliedDisjunctively
            }
            products(${paginationArgs}) {
              edges {
                cursor
                node {
                  id
                  title
                  images(first: 1) {
                    nodes {
                      url
                    }
                  }
                }
              }
              pageInfo {
                hasNextPage
                hasPreviousPage
                startCursor
                endCursor
              }
            }
          }
        }
      `,
      { variables: { id: targetCollectionId } }
    );

    const data = await response.json();
    collection = data.data.collection || null;
    productCount = collection?.productsCount?.count || 0;
    pageInfo = collection?.products?.pageInfo || null;
  }

  return { 
    collection, 
    productCount, 
    pageInfo,
    allCollections,
    selectedCollectionId: targetCollectionId
  };
};

export default function Index() {
  const { collection, productCount, pageInfo, allCollections, selectedCollectionId } = useLoaderData();
  const navigate = useNavigate();
  const products = collection?.products?.edges?.map((e) => e.node) || [];

  const [localSelectedCollection, setLocalSelectedCollection] = useState(selectedCollectionId || "");

  useEffect(() => {
    setLocalSelectedCollection(selectedCollectionId || "");
  }, [selectedCollectionId]);

  const handleCollectionChange = (e) => {
    const newCollectionId = e.target.value;
    setLocalSelectedCollection(newCollectionId);
    navigate(`?collectionId=${newCollectionId}`);
  };

  const handleNextPage = () => {
    if (pageInfo?.hasNextPage) {
      navigate(`?collectionId=${selectedCollectionId}&cursor=${pageInfo.endCursor}&direction=next`);
    }
  };

  const handlePreviousPage = () => {
    if (pageInfo?.hasPreviousPage) {
      navigate(`?collectionId=${selectedCollectionId}&cursor=${pageInfo.startCursor}&direction=prev`);
    }
  };

  const getCollectionType = (coll) => {
    return coll.ruleSet ? " (Smart)" : " (Manual)";
  };

  return (
    <s-page heading="Best Sellers Overview">
      {allCollections.length === 0 ? (
        <s-section>
          <s-paragraph>
            No collections found in your store.
          </s-paragraph>
        </s-section>
      ) : (
        <s-section heading="Collection Selector">
          <s-box marginBottom="base">
            <label htmlFor="collection-select" style={{ display: "block", marginBottom: "8px", fontWeight: "600" }}>
              Select Collection:
            </label>
            <select
              id="collection-select"
              value={localSelectedCollection}
              onChange={handleCollectionChange}
              style={{
                width: "100%",
                maxWidth: "400px",
                padding: "10px",
                fontSize: "14px",
                borderRadius: "6px",
                border: "1px solid #ccc",
                cursor: "pointer"
              }}
            >
              {allCollections.map((coll) => (
                <option key={coll.id} value={coll.id}>
                  {coll.title}{getCollectionType(coll)}
                </option>
              ))}
            </select>
          </s-box>

          {!collection ? (
            <s-paragraph>
              No collection data available.
            </s-paragraph>
          ) : (
            <>
              <s-heading>
                Total Products in "{collection.title}": <strong>{productCount}</strong>
              </s-heading>
              <s-button onClick={() => navigate('/app/best-sellers')}>
                View Top 150 Best Sellers
              </s-button>

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
                      <th style={{ textAlign: "left", padding: "8px" }}>Image</th>
                      <th style={{ textAlign: "left", padding: "8px" }}>Product Name</th>
                      <th style={{ textAlign: "left", padding: "8px" }}>Collection</th>
                    </tr>
                  </thead>

                  <tbody>
                    {products.map((p) => (
                      <tr key={p.id}>
                        <td style={{ padding: "8px" }}>
                          {p.images?.nodes?.[0]?.url && (
                            <img
                              src={p.images.nodes[0].url}
                              width="60"
                              style={{ borderRadius: "6px" }}
                              alt={p.title}
                            />
                          )}
                        </td>
                        <td style={{ padding: "8px" }}>{p.title}</td>
                        <td style={{ padding: "8px" }}>{collection.title}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </s-box>

              {/* Pagination Controls */}
              <s-box 
                marginTop="base" 
                display="flex" 
                justifyContent="space-between" 
                alignItems="center"
                padding="base"
              >
                <s-paragraph>
                  Showing {products.length} of {productCount} products
                </s-paragraph>
                
                <s-box display="flex" gap="small">
                  <s-button 
                    onClick={handlePreviousPage}
                    disabled={!pageInfo?.hasPreviousPage}
                    variant="secondary"
                  >
                    Previous
                  </s-button>
                  
                  <s-button 
                    onClick={handleNextPage}
                    disabled={!pageInfo?.hasNextPage}
                    variant="secondary"
                  >
                    Next
                  </s-button>
                </s-box>
              </s-box>
            </>
          )}
        </s-section>
      )}
    </s-page>
  );
}