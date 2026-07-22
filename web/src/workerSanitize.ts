/**
 * Strip framework proxies from a value bound for the geometry worker. A Pinia
 * store hands the UI Vue reactive Proxies, and Comlink's postMessage structured
 * clone throws "could not be cloned" on them. This rebuilds the plain data so
 * the clone succeeds, without any per-field whack-a-mole at the call sites.
 *
 * Framework-free by construction (no Vue import): it recognises a reactive Proxy
 * structurally, because such a Proxy reports Object.prototype as its prototype
 * and is rebuilt as a plain object below.
 *
 * Payloads are assumed acyclic: there is no visited-set cycle guard, so a cyclic
 * value would recurse forever, exactly as the JSON round-trip this replaced did.
 */
export function sanitizeForWorker<T>(value: T): T {
  // Primitives clone as-is. undefined-valued optional keys (iconPath, scoop,
  // fusedLabel, brim, labelText) are treated by the worker the same as an
  // absent key, so leaving them undefined here is safe.
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForWorker(item)) as unknown as T;
  }

  // Plain objects only: a Vue reactive Proxy reports Object.prototype, so it
  // matches here and gets rebuilt as a plain object, which strips the Proxy.
  const proto = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = sanitizeForWorker((value as Record<string, unknown>)[key]);
    }
    return out as T;
  }

  // Everything else (TypedArrays, ArrayBuffer, DataView, functions, class
  // instances, Date) is returned by reference uncopied, so mesh transferables
  // and any Comlink callback proxies survive to be posted as themselves.
  return value;
}
