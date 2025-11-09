// Unibot Assistant (Assistants v2) — Vercel Node.js runtime

export const config = { runtime: 'nodejs' };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_ASSISTANT_ID = process.env.OPENAI_ASSISTANT_ID;
const DEBUG = String(process.env.DEBUG_LOGS || '').toLowerCase() === 'true';

// --------- Helpers ----------
const log = (tag, data) => { if (DEBUG) console.log(`[replyv2:${tag}]`, data); };

const send = (res, obj, status = 200) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(obj));
};

const clean = (v) => {
  if (v == null) return '';
  const t = String(v).trim();
  if (!t || t.toLowerCase() === 'null' || t.toLowerCase() === 'undefined') return '';
  return t;
};

const pickMessage = (body) => {
  const cands = [
    body.message,
    body.user_text,
    body['last user freeform'],
    body['last user freeform input'],
  ];
  for (const c of cands) {
    const t = clean(c);
    if (t) return t;
  }
  return '';
};

const normalizeThreadId = (x) => {
  const t = clean(x);
  return t.startsWith('thread_') ? t : '';
};

const readBody = async (req) => {
  // Chatfuel envoie bien du JSON, mais on reste robuste si req.body est vide
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on('data', (c) => chunks.push(c));
    req.on('end', resolve);
    req.on('error', reject);
  });
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw || '{}'); } catch { return {}; }
};

// --------- OpenAI wrappers ----------
async function callOpenAI(path, init) {
  const url = `https://api.openai.com/v1/${path}`;
  const headers = {
    Authorization: `Bearer ${OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
    'OpenAI-Beta': 'assistants=v2',
  };
  const resp = await fetch(url, { ...init, headers: { ...headers, ...(init?.headers || {}) } });
  const txt = await resp.text().catch(() => '');
  if (!resp.ok) throw new Error(`OpenAI ${resp.status}: ${txt || resp.statusText}`);
  try { return JSON.parse(txt || '{}'); } catch { return {}; }
}

async function ensureThread(threadIn) {
  const ok = normalizeThreadId(threadIn);
  if (ok) return ok;
  const t = await callOpenAI('threads', { method: 'POST', body: JSON.stringify({}) });
  return t.id;
}

async function postUserMsg(threadId, content) {
  await callOpenAI(`threads/${threadId}/messages`, {
    method: 'POST',
    body: JSON.stringify({ role: 'user', content: content || '' }),
  });
}

async function runAssistant(threadId) {
  const run = await callOpenAI(`threads/${threadId}/runs`, {
    method: 'POST',
    body: JSON.stringify({ assistant_id: OPENAI_ASSISTANT_ID }),
  });

  // Polling simple
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 800));
    const cur = await callOpenAI(`threads/${threadId}/runs/${run.id}`, { method: 'GET' });
    if (cur.status === 'completed' || cur.status === 'requires_action') return cur;
    if (['failed', 'cancelled', 'expired'].includes(cur.status)) {
      throw new Error(`Run status: ${cur.status}`);
    }
  }
  throw new Error('Run polling timeout');
}

async function readAssistantReply(threadId) {
  const data = await callOpenAI(`threads/${threadId}/messages?limit=10`, { method: 'GET' });
  for (const m of data.data || []) {
    if (m.role !== 'assistant') continue;
    const parts = (m.content || []).filter((p) => p.type === 'text');
    if (parts.length) {
      return parts.map((p) => (p.text?.value || '')).filter(Boolean).join('\n\n').trim();
    }
  }
  return '';
}

// --------- Handler ----------
export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return send(res, { reply: 'Not allowed' }, 405);

    if (!OPENAI_API_KEY || !OPENAI_ASSISTANT_ID) {
      log('env-missing', { hasKey: !!OPENAI_API_KEY, hasAssistant: !!OPENAI_ASSISTANT_ID });
      return send(res, {
        reply: 'Config manquante: OPENAI_API_KEY ou OPENAI_ASSISTANT_ID',
        conv_id: null,
      }, 500);
    }

    const body = await readBody(req);
    const userId   = clean(body.user_id || body.userId || body.uid);
    const convIn   = clean(body.conv_id || body.thread_id || body.convId);
    const message  = pickMessage(body);

    log('input', { userId, convIn, message });

    const threadId = await ensureThread(convIn);
    log('thread', threadId);

    await postUserMsg(threadId, message || '');
    const run = await runAssistant(threadId);
    log('run', run.status);

    let reply = await readAssistantReply(threadId);
    if (!reply) reply = "Je n’ai pas bien compris. Peux-tu reformuler ?";

    return send(res, { reply, conv_id: threadId, version: 'assistant_v12' });
  } catch (e) {
    log('fatal', e?.stack || String(e));
    return send(res, {
      reply: `Erreur: ${String(e?.message || e)}`,
      conv_id: null,
      version: 'assistant_v12'
    }, 500);
  }
}
