// The engine-broken alert: the sibling of the quota alert, for the OTHER global
// outage class (read-only disk, dead login, missing binary). It differs in the one
// way that earned it its own code: a broken engine has no reset time, and a single
// AdapterError can be a one-off, so it must NOT speak on first sight — only once the
// fault has persisted past a wall-clock bar and is still failing.
process.env.MEMBRO_AI = "mock";
// Belt and braces: this suite exercises the real send path, so make a real send
// impossible regardless of environment (the VM's .env has live Telegram creds).
process.env.MEMBRO_DISABLE_ALERTS = "1";

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.MEMBRO_DATA_DIR = mkdtempSync(join(tmpdir(), "membro-engine-"));

import { setKv, getKv } from "@/lib/repo";
import {
  noteEngineFault,
  maybeAlertEngineFault,
  clearEngineFault,
  engineFaultPending,
} from "@/lib/nightshift/quota-alert";
import { describeGlobalFault } from "@/lib/ai/quota";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` :: ${detail}` : ""}`);
  }
}

// An injectable sender so "delivered" is distinguishable from "not attempted", and
// so nothing can reach the real owner.
let sent: string[] = [];
const ok = async (t: string) => {
  sent.push(t);
};
const clean = () => {
  for (const k of ["engine_fault_since", "engine_fault_raw", "engine_fault_alerted"]) setKv(k, "");
  sent = [];
};

const EROFS = "API Error: EROFS: read-only file system, open '/home/x/.claude.json'";

async function main() {
console.log("\nengine-alert: the cause lookup names the fault and where to act, never a paste-command");
{
  const disk = describeGlobalFault(EROFS);
  check("EROFS -> disk cause", /disk|read-only/i.test(disk.cause) && /VM/i.test(disk.action));
  const auth = describeGlobalFault("Failed to authenticate. API Error: 401 Invalid authentication credentials");
  check("401 -> auth cause", /login|expired/i.test(auth.cause) && /re-authenticate|VM/i.test(auth.action));
  const billing = describeGlobalFault("Credit balance is too low");
  check("credit balance -> billing cause", /credit/i.test(billing.cause));
  const missing = describeGlobalFault("spawn claude ENOENT");
  check("ENOENT -> missing-binary cause", /missing|not runnable/i.test(missing.cause));
  // Never a paste-command: `claude login` is actively wrong on this VM.
  const all = [disk, auth, billing, missing].map((d) => d.cause + " " + d.action).join(" ");
  check("no cause/action hands over a command to paste", !/`|\bclaude login\b|sudo |npm /i.test(all), all);
}

console.log("\nengine-alert: does NOT speak on first sight, only after the persistence bar");
{
  clean();
  noteEngineFault(EROFS);
  check("a fault is recorded", !!getKv("engine_fault_since"));
  await maybeAlertEngineFault(ok);
  check("no ping on first sight (a one-off blip must stay silent)", sent.length === 0, JSON.stringify(sent));

  // Backdate first-seen past the 30-min bar, as if the fault has persisted.
  setKv("engine_fault_since", new Date(Date.now() - 31 * 60_000).toISOString());
  await maybeAlertEngineFault(ok);
  check("pings once the fault has outlived the bar", sent.length === 1, JSON.stringify(sent));
  check("the ping names the cause and the fix", /disk|read-only/i.test(sent[0]) && /check the VM/i.test(sent[0]), sent[0]);
  check("the ping says how long it has been down", /down since/i.test(sent[0]));
}

console.log("\nengine-alert: one ping per outage, not one per tick");
{
  await maybeAlertEngineFault(ok);
  await maybeAlertEngineFault(ok);
  await maybeAlertEngineFault(ok);
  check("further ticks of the same outage stay quiet", sent.length === 1, `sent=${sent.length}`);
}

console.log("\nengine-alert: a failed send is retried until one lands (at-least-once)");
{
  clean();
  setKv("engine_fault_since", new Date(Date.now() - 31 * 60_000).toISOString());
  setKv("engine_fault_raw", EROFS);
  const broken = async () => {
    sent.push("attempt");
    throw new Error("telegram down");
  };
  await maybeAlertEngineFault(broken).catch(() => {});
  check("a failed send does not latch the alerted marker", !getKv("engine_fault_alerted"));
  await maybeAlertEngineFault(ok);
  check("the next tick retries and lands", getKv("engine_fault_alerted") === "1");
}

console.log("\nengine-alert: recovery says 'back' only if it had spoken");
{
  // Case 1: it alerted, then recovered -> one "back".
  clean();
  setKv("engine_fault_since", new Date(Date.now() - 31 * 60_000).toISOString());
  setKv("engine_fault_raw", EROFS);
  await maybeAlertEngineFault(ok);
  check("alerted", sent.length === 1);
  await clearEngineFault(ok);
  check("recovery after an alert sends 'back'", sent.length === 2 && /back/i.test(sent[1]), JSON.stringify(sent));
  check("state cleared", !engineFaultPending());

  // Case 2: a fault that healed BEFORE the bar (never alerted) -> silent recovery.
  clean();
  noteEngineFault(EROFS); // fresh, under the bar
  await clearEngineFault(ok);
  check("a fault that healed before it was announced sends nothing", sent.length === 0, JSON.stringify(sent));
  check("and clears its state", !engineFaultPending());

  // Case 3: quota already said "back" this recovery -> engine stays silent (one fact,
  // one message), even though it had alerted.
  clean();
  setKv("engine_fault_since", new Date(Date.now() - 31 * 60_000).toISOString());
  setKv("engine_fault_raw", EROFS);
  await maybeAlertEngineFault(ok); // engine alerted
  sent = [];
  await clearEngineFault(ok, /* alreadyAnnounced */ true);
  check("engine recovery is silent when a 'back' already went out", sent.length === 0, JSON.stringify(sent));
}

console.log("\nengine-alert: a pending fault is detectable so the sweep can re-probe with nothing due");
{
  // Finding #1: the alert fires only from a FAILING tick, but the tick's loop runs
  // only when a brief is due. If the engine broke while every brief was fresh and
  // nothing new is captured, nothing is due, nothing probes, and the outage stays
  // silent for up to BRIEF_STALE_DAYS. The worker closes this by probing one person
  // when engineFaultPending() is true and the due-list is empty; this pins the
  // signal that gate reads.
  clean();
  check("no fault pending on a healthy engine (sweep stays idle when nothing is due)", !engineFaultPending());
  noteEngineFault(EROFS);
  check("a recorded fault is pending, so the sweep knows to probe even with nothing due", engineFaultPending());
  await clearEngineFault(ok);
  check("once cleared, the sweep goes back to idle", !engineFaultPending());
}

console.log("\nengine-alert: quota takes precedence (both keys never fight)");
{
  clean();
  // The engine marker is independent of the quota marker: different keys, no fight.
  noteEngineFault(EROFS);
  check("an engine fault is pending", engineFaultPending());
  check("it does not touch the quota key", getKv("quota_paused_until") !== EROFS);
}

// The kill switch itself, against the REAL sender. This is the direct fix for the
// incident where a probe messaged the owner for real: MEMBRO_DISABLE_ALERTS is
// additive (never in .env, so Next's dotenv cannot re-supply it) and short-circuits
// every off-app send before any network call. With it set, even a fully-configured
// send must not touch the network.
console.log("\nengine-alert: MEMBRO_DISABLE_ALERTS is a real kill switch on the actual sender");
{
  const { sendTelegramMessage } = await import("@/lib/nightshift/telegram");
  process.env.TELEGRAM_BOT_TOKEN = "real-looking-token";
  process.env.TELEGRAM_CHAT_ID = "12345";
  let fetched = false;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetched = true;
    throw new Error("network must never be reached with the kill switch on");
  }) as typeof fetch;
  try {
    process.env.MEMBRO_DISABLE_ALERTS = "1";
    let threw = false;
    try {
      await sendTelegramMessage("this must not go out");
    } catch {
      threw = true;
    }
    // It throws rather than reports delivered, so no caller latches a once-per-outage
    // marker while the switch is on: removing the switch lets the next attempt send.
    check("a disabled send throws (never latches a marker)", threw);
    check("and never touches the network", fetched === false);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.MEMBRO_DISABLE_ALERTS;
  }
}

console.log(failures ? `\n${failures} engine-alert check(s) FAILED\n` : "\nall engine-alert checks passed\n");
process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
