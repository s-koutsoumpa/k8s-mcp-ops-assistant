// PROBE ANALYZER
// This file checks whether probes are missing
// and suggests a probe profile based on observed behavior.

type ProbeProfile = "basic" | "slow_start" | "unstable";

export function analyzeProbes(input: {
  deploymentName: string;
  namespace: string;
  probeInfo: any[];
  pods?: any[];
  events?: any[];
}) {
  const {
    deploymentName,
    namespace,
    probeInfo,
    pods = [],
    events = [],
  } = input;

  const findings: any[] = [];

  // Check each container and detect missing probes
  for (const container of probeInfo) {
    if (!container.readinessProbe) {
      findings.push({
        type: "missing_readiness_probe",
        container: container.container,
        suggestion:
          "Add a readinessProbe so traffic starts only when the app is ready",
      });
    }

    if (!container.livenessProbe) {
      findings.push({
        type: "missing_liveness_probe",
        container: container.container,
        suggestion:
          "Add a livenessProbe so stuck containers can be restarted",
      });
    }

    if (
      !container.startupProbe &&
      !container.readinessProbe &&
      !container.livenessProbe
    ) {
      findings.push({
        type: "missing_all_probes",
        container: container.container,
        suggestion:
          "Add readinessProbe and livenessProbe. If the app starts slowly, consider startupProbe too",
      });
    }
  }

  // Look for warning events related to probes
  const warningEvents = events.filter((e) => e.type === "Warning");

  const probeFailures = warningEvents.filter((e) =>
    String(e.message || "").toLowerCase().includes("probe")
  );

  if (probeFailures.length > 0) {
    findings.push({
      type: "probe_failures_detected",
      container: "unknown",
      suggestion:
        "Kubernetes events already show probe failures. Prefer tuning probe settings before investigating logs.",
    });
  }

  // Run profile-based tuning logic
  const smartTuning = suggestSmartProbes({
    deploymentName,
    probeInfo,
    pods,
    events,
  });

  return {
    deployment: deploymentName,
    namespace,
    findings,
    smartTuning,
  };
}

// This function selects a probe profile based on observed behavior
// and then builds probe config from that profile.
export function suggestSmartProbes(params: {
  deploymentName: string;
  probeInfo: any[];
  pods: any[];
  events: any[];
}) {
  const { probeInfo, pods, events } = params;

  const findings: string[] = [];
  const rationale: string[] = [];

  let hasReadiness = false;
  let hasLiveness = false;
  let hasStartup = false;

  for (const c of probeInfo) {
    if (c.readinessProbe) hasReadiness = true;
    if (c.livenessProbe) hasLiveness = true;
    if (c.startupProbe) hasStartup = true;
  }

  // Count restarts
  let totalRestarts = 0;
  for (const pod of pods) {
    for (const cs of pod.status?.containerStatuses ?? []) {
      totalRestarts += cs.restartCount ?? 0;
    }
  }

  // Read event messages
  const messages = events.map((e) =>
    `${e.reason ?? ""} ${e.message ?? ""}`.toLowerCase()
  );

  const readinessFailures = messages.some((m) =>
    m.includes("readiness probe failed")
  );

  const livenessFailures = messages.some((m) =>
    m.includes("liveness probe failed")
  );

  // Missing probe findings
  if (!hasReadiness) findings.push("Missing readiness probe");
  if (!hasLiveness) findings.push("Missing liveness probe");
  if (!hasStartup) findings.push("Missing startup probe");

  // Select profile
  const profile = selectProbeProfile({
    hasReadiness,
    hasLiveness,
    hasStartup,
    totalRestarts,
    readinessFailures,
    livenessFailures,
  });

  rationale.push(`Selected probe profile: ${profile}`);

  if (profile === "basic") {
    rationale.push(
      "The workload shows low instability, so conservative basic health checks are enough."
    );
  }

  if (profile === "slow_start") {
    rationale.push(
      "The workload appears to need more warm-up time before becoming healthy."
    );
  }

  if (profile === "unstable") {
    rationale.push(
      "The workload shows repeated restarts or liveness-related instability, so stronger startup protection is recommended."
    );
  }

  return {
    findings,
    rationale,
    selectedProfile: profile,
    suggestedProbeConfig: buildProbeConfigFromProfile(profile),
  };
}

// Decide which profile matches the workload behavior
function selectProbeProfile(params: {
  hasReadiness: boolean;
  hasLiveness: boolean;
  hasStartup: boolean;
  totalRestarts: number;
  readinessFailures: boolean;
  livenessFailures: boolean;
}): ProbeProfile {
  const {
    hasReadiness,
    hasLiveness,
    totalRestarts,
    readinessFailures,
    livenessFailures,
  } = params;

  // Strong instability signals
  if (livenessFailures || totalRestarts >= 3) {
    return "unstable";
  }

  // Looks like startup / readiness delay
  if (readinessFailures || totalRestarts > 0) {
    return "slow_start";
  }

  // Missing probes but no strong instability
  if (!hasReadiness || !hasLiveness) {
    return "basic";
  }

  // Default safe profile
  return "basic";
}

// Build a concrete probe config from the selected profile
function buildProbeConfigFromProfile(profile: ProbeProfile) {
  if (profile === "basic") {
    return {
      readinessProbe: {
        httpGet: { path: "/", port: 80 },
        initialDelaySeconds: 5,
        periodSeconds: 10,
        timeoutSeconds: 2,
        failureThreshold: 3,
        successThreshold: 1,
      },
      livenessProbe: {
        httpGet: { path: "/", port: 80 },
        initialDelaySeconds: 15,
        periodSeconds: 15,
        timeoutSeconds: 2,
        failureThreshold: 3,
      },
    };
  }

  if (profile === "slow_start") {
    return {
      readinessProbe: {
        httpGet: { path: "/", port: 80 },
        initialDelaySeconds: 10,
        periodSeconds: 10,
        timeoutSeconds: 3,
        failureThreshold: 3,
        successThreshold: 1,
      },
      livenessProbe: {
        httpGet: { path: "/", port: 80 },
        initialDelaySeconds: 20,
        periodSeconds: 15,
        timeoutSeconds: 2,
        failureThreshold: 3,
      },
      startupProbe: {
        httpGet: { path: "/", port: 80 },
        periodSeconds: 5,
        timeoutSeconds: 2,
        failureThreshold: 10,
      },
    };
  }

  // unstable
  return {
    readinessProbe: {
      httpGet: { path: "/", port: 80 },
      initialDelaySeconds: 10,
      periodSeconds: 10,
      timeoutSeconds: 3,
      failureThreshold: 3,
      successThreshold: 1,
    },
    livenessProbe: {
      httpGet: { path: "/", port: 80 },
      initialDelaySeconds: 25,
      periodSeconds: 15,
      timeoutSeconds: 3,
      failureThreshold: 3,
    },
    startupProbe: {
      httpGet: { path: "/", port: 80 },
      periodSeconds: 5,
      timeoutSeconds: 2,
      failureThreshold: 12,
    },
  };
}