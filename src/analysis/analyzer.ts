import { appsV1, coreV1 } from "../k8s/client";

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
}

export async function analyzeDeployment(
  namespace: string,
  deploymentName: string
): Promise<DeploymentAnalysisResult> {
  const findings: Finding[] = [];
  const probableCauses: string[] = [];
  const recommendations: Recommendation[] = [];

  // Read the deployment from Kubernetes
  const deploymentRes = await appsV1.readNamespacedDeployment(
    deploymentName,
    namespace
  );

  // In your client version, the real deployment object is inside .body
  const deployment = deploymentRes.body;

  const spec = deployment.spec;
  const status = deployment.status;

  const desiredReplicas = spec?.replicas ?? 0;
  const readyReplicas = status?.readyReplicas ?? 0;
  const availableReplicas = status?.availableReplicas ?? 0;

  // Build label selector from deployment matchLabels
  const matchLabels = spec?.selector?.matchLabels ?? {};
  const selector = Object.entries(matchLabels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");

  // Read pods that belong to this deployment
  const podsRes = await coreV1.listNamespacedPod(
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    selector || undefined
  );

  const pods = podsRes.body.items ?? [];

  // Read namespace events
  const eventsRes = await coreV1.listNamespacedEvent(namespace);
  const allEvents = eventsRes.body.items ?? [];

  // Check if desired replicas are more than available replicas
  if (desiredReplicas > availableReplicas) {
    findings.push({
      type: "availability",
      severity: "high",
      message: `Deployment wants ${desiredReplicas} replicas but only ${availableReplicas} are available.`,
    });
  }

  // Check if desired replicas are more than ready replicas
  if (desiredReplicas > readyReplicas) {
    findings.push({
      type: "readiness",
      severity: "high",
      message: `Deployment wants ${desiredReplicas} replicas but only ${readyReplicas} are ready.`,
    });
  }

  // Inspect probe configuration
  const containers = spec?.template?.spec?.containers ?? [];
  const missingProbeMessages: string[] = [];

  for (const container of containers) {
    if (!container.readinessProbe) {
      missingProbeMessages.push(
        `Container "${container.name}" has no readinessProbe.`
      );
    }

    if (!container.livenessProbe) {
      missingProbeMessages.push(
        `Container "${container.name}" has no livenessProbe.`
      );
    }

    if (!container.startupProbe) {
      missingProbeMessages.push(
        `Container "${container.name}" has no startupProbe.`
      );
    }
  }

  for (const msg of missingProbeMessages) {
    findings.push({
      type: "probe",
      severity: "medium",
      message: msg,
    });
  }

  // Inspect pod/container runtime state
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
      message: "At least one container shows a terminated/crash state.",
    });
  }

  // Keep only events related to this deployment or its pods
  const relevantEvents = allEvents.filter((event) => {
    const involvedName = event.involvedObject?.name ?? "";

    return (
      involvedName === deploymentName ||
      pods.some((pod) => pod.metadata?.name === involvedName)
    );
  });

  const eventMessages = relevantEvents.map(
    (e) => `${e.reason ?? "Unknown"}: ${e.message ?? ""}`
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
      message: "Health check failures detected from events.",
    });
  }

  if (hasSchedulingIssue) {
    findings.push({
      type: "resources",
      severity: "high",
      message: "Scheduling/resource-related issue detected from events.",
    });
  }

  // Convert findings to possible causes + recommended actions
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
      reason: "Return to the last known working version.",
    });
  }

  if (hasSchedulingIssue) {
    probableCauses.push(
      "Cluster does not currently have enough resources to schedule the pods."
    );

    recommendations.push({
      action: "patch_resources",
      reason: "Adjust CPU/memory requests and limits.",
    });

    recommendations.push({
      action: "scale",
      reason: "Reduce replicas or rebalance workload.",
    });
  }

  if (totalRestarts > 0 || crashDetected) {
    probableCauses.push(
      "Application may be crashing during startup or runtime."
    );

    recommendations.push({
      action: "inspect_logs",
      reason: "Check container logs before applying remediation.",
    });
  }

  if (missingProbeMessages.length > 0) {
    probableCauses.push(
      "Missing probes reduce health visibility and may delay or weaken failure detection."
    );

    recommendations.push({
      action: "patch_probes",
      reason: "Add or tune readiness/liveness/startup probes.",
    });
  }

  if (
    desiredReplicas > availableReplicas &&
    !hasImagePullIssue &&
    !hasSchedulingIssue
  ) {
    probableCauses.push("Pods exist but are not becoming healthy/available.");
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

  const uniqueRecommendations = recommendations.filter(
    (rec, index, arr) =>
      index === arr.findIndex((r) => r.action === rec.action)
  );

  const uniqueCauses = [...new Set(probableCauses)];

  return {
    namespace,
    deployment: deploymentName,
    status: overallStatus,
    summary,
    findings,
    probableCauses: uniqueCauses,
    recommendations: uniqueRecommendations,
    safeToAutoRemediate: false,
  };
}