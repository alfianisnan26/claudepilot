// What the Kubernetes proxy says when it refuses: a `Status` object like the API server's own, so client libraries show a normal error.
export type KubeRule = 'auth' | 'path' | 'method' | 'namespace' | 'name' | 'resource' | 'selector' | 'body' | 'upgrade' | 'header';

export interface KubeRefusal {
  rule: KubeRule;
  message: string;
}

export const refuseKube = (rule: KubeRule, message: string): KubeRefusal => ({ rule, message });

export const isKubeRefusal = (x: object): x is KubeRefusal => 'rule' in x && 'message' in x;

export function statusBody(code: number, reason: string, message: string): string {
  return JSON.stringify({ kind: 'Status', apiVersion: 'v1', metadata: {}, status: 'Failure', message, reason, details: {}, code });
}

export const deniedStatus = (rule: string): string => statusBody(403, 'Forbidden', `denied by claudepilot policy (${rule})`);
