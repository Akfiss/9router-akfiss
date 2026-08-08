"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, ConfirmModal } from "@/shared/components";
import Input from "@/shared/components/Input";
import Pagination from "@/shared/components/Pagination";
import { cn } from "@/shared/utils/cn";
import {
  isPromptExpired,
  formatRetentionWarning,
  fetchPromptAudits,
  eraseAuditPrompt,
} from "./UsageLogsTab.logic.js";

const STATUS_OPTIONS = ["", "success", "error", "pending"];

export default function UsageLogsTab() {
  const [audits, setAudits] = useState([]);
  const [pagination, setPagination] = useState({ page: 1, pageSize: 20, totalItems: 0 });
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({ userId: "", apiKeyId: "", status: "" });
  const [retentionDays, setRetentionDays] = useState(null);
  const [erasingId, setErasingId] = useState(null);
  const [eraseError, setEraseError] = useState("");
  const [eraseTarget, setEraseTarget] = useState(null);

  useEffect(() => {
    fetch("/api/bansos/settings")
      .then((res) => res.json())
      .then((data) => setRetentionDays(data?.promptRetentionDays ?? null))
      .catch(() => {});
  }, []);

  const loadAudits = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchPromptAudits(filters, { page: pagination.page, pageSize: pagination.pageSize });
      setAudits(data.audits || []);
      setPagination((prev) => ({ ...prev, ...data.pagination }));
    } catch (error) {
      console.error("Failed to fetch Bansos requests:", error);
    } finally {
      setLoading(false);
    }
  }, [filters, pagination.page, pagination.pageSize]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAudits();
  }, [loadAudits]);

  const handleEraseConfirm = async () => {
    if (!eraseTarget) return;
    const requestId = eraseTarget.requestId;
    setErasingId(requestId);
    setEraseError("");
    try {
      const res = await eraseAuditPrompt(requestId);
      if (res.ok) {
        setAudits((prev) => prev.map((a) => (a.requestId === requestId ? { ...a, prompt: null } : a)));
      } else {
        setEraseError("Prompt was already erased or the request is unknown.");
      }
    } catch (error) {
      setEraseError("An error occurred");
    } finally {
      setErasingId(null);
      setEraseTarget(null);
    }
  };

  const handlePageChange = (page) => setPagination((prev) => ({ ...prev, page }));
  const handlePageSizeChange = (pageSize) => setPagination((prev) => ({ ...prev, pageSize, page: 1 }));
  const updateFilter = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setPagination((prev) => ({ ...prev, page: 1 }));
  };
  const handleClearFilters = () => {
    setFilters({ userId: "", apiKeyId: "", status: "" });
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {retentionDays !== null && (
        <div className="flex items-center gap-2 rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-500/5 p-3 text-sm text-amber-700 dark:text-amber-400">
          <span className="material-symbols-outlined text-[18px]">schedule</span>
          {formatRetentionWarning(retentionDays)}
        </div>
      )}

      <Card padding="md">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            label="User ID"
            placeholder="usr_..."
            value={filters.userId}
            onChange={(e) => updateFilter("userId", e.target.value)}
          />
          <Input
            label="API Key ID"
            placeholder="key_..."
            value={filters.apiKeyId}
            onChange={(e) => updateFilter("apiKeyId", e.target.value)}
          />
          <div className="flex flex-col gap-1.5">
            <label htmlFor="bansos-status-filter" className="text-sm font-medium text-text-main">
              Status
            </label>
            <select
              id="bansos-status-filter"
              value={filters.status}
              onChange={(e) => updateFilter("status", e.target.value)}
              className={cn(
                "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                "text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20 cursor-pointer"
              )}
              style={{ colorScheme: "auto" }}
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s || "all"} value={s}>
                  {s || "All Statuses"}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="hidden text-sm font-medium text-text-main opacity-0 lg:block" aria-hidden="true">
              Clear
            </span>
            <Button
              variant="ghost"
              onClick={handleClearFilters}
              disabled={!filters.userId && !filters.apiKeyId && !filters.status}
              className="w-full"
            >
              Clear Filters
            </Button>
          </div>
        </div>
      </Card>

      {eraseError && <p className="text-sm text-red-500">{eraseError}</p>}

      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px]">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/5">
                <th className="text-left p-4 text-sm font-semibold text-text-main">Time</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">User</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Status</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Prompt</th>
                <th className="text-center p-4 text-sm font-semibold text-text-main">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="5" className="p-8 text-center text-text-muted">
                    Loading...
                  </td>
                </tr>
              ) : audits.length === 0 ? (
                <tr>
                  <td colSpan="5" className="p-8 text-center text-text-muted">
                    No requests found
                  </td>
                </tr>
              ) : (
                audits.map((audit) => {
                  const expired = isPromptExpired(audit);
                  return (
                    <tr
                      key={audit.requestId}
                      className="border-b border-black/5 dark:border-white/5 last:border-b-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors"
                    >
                      <td className="whitespace-nowrap p-4 text-sm text-text-main">
                        {new Date(audit.createdAt).toLocaleString()}
                      </td>
                      <td className="p-4 text-sm text-text-main font-mono">{audit.userId}</td>
                      <td className="p-4 text-sm">
                        <span
                          className={cn(
                            "px-2 py-0.5 rounded text-xs font-medium",
                            audit.status === "success"
                              ? "bg-green-500/15 text-green-600"
                              : audit.status === "error"
                                ? "bg-red-500/15 text-red-600"
                                : "bg-amber-500/15 text-amber-600"
                          )}
                        >
                          {audit.status}
                        </span>
                      </td>
                      <td className="max-w-[320px] truncate p-4 text-sm text-text-main">
                        {expired ? (
                          <span className="italic text-text-muted">Prompt expired/erased</span>
                        ) : (
                          audit.prompt
                        )}
                      </td>
                      <td className="p-4 text-center">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={expired || erasingId === audit.requestId}
                          loading={erasingId === audit.requestId}
                          onClick={() => setEraseTarget(audit)}
                        >
                          Erase
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {!loading && audits.length > 0 && (
          <div className="border-t border-black/5 dark:border-white/5">
            <Pagination
              currentPage={pagination.page}
              pageSize={pagination.pageSize}
              totalItems={pagination.totalItems}
              onPageChange={handlePageChange}
              onPageSizeChange={handlePageSizeChange}
            />
          </div>
        )}
      </Card>

      <ConfirmModal
        isOpen={!!eraseTarget}
        onClose={() => setEraseTarget(null)}
        onConfirm={handleEraseConfirm}
        title="Erase Prompt"
        message="Erase the stored prompt text for this request? This cannot be undone."
        confirmText="Erase"
        cancelText="Cancel"
        variant="danger"
        loading={erasingId === eraseTarget?.requestId}
      />
    </div>
  );
}
