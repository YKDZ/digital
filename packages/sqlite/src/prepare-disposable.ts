import { prepareDisposableCatalogue } from "./disposable.js";

const root = process.env.DIGITAL_DISPOSABLE_CATALOGUE_ROOT;
if (root === undefined || root.trim().length === 0) {
  throw new Error(
    "DIGITAL_DISPOSABLE_CATALOGUE_ROOT is required for a Drizzle disposable prepare",
  );
}

await prepareDisposableCatalogue({ root });
