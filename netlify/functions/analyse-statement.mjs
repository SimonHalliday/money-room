// Serverless proxy so the Anthropic API key never reaches the browser.
// The app posts { content: [...] }; this adds the model, token limit and key.

export async function handler(event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "ANTHROPIC_API_KEY is not set" }) };
  }
  try {
    const { content } = JSON.parse(event.body || "{}");
    if (!content) {
      return { statusCode: 400, body: JSON.stringify({ error: "Missing content" }) };
    }
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        messages: [{ role: "user", content }],
      }),
    });
    const data = await res.json();
    return {
      statusCode: res.status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: String(e) }) };
  }
}
