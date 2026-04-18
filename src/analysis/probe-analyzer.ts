// PROBE ANALYZER
// This file checks whether probes are missing or probably need tuning.

export function analyzeProbes(input: {
  deploymentName: string;
  namespace: string;
  probeInfo: any[];
  pods?: any[];
  events?: any[];
}) {
  const { deploymentName, namespace, probeInfo, events = [] } = input;

  const findings: any[] = [];

  for (const container of probeInfo) {
    if (!container.readinessProbe) {
      findings.push({
        type: "missing_readiness_probe",
        container: container.container,
        suggestion: "Add a readinessProbe so traffic starts only when the app is ready",
      });
    }

    if (!container.livenessProbe) {
      findings.push({
        type: "missing_liveness_probe",
        container: container.container,
        suggestion: "Add a livenessProbe so stuck containers can be restarted",
      });
    }

    if (!container.startupProbe && !container.readinessProbe && !container.livenessProbe) {
      findings.push({
        type: "missing_all_probes",
        container: container.container,
        suggestion:
          "Add readinessProbe and livenessProbe. If the app starts slowly, consider startupProbe too",
      });
    }
  }

  const warningEvents = events.filter((e) => e.type === "Warning");
  const probeFailures = warningEvents.filter((e) =>
    String(e.message || "").toLowerCase().includes("probe")
  );

  if (probeFailures.length > 0) {
    findings.push({
      type: "probe_failures_detected",
      container: "unknown",
      suggestion:
        "Current probe settings may be too aggressive. Review initialDelaySeconds, timeoutSeconds, periodSeconds, and failureThreshold",
    });
  }

  return {
    deployment: deploymentName,
    namespace,
    findings,
  };
}