import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createConfessionReport } from "@/app/lib/api/reports";
import { ReportConfessionButton } from "../ReportConfessionButton";

jest.mock("@/app/lib/api/reports", () => ({
  createConfessionReport: jest.fn(),
}));

describe("ReportConfessionButton", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("reports success and allows retry after an explicit API failure", async () => {
    (createConfessionReport as jest.Mock)
      .mockResolvedValueOnce({
        ok: false,
        error: { message: "Connect your wallet to report anonymously." },
      })
      .mockResolvedValueOnce({ ok: true, data: { id: "report-1" } });

    render(<ReportConfessionButton confessionId="confession-1" />);

    fireEvent.click(screen.getByRole("button", { name: "Report confession" }));
    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("Connect your wallet");

    fireEvent.click(screen.getByRole("button", { name: "Report confession" }));
    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("Report submitted.");
    });
    expect(createConfessionReport).toHaveBeenCalledTimes(2);
  });
});
