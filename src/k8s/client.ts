// =============================================================================
// client.ts
// =============================================================================
//
// WHAT IS THIS FILE?
// ------------------
// This file creates and exports the Kubernetes API clients that every other
// file in this project uses to talk to the cluster.
//
// Think of it as the "phone book setup": we configure the connection once
// here, and every other file just picks up the ready-to-use client objects.
//
// WHERE IS IT USED?
// -----------------
// Imported by:
//   - src/tools/read-tools.ts   (reads deployments, pods, events, metrics, logs)
//   - src/tools/action-tools.ts (writes: restart, scale, patch, rollback)
//   - src/analysis/analyzer.ts  (reads deployments, pods, events for analysis)
//
// HOW IT FITS WITH THE REST OF THE SYSTEM
// ----------------------------------------
// Kubernetes has many different API groups, each with its own client class:
//
//   appsV1        — Deployments, ReplicaSets, StatefulSets, DaemonSets
//   coreV1        — Pods, Services, ConfigMaps, Namespaces, Events
//   customObjects — Any custom resource (used here for pod metrics via metrics-server)
//
// We create all three here and export them so the rest of the codebase never
// has to re-configure the connection themselves.
//
// HOW KUBERNETES KNOWS WHERE TO CONNECT:
// ---------------------------------------
// kc.loadFromDefault() checks two places in order:
//   1. Inside the cluster: if this app is running as a Pod, Kubernetes
//      automatically mounts credentials at /var/run/secrets/kubernetes.io/serviceaccount/
//   2. On your local machine: it reads ~/.kube/config (the same file
//      that `kubectl` uses)
//
// This means the same code works both locally and when deployed to the cluster.
// =============================================================================

import * as k8s from "@kubernetes/client-node";

// Create a KubeConfig object and load the connection settings automatically.
// This reads ~/.kube/config when running locally, or in-cluster credentials
// when running inside a Kubernetes Pod.
const kc = new k8s.KubeConfig();
kc.loadFromDefault();

// appsV1 is used for anything involving Deployments or ReplicaSets.
export const appsV1 = kc.makeApiClient(k8s.AppsV1Api);

// coreV1 is used for Pods, Namespaces, Events, and Pod logs.
export const coreV1 = kc.makeApiClient(k8s.CoreV1Api);

// customObjects is used for resources that are not built into Kubernetes,
// such as pod metrics provided by the metrics-server (metrics.k8s.io/v1beta1).
export const customObjects = kc.makeApiClient(k8s.CustomObjectsApi);

// We also export kc itself in case any code needs to inspect
// the cluster configuration (e.g. current context or server URL).
export { kc };
