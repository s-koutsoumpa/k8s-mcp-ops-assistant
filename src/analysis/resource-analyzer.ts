// =============================================================================
// resource-analyzer.ts
// =============================================================================
//
// WHAT IS THIS FILE?
// ------------------
// This file looks at how much CPU and memory a deployment's pods are actually
// using, and decides whether the current resource settings are appropriate.
//
// It classifies the deployment into one of four "profiles":
//   - balanced         → no pressure detected, keep moderate settings
//   - cpu_pressure     → pods are using a lot of CPU, increase CPU limits
//   - memory_pressure  → pods are using a lot of memory, increase memory limits
//   - underprovisioned → both CPU and memory are under pressure
//
// Based on the profile, it then suggests specific CPU/memory request and
// limit values to apply via the patch_resources action.
//
// WHERE IS IT USED?
// -----------------
// - src/server.ts calls analyzeResources() when the agent uses the
//   "analyze_resources" MCP tool.
// - src/analysis/analyzer.ts calls suggestSmartResources() with placeholder
//   metrics (cpu/memory = "0") just to get the profile name for ordering logic.
//   It does NOT use the suggested resource values from here.
//
// HOW IT FITS WITH THE REST OF THE SYSTEM
// ----------------------------------------
// The flow for a resource problem is:
//
//   1. Agent calls analyze_resources  → analyzeResources() here
//   2. We read live metrics and select a profile
//   3. We return suggested resource values (requests + limits)
//   4. Agent calls execute_action → patch_resources with those values
//   5. action-tools.ts applies them to the cluster
//
// PARSING NOTE:
// -------------
// Kubernetes metric values come back as strings like "23m" (CPU millicores)
// or "45Mi" (memory in Mebibytes). The helper functions at the bottom of
// this file convert those strings into plain numbers for comparison.
// =============================================================================


// The four resource health profiles this analyzer can select.
type ResourceProfile =
  | "balanced"
  | "cpu_pressure"
  | "memory_pressure"
  | "underprovisioned";


// =============================================================================
// 1. analyzeResources
// =============================================================================
//
// WHAT IT DOES:
//   Filters pod metrics to find only the pods belonging to the named
//   deployment, runs the smart resource tuning logic, and returns a
//   structured report with findings and suggested resource values.
//
// WHEN TO USE IT:
//   Called by the "analyze_resources" MCP tool in server.ts. The agent
//   should call this when a deployment is suspected to have resource problems
//   (e.g. OOMKilled pods, CPU throttling, or FailedScheduling events).
//
// HOW IT WORKS:
//   STEP 1: Filter the incoming metrics list to only pods whose name starts
//           with the deployment name (e.g. "nginx-" for deployment "nginx").
//   STEP 2: Run suggestSmartResources() to classify the workload and build
//           the suggested resource configuration.
//   STEP 3: Collect the findings and return the full result.
// =============================================================================
export function analyzeResources(input: {
  deploymentName: string;
  namespace: string;
  podMetrics: any[];
}) {
  const { deploymentName, namespace, podMetrics } = input;

  const findings: any[] = [];

  // STEP 1: Keep only pod metrics that likely belong to this deployment.
  // Kubernetes names pods as "<deploymentName>-<hash>-<hash>", so filtering
  // by prefix is a reliable way to find the right pods.
  const relevantMetrics = filterMetricsForDeployment(deploymentName, podMetrics);

  // STEP 2: Run the profile-based tuning logic on the filtered metrics.
  const smartTuning = suggestSmartResources({
    deploymentName,
    podMetrics: relevantMetrics,
  });

  // STEP 3: Wrap each tuning finding in a typed object for the result.
  for (const finding of smartTuning.findings) {
    findings.push({
      type: "resource_signal",
      detail: finding,
    });
  }

  return {
    deployment: deploymentName,
    namespace,
    findings,
    smartTuning,
  };
}


// =============================================================================
// 2. suggestSmartResources
// =============================================================================
//
// WHAT IT DOES:
//   Reads the pod metrics, selects the right resource profile, and returns
//   both a human-readable rationale and specific CPU/memory values to apply.
//
// WHEN TO USE IT:
//   Called internally by analyzeResources(), and also called directly by
//   analyzer.ts with placeholder metrics (just to get the profile name).
//
// HOW IT WORKS:
//   STEP 1: Summarize the metrics into signal counts (how many pods are
//           above the high-CPU or high-memory thresholds).
//   STEP 2: Select a profile based on those signal counts.
//   STEP 3: Build human-readable rationale strings for the selected profile.
//   STEP 4: Record specific findings (how many pods, highest usage seen).
//   STEP 5: Return everything, including the suggested resource block.
// =============================================================================
export function suggestSmartResources(params: {
  deploymentName: string;
  podMetrics: any[];
}) {
  const { podMetrics } = params;

  const findings: string[] = [];
  const rationale: string[] = [];

  // STEP 1: Summarize raw metrics into high-level signal counts.
  const resourceSignals = summarizeResourceSignals(podMetrics);

  // STEP 2: Select which profile best describes the current pressure level.
  const profile = selectResourceProfile(resourceSignals);

  // STEP 3: Build rationale strings explaining the selected profile.
  rationale.push(`Selected resource profile: ${profile}`);

  if (profile === "balanced") {
    rationale.push(
      "The workload does not currently show strong CPU or memory pressure."
    );
  }

  if (profile === "cpu_pressure") {
    rationale.push(
      "Observed CPU usage suggests the workload may need more CPU resources."
    );
  }

  if (profile === "memory_pressure") {
    rationale.push(
      "Observed memory usage suggests the workload may need more memory resources."
    );
  }

  if (profile === "underprovisioned") {
    rationale.push(
      "Observed signals suggest the workload may be underprovisioned in both CPU and memory."
    );
  }

  // STEP 4: Record specific numeric findings for the report.
  if (resourceSignals.highCpuPods > 0) {
    findings.push(`${resourceSignals.highCpuPods} pod(s) show elevated CPU usage.`);
  }

  if (resourceSignals.highMemoryPods > 0) {
    findings.push(`${resourceSignals.highMemoryPods} pod(s) show elevated memory usage.`);
  }

  if (resourceSignals.maxCpuMillicores > 0) {
    findings.push(
      `Highest observed CPU usage: ${resourceSignals.maxCpuMillicores.toFixed(1)}m.`
    );
  }

  if (resourceSignals.maxMemoryMi > 0) {
    findings.push(
      `Highest observed memory usage: ${resourceSignals.maxMemoryMi.toFixed(1)}Mi.`
    );
  }

  // STEP 5: Return the full result including the profile-based resource block.
  return {
    findings,
    rationale,
    selectedProfile: profile,
    suggestedResources: buildResourcesFromProfile(profile),
  };
}


// =============================================================================
// filterMetricsForDeployment  (private helper)
// =============================================================================
//
// WHAT IT DOES:
//   Keeps only the pods whose name starts with "<deploymentName>-",
//   filtering out pods from other deployments in the same namespace.
//
// HOW IT WORKS:
//   Pod names in Kubernetes follow the pattern "<deployment>-<rs-hash>-<pod-hash>".
//   Checking startsWith("<deploymentName>-") reliably identifies the right pods.
//   We try several common field names because different callers may pass
//   metrics in slightly different shapes.
// =============================================================================
function filterMetricsForDeployment(deploymentName: string, podMetrics: any[]) {

  // "?? []" means: if podMetrics is null or undefined, treat it as an empty array.
  return (podMetrics ?? []).filter((pod) => {

    // Different metric sources use different field names for the pod name.
    // We try each in order and fall back to an empty string if none are set.
    const podName =
      pod.pod ||
      pod.name ||
      pod.podName ||
      pod.metadata?.name ||
      "";

    return String(podName).startsWith(`${deploymentName}-`);
  });
}


// =============================================================================
// summarizeResourceSignals  (private helper)
// =============================================================================
//
// WHAT IT DOES:
//   Loops through pod metrics and counts how many pods exceed the CPU and
//   memory usage thresholds. Also tracks the highest usage seen.
//
// THRESHOLDS USED:
//   - CPU:    >= 80m (80 millicores) → considered elevated
//   - Memory: >= 120Mi               → considered elevated
//
// HOW IT WORKS:
//   For each pod, extract its CPU and memory usage as plain numbers
//   (using the helper functions at the bottom of this file), then
//   compare against the thresholds and update the running totals.
// =============================================================================
function summarizeResourceSignals(podMetrics: any[]) {
  let highCpuPods = 0;
  let highMemoryPods = 0;
  let maxCpuMillicores = 0;
  let maxMemoryMi = 0;

  for (const pod of podMetrics ?? []) {
    const cpuMillicores = extractCpuMillicoresFromMetric(pod);
    const memoryMi = extractMemoryMiFromMetric(pod);

    if (cpuMillicores >= 80) {
      highCpuPods += 1;
    }

    if (memoryMi >= 120) {
      highMemoryPods += 1;
    }

    if (cpuMillicores > maxCpuMillicores) {
      maxCpuMillicores = cpuMillicores;
    }

    if (memoryMi > maxMemoryMi) {
      maxMemoryMi = memoryMi;
    }
  }

  return { highCpuPods, highMemoryPods, maxCpuMillicores, maxMemoryMi };
}


// =============================================================================
// selectResourceProfile  (private helper)
// =============================================================================
//
// WHAT IT DOES:
//   Maps the signal counts from summarizeResourceSignals() to one of the
//   four ResourceProfile values.
//
// DECISION LOGIC:
//   - Both high CPU and high memory pods → "underprovisioned"
//   - Only high CPU pods                 → "cpu_pressure"
//   - Only high memory pods              → "memory_pressure"
//   - Neither                            → "balanced"
// =============================================================================
function selectResourceProfile(signals: {
  highCpuPods: number;
  highMemoryPods: number;
}): ResourceProfile {
  const { highCpuPods, highMemoryPods } = signals;

  if (highCpuPods > 0 && highMemoryPods > 0) {
    return "underprovisioned";
  }

  if (highCpuPods > 0) {
    return "cpu_pressure";
  }

  if (highMemoryPods > 0) {
    return "memory_pressure";
  }

  return "balanced";
}


// =============================================================================
// buildResourcesFromProfile  (private helper)
// =============================================================================
//
// WHAT IT DOES:
//   Returns a Kubernetes resource block (requests + limits) tuned for the
//   given profile. These are safe, conservative starting values.
//
// UNDERSTANDING THE UNITS:
//   CPU:    "100m"  = 100 millicores = 0.1 of one CPU core
//           "500m"  = 500 millicores = 0.5 of one CPU core
//   Memory: "128Mi" = 128 Mebibytes
//           "512Mi" = 512 Mebibytes
//
//   "requests" = what the container needs (Kubernetes reserves this on the node)
//   "limits"   = the maximum the container may use (exceeding memory = OOMKill)
// =============================================================================
function buildResourcesFromProfile(profile: ResourceProfile) {
  if (profile === "balanced") {
    return {
      requests: { cpu: "100m", memory: "128Mi" },
      limits:   { cpu: "250m", memory: "256Mi" },
    };
  }

  if (profile === "cpu_pressure") {
    return {
      requests: { cpu: "250m", memory: "128Mi" },
      limits:   { cpu: "500m", memory: "256Mi" },
    };
  }

  if (profile === "memory_pressure") {
    return {
      requests: { cpu: "100m", memory: "256Mi" },
      limits:   { cpu: "250m", memory: "512Mi" },
    };
  }

  // "underprovisioned" — give more of both
  return {
    requests: { cpu: "250m", memory: "256Mi" },
    limits:   { cpu: "500m", memory: "512Mi" },
  };
}


// =============================================================================
// extractCpuMillicoresFromMetric  (private helper)
// =============================================================================
//
// WHAT IT DOES:
//   Reads the CPU usage value out of a pod metric object (which may have
//   different shapes depending on the source) and returns it as a number
//   in millicores.
//
// HOW IT WORKS:
//   STEP 1: Try to find a direct top-level CPU field. Different callers
//           use different field names, so we try several.
//   STEP 2: If found, parse and return it.
//   STEP 3: If not found, check if the pod has a containers array and
//           sum CPU across all containers.
// =============================================================================
function extractCpuMillicoresFromMetric(pod: any): number {

  // STEP 1: Try to find a direct CPU value at the top level of the pod object.
  // We check multiple field names because the metrics-server, kubectl top,
  // and our own code all use slightly different shapes.
  const directCpu =
    pod.cpu ||
    pod.cpuUsage ||
    pod.usage?.cpu ||
    pod.metrics?.cpu;

  // STEP 2: If we found a direct value, parse it and return immediately.
  if (directCpu) {
    return parseCpuToMillicores(String(directCpu).toLowerCase());
  }

  // STEP 3: If no direct value, check if the pod has a containers array
  // and sum up CPU usage across all containers.
  if (Array.isArray(pod.containers)) {
    let total = 0;
    for (const container of pod.containers) {
      const cpu =
        container.cpu ||
        container.cpuUsage ||
        container.usage?.cpu ||
        container.metrics?.cpu;

      total += parseCpuToMillicores(String(cpu || "").toLowerCase());
    }
    return total;
  }

  return 0;
}


// =============================================================================
// extractMemoryMiFromMetric  (private helper)
// =============================================================================
//
// WHAT IT DOES:
//   Same idea as extractCpuMillicoresFromMetric, but for memory.
//   Returns memory usage as a plain number in Mebibytes (Mi).
// =============================================================================
function extractMemoryMiFromMetric(pod: any): number {

  // Try to find a direct memory value at the top level.
  const directMemory =
    pod.memory ||
    pod.memoryUsage ||
    pod.usage?.memory ||
    pod.metrics?.memory;

  if (directMemory) {
    return parseMemoryToMi(String(directMemory).toLowerCase());
  }

  // Fall back to summing memory across the containers array.
  if (Array.isArray(pod.containers)) {
    let total = 0;
    for (const container of pod.containers) {
      const memory =
        container.memory ||
        container.memoryUsage ||
        container.usage?.memory ||
        container.metrics?.memory;

      total += parseMemoryToMi(String(memory || "").toLowerCase());
    }
    return total;
  }

  return 0;
}


// =============================================================================
// parseCpuToMillicores  (private helper)
// =============================================================================
//
// WHAT IT DOES:
//   Converts a Kubernetes CPU string into a plain number in millicores.
//
// EXAMPLES:
//   "23m"   → 23       (already in millicores)
//   "500n"  → 0.0005   (nanocores → millicores, very rare)
//   "0.5"   → 500      (fractional cores → millicores)
//   "2"     → 2000     (whole cores → millicores)
// =============================================================================
function parseCpuToMillicores(cpu: string): number {
  if (!cpu) return 0;

  if (cpu.endsWith("n")) {
    // Nanocores: 1 millicore = 1,000,000 nanocores
    const value = Number(cpu.replace("n", ""));
    return Number.isNaN(value) ? 0 : value / 1_000_000;
  }

  if (cpu.endsWith("m")) {
    // Millicores: already the unit we want
    return Number(cpu.replace("m", "")) || 0;
  }

  // Plain number: treat as whole cores, convert to millicores
  const cores = Number(cpu);
  if (!Number.isNaN(cores)) {
    return cores * 1000;
  }

  return 0;
}


// =============================================================================
// parseMemoryToMi  (private helper)
// =============================================================================
//
// WHAT IT DOES:
//   Converts a Kubernetes memory string into a plain number in Mebibytes.
//
// EXAMPLES:
//   "128mi"  → 128       (already in Mebibytes)
//   "1gi"    → 1024      (Gibibytes → Mebibytes)
//   "512ki"  → 0.5       (Kibibytes → Mebibytes)
//   "134217" → ~0.128    (raw bytes → Mebibytes)
// =============================================================================
function parseMemoryToMi(memory: string): number {
  if (!memory) return 0;

  if (memory.endsWith("gi")) {
    // Gibibytes → Mebibytes (1 Gi = 1024 Mi)
    const value = Number(memory.replace("gi", ""));
    return Number.isNaN(value) ? 0 : value * 1024;
  }

  if (memory.endsWith("mi")) {
    // Already in Mebibytes
    const value = Number(memory.replace("mi", ""));
    return Number.isNaN(value) ? 0 : value;
  }

  if (memory.endsWith("ki")) {
    // Kibibytes → Mebibytes (1 Mi = 1024 Ki)
    const value = Number(memory.replace("ki", ""));
    return Number.isNaN(value) ? 0 : value / 1024;
  }

  // Raw bytes → Mebibytes
  const raw = Number(memory);
  return Number.isNaN(raw) ? 0 : raw / (1024 * 1024);
}
