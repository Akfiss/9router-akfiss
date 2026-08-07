"use client";

import { useState, useEffect } from "react";
import { Card, Toggle, CardSkeleton } from "@/shared/components";
import Input from "@/shared/components/Input";
import {
  READ_ONLY_SETTINGS_FIELDS,
  fetchGatewaySettings,
  updateGatewayEnabled,
  updateDefaultRequestsPerMinute,
  updateDefaultMaxConcurrentRequests,
} from "./SettingsTab.logic.js";

export default function SettingsTab() {
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [savingEnabled, setSavingEnabled] = useState(false);
  const [rpmInput, setRpmInput] = useState("");
  const [concurrencyInput, setConcurrencyInput] = useState("");

  useEffect(() => {
    fetchGatewaySettings()
      .then((data) => {
        setSettings(data);
        setRpmInput(String(data?.defaultRequestsPerMinute ?? ""));
        setConcurrencyInput(String(data?.defaultMaxConcurrentRequests ?? ""));
      })
      .catch((error) => console.error("Failed to fetch Bansos settings:", error))
      .finally(() => setLoading(false));
  }, []);

  const handleToggleEnabled = async () => {
    if (!settings) return;
    const next = !(settings.gatewayEnabled !== false);
    setSavingEnabled(true);
    try {
      const res = await updateGatewayEnabled(next);
      if (res.ok) {
        const data = await res.json();
        setSettings((prev) => ({ ...prev, gatewayEnabled: data.gatewayEnabled }));
      }
    } catch (error) {
      console.error("Failed to update Bansos gateway enabled:", error);
    } finally {
      setSavingEnabled(false);
    }
  };

  const handleRpmChange = async (value) => {
    setRpmInput(value);
    const parsed = parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) return;
    try {
      const res = await updateDefaultRequestsPerMinute(parsed);
      if (res.ok) {
        const data = await res.json();
        setSettings((prev) => ({ ...prev, defaultRequestsPerMinute: data.defaultRequestsPerMinute }));
      }
    } catch (error) {
      console.error("Failed to update default requests per minute:", error);
    }
  };

  const handleConcurrencyChange = async (value) => {
    setConcurrencyInput(value);
    const parsed = parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < 1) return;
    try {
      const res = await updateDefaultMaxConcurrentRequests(parsed);
      if (res.ok) {
        const data = await res.json();
        setSettings((prev) => ({ ...prev, defaultMaxConcurrentRequests: data.defaultMaxConcurrentRequests }));
      }
    } catch (error) {
      console.error("Failed to update default max concurrent requests:", error);
    }
  };

  if (loading || !settings) return <CardSkeleton />;

  const enabled = settings.gatewayEnabled !== false;

  return (
    <div className="flex flex-col gap-6">
      <Card title="Emergency Kill Switch" icon="power_settings_new" padding="md">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="font-medium text-sm text-text-main">Public Gateway</p>
            <p className="text-xs text-text-muted">
              When off, all public /v1 requests are rejected immediately.
            </p>
            {!enabled && (
              <p className="text-xs text-red-500 mt-1">
                Gateway is currently disabled — public traffic is being rejected.
              </p>
            )}
          </div>
          <Toggle checked={enabled} onChange={handleToggleEnabled} disabled={savingEnabled} />
        </div>
      </Card>

      <Card title="New User Defaults" icon="tune" padding="md">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Default Requests / Minute"
            type="number"
            min="1"
            value={rpmInput}
            onChange={(e) => handleRpmChange(e.target.value)}
          />
          <Input
            label="Default Max Concurrent Requests"
            type="number"
            min="1"
            value={concurrencyInput}
            onChange={(e) => handleConcurrencyChange(e.target.value)}
          />
        </div>
      </Card>

      <Card title="Gateway Configuration" icon="dns" padding="md">
        <div className="flex flex-col gap-3">
          {READ_ONLY_SETTINGS_FIELDS.map((field) => (
            <div
              key={field.key}
              className="flex items-center justify-between gap-4 py-2 border-b border-border-subtle last:border-b-0"
            >
              <span className="text-sm text-text-muted">{field.label}</span>
              <span className="font-mono text-sm text-text-main">{String(settings[field.key] ?? "—")}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
