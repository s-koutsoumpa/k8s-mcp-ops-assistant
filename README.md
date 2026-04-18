# Kubernetes MCP Operations Assistant

A conversational Kubernetes operations backend for inspection, diagnosis, and controlled remediation through MCP tools.

## What this project does

This project exposes Kubernetes operations through an MCP server written in TypeScript.
It is designed to work with an AI agent in n8n.

The project currently supports two main usage modes:

1. **Read-only inspection mode**
   - list namespaces
   - list deployments
   - inspect deployments
   - inspect pods
   - inspect events
   - inspect pod metrics
   - inspect pod logs
   - inspect liveness/readiness/startup probes

2. **Diagnosis and controlled action mode**
   - analyze deployment problems
   - analyze probe configuration
   - analyze pod resource usage
   - execute safe write actions after approval

## Project structure

```text
src/
├── index.ts                 # Express HTTP server and MCP transport
├── server.ts                # MCP tool registration
├── k8s/
│   └── client.ts            # Kubernetes API clients
├── tools/
│   ├── read-tools.ts        # Read-only Kubernetes functions
│   └── action-tools.ts      # Write actions for Kubernetes resources
├── analysis/
│   ├── analyzer.ts          # General deployment analysis rules
│   ├── probe-analyzer.ts    # Probe analysis rules
│   └── resource-analyzer.ts # Resource analysis rules
└── policies/
    └── action-policy.ts     # Safety checks for write actions
```

## Current MCP tools

### Read-only tools
- `list_namespaces`
- `list_deployments`
- `inspect_deployment`
- `inspect_pods`
- `inspect_events`
- `get_pod_metrics`
- `get_pod_logs`
- `inspect_probes`

### Analysis tools
- `analyze_deployment`
- `analyze_probes`
- `analyze_resources`

### Write tools
- `execute_action`
  - `restart`
  - `scale`
  - `update_image`
  - `patch_resources`
  - `patch_probes`
  - `rollback` (starter placeholder)

## Why this project is useful

The project is not trying to replace Kubernetes tooling.
Instead, it combines:
- Kubernetes APIs
- MCP tool exposure
- n8n conversational orchestration
- simple diagnosis logic
- controlled write actions with safety rules

This makes it possible to build a conversational assistant for Kubernetes inspection and controlled remediation.

## Safety model

Write actions are checked in `src/policies/action-policy.ts`.

Current rules include:
- never modify `kube-system`
- limit scaling to a maximum number of replicas
- validate required input such as `newImage`

## Running locally

Install dependencies:

```bash
npm install
```

Run in development mode:

```bash
npm run dev
```

The server will expose:

- `GET /health`
- `POST /mcp`
- `GET /mcp`
- `DELETE /mcp`

## n8n usage

### Workflow 1: Kubernetes Q&A Assistant
Use only the read-only tools:
- `list_namespaces`
- `list_deployments`
- `inspect_deployment`
- `inspect_pods`
- `inspect_events`
- `get_pod_metrics`
- `get_pod_logs`
- `inspect_probes`

### Workflow 2: Diagnosis & Controlled Action Assistant
Use:
- `analyze_deployment`
- `analyze_probes`
- `analyze_resources`
- `execute_action`

Suggested rule for workflow 2:
- always analyze first
- explain the issue
- ask for approval before any write action

## References used

### MCP
- Model Context Protocol documentation: https://modelcontextprotocol.io
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk

### Kubernetes client and APIs
- Official Kubernetes JavaScript/TypeScript client: https://github.com/kubernetes-client/javascript
- Kubernetes probes documentation: https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/
- Kubernetes probe concepts: https://kubernetes.io/docs/concepts/configuration/liveness-readiness-startup-probes/
- Kubernetes set image command: https://kubernetes.io/docs/reference/kubectl/generated/kubectl_set/kubectl_set_image/
- Kubernetes rollout undo command: https://kubernetes.io/docs/reference/kubectl/generated/kubectl_rollout/kubectl_rollout_undo/
- Kubernetes exec command: https://kubernetes.io/docs/reference/kubectl/generated/kubectl_exec/
- Kubernetes deployment concepts: https://kubernetes.io/docs/concepts/workloads/controllers/deployment/

### n8n
- AI Agent node docs: https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/
- Chat Trigger docs: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.chattrigger/
- MCP Client Tool docs: https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/

### Diagnostic inspiration
- K8sGPT repository: https://github.com/k8sgpt-ai/k8sgpt

### Probe guidance / educational reference
- Agent Factory health checks and probes page: https://agentfactory.panaversity.org/docs/Deploying-Agent-Factories-in-the-Cloud/kubernetes-for-ai-services/health-checks-probes

## Notes

- The current architecture relies directly on MCP tools, analysis modules, and controlled actions.
- Probe tuning is a strong future direction for this project.
