import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // Get pagination parameters from URL
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor") || null;
  const direction = url.searchParams.get("direction") || "next";
  const limit = 50; // Products per page

  const BEST_SELLERS_TITLE = "Best Sellers";

  // Build pagination arguments
  const paginationArgs = direction === "next" 
    ? `first: ${limit}${cursor ? `, after: "${cursor}"` : ''}`
    : `last: ${limit}${cursor ? `, before: "${cursor}"` : ''}`;

  const response = await admin.graphql(
    `#graphql
      query getCollectionProducts($query: String!) {
        collections(first: 1, query: $query) {
          nodes {
            id
            title
            productsCount {
              count
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
      }
    `,
    { variables: { query: BEST_SELLERS_TITLE } }
  );

  const data = await response.json();
  const collection = data.data.collections.nodes[0] || null;

  const productCount = collection?.productsCount?.count || 0;
  const pageInfo = collection?.products?.pageInfo || null;

  return { 
    collection, 
    productCount, 
    pageInfo
  };
};

export default function Index() {
  const { collection, productCount, pageInfo } = useLoaderData();
  const navigate = useNavigate();
  const products = collection?.products?.edges?.map((e) => e.node) || [];

  const handleNextPage = () => {
    if (pageInfo?.hasNextPage) {
      navigate(`?cursor=${pageInfo.endCursor}&direction=next`);
    }
  };

  const handlePreviousPage = () => {
    if (pageInfo?.hasPreviousPage) {
      navigate(`?cursor=${pageInfo.startCursor}&direction=prev`);
    }
  };

  return (
    <s-page heading="Best Sellers Overview">
      {!collection ? (
        <s-section>
          <s-paragraph>
            No collection named <strong>"Best Sellers"</strong> was found.
          </s-paragraph>
        </s-section>
      ) : (
        <s-section heading={`Collection: ${collection.title}`}>
          <s-heading>
            Total Products in this Collection: <strong>{productCount}</strong>
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
        </s-section>
      )}
    </s-page>
  );
}