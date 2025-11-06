// api/reply.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { user_id, message, session, conv_id } = req.body || {};
    if (!user_id || !message) {
      return res.status(400).json({ error: "Missing user_id or message" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ reply: "Config manquante: OPENAI_API_KEY" });
    }

    const systemPrompt =
      "Tu es UNIBOT, assistant francophone clair et concret. Réponds en moins de 800 caractères. Pose une seule question si besoin.";
    const model = "gpt-4o-mini";

    // Payload de base pour Responses API
    const payload = {
      model,
      store: true,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user",   content: [{ type: "input_text", text: message }] }
      ],
    };

    // ⚠️ On N'AJOUTE 'conversation' QUE si on a déjà un conv_id connu
    if (conv_id) {
      // Sanitize minimal: l'API attend un id commençant par "conv"
      const safe = String(conv_id).replace(/[^A-Za-z0-9_-]/g, "_");
      if (!safe.startsWith("conv")) {
        payload.conversation = `conv_${safe}`.slice(0, 64);
      } else {
        payload.conversation = safe.slice(0, 64);
      }
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

    // 🆕 Récupère l'ID de conversation retourné par OpenAI (créé ou réutilisé)
    const returnedConvId =
      data?.conversation?.id || // format fréquent
      data?.output?.[0]?.conversation_id || // au cas où
      payload.conversation || null;

    const reply =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "Désolé, je n’ai pas pu répondre cette fois.";

    return res.status(200).json({
      reply,
      conv_id: returnedConvId || null,
      session: session || null
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ reply: "Oups, une erreur est survenue." });
  }
}
