// api/reply.js — VERSION DE SECOURS (modèle direct, sans assistant)

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = req.body || {};
    const user_id = String(body.user_id || "").trim();
    const text =
      (body.message ?? body["last user freeform"] ?? body["last user freeform input"] ?? body.user_text ?? "")
        .toString()
        .trim();

    if (!user_id || !text) {
      return res.status(400).json({ reply: "Message vide. Que puis-je faire pour toi ?" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ reply: "Config manquante: OPENAI_API_KEY" });
    }

    // Payload Responses API — modèle direct, PAS d'assistant_id
    const payload = {
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      store: true,
      // on peut garder conversation si tu veux la continuité
      conversation: (() => {
        const c = String(body.conv_id || "").trim();
        if (!c) return `conv_${user_id}`.slice(0, 64);
        return c.startsWith("conv") ? c.slice(0, 64) : `conv_${c}`.slice(0, 64);
      })(),
      input: [
        { role: "system", content: [{ type: "input_text", text: "Tu es Unibot. Réponds en français, clair et concis." }] },
        { role: "user", content: [{ type: "input_text", text }] },
      ],
    };

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const raw = await r.text();
    if (!r.ok) {
      let msg = "Erreur OpenAI";
      try { msg = JSON.parse(raw)?.error?.message || msg; } catch {}
      return res.status(500).json({ reply: `Erreur OpenAI (${r.status}) : ${msg}` });
    }

    const data = JSON.parse(raw);
    const reply =
      data?.output?.[0]?.content?.[0]?.text ||
      data?.output_text ||
      "Désolé, je n’ai pas pu répondre cette fois.";

    const conv_id =
      data?.conversation?.id ||
      data?.response?.conversation_id ||
      data?.output?.[0]?.conversation_id ||
      payload.conversation;

    return res.status(200).json({ reply, conv_id });
  } catch (e) {
    return res.status(500).json({ reply: "Oups, erreur serveur." });
  }
}
