// ============================================
// FILE: app/routes/app.fulfil-from.jsx
// ============================================

import { useState } from "react";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";

// Named export for the loader
export async function loader({ request }) {
    const { admin } = await authenticate.admin(request);

    return { admin: true };
}

// Action to handle CSV upload and metafield assignment
export async function action({ request }) {
    const { admin } = await authenticate.admin(request);
    const formData = await request.formData();
    const csvData = formData.get("csvData");
    const fulfilFrom = formData.get("fulfilFrom");

    if (!csvData) {
        return {
            success: false,
            error: "No CSV data provided",
        };
    }

    if (!fulfilFrom) {
        return {
            success: false,
            error: "Please select Fulfil From value (US or CN)",
        };
    }

    try {
        // Parse CSV data
        const csvRows = JSON.parse(csvData);

        console.log(`Processing ${csvRows.length} CSV rows for metafield assignment...`);

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

        // Match CSV SKUs with Shopify variants
        const matched = [];
        const notFound = [];

        for (const csvRow of csvRows) {
            const csvSKU = csvRow.SKU?.toString().trim();

            if (!csvSKU) continue;

            const shopifyVariant = shopifyVariants.get(csvSKU);

            if (!shopifyVariant) {
                notFound.push({
                    csvSKU,
                    csvProduct: csvRow.Product,
                });
            } else {
                matched.push({
                    ...shopifyVariant,
                    csvProduct: csvRow.Product,
                });
            }
        }

        console.log(`Matched: ${matched.length}, Not Found: ${notFound.length}`);

        // Now update metafields for matched variants
        const METAFIELD_MUTATION = `#graphql
      mutation metafieldsSet($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields {
            id
            namespace
            key
            value
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

        const succeeded = [];
        const failed = [];

        for (const variant of matched) {
            try {
                const response = await admin.graphql(METAFIELD_MUTATION, {
                    variables: {
                        metafields: [
                            {
                                ownerId: variant.variantId,
                                namespace: "custom",
                                key: "fulfil_from",
                                value: fulfilFrom,
                                type: "single_line_text_field",
                            },
                        ],
                    },
                });

                const json = await response.json();

                if (json.data?.metafieldsSet?.userErrors?.length > 0) {
                    failed.push({
                        ...variant,
                        error: json.data.metafieldsSet.userErrors[0].message,
                    });
                } else {
                    succeeded.push(variant);
                }

                // Rate limiting - wait 100ms between requests
                await new Promise((resolve) => setTimeout(resolve, 100));
            } catch (error) {
                failed.push({
                    ...variant,
                    error: error.message,
                });
            }
        }

        console.log(`Assignment complete - Succeeded: ${succeeded.length}, Failed: ${failed.length}`);

        return {
            success: true,
            results: {
                succeeded,
                failed,
                notFound,
            },
            totalCSVRows: csvRows.length,
            fulfilFrom,
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
export default function FulfilFromAssignment() {
    const loaderData = useLoaderData();
    const fetcher = useFetcher();
    const [csvFile, setCSVFile] = useState(null);
    const [fulfilFrom, setFulfilFrom] = useState("US");
    const [selectedTab, setSelectedTab] = useState("succeeded");

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

        if (!fulfilFrom) {
            alert("Please select Fulfil From value (US or CN)");
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
                    {
                        csvData: JSON.stringify(rows),
                        fulfilFrom: fulfilFrom,
                    },
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

    const resetForAnotherBatch = () => {
        setCSVFile(null);
        setFulfilFrom("US");        // or keep current value if you prefer
        setSelectedTab("succeeded");
        fetcher.load(window.location.pathname); // clears fetcher.data by re-running loader (no full page reload)
    };

    return (
        <s-page heading="Assign Fulfil From Meta Field">
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
                        <s-heading size="medium">Assign "Fulfil From" Meta Field</s-heading>
                        <s-box marginTop="base" marginBottom="large">
                            <s-text subdued>
                                Upload a CSV file with SKU column to assign the "Fulfil From" meta field to matching variants
                            </s-text>
                        </s-box>

                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "20px" }}>
                            {/* Fulfil From Selection */}
                            <div style={{ width: "100%", maxWidth: "400px" }}>
                                <s-box marginBottom="small">
                                    <s-text fontWeight="semibold">Select Fulfil From Value:</s-text>
                                </s-box>
                                <div style={{ display: "flex", gap: "16px", justifyContent: "center" }}>
                                    <label style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "8px",
                                        padding: "12px 24px",
                                        border: fulfilFrom === "US" ? "2px solid #3b82f6" : "2px solid #d1d5db",
                                        borderRadius: "8px",
                                        cursor: "pointer",
                                        backgroundColor: fulfilFrom === "US" ? "#eff6ff" : "white",
                                        fontWeight: fulfilFrom === "US" ? "600" : "400",
                                    }}>
                                        <input
                                            type="radio"
                                            name="fulfilFrom"
                                            value="US"
                                            checked={fulfilFrom === "US"}
                                            onChange={(e) => setFulfilFrom(e.target.value)}
                                            disabled={isProcessing}
                                            style={{ width: "18px", height: "18px" }}
                                        />
                                        <span>US</span>
                                    </label>
                                    <label style={{
                                        display: "flex",
                                        alignItems: "center",
                                        gap: "8px",
                                        padding: "12px 24px",
                                        border: fulfilFrom === "CN" ? "2px solid #3b82f6" : "2px solid #d1d5db",
                                        borderRadius: "8px",
                                        cursor: "pointer",
                                        backgroundColor: fulfilFrom === "CN" ? "#eff6ff" : "white",
                                        fontWeight: fulfilFrom === "CN" ? "600" : "400",
                                    }}>
                                        <input
                                            type="radio"
                                            name="fulfilFrom"
                                            value="CN"
                                            checked={fulfilFrom === "CN"}
                                            onChange={(e) => setFulfilFrom(e.target.value)}
                                            disabled={isProcessing}
                                            style={{ width: "18px", height: "18px" }}
                                        />
                                        <span>CN</span>
                                    </label>
                                </div>
                            </div>

                            {/* File Input */}
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
                                {isProcessing ? "Processing..." : "Confirm & Assign"}
                            </s-button>
                        </div>

                        {isProcessing && (
                            <s-box marginTop="large">
                                <s-spinner size="large" />
                                <s-box marginTop="base">
                                    <s-text subdued>
                                        Fetching Shopify data and assigning meta fields... This may take 1-2 minutes.
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
                                    <s-text subdued size="small">Successfully Assigned</s-text>
                                    <s-heading size="medium" style={{ color: "#10b981" }}>{results.succeeded.length || 0}</s-heading>
                                </div>
                                <div>
                                    <s-text subdued size="small">Failed</s-text>
                                    <s-heading size="medium" tone="critical">{results.failed.length || 0}</s-heading>
                                </div>
                                <div>
                                    <s-text subdued size="small">SKUs Not Found</s-text>
                                    <s-heading size="medium" tone="critical">{results.notFound.length || 0}</s-heading>
                                </div>
                            </div>

                            <s-box marginTop="base" style={{ display: "flex", gap: "12px", justifyContent: "center", alignItems: "center" }}>
                                <s-text fontWeight="semibold">Assigned Value:</s-text>
                                <span style={{
                                    backgroundColor: "#3b82f6",
                                    color: "white",
                                    padding: "6px 16px",
                                    borderRadius: "6px",
                                    fontWeight: "600",
                                    fontSize: "14px",
                                }}>
                                    {fetcher.data.fulfilFrom}
                                </span>
                            </s-box>

                            <s-box marginTop="base" style={{ textAlign: "center" }}>
                                <s-button onClick={resetForAnotherBatch}>
                                    Assign Another Batch
                                </s-button>

                            </s-box>
                        </s-box>

                        {/* Tabs */}
                        <s-box marginBottom="base">
                            <div style={{ display: "flex", gap: "8px", borderBottom: "2px solid #e5e7eb" }}>
                                <button
                                    onClick={() => setSelectedTab("succeeded")}
                                    style={{
                                        padding: "12px 20px",
                                        border: "none",
                                        background: selectedTab === "succeeded" ? "#10b981" : "transparent",
                                        color: selectedTab === "succeeded" ? "white" : "#6b7280",
                                        fontWeight: "600",
                                        cursor: "pointer",
                                        borderRadius: "4px 4px 0 0",
                                    }}
                                >
                                    ✅ Succeeded ({results.succeeded.length})
                                </button>
                                <button
                                    onClick={() => setSelectedTab("failed")}
                                    style={{
                                        padding: "12px 20px",
                                        border: "none",
                                        background: selectedTab === "failed" ? "#ef4444" : "transparent",
                                        color: selectedTab === "failed" ? "white" : "#6b7280",
                                        fontWeight: "600",
                                        cursor: "pointer",
                                        borderRadius: "4px 4px 0 0",
                                    }}
                                >
                                    ❌ Failed ({results.failed.length})
                                </button>
                                <button
                                    onClick={() => setSelectedTab("notFound")}
                                    style={{
                                        padding: "12px 20px",
                                        border: "none",
                                        background: selectedTab === "notFound" ? "#f59e0b" : "transparent",
                                        color: selectedTab === "notFound" ? "white" : "#6b7280",
                                        fontWeight: "600",
                                        cursor: "pointer",
                                        borderRadius: "4px 4px 0 0",
                                    }}
                                >
                                    ⚠️ Not Found ({results.notFound.length})
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
                            {/* Succeeded Tab */}
                            {selectedTab === "succeeded" && (
                                <>
                                    {results.succeeded.length === 0 ? (
                                        <s-box padding="large" style={{ textAlign: "center" }}>
                                            <s-text subdued>No successful assignments</s-text>
                                        </s-box>
                                    ) : (
                                        <table style={{ width: "100%", borderCollapse: "collapse", backgroundColor: "white" }}>
                                            <thead>
                                                <tr style={{ borderBottom: "2px solid #ddd" }}>
                                                    <th style={{ textAlign: "left", padding: "10px" }}>Image</th>
                                                    <th style={{ textAlign: "left", padding: "10px" }}>SKU</th>
                                                    <th style={{ textAlign: "left", padding: "10px" }}>Product</th>
                                                    <th style={{ textAlign: "left", padding: "10px" }}>Variant</th>
                                                    <th style={{ textAlign: "left", padding: "10px" }}>Status</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {results.succeeded.map((item, index) => (
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
                                                        <td style={{ padding: "10px", fontSize: "12px", color: "#6b7280" }}>{item.variantTitle}</td>
                                                        <td style={{ padding: "10px" }}>
                                                            <span style={{
                                                                backgroundColor: "#d1fae5",
                                                                color: "#065f46",
                                                                padding: "4px 10px",
                                                                borderRadius: "12px",
                                                                fontSize: "12px",
                                                                fontWeight: "500",
                                                            }}>
                                                                ✅ Assigned
                                                            </span>
                                                        </td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    )}
                                </>
                            )}

                            {/* Failed Tab */}
                            {selectedTab === "failed" && (
                                <>
                                    {results.failed.length === 0 ? (
                                        <s-box padding="large" style={{ textAlign: "center" }}>
                                            <s-text subdued>✅ No failed assignments!</s-text>
                                        </s-box>
                                    ) : (
                                        <table style={{ width: "100%", borderCollapse: "collapse", backgroundColor: "white" }}>
                                            <thead>
                                                <tr style={{ borderBottom: "2px solid #ddd" }}>
                                                    <th style={{ textAlign: "left", padding: "10px" }}>Image</th>
                                                    <th style={{ textAlign: "left", padding: "10px" }}>SKU</th>
                                                    <th style={{ textAlign: "left", padding: "10px" }}>Product</th>
                                                    <th style={{ textAlign: "left", padding: "10px" }}>Error</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {results.failed.map((item, index) => (
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
                                                        <td style={{ padding: "10px", fontSize: "12px", color: "#dc2626" }}>{item.error}</td>
                                                    </tr>
                                                ))}
                                            </tbody>
                                        </table>
                                    )}
                                </>
                            )}

                            {/* Not Found Tab */}
                            {selectedTab === "notFound" && (
                                <>
                                    {results.notFound.length === 0 ? (
                                        <s-box padding="large" style={{ textAlign: "center" }}>
                                            <s-text subdued>✅ All SKUs from CSV were found in Shopify!</s-text>
                                        </s-box>
                                    ) : (
                                        <table style={{ width: "100%", borderCollapse: "collapse", backgroundColor: "white" }}>
                                            <thead>
                                                <tr style={{ borderBottom: "2px solid #ddd" }}>
                                                    <th style={{ textAlign: "left", padding: "12px" }}>CSV SKU</th>
                                                    <th style={{ textAlign: "left", padding: "12px" }}>CSV Product</th>
                                                    <th style={{ textAlign: "left", padding: "12px" }}>Status</th>
                                                </tr>
                                            </thead>
                                            <tbody>
                                                {results.notFound.map((item, index) => (
                                                    <tr key={index} style={{ borderBottom: "1px solid #eee" }}>
                                                        <td style={{ padding: "12px", fontFamily: "monospace", fontWeight: "500" }}>{item.csvSKU}</td>
                                                        <td style={{ padding: "12px" }}>{item.csvProduct}</td>
                                                        <td style={{ padding: "12px" }}>
                                                            <span style={{
                                                                backgroundColor: "#fef3c7",
                                                                color: "#92400e",
                                                                padding: "4px 10px",
                                                                borderRadius: "12px",
                                                                fontSize: "12px",
                                                                fontWeight: "500",
                                                            }}>
                                                                ⚠️ Not in Shopify
                                                            </span>
                                                        </td>
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