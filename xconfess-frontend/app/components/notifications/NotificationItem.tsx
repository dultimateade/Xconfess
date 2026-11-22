"use client";

import { Notification } from "@/app/types/notifications";
import { Trash2, Check } from "lucide-react";
import Link from "next/link";

interface NotificationItemProps {
    notification: Notification;
    onMarkAsRead: (id: string) => void;
    onDelete: (id: string) => void;
}

export function NotificationItem({
    notification,
    onMarkAsRead,
    onDelete,
}: NotificationItemProps) {
    const confessionId = notification.metadata?.confessionId;

    return (
        <div
            className={`p-4 flex justify-between gap-3 ${notification.isRead ? "bg-white" : "bg-blue-50"
                }`}
        >
            <div>
                <p className="text-sm font-medium text-gray-800">
                    {notification.title}
                </p>
                <p className="text-xs text-gray-600">{notification.message}</p>
                {confessionId && (
                    <Link
                        href={`/confessions/${confessionId}`}
                        className="mt-2 inline-flex text-xs font-medium text-indigo-600 underline-offset-2 hover:underline"
                    >
                        View confession
                    </Link>
                )}
            </div>

            <div className="flex items-center gap-2">
                {!notification.isRead && (
                    <button
                        onClick={() => onMarkAsRead(notification.id)}
                        aria-label="Mark as read"
                    >
                        <Check className="w-4 h-4 text-green-600" />
                    </button>
                )}

                <button
                    onClick={() => onDelete(notification.id)}
                    aria-label="Delete notification"
                >
                    <Trash2 className="w-4 h-4 text-red-500" />
                </button>
            </div>
        </div>
    );
}
