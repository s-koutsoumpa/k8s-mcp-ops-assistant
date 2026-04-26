# Attributions

This document is the authoritative map between the external references used
in this thesis project and the specific files and sections of the codebase
they informed. It exists to make authorship transparent: it shows where I
relied on existing libraries, official documentation, or published prior
art, and what I built myself on top of those foundations.

The structure below mirrors the project's `src/` layout. Each entry names
the file, the relevant function or section, the external reference, the
exact URL, and a one-line note on what was reused versus what is mine.

For a high-level summary of the same information, see the **References**
section at the bottom of `README.md`.

---

## 1. External libraries declared in `package.json`

These are the npm packages the code calls into. Their use is standard for
any TypeScript/Node.js Kubernetes integration.

### `@modelcontextprotocol/sdk` — Model Context Protocol TypeScript SDK
- **Documentation:** https://modelcontextprotocol.io
- **Source:** https://github.com/modelcontextprotocol/typescript-sdk
- **Used in:**
  - `src/index.ts` — the `StreamableHTTPServerTransport` setup, the
    `POST /mcp` + `GET /mcp` + `DELETE /mcp` session pattern, the
    `sessionIdGenerator: () => randomUUID()` configuration, and the
    `onsessioninitialized` callback follow the SDK's official
    Streamable HTTP transport example.
  - `src/server.ts` — the `McpServer` class and the
    `server.tool(name, zodSchema, handler)` registration pattern.
- **Mine:** the choice of which tools to register, their input schemas,
  the per-session server map, and the dispatcher pattern in
  `execute_action`.

### `@kubernetes/client-node` — official Kubernetes client
- **Source:** https://github.com/kubernetes-client/javascript
- **Used in:**
  - `src/k8s/client.ts` — `KubeConfig`, `kc.loadFromDefault()`,
    `makeApiClient(AppsV1Api/CoreV1Api/CustomObjectsApi)`. Straight
    quickstart usage from the client's README.
  - `src/tools/read-tools.ts` and `src/tools/action-tools.ts` — every
    API call (`listNamespacedDeployment`, `readNamespacedDeployment`,
    `replaceNamespacedDeployment`, `patchNamespacedDeployment`,
    `readNamespacedPodLog`, `listNamespacedCustomObject`, etc.) is the
    SDK's API surface.
- **Mine:** which functions to expose, how to compose multiple API
  calls into a single MCP tool, and the JSON shape of each tool's
  return value.

### `express` — HTTP routing
- **Used in:** `src/index.ts` (`app.get`, `app.post`, `app.use(express.json())`).
  Standard Express usage.

### `zod` — input schema validation
- **Used in:** `src/server.ts` for every tool registration
  (`z.string()`, `z.number()`, `.default()`). Standard Zod usage.

---

## 2. Kubernetes API patterns and idioms

These are upstream Kubernetes patterns reimplemented in this codebase.
The pattern is theirs; the implementation here is mine.

### Rolling restart via timestamp annotation
- **Reference:** Kubernetes deployments documentation —
  https://kubernetes.io/docs/concepts/workloads/controllers/deployment/
- **Used in:** `src/tools/action-tools.ts` → `restartDeployment()`.
  Writing `kubectl.kubernetes.io/restartedAt` to trigger a rollout is
  exactly what `kubectl rollout restart` does internally.

### Rollback via previous ReplicaSet
- **Reference:** `kubectl rollout undo` —
  https://kubernetes.io/docs/reference/kubectl/generated/kubectl_rollout/kubectl_rollout_undo/
- **Used in:** `src/tools/action-tools.ts` → `rollbackDeployment()`.
  Looking up the prior ReplicaSet by `revision` annotation and patching
  the deployment template back is the post-1.16 replacement for the
  deprecated `spec.rollbackTo` field.

### `application/merge-patch+json` content type
- **Reference:** Kubernetes API concepts (PATCH operations)
- **Used in:** `src/tools/action-tools.ts` →
  `updateDeploymentImage()`, `patchDeploymentResources()`,
  `rollbackDeployment()`. Required by the Kubernetes API for partial
  updates.

### `metrics.k8s.io/v1beta1` custom resource
- **Reference:** Kubernetes metrics-server documentation
- **Used in:** `src/tools/read-tools.ts` → `getPodMetrics()`. The
  `(group, version, namespace, plural)` tuple is the standard way to
  read metrics-server data via the customObjects client.

### Probe field semantics
- **Reference:** Kubernetes "Configure Liveness, Readiness and Startup
  Probes" —
  https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/
- **Used in:** `src/analysis/probe-analyzer.ts` (entire file) and
  `src/tools/read-tools.ts` → `inspectProbes()`, `getProbeType()`. The
  fields `initialDelaySeconds`, `periodSeconds`, `timeoutSeconds`,
  `failureThreshold`, `successThreshold`, and the four probe styles
  (HTTP / TCP / exec / gRPC) come from this page.

### Image resolution and pull policy
- **Reference:** Kubernetes "Images" —
  https://kubernetes.io/docs/concepts/containers/images/
- **Used in:** `src/tools/action-tools.ts` → `updateDeploymentImage()`.
  The action only writes a new image string; the rest (registry
  resolution, default `imagePullPolicy=Always` for `:latest` or
  untagged, `IfNotPresent` for other tags, `imagePullSecrets` for
  private registries) is handled by Kubernetes itself. The README
  explains this to the reader; the code comment documents it inline.

### Kubelet event vocabulary
- **Reference:** Kubernetes scheduling and probe documentation; same as
  the K8sGPT pod analyzer's enumeration of error reasons
  (`isErrorReason()` in `pkg/analyzer/pod.go`)
- **Used in:** `src/analysis/analyzer.ts` → STEP 8. The exact strings
  matched (`ImagePullBackOff`, `ErrImagePull`, `Failed to pull image`,
  `FailedScheduling`, `Insufficient`, `Unhealthy`, `Readiness probe
  failed`, `Liveness probe failed`) are emitted directly by the
  scheduler and kubelet.

### Default probe `failureThreshold = 3`
- **Reference:** Kubernetes probes documentation (link above)
- **Used in:** `src/analysis/analyzer.ts` —
  `RESTART_INSTABILITY_THRESHOLD = 3`. We elevate restart-loop
  severity once the container restart count reaches Kubernetes' own
  default failure threshold.

---

## 3. Theoretical references and prior implementations

These are the "ideas behind the algorithm" sources. They map to specific
functions; the implementations here apply or adapt their methodology.

### K8sGPT — pod analyzer (rule-based diagnosis pattern)
- **Reference:** https://github.com/k8sgpt-ai/k8sgpt/blob/main/pkg/analyzer/pod.go
- **Used in:** `src/analysis/analyzer.ts` — STEPS 6 and 8. The pattern
  of iterating `containerStatuses` and inspecting `state.waiting` and
  `lastState.terminated` follows K8sGPT's
  `analyzeContainerStatusFailures()` function. The set of waiting-state
  reasons recognised (`CrashLoopBackOff`, `ImagePullBackOff`,
  `ErrImagePull`, etc.) is the same set K8sGPT's `isErrorReason()`
  helper enumerates. We use a narrower subset focused on the failure
  modes our remediation actions can address.
- **Mine:** the recommendations dispatched for each detected pattern,
  the severity model, the `combinedReasoning` field, and the entire
  `selectXxxProfile` decision logic (see below).

### Vertical Pod Autoscaler — recommender (percentile-based resource sizing)
- **Reference (docs):** https://kubernetes.io/docs/concepts/workloads/autoscaling/vertical-pod-autoscale/
- **Reference (source):** https://github.com/kubernetes/autoscaler/blob/master/vertical-pod-autoscaler/pkg/recommender/logic/recommender.go
- **Used in:** `src/analysis/resource-analyzer.ts` (entire file). Every
  numeric constant in the `VPA_*` block at the top of the file is
  taken from the default value of the corresponding command-line flag
  in the upstream recommender:
  - `target-cpu-percentile = 0.9`
  - `target-memory-percentile = 0.9`
  - `recommendation-lower-bound-cpu-percentile = 0.5`
  - `recommendation-upper-bound-cpu-percentile = 0.95`
  - `recommendation-margin-fraction = 0.15`
  - `pod-recommendation-min-cpu-millicores = 25`
  - `pod-recommendation-min-memory-mb = 250` (converted to ~238 Mi)
  The recommendation logic (use p90 + 15% margin for `requests`, p95 + 15%
  margin for `limits`, clamped to VPA minimum floors) follows VPA's own
  Target / UpperBound semantics.
- **Mine:** the four-value profile classification (`balanced`,
  `cpu_pressure`, `memory_pressure`, `underprovisioned`), the
  `PRESSURE_THRESHOLD_MULTIPLIER = 2.0` constant that controls when a
  workload is reported as "under pressure", the `percentileSignals`
  field exposed in the result, and the integration with the rest of the
  analysis pipeline.

### KEP-5734 — Pod hard-reset threshold (compared, not used)
- **Reference:** https://github.com/kubernetes/enhancements/issues/5734
- **Used in:** `src/analysis/analyzer.ts` — only as a documented
  contrast in the comment above `RESTART_INSTABILITY_THRESHOLD`. KEP-5734
  uses 7 as the threshold for "give up and reschedule"; our threshold of
  3 is the early-warning counterpart aligned with the kubelet's default
  probe `failureThreshold`.

### Panaversity Agent Factory — health-checks-probes
- **Reference:** https://agentfactory.panaversity.org/docs/Deploying-Agent-Factories-in-the-Cloud/kubernetes-for-ai-services/health-checks-probes
- **Used in:** `src/analysis/probe-analyzer.ts` —
  `buildProbeConfigFromProfile()`. The three profiles (`basic`,
  `slow_start`, `unstable`) and the specific timing values (e.g.
  `startupProbe` with `failureThreshold: 10` for slow-start) reflect
  the AI/ML probe guidance from this source. The "decouple startup from
  liveness via startupProbe" pattern in the system prompts comes from
  here too.

---

## 4. Safety policy: admission-controller and guardrail prior art

The architecture of `src/policies/action-policy.ts` mirrors two converging
bodies of prior work: the Kubernetes admission-controller pattern and
the LLM-agent tool-guardrail pattern.

### Kubernetes admission controllers (architectural pattern)
- **Reference:** https://kubernetes.io/docs/reference/access-authn-authz/admission-controllers/
- **Used in:** `src/policies/action-policy.ts` (entire file). The
  "deterministic policy gate runs before any cluster mutation" pattern
  is the same one Kubernetes admission controllers use on the API
  server. We apply it at the MCP-tool layer so LLM-generated actions
  are validated by plain code before they can reach the API.

### OPA Gatekeeper — `excludedNamespaces: ["kube-*"]` guidance
- **Reference (docs):** https://open-policy-agent.github.io/gatekeeper/website/docs/exempt-namespaces/
- **Used in:** `src/policies/action-policy.ts` → Rule 1 (`kube-system`
  block). Gatekeeper's own recommendation is to exempt `kube-*`
  namespaces from policy enforcement so constraints cannot break
  control-plane components. We apply the same principle in the inverse
  direction — making `kube-system` the target of an outright deny for
  our agent's writes.

### Kyverno — numeric range validation operators
- **Reference:** https://kyverno.io/docs/policy-types/cluster-policy/validate/
- **Used in:** `src/policies/action-policy.ts` → Rule 2 (replica range
  `[0, 10]`). Kyverno's `>=`, `<=`, and `-` operators on
  `validate.pattern` and `validate.cel.expressions` are the canonical
  way to express the same kind of closed-interval check we implement
  in TypeScript here.

### Kyverno — `disallow-latest-tag` ClusterPolicy
- **Reference:** https://kyverno.io/policies/best-practices/disallow-latest-tag/disallow-latest-tag/
- **Used in:** `src/policies/action-policy.ts` → Rule 3 (non-empty
  `newImage`). The Kyverno community ships a canonical
  `disallow-latest-tag` policy whose first rule (`require-image-tag`,
  pattern `image: "*:*"`) validates that the image string is present
  and tagged. Our check is the lighter cousin: we require the
  `newImage` parameter to be a non-empty string before letting the
  `update_image` action proceed.

### LangChain — agent guardrails (deterministic pre-execution checks)
- **Reference:** https://docs.langchain.com/oss/python/langchain/guardrails
- **Used in:** `src/policies/action-policy.ts` (file header). The
  guidance that guardrails should be fast, rule-based, and run on every
  tool call before the LLM context is the design principle behind our
  `validateAction()` function.

### Wiz — LLM guardrails (tool and function guardrails pattern)
- **Reference:** https://www.wiz.io/academy/ai-security/llm-guardrails
- **Used in:** `src/policies/action-policy.ts` (file header). Wiz's
  description of the "tool and function guardrails" pattern (action
  allowlists per role, pre-execution policy checks, scope and privilege
  enforcement) maps directly onto our policy layer.

---

## 5. n8n workflow nodes

The `Chat Trigger`, `AI Agent`, `OpenAI Chat Model`, and `MCP Client Tool`
nodes in `n8n/workflows/Kubernetes Q&A Assistant.json` and
`n8n/workflows/Kubernetes Diagnosis Assistant.json` are stock n8n LangChain
nodes. They are configured here, not implemented here.

- **AI Agent node:** https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.agent/
- **Chat Trigger:** https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-langchain.chattrigger/
- **MCP Client Tool:** https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.toolmcp/

What is mine in the n8n layer:
- The two-agent split (read-only Q&A vs diagnosis + remediation).
- Every system prompt under `n8n/system-prompts/` — the rules,
  ordering instructions, and remediation policies.
- The wiring of which MCP tools each agent is allowed to call.

---

## 6. Original contributions

This section lists what is genuinely my own work in this thesis, with
pointers to where to find it in the code.

- **Two-agent architecture (read-only Q&A vs diagnosis + remediation)** —
  represented by the two n8n workflow JSON files and their respective
  system prompts. Architectural choice; not present in any single
  cited source.
- **Single `execute_action` dispatcher** — `src/server.ts`, the
  `execute_action` tool. The choice to expose all write actions
  through one MCP tool with a `switch` over named actions (rather
  than one MCP tool per action) is mine.
- **Two-layer safety model** — `src/policies/action-policy.ts`. While
  each individual rule mirrors a corresponding admission-controller or
  Kyverno pattern (see Section 4), the combination — applying
  admission-controller-style determinism to MCP tool calls before they
  reach the Kubernetes API — and the specific rule set are mine.
- **`combinedReasoning` / `fixOrder` logic** — `src/analysis/analyzer.ts`,
  STEP 11. The ordering of multi-step remediations (e.g. resources
  before probes when both apply) is my contribution. K8sGPT does not
  emit this kind of cross-issue reasoning; VPA does not either.
- **Profile selection logic for probes** — `src/analysis/probe-analyzer.ts`
  → `selectProbeProfile()`. Decision rules: 3+ restarts → unstable,
  readiness failures → slow_start, else basic. Threshold is grounded
  in Kubernetes' default `failureThreshold = 3`, but the decision
  rules themselves are mine.
- **Profile selection logic for resources** —
  `src/analysis/resource-analyzer.ts` → `selectResourceProfile()` and
  the `PRESSURE_THRESHOLD_MULTIPLIER = 2.0` constant. The percentile
  inputs and minimum floors come from VPA, but the four-value profile
  classification and the "target ≥ 2× VPA floor → pressure" decision
  rule are mine.
- **System prompts in `n8n/system-prompts/`** — all rules, ordering
  instructions, verification rules, combined-reasoning guidance, and
  the preference for image fixes over rollbacks. Pure prompt engineering.
- **Synthetic fault scenarios** under `examples/` — the evaluation
  dataset for the thesis.
- **Per-session MCP server pattern** — `src/index.ts`. One `McpServer`
  object per session in the `servers` map, rather than the SDK's more
  common single-shared-server pattern.
- **Inline documentation** — every source file's "WHAT IS THIS FILE",
  "WHERE IS IT USED", "HOW IT FITS WITH THE REST OF THE SYSTEM"
  comment blocks, and the per-function step-by-step explanations.

---

## How to read this document

If you are reviewing this thesis for academic integrity, the test is
simple: pick any line of code in the repository, find the file in the
sections above, and you should be able to identify either (a) the
external reference that justifies it, or (b) a sentence in Section 6
claiming it as my own. If something in the code falls between these two
categories, that is a bug in this document — please flag it and I will
fix it.
