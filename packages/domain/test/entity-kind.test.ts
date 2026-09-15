import { describe, expect, it } from "vitest";

import { deriveEffectiveEntityKind } from "../src/index.ts";

describe("生效实体种类", () => {
  it("从单一断言推导、公开冲突，清除决定后重新采用断言", () => {
    expect(
      deriveEffectiveEntityKind({
        assertions: [
          {
            id: "person",
            entityId: "entity",
            kind: "person",
            basis: "source",
          },
        ],
      }),
    ).toEqual({ status: "effective", kind: "person", basis: "assertion" });
    expect(
      deriveEffectiveEntityKind({
        assertions: [
          {
            id: "person",
            entityId: "entity",
            kind: "person",
            basis: "source",
          },
          {
            id: "persona",
            entityId: "entity",
            kind: "persona",
            basis: "source",
          },
        ],
      }),
    ).toEqual({ status: "conflict", kinds: ["person", "persona"] });
    expect(
      deriveEffectiveEntityKind({
        assertions: [
          {
            id: "person",
            entityId: "entity",
            kind: "person",
            basis: "source",
          },
        ],
        decision: {
          id: "clear",
          entityId: "entity",
          basis: "manual",
        },
      }),
    ).toEqual({ status: "effective", kind: "person", basis: "assertion" });
  });
});
