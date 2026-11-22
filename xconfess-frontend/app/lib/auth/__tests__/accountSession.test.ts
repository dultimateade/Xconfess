import {
  publishAccountChange,
  subscribeToAccountChanges,
} from "../accountSession";

describe("cross-tab account-change signals", () => {
  const storage = new Map<string, string>();

  beforeEach(() => {
    storage.clear();
    (localStorage.setItem as jest.Mock).mockImplementation((key, value) => {
      storage.set(String(key), String(value));
    });
    (localStorage.getItem as jest.Mock).mockImplementation((key) => {
      return storage.get(String(key)) ?? null;
    });
    (localStorage.removeItem as jest.Mock).mockImplementation((key) => {
      storage.delete(String(key));
    });
  });

  afterEach(() => {
    localStorage.removeItem("xconfess.account-change.v1");
    jest.clearAllMocks();
  });

  it("uses an opaque signal and notifies once for another tab", () => {
    const onChange = jest.fn();
    const unsubscribe = subscribeToAccountChanges(onChange);

    expect(publishAccountChange()).toBe(true);
    const ownSignal = localStorage.getItem("xconfess.account-change.v1");
    expect(ownSignal).not.toContain("admin@example.com");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "xconfess.account-change.v1",
        newValue: ownSignal,
      }),
    );
    expect(onChange).not.toHaveBeenCalled();

    const otherTabSignal = JSON.stringify({
      senderId: "another-tab",
      eventId: "account-switch-event",
    });
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "xconfess.account-change.v1",
        newValue: otherTabSignal,
      }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "xconfess.account-change.v1",
        newValue: otherTabSignal,
      }),
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
