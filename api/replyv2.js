// /api/reply_assistant.js
// Variables requises sur Vercel: OPENAI_API_KEY, UNIBOT_ASSISTANT_ID
const BASE = "https://api.openai.com/v1";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

async function callOpenAI(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const e = await r.text();
    throw new Error(`OpenAI ${r.status}: ${e}`);
  }
  return r.json();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Not allowed" });
  }

  try {
    const { user_id, message, conv_id } = await readBody(req);
    if (!user_id) return res.status(400).json({ reply: "user_id manquant." });
    if (!message || !String(message).trim()) {
      return res.status(200).json({ reply: "Votre message est vide.", conv_id: conv_id || null, version: "assistant_v7" });
    }

    // 1) Conversation id déterministe + stable côté Chatfuel
    const apiConv = conv_id && /^conv_[A-Za-z0-9_-]+$/.test(conv_id)
      ? conv_id
      : `conv_${user_id}`; // fallback stable

    // 2) Créer un thread (si tu veux 1 thread par conv) — ici on utilise l’API Assistants v2
    // NB: un thread_id peut être réutilisé côté persistance si tu le stockes;
    // ici on repart de zéro car Chatfuel ne stocke pas de thread_id nativement.
    const thread = await callOpenAI("/threads", {});

    // 3) Ajouter le message utilisateur
    await callOpenAI(`/threads/${thread.id}/messages`, {
      role: "user",
      content: [
        { type: "input_text", text: message }
      ]
    });

    // 4) Lancer un run avec ton Assistant
    const run = await callOpenAI(`/threads/${thread.id}/runs`, {
      assistant_id: process.env.UNIBOT_ASSISTANT_ID,
      // Tools/file search, etc. sont déjà configurés sur l’assistant côté OpenAI
    });

    // 5) Polling simple jusqu’à completion
    let out = null;
    for (let i = 0; i < 40; i++) {
      const rr = await fetch(`${BASE}/threads/${thread.id}/runs/${run.id}`, {
        headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` }
      });
      const data = await rr.json();
      if (data.status === "completed") {
        // récupérer les messages
        const msgs = await fetch(`${BASE}/threads/${thread.id}/messages`, {
          headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` }
        }).then(r => r.json());
        // dernier message assistant
        const assistantMsg = (msgs.data || []).find(m => m.role === "assistant");
        let reply = "Désolé, je n'ai pas pu générer de réponse.";
        if (assistantMsg) {
          // contenu textuel (format tools beta)
          const parts = assistantMsg.content || [];
          const txt = parts
            .filter(p => p.type === "output_text" || p.type === "text" || p.text)
            .map(p => p.output_text || p.text?.value || p.text || "")
            .join("\n")
            .trim();
          if (txt) reply = txt;
        }
        out = reply;
        break;
      } else if (
        data.status === "failed" ||
        data.status === "cancelled" ||
        data.status === "expired"
      ) {
        out = "Oups, une erreur est survenue.";
        break;
      }
      await new Promise(r => setTimeout(r, 600));
    }

    if (!out) out = "Désolé, délai dépassé.";

    return res.status(200).json({
      reply: out,
      conv_id: apiConv,
      version: "assistant_v7"
    });
  } catch (e) {
    const m = String(e.message || e);
    return res.status(200).json({ reply: `Erreur: ${m}`, conv_id: null, version: "assistant_v7" });
  }
}
