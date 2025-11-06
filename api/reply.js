// api/reply.js
export default async function handler(req, res) {
  try {
    // 1) Autoriser uniquement POST
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    // 2) Lire le payload (et tolérer différents noms éventuels)
    const {
      user_id,
      session,
      conv_id,
      message: rawMessage,
      user_text,
      "last user freeform": lastUserFreeform,
      last_user_freeform,
    } = req.body || {};

    // Unifier le message
    const msg =
      (rawMessage ?? user_text ?? lastUserFreeform ?? last_user_freeform ?? "")
        .toString()
        .trim();

    if (!user_id || !msg) {
      return res.status(400).json({
        error: "Missing user_id or message",
        reply:
          "Il semble que ton message soit vide. Écris ta question et je t’aide 🙂",
      });
    }

    // 3) Clé OpenAI
    if (!process.env.OPENAI_API_KEY) {
      return res
        .status(500)
        .json({ reply: "Config manquante: OPENAI_API_KEY" });
    }

    // 4) System prompt : style, contraintes, et pas de salutation à chaque tour
    const systemPrompt =
      "Tu es UNIBOT, un assistant francophone clair et concret. " +
      "Ne redis jamais 'Salut' à chaque message si la conversation est entamée. " +
      "Va droit au but, exemples chiffrés si utile. " +
      "Réponds idéalement en moins de 800 caractères.";

    // 5) Construire le payload Responses API
    const payload = {
      model: "gpt-4o-mini",
      store: true,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: [{ type: "input_text", text: msg }] },
      ],
    };

    // 6) Gestion de la conversation : on n’envoie 'conversation'
    //    QUE si on a réellement un conv_id valable.
    const normalized = (conv_id ?? "").toString().trim().toLowerCase();
    const hasValidConv =
      normalized && normalized !== "null" && normalized !== "undefined";

    if (hasValidConv) {
      // L’API attend un id [A-Za-z0-9_-] qui commence par "conv"
      const safe = String(conv_id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
      payload.conversation = safe.startsWith("conv") ? safe : `conv_${safe}`;
    }

    // 7) Appel OpenAI
    const r = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await r.text();

    // 8) Erreurs : renvoyer seulement 'reply' (ne pas écraser conv_id côté Chatfuel)
    if (!r.ok) {
      let hint = "Erreur API OpenAI";
      try {
        hint = JSON.parse(text)?.error?.message || hint;
      } catch {}
      // 429 → message plus doux
      if (r.status === 429) {
        return res.status(429).json({
          reply:
            "Je reçois beaucoup de demandes en ce moment 😅 Réessaie dans une minute.",
        });
      }
      return res
        .status(500)
        .json({ reply: `Erreur OpenAI (${r.status}) : ${hint}` });
    }

    // 9) Extraire la réponse et l’ID de conversation
    const data = JSON.parse(text);

    const reply =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "Désolé, je n’ai pas pu répondre cette fois.";

    const returnedConvId =
      data?.conversation?.id ||
      data?.output?.[0]?.conversation_id ||
      payload.conversation ||
      null;

    // 10) Construire la réponse à Chatfuel
    const out = { reply };

    // Renvoyer conv_id uniquement s’il est connu (pour ne pas écraser la valeur existante avec null)
    if (returnedConvId && typeof returnedConvId === "string" && returnedConvId.trim()) {
      out.conv_id = returnedConvId;
    }

    // (Optionnel) renvoyer la session si tu en as l’usage
    if (session) out.session = session;

    return res.status(200).json(out);
  } catch (e) {
    // Filet de sécurité
    return res.status(500).json({ reply: "Oups, une erreur est survenue." });
  }
}
