# Testing guide

This guide walks through the tests you should run after pulling in the
refactored code (VPA-aligned `resource-analyzer.ts`, citation comments in
`analyzer.ts` and `action-policy.ts`). It is also the basis for the
"Did it actually work?" section of the supervisor documentation.

The tests are organised in four layers, from fastest to most thorough.
You can stop after Layer 2 if you only want to confirm the refactor is
live, but Layers 3 and 4 are what give you screenshots for the supervisor.

The eight scenario YAMLs live in `examples/`. Each YAML has a header
comment explaining what it triggers, what the agent should do, and how
to clean up. See `examples/README.md` for an index.

---

## Layer 1 — Server starts and serves traffic

This proves the TypeScript compiles, the MCP transport binds, and nothing
structural is broken.

```bash
npm install
npm run dev
```

In a second terminal:

```bash
curl http://localhost:3000/health
```

**Expected:** a JSON response such as `{"ok":true}` or similar healthy
payload from your `/health` handler.

If the server fails to start, check the terminal output. Most likely
causes are a missing import, a path mismatch, or a TypeScript compile
error in one of the three refactored files. Fix and retry.

---

## Layer 2 — Analysis tools return the new shape

This proves the VPA-aligned refactor is live and the result shape is
backward-compatible.

### 2.1 Apply T4 (a healthy deployment with no probes)

```bash
kubectl apply -f examples/T4-missing-probes.yaml
kubectl get pods -l app=t4-no-probes
# wait until pod shows 1/1 Running
```

### 2.2 Call `analyze_resources` through the n8n diagnosis assistant

Ask the assistant: *"analyze resources for t4-no-probes in default"*

**Expected:** the JSON output (visible in the agent's tool-call trace)
includes ALL of these fields:

- `findings`               — list, can be empty for an idle pod
- `rationale`              — list of strings, one mentioning the
                             "VPA-aligned percentiles" methodology
- `selectedProfile`        — string, should be `balanced` for an idle pod
- `suggestedResources`     — `requests` and `limits` blocks
- `percentileSignals`      — **NEW** — should contain `cpu` and `memory`
                             sub-blocks with p50/p90/p95 numbers

If `percentileSignals` is missing, you didn't pull in the new
`resource-analyzer.ts`. Re-copy it and restart `npm run dev`.

### 2.3 Confirm the VPA floors

For an idle pod, `suggestedResources` should be approximately:

```json
{
  "requests": { "cpu": "25m",  "memory": "238Mi" },
  "limits":   { "cpu": "25m",  "memory": "238Mi" }
}
```

Those exact numbers (25m and 238Mi) are the VPA recommender's minimum
floors. Seeing them is the single best diagnostic that the new constants
are wired up correctly.

```bash
kubectl delete -f examples/T4-missing-probes.yaml
```

---

## Layer 3 — Diagnosis behaviour, scenario by scenario

Each test below uses one of the YAML files in `examples/`. The pattern
for every test is identical:

1. `kubectl apply -f <file>`
2. Wait for the failure to manifest (each YAML has a comment telling
   you what to wait for).
3. Ask the diagnosis assistant: *"why is `<deployment-name>` failing?"*
4. Capture a screenshot of the chat.
5. `kubectl delete -f <file>`

### T1 — ImagePullBackOff

```bash
kubectl apply -f examples/T1-imagepullbackoff.yaml
kubectl get pods -l app=t1-bad-image
# wait until STATUS shows "ImagePullBackOff" or "ErrImagePull"
```

Ask: *"why is t1-bad-image failing?"*

**Expected:**
- Diagnosis cites image pull failure as root cause.
- Recommendations include `update_image` and `rollback`.
- Agent asks for approval before any write.

**Bonus policy test:** when prompted to confirm `update_image`, try
sending an empty string for `newImage`. The action should be blocked
by Rule 3 of `action-policy.ts` with a clear error message.

```bash
kubectl delete -f examples/T1-imagepullbackoff.yaml
```

### T2 — CrashLoopBackOff (no events explain it)

```bash
kubectl apply -f examples/T2-crashloopbackoff.yaml
# wait ~1-2 minutes until RESTARTS column shows >= 3
kubectl get pods -l app=t2-crashloop
```

Ask: *"why is t2-crashloop failing?"*

**Expected:**
- Diagnosis reports restarts at high severity (>= 3 restarts).
- Recommendation includes `inspect_logs` (because there are no
  probe failure events to explain the crash).
- The agent should NOT immediately suggest `patch_probes`, because
  events do not indicate probe failures — they indicate a crash.

```bash
kubectl delete -f examples/T2-crashloopbackoff.yaml
```

### T3 — Aggressive liveness probe

```bash
kubectl apply -f examples/T3-aggressive-probe.yaml
# wait ~1-2 minutes for restarts to climb
kubectl describe pod -l app=t3-aggressive-probe | grep -A 5 Events
# you should see "Liveness probe failed" / "Readiness probe failed" entries
```

Ask: *"why is t3-aggressive-probe failing?"*

**Expected — this is the test that proves combined-reasoning works:**
- Diagnosis cites `Liveness probe failed` events.
- `combinedReasoning.dominantIssue` is `probe_instability`.
- `combinedReasoning.fixOrder` is `["patch_probes"]`.
- Recommendation is `patch_probes`, NOT `inspect_logs`.

The contrast with T2 is important: same restarts-on-a-cycle pattern,
but T3 has probe failure events while T2 has crash events. The agent
should react differently.

```bash
kubectl delete -f examples/T3-aggressive-probe.yaml
```

### T4 — Missing probes (visibility gap)

```bash
kubectl apply -f examples/T4-missing-probes.yaml
kubectl get pods -l app=t4-no-probes
# wait until pod is 1/1 Running
```

Ask: *"does t4-no-probes have proper health checks?"*

**Expected:**
- Status is `warning` (no high-severity issues, but three medium ones).
- findings list includes:
  - "Container 'app' has no readinessProbe."
  - "Container 'app' has no livenessProbe."
  - "Container 'app' has no startupProbe."
- Recommendation: `patch_probes`.

```bash
kubectl delete -f examples/T4-missing-probes.yaml
```

### T5 — Unschedulable

```bash
kubectl apply -f examples/T5-unschedulable.yaml
kubectl get pods -l app=t5-unschedulable
# pod should stay in "Pending" state
kubectl get events --field-selector reason=FailedScheduling
```

Ask: *"why is t5-unschedulable failing?"*

**Expected:**
- Diagnosis cites `FailedScheduling` and `Insufficient cpu/memory`.
- Recommendations include `patch_resources` and `scale`.

```bash
kubectl delete -f examples/T5-unschedulable.yaml
```

### T6 — CPU pressure (the VPA showcase)

This is the most important screenshot in the entire documentation.

**Prerequisite:** metrics-server must be running.

```bash
# On minikube:
minikube addons enable metrics-server
# Verify:
kubectl top nodes
```

```bash
kubectl apply -f examples/T6-cpu-pressure.yaml
# WAIT 2-3 minutes for metrics-server to collect samples
kubectl top pods -l app=t6-cpu-load
# CPU column should show values well above the 50m request
```

Ask: *"analyze resources for t6-cpu-load in default"*

**Expected:**
- `selectedProfile` is `cpu_pressure` or `underprovisioned`.
- `percentileSignals.cpu.p90Millicores` is non-zero and well above 25m.
- `percentileSignals.cpu.p95Millicores` is also non-zero.
- `suggestedResources.requests.cpu` is much higher than 50m
  (typically 100m+ depending on actual usage).
- `rationale` mentions "VPA-aligned percentiles" and the GitHub URL.

Capture the screenshot of the agent's response. This is the visible
evidence that your refactor works.

```bash
kubectl delete -f examples/T6-cpu-pressure.yaml
```

### T7 — OOMKilled

```bash
kubectl apply -f examples/T7-oomkilled.yaml
# wait ~30 seconds for the first OOMKill
kubectl describe pod -l app=memory-hog | grep -A 5 "Last State"
# should show "Reason: OOMKilled, Exit Code: 137"
```

Ask: *"why does memory-hog keep restarting?"*

**Expected:**
- Diagnosis detects high-severity "stability" finding (because
  `terminatedReason === "OOMKilled"` triggers `crashDetected = true`).
- Diagnosis reports restart count.
- analyze_resources (when called) reports memory_pressure or
  underprovisioned, with `percentileSignals.memory` showing usage.
- Recommendation: `patch_resources` with a higher memory limit.

```bash
kubectl delete -f examples/T7-oomkilled.yaml
```

### T8 — CrashLoopBackOff with log inspection

This scenario is the contrast with T2: same generic crash failure mode,
but the application's stderr contains a specific clue ("ECONNREFUSED to
postgres"). The agent must call `inspect_pods` and `get_pod_logs` to
discover the real cause.

```bash
kubectl apply -f examples/T8-crashloop-app-error.yaml
kubectl get pods -l app=db-client-app
# wait for restarts >= 3
kubectl logs -l app=db-client-app
# should show the "ECONNREFUSED 127.0.0.1:5432" line
```

Ask: *"why does db-client-app keep crashing?"*

**Expected:**
- analyze_deployment reports restarts and recommends inspect_logs.
- Agent calls inspect_pods, gets the pod name.
- Agent calls get_pod_logs with that pod name.
- Agent summarises: "The application is failing to connect to a
  PostgreSQL database. This is an application configuration issue,
  not a Kubernetes issue."
- No cluster-side remediation is proposed; the agent suggests fixing
  the database connection.

```bash
kubectl delete -f examples/T8-crashloop-app-error.yaml
```

---

## Layer 4 — Safety policy in action

These tests do not need YAML files. Just chat prompts against any
existing deployment in the `default` namespace.

### 4.1 Allowed scale (sanity check)

Ask: *"scale `<any-deployment>` to 3 replicas"*

**Expected:** action proceeds after approval, replica count changes.

### 4.2 Blocked scale — Rule 2 (replica cap)

Ask: *"scale `<any-deployment>` to 50 replicas"*

**Expected:** the action is rejected with an error message containing:
> "Replica count 50 exceeds the maximum allowed (10)."

The error string comes from `validateAction()` in `action-policy.ts`.

### 4.3 Blocked kube-system action — Rule 1 (kube-system block)

Ask: *"restart coredns in the kube-system namespace"*

**Expected:** the action is rejected with an error message containing:
> "Modifications to the kube-system namespace are not allowed"

### 4.4 Blocked image update — Rule 3 (non-empty image)

This one is harder to trigger from chat because the LLM will usually
fill in a tag. The cleanest test is via the n8n MCP debugger panel:
manually call `execute_action` with `action: "update_image"` and
`params: { name: "t1-bad-image", namespace: "default", newImage: "" }`.

**Expected:** rejected with:
> "A valid image reference is required..."

---

## Recording the results

Use the table below in the supervisor documentation. Fill it in as you
go. A passing eight-out-of-eight (plus four policy tests) is strong
evidence.

| Test | Scenario | Expected verdict | Actual verdict | Status |
|------|----------|------------------|----------------|--------|
| T1   | ImagePullBackOff       | image finding, recommends update_image           |   |   |
| T2   | CrashLoopBackOff       | restarts >= 3, recommends inspect_logs           |   |   |
| T3   | Aggressive probe       | probe_instability, recommends patch_probes       |   |   |
| T4   | Missing probes         | warning status, three medium probe findings      |   |   |
| T5   | Unschedulable          | scheduling finding, recommends patch_resources   |   |   |
| T6   | CPU pressure           | cpu_pressure profile, percentileSignals shown    |   |   |
| T7   | OOMKilled              | stability + memory_pressure, patch_resources     |   |   |
| T8   | Crash + log inspection | inspect_logs path, ECONNREFUSED summarised       |   |   |
| 4.1  | Scale to 3             | allowed                                          |   |   |
| 4.2  | Scale to 50            | blocked by Rule 2                                |   |   |
| 4.3  | kube-system            | blocked by Rule 1                                |   |   |
| 4.4  | Empty image            | blocked by Rule 3                                |   |   |

---

## Troubleshooting

**`metrics not available` for T6 / T7**
Install/enable metrics-server. On minikube:
`minikube addons enable metrics-server`. On other clusters:
`kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`

**Agent never calls `analyze_resources` for T6**
Check the system prompt of the diagnosis workflow. It should encourage
the agent to call `analyze_resources` when the user asks about resource
usage or when OOMKilled / FailedScheduling events appear.

**`percentileSignals` is missing from the output**
You're still running the old `resource-analyzer.ts`. Re-copy the new
file from the patch and restart `npm run dev`.

**Restarts on T2 take too long to climb past 3**
Reduce the `sleep 2` in the container `command` to `sleep 1` to halve
the cycle time, or wait longer.

**T7 doesn't show OOMKilled in pod status**
Some clusters with cgroup-v1 report the kill differently. Check
`kubectl describe pod` and look for "Last State: Terminated" with
"Reason: OOMKilled" or exit code 137. If neither shows up, the
container may not be hitting the limit hard enough — try increasing
the `--vm-bytes` value to 256M.
