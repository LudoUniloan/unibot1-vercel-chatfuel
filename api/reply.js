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

function extractConvId(data, payload) {
  // essaye différentes formes possibles
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
    if (req.method !== "POST") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const {
      user_id,
      session,
      conv_id,
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
        reply: "Ton message semble vide. Écris ta question et je t’aide 🙂",
      });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ reply: "Config manquante: OPENAI_API_KEY" });
    }

    const systemPrompt =
      "Tu es UNIBOT, assistant francophone clair et concret. " +
      "Ne redis pas 'Salut' à chaque message une fois la conversation entamée. " +
      "Réponds directement, en moins de 800 caractères si possible.";

    // --- construit le payload
    const payload = {
      model: "gpt-4o-mini",
      store: true,
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: [{ type: "input_text", text: msg }] },
      ],
    };

    // n’ajoute conversation QUE si on a un conv_id non vide
    const normalized = (conv_id ?? "").toString().trim().toLowerCase();
    const hasValidConv = normalized && normalized !== "null" && normalized !== "undefined";
    if (hasValidConv) {
      const safe = String(conv_id).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
      payload.conversation = safe.startsWith("conv") ? safe : `conv_${safe}`;
    }

    // --- 1er appel
    let { ok, status, text } = await callOpenAI(payload, process.env.OPENAI_API_KEY);

    // --- Retry automatique si la conv fournie n'existe plus (404)
    if (!ok && status === 404 && payload.conversation) {
      const keepMsg = payload.input; // garde le même message
      const payloadNoConv = { ...payload };
      delete payloadNoConv.conversation;
      ({ ok, status, text } = await callOpenAI(payloadNoConv, process.env.OPENAI_API_KEY));
      // si ça marche, on remplacera conv_id par celui retourné
    }

    if (!ok) {
      let hint = "Erreur API OpenAI";
      try { hint = JSON.parse(text)?.error?.message || hint; } catch {}
      if (status === 429) {
        return res.status(429).json({
          reply: "Beaucoup de demandes en ce moment 😅 Réessaie dans une minute.",
        });
      }
      return res.status(500).json({ reply: `Erreur OpenAI (${status}) : ${hint}` });
    }

    const data = JSON.parse(text);

    const reply =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "Désolé, je n’ai pas pu répondre cette fois.";

    const newConvId = extractConvId(data, payload);

    // réponse: ne renvoyer conv_id QUE s'il est défini
    const out = { reply };
    if (newConvId && typeof newConvId === "string" && newConvId.trim()) {
      out.conv_id = newConvId;
    } else if (payload.conversation) {
      // si on avait fourni une conv et qu'OpenAI n'a rien renvoyé, renvoie celle-ci
      out.conv_id = payload.conversation;
    }
    if (session) out.session = session;

    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ reply: "Oups, une erreur est survenue." });
  }
}
