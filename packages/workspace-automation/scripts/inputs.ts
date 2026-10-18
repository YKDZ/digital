import path from "node:path";

/** 路径由工作区入口显式提供，不从本包的物理位置寻找其他包或资源。 */
export function requireInput(name: string): string {
  const value = process.env[name];
  if (value === undefined || !path.isAbsolute(value))
    throw new Error(`工作区入口必须提供绝对路径 ${name}`);
  return value;
}
