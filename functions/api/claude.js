export async function onRequest(c) {
  console.log("STEP 1: Function started");
  
  if (c.request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  try {
    console.log("STEP 2: Parsing request body");
    const b = await c.request.json();
    console.log("STEP 3: Request parsed successfully");

    const apiKey = c.env.ANTHROPIC_API_KEY;
    console.log("STEP 4: API key exists:", !!apiKey);

    console.log("STEP 5: Calling Anthropic API");
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(b),
    });
    console.log("STEP 6: Anthropic responded with status:", r.status);

    const d = await r.json();
    console.log("STEP 7: Response parsed, returning to client");

    return new Response(JSON.stringify(d), {
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    console.log("ERROR:", err.message);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }
}
