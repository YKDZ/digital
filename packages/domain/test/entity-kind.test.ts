import { describe, expect, it } from "vitest";

import { deriveEffectiveEntityKind } from "../src/index.ts";

describe("生效实体种类", () => {
  it("只在数字资产断言存在时生效，否则为普通实体", () => {
    expect(deriveEffectiveEntityKind({ assertions: [] })).toEqual({
      status: "ordinary",
    });
    expect(
      deriveEffectiveEntityKind({
        assertions: [
          {
            id: "asset",
            entityId: "entity",
            kind: "digital-asset",
            basis: "source",
          },
        ],
      }),
    ).toEqual({
      status: "effective",
      kind: "digital-asset",
      basis: "assertion",
    });
  });
});
