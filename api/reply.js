// api/reply.js — Responses API avec previous_response_id

// ------- Utils -------
function pickMessage(body) {
  const {
    message,
    user_text,
    "last user freeform": f1,
    last_user_freeform: f2,
    "last user freeform input": f3,
  } = body || {};
  return (message ?? user_text ?? f1 ?? f2 ?? f3 ?? "").toString().trim();
}
function wantsReset(text) {
  const t = (text || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[!?.,;:()"'`]+/g, "").trim();
  return t === "reset" || t === "/new" || t.includes("nouvelle question") || t.includes("autre sujet");
}

async function callResponses(payload) {
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  const txt = await r.text();
  return { ok: r.ok, status: r.status, txt };
}

// ------- Handler -------
export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = req.body || {};
    const user_id = String(body.user_id || "").trim();
    const msg = pickMessage(body);

    if (!user_id || !msg) {
      return res.status(400).json({ reply: "Ton message semble vide. Que puis-je faire pour toi ?" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ reply: "Config manquante: OPENAI_API_KEY" });
    }

    // ----- Construction du payload -----
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";

    // Si reset demandé, on repart sans previous_response_id
    const previous = wantsReset(msg) ? null : (body.resp_id || null);

    const payload = {
      model,            // ✅ toujours présent (finit l'erreur "Missing model")
      store: true,      // demande à OpenAI de persister la réponse pour pouvoir chaîner
      ...(previous ? { previous_response_id: String(previous) } : {}),
      input: [
        // Astuce : un mini system pour stabiliser le ton
        { role: "system", content: [{ type: "input_text", text: "Tu es Unibot. Réponds en français, clair et concis." }] },
        { role: "user", content: [{ type: "input_text", text: msg }] },
      ],
    };

    // ----- Appel API -----
    let { ok, status, txt } = await callResponses(payload);
    if (!ok) {
      let msgErr = "Erreur OpenAI";
      try { msgErr = JSON.parse(txt)?.error?.message || msgErr; } catch {}
      return res.status(500).json({ reply: `Erreur OpenAI (${status}) : ${msgErr}` });
    }

    const data = JSON.parse(txt);

    // ----- Extraction réponse + id pour chaîner -----
    const reply =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "Désolé, je n’ai pas pu répondre cette fois.";

    // L’ID à réutiliser au tour suivant (chaînage Responses API)
    const resp_id = data?.id || null;

    return res.status(200).json({
      reply,
      resp_id,        // <= à stocker côté Chatfuel pour le prochain tour
      // conv_id laissé de côté (inutile en Responses API si on chaîne par previous_response_id)
    });
  } catch (e) {
    return res.status(500).json({ reply: "Oups, une erreur est survenue." });
  }
}
