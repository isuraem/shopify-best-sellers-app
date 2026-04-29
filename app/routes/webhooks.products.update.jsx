import { authenticate, unauthenticated } from "../shopify.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  try {
    await syncColorImageSets({ shop, product: payload });
  } catch (err) {
    console.error(`[products/update] Error for shop ${shop}:`, err);
  }

  return new Response();
};

async function syncColorImageSets({ shop, product }) {
  const { admin } = await unauthenticated.admin(shop);
  const productGID = `gid://shopify/Product/${product.id}`;

  // 1. Get current product media GIDs + previously stored snapshot + color_image_sets
  const response = await admin.graphql(`
    query getProductData($id: ID!) {
      product(id: $id) {
        media(first: 250) {
          nodes {
            id
          }
        }
        colorImageSets: metafield(namespace: "custom", key: "color_image_sets") {
          id
          value
        }
        mediaSnapshot: metafield(namespace: "app_ic", key: "media_snapshot") {
          id
          value
        }
      }
    }
  `, { variables: { id: productGID } });

  const data = await response.json();
  const productData = data.data.product;

  const currentMediaGIDs = new Set(
    productData.media.nodes.map(n => n.id)
  );

  // 2. Figure out which GIDs were deleted by diffing against snapshot
  let deletedMediaGIDs = new Set();
  const snapshotField = productData.mediaSnapshot;

  if (snapshotField?.value) {
    try {
      const previousGIDs = JSON.parse(snapshotField.value);
      deletedMediaGIDs = new Set(
        previousGIDs.filter(gid => !currentMediaGIDs.has(gid))
      );
    } catch {
      console.error(`[syncColorImageSets] Failed to parse media snapshot`);
    }
  }

  // 3. Update snapshot to current state
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
        value: JSON.stringify([...currentMediaGIDs])
      }]
    }
  });

  // 4. If nothing was deleted, stop here
  if (deletedMediaGIDs.size === 0) {
    console.log(`[syncColorImageSets] No media deletions detected for product ${product.id}`);
    return;
  }

  console.log(`[syncColorImageSets] Detected ${deletedMediaGIDs.size} deleted media GID(s):`, [...deletedMediaGIDs]);

  // 5. Get color_image_sets metaobject GIDs
  const metafield = productData.colorImageSets;
  if (!metafield) {
    console.log(`[syncColorImageSets] No color_image_sets found for product ${product.id}`);
    return;
  }

  let metaobjectGIDs;
  try {
    metaobjectGIDs = JSON.parse(metafield.value);
  } catch {
    console.error(`[syncColorImageSets] Failed to parse metafield value`);
    return;
  }

  if (!metaobjectGIDs?.length) return;

  // 6. Clean deleted images from each metaobject
  for (const metaobjectGID of metaobjectGIDs) {
    await cleanMetaobjectImages({ admin, metaobjectGID, deletedMediaGIDs });
  }
}

async function cleanMetaobjectImages({ admin, metaobjectGID, deletedMediaGIDs }) {
  const metaobjectResponse = await admin.graphql(`
    query getMetaobject($id: ID!) {
      metaobject(id: $id) {
        id
        fields {
          key
          value
        }
      }
    }
  `, { variables: { id: metaobjectGID } });

  const metaobjectData = await metaobjectResponse.json();
  const metaobject = metaobjectData.data.metaobject;
  if (!metaobject) return;

  const imagesField = metaobject.fields.find(f => f.key === "images");
  if (!imagesField?.value) return;

  let imageGIDs;
  try {
    imageGIDs = JSON.parse(imagesField.value);
  } catch {
    return;
  }

  if (!Array.isArray(imageGIDs) || !imageGIDs.length) return;

  // Only remove GIDs that were explicitly deleted from product.media
  const validImageGIDs = imageGIDs.filter(gid => !deletedMediaGIDs.has(gid));

  // Nothing to remove
  if (validImageGIDs.length === imageGIDs.length) return;

  console.log(
    `[cleanMetaobjectImages] ${metaobjectGID}: removing ${imageGIDs.length - validImageGIDs.length} deleted image(s)`
  );

  const updateResponse = await admin.graphql(`
    mutation updateMetaobject($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject { id }
        userErrors { field message }
      }
    }
  `, {
    variables: {
      id: metaobjectGID,
      metaobject: {
        fields: [{ key: "images", value: JSON.stringify(validImageGIDs) }]
      }
    }
  });

  const updateData = await updateResponse.json();
  if (updateData.data.metaobjectUpdate.userErrors?.length) {
    console.error(`[cleanMetaobjectImages] userErrors:`, updateData.data.metaobjectUpdate.userErrors);
  }
}