// api/reply.js — Version Assistant (Unibot)
// Variables requises : OPENAI_API_KEY et UNIBOT_ASSISTANT_ID

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

function pickMessage(body) {
  const { message, user_text, "last user freeform": f1, last_user_freeform: f2 } = body || {};
  return (message || user_text || f1 || f2 || "").trim();
}

async function openaiCall(payload) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ reply: "Méthode non autorisée" });

    const body = readBody(req);
    const user_id = String(body.user_id || "").trim();
    const msg = pickMessage(body);

    if (!user_id || !msg)
      return res.status(400).json({ reply: "Message vide" });

    if (!process.env.OPENAI_API_KEY)
      return res.status(500).json({ reply: "Clé OpenAI manquante" });

    if (!process.env.UNIBOT_ASSISTANT_ID)
      return res.status(500).json({ reply: "Assistant ID manquant" });

    const conv_id = (body.conv_id || `conv_${user_id}`).slice(0, 64);

    const payload = {
      assistant_id: process.env.UNIBOT_ASSISTANT_ID, // ✅ pas de "model" ici
      store: true,
      conversation: conv_id,
      input: [
        { role: "user", content: [{ type: "input_text", text: msg }] }
      ]
    };

    let { ok, status, text } = await openaiCall(payload);

    if (!ok && status === 404) {
      delete payload.conversation;
      ({ ok, status, text } = await openaiCall(payload));
    }

    if (!ok) {
      let hint = "Erreur inconnue";
      try { hint = JSON.parse(text)?.error?.message || hint; } catch {}
      return res.status(500).json({ reply: `Erreur OpenAI (${status}) : ${hint}` });
    }

    const data = JSON.parse(text);
    const reply = data?.output_text || data?.output?.[0]?.content?.[0]?.text || "Aucune réponse.";
    const apiConv = data?.conversation?.id || conv_id;

    return res.status(200).json({ reply, conv_id: apiConv });
  } catch (e) {
    return res.status(500).json({ reply: `Oups : ${e.message}` });

    return res.status(200).json({
  reply,
  conv_id: apiConv,
  version: "assistant_v6" // <-- change ce tag à chaque push
});
  }
}
