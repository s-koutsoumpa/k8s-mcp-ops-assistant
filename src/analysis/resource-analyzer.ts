// RESOURCE ANALYZER
// This file gives simple recommendations based on pod metrics.

function cpuToMillicores(cpu: string): number {
  if (!cpu) return 0;
  if (cpu.endsWith("m")) return Number(cpu.replace("m", ""));
  return Number(cpu) * 1000;
}

function memoryToKi(memory: string): number {
  if (!memory) return 0;
  if (memory.endsWith("Ki")) return Number(memory.replace("Ki", ""));
  if (memory.endsWith("Mi")) return Number(memory.replace("Mi", "")) * 1024;
  if (memory.endsWith("Gi")) return Number(memory.replace("Gi", "")) * 1024 * 1024;
  return Number(memory);
}

export function analyzeResources(input: {
  deploymentName: string;
  namespace: string;
  podMetrics: any[];
}) {
  const { deploymentName, namespace, podMetrics } = input;

  const relatedPods = podMetrics.filter((p) =>
    String(p.name || "").startsWith(deploymentName)
  );

  let totalCpuMillicores = 0;
  let totalMemoryKi = 0;

  for (const pod of relatedPods) {
    for (const c of pod.containers || []) {
      totalCpuMillicores += cpuToMillicores(c.cpu || "0");
      totalMemoryKi += memoryToKi(c.memory || "0");
    }
  }

  let suggestion = "none";

  if (totalCpuMillicores > 500) {
    suggestion = "consider_scale_up_or_raise_cpu";
  }

  if (totalMemoryKi > 300000) {
    suggestion = "consider_raise_memory_limit";
  }

  return {
    deployment: deploymentName,
    namespace,
    totalCpuMillicores,
    totalMemoryKi,
    suggestion,
  };
}