/**
 * 完整日志的持久化脱敏：显式秘密值替换 + Bearer、凭据头与查询参数规则。
 * 与既有旅程 runner 先例一致，但不做长度截断——摘要可以限长，完整日志必须
 * 留在磁盘上。
 */
const bearerPattern = /(Bearer\s+)[^\s]+/giu;
const querySecretPattern =
  /([?&;](?:api[-_]?key|token|key|secret|oauth|cookie|credential)=[^&\s;]+)/giu;
/**
 * 认证与 Cookie 头的值整体就是凭据：`Authorization: Basic …` 的凭据在方案名
 * 之后，`Cookie:` 常带多个键值对，因此隐藏到行尾而不是只吞首个词。
 * Set-Cookie、Proxy-Authorization 等派生头名同样命中。
 */
const headerSecretPattern = /((?:authorization|cookie)\s*:\s*)[^\r\n]*/giu;
const urlCredentialPattern = /(\w{2,16}:\/\/)[^\s/]*:[^\s/]*@/giu;

export type DiagnosticRedactor = {
  /** 对一段完整文本应用全部规则。 */
  (text: string): string;
  /** 增量行脱敏：按行应用规则，未完结行留在内部等待后续 chunk。 */
  write(chunk: string): string;
  end(): string;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function createDiagnosticRedactor(
  explicitSecrets: readonly string[],
): DiagnosticRedactor {
  const secrets = [
    ...new Set(explicitSecrets.filter((value) => value.length > 0)),
  ]
    .toSorted((left, right) => right.length - left.length)
    .map((value) => new RegExp(escapeRegExp(value), "gu"));

  const redact = (text: string): string => {
    let redacted = text;
    for (const secret of secrets)
      redacted = redacted.replaceAll(secret, "[REDACTED]");
    return redacted
      .replace(bearerPattern, "$1[REDACTED]")
      .replace(querySecretPattern, "[REDACTED]")
      .replace(headerSecretPattern, "$1[REDACTED]")
      .replace(urlCredentialPattern, "$1[REDACTED]@");
  };

  let pending = "";
  return Object.assign(redact, {
    write(chunk: string): string {
      const combined = pending + chunk;
      const lines = combined.split("\n");
      pending = lines.pop() ?? "";
      return lines.map(redact).join("\n");
    },
    end(): string {
      const tail = pending;
      pending = "";
      return tail.length > 0 ? redact(tail) : "";
    },
  });
}
