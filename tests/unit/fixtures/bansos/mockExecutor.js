// Bansos Gateway vertical acceptance suite (Task 14) — the ONE legitimate
// mock boundary for tests/unit/bansos-e2e.test.js: a getExecutor() test
// double installed via vi.mock("open-sse/executors/index.js", ...). Every
// other layer of the request chain (dashboardGuard.js -> chat.js ->
// chatCore.js -> the translator/stream machinery) runs for real against a
// real temporary SQLite adapter; this fixture only intercepts the point
// where chatCore.js would otherwise make a real outbound network call to a
// provider (see chatCore.js: `const executor = getExecutor(provider); ...
// executor.execute({...})`).
//
// Response-shape rationale (see open-sse/AGENTS.md's translator pivot notes
// and open-sse/handlers/chatCore/{sseToJsonHandler,streamingHandler}.js for
// the underlying mechanics this fixture leans on):
//
//   - grok-cli's registry entry (open-sse/providers/registry/grok-cli.js) has
//     transport.format = "openai-responses" and forceStream:true. chatCore.js
//     forces `stream = true` on EVERY dispatch to this provider regardless of
//     what the client asked for; it only reads the CLIENT's requested
//     `stream` value to decide whether it must additionally convert that
//     forced SSE back into single-shot JSON (handleForcedSSEToJson) before
//     answering a client that asked for `stream:false`.
//   - `jsonSuccessResponse()` therefore returns a genuine Responses-API SSE
//     event sequence (event: response.created / response.output_item.done /
//     response.completed) — the exact shape convertResponsesStreamToJson
//     parses — for the client-requested-non-streaming scenario.
//   - `streamSuccessResponse()` (and the error/disconnect streaming variants)
//     are used with a CLIENT stream:true request, which skips
//     handleForcedSSEToJson entirely and reaches the real streaming handler.
//     They carry `responseFormat: FORMATS.OPENAI` in the scenario entry so
//     chatCore.js's `providerResponseFormat = result.responseFormat ||
//     targetFormat` override defeats streamingHandler.js's buildTransformStream
//     `needsCodexTranslation` check (AND-gated: isResponsesProvider &&
//     targetFormat===OPENAI_RESPONSES — override-defeatable, UNLIKE
//     sseToJsonHandler.js's OR-gated isCodexResponsesApi, which stays true on
//     provider identity alone and can't be overridden this way). With the
//     override, sourceFormat===targetFormat==="openai" and the stream takes
//     the simple passthrough branch (open-sse/utils/stream.js), which is the
//     only mode that unconditionally emits a real `data: [DONE]\n\n`
//     sentinel — giving the test a genuine, assertable termination marker.
//
// Every scenario is consumed exactly once via `state.next.shift()` — chat.js's
// account-fallback loop can call executor.execute() more than once per client
// request (e.g. after a provider error, mark-unavailable + retry), so a test
// exercising fallback behavior must queue one entry per expected call.
import { FORMATS } from "open-sse/translator/formats.js";

function sseBodyStream(text) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Genuine Responses-API SSE event sequence (see file header). */
export function buildResponsesApiSSE({
  text = "Hello from the Bansos mock executor.",
  inputTokens = 12,
  outputTokens = 6,
} = {}) {
  const created = Math.floor(Date.now() / 1000);
  const blocks = [
    `event: response.created\ndata: ${JSON.stringify({ response: { id: "resp_mock_001", created_at: created } })}`,
    `event: response.output_item.done\ndata: ${JSON.stringify({
      output_index: 0,
      item: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
    })}`,
    `event: response.completed\ndata: ${JSON.stringify({
      response: { usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } },
    })}`,
    "data: [DONE]",
  ];
  return `${blocks.join("\n\n")}\n\n`;
}

/** Plain OpenAI Chat Completions SSE chunk sequence + a real [DONE] sentinel. */
export function buildOpenAIChatSSE({
  text = "Hello from the Bansos mock executor.",
  promptTokens = 11,
  completionTokens = 4,
} = {}) {
  const created = Math.floor(Date.now() / 1000);
  const deltaChunk = {
    id: "chatcmpl-mock-001", object: "chat.completion.chunk", created, model: "grok-4.5",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  };
  const finishChunk = {
    id: "chatcmpl-mock-001", object: "chat.completion.chunk", created, model: "grok-4.5",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
  };
  return `data: ${JSON.stringify(deltaChunk)}\n\ndata: ${JSON.stringify(finishChunk)}\n\ndata: [DONE]\n\n`;
}

/** Non-streaming success: a forced-SSE Responses-API body (see file header). */
export function jsonSuccessResponse(opts) {
  return new Response(sseBodyStream(buildResponsesApiSSE(opts)), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Streaming success: plain OpenAI SSE chunks. Pair with
 * `{ responseFormat: FORMATS.OPENAI }` in the queued scenario (see file
 * header) so the real streaming handler takes the passthrough branch.
 */
export function streamSuccessResponse(opts) {
  return new Response(sseBodyStream(buildOpenAIChatSSE(opts)), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * A stream that emits one real chunk then errors — exercises
 * pipeWithDisconnect/createDisconnectAwareStream's real handleError() path
 * (upstream connection failure mid-response). Pair with
 * `{ responseFormat: FORMATS.OPENAI }`.
 */
export function midStreamErrorResponse({ text = "partial answer before the connection died" } = {}) {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  const firstChunk = `data: ${JSON.stringify({
    id: "chatcmpl-mock-err", object: "chat.completion.chunk", created, model: "grok-4.5",
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  })}\n\n`;
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(firstChunk));
      // Deferred so the transform pipeline has actually started consuming
      // the first chunk before the "connection" dies — a closer analog of a
      // real mid-stream provider failure than an immediate error() call.
      setTimeout(() => controller.error(new Error("mock upstream connection reset")), 10);
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

/**
 * A stream that emits one real chunk and then never closes or errors — the
 * test drives termination itself via `response.body.cancel(reason)`,
 * exercising createDisconnectAwareStream's real cancel() -> handleDisconnect()
 * wiring (client-abandons-the-request scenario). Pair with
 * `{ responseFormat: FORMATS.OPENAI }`.
 */
export function neverEndingStreamResponse({ text = "still generating" } = {}) {
  const encoder = new TextEncoder();
  const created = Math.floor(Date.now() / 1000);
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        id: "chatcmpl-mock-open", object: "chat.completion.chunk", created, model: "grok-4.5",
        choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
      })}\n\n`));
      // Deliberately never close()/error() — see doc comment above.
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A non-ok upstream response — status/message configurable. */
export function providerErrorResponse({ status = 429, message = "mock upstream rate limited" } = {}) {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Fresh, per-test recording/queue state — call once per test. */
export function createMockExecutorState() {
  return { calls: [], next: [] };
}

/**
 * The getExecutor() replacement installed via
 * vi.mock("open-sse/executors/index.js", () => ({ getExecutor: () =>
 * installedExecutor, hasSpecializedExecutor: () => false })) in
 * bansos-e2e.test.js. `state.next` is a queue of
 * `{ response, responseFormat? }` entries a test pushes to before making a
 * request; an empty queue throws loudly rather than hanging, so a
 * mis-sequenced test fails fast instead of timing out.
 */
export function installMockExecutor(state) {
  return {
    noAuth: false,
    async execute(args) {
      state.calls.push(args);
      const scenario = state.next.shift();
      if (!scenario) {
        throw new Error(
          "mockExecutor: no scenario queued for call #" + state.calls.length +
          " — push { response, responseFormat? } onto state.next before dispatching",
        );
      }
      return {
        response: scenario.response,
        url: scenario.url || "https://mock.invalid/upstream",
        headers: scenario.headers || {},
        transformedBody: args.body,
        responseFormat: scenario.responseFormat,
      };
    },
    // Never exercised by this suite's scenarios (all responses are either
    // 200 or a non-401/403 error), but defined defensively so an accidental
    // 401/403 scenario fails with a clear rejection instead of "not a
    // function" if chatCore.js's refresh branch is ever reached.
    async refreshCredentials() {
      throw new Error("mockExecutor: refreshCredentials() should never be called by this suite's scenarios");
    },
  };
}

export const FIXTURE_FORMATS = FORMATS;
