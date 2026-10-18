import {
  createPublicApiClient,
  PublicApiClientError,
} from "@digital/public-api";
import type { PublicFanboxConnectionRequest } from "@digital/public-api/source-connection-contract";

const serviceUrlInput = requiredInput("service-url");
const instanceIdInput = requiredInput("instance-id");
const requestIdInput = requiredInput("request-id");
const pairingCodeInput = requiredInput("pairing-code");
const reviewButton = requiredButton("review");
const connectButton = requiredButton("connect");
const scope = requiredElement("scope");
const status = requiredElement("status");

let reviewedRequest: PublicFanboxConnectionRequest | undefined;
type ConnectionTarget = NonNullable<ReturnType<typeof readTarget>>;
let reviewedTarget: ConnectionTarget | undefined;
let busy = false;

reviewButton.addEventListener("click", () => void reviewTarget());
connectButton.addEventListener("click", () => void connectBrowserSession());

async function reviewTarget(): Promise<void> {
  if (busy) return;
  const target = readTarget();
  if (target === undefined) return;
  busy = true;
  setBusy(true);
  reviewedRequest = undefined;
  reviewedTarget = undefined;
  connectButton.disabled = true;
  scope.hidden = true;
  setStatus("正在请求访问目标服务的权限…");
  try {
    if (!(await requestOrigins([target.permissionOrigin]))) {
      setStatus("未授予目标服务权限，连接请求保持等待状态。");
      return;
    }
    if (!sameTarget(target, readTarget())) {
      rejectChangedReview();
      return;
    }
    const request = await target.client.getFanboxConnectionRequestForPairing({
      requestId: target.requestId,
      pairingCode: target.pairingCode,
    });
    if (!sameTarget(target, readTarget())) {
      rejectChangedReview();
      return;
    }
    if (request.instanceId !== target.expectedInstanceId) {
      setScope(request);
      setStatus("目标实例编号不一致。请核对 TUI 显示的服务地址与实例编号。");
      return;
    }
    setScope(request);
    if (request.status !== "waiting") {
      setStatus(`此连接请求当前状态为：${requestStatus(request.status)}。`);
      return;
    }
    reviewedRequest = request;
    reviewedTarget = target;
    connectButton.disabled = false;
    setStatus(
      "请核对上方服务实例和创作者范围，再选择是否发送当前浏览器登录状态。",
    );
  } catch (error) {
    setStatus(clientFailure(error));
  } finally {
    busy = false;
    setBusy(false);
    if (reviewedRequest !== undefined) connectButton.disabled = false;
  }
}

async function connectBrowserSession(): Promise<void> {
  if (busy || reviewedRequest === undefined || reviewedTarget === undefined)
    return;
  const target = readTarget();
  if (target === undefined) return;
  const confirmedTarget = reviewedTarget;
  const confirmedRequest = reviewedRequest;
  if (!sameTarget(confirmedTarget, target)) {
    rejectChangedReview();
    return;
  }
  busy = true;
  setBusy(true);
  connectButton.disabled = true;
  setStatus("正在请求读取 FANBOX 登录状态的权限…");
  const fanboxOrigins = ["https://fanbox.cc/*", "https://*.fanbox.cc/*"];
  try {
    if (!(await requestOrigins(fanboxOrigins))) {
      setStatus("未授予 FANBOX 权限。尚未读取或发送浏览器登录状态。");
      return;
    }
    if (!reviewIsCurrent(confirmedTarget, confirmedRequest)) {
      rejectChangedReview();
      return;
    }
    const current = await target.client.getFanboxConnectionRequestForPairing({
      requestId: target.requestId,
      pairingCode: target.pairingCode,
    });
    if (!reviewIsCurrent(confirmedTarget, confirmedRequest)) {
      rejectChangedReview();
      return;
    }
    if (
      current.status !== "waiting" ||
      current.instanceId !== target.expectedInstanceId ||
      current.creatorId !== confirmedRequest.creatorId
    ) {
      reviewedRequest = undefined;
      reviewedTarget = undefined;
      setScope(current);
      setStatus(
        `连接请求已变化，当前状态为：${requestStatus(current.status)}。请重新检查目标。`,
      );
      return;
    }

    const cookies = await getFanboxCookies();
    if (!reviewIsCurrent(confirmedTarget, confirmedRequest)) {
      rejectChangedReview();
      return;
    }
    if (!cookies.some((cookie) => cookie.name === "FANBOXSESSID")) {
      setStatus(
        "当前 Chromium 配置中没有 FANBOX 登录会话。请先在此浏览器登录 FANBOX，再重试。",
      );
      connectButton.disabled = false;
      return;
    }
    setStatus("已捕获当前浏览器会话，正在由目标服务验证…");
    const result = await target.client.completeFanboxConnectionRequest({
      requestId: target.requestId,
      pairingCode: target.pairingCode,
      browserCredential: { cookies, userAgent: navigator.userAgent },
    });
    setScope(result);
    reviewedRequest = undefined;
    reviewedTarget = undefined;
    pairingCodeInput.value = "";
    setStatus(
      result.status === "succeeded"
        ? "FANBOX 连接成功。浏览器会话已由目标服务验证并私密保存。"
        : `目标服务未保存此连接，状态为：${requestStatus(result.status)}。`,
    );
  } catch (error) {
    setStatus(clientFailure(error));
    connectButton.disabled = false;
  } finally {
    busy = false;
    setBusy(false);
    if (reviewedRequest !== undefined) connectButton.disabled = false;
  }
}

function readTarget():
  | {
      readonly client: ReturnType<typeof createPublicApiClient>;
      readonly serviceAddress: string;
      readonly permissionOrigin: string;
      readonly expectedInstanceId: string;
      readonly requestId: string;
      readonly pairingCode: string;
    }
  | undefined {
  let serviceUrl: URL;
  try {
    serviceUrl = new URL(serviceUrlInput.value.trim());
  } catch {
    setStatus("请输入完整的 HTTP 或 HTTPS 服务地址。");
    return undefined;
  }
  if (
    (serviceUrl.protocol !== "http:" && serviceUrl.protocol !== "https:") ||
    serviceUrl.username.length > 0 ||
    serviceUrl.password.length > 0
  ) {
    setStatus("服务地址必须使用 HTTP 或 HTTPS，且不能包含用户名或密码。");
    return undefined;
  }
  const expectedInstanceId = instanceIdInput.value.trim();
  const requestId = requestIdInput.value.trim();
  const pairingCode = pairingCodeInput.value.trim();
  if (
    !isUuid(expectedInstanceId) ||
    !isUuid(requestId) ||
    !isPairingCode(pairingCode)
  ) {
    setStatus("请填写 TUI 显示的目标实例编号、连接请求编号和限时配对码。");
    return undefined;
  }
  return {
    client: createPublicApiClient({ baseUrl: serviceUrl }),
    serviceAddress: serviceUrl.href,
    permissionOrigin: `${serviceUrl.origin}/*`,
    expectedInstanceId,
    requestId,
    pairingCode,
  };
}

function sameTarget(
  expected: ConnectionTarget,
  actual: ConnectionTarget | undefined,
): boolean {
  return (
    actual !== undefined &&
    expected.serviceAddress === actual.serviceAddress &&
    expected.expectedInstanceId === actual.expectedInstanceId &&
    expected.requestId === actual.requestId &&
    expected.pairingCode === actual.pairingCode
  );
}

function reviewIsCurrent(
  target: ConnectionTarget,
  request: PublicFanboxConnectionRequest,
): boolean {
  return (
    reviewedTarget === target &&
    reviewedRequest === request &&
    sameTarget(target, readTarget())
  );
}

function rejectChangedReview(): void {
  reviewedRequest = undefined;
  reviewedTarget = undefined;
  connectButton.disabled = true;
  scope.hidden = true;
  setStatus("目标信息已更改，请重新检查目标与创作者范围。");
}

function requestOrigins(origins: readonly string[]): Promise<boolean> {
  return chrome.permissions.request({ origins: [...origins] });
}

async function getFanboxCookies(): Promise<readonly Record<string, unknown>[]> {
  const browserCookies = await chrome.cookies.getAll({ domain: "fanbox.cc" });
  return browserCookies.flatMap((cookie) => {
    if (cookie.domain !== "fanbox.cc" && cookie.domain !== ".fanbox.cc")
      return [];
    const sameSite =
      cookie.sameSite === "unspecified"
        ? undefined
        : cookie.sameSite === "no_restriction"
          ? "None"
          : cookie.sameSite === "lax"
            ? "Lax"
            : "Strict";
    return [
      {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        ...(sameSite === undefined ? {} : { sameSite }),
        ...(cookie.expirationDate === undefined
          ? {}
          : { expirationDate: cookie.expirationDate }),
      },
    ];
  });
}

function setScope(request: PublicFanboxConnectionRequest): void {
  scope.hidden = false;
  scope.textContent = `目标实例：${request.instanceId}\n创作者范围：${request.creatorId}\n请求状态：${requestStatus(request.status)}`;
}

function setBusy(value: boolean): void {
  reviewButton.disabled = value;
  if (value) connectButton.disabled = true;
}

function setStatus(message: string): void {
  status.textContent = message;
}

function requestStatus(
  statusValue: PublicFanboxConnectionRequest["status"],
): string {
  switch (statusValue) {
    case "waiting":
      return "等待配对";
    case "verifying":
      return "正在验证";
    case "succeeded":
      return "连接成功";
    case "failed":
      return "验证失败";
    case "cancelled":
      return "已取消";
    case "expired":
      return "已过期";
    case "superseded":
      return "已替代";
  }
}

function clientFailure(error: unknown): string {
  if (error instanceof PublicApiClientError) {
    if (error.kind === "not-found")
      return "服务地址、实例编号或配对信息无效；请核对目标并重新发起请求。";
    if (error.kind === "conflict")
      return "连接状态已变化，请回到 TUI 重新发起连接。";
    if (error.kind === "transport")
      return "无法连接目标服务，请检查服务地址和浏览器权限。";
  }
  return "连接未完成。请核对目标服务状态后重试；浏览器会话不会显示在扩展中。";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function isPairingCode(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function requiredElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (element === null) throw new Error("扩展界面没有完成加载");
  return element;
}

function requiredInput(id: string): HTMLInputElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLInputElement))
    throw new Error("扩展界面输入项无效");
  return element;
}

function requiredButton(id: string): HTMLButtonElement {
  const element = requiredElement(id);
  if (!(element instanceof HTMLButtonElement))
    throw new Error("扩展界面按钮无效");
  return element;
}
