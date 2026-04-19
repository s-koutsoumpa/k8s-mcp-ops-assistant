import { appsV1, coreV1 } from "../k8s/client";
import { suggestSmartResources } from "./resource-analyzer";

type Severity = "low" | "medium" | "high";
type AnalysisStatus = "healthy" | "warning" | "critical";

interface Finding {
  type: string;
  severity: Severity;
  message: string;
}

interface Recommendation {
  action: string;
  reason: string;
}

interface DeploymentAnalysisResult {
  namespace: string;
  deployment: string;
  status: AnalysisStatus;
  summary: string;
  findings: Finding[];
  probableCauses: string[];
  recommendations: Recommendation[];
  safeToAutoRemediate: boolean;
  combinedReasoning?: {
    dominantIssue: string;
    fixOrder: string[];
    explanation: string;
  };
}

export async function analyzeDeployment(
  namespace: string,
  deploymentName: string
): Promise<DeploymentAnalysisResult> {
  const findings: Finding[] = [];
  const probableCauses: string[] = [];
  const recommendations: Recommendation[] = [];

  const deploymentRes = await appsV1.readNamespacedDeployment(
    deploymentName,
    namespace
  );

  const deployment = deploymentRes.body;
  const spec = deployment.spec;
  const status = deployment.status;

  const desiredReplicas = spec?.replicas ?? 0;
  const readyReplicas = status?.readyReplicas ?? 0;
  const availableReplicas = status?.availableReplicas ?? 0;

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

  const eventsRes = await coreV1.listNamespacedEvent(namespace);
  const allEvents = eventsRes.body.items ?? [];

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

  let totalRestarts = 0;
  const waitingReasons: string[] = [];
  let crashDetected = false;

  for (const pod of pods) {
    const statuses = pod.status?.containerStatuses ?? [];

    for (const cs of statuses) {
      totalRestarts += cs.restartCount ?? 0;

      const waitingReason = cs.state?.waiting?.reason;
      if (waitingReason) {
        waitingReasons.push(waitingReason);
      }

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

  const relevantEvents = allEvents.filter((event) => {
    const involvedName = event.involvedObject?.name ?? "";

    return (
      involvedName === deploymentName ||
      pods.some((pod) => pod.metadata?.name === involvedName)
    );
  });

  const eventMessages = relevantEvents.map(
    (e) => `${e.reason ?? ""} ${e.message ?? ""}`
  );

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

  const hasMissingProbes = containers.some(
    (c) => !c.readinessProbe || !c.livenessProbe || !c.startupProbe
  );

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
    probableCauses.push(
      "Deployment image is invalid, unavailable, or cannot be pulled."
    );

    recommendations.push({
      action: "update_image",
      reason: "Fix the image reference or tag.",
    });

    recommendations.push({
      action: "rollback",
      reason: "Return to the last known working version if available.",
    });
  }

  if (hasSchedulingIssue) {
    probableCauses.push(
      "Cluster may not currently have enough resources to schedule the pods."
    );

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
      probableCauses.push(
        "Application may be crashing during startup or runtime."
      );

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

  if (
    desiredReplicas > availableReplicas &&
    !hasImagePullIssue &&
    !hasSchedulingIssue
  ) {
    probableCauses.push("Pods exist but are not becoming healthy or available.");
  }

  // Combined reasoning for probe + resource interactions
  const resourceMetricsForDeployment = pods.map((pod) => ({
    pod: pod.metadata?.name ?? "",
    cpu: "0",
    memory: "0",
  }));

  // This lightweight signal only helps with ordering logic inside analyze_deployment.
  // Full resource decisions still belong to analyze_resources.
  const resourceProfilePreview = suggestSmartResources({
    deploymentName,
    podMetrics: resourceMetricsForDeployment,
  });

  let combinedReasoning:
    | {
        dominantIssue: string;
        fixOrder: string[];
        explanation: string;
      }
    | undefined;

  const probeIssueStrong = hasUnhealthyEvent || hasMissingProbes;
  const restartIssueStrong = totalRestarts >= 3;
  const resourceIssueStrong = hasSchedulingIssue;

  if (probeIssueStrong && resourceIssueStrong) {
    combinedReasoning = {
      dominantIssue: "combined_probe_and_resource_issue",
      fixOrder: ["patch_resources", "patch_probes"],
      explanation:
        "The workload shows both resource-related and probe-related problems. Stabilizing resource availability first is usually safer, then probe tuning can be applied on a more stable runtime.",
    };
  } else if (probeIssueStrong && restartIssueStrong) {
    combinedReasoning = {
      dominantIssue: "probe_instability",
      fixOrder: ["patch_probes"],
      explanation:
        "Repeated restarts and probe-related events suggest that health checks are a dominant source of instability. Probe tuning should be prioritized.",
    };
  } else if (resourceIssueStrong) {
    combinedReasoning = {
      dominantIssue: "resource_pressure",
      fixOrder: ["patch_resources"],
      explanation:
        "Resource-related signals dominate the failure pattern, so resource tuning should be prioritized.",
    };
    } else if (resourceProfilePreview.selectedProfile === "cpu_pressure") {
    combinedReasoning = {
      dominantIssue: "cpu_pressure",
      fixOrder: ["patch_resources"],
      explanation:
        "CPU pressure appears to be the main issue, so resource tuning should be applied before other optimizations.",
    };
  } else if (probeIssueStrong) {
    combinedReasoning = {
      dominantIssue: "probe_configuration",
      fixOrder: ["patch_probes"],
      explanation:
        "Probe-related instability appears to be the dominant issue, so probe tuning should be prioritized.",
    };
  }

  let overallStatus: AnalysisStatus = "healthy";

  const hasHighSeverity = findings.some((f) => f.severity === "high");
  const hasMediumSeverity = findings.some((f) => f.severity === "medium");

  if (hasHighSeverity) {
    overallStatus = "critical";
  } else if (hasMediumSeverity) {
    overallStatus = "warning";
  }

  const summary =
    findings.length === 0
      ? "Deployment appears healthy."
      : findings[0].message;

  const uniqueCauses = [...new Set(probableCauses)];

  const uniqueRecommendations = recommendations.filter(
    (rec, index, arr) =>
      index === arr.findIndex((r) => r.action === rec.action)
  );

  return {
    namespace,
    deployment: deploymentName,
    status: overallStatus,
    summary,
    findings,
    probableCauses: uniqueCauses,
    recommendations: uniqueRecommendations,
    safeToAutoRemediate: false,
    combinedReasoning,
  };
}