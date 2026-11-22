const ACCOUNT_CHANGE_STORAGE_KEY = "xconfess.account-change.v1";
const ACCOUNT_CHANGE_CHANNEL = "xconfess-account-change-v1";

let accountGeneration = 0;
let tabId: string | null = null;

function getTabId(): string {
  if (!tabId) tabId = window.crypto.randomUUID();
  return tabId;
}

function readSignal(value: string | null): { senderId: string; eventId: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { senderId?: unknown; eventId?: unknown };
    if (typeof parsed.senderId !== "string" || typeof parsed.eventId !== "string") return null;
    return { senderId: parsed.senderId, eventId: parsed.eventId };
  } catch {
    return null;
  }
}

export class AccountChangedError extends Error {
  readonly code = "ACCOUNT_CHANGED";

  constructor() {
    super("Request was rejected because the active account changed.");
    this.name = "AccountChangedError";
  }
}

export function getAccountGeneration(): number {
  return accountGeneration;
}

export function advanceAccountGeneration(): number {
  accountGeneration += 1;
  return accountGeneration;
}

export function isAccountGenerationCurrent(generation: number): boolean {
  return generation === accountGeneration;
}

export function publishAccountChange(): boolean {
  if (typeof window === "undefined") return false;

  const eventId = window.crypto.randomUUID();
  const senderId = getTabId();
  let published = false;

  try {
    window.localStorage.setItem(
      ACCOUNT_CHANGE_STORAGE_KEY,
      JSON.stringify({ senderId, eventId }),
    );
    published = true;
  } catch {
    // BroadcastChannel below is the fallback when browser storage is unavailable.
  }

  if (!published && typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(ACCOUNT_CHANGE_CHANNEL);
      channel.postMessage({ type: "account-change", senderId, eventId });
      channel.close();
      published = true;
    } catch {
      // The storage event remains the primary cross-tab transport.
    }
  }

  return published;
}

export function subscribeToAccountChanges(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;

  const seenEventIds = new Set<string>();
  const notify = (senderId: unknown, eventId: unknown) => {
    if (
      typeof senderId !== "string" ||
      senderId === getTabId() ||
      typeof eventId !== "string" ||
      !eventId ||
      seenEventIds.has(eventId)
    ) return;
    seenEventIds.add(eventId);
    if (seenEventIds.size > 20) {
      const oldestEventId = seenEventIds.values().next().value;
      if (oldestEventId) seenEventIds.delete(oldestEventId);
    }
    onChange();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== ACCOUNT_CHANGE_STORAGE_KEY) return;
    const signal = readSignal(event.newValue);
    if (signal) notify(signal.senderId, signal.eventId);
  };
  window.addEventListener("storage", onStorage);

  let channel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(ACCOUNT_CHANGE_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        const message = event.data as {
          type?: unknown;
          senderId?: unknown;
          eventId?: unknown;
        } | null;
        if (message?.type === "account-change") {
          notify(message.senderId, message.eventId);
        }
      };
    } catch {
      channel = null;
    }
  }

  return () => {
    window.removeEventListener("storage", onStorage);
    channel?.close();
  };
}
