// api/reply.js — Unibot via Assistant API + previous_response_id

function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (req.body && typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return {};
}

function pickMessage(body) {
  const { message, user_text, "last user freeform": f1, last_user_freeform: f2, "last user freeform input": f3 } = body || {};
  return (message ?? user_text ?? f1 ?? f2 ?? f3 ?? "").toString().trim();
}

function wantsReset(text) {
  const t = (text || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[!?.,;:()"'`]+/g, "")
    .trim();
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
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

    const body = readBody(req);
    const user_id = String(body.user_id || "").trim();
    const msg = pickMessage(body);

    if (!user_id || !msg) {
      return res.status(400).json({ reply: "Ton message semble vide. Que puis-je faire pour toi ?" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ reply: "Config manquante: OPENAI_API_KEY" });
    }
    if (!process.env.UNIBOT_ASSISTANT_ID) {
      return res.status(500).json({ reply: "Config manquante: UNIBOT_ASSISTANT_ID" });
    }

    // Chaînage de contexte : previous_response_id (et non 'conversation')
    const previous = wantsReset(msg) ? null : (body.resp_id ? String(body.resp_id) : null);

    const base = {
      assistant_id: process.env.UNIBOT_ASSISTANT_ID, // ✅ force l'Assistant Unibot
      store: true,
      input: [
        { role: "user", content: [{ type: "input_text", text: msg }] }
      ],
      ...(previous ? { previous_response_id: previous } : {}),
    };

    // 1) Appel principal
    let { ok, status, text } = await callResponses(base);

    // 2) Si 404 (previous invalide/expiré), on réessaie sans previous_response_id (nouveau fil)
    if (!ok && status === 404 && previous) {
      const retry = { ...base };
      delete retry.previous_response_id;
      ({ ok, status, text } = await callResponses(retry));
    }

    if (!ok) {
      let hint = "Erreur OpenAI";
      try { hint = JSON.parse(text)?.error?.message || hint; } catch {}
      if (status === 429) {
        return res.status(429).json({ reply: "Trop de demandes en même temps. Réessaie dans un instant 🙏" });
      }
      return res.status(500).json({ reply: `Erreur OpenAI (${status}) : ${hint}` });
    }

    let data;
    try { data = JSON.parse(text); }
    catch { return res.status(500).json({ reply: "Réponse OpenAI illisible." }); }

    const reply =
      data?.output?.[0]?.content?.[0]?.text ??
      data?.output_text ??
      "Désolé, je n’ai pas pu répondre cette fois.";

    const resp_id = data?.id || null;

    return res.status(200).json({ reply, resp_id });
  } catch {
    return res.status(500).json({ reply: "Oups, une erreur est survenue." });
  }
}
