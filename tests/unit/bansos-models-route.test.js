import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  isBansosHost: vi.fn(),
  buildModelsList: vi.fn(),
}));

vi.mock("@/lib/bansos/policy.js", () => ({
  isBansosHost: mocks.isBansosHost,
}));

vi.mock("@/lib/bansos/constants.js", () => ({
  PUBLIC_MODEL: "bansos/grok-4.5",
}));

// Mock the large expensive machinery that should NOT run for Bansos requests
vi.mock("@/shared/constants/models", () => ({
  PROVIDER_MODELS: {},
  PROVIDER_ID_TO_ALIAS: {},
  getModelKind: vi.fn(),
}));

vi.mock("@/shared/constants/providers", () => ({
  AI_PROVIDERS: {},
  getProviderAlias: vi.fn(),
  isAnthropicCompatibleProvider: vi.fn(),
  isOpenAICompatibleProvider: vi.fn(),
}));

const mockLocalDb = {
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
};

const mockDisabledDb = {
  getDisabledModels: vi.fn(),
};

vi.mock("@/lib/localDb", () => mockLocalDb);
vi.mock("@/lib/disabledModelsDb", () => mockDisabledDb);

vi.mock("open-sse/services/kiroModels.js", () => ({
  resolveKiroModels: vi.fn(),
}));

vi.mock("open-sse/services/kimchiModels.js", () => ({
  resolveKimchiModels: vi.fn(),
}));

vi.mock("open-sse/services/qoderModels.js", () => ({
  resolveQoderModels: vi.fn(),
}));

vi.mock("open-sse/services/copilotModels.js", () => ({
  resolveCopilotModels: vi.fn(),
}));

vi.mock("open-sse/services/clinepassModels.js", () => ({
  resolveClinepassModels: vi.fn(),
}));

vi.mock("open-sse/services/grokCliModels.js", () => ({
  resolveGrokCliModels: vi.fn(),
}));

vi.mock("open-sse/services/cursorModels.js", () => ({
  resolveCursorModels: vi.fn(),
}));

vi.mock("open-sse/shared/zedAuth.js", () => ({
  resolveZedModels: vi.fn(),
}));

vi.mock("@/sse/services/tokenRefresh", () => ({
  updateProviderCredentials: vi.fn(),
}));

vi.mock("@/lib/network/connectionProxy", () => ({
  resolveConnectionProxyConfig: vi.fn(),
}));

vi.mock("open-sse/providers/capabilities.js", () => ({
  capabilitiesFromServiceKind: vi.fn(),
  getCapabilitiesForModel: vi.fn(),
}));

const { GET, buildModelsList } = await import("../../src/app/api/v1/models/route.js");

describe("GET /v1/models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns one-model catalog for Bansos public host", async () => {
    mocks.isBansosHost.mockReturnValue(true);

    const request = {
      headers: {
        get: (name) => {
          if (name === "host") return "api.priaoslo.web.id";
          return null;
        },
      },
    };

    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      object: "list",
      data: [{ id: "bansos/grok-4.5", object: "model", owned_by: "bansos" }],
    });
  });

  it("returns one-model catalog with CORS header for Bansos public host", async () => {
    mocks.isBansosHost.mockReturnValue(true);

    const request = {
      headers: {
        get: (name) => {
          if (name === "host") return "api.priaoslo.web.id";
          return null;
        },
      },
    };

    const response = await GET(request);

    // Verify CORS header is present (like the existing path)
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("checks isBansosHost with the host header", async () => {
    mocks.isBansosHost.mockReturnValue(true);

    const request = {
      headers: {
        get: (name) => {
          if (name === "host") return "api.priaoslo.web.id";
          return null;
        },
      },
    };

    await GET(request);

    expect(mocks.isBansosHost).toHaveBeenCalledWith("api.priaoslo.web.id");
  });

  it("executes existing catalog path for non-Bansos hosts", async () => {
    // REGRESSION TEST: Ensure the expensive catalog path still runs for normal hosts
    mocks.isBansosHost.mockReturnValue(false);

    // Mock the DB functions to return empty results (this triggers the static model fallback path)
    mockLocalDb.getProviderConnections.mockResolvedValue([]);
    mockLocalDb.getCombos.mockResolvedValue([]);
    mockLocalDb.getCustomModels.mockResolvedValue([]);
    mockLocalDb.getModelAliases.mockResolvedValue({});
    mockDisabledDb.getDisabledModels.mockResolvedValue({});

    const request = {
      headers: {
        get: (name) => {
          if (name === "host") return "localhost";
          return null;
        },
      },
    };

    const response = await GET(request);

    expect(response.status).toBe(200);
    const body = await response.json();
    // Should return a response from buildModelsList (not the one-model Bansos response)
    // With mocked empty DB, it will return the static models from PROVIDER_MODELS (which is also mocked empty)
    expect(body.object).toBe("list");
    expect(Array.isArray(body.data)).toBe(true);
    // Verify the DB functions were actually called (proves we hit the buildModelsList path)
    expect(mockLocalDb.getProviderConnections).toHaveBeenCalled();
  });
});
