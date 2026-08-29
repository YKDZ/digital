import type { Server } from "vike/types";

import { createWebServer } from "#/server/app";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const app = createWebServer({
  productDataDirectory: process.env.DIGITAL_PRODUCT_DATA,
  environment: process.env,
});

export default {
  fetch: app.fetch,
  prod: {
    port,
  },
} satisfies Server;
