// WRITE ACTIONS
// These functions change Kubernetes resources.
// We call them only after policy checks and user approval.

import { appsV1 } from "../k8s/client";


/*
  ACTION POLICY

  This file contains safety rules for write actions.
  All mutating actions should pass through here first.
*/

export function validateAction(action: string, params: any) {
  const namespace = params?.namespace || "default";

  if (namespace === "kube-system") {
    throw new Error("Modifications in kube-system are not allowed");
  }

  if (action === "scale") {
    const replicas = params?.replicas ?? 0;

    if (replicas < 0) {
      throw new Error("Replicas cannot be negative");
    }

    if (replicas > 10) {
      throw new Error("Replicas above 10 are not allowed");
    }
  }

  if (action === "update_image") {
    if (!params?.newImage) {
      throw new Error("newImage is required");
    }
  }

  return true;
}

export async function restartDeployment(name: string, namespace: string) {
  const res = await appsV1.readNamespacedDeployment(name, namespace);
  const deployment = res.body;

  deployment.spec = deployment.spec!;
  deployment.spec.template = deployment.spec.template!;
  deployment.spec.template.metadata = deployment.spec.template.metadata || {};
  deployment.spec.template.metadata.annotations = {
    ...(deployment.spec.template.metadata.annotations || {}),
    "kubectl.kubernetes.io/restartedAt": new Date().toISOString(),
  };

  await appsV1.replaceNamespacedDeployment(name, namespace, deployment);

  return {
    status: "restarted",
    name,
    namespace,
  };
}

export async function scaleDeployment(
  name: string,
  namespace: string,
  replicas: number
) {
  const res = await appsV1.readNamespacedDeployment(name, namespace);
  const deployment = res.body;

  if (!deployment.spec) {
    throw new Error("Deployment spec is missing");
  }

  deployment.spec.replicas = replicas;

  await appsV1.replaceNamespacedDeployment(name, namespace, deployment);

  return {
    status: "scaled",
    name,
    namespace,
    replicas,
  };
}

export async function updateDeploymentImage(
  name: string,
  namespace: string,
  containerName: string,
  newImage: string
) {
  const res = await appsV1.readNamespacedDeployment(name, namespace);
  const deployment = res.body;

  const containers = deployment.spec?.template?.spec?.containers ?? [];
  const target = containers.find((c) => c.name === containerName);

  if (!target) {
    throw new Error(`Container ${containerName} not found`);
  }

  target.image = newImage;

  await appsV1.replaceNamespacedDeployment(name, namespace, deployment);

  return {
    status: "image_updated",
    name,
    namespace,
    containerName,
    newImage,
  };
}

export async function patchDeploymentResources(
  name: string,
  namespace: string,
  containerName: string,
  resources: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  }
) {
  const res = await appsV1.readNamespacedDeployment(name, namespace);
  const deployment = res.body;

  const containers = deployment.spec?.template?.spec?.containers ?? [];
  const target = containers.find((c) => c.name === containerName);

  if (!target) {
    throw new Error(`Container ${containerName} not found`);
  }

  target.resources = {
    ...(target.resources || {}),
    ...(resources || {}),
  };

  await appsV1.replaceNamespacedDeployment(name, namespace, deployment);

  return {
    status: "resources_patched",
    name,
    namespace,
    containerName,
    resources,
  };
}

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
  const res = await appsV1.readNamespacedDeployment(name, namespace);
  const deployment = res.body;

  const containers = deployment.spec?.template?.spec?.containers ?? [];
  const target = containers.find((c) => c.name === containerName);

  if (!target) {
    throw new Error(`Container ${containerName} not found`);
  }

  if (probeConfig.livenessProbe) {
    target.livenessProbe = probeConfig.livenessProbe;
  }

  if (probeConfig.readinessProbe) {
    target.readinessProbe = probeConfig.readinessProbe;
  }

  if (probeConfig.startupProbe) {
    target.startupProbe = probeConfig.startupProbe;
  }

  await appsV1.replaceNamespacedDeployment(name, namespace, deployment);

  return {
    status: "probes_patched",
    name,
    namespace,
    containerName,
  };
}

export async function rollbackDeployment(name: string, namespace: string) {
  // This is only a starter placeholder.
  // Full rollback logic can be added later.
  return {
    status: "not_implemented_yet",
    action: "rollback",
    name,
    namespace,
    message: "Rollback starter added. Full rollback logic can be implemented next.",
  };
}