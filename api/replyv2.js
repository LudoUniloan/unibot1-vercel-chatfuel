// /api/reply_assistant.js
// Requiert sur Vercel :
//   - OPENAI_API_KEY       (clé API OpenAI)
//   - UNIBOT_ASSISTANT_ID  (id de l'assistant : asst_...)
// Utilisation : POST JSON { user_id, message, conv_id? }

const BASE = "https://api.openai.com/v1";

function asString(x) { return (x ?? "").toString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}

async function callOpenAI(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
      // 👇 obligatoire pour l'Assistants API v2
      "OpenAI-Beta": "assistants=v2",
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    // on remonte le message d'erreur OpenAI pour debug
    const txt = await r.text();
    throw new Error(`OpenAI ${r.status}: ${txt}`);
  }
  return r.json();
}

function pickAssistantText(msg) {
  // v2 : content = [{ type: 'output_text', 'text' : {...} }, ...]
  // on gère aussi les fallback possibles
  const parts = Array.isArray(msg?.content) ? msg.content : [];
  const chunks = parts.map(p => {
    if (p.type === "output_text" && p.output_text) return asString(p.output_text);
    if (p.type === "text" && p.text?.value)    return asString(p.text.value);
    if (typeof p.text === "string")            return p.text;
    return "";
  }).filter(Boolean);
  return chunks.join("\n").trim();
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Not allowed" });
  }

  try {
    const { user_id, message, conv_id } = await readBody(req);

    if (!user_id) {
      return res.status(400).json({ reply: "Paramètre user_id manquant.", conv_id: null, version: "assistant_v8" });
    }
    if (!message || !asString(message).trim()) {
      return res.status(200).json({ reply: "Votre message est vide.", conv_id: conv_id || null, version: "assistant_v8" });
    }
    if (!process.env.OPENAI_API_KEY || !process.env.UNIBOT_ASSISTANT_ID) {
      return res.status(200).json({ reply: "Configuration manquante (OPENAI_API_KEY / UNIBOT_ASSISTANT_ID).", conv_id: null, version: "assistant_v8" });
    }

    // conv_id déterministe (utile pour Chatfuel, même si l'Assistants API ne persiste pas encore entre runs sans stocker thread_id)
    const apiConv = (conv_id && /^conv_[A-Za-z0-9_-]+$/.test(conv_id))
      ? conv_id
      : `conv_${user_id}`;

    // 1) Créer un thread éphémère (si tu veux la vraie mémoire, il faudra persister thread.id côté BDD)
    const thread = await callOpenAI("/threads", {});

    // 2) Ajouter le message utilisateur
    await callOpenAI(`/threads/${thread.id}/messages`, {
      role: "user",
      content: [{ type: "input_text", text: asString(message) }]
    });

    // 3) Lancer un run avec ton assistant
    const run = await callOpenAI(`/threads/${thread.id}/runs`, {
      assistant_id: process.env.UNIBOT_ASSISTANT_ID
      // (les outils / files / instructions sont déjà configurés côté Assistant)
    });

    // 4) Polling jusqu'à completion (timeout ~ 24s max)
    let replyText = null;
    for (let i = 0; i < 40; i++) {
      const rr = await fetch(`${BASE}/threads/${thread.id}/runs/${run.id}`, {
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "assistants=v2"
        }
      });
      const data = await rr.json();

      if (data.status === "completed") {
        // 5) Récupérer les messages (le dernier assistant en tête de liste)
        const msgs = await fetch(`${BASE}/threads/${thread.id}/messages?limit=10`, {
          headers: {
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
            "OpenAI-Beta": "assistants=v2"
          }
        }).then(r => r.json());

        const assistantMsg = (msgs?.data || []).find(m => m.role === "assistant");
        replyText = assistantMsg ? pickAssistantText(assistantMsg) : null;
        break;
      }

      if (["failed", "cancelled", "expired"].includes(data.status)) {
        replyText = "Oups, une erreur est survenue.";
        break;
      }

      await sleep(600);
    }

    if (!replyText) replyText = "Désolé, délai dépassé.";

    return res.status(200).json({
      reply: replyText,
      conv_id: apiConv,
      version: "assistant_v8"
    });

  } catch (e) {
    return res.status(200).json({
      reply: `Erreur: ${e.message || e}`,
      conv_id: null,
      version: "assistant_v8"
    });
  }
}
