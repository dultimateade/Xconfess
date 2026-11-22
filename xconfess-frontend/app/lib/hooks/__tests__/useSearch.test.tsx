import { renderHook, waitFor } from "@testing-library/react";
import { DEFAULT_FILTERS } from "@/app/lib/types/search";
import { useSearch } from "../useSearch";

describe("useSearch", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("normalizes the backend search response and preserves content warnings", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: "confession-1",
            message: "Sensitive result",
            created_at: "2025-01-01T00:00:00.000Z",
            contentWarning: true,
            reactions: [{ type: "like", count: 3 }],
          },
        ],
        meta: { total: 1, page: 1, limit: 10 },
      }),
    }) as typeof fetch;

    const { result } = renderHook(() =>
      useSearch({
        query: "sensitive",
        filters: DEFAULT_FILTERS,
        debouncedQuery: "sensitive",
        runSearch: true,
      }),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.error).toBeNull();

    expect(result.current.results[0]).toMatchObject({
      id: "confession-1",
      content: "Sensitive result",
      contentWarning: true,
      reactions: { like: 3, love: 0 },
    });
  });
});
