# Test scenarios

This folder contains eight YAML manifests that produce specific
Kubernetes failure modes the assistant is designed to detect, diagnose,
and (where appropriate) remediate. Together they form the evaluation
dataset referenced in the thesis proposal.

The full procedure for running them — what to expect, what to capture
for the supervisor documentation, and the policy tests that don't need
YAMLs — is documented in [`../TESTING.md`](../TESTING.md).

## Scenario index

| ID | File | Failure mode | Code paths exercised |
|----|------|--------------|----------------------|
| T1 | `T1-imagepullbackoff.yaml` | ImagePullBackOff (bad image tag) | `analyzer.ts` STEP 8 image-pull keywords; policy Rule 3 (when fixing with empty image) |
| T2 | `T2-crashloopbackoff.yaml` | CrashLoopBackOff (clean exit 1, no events) | `analyzer.ts` `RESTART_INSTABILITY_THRESHOLD = 3`; recommendation falls through to `inspect_logs` |
| T3 | `T3-aggressive-probe.yaml` | Probe-induced restarts (slow startup + tight liveness probe) | `analyzer.ts` `combinedReasoning.dominantIssue = "probe_instability"`; `probe-analyzer.ts` profile selection |
| T4 | `T4-missing-probes.yaml` | All three probes missing on a healthy pod | `analyzer.ts` STEP 5 missing-probe findings |
| T5 | `T5-unschedulable.yaml` | FailedScheduling (resources no node can satisfy) | `analyzer.ts` STEP 8 `FailedScheduling` / `Insufficient` keywords |
| T6 | `T6-cpu-pressure.yaml` | Sustained CPU throttling | `resource-analyzer.ts` percentile path; `cpu_pressure` profile; `percentileSignals` block populated |
| T7 | `T7-oomkilled.yaml` | OOMKilled (allocates over its memory limit) | `analyzer.ts` STEP 6 `terminatedReason === "OOMKilled"` branch; `resource-analyzer.ts` `memory_pressure` profile |
| T8 | `T8-crashloop-app-error.yaml` | CrashLoopBackOff with no events explaining it (logs only) | `analyzer.ts` "no unhealthy events → recommend inspect_logs" branch; full read flow including `inspect_pods` and `get_pod_logs` |

## Quick reference

```bash
# Apply one scenario:
kubectl apply -f T1-imagepullbackoff.yaml

# Watch what happens:
kubectl get pods -l scenario=t1-imagepullbackoff -w

# Run the diagnosis through the n8n diagnosis assistant.

# Clean up before moving to the next scenario:
kubectl delete -f T1-imagepullbackoff.yaml
```

## Prerequisites

Some scenarios need metrics-server to be installed in the cluster.
T6 and T7 require it; the rest do not.

```bash
# On minikube:
minikube addons enable metrics-server

# Verify metrics-server is responding:
kubectl top nodes
```

If `kubectl top` returns "metrics not available", wait a minute and
try again. metrics-server typically needs 30–60 seconds to start
collecting samples after it comes up.

## Coverage rationale

Each scenario was chosen to exercise a specific code path that other
scenarios do not cover:

- **T1, T5** — pattern-matching against Kubernetes events and pod
  waiting-state reasons (the K8sGPT-style diagnosis pattern).
- **T2, T8** — the two CrashLoopBackOff variants. T2 has clean exit
  signals so the agent recommends inspecting logs; T8 has a specific
  application log line and demonstrates the full read flow
  (`inspect_pods` → `get_pod_logs` → summarise).
- **T3** — probe-induced restarts where the diagnosis must distinguish
  probe failures from generic crashes (the contrast with T2 and T8).
- **T4** — the missing-probes branch, which produces a "warning" status
  even when the pod is otherwise healthy.
- **T6, T7** — the two ways resources can fail: chronic pressure (T6)
  and acute kill (T7). T6 is the showcase for the VPA-aligned
  percentile-based recommendation path; T7 specifically exercises the
  OOMKilled detection branch.

The four policy tests (replica-cap, kube-system block, empty image,
allowed scale) require no YAMLs and are documented in `../TESTING.md`.
