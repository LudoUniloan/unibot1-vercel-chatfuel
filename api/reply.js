// api/reply.js
function makeConvIdFromUser(userId) {
  const safe = String(userId || "anon").replace(/[^A-Za-z0-9_-]/g, "_");
  return ("conv_wa_" + safe).slice(0, 64); // l'API exige un id qui commence par "conv"
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const {
      user_id,
      session,
      message: rawMessage,
      user_text,
      "last user freeform": lastUserFreeform,
      last_user_freeform,
    } = req.body || {};

    const msg = (rawMessage ?? user_text ?? lastUserFreeform ?? last_user_freeform ?? "")
      .toString()
      .trim();

    if (!user_id || !msg) {
      return res.status(400).json({
        reply:
          "Ton message semble vide. Dis-moi ce que tu veux savoir et je t’aide 🙂",
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ reply: "Config manquante: OPENAI_API_KEY" });
    }

    // ✅ ID de conversation déterministe et stable par utilisateur
    const conversation = makeConvIdFromUser(user_id);

    const systemPrompt =
      "Tu es UNIBOT, assistant francophone clair et concret. " +
      "Ne redis pas 'Salut' si la conversation est entamée. " +
      "Réponds directement, en moins de 800 caractères si possible.";

    const payload = {
      model: "gpt-4o-mini",
      store: true,
      conversation, // <-- on force notre conv_id stable
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: [{ type: "input_text", text: msg }] },
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

    const text = await r.text();

    if (!r.ok) {
      let hint = "Erreur API OpenAI";
      try { hint = JSON.parse(text)?.error?.message || hint; } catch {}
      if (r.status === 429) {
        return res.status(429).json({
          reply: "Beaucoup de demandes en ce moment 😅 Réessaie dans une minute.",
        });
      }
      return res.status(500).json({ reply: `Erreur OpenAI (${r.status}) : ${hint}` });
    }

    const data = JSON.parse(text);
    const reply =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "Désolé, je n’ai pas pu répondre cette fois.";

    // ✅ On renvoie toujours le conv_id qu’on a fixé
    return res.status(200).json({
      reply,
      conv_id: conversation,
      session: session || null,
    });
  } catch (e) {
    return res.status(500).json({ reply: "Oups, une erreur est survenue." });
  }
}
