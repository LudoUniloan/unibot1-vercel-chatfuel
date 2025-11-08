// api/reply.js — Assistant Unibot + conversation par utilisateur
// Vars requises : OPENAI_API_KEY, UNIBOT_ASSISTANT_ID

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (req.body && typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return {}; } }
  return {};
}
function pickMessage(body) {
  const { message, user_text, "last user freeform": f1, last_user_freeform: f2, "last user freeform input": f3 } = body || {};
  return (message ?? user_text ?? f1 ?? f2 ?? f3 ?? "").toString().trim();
}
function wantsReset(text) {
  const t = (text || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g,"")
    .toLowerCase().replace(/[!?.,;:()"'`]+/g,"").trim();
  return t === "reset" || t === "/new" || t.includes("nouvelle question") || t.includes("autre sujet");
}
async function call(payload) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = readBody(req);
    const user_id = String(body.user_id || "").trim();
    const msg = pickMessage(body);

    if (!user_id || !msg) return res.status(400).json({ reply: "Ton message semble vide. Que puis-je faire pour toi ?" });
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ reply: "Config manquante: OPENAI_API_KEY" });
    if (!process.env.UNIBOT_ASSISTANT_ID) return res.status(500).json({ reply: "Config manquante: UNIBOT_ASSISTANT_ID" });

    // Conversation fixe par user (reset si demandé)
    const rawConv = wantsReset(msg) ? "" : (body.conv_id || "");
    const conv_id = rawConv
      ? (rawConv.startsWith("conv") ? rawConv.slice(0, 64) : `conv_${rawConv}`.slice(0, 64))
      : `conv_${user_id}`.slice(0, 64);

    const payload = {
      assistant_id: process.env.UNIBOT_ASSISTANT_ID, // ✅ pas de "model" ici
      store: true,
      conversation: conv_id,
      input: [{ role: "user", content: [{ type: "input_text", text: msg }] }],
    };

    // 1) essai avec conversation
    let { ok, status, text } = await call(payload);

    // 2) si 404 sur la conversation, on réessaie sans la forcer
    if (!ok && status === 404) {
      const retry = { ...payload };
      delete retry.conversation;
      ({ ok, status, text } = await call(retry));
    }

    if (!ok) {
      let hint = "Erreur OpenAI";
      try { hint = JSON.parse(text)?.error?.message || hint; } catch {}
      if (status === 429) return res.status(429).json({ reply: "Trop de demandes pour l’instant. Réessaie dans un instant 🙏" });
      return res.status(500).json({ reply: `Erreur OpenAI (${status}) : ${hint}` });
    }

    let data;
    try { data = JSON.parse(text); }
    catch { return res.status(500).json({ reply: "Réponse OpenAI illisible." }); }

    const reply =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "Désolé, je n’ai pas pu répondre cette fois.";

    const apiConv =
      data?.conversation?.id ||
      data?.response?.conversation_id ||
      data?.output?.[0]?.conversation_id ||
      conv_id;

    return res.status(200).json({ reply, conv_id: apiConv });
  } catch {
    return res.status(500).json({ reply: "Oups, une erreur est survenue." });
  }
}
