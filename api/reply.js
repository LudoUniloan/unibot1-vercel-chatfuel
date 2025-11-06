// api/reply.js
export default async function handler(req, res) {
  try {
    // 1) Méthode
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // 2) Lecture du payload
    const { user_id, message, session } = req.body || {};
    if (!user_id || !message) {
      return res.status(400).json({ error: "Missing user_id or message" });
    }

    // 3) Variable d'environnement
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ reply: "Config manquante: OPENAI_API_KEY" });
    }

    // 4) Construire un ID de conversation valide: [A-Za-z0-9_-], pas d'espace/:
    const convId = (raw) =>
      ("wa_" + String(raw ?? "anon"))
        .replace(/[^A-Za-z0-9_-]/g, "_")
        .slice(0, 64); // borne par prudence

    const conversation = convId(user_id || session);

    // 5) Prompt système (tu peux l'ajuster)
    const systemPrompt =
      "Tu es UNIBOT, assistant FR clair et concret. Réponds en <= 800 caractères. Pose 1 question max si besoin.";

    // 6) Modèle stable/compatible
    const model = "gpt-4o-mini";

    // 7) Appel Responses API (format 'input' + input_text)
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: true,
        conversation,
        input: [
          { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
          { role: "user",   content: [{ type: "input_text", text: message }] }
        ]
      }),
    });

    // 8) Gestion d'erreur bavarde (diagnostic)
    const text = await r.text();
    if (!r.ok) {
      let hint = "Erreur API OpenAI";
      try { hint = JSON.parse(text)?.error?.message || hint; } catch {}
      return res.status(500).json({ reply: `Erreur OpenAI (${r.status}) : ${hint}` });
    }

    // 9) Extraction de la réponse
    const data = JSON.parse(text);
    const reply =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "Désolé, je n’ai pas pu répondre cette fois.";

    return res.status(200).json({ reply, session: session || null });
  } catch (e) {
    // 10) Filet de sécurité
    return res.status(500).json({ reply: "Oups, une erreur est survenue." });
  }
}
