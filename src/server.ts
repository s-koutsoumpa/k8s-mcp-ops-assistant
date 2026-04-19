// =============================================================================
// server.ts
// =============================================================================
//
// WHAT IS THIS FILE?
// ------------------
// This file creates the MCP server and registers every tool that the AI agent
// can call. Think of it as the "menu" of the whole system — it lists every
// available operation and wires each one to the right implementation.
//
// WHERE IS IT USED?
// -----------------
// Imported by src/index.ts, which calls createMcpServer() once at startup
// to get a fully configured server object. index.ts then connects it to the
// HTTP transport so n8n can reach it.
//
// HOW IT FITS WITH THE REST OF THE SYSTEM
// ----------------------------------------
// This file sits at the center of the project:
//
//   index.ts  →  server.ts  →  tools/read-tools.ts      (read-only ops)
//                           →  tools/action-tools.ts    (write ops)
//                           →  policies/action-policy.ts (safety checks)
//                           →  analysis/analyzer.ts     (deployment analysis)
//                           →  analysis/probe-analyzer.ts
//                           →  analysis/resource-analyzer.ts
//
// THE THREE TOOL CATEGORIES:
// --------------------------
//   READ tools      — fetch data from the cluster (no side effects)
//   ANALYSIS tools  — interpret the data and suggest fixes
//   ACTION tools    — change the cluster (guarded by validateAction first)
//
// HOW execute_action WORKS:
// -------------------------
// All write operations go through the single "execute_action" tool.
// The flow is:
//   1. Agent calls execute_action with { action: "scale", params: {...} }
//   2. We call validateAction() — this throws if the action is not allowed
//   3. Only if validation passes do we call the real Kubernetes function
//
// This two-layer approach means the policy check (action-policy.ts) is
// always enforced, even if the agent tries to skip it.
// =============================================================================

// McpServer is the MCP SDK class that manages tool registration and routing.
// We use require() here because the MCP SDK packages use CommonJS modules.
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");

// z is the Zod validation library. We use it to describe the shape of each
// tool's input parameters. Zod checks the types before our handler runs,
// so we never get a string where a number is expected.
import { z } from "zod";

// READ tools — safe, no side effects
import {
  listDeployments,
  inspectDeployment,
  inspectPods,
  inspectEvents,
  listNamespaces,
  getPodMetrics,
  getPodLogs,
  inspectProbes,
} from "./tools/read-tools";

// ACTION tools — each one makes a change in the cluster
import {
  restartDeployment,
  scaleDeployment,
  updateDeploymentImage,
  patchDeploymentResources,
  patchDeploymentProbes,
  rollbackDeployment,
} from "./tools/action-tools";

// Safety guard — must run before any action tool
import { validateAction } from "./policies/action-policy";

// Analysis functions — interpret cluster state and suggest fixes
import { analyzeDeployment } from "./analysis/analyzer";
import { analyzeProbes } from "./analysis/probe-analyzer";
import { analyzeResources } from "./analysis/resource-analyzer";


// =============================================================================
// createMcpServer
// =============================================================================
//
// WHAT IT DOES:
//   Creates and returns a fully configured MCP server with all tools
//   registered. The returned server is ready to be connected to a transport
//   (done in index.ts).
//
// WHEN TO USE IT:
//   Called once at startup from index.ts. Not called per-request.
//
// HOW IT WORKS:
//   STEP 1:  Create a new McpServer instance with a name and version.
//   STEPS 2–10: Register each read tool (list, inspect, metrics, logs).
//   STEPS 11–13: Register each analysis tool (deployment, probes, resources).
//   STEP 14:  Register the execute_action tool with its policy gate.
//   STEP 15:  Return the finished server.
// =============================================================================
export function createMcpServer() {

  // STEP 1: Create the server.
  // The name and version are metadata that MCP clients can inspect.
  const server = new McpServer({
    name: "k8s-mcp-ops-assistant",
    version: "1.0.0",
  });


  // ---------------------------------------------------------------------------
  // STEP 2: list_deployments
  // ---------------------------------------------------------------------------
  // Returns a summary of all deployments in a namespace (name, replicas, etc.).
  // Default namespace is "default" if none is provided.
  // ---------------------------------------------------------------------------
  server.tool(
    "list_deployments",
    { namespace: z.string().default("default") },
    async ({ namespace }: { namespace: string }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await listDeployments(namespace), null, 2),
        },
      ],
    })
  );


  // ---------------------------------------------------------------------------
  // STEP 3: inspect_deployment
  // ---------------------------------------------------------------------------
  // Returns detailed info about a single named deployment (containers, images,
  // replica counts, labels, selector).
  // ---------------------------------------------------------------------------
  server.tool(
    "inspect_deployment",
    {
      name: z.string(),
      namespace: z.string().default("default"),
    },
    async ({ name, namespace }: { name: string; namespace: string }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await inspectDeployment(name, namespace), null, 2),
        },
      ],
    })
  );


  // ---------------------------------------------------------------------------
  // STEP 4: inspect_pods
  // ---------------------------------------------------------------------------
  // Returns the status of every pod in a namespace: phase, restarts, readiness.
  // ---------------------------------------------------------------------------
  server.tool(
    "inspect_pods",
    { namespace: z.string().default("default") },
    async ({ namespace }: { namespace: string }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await inspectPods(namespace), null, 2),
        },
      ],
    })
  );


  // ---------------------------------------------------------------------------
  // STEP 5: inspect_events
  // ---------------------------------------------------------------------------
  // Returns recent Kubernetes events for a namespace. Useful for spotting
  // image pull failures, scheduling issues, and probe failures.
  // ---------------------------------------------------------------------------
  server.tool(
    "inspect_events",
    { namespace: z.string().default("default") },
    async ({ namespace }: { namespace: string }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await inspectEvents(namespace), null, 2),
        },
      ],
    })
  );


  // ---------------------------------------------------------------------------
  // STEP 6: list_namespaces
  // ---------------------------------------------------------------------------
  // Returns all namespaces in the cluster. No parameters needed.
  // ---------------------------------------------------------------------------
  server.tool("list_namespaces", {}, async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(await listNamespaces(), null, 2),
      },
    ],
  }));


  // ---------------------------------------------------------------------------
  // STEP 7: get_pod_metrics
  // ---------------------------------------------------------------------------
  // Returns live CPU and memory usage per pod (requires metrics-server).
  // ---------------------------------------------------------------------------
  server.tool(
    "get_pod_metrics",
    { namespace: z.string().default("default") },
    async ({ namespace }: { namespace: string }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await getPodMetrics(namespace), null, 2),
        },
      ],
    })
  );


  // ---------------------------------------------------------------------------
  // STEP 8: get_pod_logs
  // ---------------------------------------------------------------------------
  // Returns the last 200 lines of logs from a pod.
  // "container" is optional — only needed if the pod has more than one container.
  // ---------------------------------------------------------------------------
  server.tool(
    "get_pod_logs",
    {
      podName: z.string(),
      namespace: z.string().default("default"),
      container: z.string().optional(),
    },
    async ({
      podName,
      namespace,
      container,
    }: {
      podName: string;
      namespace: string;
      container?: string;
    }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            await getPodLogs(podName, namespace, container),
            null,
            2
          ),
        },
      ],
    })
  );


  // ---------------------------------------------------------------------------
  // STEP 9: inspect_probes
  // ---------------------------------------------------------------------------
  // Returns the raw probe configuration for every container in a deployment.
  // Use this before analyze_probes if you want the unanalyzed raw data.
  // ---------------------------------------------------------------------------
  server.tool(
    "inspect_probes",
    {
      name: z.string(),
      namespace: z.string().default("default"),
    },
    async ({ name, namespace }: { name: string; namespace: string }) => ({
      content: [
        {
          type: "text",
          text: JSON.stringify(await inspectProbes(name, namespace), null, 2),
        },
      ],
    })
  );


  // ---------------------------------------------------------------------------
  // STEP 10: analyze_deployment
  // ---------------------------------------------------------------------------
  // The main diagnosis tool. Checks replica counts, probes, restarts, events,
  // and returns a structured report with findings and recommendations.
  // This is usually the agent's first step when investigating a problem.
  // ---------------------------------------------------------------------------
  server.tool(
    "analyze_deployment",
    {
      name: z.string(),
      namespace: z.string().default("default"),
    },
    async ({ name, namespace }: { name: string; namespace: string }) => {
      const result = await analyzeDeployment(namespace, name);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );


  // ---------------------------------------------------------------------------
  // STEP 11: analyze_probes
  // ---------------------------------------------------------------------------
  // Diagnoses probe configuration issues. Gathers probe info, pods, and events
  // then calls analyzeProbes() to detect missing/misconfigured probes and
  // suggest a corrected configuration.
  // ---------------------------------------------------------------------------
  server.tool(
    "analyze_probes",
    {
      name: z.string(),
      namespace: z.string().default("default"),
    },
    async ({ name, namespace }: { name: string; namespace: string }) => {

      // Gather the three inputs that analyzeProbes() needs.
      const probeInfo = await inspectProbes(name, namespace);
      const pods = await inspectPods(namespace);
      const events = await inspectEvents(namespace);

      const result = analyzeProbes({
        deploymentName: name,
        namespace,
        probeInfo,
        pods,
        events,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );


  // ---------------------------------------------------------------------------
  // STEP 12: analyze_resources
  // ---------------------------------------------------------------------------
  // Diagnoses CPU/memory problems. Fetches live pod metrics and calls
  // analyzeResources() to classify the workload and suggest better
  // CPU/memory request and limit values.
  // ---------------------------------------------------------------------------
  server.tool(
    "analyze_resources",
    {
      name: z.string(),
      namespace: z.string().default("default"),
    },
    async ({ name, namespace }: { name: string; namespace: string }) => {

      // Get live pod metrics from the metrics-server.
      const podMetrics = await getPodMetrics(namespace);

      const result = analyzeResources({
        deploymentName: name,
        namespace,
        podMetrics,
      });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );


  // ---------------------------------------------------------------------------
  // STEP 13: execute_action
  // ---------------------------------------------------------------------------
  // The single entry point for ALL write operations.
  //
  // The agent sends an action name (e.g. "scale") and a params object.
  // We validate the action first (validateAction throws if it is blocked),
  // then dispatch to the correct function in action-tools.ts.
  //
  // SUPPORTED ACTIONS:
  //   restart        → restartDeployment()
  //   scale          → scaleDeployment()
  //   update_image   → updateDeploymentImage()
  //   patch_resources → patchDeploymentResources()
  //   patch_probes   → patchDeploymentProbes()
  //   rollback       → rollbackDeployment()
  // ---------------------------------------------------------------------------
  server.tool(
    "execute_action",
    {
      action: z.string(),
      params: z.any(),
    },
    async ({ action, params }: { action: string; params: any }) => {

      // STEP 13a: Run the policy check first. If the action violates any rule
      // (e.g. targets kube-system, or scale > 10), validateAction() throws an
      // Error and we never reach the Kubernetes calls below.
      validateAction(action, params);

      // STEP 13b: Dispatch to the right action function.
      let result: any;

      switch (action) {
        case "restart":
          result = await restartDeployment(params.name, params.namespace);
          break;

        case "scale":
          result = await scaleDeployment(
            params.name,
            params.namespace,
            params.replicas
          );
          break;

        case "update_image":
          result = await updateDeploymentImage(
            params.name,
            params.namespace,
            params.containerName,
            params.newImage
          );
          break;

        case "patch_resources":
          result = await patchDeploymentResources(
            params.name,
            params.namespace,
            params.containerName,
            params.resources
          );
          break;

        case "patch_probes":
          result = await patchDeploymentProbes(
            params.name,
            params.namespace,
            params.containerName,
            params.probeConfig
          );
          break;

        case "rollback":
          result = await rollbackDeployment(params.name, params.namespace);
          break;

        default:
          throw new Error(`Unknown action: ${action}`);
      }

      // STEP 13c: Return the result in MCP content format.
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  // STEP 14: Return the fully configured server to index.ts.
  return server;
}
