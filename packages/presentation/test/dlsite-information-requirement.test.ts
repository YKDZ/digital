import { describe, expect, it } from "vitest";

import {
  dlsiteAssetViewInformationRequirement,
  informationRequirementForAssetView,
} from "../src/index";

describe("DLsite Asset View information requirement", () => {
  it("declares its complete neutral input demand at the view boundary", () => {
    expect(dlsiteAssetViewInformationRequirement).toEqual({
      metadataUsageContext: "asset.ordinary",
      metadata: [
        { property: "asset.title", necessity: "required" },
        { property: "asset.release-date", necessity: "optional" },
        { property: "asset.introduction", necessity: "optional" },
        { property: "asset.declared-language", necessity: "optional" },
        { property: "asset.content-classification", necessity: "optional" },
        { property: "dlsite.product.price-jpy", necessity: "optional" },
        { property: "asset.series-position", necessity: "optional" },
      ],
      artifactRoles: [
        {
          role: "asset.primary-cover",
          necessity: "optional",
          maximum: 1,
        },
      ],
      relationshipTypes: [
        { type: "asset.contribution", necessity: "optional" },
        { type: "asset.membership", necessity: "optional" },
      ],
    });
  });

  it("selects that demand through presentation dispatch instead of a global union", () => {
    const requirement = informationRequirementForAssetView({
      sourceAssociations: [
        {
          sourceIdentity: "dlsite",
          nativeAddress:
            "https://www.dlsite.com/maniax/work/=/product_id/RJ01668691.html",
        },
      ],
      metadata: [],
    });

    expect(requirement).toBe(dlsiteAssetViewInformationRequirement);
    expect(requirement.metadata).not.toContainEqual({
      property: "asset.runtime-minutes",
      necessity: "optional",
    });
  });
});
