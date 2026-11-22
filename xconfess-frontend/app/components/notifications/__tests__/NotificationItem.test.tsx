import { render, screen } from "@testing-library/react";
import { NotificationItem } from "../NotificationItem";
import { NotificationType } from "@/app/types/notifications";

describe("NotificationItem", () => {
  it("links to the detail warning boundary for notifications with a confession", () => {
    render(
      <NotificationItem
        notification={{
          id: "notification-1",
          userId: "user-1",
          type: NotificationType.COMMENT,
          title: "New activity",
          message: "There is an update.",
          metadata: { confessionId: "confession-1" },
          isRead: true,
          createdAt: "2025-01-01T00:00:00.000Z",
        }}
        onMarkAsRead={jest.fn()}
        onDelete={jest.fn()}
      />,
    );

    expect(
      screen.getByRole("link", { name: "View confession" }),
    ).toHaveAttribute("href", "/confessions/confession-1");
  });
});
