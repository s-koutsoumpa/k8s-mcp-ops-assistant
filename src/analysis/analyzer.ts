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
  // "??" means: if matchLabels is null/undefined, use an empty object {}.
  const matchLabels = spec?.selector?.matchLabels ?? {};

  // Object.entries() turns { app: "nginx" } into [["app", "nginx"]].
  // We then format each pair as "key=value" and join them with commas.
  const selector = Object.entries(matchLabels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");

  // The Kubernetes client uses positional arguments. We only need the
  // namespace (1st) and labelSelector (6th), so we pass "undefined" for
  // the four arguments in between.
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

  let totalRestarts = 0;
  const waitingReasons: string[] = []; // reasons why containers are stuck waiting
  let crashDetected = false;

  for (const pod of pods) {
    const containerStatuses = pod.status?.containerStatuses ?? [];

    for (const cs of containerStatuses) {
      // Add up all restarts across every container in every pod.
      totalRestarts += cs.restartCount ?? 0;

      // If a container is waiting, record why (e.g. "ImagePullBackOff").
      const waitingReason = cs.state?.waiting?.reason;
      if (waitingReason) {
        waitingReasons.push(waitingReason);
      }

      // Check if the container last exited due to an error or memory kill (OOMKilled).
      const terminatedReason = cs.lastState?.terminated?.reason;
      if (terminatedReason === "Error" || terminatedReason === "OOMKilled") {
        crashDetected = true;
      }
    }
  }

  if (totalRestarts > 0) {
    findings.push({
      type: "restarts",
      severity: totalRestarts >= 3 ? "high" : "medium",
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

  const hasImagePullIssue = eventMessages.some(
    (msg) =>
      msg.includes("ImagePullBackOff") ||
      msg.includes("ErrImagePull") ||
      msg.includes("Failed to pull image")
  );

  const hasUnhealthyEvent = eventMessages.some(
    (msg) =>
      msg.includes("Unhealthy") ||
      msg.includes("Readiness probe failed") ||
      msg.includes("Liveness probe failed")
  );

  const hasSchedulingIssue = eventMessages.some(
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
  const restartIssueStrong = totalRestarts >= 3;
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
  // The "..." spread syntax turns the Set back into an array.
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
