// =============================================================================
// probe-analyzer.ts
// =============================================================================
//
// WHAT IS THIS FILE?
// ------------------
// This file checks whether a deployment's health probes are missing or
// misconfigured, and suggests a better probe configuration to apply.
//
// It classifies the workload into one of three "probe profiles":
//   - basic      → the workload is stable; apply conservative probe settings
//   - slow_start → the workload needs extra warm-up time before checks start
//   - unstable   → the workload is crashing a lot; apply stronger startup protection
//
// Based on the profile, it returns a ready-to-apply probe configuration block
// that can be passed directly to patchDeploymentProbes() in action-tools.ts.
//
// WHERE IS IT USED?
// -----------------
// src/server.ts calls analyzeProbes() when the agent uses the "analyze_probes"
// MCP tool. The agent gathers probe info, pods, and events first, then passes
// them all here for analysis.
//
// HOW IT FITS WITH THE REST OF THE SYSTEM
// ----------------------------------------
// The flow for a probe problem is:
//
//   1. Agent calls analyze_probes      → analyzeProbes() here
//   2. We detect what is wrong and select a profile
//   3. We return suggested probe config values
//   4. Agent calls execute_action → patch_probes with those values
//   5. action-tools.ts applies them to the cluster
//
// WHAT ARE PROBES (quick reminder)?
// ----------------------------------
//   livenessProbe:  "Is this container still alive?" If it fails, Kubernetes
//                   RESTARTS the container.
//   readinessProbe: "Is this container ready for traffic?" If it fails,
//                   the pod is removed from the load balancer but NOT restarted.
//   startupProbe:   "Has this container finished starting up?" Gives slow apps
//                   extra time before liveness/readiness checks begin.
// =============================================================================


// The three probe health profiles this analyzer can select.
type ProbeProfile = "basic" | "slow_start" | "unstable";


// =============================================================================
// 1. analyzeProbes
// =============================================================================
//
// WHAT IT DOES:
//   Inspects each container's probe configuration for missing probes,
//   checks events for probe-related failures, and returns a report with
//   findings and a suggested probe configuration.
//
// WHEN TO USE IT:
//   Called when the agent suspects probe misconfiguration (e.g. containers
//   that keep restarting due to failed liveness checks, or probes that are
//   missing entirely).
//
// HOW IT WORKS:
//   STEP 1: Check each container for missing probes and add a finding for each.
//   STEP 2: Filter Kubernetes events to find Warning-level probe failures.
//   STEP 3: Run suggestSmartProbes() to pick a profile and build probe config.
//   STEP 4: Return the combined result.
// =============================================================================
export function analyzeProbes(input: {
  deploymentName: string;
  namespace: string;
  probeInfo: any[];  // output of inspectProbes() from read-tools.ts
  pods?: any[];      // output of inspectPods()  — optional, used for restarts
  events?: any[];    // output of inspectEvents() — optional, used for failures
}) {
  const {
    deploymentName,
    namespace,
    probeInfo,
    pods = [],    // default to empty array if not provided
    events = [],  // default to empty array if not provided
  } = input;

  const findings: any[] = [];

  // STEP 1: Check each container for missing probes.
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

    // Only add the "missing all probes" finding if truly none are configured.
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

  // STEP 2: Check Kubernetes events for probe-related failures.
  // We only care about Warning events (not Normal/informational ones).
  const warningEvents = events.filter((e) => e.type === "Warning");

  // A probe failure event usually has "probe" in its message.
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

  // STEP 3: Run smart probe selection logic.
  const smartTuning = suggestSmartProbes({
    deploymentName,
    probeInfo,
    pods,
    events,
  });

  // STEP 4: Return the full analysis result.
  return {
    deployment: deploymentName,
    namespace,
    findings,
    smartTuning,
  };
}


// =============================================================================
// 2. suggestSmartProbes
// =============================================================================
//
// WHAT IT DOES:
//   Reads the current probe state, restart history, and event messages, then
//   picks the most appropriate probe profile and returns specific probe config
//   values to apply.
//
// WHEN TO USE IT:
//   Called internally by analyzeProbes(). Can also be called standalone
//   if you already have probe info, pods, and events available.
//
// HOW IT WORKS:
//   STEP 1: Check which probe types currently exist (readiness/liveness/startup).
//   STEP 2: Count total container restarts across all pods.
//   STEP 3: Search event messages for readiness or liveness failure keywords.
//   STEP 4: Record which probe types are missing.
//   STEP 5: Select a profile based on restarts and failure events.
//   STEP 6: Build a rationale and return the result.
// =============================================================================
export function suggestSmartProbes(params: {
  deploymentName: string;
  probeInfo: any[];
  pods: any[];
  events: any[];
}) {
  const { probeInfo, pods, events } = params;

  const findings: string[] = [];
  const rationale: string[] = [];

  // STEP 1: Check which probe types are currently configured.
  let hasReadiness = false;
  let hasLiveness = false;
  let hasStartup = false;

  for (const c of probeInfo) {
    if (c.readinessProbe) hasReadiness = true;
    if (c.livenessProbe)  hasLiveness = true;
    if (c.startupProbe)   hasStartup = true;
  }

  // STEP 2: Sum up total container restarts across all pods.
  // "?? []" means: treat the value as an empty array if it is null/undefined.
  let totalRestarts = 0;
  for (const pod of pods) {
    for (const cs of pod.status?.containerStatuses ?? []) {
      totalRestarts += cs.restartCount ?? 0;
    }
  }

  // STEP 3: Convert all events into a single lowercase string per event,
  // then check for probe failure keywords.
  const messages = events.map((e) =>
    `${e.reason ?? ""} ${e.message ?? ""}`.toLowerCase()
  );

  const readinessFailures = messages.some((m) =>
    m.includes("readiness probe failed")
  );

  const livenessFailures = messages.some((m) =>
    m.includes("liveness probe failed")
  );

  // STEP 4: Record which probe types are missing as plain-text findings.
  if (!hasReadiness) findings.push("Missing readiness probe");
  if (!hasLiveness)  findings.push("Missing liveness probe");
  if (!hasStartup)   findings.push("Missing startup probe");

  // STEP 5: Select the profile based on observed instability signals.
  const profile = selectProbeProfile({
    hasReadiness,
    hasLiveness,
    hasStartup,
    totalRestarts,
    readinessFailures,
    livenessFailures,
  });

  // STEP 6: Build a rationale explaining why this profile was chosen.
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


// =============================================================================
// selectProbeProfile  (private helper)
// =============================================================================
//
// WHAT IT DOES:
//   Maps the observed instability signals to one of the three ProbeProfile
//   values, from most severe to least severe.
//
// DECISION LOGIC:
//   - liveness failures OR 3+ restarts → "unstable"  (most severe)
//   - readiness failures OR any restart → "slow_start"
//   - probes missing but no failures   → "basic"     (least severe)
// =============================================================================
function selectProbeProfile(params: {
  hasReadiness: boolean;
  hasLiveness: boolean;
  hasStartup: boolean;
  totalRestarts: number;
  readinessFailures: boolean;
  livenessFailures: boolean;
}): ProbeProfile {
  const { totalRestarts, readinessFailures, livenessFailures } = params;

  // Most severe case: the container is being repeatedly killed and restarted.
  if (livenessFailures || totalRestarts >= 3) {
    return "unstable";
  }

  // Medium severity: the container isn't ready in time or has restarted once.
  if (readinessFailures || totalRestarts > 0) {
    return "slow_start";
  }

  // Least severe: probes are misconfigured or missing, but no active failures.
  return "basic";
}


// =============================================================================
// buildProbeConfigFromProfile  (private helper)
// =============================================================================
//
// WHAT IT DOES:
//   Returns a ready-to-apply probe configuration object for the given profile.
//   These values are designed to be safe starting points — not perfect for
//   every application, but better than the defaults or nothing at all.
//
// UNDERSTANDING THE TIMING FIELDS:
//   initialDelaySeconds: how long to wait after the container starts before
//                        running the first probe check
//   periodSeconds:       how often to run the probe after that
//   timeoutSeconds:      how long to wait for the probe to respond before
//                        counting it as a failure
//   failureThreshold:    how many consecutive failures before action is taken
//   successThreshold:    how many consecutive successes before the probe passes
// =============================================================================
function buildProbeConfigFromProfile(profile: ProbeProfile) {

  if (profile === "basic") {
    // Short delays, frequent checks — for stable apps that start quickly.
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
    // Longer initial delays and a startupProbe to give the app more boot time.
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
        failureThreshold: 10, // allows up to 10 * 5 = 50 seconds for startup
      },
    };
  }

  // "unstable" profile — maximum startup protection, tolerant thresholds.
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
      failureThreshold: 12, // allows up to 12 * 5 = 60 seconds for startup
    },
  };
}
