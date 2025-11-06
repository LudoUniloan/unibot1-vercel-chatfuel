// api/reply.js
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { user_id, message, session } = req.body || {};
    if (!user_id || !message) return res.status(400).json({ error: "Missing user_id or message" });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ reply: "Config manquante: OPENAI_API_KEY" });

    const systemPrompt = "Tu es UNIBOT, assistant FR clair et concret. Réponds en <= 800 caractères.";
    const model = "gpt-4o-mini";

    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: true,
        conversation: `wa:${user_id}`,
        input: [
          { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
          { role: "user",   content: [{ type: "input_text", text: message }] }
        ]
      }),
    });

    const text = await r.text();
    if (!r.ok) {
      let hint = "Erreur API OpenAI";
      try { hint = JSON.parse(text)?.error?.message || hint; } catch {}
      return res.status(500).json({ reply: `Erreur OpenAI (${r.status}) : ${hint}` });
    }

    const data = JSON.parse(text);
    const reply = data?.output?.[0]?.content?.[0]?.text ?? data?.output_text ?? "Désolé, je n’ai pas pu répondre cette fois.";
    return res.status(200).json({ reply, session: session || null });
  } catch (e) {
    return res.status(500).json({ reply: "Oups, une erreur est survenue." });
  }
}
