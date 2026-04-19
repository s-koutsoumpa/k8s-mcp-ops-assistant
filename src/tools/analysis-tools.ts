// =============================================================================
// analysis-tools.ts
// =============================================================================
//
// WHAT IS THIS FILE?
// ------------------
// This file registers the "analyze_deployment" MCP tool with the MCP server.
//
// It is a thin bridge between the MCP server (which knows about tool names
// and JSON parameters) and the actual analysis logic (which lives in
// src/analysis/analyzer.ts).
//
// WHERE IS IT USED?
// -----------------
// Imported and called by src/server.ts during server startup.
// server.ts calls registerAnalysisTools(server) once, which adds the
// "analyze_deployment" tool to the server's tool registry.
//
// HOW IT FITS WITH THE REST OF THE SYSTEM
// ----------------------------------------
// The pattern in this codebase is to keep "tool registration" separate from
// "tool logic":
//
//   analysis-tools.ts  ← registers the MCP tool shape (name + parameters)
//   analyzer.ts        ← contains the actual analysis logic
//
// This file only handles the MCP plumbing. All the interesting decision-making
// (replica checks, probe checks, event parsing) happens in analyzer.ts.
//
// NOTE: server.ts also registers its own analyze_deployment tool inline.
// This file provides an alternative registration path that some earlier
// versions used. Both call the same underlying analyzeDeployment() function.
// =============================================================================

import { z } from "zod";
import { analyzeDeployment } from "../analysis/analyzer";


// =============================================================================
// registerAnalysisTools
// =============================================================================
//
// WHAT IT DOES:
//   Adds the "analyze_deployment" tool to the given MCP server instance,
//   so that AI agents can call it by name.
//
// WHEN TO USE IT:
//   Called once at startup from server.ts. Not called at request time.
//
// HOW IT WORKS:
//   STEP 1: Call server.tool() with the tool name, parameter schema, and
//           an async handler function.
//   STEP 2: When the agent calls "analyze_deployment", the handler receives
//           the validated parameters and calls analyzeDeployment().
//   STEP 3: Wrap the result in the MCP content format (type: "text", text: JSON).
//           The MCP protocol requires every tool response to be an array of
//           content blocks — even if there is only one piece of content.
// =============================================================================
export function registerAnalysisTools(server: any) {

  // STEP 1: Register the "analyze_deployment" tool.
  // z.string() is a Zod schema validator — it ensures the parameter is a
  // string before the handler runs (rejects numbers, nulls, etc.).
  server.tool(
    "analyze_deployment",
    {
      namespace: z.string(),
      deploymentName: z.string(),
    },

    // STEP 2: This async handler runs every time the agent calls the tool.
    async ({ namespace, deploymentName }: { namespace: string; deploymentName: string }) => {

      // Run the full deployment analysis (checks replicas, probes, events, etc.)
      const result = await analyzeDeployment(namespace, deploymentName);

      // STEP 3: Return the result in the MCP content format.
      // JSON.stringify with (null, 2) produces pretty-printed JSON
      // with 2-space indentation, which is easier for the AI to read.
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  );
}
