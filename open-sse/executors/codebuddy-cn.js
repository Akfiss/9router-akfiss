import { DefaultExecutor } from "./default.js";

/**
 * CodeBuddyExecutor — talks to https://copilot.tencent.com/v2/chat/completions
 *
 * CodeBuddy is OpenAI-compatible but rejects non-stream chat requests
 * (HTTP 400, code 11101 "Non-stream chat request is currently not supported").
 * The same-format (openai→openai) translator path leaves body.stream as the
 * client sent it, so we force it true here — 9router still re-aggregates the
 * SSE into a JSON response for non-streaming clients.
 *
 * Additionally, CodeBuddy CN content-filters requests that carry agent/CLI
 * identity markers (cc_entrypoint, <agent-identity>, Anthropic CLI refs, etc.).
 * The sanitizer below strips these markers from the request body — preserving
 * the system prompt's agent/tool-use instructions — so the model behaves
 * normally without triggering Tencent's content moderation.
 */
export class CodeBuddyExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-cn");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    // Sanitize messages to strip agent identity markers
    if (Array.isArray(transformed.messages)) {
      transformed.messages = transformed.messages.map((msg) => sanitizeMessage(msg));
    }

    // CodeBuddy only surfaces model reasoning when the request carries the CLI's
    // OpenAI-style params: reasoning_effort + reasoning_summary:"auto". 9router's
    // thinking pipeline sets reasoning_effort only when the client asks, and never
    // sets reasoning_summary — so reasoning never shows. Mirror the CLI here.
    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort; // gateway has no "none" — just omit
    } else if (eff) {
      // Client explicitly asked for reasoning — mirror the CLI's reasoning_summary
      // so CodeBuddy surfaces the model's reasoning.
      transformed.reasoning_summary = "auto";
    }
    // No reasoning requested: leave both unset. Forcing reasoning_effort:"medium"
    // + reasoning_summary on plain requests makes CodeBuddy trip its content
    // filter and return an error (#2071).
    return transformed;
  }
}

// ── Sanitizer ──────────────────────────────────────────────────────────────
// Ported from etteum-pool/src/proxy/filters.ts (PUDIDIL_FILTERS) +
// codebuddy-china.ts (isAgentSystemPrompt + cleanMessages).
// Strips sensitive agent/CLI identity markers from request text WITHOUT
// replacing the system prompt — only filtering, preserving agent behavior.

const FILTER_RULES = [
  [/(x-(?:anthropic-)?billing-header:?\s*[^\n]*)/gi, ""],
  [/cc_entrypoint\s*=\s*\w+/gi, ""],
  [/cc_version\s*=\s*[\w.]+/gi, ""],
  [/c?ch=[a-f0-9]+/gi, ""],
  [/https?:\/\/github\.com\/anthropics\/claude-code[^\s]*/gi, ""],
  [/<agent-identity>[\s\S]*?<\/agent-identity>/gi, ""],
  [/<\/?(?:Role|Behavior_Instructions)[^>]*>/gi, ""],
  [/Anthropic'?s official (?:CLI|tool|agent)[^.]*\.?/gi, ""],
  [/You are (?:a )?(?:powerful )?(?:AI )?(?:assistant|agent) (?:made|built|created) by (?:Cursor|Anysphere)[^.]*\.?/gi, ""],
  [/You are (?:Windsurf|Cascade|Codeium)[^.]*\.?/gi, ""],
  [/(?:autonomous|agentic) (?:AI |coding )?(?:agent|assistant)[^.]*\.?/gi, ""],
  [/MCP (?:server|client|protocol)[^.]*\.?/gi, ""],
  [/powered by (?:Claude|Anthropic)[^.]*\.?/gi, ""],
];

function filterText(text) {
  if (typeof text !== "string") return text;
  let result = text;
  for (const [pattern, replacement] of FILTER_RULES) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function sanitizeMessage(msg) {
  if (!msg || typeof msg !== "object") return msg;

  // String content
  if (typeof msg.content === "string") {
    return { ...msg, content: filterText(msg.content) };
  }

  // Array content — map each block
  if (Array.isArray(msg.content)) {
    return {
      ...msg,
      content: msg.content.map((block) => {
        if (block?.type === "text" && typeof block.text === "string") {
          return { ...block, text: filterText(block.text) };
        }
        if (block?.type === "tool_result") {
          if (typeof block.content === "string") {
            return { ...block, content: filterText(block.content) };
          }
          if (Array.isArray(block.content)) {
            return {
              ...block,
              content: block.content.map((c) =>
                c?.type === "text" && typeof c.text === "string"
                  ? { ...c, text: filterText(c.text) }
                  : c
              ),
            };
          }
        }
        return block;
      }),
    };
  }

  return msg;
}

export default CodeBuddyExecutor;
