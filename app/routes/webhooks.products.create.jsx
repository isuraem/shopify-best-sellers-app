// app/routes/webhooks.products.create.jsx
import { authenticate, unauthenticated } from "../shopify.server";
import db from "../db.server";

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

    // Auto-assign SKU and stock for variants missing them
    if (payload.variants?.length) {
      await assignSkuAndStock({ admin, shop, productId: payload.id, variants: payload.variants });
    }
  } catch (err) {
    console.error(`[products/create] Error for shop ${shop}:`, err);
  }

  return new Response();
};

async function assignSkuAndStock({ admin, shop, productId, variants }) {
  const locationRes = await admin.graphql(`
    query getWarehouseLocation {
      locations(first: 50, query: "name:Warehouse") {
        nodes { id name }
      }
    }
  `);
  const locationData = await locationRes.json();
  const warehouseLocation = locationData.data.locations.nodes.find(
    (loc) => loc.name === "Warehouse"
  );

  if (!warehouseLocation) {
    console.warn(`[assignSkuAndStock] No location named "Warehouse" found — skipping stock assignment`);
  }

  for (const variant of variants) {
    const inventoryItemGID = `gid://shopify/InventoryItem/${variant.inventory_item_id}`;
    let skuAssigned = false;
    let stockAdded = false;

    if (!variant.sku) {
      const skuRes = await admin.graphql(`
        mutation updateSku($id: ID!, $input: InventoryItemInput!) {
          inventoryItemUpdate(id: $id, input: $input) {
            inventoryItem { id sku }
            userErrors { field message }
          }
        }
      `, {
        variables: { id: inventoryItemGID, input: { sku: `IC-${variant.id}` } }
      });

      const skuErrors = (await skuRes.json()).data.inventoryItemUpdate.userErrors;
      if (skuErrors?.length) {
        console.error(`[assignSkuAndStock] SKU errors for variant ${variant.id}:`, skuErrors);
      } else {
        skuAssigned = true;
        console.log(`[assignSkuAndStock] Assigned SKU IC-${variant.id} to variant ${variant.id}`);
      }
    }

    if (warehouseLocation) {
      // Query Warehouse-specific level — total stock across locations can be > 0 while Warehouse is 0
      const levelRes = await admin.graphql(`
        query getWarehouseLevel($id: ID!) {
          inventoryItem(id: $id) {
            inventoryLevels(first: 50) {
              nodes {
                location { id }
                quantities(names: ["on_hand"]) { quantity }
              }
            }
          }
        }
      `, {
        variables: { id: inventoryItemGID }
      });
      const levelData = await levelRes.json();
      const warehouseLevel = levelData.data.inventoryItem?.inventoryLevels?.nodes?.find(
        n => n.location.id === warehouseLocation.id
      );
      const warehouseQty = warehouseLevel?.quantities?.[0]?.quantity ?? 0;

      if (warehouseQty === 0) {
        const invRes = await admin.graphql(`
          mutation setInventory($input: InventorySetOnHandQuantitiesInput!) {
            inventorySetOnHandQuantities(input: $input) {
              inventoryAdjustmentGroup { id }
              userErrors { field message }
            }
          }
        `, {
          variables: {
            input: {
              reason: "correction",
              setQuantities: [{
                inventoryItemId: inventoryItemGID,
                locationId: warehouseLocation.id,
                quantity: 100000
              }]
            }
          }
        });

        const invErrors = (await invRes.json()).data.inventorySetOnHandQuantities.userErrors;
        if (invErrors?.length) {
          console.error(`[assignSkuAndStock] Inventory errors for variant ${variant.id}:`, invErrors);
        } else {
          stockAdded = true;
          console.log(`[assignSkuAndStock] Set 100000 units at Warehouse for variant ${variant.id}`);
        }
      }
    }

    if (skuAssigned || stockAdded) {
      const parts = [];
      if (skuAssigned) parts.push("SKU assigned");
      if (stockAdded) parts.push("Stock added");
      await db.variantAutoSetup.create({
        data: {
          shop,
          productId: String(productId),
          variantId: String(variant.id),
          sku: skuAssigned ? `IC-${variant.id}` : null,
          stockAdded,
          changes: parts.join(", "),
          trigger: "products/create",
        }
      });
    }
  }
}