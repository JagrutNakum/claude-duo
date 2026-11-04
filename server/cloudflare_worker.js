/**
 * Claude-Duo Cloudflare Worker Relay
 * Deploy this on Cloudflare Workers (Free tier: 100,000 requests/day).
 * Stores latest state in memory / KV and relays events between peers.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS headers for easy cross-origin access
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // POST /event - receive an alert or state sync
    if (request.method === "POST") {
      try {
        const body = await request.json();
        const user = (body.sender || "unknown").toLowerCase();
        
        // Save to KV if bound (e.g. env.CLAUDE_DUO_KV)
        if (env && env.CLAUDE_DUO_KV) {
          if (body.type === "state_sync") {
            await env.CLAUDE_DUO_KV.put(`state:${user}`, JSON.stringify(body));
          } else {
            // Save recent alert
            await env.CLAUDE_DUO_KV.put("latest_alert", JSON.stringify(body));
          }
        }
        
        return new Response(JSON.stringify({ status: "ok", received: body.type }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }

    // GET /state/:user - fetch peer state
    if (request.method === "GET") {
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] === "state" && parts[1] && env && env.CLAUDE_DUO_KV) {
        const state = await env.CLAUDE_DUO_KV.get(`state:${parts[1].toLowerCase()}`);
        return new Response(state || "{}", {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
      return new Response(JSON.stringify({ status: "Claude-Duo Relay Active" }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    return new Response("Not found", { status: 404 });
  }
};
