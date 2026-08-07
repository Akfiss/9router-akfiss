"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, Button, CardSkeleton } from "@/shared/components";
import Input from "@/shared/components/Input";
import { useCopyToClipboard } from "@/shared/hooks/useCopyToClipboard";
import {
  isGatewayUnavailable,
  buildBansosBaseUrl,
  fetchBansosSettings,
  fetchBansosOverview,
} from "./OverviewTab.logic.js";

export default function OverviewTab() {
  const [settings, setSettings] = useState(null);
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState(null);
  const { copied, copy } = useCopyToClipboard();

  const loadOverview = useCallback(async () => {
    try {
      const [settingsData, overviewData] = await Promise.all([
        fetchBansosSettings(),
        fetchBansosOverview(),
      ]);
      setSettings(settingsData);
      setOverview(overviewData);
    } catch (error) {
      console.error("Failed to fetch Bansos overview:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadOverview();
  }, [loadOverview]);

  const handleTestConnectivity = async () => {
    setProbing(true);
    try {
      const data = await fetchBansosOverview(true);
      setProbeResult(data.publicHost || null);
    } catch (error) {
      console.error("Failed to probe Bansos public host:", error);
      setProbeResult({ reachable: false, error: "Probe failed" });
    } finally {
      setProbing(false);
    }
  };

  if (loading || !settings) {
    return (
      <div className="flex flex-col gap-6">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const baseUrl = buildBansosBaseUrl(settings.hostname);
  const unavailable = isGatewayUnavailable(settings);

  return (
    <div className="flex flex-col gap-6">
      {unavailable && (
        <div className="flex items-start gap-3 rounded-lg border border-red-300 dark:border-red-800 bg-red-500/5 p-4 text-sm">
          <span className="material-symbols-outlined text-red-500">warning</span>
          <div>
            <p className="font-medium text-red-600 dark:text-red-400">Public gateway is disabled</p>
            <p className="text-red-600/80 dark:text-red-400/80">
              The emergency kill switch is off — public requests are being rejected. Enable it from Settings.
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card padding="md">
          <p className="text-sm text-text-muted">Users</p>
          <p className="text-2xl font-semibold text-text-main">{overview?.userCount ?? 0}</p>
        </Card>
        <Card padding="md">
          <p className="text-sm text-text-muted">API Keys</p>
          <p className="text-2xl font-semibold text-text-main">{overview?.keyCount ?? 0}</p>
        </Card>
        <Card padding="md">
          <p className="text-sm text-text-muted">Requests (audited)</p>
          <p className="text-2xl font-semibold text-text-main">{overview?.requestCount ?? 0}</p>
        </Card>
        <Card padding="md">
          <p className="text-sm text-text-muted">Grok CLI</p>
          <p className="text-2xl font-semibold text-text-main">
            {overview?.grokCliConnected ? "Connected" : "Not connected"}
          </p>
        </Card>
      </div>

      <Card title="Today's Usage" icon="bar_chart" padding="md">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <p className="text-xs text-text-muted">Requests</p>
            <p className="font-mono text-lg text-text-main">{overview?.todayUsage?.totalRequests ?? 0}</p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Prompt Tokens</p>
            <p className="font-mono text-lg text-text-main">
              {(overview?.todayUsage?.totalPromptTokens ?? 0).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Completion Tokens</p>
            <p className="font-mono text-lg text-text-main">
              {(overview?.todayUsage?.totalCompletionTokens ?? 0).toLocaleString()}
            </p>
          </div>
          <div>
            <p className="text-xs text-text-muted">Cost</p>
            <p className="font-mono text-lg text-text-main">
              ${(overview?.todayUsage?.totalCost ?? 0).toFixed(4)}
            </p>
          </div>
        </div>
      </Card>

      <Card title="Public Endpoint" icon="public" padding="md">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-main">Base URL</label>
            <div className="flex gap-2">
              <Input value={baseUrl} readOnly className="flex-1 font-mono text-sm" />
              <Button
                variant="secondary"
                icon={copied === "base_url" ? "check" : "content_copy"}
                onClick={() => copy(baseUrl, "base_url")}
              >
                {copied === "base_url" ? "Copied!" : "Copy"}
              </Button>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text-main">Model</label>
            <div className="flex gap-2">
              <Input value={settings.publicModel || ""} readOnly className="flex-1 font-mono text-sm" />
              <Button
                variant="secondary"
                icon={copied === "public_model" ? "check" : "content_copy"}
                onClick={() => copy(settings.publicModel || "", "public_model")}
              >
                {copied === "public_model" ? "Copied!" : "Copy"}
              </Button>
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 pt-2 border-t border-border/50">
            <Button variant="outline" size="sm" loading={probing} onClick={handleTestConnectivity}>
              Test Connectivity
            </Button>
            {probeResult && (
              <span className={probeResult.reachable ? "text-sm text-green-600" : "text-sm text-red-500"}>
                {probeResult.reachable
                  ? `Reachable (${probeResult.status})`
                  : `Unreachable${probeResult.error ? `: ${probeResult.error}` : ""}`}
              </span>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
