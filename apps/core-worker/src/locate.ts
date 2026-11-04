/**
 * The one way to reach a Durable Object by name. Every object is placed in Asia-Pacific (the owner and the k3s
 * workspaces are there); a hint only counts when the object is first created, so it must be on every call, and a
 * test fails when any other file calls idFromName.
 */
export const LOCATION_HINT = 'apac' satisfies DurableObjectLocationHint;

export function locate<T extends Rpc.DurableObjectBranded | undefined>(
  namespace: DurableObjectNamespace<T>,
  name: string,
): DurableObjectStub<T> {
  return namespace.get(namespace.idFromName(name), { locationHint: LOCATION_HINT });
}
