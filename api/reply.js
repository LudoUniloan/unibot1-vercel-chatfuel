// api/reply.js
async function callOpenAI(payload, apiKey) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

function pickMessage(body) {
  const {
    message,
    user_text,
    "last user freeform": lastFreeform1,
    last_user_freeform: lastFreeform2,
  } = body || {};
  return (message ?? user_text ?? lastFreeform1 ?? lastFreeform2 ?? "")
    .toString()
    .trim();
}

function extractConvId(data, payload) {
  return (
    data?.conversation?.id ||
    data?.response?.conversation_id ||
    data?.output?.[0]?.conversation_id ||
    payload?.conversation ||
    null
  );
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const { user_id, session, conv_id } = req.body || {};
    const msg = pickMessage(req.body);

    if (!user_id || !msg) {
      return res.status(400).json({
        reply: "Ton message semble vide. Dis-moi ce que tu veux savoir et je t’aide 🙂",
      });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ reply: "Config manquante: OPENAI_API_KEY" });
    }

    const systemPrompt =
      "Tu es UNIBOT, assistant francophone clair et concret. " +
      "Ne redis pas 'Salut' si la conversation est entamée. " +
      "Réponds directement, idéalement en < 800 caractères.";

    // Payload de base
    const base = {
      model: "gpt-4o-mini",
      store: true,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user",   content: [{ type: "input_text", text: msg }] },
      ],
    };

    // N'ajouter 'conversation' QUE si on a un conv_id non vide et non "null"/"undefined"
    const norm = (conv_id ?? "").toString().trim().toLowerCase();
    const hasConv = norm && norm !== "null" && norm !== "undefined";
    const payload = hasConv
      ? { ...base, conversation: String(conv_id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) }
      : { ...base };

    // 1er appel
    let { ok, status, text } = await callOpenAI(payload, process.env.OPENAI_API_KEY);

    // Si l'ID fourni n'existe pas (404), on REESSAIE sans conversation (création auto)
    if (!ok && status === 404 && payload.conversation) {
      const payloadNoConv = { ...base }; // même message, sans conversation
      ({ ok, status, text } = await callOpenAI(payloadNoConv, process.env.OPENAI_API_KEY));
    }

    if (!ok) {
      let hint = "Erreur API OpenAI";
      try { hint = JSON.parse(text)?.error?.message || hint; } catch {}
      if (status === 429) {
        return res.status(429).json({ reply: "Beaucoup de demandes en ce moment 😅 Réessaie dans une minute." });
      }
      return res.status(500).json({ reply: `Erreur OpenAI (${status}) : ${hint}` });
    }

    const data = JSON.parse(text);
    const reply =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "Désolé, je n’ai pas pu répondre cette fois.";

    const newConv = extractConvId(data, payload);
    const out = { reply };

    // NE renvoyer conv_id que s'il est connu (pour ne pas écraser côté Chatfuel)
    if (newConv && typeof newConv === "string" && newConv.trim()) out.conv_id = newConv;
    if (session) out.session = session;

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ reply: "Oups, une erreur est survenue." });
  }
}
