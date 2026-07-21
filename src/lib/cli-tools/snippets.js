/**
 * Snippet generators for CLI tools.
 * Each function mirrors the config-writing logic in the corresponding
 * src/app/api/cli-tools/{tool}-settings/route.js POST handler, but
 * returns the config content as a string instead of writing to disk.
 *
 * Usage: POST /api/cli-tools/[tool]/snippet
 *   body: { baseUrl, apiKey, model, models?, activeModel?, subagentModel? }
 *   returns: { tool, files: [{ path, content, language, isCredential }], summary }
 */

// ─── Claude Code ───────────────────────────────────────────────────────────
export function buildClaudeSnippet({ baseUrl, apiKey, model }) {
  if (!baseUrl) throw new Error("baseUrl is required");

  const normalized = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

  const env = {
    ANTHROPIC_BASE_URL: normalized,
    ANTHROPIC_AUTH_TOKEN: apiKey || "sk_9router",
  };

  if (model) {
    env.ANTHROPIC_MODEL = model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = model;
    env.ANTHROPIC_DEFAULT_FABLE_MODEL = model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = model;
  }

  // Snippet shows only the env block — user merges into existing settings.json
  const config = {
    hasCompletedOnboarding: true,
    env,
  };

  return {
    tool: "claude",
    files: [
      {
        path: "~/.claude/settings.json",
        content: JSON.stringify(config, null, 2),
        language: "json",
        isCredential: true,
      },
    ],
    summary: "Merge this env block into your ~/.claude/settings.json",
  };
}

// ─── Codex ─────────────────────────────────────────────────────────────────
export function buildCodexSnippet({ baseUrl, apiKey, model }) {
  if (!baseUrl || !model) throw new Error("baseUrl and model are required");

  const normalized = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

  const tomlBlock = `[model_providers.9router]
name = "9Router"
base_url = "${normalized}"
wire_api = "chat"
env_key = "OPENAI_API_KEY"

model = "${model}"
model_provider = "9router"`;

  const auth = {
    OPENAI_API_KEY: apiKey || "sk_9router",
    auth_mode: "apikey",
  };

  return {
    tool: "codex",
    files: [
      {
        path: "~/.codex/config.toml",
        content: tomlBlock,
        language: "toml",
        isCredential: false,
      },
      {
        path: "~/.codex/auth.json",
        content: JSON.stringify(auth, null, 2),
        language: "json",
        isCredential: true,
      },
    ],
    summary: "Append the TOML block to config.toml and write auth.json",
  };
}

// ─── OpenCode ──────────────────────────────────────────────────────────────
export function buildOpenCodeSnippet({ baseUrl, apiKey, model, models, activeModel, subagentModel }) {
  if (!baseUrl) throw new Error("baseUrl is required");

  const modelsArray = Array.isArray(models) ? models.slice() : (typeof model === "string" ? [model] : []);
  if (modelsArray.length === 0) throw new Error("at least one model is required");

  const normalized = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  const keyToUse = apiKey || "sk_9router";
  const effectiveSubagent = subagentModel || modelsArray[0];
  const finalActive = activeModel || modelsArray[0];

  const modelsMap = {};
  for (const m of modelsArray) {
    if (m && typeof m === "string") {
      modelsMap[m] = { name: m, modalities: { input: ["text", "image"], output: ["text"] } };
    }
  }

  const config = {
    provider: {
      "9router": {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: normalized,
          apiKey: keyToUse,
        },
        models: modelsMap,
      },
    },
    model: finalActive ? `9router/${finalActive}` : "",
    agent: {
      explorer: {
        description: "Fast explorer subagent for codebase exploration",
        mode: "subagent",
        model: `9router/${effectiveSubagent}`,
      },
    },
  };

  return {
    tool: "opencode",
    files: [
      {
        path: "~/.config/opencode/opencode.json",
        content: JSON.stringify(config, null, 2),
        language: "json",
        isCredential: true,
      },
    ],
    summary: "Merge this into your opencode.json (or use as-is for fresh install)",
  };
}

// ─── Cline ─────────────────────────────────────────────────────────────────
export function buildClineSnippet({ baseUrl, apiKey, model }) {
  if (!baseUrl || !model) throw new Error("baseUrl and model are required");

  // Cline appends its own path — do NOT add /v1
  const normalized = baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;

  const globalState = {
    actModeApiProvider: "openai",
    planModeApiProvider: "openai",
    openAiBaseUrl: normalized,
    openAiModelId: model,
    planModeOpenAiModelId: model,
  };

  const secrets = {
    openAiApiKey: apiKey || "sk_9router",
  };

  return {
    tool: "cline",
    files: [
      {
        path: "~/.cline/data/globalState.json",
        content: JSON.stringify(globalState, null, 2),
        language: "json",
        isCredential: false,
      },
      {
        path: "~/.cline/data/secrets.json",
        content: JSON.stringify(secrets, null, 2),
        language: "json",
        isCredential: true,
      },
    ],
    summary: "Merge globalState fields and write secrets.json",
  };
}

// ─── Kilo Code ─────────────────────────────────────────────────────────────
export function buildKiloSnippet({ baseUrl, apiKey, model }) {
  if (!baseUrl || !model) throw new Error("baseUrl and model are required");

  const normalized = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

  const auth = {
    "openai-compatible": {
      type: "api-key",
      apiKey: apiKey || "sk_9router",
      baseUrl: normalized,
      model,
    },
  };

  return {
    tool: "kilo",
    files: [
      {
        path: "~/.local/share/kilo/auth.json",
        content: JSON.stringify(auth, null, 2),
        language: "json",
        isCredential: true,
      },
    ],
    summary: "Write this to ~/.local/share/kilo/auth.json",
  };
}

// ─── OpenClaw ──────────────────────────────────────────────────────────────
export function buildOpenClawSnippet({ baseUrl, apiKey, model }) {
  if (!baseUrl || !model) throw new Error("baseUrl and model are required");

  const settings = {
    models: {
      providers: {
        "9router": {
          api: "openai-completions",
          baseURL: baseUrl,
          apiKey: apiKey || "sk_9router",
          models: [{ id: model, name: model.split("/").pop() || model }],
        },
      },
    },
    agents: {
      defaults: {
        model: { primary: `9router/${model}` },
        models: { [`9router/${model}`]: {} },
      },
    },
  };

  return {
    tool: "openclaw",
    files: [
      {
        path: "~/.openclaw/openclaw.json",
        content: JSON.stringify(settings, null, 2),
        language: "json",
        isCredential: true,
      },
    ],
    summary: "Merge into your openclaw.json",
  };
}

// ─── Hermes ────────────────────────────────────────────────────────────────
export function buildHermesSnippet({ baseUrl, apiKey, model }) {
  if (!baseUrl || !model) throw new Error("baseUrl and model is required");

  const normalized = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

  const yaml = `model:
  default: "${model}"
  provider: "custom"
  base_url: "${normalized}"
`;

  const env = apiKey ? `OPENAI_API_KEY=${apiKey}\n` : "";

  const files = [
    {
      path: "~/.hermes/config.yaml",
      content: yaml,
      language: "yaml",
      isCredential: false,
    },
  ];

  if (env) {
    files.push({
      path: "~/.hermes/.env",
      content: env,
      language: "bash",
      isCredential: true,
    });
  }

  return {
    tool: "hermes",
    files,
    summary: "Write config.yaml and .env to ~/.hermes/",
  };
}

// ─── Factory Droid ─────────────────────────────────────────────────────────
export function buildDroidSnippet({ baseUrl, apiKey, model, models, activeModel }) {
  if (!baseUrl) throw new Error("baseUrl is required");

  const modelsArray = Array.isArray(models) ? models.slice() : (typeof model === "string" ? [model] : []);
  if (modelsArray.length === 0) throw new Error("at least one model is required");

  const normalized = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  const keyToUse = apiKey || "sk_9router";

  const customModels = modelsArray.map((m, i) => ({
    id: `custom:9Router:${m}`,
    modelDisplayName: m,
    model: m,
    baseUrl: normalized,
    apiKey: keyToUse,
    provider: "generic-chat-completion-api",
    index: i,
  }));

  // If activeModel specified, move it to front
  if (activeModel) {
    const idx = customModels.findIndex((m) => m.model === activeModel);
    if (idx > 0) {
      const [entry] = customModels.splice(idx, 1);
      customModels.unshift({ ...entry, index: 0 });
      customModels.forEach((m, i) => { m.index = i; });
    }
  }

  const settings = { customModels };

  return {
    tool: "droid",
    files: [
      {
        path: "~/.factory/settings.json",
        content: JSON.stringify(settings, null, 2),
        language: "json",
        isCredential: true,
      },
    ],
    summary: "Merge customModels array into ~/.factory/settings.json",
  };
}

// ─── GitHub Copilot (VS Code) ──────────────────────────────────────────────
export function buildCopilotSnippet({ baseUrl, apiKey, models }) {
  if (!baseUrl || !models?.length) throw new Error("baseUrl and models are required");

  const endpointUrl = `${baseUrl}/chat/completions#models.ai.azure.com`;
  const keyToUse = apiKey || "sk_9router";

  const entry = {
    name: "9Router",
    vendor: "azure",
    apiKey: keyToUse,
    models: models.map((id) => ({
      id,
      name: id,
      url: endpointUrl,
      toolCalling: true,
      vision: false,
      maxInputTokens: 128000,
      maxOutputTokens: 16000,
    })),
  };

  return {
    tool: "copilot",
    files: [
      {
        path: "~/Code/User/chatLanguageModels.json",
        content: JSON.stringify([entry], null, 2),
        language: "json",
        isCredential: true,
      },
    ],
    summary: "Merge this entry into your chatLanguageModels.json array",
  };
}

// ─── DeepSeek TUI ──────────────────────────────────────────────────────────
export function buildDeepSeekSnippet({ baseUrl, apiKey, model }) {
  if (!baseUrl || !model) throw new Error("baseUrl and model are required");

  const normalized = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

  const toml = `provider = "openai"

[providers.openai]
base_url = "${normalized}"
api_key = "${apiKey || "sk_9router"}"
model = "${model}"
`;

  return {
    tool: "deepseek-tui",
    files: [
      {
        path: "~/.deepseek/config.toml",
        content: toml,
        language: "toml",
        isCredential: true,
      },
    ],
    summary: "Write this to ~/.deepseek/config.toml (replaces existing content)",
  };
}

// ─── jcode ─────────────────────────────────────────────────────────────────
export function buildJcodeSnippet({ baseUrl, apiKey, model }) {
  if (!baseUrl || !model) throw new Error("baseUrl and model are required");

  const normalized = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

  const toml = `[providers.9router]
type = "openai"
base_url = "${normalized}"
model = "${model}"
env_file = "provider-9router.env"
`;

  const env = `# jcode provider environment variables
OPENAI_API_KEY="${apiKey || "sk_9router"}"
`;

  return {
    tool: "jcode",
    files: [
      {
        path: "~/.jcode/config.toml",
        content: toml,
        language: "toml",
        isCredential: false,
      },
      {
        path: "~/.config/jcode/provider-9router.env",
        content: env,
        language: "bash",
        isCredential: true,
      },
    ],
    summary: "Append provider block to config.toml and write env file",
  };
}

// ─── Grok Build ───────────────────────────────────────────────────────────
export function buildGrokBuildSnippet({ baseUrl, apiKey, model, contextWindow }) {
  if (!baseUrl || !model) throw new Error("baseUrl and model are required");

  const normalized = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  const ctx = contextWindow || 131072;

  const toml = `[models.9router]
model = "${model}"
base_url = "${normalized}"
api_key = "${apiKey || "sk_9router"}"
context_window = ${ctx}
name = "9Router"

[models]
default = "9router"
`;

  return {
    tool: "grok-build",
    files: [
      {
        path: "~/.grok/config.toml",
        content: toml,
        language: "toml",
        isCredential: true,
      },
    ],
    summary: "Write this to ~/.grok/config.toml (replaces existing content)",
  };
}

// ─── Registry ──────────────────────────────────────────────────────────────
export const SNIPPET_BUILDERS = {
  claude: buildClaudeSnippet,
  codex: buildCodexSnippet,
  opencode: buildOpenCodeSnippet,
  cline: buildClineSnippet,
  kilo: buildKiloSnippet,
  openclaw: buildOpenClawSnippet,
  hermes: buildHermesSnippet,
  droid: buildDroidSnippet,
  copilot: buildCopilotSnippet,
  "deepseek-tui": buildDeepSeekSnippet,
  jcode: buildJcodeSnippet,
  "grok-build": buildGrokBuildSnippet,
};

export function buildSnippet(toolId, params) {
  const builder = SNIPPET_BUILDERS[toolId];
  if (!builder) {
    return null;
  }
  return builder(params);
}
