import { prepareDisposableProductDataCatalogue } from "./disposable.ts";

const productDataDirectory = process.env.DIGITAL_DISPOSABLE_PRODUCT_DATA_ROOT;
if (
  productDataDirectory === undefined ||
  productDataDirectory.trim().length === 0
) {
  throw new Error(
    "DIGITAL_DISPOSABLE_PRODUCT_DATA_ROOT is required for test product-data preparation",
  );
}

await prepareDisposableProductDataCatalogue({ productDataDirectory });
