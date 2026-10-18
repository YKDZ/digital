import { PublicApiClientError } from "@digital/public-api";
import type {
  BangumiAuthorizationStart,
  KeySourceConnectionId,
  PublicBangumiAuthorizationAttempt,
  PublicFanboxConnectionRequest,
  PublicSourceConnection,
  PublicSourceConnectionClientMethods,
} from "@digital/public-api/source-connection-contract";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";

type SourceConnectionsPanelProps = {
  readonly client: PublicSourceConnectionClientMethods;
  readonly serviceUrl: string;
  readonly onExit: () => void;
};

type PanelMode =
  | "list"
  | "secret"
  | "revoke-confirm"
  | "fanbox-creator"
  | "fanbox-request"
  | "bangumi-authorization";

type BangumiAuthorization = BangumiAuthorizationStart & {
  readonly status: PublicBangumiAuthorizationAttempt["status"];
};

/** TMDB 与 OMDb 的私密密钥连接入口；其他来源由各自连接流程负责。 */
export function SourceConnectionsPanel({
  client,
  serviceUrl,
  onExit,
}: SourceConnectionsPanelProps) {
  const [connections, setConnections] = useState<
    readonly PublicSourceConnection[]
  >([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<PanelMode>("list");
  const [secret, setSecret] = useState("");
  const [creatorId, setCreatorId] = useState("");
  const [pairing, setPairing] = useState<{
    readonly request: PublicFanboxConnectionRequest;
    readonly pairingCode: string;
  }>();
  const [bangumiAuthorization, setBangumiAuthorization] =
    useState<BangumiAuthorization>();
  const [message, setMessage] = useState("正在读取来源连接…");
  const [readFailed, setReadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    let active = true;
    void client
      .listSourceConnections()
      .then(({ items }) => {
        if (!active) return;
        setConnections(
          items.filter(
            ({ id }) =>
              id === "tmdb" ||
              id === "omdb" ||
              id === "bangumi" ||
              id.startsWith("fanbox/"),
          ),
        );
        setReadFailed(false);
        setMessage("");
      })
      .catch(() => {
        if (!active) return;
        setReadFailed(true);
        setMessage("暂时无法读取来源连接，请按 r 重试");
      });
    return () => {
      active = false;
    };
  }, [client, reloadVersion]);

  useEffect(() => {
    if (mode !== "fanbox-request" || pairing === undefined) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const request = await client.getFanboxConnectionRequest(
          pairing.request.id,
        );
        if (!active) return;
        setPairing((current) =>
          current === undefined ? current : { ...current, request },
        );
        if (request.status === "waiting" || request.status === "verifying")
          timer = setTimeout(() => void poll(), 1_000);
        else setReloadVersion((value) => value + 1);
      } catch {
        if (!active) return;
        timer = setTimeout(() => void poll(), 2_000);
      }
    };
    timer = setTimeout(() => void poll(), 1_000);
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [client, mode, pairing?.request.id, pairing?.request.status]);

  useEffect(() => {
    if (
      mode !== "bangumi-authorization" ||
      bangumiAuthorization === undefined ||
      bangumiAuthorization.status === "succeeded" ||
      bangumiAuthorization.status === "failed" ||
      bangumiAuthorization.status === "cancelled" ||
      bangumiAuthorization.status === "expired" ||
      bangumiAuthorization.status === "superseded"
    ) {
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const attempt = await client.getBangumiAuthorizationAttempt(
          bangumiAuthorization.attemptId,
        );
        if (!active) return;
        setBangumiAuthorization((current) =>
          current === undefined
            ? current
            : { ...current, status: attempt.status },
        );
        if (attempt.status === "waiting" || attempt.status === "processing") {
          timer = setTimeout(() => void poll(), 1_000);
        } else {
          setReloadVersion((value) => value + 1);
          setMessage(bangumiAuthorizationMessage(attempt.status));
        }
      } catch {
        if (!active) return;
        setMessage("暂时无法读取授权结果，正在重试…");
        timer = setTimeout(() => void poll(), 2_000);
      }
    };
    timer = setTimeout(() => void poll(), 750);
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [
    bangumiAuthorization?.attemptId,
    bangumiAuthorization?.status,
    client,
    mode,
  ]);

  const selected = connections[selectedIndex];

  const configure = async () => {
    if (selected === undefined) return;
    if (secret.trim().length === 0) {
      setMessage("请输入密钥");
      return;
    }
    const sourceId = selected.id as KeySourceConnectionId;
    setBusy(true);
    setMessage("正在验证密钥…");
    try {
      const input = {
        sourceId,
        expectedVersion: selected.version,
        secret,
      };
      const result =
        selected.credentialStatus === "configured"
          ? await client.replaceSourceConnection(input)
          : await client.configureSourceConnection(input);
      setConnections((current) =>
        current.map((connection) =>
          connection.id === result.connection.id
            ? result.connection
            : connection,
        ),
      );
      setMessage(verificationMessage(result.verification));
    } catch (error) {
      setMessage(operationFailureMessage(error, "配置"));
    } finally {
      setSecret("");
      setMode("list");
      setBusy(false);
    }
  };

  const beginBangumiAuthorization = async () => {
    setBusy(true);
    setMessage("正在发起 Bangumi 连接授权…");
    try {
      const started = await client.beginBangumiAuthorization();
      setBangumiAuthorization({ ...started, status: "waiting" });
      setMode("bangumi-authorization");
      setMessage("");
    } catch (error) {
      setMessage(
        error instanceof PublicApiClientError && error.kind === "conflict"
          ? "Bangumi 授权正在处理，请稍后重试。"
          : "暂时无法发起 Bangumi 授权，请稍后重试。",
      );
    } finally {
      setBusy(false);
    }
  };

  const cancelBangumiAuthorization = async () => {
    if (bangumiAuthorization === undefined) return;
    setBusy(true);
    try {
      const attempt = await client.cancelBangumiAuthorization(
        bangumiAuthorization.attemptId,
      );
      setBangumiAuthorization((current) =>
        current === undefined
          ? current
          : { ...current, status: attempt.status },
      );
      setMessage(
        attempt.status === "processing"
          ? "授权回调正在处理，当前无法取消；正在等待结果。"
          : bangumiAuthorizationMessage(attempt.status),
      );
      if (
        attempt.status === "succeeded" ||
        attempt.status === "failed" ||
        attempt.status === "cancelled" ||
        attempt.status === "expired" ||
        attempt.status === "superseded"
      ) {
        setReloadVersion((value) => value + 1);
      }
    } catch {
      setMessage("暂时无法取消 Bangumi 授权，请稍后重试。");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async () => {
    if (selected === undefined) return;
    setBusy(true);
    try {
      const result = selected.id.startsWith("fanbox/")
        ? await client.revokeFanboxSourceConnection({
            creatorId: selected.id.slice("fanbox/".length),
            expectedVersion: selected.version,
          })
        : selected.id === "bangumi"
          ? await client.revokeBangumiSourceConnection({
              expectedVersion: selected.version,
            })
          : await client.revokeSourceConnection({
              sourceId: selected.id as KeySourceConnectionId,
              expectedVersion: selected.version,
            });
      setConnections((current) =>
        current.map((connection) =>
          connection.id === result.connection.id
            ? result.connection
            : connection,
        ),
      );
      setMessage("来源连接已撤销");
    } catch (error) {
      setMessage(operationFailureMessage(error, "撤销"));
    } finally {
      setMode("list");
      setBusy(false);
    }
  };

  const createFanboxRequest = async () => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(creatorId)) {
      setMessage("请输入有效的 FANBOX 创作者编号");
      return;
    }
    setBusy(true);
    setMessage("正在发起 FANBOX 连接…");
    try {
      const result = await client.createFanboxConnectionRequest({ creatorId });
      setPairing(result);
      setMode("fanbox-request");
      setMessage("请在已登录 FANBOX 的 Chromium 扩展中完成配对");
    } catch (error) {
      setMessage(operationFailureMessage(error, "连接"));
    } finally {
      setBusy(false);
    }
  };

  const cancelFanboxRequest = async () => {
    if (pairing === undefined) return;
    setBusy(true);
    try {
      const request = await client.cancelFanboxConnectionRequest({
        requestId: pairing.request.id,
        pairingCode: pairing.pairingCode,
      });
      setPairing({ ...pairing, request });
      setMessage("FANBOX 连接请求已取消");
      setReloadVersion((value) => value + 1);
    } catch {
      setMessage("FANBOX 连接请求取消失败，请按 r 重读状态");
    } finally {
      setBusy(false);
    }
  };

  useInput((input, key) => {
    if (busy) return;
    if (mode === "fanbox-creator") {
      if (key.escape) {
        setCreatorId("");
        setMode("list");
        setMessage("已取消 FANBOX 连接");
      } else if (key.return) {
        void createFanboxRequest();
      } else if (key.backspace || key.delete) {
        setCreatorId((value) => value.slice(0, -1));
      } else if (input.length > 0 && !key.ctrl && !key.meta) {
        setCreatorId((value) => value + input);
      }
      return;
    }
    if (mode === "fanbox-request") {
      if (
        input === "x" &&
        pairing !== undefined &&
        (pairing.request.status === "waiting" ||
          pairing.request.status === "verifying")
      ) {
        void cancelFanboxRequest();
      } else if (input === "q" || key.escape) {
        setPairing(undefined);
        setMode("list");
        setReloadVersion((value) => value + 1);
        setMessage("FANBOX 连接状态已返回列表");
      }
      return;
    }
    if (mode === "bangumi-authorization") {
      if (input === "x" || key.escape) {
        if (bangumiAuthorization?.status === "waiting")
          void cancelBangumiAuthorization();
        else if (bangumiAuthorization?.status === "processing")
          setMessage("授权回调正在处理，当前无法取消；正在等待结果。");
        else if (bangumiAuthorization !== undefined) {
          setBangumiAuthorization(undefined);
          setMode("list");
          setReloadVersion((value) => value + 1);
        }
      } else if (input === "q" && bangumiAuthorization !== undefined) {
        if (bangumiAuthorization.status === "waiting")
          void cancelBangumiAuthorization();
        else if (bangumiAuthorization.status === "processing")
          setMessage("授权回调正在处理，完成后按 q 返回来源连接。");
        else {
          setBangumiAuthorization(undefined);
          setMode("list");
          setReloadVersion((value) => value + 1);
        }
      }
      return;
    }
    if (mode === "secret") {
      if (key.escape) {
        setSecret("");
        setMode("list");
        setMessage("已取消密钥输入");
      } else if (key.return) {
        void configure();
      } else if (key.backspace || key.delete) {
        setSecret((value) => value.slice(0, -1));
      } else if (input.length > 0 && !key.ctrl && !key.meta) {
        setSecret((value) => value + input);
      }
      return;
    }
    if (mode === "revoke-confirm") {
      if (input.toLowerCase() === "y") void revoke();
      else if (input.toLowerCase() === "n" || key.escape) {
        setMode("list");
        setMessage("已取消撤销");
      }
      return;
    }
    if (input === "q" || key.escape) {
      onExit();
    } else if (input === "r") {
      setReadFailed(false);
      setMessage("正在读取来源连接…");
      setReloadVersion((value) => value + 1);
    } else if (key.upArrow) {
      setSelectedIndex((value) => Math.max(0, value - 1));
    } else if (key.downArrow) {
      setSelectedIndex((value) => Math.min(connections.length - 1, value + 1));
    } else if (input === "f") {
      setCreatorId(
        selected?.id.startsWith("fanbox/")
          ? selected.id.slice("fanbox/".length)
          : "",
      );
      setMode("fanbox-creator");
      setMessage("");
    } else if ((input === "c" || key.return) && selected !== undefined) {
      if (selected.id === "bangumi") {
        void beginBangumiAuthorization();
        return;
      } else if (selected.id.startsWith("fanbox/")) {
        setCreatorId(selected.id.slice("fanbox/".length));
        setMode("fanbox-creator");
        setMessage("");
        return;
      }
      setSecret("");
      setMode("secret");
      setMessage("");
    } else if (input === "x" && selected !== undefined) {
      if (selected.credentialStatus === "unconfigured")
        setMessage("此来源还未配置");
      else {
        setMode("revoke-confirm");
        setMessage(`确认撤销${sourceName(selected.id)}连接？按 y 确认，n 取消`);
      }
    }
  });

  if (mode === "fanbox-creator")
    return (
      <Box flexDirection="column">
        <Text>连接 FANBOX 创作者</Text>
        <Text>创作者编号（不是 FANBOX 登录凭据）</Text>
        <Text>{creatorId.length === 0 ? "（空）" : creatorId}</Text>
        <Text>Enter 发起限时配对，Esc 取消</Text>
        {message.length > 0 ? <Text color="yellow">{message}</Text> : null}
      </Box>
    );

  if (mode === "fanbox-request" && pairing !== undefined)
    return (
      <Box flexDirection="column">
        <Text bold>FANBOX 浏览器连接</Text>
        <Text>服务地址：{serviceUrl}</Text>
        <Text>创作者范围：{pairing.request.creatorId}</Text>
        <Text>目标实例：{pairing.request.instanceId}</Text>
        <Text>请求编号：{pairing.request.id}</Text>
        <Text>限时配对码：{pairing.pairingCode}</Text>
        <Text>
          当前状态：{fanboxRequestStatusLabel(pairing.request.status)}
        </Text>
        {pairing.request.status === "waiting" ||
        pairing.request.status === "verifying" ? (
          <Text>x 取消请求　q 返回列表</Text>
        ) : (
          <Text>q 返回列表</Text>
        )}
        {message.length > 0 ? <Text color="yellow">{message}</Text> : null}
      </Box>
    );

  if (mode === "bangumi-authorization" && bangumiAuthorization !== undefined) {
    const target = bangumiAuthorizationTarget(
      bangumiAuthorization.authorizationUrl,
      serviceUrl,
    );
    return (
      <Box flexDirection="column">
        <Text bold>Bangumi 连接授权</Text>
        <Text>目标实例：{new URL(serviceUrl).origin}</Text>
        <Text>授权回调目标：{target}</Text>
        <Text>授权地址：{bangumiAuthorization.authorizationUrl}</Text>
        <Text>请在你自己的浏览器打开授权地址，完成后返回此终端查看结果。</Text>
        <Text>
          当前状态：{bangumiAuthorizationLabel(bangumiAuthorization.status)}
        </Text>
        {bangumiAuthorization.status === "waiting" ? (
          <Text>x/Esc 取消授权　q 取消并查看结果</Text>
        ) : bangumiAuthorization.status === "processing" ? (
          <Text>正在确认授权，暂时无法取消或返回</Text>
        ) : (
          <Text>q/Esc 返回来源连接</Text>
        )}
        {message.length > 0 ? <Text color="yellow">{message}</Text> : null}
      </Box>
    );
  }

  if (mode === "secret")
    return (
      <Box flexDirection="column">
        <Text>设置{sourceName(selected?.id ?? "")}密钥</Text>
        <Text>
          {selected?.id === "tmdb" ? "访问令牌" : "API 密钥"}（输入已隐藏）
        </Text>
        <Text>
          {secret.length === 0
            ? "（空）"
            : "•".repeat(Math.min(24, secret.length))}
        </Text>
        <Text>Enter 验证并保存，Esc 取消</Text>
        {message.length > 0 ? <Text color="yellow">{message}</Text> : null}
      </Box>
    );

  return (
    <Box flexDirection="column">
      <Text bold>来源连接</Text>
      {connections.length === 0 && !readFailed ? (
        <Text>当前没有来源连接</Text>
      ) : (
        <SourceConnectionStatusList
          connections={connections}
          selectedIndex={selectedIndex}
          sourceName={sourceName}
        />
      )}
      {message.length > 0 ? (
        <Text color={readFailed ? "red" : "yellow"}>{message}</Text>
      ) : null}
      {mode === "revoke-confirm" ? null : (
        <Text>↑↓选择 Enter/c 配置 f FANBOX 连接 x 撤销 r 重读 q 返回</Text>
      )}
    </Box>
  );
}

export function SourceConnectionStatusList({
  connections,
  selectedIndex,
  sourceName: displayName = sourceName,
}: {
  readonly connections: readonly PublicSourceConnection[];
  readonly selectedIndex?: number | undefined;
  readonly sourceName?: ((id: string) => string) | undefined;
}) {
  return (
    <Box flexDirection="column">
      {connections.map((connection, index) => (
        <Text key={connection.id}>
          {selectedIndex === index ? "› " : "  "}
          {displayName(connection.id)}：
          {sourceConnectionStatusLabel(connection)}
        </Text>
      ))}
    </Box>
  );
}

function sourceName(id: string): string {
  switch (id) {
    case "bangumi":
      return "Bangumi";
    case "tmdb":
      return "TMDB";
    case "omdb":
      return "OMDb";
    default:
      return id.startsWith("fanbox/") ? `FANBOX ${id.slice(7)}` : "来源";
  }
}

function bangumiAuthorizationTarget(
  authorizationUrl: string,
  fallback: string,
): string {
  const redirectUri = new URL(authorizationUrl).searchParams.get(
    "redirect_uri",
  );
  return redirectUri === null ? fallback : new URL(redirectUri).origin;
}

function bangumiAuthorizationLabel(
  status: PublicBangumiAuthorizationAttempt["status"],
): string {
  switch (status) {
    case "waiting":
      return "等待浏览器授权";
    case "processing":
      return "正在确认授权";
    case "succeeded":
      return "连接已可用";
    case "failed":
      return "授权失败";
    case "cancelled":
      return "授权已取消";
    case "expired":
      return "授权已过期";
    case "superseded":
      return "授权请求已失效";
  }
}

function bangumiAuthorizationMessage(
  status: PublicBangumiAuthorizationAttempt["status"],
): string {
  switch (status) {
    case "waiting":
      return "等待浏览器完成授权。";
    case "processing":
      return "授权回调正在处理，当前无法取消；正在等待结果。";
    case "succeeded":
      return "Bangumi 连接已可用。";
    case "failed":
      return "Bangumi 授权失败，请重新发起。";
    case "cancelled":
      return "Bangumi 授权已取消。";
    case "expired":
      return "Bangumi 授权已过期，请重新发起。";
    case "superseded":
      return "Bangumi 授权请求已失效，请重新发起。";
  }
}

function fanboxRequestStatusLabel(
  status: PublicFanboxConnectionRequest["status"],
): string {
  switch (status) {
    case "waiting":
      return "等待浏览器配对";
    case "verifying":
      return "正在验证 FANBOX 登录状态";
    case "succeeded":
      return "连接成功";
    case "failed":
      return "验证失败";
    case "cancelled":
      return "已取消";
    case "expired":
      return "已过期";
    case "superseded":
      return "已由新连接请求替代";
  }
}

export function sourceConnectionStatusLabel(
  connection: PublicSourceConnection,
): string {
  if (connection.reason === "verification-pending") return "待验证";
  if (connection.credentialStatus === "unconfigured") return "待配置";
  if (connection.credentialStatus === "revoked") return "已撤销";
  if (connection.credentialStatus === "invalid") return "状态不可用";
  if (connection.availability === "available") return "可用";
  if (connection.reason === "verification-failed") return "验证未通过";
  return "当前不可用";
}

function verificationMessage(
  verification: "verified" | "failed" | "superseded",
): string {
  switch (verification) {
    case "verified":
      return "验证成功，来源连接已可用";
    case "failed":
      return "验证未通过，来源连接当前不可用";
    case "superseded":
      return "连接已由其他操作更改，请重新读取状态";
  }
}

function operationFailureMessage(
  error: unknown,
  action: "配置" | "撤销" | "连接",
) {
  if (error instanceof PublicApiClientError && error.kind === "conflict")
    return "来源连接已被其他操作更改，请按 r 重读后重试";
  return `来源连接${action}未完成，请按 r 重读后重试`;
}
