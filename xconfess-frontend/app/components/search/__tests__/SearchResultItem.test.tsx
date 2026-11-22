import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SearchResultItem } from "../SearchResultItem";

describe("SearchResultItem", () => {
  beforeEach(() => {
    window.localStorage.setItem("contentWarningsCollapsed", "true");
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("does not expose warned content in search previews until opted in", async () => {
    const user = userEvent.setup();
    render(
      <SearchResultItem
        confession={{
          id: "confession-1",
          content: "Sensitive search result",
          contentWarning: true,
          createdAt: "2025-01-01T00:00:00.000Z",
          reactions: { like: 0, love: 0 },
        }}
      />,
    );

    expect(screen.getByText("Content warning")).toBeInTheDocument();
    expect(screen.queryByText("Sensitive search result")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show confession" }));

    expect(screen.getByText("Sensitive search result")).toBeInTheDocument();
  });
});
