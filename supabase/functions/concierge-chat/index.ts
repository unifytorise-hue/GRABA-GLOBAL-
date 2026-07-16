import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

/*
 * Graba AI concierge — a Claude tool-use loop over Graba's existing search
 * capabilities. This is the "AI concierge / multi-provider orchestration"
 * feature: Claude reasons over a natural-language request and calls tools
 * that wrap the app's own edge functions/tables, rather than being a new
 * source of travel data itself.
 *
 * GUARDRAIL (deliberate, do not relax without discussion): the propose_booking
 * tool only returns a structured proposal for the frontend to render as a
 * confirmation card. It does NOT call book_trip. Nothing in this function
 * spends money or creates a real booking on its own — the user must still
 * tap Confirm in the existing package-builder flow. Keep it this way; an LLM
 * autonomously committing bookings/payments with no human confirmation step
 * is not a safe default.
 *
 * Confidence: HIGH on the Claude/Anthropic Messages API + tool-use shape
 * (this is Anthropic's own documented API) — unlike the Sabre/SerpApi
 * integrations elsewhere in this project. Still UNTESTED end-to-end from
 * this sandbox (no live Anthropic API access here either), so verify a real
 * conversation once ANTHROPIC_API_KEY is set.
 *
 * search_flights/search_hotels call the sibling sabre-flight-search /
 * booking-hotel-search edge functions server-to-server (via their HTTP
 * endpoints, using the service role key as bearer auth) rather than
 * duplicating their logic — so they inherit the same mock-data fallback
 * behavior those functions already have.
 *
 * get_wallet_balance was removed here (Travel Wallet no longer exists — see
 * CLAUDE.md's "Wallet removal" section). Gabriella no longer claims it can
 * check a wallet balance, since `wallets` is now a dormant, unused table.
 *
 * CORS: called directly from the browser — see booking-hotel-search's
 * header for why this needs an explicit OPTIONS handler + CORS headers on
 * every response (a real, previously-undiagnosed bug affecting every
 * client-invoked function in this project, not specific to this one).
 *
 * Requires edge function secrets:
 *   ANTHROPIC_API_KEY — from console.anthropic.com
 * SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are auto-injected by the platform.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const CLAUDE_MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-sonnet-5";

const SYSTEM_PROMPT = `You are Gabriella, Graba's AI travel concierge. You help users search flights and hotels and put together trip proposals using the tools available to you.

Rules:
- You can search and compare freely.
- You must NEVER claim a booking is confirmed or that money has moved — you cannot actually book or charge anything. When a user wants to book something, use propose_booking to hand back a structured proposal, then tell them to review and confirm it in the app.
- All prices are in South African Rand (ZAR) unless a tool result says otherwise — flag it clearly if a result comes back in a different currency.
- Be concise. This is a chat UI on a phone-sized screen.`;

// deno-lint-ignore no-explicit-any
const TOOLS: any[] = [
  {
    name: "search_flights",
    description: "Search flights between two airports on given dates. Falls back to illustrative mock data if live Sabre credentials aren't configured — mention that if the result looks generic.",
    input_schema: {
      type: "object",
      properties: {
        originCode: { type: "string", description: "3-letter IATA origin airport code, e.g. JNB" },
        destinationCode: { type: "string", description: "3-letter IATA destination airport code" },
        departDateTime: { type: "string", description: "ISO 8601, e.g. 2026-09-11T20:00:00" },
        returnDateTime: { type: "string", description: "ISO 8601 return date/time" },
      },
      required: ["destinationCode", "departDateTime", "returnDateTime"],
    },
  },
  {
    name: "search_hotels",
    description: "Search hotels in a destination for a given number of nights.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Destination, e.g. 'Zanzibar, Tanzania'" },
        nights: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "propose_booking",
    description: "Hand back a structured trip proposal for the user to review and confirm in the app. This does NOT book or charge anything.",
    input_schema: {
      type: "object",
      properties: {
        destinationCity: { type: "string" },
        hotelName: { type: "string" },
        nights: { type: "number" },
        flightSummary: { type: "string" },
        estimatedTotal: { type: "number", description: "ZAR" },
      },
      required: ["destinationCity", "estimatedTotal"],
    },
  },
];

async function callSiblingFunction(name: string, body: unknown) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return await res.json();
}

async function runTool(toolName: string, input: Record<string, unknown>, _userId: string) {
  switch (toolName) {
    case "search_flights":
      return await callSiblingFunction("sabre-flight-search", input);
    case "search_hotels":
      return await callSiblingFunction("booking-hotel-search", input);
    case "propose_booking":
      // Deliberately a pass-through — see GUARDRAIL in file header. This tool
      // exists so Claude has a structured way to hand back a proposal; it
      // performs no side effects.
      return { proposal: input, note: "This is a proposal only — not booked. The user must confirm in the app." };
    default:
      return { error: `Unknown tool ${toolName}` };
  }
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string | unknown[];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Use POST" }), { status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured as an edge function secret" }), {
      status: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "Missing Authorization header" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
  const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: userError } = await supabaseAuth.auth.getUser();
  if (userError || !user) {
    return new Response(JSON.stringify({ error: "Invalid session" }), { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  let body: { messages?: ChatMessage[] };
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return new Response(JSON.stringify({ error: "messages (non-empty array) is required" }), { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }

  // deno-lint-ignore no-explicit-any
  const messages: any[] = [...body.messages];
  const MAX_TOOL_ROUNDS = 5;

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 1024,
          system: SYSTEM_PROMPT,
          tools: TOOLS,
          messages,
        }),
      });

      if (!res.ok) {
        const detail = await res.text();
        return new Response(JSON.stringify({ error: `Claude API error: ${res.status}`, detail }), { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }

      const data = await res.json();
      messages.push({ role: "assistant", content: data.content });

      if (data.stop_reason !== "tool_use") {
        // deno-lint-ignore no-explicit-any
        const textBlocks = (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text);
        return new Response(JSON.stringify({ reply: textBlocks.join("\n"), messages }), { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
      }

      // deno-lint-ignore no-explicit-any
      const toolUseBlocks = (data.content ?? []).filter((b: any) => b.type === "tool_use");
      const toolResults = await Promise.all(
        // deno-lint-ignore no-explicit-any
        toolUseBlocks.map(async (block: any) => {
          const result = await runTool(block.name, block.input, user.id);
          return { type: "tool_result", tool_use_id: block.id, content: JSON.stringify(result) };
        }),
      );
      messages.push({ role: "user", content: toolResults });
    }

    return new Response(JSON.stringify({ error: "Too many tool-call rounds without a final answer" }), { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
  }
});
