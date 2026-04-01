// app/routes/api.order.get_orders.jsx
// Public endpoint – no Shopify session required.
// Matches the fetch URL used in the storefront form:
//   POST /api/order/get_orders

import prisma from "../db.server";

// ── CORS helper ──────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

// ── OPTIONS pre-flight ────────────────────────────────────────────────────────
export async function loader({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(request.headers.get("Origin")),
    });
  }
  return new Response("Method not allowed", { status: 405 });
}

// ── POST handler ──────────────────────────────────────────────────────────────
export async function action({ request }) {
  const origin = request.headers.get("Origin");

  // Handle CORS pre-flight sent via action
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  // ── Validate required fields ─────────────────────────────────────────────
  const required = ["type", "name", "email"];
  const missing = required.filter((k) => !body[k]);
  if (missing.length) {
    return new Response(
      JSON.stringify({ error: `Missing required fields: ${missing.join(", ")}` }),
      {
        status: 422,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      }
    );
  }

  // ── Persist to DB ────────────────────────────────────────────────────────
  try {
    const order = await prisma.customOrder.create({
      data: {
        type:      body.type        ?? "",
        name:      body.name        ?? "",
        email:     body.email       ?? "",
        phone:     body.phone       || null,
        country:   body.country     || null,
        instagram: body.instagram   || null,
        comments:  body.comments    || null,
        fileUrl:   body.fileUrl     || null,
        sourcePage: body.sourcePage || null,
        sourceUrl:  body.sourceUrl  || null,

        // Pendant
        pendantType:  body.pendant?.type  || null,
        pendantSize:  body.pendant?.size  || null,
        pendantColor: body.pendant?.color || null,

        // Chain
        chainLinkType:  body.chain?.linkType  || null,
        chainThickness: body.chain?.thickness || null,
        chainLength:    body.chain?.length    || null,
        chainColor:     body.chain?.color     || null,

        // Grillz
        grillzTeeth: body.grillz?.teeth || null,
        grillzColor: body.grillz?.color || null,

        // Ring
        ringSize:  body.ring?.size  || null,
        ringColor: body.ring?.color || null,

        submittedAt: body.submittedAt ? new Date(body.submittedAt) : new Date(),
      },
    });

    return new Response(JSON.stringify({ ok: true, id: order.id }), {
      status: 201,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  } catch (err) {
    console.error("[CustomOrder] DB error:", err);
    return new Response(
      JSON.stringify({ error: "Internal server error", detail: err.message }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      }
    );
  }
}