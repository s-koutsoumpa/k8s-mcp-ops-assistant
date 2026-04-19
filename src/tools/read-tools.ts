// =============================================================================
// read-tools.ts
// =============================================================================
//
// WHAT IS THIS FILE?
// ------------------
// This file contains all the READ-ONLY functions that inspect the Kubernetes
// cluster without changing anything.
//
// Think of these as the "eyes" of the system: they look at what is running,
// how healthy it is, and what events have happened — but they never touch
// the cluster configuration.
//
// WHERE IS IT USED?
// -----------------
// Imported by src/server.ts, which registers each function here as an MCP
// tool so the AI agent (via n8n) can call them by name.
//
// For example, when the agent calls the "list_deployments" MCP tool, server.ts
// calls listDeployments() from this file.
//
// HOW IT FITS WITH THE REST OF THE SYSTEM
// ----------------------------------------
// The read/write split is intentional and important:
//
//   read-tools.ts   ← this file: safe, read-only, no side effects
//   action-tools.ts ← write operations that change the cluster
//   action-policy.ts ← safety guard that runs before any write
//
// The AI agent typically calls read tools FIRST to understand the problem
// (e.g. "what's the state of this deployment?"), then calls analysis tools
// to diagnose it, and FINALLY calls execute_action to fix it.
//
// ALL functions in this file are async because every Kubernetes API call
// goes over the network and takes time to complete.
// =============================================================================

import { appsV1, coreV1, customObjects } from "../k8s/client";


// =============================================================================
// 1. listDeployments
// =============================================================================
//
// WHAT IT DOES:
//   Returns a summary list of all deployments in a given namespace, showing
//   how many replicas are desired vs. how many are actually ready.
//
// WHEN TO USE IT:
//   Use this as a first overview step to see what is deployed and whether
//   any deployment has fewer ready replicas than expected.
//   Equivalent to: kubectl get deployments -n <namespace>
//
// HOW IT WORKS:
//   STEP 1: Ask Kubernetes for all deployments in the namespace.
//   STEP 2: Map each deployment to a small summary object so we don't
//           return the huge raw Kubernetes object (which has 100+ fields).
// =============================================================================
export async function listDeployments(namespace: string) {

  // STEP 1: Fetch all deployments in this namespace from the Kubernetes API.
  const res = await appsV1.listNamespacedDeployment(namespace);

  // STEP 2: Transform the raw list into compact summaries.
  // The "?." (optional chaining) means: if the left side is null or undefined,
  // return undefined instead of throwing an error.
  // The "??" (nullish coalescing) means: if the left side is null/undefined,
  // use the right side as the default value instead.
  return res.body.items.map((d) => ({
    name: d.metadata?.name,
    namespace: d.metadata?.namespace,
    replicas: d.spec?.replicas ?? 0,
    readyReplicas: d.status?.readyReplicas ?? 0,
    availableReplicas: d.status?.availableReplicas ?? 0,
  }));
}


// =============================================================================
// 2. inspectDeployment
// =============================================================================
//
// WHAT IT DOES:
//   Returns a detailed summary of a single deployment: its replica counts,
//   labels, selector labels, and the list of containers with their images.
//
// WHEN TO USE IT:
//   When you already know the deployment name and need more detail than
//   listDeployments provides. For example, to see which image is running
//   or what labels the deployment uses to find its pods.
//   Equivalent to: kubectl describe deployment <name> -n <namespace>
//
// HOW IT WORKS:
//   STEP 1: Fetch the specific deployment from Kubernetes.
//   STEP 2: Extract and return the fields the agent needs most.
// =============================================================================
export async function inspectDeployment(name: string, namespace: string) {

  // STEP 1: Fetch the named deployment.
  const res = await appsV1.readNamespacedDeployment(name, namespace);
  const d = res.body;

  // STEP 2: Return only the useful fields (not the raw 100-field object).
  // The "?? {}" and "?? []" patterns mean: if the value is missing, use an
  // empty object or empty array as the default so callers always get a value.
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


// =============================================================================
// 3. inspectPods
// =============================================================================
//
// WHAT IT DOES:
//   Returns a summary of every pod in a namespace, including its phase
//   (Running / Pending / Failed), restart count, and readiness status.
//
// WHEN TO USE IT:
//   To check the health of individual pods. Useful for spotting pods that
//   are stuck in Pending or CrashLoopBackOff, or have a high restart count.
//   Equivalent to: kubectl get pods -n <namespace>
//
// HOW IT WORKS:
//   STEP 1: Fetch all pods in the namespace.
//   STEP 2: For each pod, sum up restarts across all containers and check
//           whether every container reports itself as ready.
// =============================================================================
export async function inspectPods(namespace: string) {

  // STEP 1: Fetch all pods in this namespace.
  const res = await coreV1.listNamespacedPod(namespace);

  // STEP 2: For each pod, compute totals and return a compact summary.
  return res.body.items.map((p) => ({
    name: p.metadata?.name,
    namespace: p.metadata?.namespace,
    phase: p.status?.phase,
    nodeName: p.spec?.nodeName,
    podIP: p.status?.podIP,

    // Sum restart counts across all containers in this pod.
    // reduce() starts at 0 and adds each container's restartCount.
    restarts:
      p.status?.containerStatuses?.reduce(
        (sum, c) => sum + (c.restartCount || 0),
        0
      ) ?? 0,

    // A pod is "ready" only if EVERY container in it reports ready === true.
    // every() returns true only when the callback is true for all items.
    ready:
      p.status?.containerStatuses?.every((c) => c.ready === true) ?? false,
  }));
}


// =============================================================================
// 4. inspectEvents
// =============================================================================
//
// WHAT IT DOES:
//   Returns the recent Kubernetes events for a namespace — things like
//   "ImagePullBackOff", "FailedScheduling", or "Liveness probe failed".
//
// WHEN TO USE IT:
//   When you need to understand WHY something is failing. Events are the
//   closest thing Kubernetes has to a log of what went wrong and when.
//   Equivalent to: kubectl get events -n <namespace>
//
// HOW IT WORKS:
//   STEP 1: Fetch all events in the namespace.
//   STEP 2: Return a compact summary of each event, including a timestamp.
//           We try three different timestamp fields because different event
//           types populate different ones.
// =============================================================================
export async function inspectEvents(namespace: string) {

  // STEP 1: Fetch all events in this namespace.
  const res = await coreV1.listNamespacedEvent(namespace);

  // STEP 2: Map each event to a compact summary object.
  return res.body.items.map((e) => ({
    type: e.type,                        // "Normal" or "Warning"
    reason: e.reason,                    // short machine-readable label, e.g. "BackOff"
    message: e.message,                  // human-readable explanation
    involvedObject: e.involvedObject?.name,
    kind: e.involvedObject?.kind,        // e.g. "Pod", "Deployment"

    // Kubernetes events can store their timestamp in three different fields
    // depending on which event type was used. We try each in order and
    // fall back to null if none are set.
    timestamp:
      e.lastTimestamp ||
      e.eventTime ||
      e.metadata?.creationTimestamp ||
      null,
  }));
}


// =============================================================================
// 5. listNamespaces
// =============================================================================
//
// WHAT IT DOES:
//   Returns the names and statuses of all namespaces in the cluster.
//
// WHEN TO USE IT:
//   When you need to discover which namespaces exist before calling other
//   tools with a namespace parameter.
//   Equivalent to: kubectl get namespaces
//
// HOW IT WORKS:
//   STEP 1: Fetch all namespaces from the Kubernetes core API.
//   STEP 2: Return a compact list of names and their phase status.
// =============================================================================
export async function listNamespaces() {

  // STEP 1: Fetch all namespaces cluster-wide.
  const res = await coreV1.listNamespace();

  // STEP 2: Return just the name and status for each namespace.
  return res.body.items.map((ns) => ({
    name: ns.metadata?.name,
    status: ns.status?.phase,
  }));
}


// =============================================================================
// 6. getPodMetrics
// =============================================================================
//
// WHAT IT DOES:
//   Returns the live CPU and memory usage for every pod in a namespace,
//   broken down by container.
//
// WHEN TO USE IT:
//   When you need to see actual resource usage (not just what was requested).
//   This is the data that feeds into analyze_resources.
//   Requires the Kubernetes metrics-server to be installed in the cluster.
//   Equivalent to: kubectl top pods -n <namespace>
//
// HOW IT WORKS:
//   STEP 1: Query the metrics.k8s.io API via the customObjects client,
//           because pod metrics are a custom resource (not a built-in type).
//   STEP 2: Return the per-container CPU and memory usage for each pod.
// =============================================================================
export async function getPodMetrics(namespace: string) {

  // STEP 1: Fetch pod metrics.
  // We use customObjects (not coreV1 or appsV1) because metrics are provided
  // by a separate metrics-server extension, not the core Kubernetes API.
  // The four arguments are: group, version, namespace, plural (resource type).
  const res = await customObjects.listNamespacedCustomObject(
    "metrics.k8s.io",
    "v1beta1",
    namespace,
    "pods"
  );

  // The customObjects API returns an untyped body, so we cast it to `any`
  // to access its fields without TypeScript complaining.
  const body = res.body as any;
  const items = body.items ?? [];

  // STEP 2: Return per-container usage for each pod.
  return items.map((pod: any) => ({
    name: pod.metadata?.name,
    containers: (pod.containers ?? []).map((c: any) => ({
      name: c.name,
      cpu: c.usage?.cpu,       // e.g. "23m" (23 millicores)
      memory: c.usage?.memory, // e.g. "45Mi" (45 Mebibytes)
    })),
  }));
}


// =============================================================================
// 7. getPodLogs
// =============================================================================
//
// WHAT IT DOES:
//   Fetches the last 200 lines of logs from a pod (and optionally a specific
//   container inside that pod).
//
// WHEN TO USE IT:
//   When a pod is crashing or behaving unexpectedly and you need to see its
//   output to understand why. This is the last resort — try analyze_deployment
//   first, since logs are often noisy and hard to parse automatically.
//   Equivalent to: kubectl logs <pod> -n <namespace> [--container <c>] --tail 200
//
// HOW IT WORKS:
//   STEP 1: Call the Kubernetes pod log API with positional parameters.
//           Most parameters are undefined because we only need the last 200 lines.
//   STEP 2: Return the raw log text along with identifying metadata.
// =============================================================================
export async function getPodLogs(
  podName: string,
  namespace: string,
  container?: string    // optional: only needed when a pod has multiple containers
) {

  // STEP 1: Fetch the last 200 lines of logs.
  // The Kubernetes client library uses positional parameters.
  // We pass "undefined" for the 9 parameters we don't care about, and 200
  // as the last argument (tailLines) to limit the output.
  const res = await coreV1.readNamespacedPodLog(
    podName,    // which pod
    namespace,  // which namespace
    container,  // which container (undefined = the only/default container)
    undefined,  // follow: stream in real time? No.
    undefined,  // insecureSkipTLSVerifyBackend
    undefined,  // limitBytes
    undefined,  // pretty
    undefined,  // previous (get logs from the previous crashed container)
    undefined,  // sinceSeconds
    200         // tailLines: only the last 200 lines
  );

  // STEP 2: Return the log text along with context about where it came from.
  return {
    podName,
    namespace,
    container: container || null,
    logs: res.body,
  };
}


// =============================================================================
// 8. inspectProbes
// =============================================================================
//
// WHAT IT DOES:
//   Returns the current probe configuration (readiness, liveness, startup)
//   for every container in a deployment.
//
// WHEN TO USE IT:
//   Before running analyze_probes, or when you want to see the raw probe
//   settings without the analysis layer on top.
//   Equivalent to reading the "containers[*].livenessProbe" etc. fields from
//   `kubectl get deployment <name> -o yaml`
//
// HOW IT WORKS:
//   STEP 1: Fetch the deployment.
//   STEP 2: For each container, return the probe objects, or null if missing.
//           We use the helper getProbeType() to label the probe style
//           (http / tcp / exec / grpc).
// =============================================================================
export async function inspectProbes(name: string, namespace: string) {

  // STEP 1: Fetch the deployment.
  const res = await appsV1.readNamespacedDeployment(name, namespace);
  const d = res.body;

  const containers = d.spec?.template?.spec?.containers ?? [];

  // STEP 2: For each container, return all three probes (or null if absent).
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


// =============================================================================
// getProbeType  (private helper — not exported)
// =============================================================================
//
// WHAT IT DOES:
//   Looks at a probe object and returns a short string describing how the
//   probe checks health: "http", "tcp", "exec", "grpc", or "unknown".
//
// WHEN TO USE IT:
//   Only called internally by inspectProbes() to label each probe's style.
//
// HOW IT WORKS:
//   A Kubernetes probe uses exactly ONE of four possible check mechanisms.
//   We check which field is set and return the matching label.
// =============================================================================
function getProbeType(probe: any): string {
  if (probe.httpGet)   return "http";   // checks an HTTP endpoint
  if (probe.tcpSocket) return "tcp";    // opens a TCP socket
  if (probe.exec)      return "exec";   // runs a command inside the container
  if (probe.grpc)      return "grpc";   // calls a gRPC health service
  return "unknown";
}
