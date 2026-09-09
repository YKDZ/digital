// 接入区原型的内存数据；不是产品契约或领域类型。
export type PrototypeMaterial = {
  id: string;
  name: string;
  folder: string;
  detail: string;
  broken?: boolean;
};

export type PrototypeSourceMatch = {
  source: string;
  identity: string;
  title: string;
  description: string;
};
