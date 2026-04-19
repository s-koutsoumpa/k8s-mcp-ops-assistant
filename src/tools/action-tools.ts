// =============================================================================
// action-tools.ts
// =============================================================================
//
// WHAT IS THIS FILE?
// ------------------
// This file contains the functions that CHANGE things in Kubernetes.
// Think of these as "write actions": restart a deployment, scale it up,
// change its image, update its probes, update its CPU/memory, or roll it back.
//
// Each function here talks to the Kubernetes API using the official
// Kubernetes JavaScript client. We give it a command, it talks to the
// cluster, and it comes back with a result.
//
// IMPORTANT SAFETY RULE:
// ----------------------
// The functions in this file do NOT check if an action is safe or allowed.
// That is the job of action-policy.ts (which runs BEFORE these functions).
// By the time any function here runs, two things have already happened:
//   1. action-policy.ts has checked that the action is allowed
//   2. The user has said "yes" in the n8n chat
//
// So this file can focus on ONE thing: doing the action correctly.
//
// COMMON PATTERN YOU WILL SEE:
// ----------------------------
// Most functions follow the same 3-step pattern:
//   1. READ the current deployment from the cluster
//   2. MODIFY it in memory (change the image, change the replicas, etc.)
//   3. WRITE the modified version back to the cluster
//
// Kubernetes then sees the new version and automatically applies the change
// (usually by starting new pods and stopping the old ones).
// =============================================================================

// We import the Kubernetes "apps" API client.
// "appsV1" is the part of the Kubernetes API that deals with deployments.
// (There are other parts, like "coreV1" for pods and "batchV1" for jobs.)
import { appsV1 } from "../k8s/client";


// =============================================================================
// 1. restartDeployment
// =============================================================================
//
// WHAT IT DOES:
//   Restarts every pod in a deployment, one at a time, without changing
//   anything about the deployment's configuration.
//
// WHEN TO USE IT:
//   When a deployment is in a weird state and you just want fresh pods.
//   This is the same as running `kubectl rollout restart deployment/<n>`.
//
// HOW IT WORKS (the tricky part):
//   Kubernetes does not have a direct "restart" API. So we cheat.
//   We add a small label (called an "annotation") to the deployment
//   with the current time. Kubernetes notices that the deployment has
//   "changed" (even though nothing meaningful changed) and automatically
//   rolls out new pods to replace the old ones.
// =============================================================================
export async function restartDeployment(name: string, namespace: string) {

  // STEP 1: Read the current deployment from Kubernetes.
  // This gives us the full object describing the deployment.
  const response = await appsV1.readNamespacedDeployment(name, namespace);
  const deployment = response.body;

  // STEP 2: Make sure the annotations object exists.
  // Deployments have a "template" that describes the pods they create.
  // We need to add an annotation to that template's metadata.
  // If any of these sub-objects don't exist yet, we create empty ones.
  if (!deployment.spec) {
    throw new Error(`Deployment ${name} has no spec — cannot restart.`);
  }
  if (!deployment.spec.template.metadata) {
    deployment.spec.template.metadata = {};
  }
  if (!deployment.spec.template.metadata.annotations) {
    deployment.spec.template.metadata.annotations = {};
  }

  // STEP 3: Add (or update) the "restartedAt" annotation with the current time.
  // This tiny change is what triggers the rolling restart.
  deployment.spec.template.metadata.annotations["kubectl.kubernetes.io/restartedAt"] =
    new Date().toISOString();

  // STEP 4: Send the updated deployment back to Kubernetes.
  await appsV1.replaceNamespacedDeployment(name, namespace, deployment);

  // STEP 5: Return a simple result object so the agent can report back.
  return {
    status: "restarted",
    name: name,
    namespace: namespace,
  };
}


// =============================================================================
// 2. scaleDeployment
// =============================================================================
//
// WHAT IT DOES:
//   Changes the number of pods that should be running for this deployment.
//
// WHEN TO USE IT:
//   When you want more pods (to handle more traffic) or fewer pods
//   (to save resources). Same as `kubectl scale deployment/<n> --replicas=N`.
//
// SAFETY NOTE:
//   action-policy.ts already checked that N is between 0 and 10 before
//   we get here, so we don't need to re-check.
// =============================================================================
export async function scaleDeployment(
  name: string,
  namespace: string,
  replicas: number
) {

  // STEP 1: Read the current deployment.
  const response = await appsV1.readNamespacedDeployment(name, namespace);
  const deployment = response.body;

  // STEP 2: Safety check — the deployment must have a spec.
  if (!deployment.spec) {
    throw new Error(`Deployment ${name} has no spec — cannot scale.`);
  }

  // STEP 3: Change the replica count to the new value.
  deployment.spec.replicas = replicas;

  // STEP 4: Send the updated deployment back to Kubernetes.
  await appsV1.replaceNamespacedDeployment(name, namespace, deployment);

  // STEP 5: Return a simple result.
  return {
    status: "scaled",
    name: name,
    namespace: namespace,
    replicas: replicas,
  };
}


// =============================================================================
// 3. updateDeploymentImage
// =============================================================================
//
// WHAT IT DOES:
//   Changes the container image for a specific container in a deployment.
//
// WHEN TO USE IT:
//   The main fix for ImagePullBackOff or ErrImagePull errors (when Kubernetes
//   can't find the image). Same as `kubectl set image deployment/<n> <container>=<newImage>`.
//
// WHY WE NEED containerName:
//   A single pod can have multiple containers. We need to know which
//   container to update. Most deployments have only one container, and
//   its name usually matches the deployment name.
// =============================================================================
export async function updateDeploymentImage(
  name: string,
  namespace: string,
  containerName: string,
  newImage: string
) {

  // STEP 1: Read the current deployment.
  const response = await appsV1.readNamespacedDeployment(name, namespace);
  const deployment = response.body;

  // STEP 2: Get the list of containers inside the deployment's pod template.
  // If anything is missing, treat it as an empty list.
  const containers = deployment.spec?.template?.spec?.containers ?? [];

  // STEP 3: Find the container with the name the user asked for.
  const targetContainer = containers.find((c) => c.name === containerName);

  // If we can't find it, tell the user which containers DO exist
  // so they can figure out the right name.
  if (!targetContainer) {
    const availableNames = containers.map((c) => c.name).join(", ");
    throw new Error(
      `Container "${containerName}" not found in deployment "${name}". ` +
      `Available containers: ${availableNames}`
    );
  }

  // STEP 4: Change the image for that container.
  targetContainer.image = newImage;

  // STEP 5: Send the updated deployment back to Kubernetes.
  // Kubernetes will automatically start new pods with the new image and
  // shut down the old ones.
  await appsV1.replaceNamespacedDeployment(name, namespace, deployment);

  // STEP 6: Return a simple result.
  return {
    status: "image_updated",
    name: name,
    namespace: namespace,
    containerName: containerName,
    newImage: newImage,
  };
}


// =============================================================================
// 4. patchDeploymentResources
// =============================================================================
//
// WHAT IT DOES:
//   Changes the CPU and memory settings for a specific container.
//
// WHEN TO USE IT:
//   - When a container is being CPU-throttled (needs more CPU).
//   - When a container keeps getting OOMKilled (needs more memory).
//   - When a container is using way less than it asks for (can shrink).
//
// UNDERSTANDING CPU AND MEMORY UNITS IN KUBERNETES:
//   CPU:    "500m" means 500 millicores = 0.5 of one CPU core
//           "1"    means 1 full CPU core
//           "2"    means 2 full CPU cores
//   Memory: "128Mi" means 128 Mebibytes
//           "1Gi"   means 1 Gibibyte
//
// REQUESTS vs LIMITS:
//   - "requests" = the minimum the container needs (Kubernetes reserves this).
//   - "limits"   = the maximum the container is allowed to use.
//   Pods that exceed their memory limit get OOMKilled.
//   Pods that exceed their CPU limit get throttled (slowed down).
// =============================================================================
export async function patchDeploymentResources(
  name: string,
  namespace: string,
  containerName: string,
  resources: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  }
) {

  // STEP 1: Read the current deployment.
  const response = await appsV1.readNamespacedDeployment(name, namespace);
  const deployment = response.body;

  // STEP 2: Find the target container (same as updateDeploymentImage).
  const containers = deployment.spec?.template?.spec?.containers ?? [];
  const targetContainer = containers.find((c) => c.name === containerName);

  if (!targetContainer) {
    const availableNames = containers.map((c) => c.name).join(", ");
    throw new Error(
      `Container "${containerName}" not found in deployment "${name}". ` +
      `Available containers: ${availableNames}`
    );
  }

  // STEP 3: Merge the new resource settings into the existing ones.
  //
  // If the container already has resource settings, we want to keep the
  // parts the user didn't provide. For example, if the user only provides
  // new memory limits, we keep the existing CPU settings.
  //
  // The "..." spread syntax copies all fields from one object into another.
  // The later one wins, so new values overwrite old ones.
  targetContainer.resources = {
    ...(targetContainer.resources || {}),   // keep existing values first
    ...(resources || {}),                   // then overwrite with new values
  };

  // STEP 4: Send the updated deployment back to Kubernetes.
  await appsV1.replaceNamespacedDeployment(name, namespace, deployment);

  // STEP 5: Return a simple result.
  return {
    status: "resources_patched",
    name: name,
    namespace: namespace,
    containerName: containerName,
    resources: resources,
  };
}


// =============================================================================
// 5. patchDeploymentProbes
// =============================================================================
//
// WHAT IT DOES:
//   Changes the health check settings (probes) for a container.
//
// WHAT ARE PROBES?
//   Probes are small health checks that Kubernetes runs on each container.
//   There are three kinds:
//
//   - livenessProbe:  "Is the container still alive?"
//                     If it fails, Kubernetes KILLS and RESTARTS the container.
//
//   - readinessProbe: "Is the container ready to serve traffic?"
//                     If it fails, Kubernetes removes the pod from
//                     load-balancing but does NOT restart it.
//
//   - startupProbe:   "Has the container finished starting up?"
//                     Gives slow-starting containers extra time to boot
//                     before the other probes start checking.
//
// WHEN TO USE IT:
//   When probes are badly configured (too aggressive, wrong timing, or missing).
//   The analysis in probe-analyzer.ts figures out what the new values should be.
//   This function just applies them.
//
// PARTIAL UPDATES:
//   If the caller only provides a readinessProbe (and no livenessProbe or
//   startupProbe), we only update the readinessProbe. The others stay as they were.
// =============================================================================
export async function patchDeploymentProbes(
  name: string,
  namespace: string,
  containerName: string,
  probeConfig: {
    livenessProbe?: any;
    readinessProbe?: any;
    startupProbe?: any;
  }
) {

  // STEP 1: Read the current deployment.
  const response = await appsV1.readNamespacedDeployment(name, namespace);
  const deployment = response.body;

  // STEP 2: Find the target container.
  const containers = deployment.spec?.template?.spec?.containers ?? [];
  const targetContainer = containers.find((c) => c.name === containerName);

  if (!targetContainer) {
    const availableNames = containers.map((c) => c.name).join(", ");
    throw new Error(
      `Container "${containerName}" not found in deployment "${name}". ` +
      `Available containers: ${availableNames}`
    );
  }

  // STEP 3: Apply only the probes that were provided.
  //
  // We check each probe separately because the caller might only want to
  // change one of them. If they pass "livenessProbe" in probeConfig, we
  // apply it. If they don't pass it, we leave the existing one alone.
  if (probeConfig.livenessProbe !== undefined) {
    targetContainer.livenessProbe = probeConfig.livenessProbe;
  }

  if (probeConfig.readinessProbe !== undefined) {
    targetContainer.readinessProbe = probeConfig.readinessProbe;
  }

  if (probeConfig.startupProbe !== undefined) {
    targetContainer.startupProbe = probeConfig.startupProbe;
  }

  // STEP 4: Send the updated deployment back to Kubernetes.
  await appsV1.replaceNamespacedDeployment(name, namespace, deployment);

  // STEP 5: Return a result that tells the agent which probes were updated.
  return {
    status: "probes_patched",
    name: name,
    namespace: namespace,
    containerName: containerName,
    updatedProbes: {
      liveness: probeConfig.livenessProbe !== undefined,
      readiness: probeConfig.readinessProbe !== undefined,
      startup: probeConfig.startupProbe !== undefined,
    },
  };
}


// =============================================================================
// 6. rollbackDeployment
// =============================================================================
//
// WHAT IT DOES:
//   Goes back to the previous version of a deployment.
//   Same as `kubectl rollout undo deployment/<n>`.
//
// WHEN TO USE IT:
//   When a recent update broke the deployment and you want to undo it.
//
// HOW KUBERNETES TRACKS VERSIONS (this is the key concept):
//
//   Every time you update a deployment, Kubernetes creates a new "ReplicaSet"
//   (basically a snapshot of that version's pod configuration). It gives each
//   ReplicaSet a number called a "revision".
//
//   Example timeline:
//     Revision 1: nginx:1.20  ← the first deployment
//     Revision 2: nginx:1.21  ← someone updated the image
//     Revision 3: nginx:1.22  ← someone updated it again (current)
//
//   Kubernetes keeps the old ReplicaSets around (up to 10 by default) so
//   rollback is possible. To roll back from revision 3 to revision 2, we:
//     1. Find the ReplicaSet for revision 2
//     2. Copy its pod template onto the deployment
//     3. Kubernetes notices the change and rolls back automatically
//
// LIMITATIONS TO KNOW:
//   - We can only go back ONE step (from revision N to revision N-1).
//   - If the previous ReplicaSet was deleted (Kubernetes keeps only 10
//     by default), rollback will fail.
//   - If you're already at revision 1, there's nothing to go back to.
// =============================================================================
export async function rollbackDeployment(name: string, namespace: string) {

  // ----- STEP 1: Find out what revision we're currently on -----

  // Read the deployment.
  const deploymentResponse = await appsV1.readNamespacedDeployment(name, namespace);
  const deployment = deploymentResponse.body;

  // The current revision is stored in an annotation on the deployment.
  // It's a string, so we convert it to a number. If it's missing, use 0.
  const currentRevisionString =
    deployment.metadata?.annotations?.["deployment.kubernetes.io/revision"] ?? "0";
  const currentRevision = parseInt(currentRevisionString, 10);

  // ----- STEP 2: Check that rollback is actually possible -----

  // If we're on revision 1 (or 0, which shouldn't normally happen),
  // there's no previous revision to go back to.
  if (currentRevision <= 1) {
    throw new Error(
      `Cannot rollback deployment "${name}": it is at revision ${currentRevision}, ` +
      `which means there is no previous version to roll back to. ` +
      `If you want to change the image, use update_image instead.`
    );
  }

  // The target is the revision just before the current one.
  const targetRevision = currentRevision - 1;

  // ----- STEP 3: Build a label selector to find this deployment's ReplicaSets -----

  // A deployment "owns" its ReplicaSets through matching labels. For example,
  // if the deployment selects pods with label "app=nginx", then all of its
  // ReplicaSets also have label "app=nginx".
  //
  // We need to build a selector string like "app=nginx,tier=frontend" from
  // the deployment's matchLabels object.
  const matchLabels = deployment.spec?.selector?.matchLabels ?? {};

  const selectorParts: string[] = [];
  for (const [labelKey, labelValue] of Object.entries(matchLabels)) {
    selectorParts.push(`${labelKey}=${labelValue}`);
  }
  const labelSelector = selectorParts.join(",");

  // ----- STEP 4: Get all ReplicaSets that belong to this deployment -----

  // The Kubernetes client library requires us to pass positional arguments.
  // We only care about the namespace (1st arg) and labelSelector (6th arg),
  // but TypeScript needs us to pass "undefined" for the arguments in between.
  const replicaSetsResponse = await appsV1.listNamespacedReplicaSet(
    namespace,      // which namespace to look in
    undefined,      // pretty-print output: we don't need this
    undefined,      // allowWatchBookmarks: we don't need this
    undefined,      // continue token: we don't need this
    undefined,      // fieldSelector: we don't need this
    labelSelector   // labelSelector: THIS is what we actually need
  );

  const allReplicaSets = replicaSetsResponse.body.items;

  // ----- STEP 5: Find the ReplicaSet for the previous revision -----

  // Each ReplicaSet has the same "deployment.kubernetes.io/revision" annotation
  // that the deployment has. We look for the one matching our target revision.
  let previousReplicaSet = undefined;

  for (const rs of allReplicaSets) {
    const rsRevision = rs.metadata?.annotations?.["deployment.kubernetes.io/revision"];
    if (rsRevision === String(targetRevision)) {
      previousReplicaSet = rs;
      break;
    }
  }

  // If we can't find it, Kubernetes must have cleaned it up already.
  if (!previousReplicaSet) {
    throw new Error(
      `Cannot rollback deployment "${name}": the ReplicaSet for revision ${targetRevision} ` +
      `no longer exists (Kubernetes probably garbage-collected it). ` +
      `If you want to change the image, use update_image instead.`
    );
  }

  // ----- STEP 6: Get the image name from the previous ReplicaSet -----

  // Useful so we can tell the user what they're rolling back to.
  const previousContainers = previousReplicaSet.spec?.template?.spec?.containers ?? [];
  const previousImage = previousContainers[0]?.image ?? "unknown";

  // ----- STEP 7: Patch the deployment with the old pod template -----

  // We send Kubernetes a partial update saying "replace my pod template
  // with this old one from the previous ReplicaSet". Kubernetes will then
  // start a rolling update back to the old configuration.
  //
  // We have to pass the Content-Type header so Kubernetes knows we're
  // sending a "merge patch" (only changes the fields we provide).

  const patchBody = {
    spec: {
      template: previousReplicaSet.spec?.template,
    },
  };

  const patchHeaders = {
    headers: { "Content-Type": "application/merge-patch+json" },
  };

  await appsV1.patchNamespacedDeployment(
    name,           // deployment name
    namespace,      // namespace
    patchBody,      // what to change
    undefined,      // pretty: not needed
    undefined,      // dryRun: not needed
    undefined,      // fieldManager: not needed
    undefined,      // fieldValidation: not needed
    undefined,      // force: not needed
    patchHeaders    // headers: REQUIRED to tell K8s this is a merge patch
  );

  // ----- STEP 8: Return a useful result -----

  return {
    status: "rolled_back",
    name: name,
    namespace: namespace,
    fromRevision: currentRevision,
    toRevision: targetRevision,
    previousImage: previousImage,
  };
}