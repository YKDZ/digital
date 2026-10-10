import { toStandardJsonSchema } from "@valibot/to-json-schema";
import type * as v from "valibot";

/** 保留模板的 Valibot 适配：失败只返回 issues，同时提供官方 JSON Schema 投影。 */
export function standardSchema<
  T extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>,
>(schema: T) {
  const converted = toStandardJsonSchema(schema);
  const adapted: typeof converted = {
    "~standard": {
      ...converted["~standard"],
      validate(value) {
        const result = converted["~standard"].validate(value);
        if (result instanceof Promise)
          return result.then((resolved) =>
            resolved.issues === undefined
              ? resolved
              : { issues: resolved.issues },
          );
        return result.issues === undefined ? result : { issues: result.issues };
      },
    },
  };
  return adapted;
}
