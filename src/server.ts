const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
import { z } from "zod";

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

import {
  restartDeployment,
  scaleDeployment,
  updateDeploymentImage,
  patchDeploymentResources,
  patchDeploymentProbes,
  rollbackDeployment,
} from "./tools/action-tools";

import { validateAction } from "./policies/action-policy";
import { analyzeDeployment } from "./analysis/analyzer";
import { analyzeProbes } from "./analysis/probe-analyzer";
import { analyzeResources } from "./analysis/resource-analyzer";

export function createMcpServer() {
  const server = new McpServer({
    name: "k8s-mcp-ops-assistant",
    version: "1.0.0",
  });

  // -------------------------
  // READ-ONLY TOOLS
  // -------------------------

  server.tool(
    "list_deployments",
    { namespace: z.string().default("default") },
    async ({ namespace }: { namespace: string }) => ({
      content: [
        { type: "text", text: JSON.stringify(await listDeployments(namespace), null, 2) },
      ],
    })
  );

  server.tool(
    "inspect_deployment",
    {
      name: z.string(),
      namespace: z.string().default("default"),
    },
    async ({ name, namespace }: { name: string; namespace: string }) => ({
      content: [
        { type: "text", text: JSON.stringify(await inspectDeployment(name, namespace), null, 2) },
      ],
    })
  );

  server.tool(
    "inspect_pods",
    { namespace: z.string().default("default") },
    async ({ namespace }: { namespace: string }) => ({
      content: [
        { type: "text", text: JSON.stringify(await inspectPods(namespace), null, 2) },
      ],
    })
  );

  server.tool(
    "inspect_events",
    { namespace: z.string().default("default") },
    async ({ namespace }: { namespace: string }) => ({
      content: [
        { type: "text", text: JSON.stringify(await inspectEvents(namespace), null, 2) },
      ],
    })
  );

  server.tool("list_namespaces", {}, async () => ({
    content: [{ type: "text", text: JSON.stringify(await listNamespaces(), null, 2) }],
  }));

  server.tool(
    "get_pod_metrics",
    { namespace: z.string().default("default") },
    async ({ namespace }: { namespace: string }) => ({
      content: [
        { type: "text", text: JSON.stringify(await getPodMetrics(namespace), null, 2) },
      ],
    })
  );

  server.tool(
    "get_pod_logs",
    {
      podName: z.string(),
      namespace: z.string().default("default"),
      container: z.string().optional(),
    },
    async ({ podName, namespace, container }: { podName: string; namespace: string; container?: string }) => ({
      content: [
        { type: "text", text: JSON.stringify(await getPodLogs(podName, namespace, container), null, 2) },
      ],
    })
  );

  server.tool(
    "inspect_probes",
    {
      name: z.string(),
      namespace: z.string().default("default"),
    },
    async ({ name, namespace }: { name: string; namespace: string }) => ({
      content: [
        { type: "text", text: JSON.stringify(await inspectProbes(name, namespace), null, 2) },
      ],
    })
  );

  // -------------------------
  // ANALYSIS TOOLS
  // -------------------------

  server.tool(
    "analyze_deployment",
    {
      name: z.string(),
      namespace: z.string().default("default"),
    },
    async ({ name, namespace }: { name: string; namespace: string }) => {
      const deployment = await inspectDeployment(name, namespace);
      const pods = await inspectPods(namespace);
      const events = await inspectEvents(namespace);

      const result = analyzeDeployment({ deployment, pods, events });

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  server.tool(
    "analyze_probes",
    {
      name: z.string(),
      namespace: z.string().default("default"),
    },
    async ({ name, namespace }: { name: string; namespace: string }) => {
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

  server.tool(
    "analyze_resources",
    {
      name: z.string(),
      namespace: z.string().default("default"),
    },
    async ({ name, namespace }: { name: string; namespace: string }) => {
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

  // -------------------------
  // WRITE ACTIONS
  // -------------------------

  server.tool(
    "execute_action",
    {
      action: z.string(),
      params: z.any(),
    },
    async ({ action, params }: { action: string; params: any }) => {
      validateAction(action, params);

      let result: any;

      switch (action) {
        case "restart":
          result = await restartDeployment(params.name, params.namespace);
          break;
        case "scale":
          result = await scaleDeployment(params.name, params.namespace, params.replicas);
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

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  return server;
}