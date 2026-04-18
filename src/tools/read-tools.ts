// READ-ONLY TOOLS
// These functions only inspect the cluster.
// They do not change anything.

import { appsV1, coreV1, customObjects } from "../k8s/client";

export async function listDeployments(namespace: string) {
  const res = await appsV1.listNamespacedDeployment(namespace);

  return res.body.items.map((d) => ({
    name: d.metadata?.name,
    namespace: d.metadata?.namespace,
    replicas: d.spec?.replicas ?? 0,
    readyReplicas: d.status?.readyReplicas ?? 0,
    availableReplicas: d.status?.availableReplicas ?? 0,
  }));
}

export async function inspectDeployment(name: string, namespace: string) {
  const res = await appsV1.readNamespacedDeployment(name, namespace);
  const d = res.body;

  return {
    name: d.metadata?.name,
    namespace: d.metadata?.namespace,
    replicas: d.spec?.replicas ?? 0,
    readyReplicas: d.status?.readyReplicas ?? 0,
    availableReplicas: d.status?.availableReplicas ?? 0,
    labels: d.metadata?.labels ?? {},
    selector: d.spec?.selector?.matchLabels ?? {},
    containers:
      d.spec?.template?.spec?.containers?.map((c) => ({
        name: c.name,
        image: c.image,
      })) ?? [],
  };
}

export async function inspectPods(namespace: string) {
  const res = await coreV1.listNamespacedPod(namespace);

  return res.body.items.map((p) => ({
    name: p.metadata?.name,
    namespace: p.metadata?.namespace,
    phase: p.status?.phase,
    nodeName: p.spec?.nodeName,
    podIP: p.status?.podIP,
    restarts:
      p.status?.containerStatuses?.reduce(
        (sum, c) => sum + (c.restartCount || 0),
        0
      ) ?? 0,
    ready:
      p.status?.containerStatuses?.every((c) => c.ready === true) ?? false,
  }));
}

export async function inspectEvents(namespace: string) {
  const res = await coreV1.listNamespacedEvent(namespace);

  return res.body.items.map((e) => ({
    type: e.type,
    reason: e.reason,
    message: e.message,
    involvedObject: e.involvedObject?.name,
    kind: e.involvedObject?.kind,
    timestamp:
      e.lastTimestamp ||
      e.eventTime ||
      e.metadata?.creationTimestamp ||
      null,
  }));
}

export async function listNamespaces() {
  const res = await coreV1.listNamespace();

  return res.body.items.map((ns) => ({
    name: ns.metadata?.name,
    status: ns.status?.phase,
  }));
}

export async function getPodMetrics(namespace: string) {
  const res = await customObjects.listNamespacedCustomObject(
    "metrics.k8s.io",
    "v1beta1",
    namespace,
    "pods"
  );

  const body = res.body as any;
  const items = body.items ?? [];

  return items.map((pod: any) => ({
    name: pod.metadata?.name,
    containers: (pod.containers ?? []).map((c: any) => ({
      name: c.name,
      cpu: c.usage?.cpu,
      memory: c.usage?.memory,
    })),
  }));
}

export async function getPodLogs(
  podName: string,
  namespace: string,
  container?: string
) {
  const res = await coreV1.readNamespacedPodLog(
    podName,
    namespace,
    container,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    200
  );

  return {
    podName,
    namespace,
    container: container || null,
    logs: res.body,
  };
}

export async function inspectProbes(name: string, namespace: string) {
  const res = await appsV1.readNamespacedDeployment(name, namespace);
  const d = res.body;

  const containers = d.spec?.template?.spec?.containers ?? [];

  return containers.map((c) => ({
    container: c.name,
    image: c.image,
    livenessProbe: c.livenessProbe
      ? {
          type: getProbeType(c.livenessProbe),
          initialDelaySeconds: c.livenessProbe.initialDelaySeconds ?? null,
          periodSeconds: c.livenessProbe.periodSeconds ?? null,
          timeoutSeconds: c.livenessProbe.timeoutSeconds ?? null,
          successThreshold: c.livenessProbe.successThreshold ?? null,
          failureThreshold: c.livenessProbe.failureThreshold ?? null,
        }
      : null,
    readinessProbe: c.readinessProbe
      ? {
          type: getProbeType(c.readinessProbe),
          initialDelaySeconds: c.readinessProbe.initialDelaySeconds ?? null,
          periodSeconds: c.readinessProbe.periodSeconds ?? null,
          timeoutSeconds: c.readinessProbe.timeoutSeconds ?? null,
          successThreshold: c.readinessProbe.successThreshold ?? null,
          failureThreshold: c.readinessProbe.failureThreshold ?? null,
        }
      : null,
    startupProbe: c.startupProbe
      ? {
          type: getProbeType(c.startupProbe),
          initialDelaySeconds: c.startupProbe.initialDelaySeconds ?? null,
          periodSeconds: c.startupProbe.periodSeconds ?? null,
          timeoutSeconds: c.startupProbe.timeoutSeconds ?? null,
          successThreshold: c.startupProbe.successThreshold ?? null,
          failureThreshold: c.startupProbe.failureThreshold ?? null,
        }
      : null,
  }));
}

function getProbeType(probe: any): string {
  if (probe.httpGet) return "http";
  if (probe.tcpSocket) return "tcp";
  if (probe.exec) return "exec";
  if (probe.grpc) return "grpc";
  return "unknown";
}