// The only place Membro talks to the outside world on the owner's behalf: it
// POSTs one plain-text line to the Telegram Bot API. Token and chat id live in
// the VM `.env` only, never the repo. Plain text (no parse_mode) so a name with
// an underscore or asterisk can never break formatting.

export type SendResult = { ok: true; status: number; messageId?: number };

const API = "https://api.telegram.org";

export async function sendTelegramMessage(text: string): Promise<SendResult> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    throw new Error("telegram: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set (VM .env)");
  }

  let res: Response;
  try {
    res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
  } catch (e) {
    // Network-level failure (DNS, timeout, offline). RCA-ready: log and rethrow
    // so the caller does NOT record the day as sent.
    console.error(`[nudge] telegram network error: ${(e as Error).message}`);
    throw e;
  }

  const raw = await res.text();
  let body: { ok?: boolean; description?: string; result?: { message_id?: number } } = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* leave body empty; raw is logged below on failure */
  }

  if (!res.ok || !body.ok) {
    console.error(`[nudge] telegram send failed: status=${res.status} body=${raw}`);
    throw new Error(`telegram send failed: ${res.status} ${body.description ?? raw}`);
  }

  return { ok: true, status: res.status, messageId: body.result?.message_id };
}
