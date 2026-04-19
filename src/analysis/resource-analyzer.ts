// RESOURCE ANALYZER
// This file analyzes pod metrics and suggests a resource profile.

type ResourceProfile =
  | "balanced"
  | "cpu_pressure"
  | "memory_pressure"
  | "underprovisioned";

export function analyzeResources(input: {
  deploymentName: string;
  namespace: string;
  podMetrics: any[];
}) {
  const { deploymentName, namespace, podMetrics } = input;

  const findings: any[] = [];

  // Keep only metrics that likely belong to this deployment
  const relevantMetrics = filterMetricsForDeployment(deploymentName, podMetrics);

  // Run profile-based resource tuning logic
  const smartTuning = suggestSmartResources({
    deploymentName,
    podMetrics: relevantMetrics,
  });

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

export function suggestSmartResources(params: {
  deploymentName: string;
  podMetrics: any[];
}) {
  const { podMetrics } = params;

  const findings: string[] = [];
  const rationale: string[] = [];

  const resourceSignals = summarizeResourceSignals(podMetrics);
  const profile = selectResourceProfile(resourceSignals);

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

  if (resourceSignals.highCpuPods > 0) {
    findings.push(
      `${resourceSignals.highCpuPods} pod(s) show elevated CPU usage.`
    );
  }

  if (resourceSignals.highMemoryPods > 0) {
    findings.push(
      `${resourceSignals.highMemoryPods} pod(s) show elevated memory usage.`
    );
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

  return {
    findings,
    rationale,
    selectedProfile: profile,
    suggestedResources: buildResourcesFromProfile(profile),
  };
}

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

  return {
    highCpuPods,
    highMemoryPods,
    maxCpuMillicores,
    maxMemoryMi,
  };
}

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

function buildResourcesFromProfile(profile: ResourceProfile) {
  if (profile === "balanced") {
    return {
      requests: {
        cpu: "100m",
        memory: "128Mi",
      },
      limits: {
        cpu: "250m",
        memory: "256Mi",
      },
    };
  }

  if (profile === "cpu_pressure") {
    return {
      requests: {
        cpu: "250m",
        memory: "128Mi",
      },
      limits: {
        cpu: "500m",
        memory: "256Mi",
      },
    };
  }

  if (profile === "memory_pressure") {
    return {
      requests: {
        cpu: "100m",
        memory: "256Mi",
      },
      limits: {
        cpu: "250m",
        memory: "512Mi",
      },
    };
  }

  return {
    requests: {
      cpu: "250m",
      memory: "256Mi",
    },
    limits: {
      cpu: "500m",
      memory: "512Mi",
    },
  };
}

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