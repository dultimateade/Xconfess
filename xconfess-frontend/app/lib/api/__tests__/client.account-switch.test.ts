import type { AxiosAdapter, AxiosResponse } from "axios";
import { advanceAccountGeneration } from "@/app/lib/auth/accountSession";
import { apiClient } from "../client";

jest.mock("@/app/lib/store/authStore", () => ({
  useAuthStore: { getState: () => ({ logout: jest.fn() }) },
}));

describe("API requests across account changes", () => {
  it("rejects a response started under the previous account instead of exposing it to callers", async () => {
    let resolveResponse!: (response: AxiosResponse) => void;
    let requestConfig: Parameters<AxiosAdapter>[0] | undefined;
    const adapter: AxiosAdapter = (config) =>
      new Promise((resolve) => {
        requestConfig = config;
        resolveResponse = resolve;
      });

    const pendingRequest = apiClient.get("/api/private/profile", { adapter });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(requestConfig).toBeDefined();

    advanceAccountGeneration();
    resolveResponse({
      data: { email: "previous-account@example.com" },
      status: 200,
      statusText: "OK",
      headers: {},
      config: requestConfig!,
    });

    await expect(pendingRequest).rejects.toMatchObject({
      name: "AccountChangedError",
      code: "ACCOUNT_CHANGED",
    });
  });
});
