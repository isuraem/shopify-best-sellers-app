// app/routes/webhooks.products.create.jsx
import { authenticate, unauthenticated } from "../shopify.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    const { admin } = await unauthenticated.admin(shop);
    const productGID = `gid://shopify/Product/${payload.id}`;

    // Fetch actual media instead of using payload
    const response = await admin.graphql(`
    query getProductMedia($id: ID!) {
        product(id: $id) {
        media(first: 250) {
            nodes { id }
        }
        }
    }
    `, { variables: { id: productGID } });

    const data = await response.json();
    const mediaGIDs = data.data.product.media.nodes.map(n => n.id);

    await admin.graphql(`
      mutation setMediaSnapshot($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `, {
      variables: {
        metafields: [{
          ownerId: productGID,
          namespace: "app_ic",
          key: "media_snapshot",
          type: "json",
          value: JSON.stringify(mediaGIDs)
        }]
      }
    });

    console.log(`[products/create] Snapshot initialized for product ${payload.id}`);
  } catch (err) {
    console.error(`[products/create] Error for shop ${shop}:`, err);
  }

  return new Response();
};