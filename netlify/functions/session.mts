import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

type Answers = Record<string, string>;

interface SessionRecord {
  createdAt: string;
  answers: { A: Answers | null; B: Answers | null };
  viewed: { A: boolean; B: boolean };
}

function computeCommon(a: Answers, b: Answers) {
  const common: { question: string; answer: string }[] = [];
  for (const q of Object.keys(a)) {
    if (a[q] && a[q] === b[q]) {
      common.push({ question: q, answer: a[q] });
    }
  }
  return common;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export default async (req: Request, context: Context) => {
  const store = getStore("sessions", { consistency: "strong" });
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  try {
    // Une personne A crée une session avec ses réponses, verrouillées dès l'envoi.
    if (req.method === "POST" && action === "create") {
      const body = await req.json();
      const answers = body?.answers;
      if (!answers || typeof answers !== "object") {
        return json({ error: "invalid-answers" }, 400);
      }
      const sessionId = crypto.randomUUID();
      const record: SessionRecord = {
        createdAt: new Date().toISOString(),
        answers: { A: answers, B: null },
        viewed: { A: false, B: false }
      };
      await store.setJSON(sessionId, record);
      return json({ sessionId });
    }

    // La personne B soumet ses réponses une seule fois pour cette session.
    if (req.method === "POST" && action === "submitB") {
      const body = await req.json();
      const { sessionId, answers } = body || {};
      if (!sessionId || !answers || typeof answers !== "object") {
        return json({ error: "invalid-request" }, 400);
      }
      const record = (await store.get(sessionId, { type: "json" })) as SessionRecord | null;
      if (!record) return json({ error: "not-found" }, 404);
      if (record.answers.B !== null) return json({ error: "already-submitted" }, 409);

      record.answers.B = answers;
      await store.setJSON(sessionId, record);
      return json({ ok: true });
    }

    // Vérifie si les deux ont répondu ; le résultat n'est renvoyé qu'une seule fois par rôle.
    if (req.method === "GET" && action === "status") {
      const sessionId = url.searchParams.get("sessionId");
      const role = url.searchParams.get("role");
      if (!sessionId || (role !== "A" && role !== "B")) {
        return json({ error: "invalid-request" }, 400);
      }
      const record = (await store.get(sessionId, { type: "json" })) as SessionRecord | null;
      if (!record) return json({ error: "not-found" }, 404);

      if (!record.answers.A || !record.answers.B) {
        return json({ ready: false });
      }
      if (record.viewed[role]) {
        return json({ ready: true, alreadyViewed: true });
      }
      record.viewed[role] = true;
      await store.setJSON(sessionId, record);
      const common = computeCommon(record.answers.A, record.answers.B);
      return json({ ready: true, common });
    }

    return json({ error: "unknown-action" }, 400);
  } catch (e) {
    return json({ error: "server-error" }, 500);
  }
};

export const config: Config = {
  path: "/api/session"
};
