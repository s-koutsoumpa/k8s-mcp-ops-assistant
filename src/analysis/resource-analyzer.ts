// =============================================================================
// resource-analyzer.ts
// =============================================================================
//
// WHAT IS THIS FILE?
// ------------------
// This file looks at how much CPU and memory a deployment's pods are actually
// using, and decides whether the current resource settings are appropriate.
//
// The logic is grounded in the Kubernetes Vertical Pod Autoscaler (VPA)
// recommender. We deliberately mirror VPA's percentile-based methodology so
// that the recommendations we surface to the agent follow the same theory
// VPA itself uses to set CPU and memory requests in production clusters.
//
// THEORY REFERENCE — Kubernetes Vertical Pod Autoscaler (official docs):
//   https://kubernetes.io/docs/concepts/workloads/autoscaling/vertical-pod-autoscale/
//
// IMPLEMENTATION REFERENCE — VPA recommender source (master branch):
//   https://github.com/kubernetes/autoscaler/blob/master/vertical-pod-autoscaler/pkg/recommender/logic/recommender.go
//
// In particular, every numeric constant in the VPA_* section below is
// taken directly from the default value of the corresponding command-line
// flag in recommender.go. See the citation block above each constant for
// the exact flag name and default.
//
// RESOURCE PROFILES (the four labels we report back to the agent):
//   - balanced         → no pressure detected, keep moderate settings
//   - cpu_pressure     → observed CPU usage suggests more CPU is needed
//   - memory_pressure  → observed memory usage suggests more memory is needed
//   - underprovisioned → both CPU and memory are under pressure
//
// WHERE IS IT USED?
// -----------------
// - src/server.ts calls analyzeResources() when the agent uses the
//   "analyze_resources" MCP tool.
// - src/analysis/analyzer.ts calls suggestSmartResources() with placeholder
//   metrics (cpu/memory = "0") just to get the profile name for ordering logic.
//   With all-zero input the percentile path returns "balanced", which is
//   the same neutral signal the previous threshold-based code returned.
//
// HOW IT FITS WITH THE REST OF THE SYSTEM
// ----------------------------------------
// The flow for a resource problem is:
//
//   1. Agent calls analyze_resources         → analyzeResources() here
//   2. We compute VPA-style percentile estimates from observed pod metrics
//   3. We return suggested resource values (requests + limits)
//   4. Agent calls execute_action            → patch_resources with those values
//   5. action-tools.ts applies them to the cluster
//
// PARSING NOTE:
// -------------
// Kubernetes metric values come back as strings like "23m" (CPU millicores)
// or "45Mi" (memory in Mebibytes). The helper functions at the bottom of
// this file convert those strings into plain numbers for comparison.
// =============================================================================


// -----------------------------------------------------------------------------
// VPA-aligned constants
// -----------------------------------------------------------------------------
// Every constant below is the default value of the corresponding command-line
// flag in the official VPA recommender (recommender.go). Citation URL:
//
//   https://github.com/kubernetes/autoscaler/blob/master/vertical-pod-autoscaler/pkg/recommender/logic/recommender.go
//
// We mirror the defaults here so our recommendations align with what a
// real VPA installation in --recommender-only mode would produce on the
// same observed metrics.
// -----------------------------------------------------------------------------

// flag.Float64("target-cpu-percentile", 0.9, ...)
// flag.Float64("target-memory-percentile", 0.9, ...)
// VPA's default "target" percentile for both CPU and memory: the 90th.
// Used as the basis for the recommended `requests` value.
const VPA_TARGET_PERCENTILE = 0.9;

// flag.Float64("recommendation-lower-bound-cpu-percentile", 0.5, ...)
// flag.Float64("recommendation-lower-bound-memory-percentile", 0.5, ...)
// VPA's default "lower bound" percentile: the 50th (median).
// Represents the minimum the workload typically needs.
const VPA_LOWER_BOUND_PERCENTILE = 0.5;

// flag.Float64("recommendation-upper-bound-cpu-percentile", 0.95, ...)
// flag.Float64("recommendation-upper-bound-memory-percentile", 0.95, ...)
// VPA's default "upper bound" percentile: the 95th.
// Used as the basis for the recommended `limits` value.
const VPA_UPPER_BOUND_PERCENTILE = 0.95;

// flag.Float64("recommendation-margin-fraction", 0.15, ...)
// VPA's default safety margin: +15% on top of every percentile-based estimate.
const VPA_SAFETY_MARGIN_FRACTION = 0.15;

// flag.Float64("pod-recommendation-min-cpu-millicores", 25, ...)
// VPA's CPU recommendation floor: any percentile estimate below 25m is
// clamped up to 25m so that idle workloads still get a non-zero request.
const VPA_MIN_CPU_MILLICORES = 25;

// flag.Float64("pod-recommendation-min-memory-mb", 250, ...)
// VPA's memory recommendation floor is in MB (250). We work in Mebibytes (Mi)
// throughout this file because that is the unit Kubernetes uses for memory
// resource fields, so we convert: 250 MB ≈ 238 Mi.
//   250 * 1000 * 1000 / (1024 * 1024) = 238.418...
const VPA_MIN_MEMORY_MI = 238;

// "Pressure" threshold multiplier: a workload is reported as under pressure
// on a given resource only when its VPA-style target recommendation is at
// least this many times the VPA minimum floor.
//
// 2.0 means the percentile-based target has climbed to twice the floor —
// strong evidence that the workload is genuinely consuming the resource
// rather than being clamped to the floor by VPA's idle-workload protection.
//
// This multiplier is the only judgement call in this file that does not
// come from VPA defaults. It is documented as our own conservative choice;
// anything below 2.0 risks reporting pressure for workloads that are simply
// being floored, anything above 2.0 risks missing real pressure on small
// workloads.
const PRESSURE_THRESHOLD_MULTIPLIER = 2.0;


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
//   deployment, runs the VPA-aligned tuning logic, and returns a structured
//   report with findings, percentile measurements, and suggested resource
//   values.
//
// WHEN TO USE IT:
//   Called by the "analyze_resources" MCP tool in server.ts. The agent
//   should call this when a deployment is suspected to have resource problems
//   (e.g. OOMKilled pods, CPU throttling, or FailedScheduling events).
//
// HOW IT WORKS:
//   STEP 1: Filter the incoming metrics list to only pods whose name starts
//           with the deployment name (e.g. "nginx-" for deployment "nginx").
//   STEP 2: Run suggestSmartResources() to compute percentiles, build the
//           VPA-aligned recommendation, and pick a profile.
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

  // STEP 2: Run the VPA-aligned tuning logic on the filtered metrics.
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
//   Reads pod metrics, computes VPA-style percentile estimates for both CPU
//   and memory (p50/p90/p95), applies VPA's 15% safety margin and minimum
//   floors, picks the right resource profile, and returns:
//     - findings (human-readable observations)
//     - rationale (why the profile was selected)
//     - selectedProfile (the four-value label)
//     - suggestedResources (concrete requests + limits ready to apply)
//     - percentileSignals (raw measurements for transparency)
//
// WHEN TO USE IT:
//   Called internally by analyzeResources(). Also called by analyzer.ts with
//   placeholder metrics (just to obtain the profile name).
//
// HOW IT WORKS:
//   STEP 1: Compute percentile signals (p50, p90, p95) and apply VPA's
//           15% safety margin and minimum floors to get target / upper bound.
//   STEP 2: Select a profile by checking whether the targets exceed
//           PRESSURE_THRESHOLD_MULTIPLIER × VPA minimum floor.
//   STEP 3: Build human-readable rationale strings.
//   STEP 4: Record specific findings.
//   STEP 5: Build the recommended Kubernetes resource block.
//   STEP 6: Return everything.
// =============================================================================
export function suggestSmartResources(params: {
  deploymentName: string;
  podMetrics: any[];
}) {
  const { podMetrics } = params;

  const findings: string[] = [];
  const rationale: string[] = [];

  // STEP 1: Compute percentile signals from the observed pod metrics.
  // These are the same percentiles VPA's recommender uses (0.5, 0.9, 0.95)
  // — see the VPA_*_PERCENTILE constants at the top of this file.
  const signals = computePercentileSignals(podMetrics);

  // STEP 2: Select a profile. A workload is "under pressure" on a resource
  // when its VPA-style target has climbed to at least PRESSURE_THRESHOLD_MULTIPLIER
  // times the VPA minimum floor. This means percentile-based observation
  // indicates real consumption rather than an idle workload that VPA would
  // simply clamp to its minimum.
  const profile = selectResourceProfile(signals);

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

  // Methodology note so the agent can explain it to the user if asked.
  rationale.push(
    "Recommendation derived from VPA-aligned percentiles " +
      "(p50 lower bound, p90 target, p95 upper bound) with a 15% safety " +
      "margin and minimum floors of 25m CPU and ~238Mi memory. " +
      "Reference: https://github.com/kubernetes/autoscaler/blob/master/" +
      "vertical-pod-autoscaler/pkg/recommender/logic/recommender.go"
  );

  // STEP 4: Record specific numeric findings for the report.
  const cpuPressureThreshold = VPA_MIN_CPU_MILLICORES * PRESSURE_THRESHOLD_MULTIPLIER;
  const memoryPressureThreshold = VPA_MIN_MEMORY_MI * PRESSURE_THRESHOLD_MULTIPLIER;

  if (signals.cpuTargetMillicores >= cpuPressureThreshold) {
    findings.push(
      `Deployment shows elevated CPU usage (target ${signals.cpuTargetMillicores.toFixed(1)}m ` +
        `exceeds ${cpuPressureThreshold}m, which is ${PRESSURE_THRESHOLD_MULTIPLIER}× ` +
        `the VPA minimum of ${VPA_MIN_CPU_MILLICORES}m).`
    );
  }

  if (signals.memoryTargetMi >= memoryPressureThreshold) {
    findings.push(
      `Deployment shows elevated memory usage (target ${signals.memoryTargetMi.toFixed(1)}Mi ` +
        `exceeds ${memoryPressureThreshold}Mi, which is ${PRESSURE_THRESHOLD_MULTIPLIER}× ` +
        `the VPA minimum of ${VPA_MIN_MEMORY_MI}Mi).`
    );
  }

  if (signals.cpuP95Millicores > 0) {
    findings.push(
      `CPU usage percentiles (millicores): ` +
        `p50=${signals.cpuP50Millicores.toFixed(1)}, ` +
        `p90=${signals.cpuP90Millicores.toFixed(1)}, ` +
        `p95=${signals.cpuP95Millicores.toFixed(1)}.`
    );
  }

  if (signals.memoryP95Mi > 0) {
    findings.push(
      `Memory usage percentiles (Mi): ` +
        `p50=${signals.memoryP50Mi.toFixed(1)}, ` +
        `p90=${signals.memoryP90Mi.toFixed(1)}, ` +
        `p95=${signals.memoryP95Mi.toFixed(1)}.`
    );
  }

  // STEP 5: Build the suggested Kubernetes resource block from the percentiles.
  const suggestedResources = buildResourcesFromPercentiles(signals);

  // STEP 6: Return the full result. The percentileSignals field exposes the
  // raw measurements so the agent can show transparent reasoning to the user.
  return {
    findings,
    rationale,
    selectedProfile: profile,
    suggestedResources,
    percentileSignals: {
      cpu: {
        p50Millicores: round1(signals.cpuP50Millicores),
        p90Millicores: round1(signals.cpuP90Millicores),
        p95Millicores: round1(signals.cpuP95Millicores),
        targetMillicoresWithMargin: round1(signals.cpuTargetMillicores),
        upperBoundMillicoresWithMargin: round1(signals.cpuUpperBoundMillicores),
      },
      memory: {
        p50Mi: round1(signals.memoryP50Mi),
        p90Mi: round1(signals.memoryP90Mi),
        p95Mi: round1(signals.memoryP95Mi),
        targetMiWithMargin: round1(signals.memoryTargetMi),
        upperBoundMiWithMargin: round1(signals.memoryUpperBoundMi),
      },
    },
  };
}


// =============================================================================
// computePercentileSignals  (private helper)
// =============================================================================
//
// WHAT IT DOES:
//   Computes p50, p90, and p95 percentiles of CPU and memory usage across
//   all pods in the deployment, then computes "target" and "upperBound"
//   estimates by adding the VPA 15% safety margin and clamping to VPA
//   minimum floors.
//
// WHY THESE PERCENTILES:
//   These are the same percentiles VPA's recommender uses (see the VPA_*
//   constants at the top of this file). VPA produces three estimations
//   per container:
//     - lowerBound (p50)    → minimum the workload typically needs
//     - target (p90)        → recommended request value
//     - upperBound (p95)    → recommended limit value
//   See: https://github.com/kubernetes/autoscaler/blob/master/vertical-pod-autoscaler/pkg/recommender/logic/recommender.go
// =============================================================================
function computePercentileSignals(podMetrics: any[]) {
  const cpuValues: number[] = [];
  const memoryValues: number[] = [];

  for (const pod of podMetrics ?? []) {
    cpuValues.push(extractCpuMillicoresFromMetric(pod));
    memoryValues.push(extractMemoryMiFromMetric(pod));
  }

  // Raw percentiles of observed usage.
  const cpuP50 = percentile(cpuValues, VPA_LOWER_BOUND_PERCENTILE);
  const cpuP90 = percentile(cpuValues, VPA_TARGET_PERCENTILE);
  const cpuP95 = percentile(cpuValues, VPA_UPPER_BOUND_PERCENTILE);

  const memoryP50 = percentile(memoryValues, VPA_LOWER_BOUND_PERCENTILE);
  const memoryP90 = percentile(memoryValues, VPA_TARGET_PERCENTILE);
  const memoryP95 = percentile(memoryValues, VPA_UPPER_BOUND_PERCENTILE);

  // Apply VPA's 15% safety margin and floor to VPA minimums to get the
  // values that would actually become Kubernetes resource fields.
  const cpuTargetMillicores = applyMarginAndFloor(cpuP90, VPA_MIN_CPU_MILLICORES);
  const cpuUpperBoundMillicores = applyMarginAndFloor(cpuP95, VPA_MIN_CPU_MILLICORES);
  const memoryTargetMi = applyMarginAndFloor(memoryP90, VPA_MIN_MEMORY_MI);
  const memoryUpperBoundMi = applyMarginAndFloor(memoryP95, VPA_MIN_MEMORY_MI);

  return {
    cpuP50Millicores: cpuP50,
    cpuP90Millicores: cpuP90,
    cpuP95Millicores: cpuP95,
    cpuTargetMillicores,
    cpuUpperBoundMillicores,
    memoryP50Mi: memoryP50,
    memoryP90Mi: memoryP90,
    memoryP95Mi: memoryP95,
    memoryTargetMi,
    memoryUpperBoundMi,
  };
}


// =============================================================================
// applyMarginAndFloor  (private helper)
// =============================================================================
//
// Adds the VPA safety margin (15%) to an estimate, then clamps the result to
// at least the VPA minimum floor.
//
//   final = max( estimate * (1 + 0.15) , floor )
//
// REFERENCE: VPA recommender.go uses WithMargin() to apply the same +15%
// fraction (the recommendation-margin-fraction flag), and uses
// pod-recommendation-min-cpu-millicores / pod-recommendation-min-memory-mb
// as the floors. URL:
//   https://github.com/kubernetes/autoscaler/blob/master/vertical-pod-autoscaler/pkg/recommender/logic/recommender.go
// =============================================================================
function applyMarginAndFloor(estimate: number, floor: number): number {
  const withMargin = estimate * (1 + VPA_SAFETY_MARGIN_FRACTION);
  return Math.max(withMargin, floor);
}


// =============================================================================
// percentile  (private helper)
// =============================================================================
//
// Computes the given percentile (0..1) of a list of numbers using linear
// interpolation between adjacent values. Returns 0 for an empty input.
//
//   percentile(xs, 0.5)  → median
//   percentile(xs, 0.9)  → 90th percentile
//   percentile(xs, 0.95) → 95th percentile
//
// This is the standard "type 7" percentile (the same one numpy and most
// statistics libraries use by default).
// =============================================================================
function percentile(values: number[], p: number): number {
  if (!values || values.length === 0) return 0;

  // Sort a copy so we don't mutate the caller's array.
  const sorted = [...values].sort((a, b) => a - b);

  if (sorted.length === 1) return sorted[0];

  // Compute the fractional index in the sorted array.
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);

  if (lo === hi) return sorted[lo];

  // Linear interpolation between the two surrounding values.
  const fraction = idx - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * fraction;
}


// =============================================================================
// selectResourceProfile  (private helper)
// =============================================================================
//
// WHAT IT DOES:
//   Picks one of the four ResourceProfile values based on whether the
//   computed VPA-style targets indicate "real" resource consumption.
//
//   The VPA recommender uses pod-recommendation-min-cpu-millicores=25 and
//   pod-recommendation-min-memory-mb=250 as floors below which percentile
//   estimates are clamped. So a target that is significantly above this
//   floor (we use 2x) means the workload's observed percentile usage is
//   genuinely consuming more than the VPA "idle" minimum — i.e., pressure.
//
// DECISION LOGIC:
//   - cpuTarget >= 2 × VPA_MIN_CPU AND memoryTarget >= 2 × VPA_MIN_MEMORY → "underprovisioned"
//   - cpuTarget >= 2 × VPA_MIN_CPU only                                  → "cpu_pressure"
//   - memoryTarget >= 2 × VPA_MIN_MEMORY only                            → "memory_pressure"
//   - Neither                                                            → "balanced"
// =============================================================================
function selectResourceProfile(signals: {
  cpuTargetMillicores: number;
  memoryTargetMi: number;
}): ResourceProfile {
  const cpuPressureThreshold = VPA_MIN_CPU_MILLICORES * PRESSURE_THRESHOLD_MULTIPLIER;
  const memoryPressureThreshold = VPA_MIN_MEMORY_MI * PRESSURE_THRESHOLD_MULTIPLIER;

  const isCpuPressure = signals.cpuTargetMillicores >= cpuPressureThreshold;
  const isMemoryPressure = signals.memoryTargetMi >= memoryPressureThreshold;

  if (isCpuPressure && isMemoryPressure) return "underprovisioned";
  if (isCpuPressure) return "cpu_pressure";
  if (isMemoryPressure) return "memory_pressure";
  return "balanced";
}


// =============================================================================
// buildResourcesFromPercentiles  (private helper)
// =============================================================================
//
// WHAT IT DOES:
//   Returns a Kubernetes resource block (requests + limits) built directly
//   from the VPA-style percentile signals.
//
//     requests.cpu     ← target CPU      (p90 + 15% margin, floored to 25m)
//     requests.memory  ← target memory   (p90 + 15% margin, floored to ~238Mi)
//     limits.cpu       ← upper-bound CPU (p95 + 15% margin)
//     limits.memory    ← upper-bound mem (p95 + 15% margin)
//
//   This mirrors the VPA pattern of using Target for requests and
//   UpperBound as a ceiling. For background, see the VPA documentation:
//   https://kubernetes.io/docs/concepts/workloads/autoscaling/vertical-pod-autoscale/
// =============================================================================
function buildResourcesFromPercentiles(signals: {
  cpuTargetMillicores: number;
  cpuUpperBoundMillicores: number;
  memoryTargetMi: number;
  memoryUpperBoundMi: number;
}) {
  return {
    requests: {
      cpu: `${Math.ceil(signals.cpuTargetMillicores)}m`,
      memory: `${Math.ceil(signals.memoryTargetMi)}Mi`,
    },
    limits: {
      cpu: `${Math.ceil(signals.cpuUpperBoundMillicores)}m`,
      memory: `${Math.ceil(signals.memoryUpperBoundMi)}Mi`,
    },
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
// =============================================================================
function filterMetricsForDeployment(deploymentName: string, podMetrics: any[]) {
  return (podMetrics ?? []).filter((pod) => {
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
// extractCpuMillicoresFromMetric  (private helper)
// =============================================================================
//
// WHAT IT DOES:
//   Reads the CPU usage value out of a pod metric object (which may have
//   different shapes depending on the source) and returns it as a number
//   in millicores.
// =============================================================================
function extractCpuMillicoresFromMetric(pod: any): number {
  const directCpu =
    pod.cpu ||
    pod.cpuUsage ||
    pod.usage?.cpu ||
    pod.metrics?.cpu;

  if (directCpu) {
    return parseCpuToMillicores(String(directCpu).toLowerCase());
  }

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
// Same idea as extractCpuMillicoresFromMetric, but for memory.
// Returns memory usage as a plain number in Mebibytes (Mi).
// =============================================================================
function extractMemoryMiFromMetric(pod: any): number {
  const directMemory =
    pod.memory ||
    pod.memoryUsage ||
    pod.usage?.memory ||
    pod.metrics?.memory;

  if (directMemory) {
    return parseMemoryToMi(String(directMemory).toLowerCase());
  }

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
// Converts a Kubernetes CPU string into a plain number in millicores.
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
    const value = Number(cpu.replace("n", ""));
    return Number.isNaN(value) ? 0 : value / 1_000_000;
  }

  if (cpu.endsWith("m")) {
    return Number(cpu.replace("m", "")) || 0;
  }

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
// Converts a Kubernetes memory string into a plain number in Mebibytes.
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
    const value = Number(memory.replace("gi", ""));
    return Number.isNaN(value) ? 0 : value * 1024;
  }

  if (memory.endsWith("mi")) {
    const value = Number(memory.replace("mi", ""));
    return Number.isNaN(value) ? 0 : value;
  }

  if (memory.endsWith("ki")) {
    const value = Number(memory.replace("ki", ""));
    return Number.isNaN(value) ? 0 : value / 1024;
  }

  const raw = Number(memory);
  return Number.isNaN(raw) ? 0 : raw / (1024 * 1024);
}


// =============================================================================
// round1  (private helper)
// =============================================================================
// Rounds a number to one decimal place. Used only when exporting raw
// percentile values to the result so the JSON output stays readable.
// =============================================================================
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}