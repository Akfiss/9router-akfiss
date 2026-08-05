import { DefaultExecutor } from "./default.js";

/**
 * CodeBuddyIntlExecutor — talks to https://www.codebuddy.ai/v2/chat/completions
 *
 * Same OpenAI-compatible-but-stream-only gateway behavior as codebuddy-cn:
 * non-stream requests are rejected, and reasoning is surfaced only when the
 * request carries the IDE's OpenAI-style reasoning params. Force stream and
 * mirror reasoning_summary exactly like CodeBuddyExecutor.
 *
 * Additionally, CodeBuddy Intl requires a system message — without one it
 * returns 400 code 11101 "Parse message failed: invalid request". When the
 * client sends no system message (e.g. ping test), inject a minimal one.
 */
export class CodeBuddyIntlExecutor extends DefaultExecutor {
  constructor() {
    super("codebuddy-intl");
  }

  transformRequest(model, body, stream, credentials) {
    const transformed = super.transformRequest(model, body, stream, credentials);
    transformed.stream = true;

    if (!Array.isArray(transformed.messages) || !transformed.messages.some((m) => m.role === "system")) {
      transformed.messages = [
        { role: "system", content: "You are a helpful assistant." },
        ...(Array.isArray(transformed.messages) ? transformed.messages : []),
      ];
    }

    const eff = transformed.reasoning_effort;
    if (eff === "none" || eff === "off") {
      delete transformed.reasoning_effort;
    } else if (eff) {
      transformed.reasoning_summary = "auto";
    }
    return transformed;
  }
}

export default CodeBuddyIntlExecutor;
