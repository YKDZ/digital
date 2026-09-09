import {
  FanboxSessionTransportFault,
  type FanboxClosedEndpoint,
  type FanboxPrivateBrowserContextV2,
  type FanboxSessionResponse,
  type FanboxEndpointSessionTransport,
} from "./browser-session.ts";
import {
  createFanboxProductAssemblyWithTransport,
  type FanboxProductAssembly,
} from "./index.ts";

/**
 * 仅供 FANBOX 因果测试与跨包集成测试使用；通过精确的 testing 子路径导出。
 * script 进入的边界与 production adapter 相同，只有 transaction 内的 closed get，
 * 不接受 URL/header/fetch。
 */
export function createScriptedFanboxProductAssembly(
  get: (input: {
    readonly creatorId: string;
    readonly privateContext: FanboxPrivateBrowserContextV2;
    readonly endpoint: FanboxClosedEndpoint;
  }) => Promise<FanboxSessionResponse>,
): FanboxProductAssembly {
  let closed = false;
  const transport: FanboxEndpointSessionTransport = {
    async transact(input) {
      if (closed) throw new FanboxSessionTransportFault("runtime-unavailable");
      return await input.use(
        async (endpoint) =>
          await get({
            creatorId: input.creatorId,
            privateContext: input.privateContext,
            endpoint,
          }),
      );
    },
    async close() {
      closed = true;
    },
  };
  return createFanboxProductAssemblyWithTransport(transport);
}
