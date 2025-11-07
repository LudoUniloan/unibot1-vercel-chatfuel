// api/reply.js — modèle direct, création auto de conversation

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = req.body || {};
    const user_id = String(body.user_id || "").trim();
    const msg =
      (body.message ??
       body["last user freeform"] ??
       body["last user freeform input"] ??
       body.user_text ??
       "").toString().trim();

    if (!user_id || !msg) {
      return res.status(400).json({ reply: "Message vide. Que puis-je faire pour toi ?" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ reply: "Config manquante: OPENAI_API_KEY" });
    }

    // 1) Construire le payload de base (sans conversation)
    const base = {
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      store: true,
      input: [
        { role: "system", content: [{ type: "input_text", text: "Tu es Unibot. Réponds en français, clair et concis." }] },
        { role: "user", content: [{ type: "input_text", text: msg }] }
      ]
    };

    // 2) Si le client fournit un conv_id, on le normalise et on l'ajoute
    const clientConv = (body.conv_id || "").toString().trim();
    const hasClientConv = !!clientConv && clientConv.toLowerCase() !== "null";
    const conversation = hasClientConv
      ? (clientConv.startsWith("conv") ? clientConv.slice(0, 64)
                                       : `conv_${clientConv}`.slice(0, 64))
      : null;

    const payload = hasClientConv ? { ...base, conversation } : { ...base };

    // 3) Appel OpenAI
    let r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // 4) Si 404 (conv inexistante), on réessaie sans conversation (création auto)
    if (!r.ok && r.status === 404 && hasClientConv) {
      const retryPayload = { ...base }; // sans conversation
      r = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(retryPayload),
      });
    }

    const raw = await r.text();
    if (!r.ok) {
      let msgErr = "Erreur OpenAI";
      try { msgErr = JSON.parse(raw)?.error?.message || msgErr; } catch {}
      return res.status(500).json({ reply: `Erreur OpenAI (${r.status}) : ${msgErr}` });
    }

    const data = JSON.parse(raw);
    const reply =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "Désolé, je n’ai pas pu répondre cette fois.";

    const newConvId =
      data?.conversation?.id ||
      data?.response?.conversation_id ||
      data?.output?.[0]?.conversation_id ||
      conversation || null;

    return res.status(200).json({
      reply,
      conv_id: newConvId,
      session: body.session || null,
    });
  } catch (e) {
    return res.status(500).json({ reply: "Oups, erreur serveur." });
  }
}
