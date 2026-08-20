import { defineConfig } from "drizzle-kit";

import {
  disposableCatalogueTargetFromEnvironment,
  disposableProductDataCatalogueTargetFromEnvironment,
} from "./src/disposable.ts";

const disposableCatalogueRoot = process.env.DIGITAL_DISPOSABLE_CATALOGUE_ROOT;
const disposableProductDataRoot =
  process.env.DIGITAL_DISPOSABLE_PRODUCT_DATA_ROOT;
if (
  disposableCatalogueRoot !== undefined &&
  disposableCatalogueRoot.trim().length > 0 &&
  disposableProductDataRoot !== undefined &&
  disposableProductDataRoot.trim().length > 0
) {
  throw new Error(
    "Choose either DIGITAL_DISPOSABLE_CATALOGUE_ROOT or DIGITAL_DISPOSABLE_PRODUCT_DATA_ROOT",
  );
}
const target =
  disposableProductDataRoot === undefined ||
  disposableProductDataRoot.trim().length === 0
    ? disposableCatalogueTargetFromEnvironment()
    : disposableProductDataCatalogueTargetFromEnvironment();

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/schema.ts",
  dbCredentials: { url: target.databasePath },
  strict: false,
  verbose: false,
});
