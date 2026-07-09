"use server";

import { NextResponse } from "next/server";
import { buildSnippet } from "@/lib/cli-tools/snippets";
import { CLI_TOOLS } from "@/shared/constants/cliTools";

// POST /api/cli-tools/[tool]/snippet
// Body: { baseUrl, apiKey, model, models?, activeModel?, subagentModel? }
// Returns: { tool, files: [{ path, content, language, isCredential }], summary }
export async function POST(request, { params }) {
  try {
    const { tool } = await params;
    const body = await request.json();

    // Validate tool exists in registry
    if (!CLI_TOOLS[tool]) {
      return NextResponse.json(
        { error: `Unknown tool: ${tool}` },
        { status: 404 }
      );
    }

    // Only custom-type tools support snippet generation
    const toolDef = CLI_TOOLS[tool];
    if (toolDef.configType === "guide" || toolDef.configType === "mitm") {
      return NextResponse.json(
        { error: `Tool "${tool}" uses ${toolDef.configType} config type. Snippets are only available for auto-configurable tools.` },
        { status: 400 }
      );
    }

    const { baseUrl, apiKey, model, models, activeModel, subagentModel } = body;

    if (!baseUrl) {
      return NextResponse.json(
        { error: "baseUrl is required" },
        { status: 400 }
      );
    }

    const result = buildSnippet(tool, { baseUrl, apiKey, model, models, activeModel, subagentModel });

    if (!result) {
      return NextResponse.json(
        { error: `Snippet generation not supported for tool: ${tool}` },
        { status: 404 }
      );
    }

    return NextResponse.json(result);
  } catch (error) {
    console.log("Error generating snippet:", error);
    return NextResponse.json(
      { error: error.message || "Failed to generate snippet" },
      { status: 500 }
    );
  }
}
