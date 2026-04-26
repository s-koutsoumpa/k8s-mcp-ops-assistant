// =============================================================================
// analyzer.ts
// =============================================================================
//
// WHAT IS THIS FILE?
// ------------------
// This file contains the core deployment health analysis logic. Given a
// namespace and deployment name, it inspects the deployment from multiple
// angles and returns a structured report describing what is wrong and what
// to do about it.
//
// METHODOLOGICAL REFERENCE — K8sGPT pod analyzer:
// ------------------------------------------------
// The "scan recent events and pod container statuses for known error patterns"
// approach used in this file is the same approach K8sGPT uses in its Pod
// analyzer. We follow the same pattern (categorize by waiting-state reason
// and event-message keywords) and use the same vocabulary of error reasons
// (ImagePullBackOff, ErrImagePull, CrashLoopBackOff, FailedScheduling,
// Liveness/Readiness probe failed). For the upstream reference, see:
//
//   https://github.com/k8sgpt-ai/k8sgpt/blob/main/pkg/analyzer/pod.go
//
// In particular, K8sGPT's analyzeContainerStatusFailures() function and its
// isErrorReason() helper enumerate the same set of waiting-state reasons we
// look for below ("CrashLoopBackOff", "ImagePullBackOff",
// "CreateContainerConfigError", "PreCreateHookError", "CreateContainerError",
// "PreStartHookError", "RunContainerError", "ImageInspectError",
// "ErrImagePull", "ErrImageNeverPull", "InvalidImageName"). We use a
// narrower subset focused on the failure modes our remediation actions
// can address (image pulls, scheduling, probes, restarts).
//
// EVENT KEYWORDS REFERENCE — Kubernetes scheduler & kubelet:
// ----------------------------------------------------------
// The event-message keywords we match ("FailedScheduling", "Insufficient",
// "Readiness probe failed", "Liveness probe failed", "Unhealthy") are emitted
// directly by the Kubernetes scheduler and kubelet:
//   - https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/
//   - https://kubernetes.io/docs/concepts/scheduling-eviction/
//
// WHERE IS IT USED?
// -----------------
// Called by:
//   - src/tools/analysis-tools.ts (via the "analyze_deployment" MCP tool)
//   - src/server.ts               (also registers its own analyze_deployment tool)
//
// HOW IT FITS WITH THE REST OF THE SYSTEM
// ----------------------------------------
// This file is the "brain" of the read side. The typical flow is:
//
//   1. Agent calls analyze_deployment
//   2. analyzeDeployment() runs here — fetches data, builds findings,
//      and returns a DeploymentAnalysisResult
//   3. The agent reads the result and decides which action to take
//   4. If action is needed, the agent calls execute_action in server.ts
//      which goes through action-policy.ts → action-tools.ts
//
// This file ONLY reads — it never modifies the cluster.
// =============================================================================

import { appsV1, coreV1 } from "../k8s/client";
import { suggestSmartResources } from "./resource-analyzer";

// These are the only allowed values for "how bad is this problem?"
type Severity = "low" | "medium" | "high";

// These are the only allowed values for "how healthy is the deployment overall?"
type AnalysisStatus = "healthy" | "warning" | "critical";

// A single problem we found (e.g. "too many restarts")
interface Finding {
  type: string;       // category of the problem (e.g. "probe", "image")
  severity: Severity; // how serious it is
  message: string;    // human-readable description
}

// A suggested fix for a problem
interface Recommendation {
  action: string; // short name of the action (e.g. "patch_probes")
  reason: string; // why we suggest this action
}

// The full result returned by analyzeDeployment()
interface DeploymentAnalysisResult {
  namespace: string;
  deployment: string;
  status: AnalysisStatus;
  summary: string;
  findings: Finding[];
  probableCauses: string[];
  recommendations: Recommendation[];
  safeToAutoRemediate: boolean; // whether it is safe to fix without human approval
  combinedReasoning?: {
    dominantIssue: string; // the main problem type
    fixOrder: string[];    // in what order to apply fixes
    explanation: string;   // plain English explanation
  };
}


// -----------------------------------------------------------------------------
// Restart-count threshold for "the deployment is meaningfully unstable"
// -----------------------------------------------------------------------------
// We elevate a "restarts" finding from medium to high severity once the
// total container restart count across the deployment reaches this number.
//
// REFERENCE: Kubernetes uses 3 as the default failureThreshold for liveness,
// readiness, and startup probes. Three failures is "the kubelet's official
// definition of unstable" — see:
//
//   https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/
//
// We pick the same number so our severity escalation aligns with the
// kubelet's own failure model. The KEP for automatic Pod hard-reset
// (KEP-5734) uses 7 as the late-stage threshold; ours is the early-warning
// counterpart.
//   https://github.com/kubernetes/enhancements/issues/5734
// -----------------------------------------------------------------------------
const RESTART_INSTABILITY_THRESHOLD = 3;


// =============================================================================
// analyzeDeployment
// =============================================================================
//
// WHAT IT DOES:
//   Fetches data about a deployment and its pods from Kubernetes, then
//   examines replica counts, probe configuration, restart history, crash
//   states, and Kubernetes events to build a structured health report.
//
// WHEN TO USE IT:
//   Called whenever the agent needs to understand why a deployment is
//   unhealthy before deciding on a fix. It should be the first step in any
//   troubleshooting flow.
//
// HOW IT WORKS:
//   Steps 1–3:  Fetch the deployment, its pods, and all namespace events.
//   Steps 4–8:  Detect problems and add them to the findings list.
//   Steps 9–10: Add probable causes and recommendations for each problem.
//   Steps 11–12: Decide which problem is dominant and compute overall status.
//   Step 13:    Deduplicate and return the final result.
// =============================================================================
export async function analyzeDeployment(
  namespace: string,
  deploymentName: string
): Promise<DeploymentAnalysisResult> {

  // These arrays will be filled as we find problems
  const findings: Finding[] = [];
  const probableCauses: string[] = [];
  const recommendations: Recommendation[] = [];


  // ---------------------------------------------------------------------------
  // STEP 1: Fetch the deployment from Kubernetes
  // ---------------------------------------------------------------------------

  const deploymentRes = await appsV1.readNamespacedDeployment(deploymentName, namespace);
  const deployment = deploymentRes.body;

  // "spec" describes what we want the deployment to look like.
  // "status" describes what it actually looks like right now.
  const spec = deployment.spec;
  const status = deployment.status;

  // How many pods do we want vs. how many are actually running?
  // "??" means: if the left side is null or undefined, use 0 instead.
  const desiredReplicas = spec?.replicas ?? 0;
  const readyReplicas = status?.readyReplicas ?? 0;
  const availableReplicas = status?.availableReplicas ?? 0;


  // ---------------------------------------------------------------------------
  // STEP 2: Fetch the pods belonging to this deployment
  // ---------------------------------------------------------------------------

  // Build a label selector string like "app=my-app" so we only get pods
  // that belong to this deployment.
  const matchLabels = spec?.selector?.matchLabels ?? {};

  const selector = Object.entries(matchLabels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");

  const podsRes = await coreV1.listNamespacedPod(
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    selector || undefined
  );
  const pods = podsRes.body.items ?? [];


  // ---------------------------------------------------------------------------
  // STEP 3: Fetch Kubernetes events for this namespace
  // ---------------------------------------------------------------------------
  // Events are like a short-lived log of what has happened recently
  // (e.g. "image pull failed", "liveness probe failed").

  const eventsRes = await coreV1.listNamespacedEvent(namespace);
  const allEvents = eventsRes.body.items ?? [];


  // ---------------------------------------------------------------------------
  // STEP 4: Check if not enough replicas are available
  // ---------------------------------------------------------------------------

  if (desiredReplicas > availableReplicas) {
    findings.push({
      type: "availability",
      severity: "high",
      message: `Deployment wants ${desiredReplicas} replicas but only ${availableReplicas} are available.`,
    });
  }

  if (desiredReplicas > readyReplicas) {
    findings.push({
      type: "readiness",
      severity: "high",
      message: `Deployment wants ${desiredReplicas} replicas but only ${readyReplicas} are ready.`,
    });
  }


  // ---------------------------------------------------------------------------
  // STEP 5: Check if containers are missing health probes
  // ---------------------------------------------------------------------------
  // Probes let Kubernetes know if a container is alive and ready for traffic.
  // Missing probes mean Kubernetes cannot detect problems automatically.
  //
  // REFERENCE — Kubernetes probes documentation:
  //   https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/

  const containers = spec?.template?.spec?.containers ?? [];

  for (const container of containers) {
    if (!container.readinessProbe) {
      findings.push({
        type: "probe",
        severity: "medium",
        message: `Container "${container.name}" has no readinessProbe.`,
      });
    }

    if (!container.livenessProbe) {
      findings.push({
        type: "probe",
        severity: "medium",
        message: `Container "${container.name}" has no livenessProbe.`,
      });
    }

    if (!container.startupProbe) {
      findings.push({
        type: "probe",
        severity: "medium",
        message: `Container "${container.name}" has no startupProbe.`,
      });
    }
  }


  // ---------------------------------------------------------------------------
  // STEP 6: Count restarts and check for crash states across all pods
  // ---------------------------------------------------------------------------
  //
  // METHODOLOGY REFERENCE — K8sGPT pod analyzer:
  // The pattern of iterating containerStatuses and inspecting state.waiting
  // and lastState.terminated is the same one K8sGPT uses in its
  // analyzeContainerStatusFailures() function. URL:
  //   https://github.com/k8sgpt-ai/k8sgpt/blob/main/pkg/analyzer/pod.go
  //
  // Severity escalation at >= 3 restarts uses Kubernetes' own default
  // failureThreshold of 3 as the boundary between "transient blip" and
  // "sustained instability". See RESTART_INSTABILITY_THRESHOLD above.

  let totalRestarts = 0;
  const waitingReasons: string[] = []; // reasons why containers are stuck waiting
  let crashDetected = false;

  for (const pod of pods) {
    const containerStatuses = pod.status?.containerStatuses ?? [];

    for (const cs of containerStatuses) {
      // Add up all restarts across every container in every pod.
      totalRestarts += cs.restartCount ?? 0;

      // If a container is waiting, record why (e.g. "ImagePullBackOff").
      // These reason strings come from the kubelet and are the same set
      // K8sGPT's isErrorReason() helper enumerates.
      const waitingReason = cs.state?.waiting?.reason;
      if (waitingReason) {
        waitingReasons.push(waitingReason);
      }

      // Check if the container last exited due to an error or memory kill (OOMKilled).
      // K8sGPT's pod analyzer also reports lastTerminationState.terminated.reason
      // when state.waiting.reason is "CrashLoopBackOff".
      const terminatedReason = cs.lastState?.terminated?.reason;
      if (terminatedReason === "Error" || terminatedReason === "OOMKilled") {
        crashDetected = true;
      }
    }
  }

  if (totalRestarts > 0) {
    findings.push({
      type: "restarts",
      // Severity escalates at the kubelet's default failureThreshold (3).
      severity: totalRestarts >= RESTART_INSTABILITY_THRESHOLD ? "high" : "medium",
      message: `Detected ${totalRestarts} container restarts across deployment pods.`,
    });
  }

  if (crashDetected) {
    findings.push({
      type: "stability",
      severity: "high",
      message: "At least one container shows a terminated or crash state.",
    });
  }


  // ---------------------------------------------------------------------------
  // STEP 7: Filter events to only those related to this deployment or its pods
  // ---------------------------------------------------------------------------

  const relevantEvents = allEvents.filter((event) => {
    const involvedName = event.involvedObject?.name ?? "";

    // Keep the event if it names this deployment OR any of its pods.
    return (
      involvedName === deploymentName ||
      pods.some((pod) => pod.metadata?.name === involvedName)
    );
  });

  // Combine the event reason and message into a single string for easy searching.
  const eventMessages = relevantEvents.map(
    (e) => `${e.reason ?? ""} ${e.message ?? ""}`
  );


  // ---------------------------------------------------------------------------
  // STEP 8: Look for known bad patterns in the event messages
  // ---------------------------------------------------------------------------
  //
  // PATTERN-MATCHING REFERENCE — K8sGPT pod analyzer:
  // The exact reason strings we match below are the same set K8sGPT looks
  // for in its isErrorReason() helper:
  //   "CrashLoopBackOff", "ImagePullBackOff", "CreateContainerConfigError",
  //   "PreCreateHookError", "CreateContainerError", "PreStartHookError",
  //   "RunContainerError", "ImageInspectError", "ErrImagePull",
  //   "ErrImageNeverPull", "InvalidImageName"
  // URL: https://github.com/k8sgpt-ai/k8sgpt/blob/main/pkg/analyzer/pod.go
  //
  // We only match the subset relevant to remediations our system can perform
  // (image pulls, scheduling, probe failures). Other K8sGPT-style reasons
  // (CreateContainerConfigError, PreStartHookError, etc.) are handled by
  // the agent reading pod logs rather than this rule-based analyzer.

  const hasImagePullIssue = eventMessages.some(
    (msg) =>
      // The first three are reason/message strings emitted directly by the kubelet:
      //   https://kubernetes.io/docs/concepts/containers/images/
      msg.includes("ImagePullBackOff") ||
      msg.includes("ErrImagePull") ||
      msg.includes("Failed to pull image")
  );

  const hasUnhealthyEvent = eventMessages.some(
    (msg) =>
      // "Unhealthy", "Readiness probe failed", and "Liveness probe failed"
      // are emitted by the kubelet's prober. See:
      //   https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/
      msg.includes("Unhealthy") ||
      msg.includes("Readiness probe failed") ||
      msg.includes("Liveness probe failed")
  );

  const hasSchedulingIssue = eventMessages.some(
    // "FailedScheduling" and "Insufficient ..." are emitted by the
    // default-scheduler when it cannot find a node to place the pod. See:
    //   https://kubernetes.io/docs/concepts/scheduling-eviction/
    (msg) => msg.includes("FailedScheduling") || msg.includes("Insufficient")
  );

  // True if at least one container is missing any probe.
  const hasMissingProbes = containers.some(
    (c) => !c.readinessProbe || !c.livenessProbe || !c.startupProbe
  );


  // ---------------------------------------------------------------------------
  // STEP 9: Add findings and recommendations based on detected problems
  // ---------------------------------------------------------------------------

  if (hasImagePullIssue) {
    findings.push({
      type: "image",
      severity: "high",
      message: "Image pull failure detected from pod events.",
    });
  }

  if (hasUnhealthyEvent) {
    findings.push({
      type: "probe",
      severity: "high",
      message: "Health check failures detected from Kubernetes events.",
    });
    probableCauses.push(
      "Kubernetes events indicate probe-related failures, such as readiness or liveness checks failing."
    );
    recommendations.push({
      action: "patch_probes",
      reason: "Adjust probe configuration based on observed health check failures.",
    });
  }

  if (hasSchedulingIssue) {
    findings.push({
      type: "resources",
      severity: "high",
      message: "Scheduling or resource issue detected from events.",
    });
  }

  if (
    hasImagePullIssue ||
    waitingReasons.includes("ImagePullBackOff") ||
    waitingReasons.includes("ErrImagePull")
  ) {
    probableCauses.push("Deployment image is invalid, unavailable, or cannot be pulled.");
    recommendations.push({ action: "update_image", reason: "Fix the image reference or tag." });
    recommendations.push({
      action: "rollback",
      reason: "Return to the last known working version if available.",
    });
  }

  if (hasSchedulingIssue) {
    probableCauses.push("Cluster may not currently have enough resources to schedule the pods.");
    recommendations.push({
      action: "patch_resources",
      reason: "Adjust CPU or memory requests and limits.",
    });
    recommendations.push({
      action: "scale",
      reason: "Reduce replicas or rebalance workload.",
    });
  }

  if (totalRestarts > 0 || crashDetected) {
    if (hasUnhealthyEvent) {
      probableCauses.push(
        "The deployment appears unstable due to probe-related failures or overly aggressive health checks."
      );
      recommendations.push({
        action: "patch_probes",
        reason: "Tune readiness, liveness, or startup probes based on observed failures.",
      });
    } else {
      probableCauses.push("Application may be crashing during startup or runtime.");
      recommendations.push({
        action: "inspect_logs",
        reason:
          "Inspect container logs to confirm whether the application is crashing or failing internally.",
      });
    }
  }

  if (hasMissingProbes) {
    probableCauses.push(
      "Missing probes reduce health visibility and may weaken failure detection."
    );
    recommendations.push({
      action: "patch_probes",
      reason: "Add or tune readiness, liveness, and startup probes.",
    });
  }

  if (desiredReplicas > availableReplicas && !hasImagePullIssue && !hasSchedulingIssue) {
    probableCauses.push("Pods exist but are not becoming healthy or available.");
  }


  // ---------------------------------------------------------------------------
  // STEP 10: Get a lightweight resource profile preview to help decide fix order
  // ---------------------------------------------------------------------------
  // We pass placeholder metrics (cpu/memory = "0") because this is only used
  // to determine the ORDER in which fixes should be applied.
  // Real resource decisions happen in analyze_resources, not here.
  //
  // With all-zero placeholder metrics, the VPA-aligned percentile path
  // returns "balanced", which is the same neutral signal the previous
  // threshold-based code returned. So no behaviour changes here.

  const resourceMetricsForDeployment = pods.map((pod) => ({
    pod: pod.metadata?.name ?? "",
    cpu: "0",
    memory: "0",
  }));

  const resourceProfilePreview = suggestSmartResources({
    deploymentName,
    podMetrics: resourceMetricsForDeployment,
  });


  // ---------------------------------------------------------------------------
  // STEP 11: Decide the "combined reasoning" — which problem to fix first
  // ---------------------------------------------------------------------------

  let combinedReasoning:
    | { dominantIssue: string; fixOrder: string[]; explanation: string }
    | undefined;

  const probeIssueStrong = hasUnhealthyEvent || hasMissingProbes;
  const restartIssueStrong = totalRestarts >= RESTART_INSTABILITY_THRESHOLD;
  const resourceIssueStrong = hasSchedulingIssue;

  if (probeIssueStrong && resourceIssueStrong) {
    // Both probe and resource problems: fix resources first, then probes.
    combinedReasoning = {
      dominantIssue: "combined_probe_and_resource_issue",
      fixOrder: ["patch_resources", "patch_probes"],
      explanation:
        "The workload shows both resource-related and probe-related problems. Stabilizing resource availability first is usually safer, then probe tuning can be applied on a more stable runtime.",
    };
  } else if (probeIssueStrong && restartIssueStrong) {
    // Probes look like the cause of the restarts.
    combinedReasoning = {
      dominantIssue: "probe_instability",
      fixOrder: ["patch_probes"],
      explanation:
        "Repeated restarts and probe-related events suggest that health checks are a dominant source of instability. Probe tuning should be prioritized.",
    };
  } else if (resourceIssueStrong) {
    // Only resource problems detected.
    combinedReasoning = {
      dominantIssue: "resource_pressure",
      fixOrder: ["patch_resources"],
      explanation:
        "Resource-related signals dominate the failure pattern, so resource tuning should be prioritized.",
    };
  } else if (resourceProfilePreview.selectedProfile === "cpu_pressure") {
    // Resource preview hints at CPU pressure even without a hard scheduling failure.
    combinedReasoning = {
      dominantIssue: "cpu_pressure",
      fixOrder: ["patch_resources"],
      explanation:
        "CPU pressure appears to be the main issue, so resource tuning should be applied before other optimizations.",
    };
  } else if (probeIssueStrong) {
    // Only probe problems detected.
    combinedReasoning = {
      dominantIssue: "probe_configuration",
      fixOrder: ["patch_probes"],
      explanation:
        "Probe-related instability appears to be the dominant issue, so probe tuning should be prioritized.",
    };
  }


  // ---------------------------------------------------------------------------
  // STEP 12: Determine the overall health status based on finding severity
  // ---------------------------------------------------------------------------

  let overallStatus: AnalysisStatus = "healthy";

  const hasHighSeverity = findings.some((f) => f.severity === "high");
  const hasMediumSeverity = findings.some((f) => f.severity === "medium");

  if (hasHighSeverity) {
    overallStatus = "critical";
  } else if (hasMediumSeverity) {
    overallStatus = "warning";
  }

  // Use the first finding as the one-line summary, or report all-healthy.
  const summary = findings.length === 0
    ? "Deployment appears healthy."
    : findings[0].message;


  // ---------------------------------------------------------------------------
  // STEP 13: Deduplicate causes and recommendations, then return the result
  // ---------------------------------------------------------------------------

  // new Set(...) removes exact duplicates from the array.
  const uniqueCauses = [...new Set(probableCauses)];

  // Keep only the first recommendation for each action name (no duplicates).
  const uniqueRecommendations = recommendations.filter(
    (rec, index, arr) => index === arr.findIndex((r) => r.action === rec.action)
  );

  return {
    namespace,
    deployment: deploymentName,
    status: overallStatus,
    summary,
    findings,
    probableCauses: uniqueCauses,
    recommendations: uniqueRecommendations,
    safeToAutoRemediate: false, // always require human approval before auto-fixing
    combinedReasoning,
  };
}