import {
  runDevelopmentOperation,
  type DevelopmentRequest,
} from "./development-operation.ts";

try {
  const request = JSON.parse(process.argv[2] ?? "{}") as DevelopmentRequest;
  const result = await runDevelopmentOperation(request);
  console.log(`DIGITAL_DEVELOPMENT_RESULT ${JSON.stringify(result)}`);
  process.exitCode = result.status === "ok" ? 0 : 1;
} catch (error) {
  console.log(
    `DIGITAL_DEVELOPMENT_RESULT ${JSON.stringify({ status: "refused", failure: error instanceof Error ? error.message : "开发会话操作异常" })}`,
  );
  process.exitCode = 1;
}
