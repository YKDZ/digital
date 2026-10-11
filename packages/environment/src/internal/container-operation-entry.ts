import type { ContainerRequest } from "../container-environment.ts";
import { createOperationCancellation } from "./cancellation.ts";
import { runContainerOperation } from "./container-operation.ts";

const input = JSON.parse(process.argv[2] ?? "{}") as {
  readonly request: ContainerRequest;
  readonly deadlineAt?: number;
};
const cancellation = createOperationCancellation({
  deadlineAt: input.deadlineAt,
});
try {
  const result = await runContainerOperation(input.request, cancellation);
  console.log(`DIGITAL_CONTAINER_RESULT ${JSON.stringify(result)}`);
  process.exitCode =
    result.status === "ok" ? 0 : result.status === "cancelled" ? 130 : 1;
} finally {
  cancellation.dispose();
}
