import type { FanboxEndpointSessionTransport } from "@digital/fanbox";

/**
 * 产品外部来源 I/O 的装配选择。它是固定来源装配的有限依赖集合，不是按字符串查服务的
 * 容器：真实模式沿用各来源自身的默认网络实现；注入模式必须同时给出普通请求实现与会话
 * transport，注入装配里没有任何边界可以退回默认网络。`offline` 与 `controlled` 都是
 * 注入模式，差别只在所注入实现的行为——前者对任何外部请求都拒绝，后者按已加载响应精确匹配。
 */
export type ProductSourceIo =
  | { readonly mode: "real" }
  | {
      readonly mode: "controlled" | "offline";
      readonly request: ProductOrdinaryRequest;
      readonly sessionTransport: FanboxEndpointSessionTransport;
    };

/** 现有来源窄接口的公共结构，由可执行根提供的实现满足。 */
export type ProductOrdinaryRequest = (
  input: string,
  init?: {
    readonly method?: string;
    readonly headers?: unknown;
    readonly body?: unknown;
  },
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;
