// api/reply.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { user_id, message, session, conv_id } = req.body || {};
    if (!user_id || !message) return res.status(400).json({ error: "Missing user_id or message" });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ reply: "Config manquante: OPENAI_API_KEY" });

    const systemPrompt = "Tu es UNIBOT, assistant francophone clair et concret. Réponds en < 800 caractères. Pose 1 question max si besoin.";
    const model = "gpt-4o-mini";

    // --- Construire le payload de base
    const payload = {
      model,
      store: true,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user",   content: [{ type: "input_text", text: message }] }
      ],
    };

    // --- N'ajouter 'conversation' QUE si conv_id est vraiment valable
    const normalized = (conv_id ?? "").toString().trim().toLowerCase();
    const hasValidConv =
      normalized &&
      normalized !== "null" &&
      normalized !== "undefined" &&
      normalized !== "false";

    if (hasValidConv) {
      const safe = String(conv_id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
      payload.conversation = safe.startsWith("conv") ? safe : `conv_${safe}`;
    }

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    if (!r.ok) {
      let hint = "Erreur API OpenAI";
      try { hint = JSON.parse(text)?.error?.message || hint; } catch {}
      return res.status(500).json({ reply: `Erreur OpenAI (${r.status}) : ${hint}` });
    }

    const data = JSON.parse(text);
    const returnedConvId =
      data?.conversation?.id ||
      data?.output?.[0]?.conversation_id ||
      payload.conversation || null;

    const reply =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "Désolé, je n’ai pas pu répondre cette fois.";

    return res.status(200).json({ reply, conv_id: returnedConvId, session: session || null });
  } catch (e) {
    return res.status(500).json({ reply: "Oups, une erreur est survenue." });
  }
}
