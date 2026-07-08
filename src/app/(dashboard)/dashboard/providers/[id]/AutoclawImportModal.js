"use client";

import { useState } from "react";
import { Button, Input, Modal } from "@/shared/components";

export default function AutoclawImportModal({ isOpen, onClose, onSaved }) {
  const [mode, setMode] = useState("single"); // "single" | "bulk"
  const [accessToken, setAccessToken] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [bulkJson, setBulkJson] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [bulkResult, setBulkResult] = useState(null);

  function handleClose() {
    setAccessToken("");
    setRefreshToken("");
    setDeviceId("");
    setBulkJson("");
    setError(null);
    setBulkResult(null);
    setMode("single");
    onClose?.();
  }

  async function handleSingleImport() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/oauth/autoclaw/import-token", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          accessToken: accessToken.trim(),
          refreshToken: refreshToken.trim(),
          deviceId: deviceId.trim() || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Import failed");
        return;
      }
      setAccessToken("");
      setRefreshToken("");
      setDeviceId("");
      onSaved?.();
      handleClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleBulkImport() {
    setLoading(true);
    setError(null);
    setBulkResult(null);
    try {
      const accounts = JSON.parse(bulkJson);
      if (!Array.isArray(accounts)) {
        setError("JSON must be an array of account objects");
        return;
      }
      const res = await fetch("/api/oauth/autoclaw/bulk-import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accounts }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Bulk import failed");
        return;
      }
      setBulkResult({ success: data.success, failed: data.failed });
      if (data.success > 0) {
        setBulkJson("");
        onSaved?.();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const canSingle = Boolean(accessToken.trim() && refreshToken.trim() && !loading);
  const canBulk = Boolean(bulkJson.trim() && !loading);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Import AutoClaw Account" size="md">
      <div className="space-y-4">
        <div className="flex gap-2">
          <Button size="sm" variant={mode === "single" ? "primary" : "ghost"} onClick={() => { setMode("single"); setError(null); setBulkResult(null); }}>
            Single
          </Button>
          <Button size="sm" variant={mode === "bulk" ? "primary" : "ghost"} onClick={() => { setMode("bulk"); setError(null); setBulkResult(null); }}>
            Bulk Import (JSON)
          </Button>
        </div>

        {mode === "single" && (
          <div className="space-y-3">
            <Input
              label="Access Token"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder="Bearer eyJ..."
              required
            />
            <Input
              label="Refresh Token"
              value={refreshToken}
              onChange={(e) => setRefreshToken(e.target.value)}
              placeholder="Bearer eyJ..."
              required
            />
            <Input
              label="Device ID (optional)"
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              placeholder="Auto-generated if blank"
              hint="Per-account device fingerprint. Leave blank to auto-generate."
            />
          </div>
        )}

        {mode === "bulk" && (
          <div className="space-y-3">
            <p className="text-xs text-text-muted">
              Paste JSON array from autoclaw_accounts.json. Each object needs: access_token, refresh_token, device_id (optional), email (optional).
            </p>
            <textarea
              className="w-full rounded border border-border bg-bg p-3 text-sm font-mono"
              rows={10}
              value={bulkJson}
              onChange={(e) => setBulkJson(e.target.value)}
              placeholder='[{"email":"...","access_token":"Bearer eyJ...","refresh_token":"Bearer eyJ...","device_id":"..."}]'
            />
            {bulkResult && (
              <div className="flex gap-3 text-sm">
                <span className="text-emerald-500">Added: {bulkResult.success}</span>
                {bulkResult.failed > 0 && <span className="text-red-500">Failed: {bulkResult.failed}</span>}
              </div>
            )}
          </div>
        )}

        {error && (
          <p className="text-sm text-red-500 break-words" role="alert">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={handleClose} disabled={loading}>
            Cancel
          </Button>
          {mode === "single" ? (
            <Button onClick={handleSingleImport} disabled={!canSingle} loading={loading}>
              Import
            </Button>
          ) : (
            <Button onClick={handleBulkImport} disabled={!canBulk} loading={loading}>
              Bulk Import
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
