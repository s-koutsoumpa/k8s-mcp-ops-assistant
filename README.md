# Kubernetes MCP Operations Assistant

A conversational Kubernetes operations backend for inspection, diagnosis, and
controlled remediation through MCP tools and n8n workflow orchestration.

This repository is the implementation for a diploma thesis on an AI-powered
Kubernetes operations assistant with automated error detection and
human-approved remediation.

## What this project does

This project exposes Kubernetes operations through an MCP (Model Context
Protocol) server written in TypeScript. It is designed to work with an AI
agent in n8n, using the OpenAI API as the reasoning engine.

The system is composed of two agents, each implemented as a separate n8n
workflow:

1. **Q&A Assistant (read-only)**
   - List namespaces, deployments, pods, and events
   - Inspect deployment details, probe configuration, and resource metrics
   - Read pod logs
   - Strictly forbidden from modifying cluster state

2. **Diagnosis & Remediation Assistant (read + controlled write)**
   - Analyze deployment problems and generate root-cause explanations
   - Analyze probe configuration and suggest profile-based tuning
   - Analyze pod resource usage and suggest VPA-aligned resource tuning
   - Inspect pods and read logs when events do not explain the failure
   - Execute remediation actions (restart, scale, update image, patch probes,
     patch resources, rollback) only after explicit user approval

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
│   ├── probe-analyzer.ts    # Probe analysis and profile-based tuning
│   └── resource-analyzer.ts # Resource analysis and VPA-aligned tuning
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
- `analyze_deployment` — detects image pull failures, restart loops,
  scheduling issues, probe-related instability, and combined reasoning
  across multiple issue types
- `analyze_probes` — classifies probe health into profiles (stable,
  unstable, aggressive, missing) and generates concrete probe configs
- `analyze_resources` — computes VPA-aligned percentile estimates
  (p50/p90/p95) of CPU and memory, classifies workloads into resource
  profiles (balanced, cpu_pressure, memory_pressure, underprovisioned),
  and generates concrete resource specs

### Write tools
- `execute_action`
  - `restart` — rolling restart of a deployment
  - `scale` — change replica count (capped at 10 by policy)
  - `update_image` — change a container image
  - `patch_resources` — update CPU and memory requests/limits
  - `patch_probes` — update liveness, readiness, or startup probes
  - `rollback` — revert to the previous ReplicaSet revision

## Why this project is useful

This project does not try to replace existing Kubernetes tooling. Instead,
it combines several layers into a conversational assistant:

- Kubernetes APIs (via `@kubernetes/client-node`)
- MCP tool exposure (via `@modelcontextprotocol/sdk`)
- n8n conversational orchestration (AI Agent + MCP Client + OpenAI)
- Rule-based diagnosis logic in dedicated analyzer modules, with the
  pattern-matching approach grounded in K8sGPT's pod analyzer
- Profile-based probe tuning grounded in Kubernetes probe theory
- VPA-aligned percentile-based resource tuning grounded in the upstream
  Vertical Pod Autoscaler recommender
- Controlled write actions guarded by a deterministic safety policy whose
  rules mirror established admission-controller patterns from OPA
  Gatekeeper and Kyverno
- Human-in-the-loop approval before any cluster state is modified

The result is an assistant that is intelligent enough to diagnose and
suggest fixes, yet safe enough to require human approval before any
cluster state is modified.

## Resource tuning model

The `analyze_resources` tool returns recommendations derived from VPA's
own percentile-based methodology, applied to the live pod metrics of the
target deployment. The defaults mirror the VPA recommender's command-line
flag defaults:

- 50th percentile is used as the lower bound (minimum the workload
  typically needs)
- 90th percentile is used as the target for `requests`
- 95th percentile is used as the upper bound for `limits`
- A 15% safety margin is added on top of every estimate
- Estimates are floored to a minimum of 25 millicores CPU and ~238 Mi
  memory (VPA's defaults of 25m CPU and 250 MB)
- A workload is reported as "under pressure" on a resource only when the
  computed target has climbed to at least twice the VPA minimum floor —
  evidence of real consumption rather than the floor being applied to an
  idle workload

The full result of `analyze_resources` includes a `percentileSignals`
field exposing the raw measurements (`p50`, `p90`, `p95`, target with
margin, upper bound with margin) so the agent can show transparent
reasoning to the user.

## Diagnosis model

The `analyze_deployment` tool follows the same rule-based diagnosis
approach K8sGPT uses in its `pkg/analyzer/pod.go` — it inspects pod
container statuses for known waiting-state reasons (`ImagePullBackOff`,
`ErrImagePull`, `CrashLoopBackOff`) and scans recent Kubernetes events
for known message keywords (`FailedScheduling`, `Insufficient`,
`Liveness probe failed`, `Readiness probe failed`, `Unhealthy`).

The severity escalation threshold for restart loops is set to `>= 3`
restarts, which aligns with the kubelet's own default `failureThreshold`
of 3 for liveness, readiness, and startup probes.

The `combinedReasoning` field of the result decides which problem to
fix first when several are present at once. The default ordering is
resources before probes, because stabilizing resource availability
first is usually safer than tuning probes against an unstable runtime.

## Safety model

Write actions are checked in `src/policies/action-policy.ts` before they
are executed. The policy layer is a deterministic backstop — it runs even
after the user has approved in chat, so it protects against LLM
hallucinations and prompt injection.

The architecture mirrors the Kubernetes admission-controller pattern used
by OPA Gatekeeper and Kyverno: a deterministic rule engine evaluates every
write request before it can mutate cluster state. We apply the same
pattern at the MCP-tool layer.

Current rules:

- **Never modify the `kube-system` namespace** — protects core cluster
  components. Mirrors OPA Gatekeeper's recommended `excludedNamespaces:
  ["kube-*"]` exemption pattern, applied here as an outright deny.
- **Limit scaling to a maximum of 10 replicas** — protects the test
  cluster from accidental resource exhaustion. Mirrors Kyverno's
  numeric range validation pattern (`>=`, `<=`, `-` operators) for
  field constraints.
- **Require a non-empty `newImage` value for `update_image`** — prevents
  silently breaking deployments with an undefined image. Mirrors the
  `require-image-tag` rule from Kyverno's canonical `disallow-latest-tag`
  ClusterPolicy.

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

- `GET /health` — liveness check
- `POST /mcp` — MCP session initialization and message handling
- `GET /mcp` — MCP server-sent events stream (per session)
- `DELETE /mcp` — MCP session termination

By default the server binds to `0.0.0.0:3000`. If you are running n8n in a
container or VM, point it at your host IP (for Minikube this is usually
`192.168.49.1:3000/mcp`).

## n8n usage

Both workflows are included in this repository as exported JSON files and
can be imported directly into n8n.

### Workflow 1: Kubernetes Q&A Assistant

Read-only inspection only. The MCP Client node exposes these tools to the
agent:

- `list_namespaces`
- `list_deployments`
- `inspect_deployment`
- `inspect_pods`
- `inspect_events`
- `get_pod_metrics`
- `get_pod_logs`
- `inspect_probes`

The system prompt forbids the agent from recommending changes or claiming
to have modified the cluster.

### Workflow 2: Diagnosis & Remediation Assistant

Analysis and controlled remediation. The MCP Client node exposes:

- `analyze_deployment`
- `analyze_probes`
- `analyze_resources`
- `inspect_pods`
- `get_pod_logs`
- `execute_action`

The system prompt enforces:

1. Always analyze before suggesting an action.
2. Explain the root cause in plain language.
3. Ask for explicit user approval before executing any write action.
4. After any execute_action, call analyze_deployment again to verify
   the fix.
5. Use combinedReasoning from analyze_deployment to order multi-step
   remediations correctly.

## Image resolution and pull behaviour

The `update_image` action only changes the image *string* on the
deployment's container spec; the rest is handled by Kubernetes itself.
Two notes worth remembering:

- An unqualified image like `nginx:1.25` is resolved by Kubernetes as
  `docker.io/library/nginx:1.25` (Docker Hub is the default registry).
- The kubelet picks `imagePullPolicy=Always` automatically for `:latest`
  or untagged images, and `IfNotPresent` for any other tag. Private
  registries require `imagePullSecrets` on the pod template, which this
  action does not modify.

For full details, see the Kubernetes images documentation:
https://kubernetes.io/docs/concepts/containers/images/

## References

A full mapping of every external reference to the file and section it
informed is maintained in `ATTRIBUTIONS.md` at the root of this repository.
The major references are summarised below.

### MCP
- Model Context Protocol documentation: https://modelcontextprotocol.io
- MCP TypeScript SDK: https://github.com/modelcontextprotocol/typescript-sdk

### Kubernetes client and APIs
- Official Kubernetes JavaScript/TypeScript client: https://github.com/kubernetes-client/javascript
- Kubernetes probes documentation: https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/
- Kubernetes deployment concepts (rolling restart, rollout undo): https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
- Kubernetes images (pull policy, registry resolution): https://kubernetes.io/docs/concepts/containers/images/
- Kubernetes admission controllers: https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/

### n8n
- AI Agent node docs: https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/
- Chat Trigger docs: https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.chattrigger/
- MCP Client Tool docs: https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/

### Diagnostic theory
- K8sGPT pod analyzer (waiting-state reason set, event-keyword pattern):
  https://github.com/k8sgpt-ai/k8sgpt/blob/main/pkg/analyzer/pod.go

### Resource tuning theory
- Vertical Pod Autoscaler (Kubernetes SIG Autoscaling): https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler
- VPA recommender source (percentile defaults, safety margin, minimum
  floors): https://github.com/kubernetes/autoscaler/blob/master/vertical-pod-autoscaler/pkg/recommender/logic/recommender.go

### Probe tuning theory
- Agent Factory health checks and probes page: https://agentfactory.panaversity.org/docs/Deploying-Agent-Factories-in-the-Cloud/kubernetes-for-ai-services/health-checks-probes

### Safety policy theory
- OPA Gatekeeper exempt-namespaces guidance: https://open-policy-agent.github.io/gatekeeper/website/docs/exempt-namespaces/
- Kyverno validate rules (numeric range operators): https://kyverno.io/docs/policy-types/cluster-policy/validate/
- Kyverno `disallow-latest-tag` ClusterPolicy: https://kyverno.io/policies/best-practices/disallow-latest-tag/disallow-latest-tag/
- LangChain agent guardrails (deterministic pre-execution checks): https://docs.langchain.com/oss/python/langchain/guardrails
- Wiz LLM guardrails (tool and function guardrails pattern): https://www.wiz.io/academy/ai-security/llm-guardrails

## Notes

- The current architecture relies directly on MCP tools, analysis modules,
  and controlled actions.
- The `rollback` action uses the ReplicaSet approach (compatible with
  Kubernetes 1.16+); the deprecated `spec.rollbackTo` field is not used.
- All code files include detailed beginner-friendly comments explaining
  what each function does, when to use it, and how it works. Where the
  logic is informed by an external reference, the citation is included
  inline in the code comment as well.