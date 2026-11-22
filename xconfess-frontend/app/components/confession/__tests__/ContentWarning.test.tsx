import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContentWarning } from "../ContentWarning";

describe("ContentWarning", () => {
  beforeEach(() => {
    window.localStorage.setItem("contentWarningsCollapsed", "true");
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("keeps warned content hidden until the reader opts in", async () => {
    const user = userEvent.setup();
    render(
      <ContentWarning contentWarning>
        <p>Sensitive confession text</p>
      </ContentWarning>,
    );

    expect(screen.getByText("Content warning")).toBeInTheDocument();
    expect(screen.queryByText("Sensitive confession text")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show confession" }));

    expect(screen.getByText("Sensitive confession text")).toBeInTheDocument();
  });

  it("does not hide content without a warning signal", () => {
    render(
      <ContentWarning contentWarning={false}>
        <p>Regular confession text</p>
      </ContentWarning>,
    );

    expect(screen.getByText("Regular confession text")).toBeInTheDocument();
    expect(screen.queryByText("Content warning")).not.toBeInTheDocument();
  });
});
