"use client";

import { useEffect, useState, type ReactNode } from "react";
import { ShieldAlert } from "lucide-react";

interface ContentWarningProps {
  contentWarning?: boolean;
  children: ReactNode;
}

export function ContentWarning({
  contentWarning,
  children,
}: ContentWarningProps) {
  const [collapsed, setCollapsed] = useState(true);
  const [showContent, setShowContent] = useState(false);

  useEffect(() => {
    const storedPreference = window.localStorage.getItem(
      "contentWarningsCollapsed",
    );
    if (storedPreference !== null) {
      setCollapsed(storedPreference !== "false");
      return;
    }

    fetch("/api/users/privacy-settings", { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((settings) => {
        if (typeof settings?.contentWarningsCollapsed === "boolean") {
          setCollapsed(settings.contentWarningsCollapsed);
          window.localStorage.setItem(
            "contentWarningsCollapsed",
            String(settings.contentWarningsCollapsed),
          );
        }
      })
      .catch(() => undefined);
  }, []);

  if (!contentWarning || !collapsed || showContent) {
    return <>{children}</>;
  }

  return (
    <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5">
      <div className="flex items-start gap-3">
        <ShieldAlert
          className="mt-0.5 h-5 w-5 shrink-0 text-amber-600"
          aria-hidden="true"
        />
        <div>
          <p className="font-semibold text-[var(--foreground)]">
            Content warning
          </p>
          <p className="mt-1 text-sm leading-6 text-[var(--secondary)]">
            This confession may contain sensitive material. You choose whether
            to view it.
          </p>
          <button
            type="button"
            onClick={() => setShowContent(true)}
            className="mt-4 rounded-lg border border-amber-500/40 px-3 py-2 text-sm font-semibold text-[var(--foreground)] transition-colors hover:bg-amber-500/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
          >
            Show confession
          </button>
        </div>
      </div>
    </div>
  );
}
