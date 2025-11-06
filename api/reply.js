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

function normalizeConvId(conv_id, user_id) {
  if (!conv_id || typeof conv_id !== "string" || conv_id.trim() === "" || conv_id === "null")
    return `conv_${String(user_id || "user").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}`;
  // si ça ne commence pas par conv, on le reformate proprement
  if (!conv_id.startsWith("conv")) {
    const clean = conv_id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 50);
    return `conv_${clean}`;
  }
  return conv_id.slice(0, 64);
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
    if (req.method !== "POST")
      return res.status(405).json({ error: "Method not allowed" });

    const { user_id, session, conv_id } = req.body || {};
    const msg = pickMessage(req.body);

    if (!user_id || !msg) {
      return res.status(400).json({
        reply:
          "Ton message semble vide. Dis-moi ce que tu veux savoir et je t’aide 🙂",
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res
        .status(500)
        .json({ reply: "Config manquante: OPENAI_API_KEY" });
    }

    const systemPrompt =
      "Tu es UNIBOT, assistant francophone clair et concret. " +
      "Ne redis pas 'Salut' si la conversation est entamée. " +
      "Réponds directement, en moins de 800 caractères si possible.";

    // ✅ on génère toujours un conv_id valide
    const conversation = normalizeConvId(conv_id, user_id);

    const base = {
      model: "gpt-4o-mini",
      store: true,
      conversation, // garanti valide
      input: [
        { role: "system", content: [{ type: "input_text", text: systemPrompt }] },
        { role: "user", content: [{ type: "input_text", text: msg }] },
      ],
    };

    let { ok, status, text } = await callOpenAI(base, process.env.OPENAI_API_KEY);

    if (!ok && status === 404) {
      // recrée une conv propre
      const retry = { ...base };
      delete retry.conversation;
      ({ ok, status, text } = await callOpenAI(
        retry,
        process.env.OPENAI_API_KEY
      ));
    }

    if (!ok) {
      let hint = "Erreur API OpenAI";
      try {
        hint = JSON.parse(text)?.error?.message || hint;
      } catch {}
      return res.status(500).json({
        reply: `Erreur OpenAI (${status}) : ${hint}`,
      });
    }

    const data = JSON.parse(text);
    const reply =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "Désolé, je n’ai pas pu répondre cette fois.";

    const newConv = extractConvId(data, base);
    return res.status(200).json({
      reply,
      conv_id: newConv || conversation,
      session: session || null,
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ reply: "Oups, une erreur est survenue." });
  }
}
