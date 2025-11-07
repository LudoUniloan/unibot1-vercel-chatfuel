// api/reply.js

// ====== Config & limites ======
const DAILY = new Map(); // user_id -> { day: 'YYYY-MM-DD', count: number }
const LAST_SEEN = new Map(); // user_id -> timestamp

const DAILY_LIMIT = parseInt(process.env.DAILY_LIMIT || "20", 10);
const TZ_OFFSET_MIN = parseInt(process.env.TZ_OFFSET_MIN || "0", 10);
const IDLE_RESET_MIN = parseInt(process.env.IDLE_RESET_MIN || "30", 10);

const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini"; // fallback si pas d'assistant
const HAS_ASSISTANT = !!process.env.UNIBOT_ASSISTANT_ID;

// ====== Utilitaires temps ======
function todayKeyUTC() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function secondsUntilNextMidnightUTC() {
  const now = new Date();
  const next = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1, 0, 0, 0
  ));
  return Math.max(1, Math.ceil((next - now) / 1000));
}
function secondsUntilNextMidnightLocalOffset() {
  if (TZ_OFFSET_MIN === 0) return secondsUntilNextMidnightUTC();
  const now = new Date();
  const localMs = now.getTime() + TZ_OFFSET_MIN * 60 * 1000;
  const local = new Date(localMs);
  const nextLocalMidnight =
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 0, 0, 0)
    - TZ_OFFSET_MIN * 60 * 1000;
  return Math.max(1, Math.ceil((nextLocalMidnight - now.getTime()) / 1000));
}

// ====== Rate limit quotidien ======
function checkDailyLimit(userId) {
  const key = String(userId);
  const day = todayKeyUTC();
  const entry = DAILY.get(key);
  if (!entry || entry.day !== day) {
    DAILY.set(key, { day, count: 0 });
  }
  const e = DAILY.get(key);
  if (e.count >= DAILY_LIMIT) {
    return { ok: false, retryAfter: secondsUntilNextMidnightLocalOffset() };
  }
  e.count += 1;
  return { ok: true };
}

// ====== Inactivité / reset auto ======
function idleTooLong(userId, minutes = IDLE_RESET_MIN) {
  const now = Date.now();
  const last = LAST_SEEN.get(userId) || 0;
  LAST_SEEN.set(userId, now);
  return minutes > 0 && (now - last) > minutes * 60 * 1000;
}

// ====== OpenAI Responses API ======
async function callOpenAI(payload) {
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

// ====== Helpers texte / conversation ======
function pickMessage(body) {
  const {
    message,
    user_text,
    "last user freeform": lastFreeform1,
    last_user_freeform: lastFreeform2,
    "last user freeform input": lastFreeform3,
  } = body || {};
  return (message ?? user_text ?? lastFreeform1 ?? lastFreeform2 ?? lastFreeform3 ?? "")
    .toString()
    .replace(/\s+/g, " ")
    .trim();
}
function normalizeConvId(conv_id, user_id) {
  if (!conv_id || typeof conv_id !== "string" || !conv_id.trim() || conv_id === "null") {
    return `conv_${String(user_id || "user").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}`;
  }
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
function makeNewConvId(userId) {
  const base = String(userId || "user").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40);
  return `conv_${base}_${Date.now()}`;
}
function wantsReset(text) {
  const t = (text || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[!?.,;:()\[\]{}"'`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (
    t === "reset" ||
    t === "/new" ||
    t.includes("nouvelle question") ||
    t.includes("autre sujet") ||
    t.includes("changement de sujet") ||
    t.startsWith("nouveau sujet")
  );
}

// ====== Handler ======
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

    // ---- Rate limit par utilisateur
    const rl = checkDailyLimit(user_id);
    if (!rl.ok) {
      res.setHeader("Retry-After", rl.retryAfter.toString());
      return res.status(429).json({
        reply: `Tu as atteint la limite de ${DAILY_LIMIT} questions pour aujourd’hui. Réessaie dans ${rl.retryAfter}s 🙏`,
      });
    }

    // ---- Conversation & resets
    let conversation = normalizeConvId(conv_id, user_id);
    if (wantsReset(msg) || idleTooLong(user_id, IDLE_RESET_MIN)) {
      conversation = makeNewConvId(user_id);
    }

    // ---- Construire le payload Responses API
    // On fournit TOUJOURS un identifiant valide :
    //  - assistant_id si dispo
    //  - SINON model (fallback)
    const base = {
      store: true,
      conversation,
      input: [{ role: "user", content: [{ type: "input_text", text: msg }] }],
      ...(HAS_ASSISTANT
        ? { assistant_id: process.env.UNIBOT_ASSISTANT_ID }
        : { model: OPENAI_MODEL }),
    };

    // 1) Appel principal
    let { ok, status, text } = await callOpenAI(base);

    // 2) Si la conversation fournie n'existe pas (404), réessayer sans conversation pour en créer une
    if (!ok && status === 404) {
      const retry = { ...base };
      delete retry.conversation;
      ({ ok, status, text } = await callOpenAI(retry));
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

    const newConv = extractConvId(data, base);

    return res.status(200).json({
      reply,
      conv_id: newConv || conversation,
      session: session || null,
    });
  } catch (e) {
    return res.status(500).json({ reply: "Oups, une erreur est survenue." });
  }
}
