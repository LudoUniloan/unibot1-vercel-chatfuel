// api/reply.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { user_id, message, session } = req.body || {};
    if (!user_id || !message) {
      return res.status(400).json({ error: "Missing user_id or message" });
    }

    const systemPrompt = `
Tu es UNIBOT, un assistant francophone clair et concret.
Réponds en 800 caractères max quand c'est possible.
Pose au besoin une seule question de clarification avant d'agir.
`;

    // Appel vers OpenAI Responses API
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        store: true,
        conversation: `wa:${user_id}`,
        input: [
          { role: "system", content: [{ type: "text", text: systemPrompt }] },
          { role: "user", content: [{ type: "text", text: message }] }
        ]
      })
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error("OpenAI error:", txt);
      return res.status(500).json({ reply: "Désolé, souci technique. Réessaie plus tard." });
    }

    const data = await r.json();
    const reply =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "Désolé, je n’ai pas pu répondre cette fois.";

    res.status(200).json({ reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ reply: "Oups, une erreur est survenue." });
  }
}
