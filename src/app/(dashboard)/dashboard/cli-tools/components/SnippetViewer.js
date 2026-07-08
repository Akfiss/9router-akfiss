"use client";

import { useState } from "react";
import { Card, Button, Badge } from "@/shared/components";
import ApiKeySelect from "./ApiKeySelect";
import BaseUrlSelect from "./BaseUrlSelect";

export default function SnippetViewer({ toolId, baseUrl, apiKeys, availableModels }) {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedApiKey, setSelectedApiKey] = useState("");
  const [selectedModel, setSelectedModel] = useState("");
  const [customBaseUrl, setCustomBaseUrl] = useState(baseUrl);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [copiedPath, setCopiedPath] = useState(null);

  const handleGenerate = async () => {
    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await fetch(`/api/cli-tools/${toolId}/snippet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseUrl: customBaseUrl,
          apiKey: selectedApiKey || "sk_9router",
          model: selectedModel || (availableModels[0]?.value || ""),
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to generate snippet");
      }

      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = async (content, path) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedPath(path);
      setTimeout(() => setCopiedPath(null), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleDownload = (content, path) => {
    const filename = path.split("/").pop() || path.split("\\").pop() || "config";
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (!isOpen) {
    return (
      <Button
        variant="secondary"
        icon="code"
        onClick={() => setIsOpen(true)}
        className="w-full sm:w-auto"
      >
        Generate Config Snippet
      </Button>
    );
  }

  return (
    <Card className="mt-6" padding="sm">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-text-muted">code</span>
          <h3 className="text-text-main font-semibold">Generate Config Snippet</h3>
        </div>
        <button
          onClick={() => setIsOpen(false)}
          className="text-text-muted hover:text-text-main transition-colors"
        >
          <span className="material-symbols-outlined text-[20px]">close</span>
        </button>
      </div>

      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-muted">Base URL</label>
            <BaseUrlSelect
              value={customBaseUrl}
              onChange={setCustomBaseUrl}
              requiresExternalUrl={false}
              withV1={true}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-muted">API Key</label>
            <ApiKeySelect
              value={selectedApiKey}
              onChange={setSelectedApiKey}
              apiKeys={apiKeys}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-text-muted">Model</label>
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              className="w-full min-w-0 px-2 py-2 bg-surface rounded text-xs border border-border focus:outline-none focus:ring-1 focus:ring-primary/50 sm:py-1.5"
            >
              <option value="">Default Model</option>
              {availableModels.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex justify-end">
          <Button
            variant="primary"
            onClick={handleGenerate}
            loading={loading}
            icon="magic_button"
          >
            Generate Snippet
          </Button>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-500 text-sm">
            {error}
          </div>
        )}

        {result && (
          <div className="flex flex-col gap-4 mt-2 border-t border-border pt-4">
            {result.summary && (
              <p className="text-sm text-text-muted">{result.summary}</p>
            )}

            <div className="flex flex-col gap-4">
              {result.files?.map((file, idx) => (
                <div key={idx} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-text-main font-mono">
                        {file.path}
                      </span>
                      {file.language && (
                        <Badge variant="default" size="sm">
                          {file.language}
                        </Badge>
                      )}
                      {file.isCredential && (
                        <Badge variant="warning" size="sm" icon="warning">
                          Credential
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => handleCopy(file.content, file.path)}
                        className="p-1.5 rounded-md text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors"
                        title="Copy content"
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          {copiedPath === file.path ? "check" : "content_copy"}
                        </span>
                      </button>
                      <button
                        onClick={() => handleDownload(file.content, file.path)}
                        className="p-1.5 rounded-md text-text-muted hover:text-text-main hover:bg-surface-2 transition-colors"
                        title="Download file"
                      >
                        <span className="material-symbols-outlined text-[16px]">download</span>
                      </button>
                    </div>
                  </div>
                  <div className="relative group">
                    <pre className="bg-black/30 dark:bg-black/50 rounded-lg p-3 font-mono text-xs overflow-x-auto text-text-main border border-border-subtle">
                      <code>{file.content}</code>
                    </pre>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
