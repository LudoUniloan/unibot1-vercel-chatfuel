// Version stable Vercel — Assistant Unibot
// Nécessite : OPENAI_API_KEY et OPENAI_ASSISTANT_ID

export const config = { runtime: 'nodejs' };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;
const DEBUG = String(process.env.DEBUG_LOGS || '').toLowerCase() === 'true';

// --- Fonctions utilitaires ---
function log(tag, obj) {
  if (DEBUG) console.log(`[replyv2:${tag}]`, obj);
}

function resj(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function s(v) {
  if (v == null) return '';
  const t = String(v).trim();
  if (!t || t.toLowerCase() === 'null' || t.toLowerCase() === 'undefined') return '';
  return t;
}

function pickMessage(body) {
  const c = [
    body.message,
    body.user_text,
    body['last user freeform'],
    body['last user freeform input'],
  ];
  for (const x of c) {
    const y = s(x);
    if (y) return y;
  }
  return '';
}

function normalizeThreadId(x) {
  const t = s(x);
  return t.startsWith('thread_') ? t : '';
}

// --- Appel OpenAI ---
async function openai(path, init) {
  const url = `https://api.openai.com/v1/${path}`;
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };

  const r = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
  const txt = await r.text().catch(() => '');
  if (!r.ok) {
    throw new Error(`OpenAI ${r.status}: ${txt || r.statusText}`);
  }
  try {
    return JSON.parse(txt || '{}');
  } catch {
    return {};
  }
}

// --- Fonctions Assistant ---
async function ensureThread(idIn) {
  const ok = normalizeThreadId(idIn);
  if (ok) return ok;
  const t = await openai('threads', { method: 'POST', body: JSON.stringify({}) });
  return t.id;
}

async function postUserMsg(threadId, content) {
  if (!content) return;
  await openai(`threads/${threadId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role: 'user', content }),
  });
}

async function runAssistant(threadId) {
  const run = await openai(`threads/${threadId}/runs`, {
    method: 'POST',
    body: JSON.stringify({ assistant_id: OPENAI_ASSISTANT_ID }),
  });

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 800));
    const cur = await openai(`threads/${threadId}/runs/${run.id}`, { method: 'GET' });
    if (cur.status === 'completed' || cur.status === 'requires_action') return cur;
    if (['failed', 'cancelled', 'expired'].includes(cur.status)) {
      throw new Error(`Run status: ${cur.status}`);
    }
  }
  throw new Error('Run polling timeout');
}

async function lastAssistantText(threadId) {
  const data = await openai(`threads/${threadId}/messages?limit=10`, { method: 'GET' });
  for (const m of data.data || []) {
    if (m.role !== 'assistant') continue;
    const parts = (m.content || []).filter((p) => p.type === 'text');
    if (parts.length)
      return parts.map((p) => p.text?.value || '').filter(Boolean).join('\n\n').trim();
  }
  return '';
}

// --- Handler principal ---
export default async function handler(req) {
  try {
    if (req.method !== 'POST') return resj({ reply: 'Not allowed' }, 405);

    if (!OPENAI_API_KEY || !OPENAI_ASSISTANT_ID) {
      log('env-missing', { hasKey: !!OPENAI_API_KEY, hasAssistant: !!OPENAI_ASSISTANT_ID });
      return resj(
        { reply: 'Config manquante: OPENAI_API_KEY ou OPENAI_ASSISTANT_ID', conv_id: null },
        500
      );
    }

    // Lecture du body
    let raw = '';
    try {
      raw = await req.text();
    } catch {}
    let body = {};
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      body = {};
    }

    const userId = s(body.user_id || body.userId || body.uid);
    const convIdIn = s(body.conv_id || body.thread_id || body.convId);
    const message = pickMessage(body);

    log('input', { userId, convIdIn, message });

    // Création ou récupération du thread
    const threadId = await ensureThread(convIdIn);
    log('thread', threadId);

    // Envoi du message utilisateur
    await postUserMsg(threadId, message || '');

    // Lancement de l’assistant
    const run = await runAssistant(threadId);
    log('run', run.status);

    // Lecture de la réponse
    let reply = await lastAssistantText(threadId);
    if (!reply) reply = "Je n’ai pas bien compris. Peux-tu reformuler ?";

    return resj({ reply, conv_id: threadId, version: 'assistant_v11' });
  } catch (e) {
    log('fatal', e?.stack || String(e));
    return resj(
      { reply: `Erreur: ${String(e?.message || e)}`, conv_id: null, version: 'assistant_v11' },
      500
    );
  }
}
