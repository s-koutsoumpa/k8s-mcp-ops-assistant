// This file creates Kubernetes API clients.
// loadFromDefault() will use ~/.kube/config on the VM,
// or in-cluster config if the app runs inside Kubernetes.

import * as k8s from "@kubernetes/client-node";

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

export const appsV1 = kc.makeApiClient(k8s.AppsV1Api);
export const coreV1 = kc.makeApiClient(k8s.CoreV1Api);
export const customObjects = kc.makeApiClient(k8s.CustomObjectsApi);

export { kc };