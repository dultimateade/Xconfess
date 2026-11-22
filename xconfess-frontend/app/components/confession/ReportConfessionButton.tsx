"use client";

import { useState } from "react";
import { AlertCircle } from "lucide-react";
import { createConfessionReport } from "@/app/lib/api/reports";

interface ReportConfessionButtonProps {
  confessionId: string;
  className?: string;
  labels?: {
    idle: string;
    pending: string;
    success: string;
    successMessage: string;
    failure: string;
  };
}

export function ReportConfessionButton({
  confessionId,
  className,
  labels,
}: ReportConfessionButtonProps) {
  const [status, setStatus] = useState<"idle" | "pending" | "success" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (status === "pending" || status === "success") return;
    setStatus("pending");
    setError(null);

    try {
      const result = await createConfessionReport(confessionId, {
        type: "other",
      });
      if (!result.ok) {
        setStatus("error");
        setError(result.error.message);
        return;
      }
      setStatus("success");
    } catch (reason) {
      setStatus("error");
      setError(
        reason instanceof Error ? reason.message : "Report submission failed.",
      );
    }
  };

  return (
    <div className="flex flex-col items-start">
      <button
        type="button"
        className={
          className ??
          "inline-flex min-h-10 items-center gap-1 rounded-lg border border-[var(--border)] px-3 text-sm text-[var(--secondary)] hover:text-[var(--foreground)]"
        }
        disabled={status === "pending" || status === "success"}
        onClick={() => void submit()}
        aria-label="Report confession"
      >
        <AlertCircle className="h-4 w-4" aria-hidden="true" />
        {status === "pending"
          ? (labels?.pending ?? "Submitting…")
          : status === "success"
            ? (labels?.success ?? "Reported")
            : (labels?.idle ?? "Report")}
      </button>
      {status === "error" && (
        <p role="alert" className="mt-1 text-xs text-red-600">
          {error || labels?.failure || "Report submission failed. Try again."}
        </p>
      )}
      {status === "success" && (
        <p role="status" className="mt-1 text-xs text-emerald-600">
          {labels?.successMessage ?? "Report submitted."}
        </p>
      )}
    </div>
  );
}
