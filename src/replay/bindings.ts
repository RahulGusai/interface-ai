export function resolveBindings(
  value: any,
  inputs: Record<string, unknown>,
  results: Record<string, unknown>,
  environment: { base_url: string },
): any {
  const read = (root: any, path: string) => {
    let v = root;
    for (const p of path.split(".")) {
      if (
        !v ||
        typeof v !== "object" ||
        !Object.hasOwn(v, p) ||
        ["__proto__", "constructor", "prototype"].includes(p)
      )
        throw Error("BINDING_UNAVAILABLE");
      v = v[p];
    }
    if (v === undefined) throw Error("BINDING_UNAVAILABLE");
    return v;
  };
  if (Array.isArray(value))
    return value.map((x) => resolveBindings(x, inputs, results, environment));
  if (!value || typeof value !== "object") return value;
  switch (value.kind) {
    case "literal":
      return structuredClone(value.value);
    case "input":
      return read(inputs, value.path);
    case "step_output":
      return read(results[value.step_id], value.path);
    case "environment":
      return environment.base_url;
    case "url": {
      const u = new URL(value.path, environment.base_url);
      if (u.origin !== new URL(environment.base_url).origin)
        throw Error("URL_ORIGIN_INVALID");
      return u.href;
    }
    case "template":
      return value.parts
        .map((p: any) => {
          const v = resolveBindings(p, inputs, results, environment);
          if (!["string", "number", "boolean"].includes(typeof v))
            throw Error("TEMPLATE_PRIMITIVE_REQUIRED");
          return String(v);
        })
        .join("");
    default:
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [
          k,
          resolveBindings(v, inputs, results, environment),
        ]),
      );
  }
}
