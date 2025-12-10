// ============================================
// FILE: app/routes/app.csv-comparison.jsx
// ============================================

import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";

// Named export for the loader
export async function loader({ request }) {
  const { admin } = await authenticate.admin(request);
  
  // Just return admin for the action to use
  return { admin: true };
}

// Action to handle CSV upload and comparison
export async function action({ request }) {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const csvData = formData.get("csvData");

  if (!csvData) {
    return {
      success: false,
      error: "No CSV data provided",
    };
  }

  try {
    // Parse CSV data
    const csvRows = JSON.parse(csvData);
    
    console.log(`Processing ${csvRows.length} CSV rows...`);

    // Fetch all products from Shopify
    let cursor = null;
    let hasNextPage = true;
    const shopifyVariants = new Map(); // SKU -> variant details

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

    // Fetch all Shopify variants
    while (hasNextPage) {
      const response = await admin.graphql(PRODUCTS_QUERY, {
        variables: { cursor },
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

        if (!product.variants?.edges?.length) continue;

        for (const variantEdge of product.variants.edges) {
          const variant = variantEdge.node;
          const sku = variant.sku?.trim();

          if (sku) {
            shopifyVariants.set(sku, {
              variantId: variant.id,
              productId: product.id,
              productTitle: product.title,
              productImage: product.images?.nodes?.[0]?.url || null,
              variantTitle: variant.title,
              sku: sku,
              barcode: variant.barcode?.trim() || null,
              inventoryQuantity: variant.inventoryQuantity || 0,
              price: variant.price,
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

    console.log(`Fetched ${shopifyVariants.size} Shopify variants`);

    // Compare CSV with Shopify data
    const results = {
      matched: [],
      skuNotFound: [],
      barcodeMismatch: [],
      skuFoundBarcodeMatch: [],
    };

    for (const csvRow of csvRows) {
      const csvSKU = csvRow.SKU?.toString().trim();
      // Handle GTIN as string and remove any decimals if it was parsed as number
      let csvGTIN = csvRow.GTIN?.toString().trim();
      if (csvGTIN && csvGTIN.includes('.')) {
        csvGTIN = csvGTIN.split('.')[0]; // Remove decimal point
      }

      if (!csvSKU) continue;

      const shopifyVariant = shopifyVariants.get(csvSKU);

      if (!shopifyVariant) {
        // SKU not found in Shopify
        results.skuNotFound.push({
          csvSKU,
          csvGTIN,
          csvProduct: csvRow.Product,
          csvQty: csvRow["Real Qty."] || csvRow["Est. Qty."],
        });
      } else {
        // SKU found in Shopify
        const shopifyBarcode = shopifyVariant.barcode;

        if (csvGTIN && shopifyBarcode) {
          if (csvGTIN === shopifyBarcode) {
            // Perfect match
            results.skuFoundBarcodeMatch.push({
              ...shopifyVariant,
              csvProduct: csvRow.Product,
              csvGTIN,
              csvQty: csvRow["Real Qty."] || csvRow["Est. Qty."],
            });
          } else {
            // Barcode mismatch
            results.barcodeMismatch.push({
              ...shopifyVariant,
              csvProduct: csvRow.Product,
              csvGTIN,
              shopifyBarcode,
              csvQty: csvRow["Real Qty."] || csvRow["Est. Qty."],
            });
          }
        } else if (!csvGTIN && !shopifyBarcode) {
          // Both missing barcodes
          results.matched.push({
            ...shopifyVariant,
            csvProduct: csvRow.Product,
            csvGTIN: "N/A",
            csvQty: csvRow["Real Qty."] || csvRow["Est. Qty."],
            note: "Both CSV and Shopify missing barcode/GTIN",
          });
        } else if (!csvGTIN) {
          // CSV missing GTIN
          results.matched.push({
            ...shopifyVariant,
            csvProduct: csvRow.Product,
            csvGTIN: "N/A",
            csvQty: csvRow["Real Qty."] || csvRow["Est. Qty."],
            note: "CSV missing GTIN",
          });
        } else if (!shopifyBarcode) {
          // Shopify missing barcode
          results.matched.push({
            ...shopifyVariant,
            csvProduct: csvRow.Product,
            csvGTIN,
            csvQty: csvRow["Real Qty."] || csvRow["Est. Qty."],
            note: "Shopify missing barcode",
          });
        }
      }
    }

    return {
      success: true,
      results,
      totalCSVRows: csvRows.length,
      totalShopifyVariants: shopifyVariants.size,
    };
  } catch (error) {
    console.error("Error processing CSV:", error);
    return {
      success: false,
      error: `Error processing CSV: ${error.message}`,
    };
  }
}

// Default export for the component
export default function CSVComparison() {
  const loaderData = useLoaderData();
  const fetcher = useFetcher();
  const [csvFile, setCSVFile] = useState(null);
  const [selectedTab, setSelectedTab] = useState("skuNotFound");

  const isProcessing = fetcher.state === "submitting";
  const results = fetcher.data?.results;

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    console.log("File selected:", file);
    if (file) {
      setCSVFile(file);
    }
  };

  const handleUpload = async () => {
    if (!csvFile) {
      alert("Please select a CSV file first");
      return;
    }

    console.log("Processing file:", csvFile.name);

    const reader = new FileReader();
    reader.onerror = (error) => {
      console.error("FileReader error:", error);
      alert("Error reading file");
    };
    
    reader.onload = async (e) => {
      const text = e.target.result;
      console.log("CSV content loaded, length:", text.length);
      
      try {
        // Better CSV parsing that handles commas inside quotes
        const lines = text.split(/\r?\n/);
        const headers = parseCSVLine(lines[0]);
        
        console.log("CSV headers:", headers);
        
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          
          const values = parseCSVLine(lines[i]);
          const row = {};
          
          headers.forEach((header, index) => {
            row[header] = values[index] || "";
          });
          
          // Only add rows that have a SKU
          if (row.SKU && row.SKU.trim()) {
            rows.push(row);
          }
        }

        console.log("Parsed rows:", rows.length);
        console.log("First row sample:", rows[0]);

        fetcher.submit(
          { csvData: JSON.stringify(rows) },
          { method: "post" }
        );
      } catch (error) {
        console.error("CSV parsing error:", error);
        alert("Error parsing CSV file. Please check the file format.");
      }
    };

    reader.readAsText(csvFile);
  };

  // Helper function to properly parse CSV lines with quoted values
  const parseCSVLine = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      const nextChar = line[i + 1];
      
      if (char === '"') {
        if (inQuotes && nextChar === '"') {
          // Escaped quote
          current += '"';
          i++;
        } else {
          // Toggle quote state
          inQuotes = !inQuotes;
        }
      } else if (char === ',' && !inQuotes) {
        // End of field
        result.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    
    // Add the last field
    result.push(current.trim());
    
    return result;
  };

  return (
    <s-page heading="CSV Comparison Tool">
      <s-section>
        {fetcher.data?.error && (
          <s-box marginBottom="base">
            <s-text tone="critical">{fetcher.data.error}</s-text>
          </s-box>
        )}

        {/* Upload Section */}
        {!results && (
          <s-box
            padding="large"
            borderWidth="base"
            borderRadius="base"
            background="subdued"
            style={{ textAlign: "center" }}
          >
            <s-heading size="medium">Upload CSV File</s-heading>
            <s-box marginTop="base" marginBottom="base">
              <s-text subdued>
                Upload a CSV file with SKU and GTIN columns to compare with your Shopify inventory
              </s-text>
            </s-box>

            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "16px" }}>
              <input
                type="file"
                accept=".csv"
                onChange={handleFileChange}
                disabled={isProcessing}
                style={{
                  padding: "10px",
                  borderRadius: "6px",
                  border: "1px solid #d1d5db",
                  fontSize: "14px",
                }}
              />

              {csvFile && (
                <s-text>
                  Selected: <strong>{csvFile.name}</strong>
                </s-text>
              )}

              <s-button
                onClick={handleUpload}
                disabled={isProcessing}
                primary
              >
                {isProcessing ? "Processing..." : "Compare with Shopify"}
              </s-button>
            </div>

            {isProcessing && (
              <s-box marginTop="large">
                <s-spinner size="large" />
                <s-box marginTop="base">
                  <s-text subdued>
                    Fetching Shopify data and comparing with CSV... This may take 1-2 minutes.
                  </s-text>
                </s-box>
              </s-box>
            )}
          </s-box>
        )}

        {/* Results Section */}
        {results && (
          <>
            {/* Summary Stats */}
            <s-box
              marginBottom="base"
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
                <div>
                  <s-text subdued size="small">CSV Rows Processed</s-text>
                  <s-heading size="medium">{fetcher.data.totalCSVRows || 0}</s-heading>
                </div>
                <div>
                  <s-text subdued size="small">Shopify Variants</s-text>
                  <s-heading size="medium">{fetcher.data.totalShopifyVariants || 0}</s-heading>
                </div>
                <div>
                  <s-text subdued size="small">SKUs Not Found</s-text>
                  <s-heading size="medium" tone="critical">{results.skuNotFound.length || 0}</s-heading>
                </div>
                <div>
                  <s-text subdued size="small">Barcode Mismatches</s-text>
                  <s-heading size="medium" tone="critical">{results.barcodeMismatch.length || 0}</s-heading>
                </div>
              </div>

              <s-box marginTop="base" style={{ textAlign: "center" }}>
                <s-button onClick={() => window.location.reload()}>
                  Upload Another CSV
                </s-button>
              </s-box>
            </s-box>

            {/* Tabs */}
            <s-box marginBottom="base">
              <div style={{ display: "flex", gap: "8px", borderBottom: "2px solid #e5e7eb" }}>
                <button
                  onClick={() => setSelectedTab("skuNotFound")}
                  style={{
                    padding: "12px 20px",
                    border: "none",
                    background: selectedTab === "skuNotFound" ? "#3b82f6" : "transparent",
                    color: selectedTab === "skuNotFound" ? "white" : "#6b7280",
                    fontWeight: "600",
                    cursor: "pointer",
                    borderRadius: "4px 4px 0 0",
                  }}
                >
                  SKUs Not Found ({results.skuNotFound.length})
                </button>
                <button
                  onClick={() => setSelectedTab("barcodeMismatch")}
                  style={{
                    padding: "12px 20px",
                    border: "none",
                    background: selectedTab === "barcodeMismatch" ? "#3b82f6" : "transparent",
                    color: selectedTab === "barcodeMismatch" ? "white" : "#6b7280",
                    fontWeight: "600",
                    cursor: "pointer",
                    borderRadius: "4px 4px 0 0",
                  }}
                >
                  Barcode Mismatches ({results.barcodeMismatch.length})
                </button>
                <button
                  onClick={() => setSelectedTab("matched")}
                  style={{
                    padding: "12px 20px",
                    border: "none",
                    background: selectedTab === "matched" ? "#3b82f6" : "transparent",
                    color: selectedTab === "matched" ? "white" : "#6b7280",
                    fontWeight: "600",
                    cursor: "pointer",
                    borderRadius: "4px 4px 0 0",
                  }}
                >
                  Matched ({results.matched.length})
                </button>
                <button
                  onClick={() => setSelectedTab("perfect")}
                  style={{
                    padding: "12px 20px",
                    border: "none",
                    background: selectedTab === "perfect" ? "#3b82f6" : "transparent",
                    color: selectedTab === "perfect" ? "white" : "#6b7280",
                    fontWeight: "600",
                    cursor: "pointer",
                    borderRadius: "4px 4px 0 0",
                  }}
                >
                  Perfect Matches ({results.skuFoundBarcodeMatch.length})
                </button>
              </div>
            </s-box>

            {/* Tab Content */}
            <s-box
              padding="base"
              borderWidth="base"
              borderRadius="base"
              background="subdued"
            >
              {/* SKUs Not Found Tab */}
              {selectedTab === "skuNotFound" && (
                <>
                  {results.skuNotFound.length === 0 ? (
                    <s-box padding="large" style={{ textAlign: "center" }}>
                      <s-text subdued>✅ All SKUs from CSV were found in Shopify!</s-text>
                    </s-box>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse", backgroundColor: "white" }}>
                      <thead>
                        <tr style={{ borderBottom: "2px solid #ddd" }}>
                          <th style={{ textAlign: "left", padding: "12px" }}>CSV SKU</th>
                          <th style={{ textAlign: "left", padding: "12px" }}>CSV Product</th>
                          <th style={{ textAlign: "left", padding: "12px" }}>CSV GTIN</th>
                          <th style={{ textAlign: "left", padding: "12px" }}>CSV Qty</th>
                          <th style={{ textAlign: "left", padding: "12px" }}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.skuNotFound.map((item, index) => (
                          <tr key={index} style={{ borderBottom: "1px solid #eee" }}>
                            <td style={{ padding: "12px", fontFamily: "monospace", fontWeight: "500" }}>{item.csvSKU}</td>
                            <td style={{ padding: "12px" }}>{item.csvProduct}</td>
                            <td style={{ padding: "12px", fontFamily: "monospace" }}>{item.csvGTIN || "N/A"}</td>
                            <td style={{ padding: "12px" }}>{item.csvQty || "N/A"}</td>
                            <td style={{ padding: "12px" }}>
                              <span style={{
                                backgroundColor: "#fee2e2",
                                color: "#991b1b",
                                padding: "4px 10px",
                                borderRadius: "12px",
                                fontSize: "12px",
                                fontWeight: "500",
                              }}>
                                ❌ Not in Shopify
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}

              {/* Barcode Mismatch Tab */}
              {selectedTab === "barcodeMismatch" && (
                <>
                  {results.barcodeMismatch.length === 0 ? (
                    <s-box padding="large" style={{ textAlign: "center" }}>
                      <s-text subdued>✅ No barcode mismatches found!</s-text>
                    </s-box>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse", backgroundColor: "white" }}>
                      <thead>
                        <tr style={{ borderBottom: "2px solid #ddd" }}>
                          <th style={{ textAlign: "left", padding: "10px" }}>Image</th>
                          <th style={{ textAlign: "left", padding: "10px" }}>SKU</th>
                          <th style={{ textAlign: "left", padding: "10px" }}>Shopify Product</th>
                          <th style={{ textAlign: "left", padding: "10px" }}>CSV Product</th>
                          <th style={{ textAlign: "left", padding: "10px" }}>CSV GTIN</th>
                          <th style={{ textAlign: "left", padding: "10px" }}>Shopify Barcode</th>
                          <th style={{ textAlign: "left", padding: "10px" }}>Variant ID</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.barcodeMismatch.map((item, index) => (
                          <tr key={index} style={{ borderBottom: "1px solid #eee" }}>
                            <td style={{ padding: "10px" }}>
                              {item.productImage ? (
                                <img src={item.productImage} width="40" style={{ borderRadius: "4px" }} alt="" />
                              ) : (
                                <div style={{ width: "40px", height: "40px", backgroundColor: "#e5e7eb", borderRadius: "4px" }} />
                              )}
                            </td>
                            <td style={{ padding: "10px", fontFamily: "monospace", fontWeight: "500" }}>{item.sku}</td>
                            <td style={{ padding: "10px", fontSize: "13px" }}>{item.productTitle}</td>
                            <td style={{ padding: "10px", fontSize: "13px" }}>{item.csvProduct}</td>
                            <td style={{ padding: "10px", fontFamily: "monospace", backgroundColor: "#fef3c7" }}>{item.csvGTIN}</td>
                            <td style={{ padding: "10px", fontFamily: "monospace", backgroundColor: "#fee2e2" }}>{item.shopifyBarcode}</td>
                            <td style={{ padding: "10px", fontSize: "11px", fontFamily: "monospace", color: "#6b7280" }}>
                              {item.variantId.replace("gid://shopify/ProductVariant/", "")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}

              {/* Matched Tab */}
              {selectedTab === "matched" && (
                <>
                  {results.matched.length === 0 ? (
                    <s-box padding="large" style={{ textAlign: "center" }}>
                      <s-text subdued>No items in this category</s-text>
                    </s-box>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse", backgroundColor: "white" }}>
                      <thead>
                        <tr style={{ borderBottom: "2px solid #ddd" }}>
                          <th style={{ textAlign: "left", padding: "10px" }}>Image</th>
                          <th style={{ textAlign: "left", padding: "10px" }}>SKU</th>
                          <th style={{ textAlign: "left", padding: "10px" }}>Product</th>
                          <th style={{ textAlign: "left", padding: "10px" }}>Note</th>
                          <th style={{ textAlign: "left", padding: "10px" }}>Variant ID</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.matched.map((item, index) => (
                          <tr key={index} style={{ borderBottom: "1px solid #eee" }}>
                            <td style={{ padding: "10px" }}>
                              {item.productImage ? (
                                <img src={item.productImage} width="40" style={{ borderRadius: "4px" }} alt="" />
                              ) : (
                                <div style={{ width: "40px", height: "40px", backgroundColor: "#e5e7eb", borderRadius: "4px" }} />
                              )}
                            </td>
                            <td style={{ padding: "10px", fontFamily: "monospace", fontWeight: "500" }}>{item.sku}</td>
                            <td style={{ padding: "10px", fontSize: "13px" }}>{item.productTitle}</td>
                            <td style={{ padding: "10px", fontSize: "12px", color: "#f59e0b" }}>{item.note}</td>
                            <td style={{ padding: "10px", fontSize: "11px", fontFamily: "monospace", color: "#6b7280" }}>
                              {item.variantId.replace("gid://shopify/ProductVariant/", "")}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}

              {/* Perfect Matches Tab */}
              {selectedTab === "perfect" && (
                <>
                  {results.skuFoundBarcodeMatch.length === 0 ? (
                    <s-box padding="large" style={{ textAlign: "center" }}>
                      <s-text subdued>No perfect matches found</s-text>
                    </s-box>
                  ) : (
                    <table style={{ width: "100%", borderCollapse: "collapse", backgroundColor: "white" }}>
                      <thead>
                        <tr style={{ borderBottom: "2px solid #ddd" }}>
                          <th style={{ textAlign: "left", padding: "10px" }}>Image</th>
                          <th style={{ textAlign: "left", padding: "10px" }}>SKU</th>
                          <th style={{ textAlign: "left", padding: "10px" }}>Product</th>
                          <th style={{ textAlign: "left", padding: "10px" }}>Barcode/GTIN</th>
                          <th style={{ textAlign: "left", padding: "10px" }}>CSV Qty</th>
                          <th style={{ textAlign: "left", padding: "10px" }}>Shopify Qty</th>
                        </tr>
                      </thead>
                      <tbody>
                        {results.skuFoundBarcodeMatch.map((item, index) => (
                          <tr key={index} style={{ borderBottom: "1px solid #eee" }}>
                            <td style={{ padding: "10px" }}>
                              {item.productImage ? (
                                <img src={item.productImage} width="40" style={{ borderRadius: "4px" }} alt="" />
                              ) : (
                                <div style={{ width: "40px", height: "40px", backgroundColor: "#e5e7eb", borderRadius: "4px" }} />
                              )}
                            </td>
                            <td style={{ padding: "10px", fontFamily: "monospace", fontWeight: "500" }}>{item.sku}</td>
                            <td style={{ padding: "10px", fontSize: "13px" }}>{item.productTitle}</td>
                            <td style={{ padding: "10px", fontFamily: "monospace" }}>{item.csvGTIN}</td>
                            <td style={{ padding: "10px" }}>{item.csvQty || "N/A"}</td>
                            <td style={{ padding: "10px" }}>{item.inventoryQuantity}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </s-box>
          </>
        )}
      </s-section>
    </s-page>
  );
}