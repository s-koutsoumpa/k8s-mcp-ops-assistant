// GENERAL ANALYZER
// This file analyzes deployment, pods, and events
// and returns a simple diagnosis object.

export function analyzeDeployment(input: {
  deployment: any;
  pods: any[];
  events: any[];
  metrics?: any[];
}) {
  const { deployment, pods, events } = input;

  const deploymentName = deployment.name;
  const namespace = deployment.namespace;

  const relatedPods = pods.filter((p) =>
    String(p.name || "").startsWith(deploymentName)
  );

  const relatedEvents = events.filter(
    (e) => e.involvedObject && String(e.involvedObject).startsWith(deploymentName)
  );

  const imagePullEvent = relatedEvents.find(
    (e) =>
      String(e.reason || "").includes("Failed") &&
      String(e.message || "").toLowerCase().includes("pull image")
  );

  if (imagePullEvent) {
    return {
      issue: "image_pull_error",
      reason: imagePullEvent.message,
      suggestedAction: "update_image",
      deployment: deploymentName,
      namespace,
    };
  }

  if ((deployment.readyReplicas ?? 0) < (deployment.replicas ?? 0)) {
    return {
      issue: "unhealthy_replicas",
      reason: "Ready replicas are fewer than desired replicas",
      suggestedAction: "inspect_pods_and_events",
      deployment: deploymentName,
      namespace,
    };
  }

  const restartingPod = relatedPods.find((p) => (p.restarts ?? 0) > 3);

  if (restartingPod) {
    return {
      issue: "restart_loop_suspected",
      reason: `Pod ${restartingPod.name} has many restarts`,
      suggestedAction: "get_pod_logs",
      deployment: deploymentName,
      namespace,
    };
  }

  return {
    issue: "healthy_or_no_specific_issue_found",
    reason: "No major problem detected by current rules",
    suggestedAction: "none",
    deployment: deploymentName,
    namespace,
  };
}