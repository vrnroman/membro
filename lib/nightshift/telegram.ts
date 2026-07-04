// The only place Membro talks to the outside world on the owner's behalf: it
// POSTs one plain-text line to the Telegram Bot API. Token and chat id live in
// the VM `.env` only, never the repo. Plain text (no parse_mode) so a name with
// an underscore or asterisk can never break formatting.

export type SendResult = { ok: true; status: number; messageId?: number };

// A failed send. `retryable` distinguishes a transient failure (network blip,
// Telegram 5xx) that a retry might fix from a permanent one (bad token, chat not
// found, message too long) where retrying just wastes the day.
export class TelegramSendError extends Error {
  retryable: boolean;
  status?: number;
  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = "TelegramSendError";
    this.retryable = retryable;
    this.status = status;
  }
}

const API = "https://api.telegram.org";
const TIMEOUT_MS = 12000; // Node fetch has no default timeout; bound it ourselves.

export async function sendTelegramMessage(text: string): Promise<SendResult> {
  // Trim: a trailing newline/space from `echo >> .env` is truthy but would break
  // the URL/chat_id and fail every send otherwise.
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) {
    throw new TelegramSendError("telegram: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set (VM .env)", false);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: controller.signal,
    });
  } catch (e) {
    // Network-level failure (DNS, timeout/abort, offline): transient, retryable.
    console.error(`[nudge] telegram network error: ${(e as Error).message}`);
    throw new TelegramSendError(`network: ${(e as Error).message}`, true);
  } finally {
    clearTimeout(timer);
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
    // 5xx (or a body with no HTTP failure) is transient; 4xx (bad token, chat not
    // found, message too long) is permanent and must not be retried.
    const retryable = res.status >= 500;
    throw new TelegramSendError(`telegram send failed: ${res.status} ${body.description ?? raw}`, retryable, res.status);
  }

  return { ok: true, status: res.status, messageId: body.result?.message_id };
}
