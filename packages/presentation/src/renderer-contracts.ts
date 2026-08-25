/**
 * DLsite 子渲染器的只读消费者输入。这些契约刻意与视图构造、信息需求、履约和交付动作分离，
 * 使渲染器无法获取数据或扩大父级需求。
 */
export type DlsiteRendererCreditGroup = {
  readonly heading: string;
  readonly names: readonly string[];
};

/** 提供给紧凑 DLsite 卡片的完整投影。 */
export type DlsiteCardRendererProjection = {
  readonly id: string;
  readonly dlsite?: {
    readonly title: string;
    readonly cover?: string;
    readonly releaseDate?: string;
    readonly circle?: string;
    readonly priceJpy?: string;
    readonly credits: readonly DlsiteRendererCreditGroup[];
  };
};

/** 提供给 DLsite 详情渲染器的完整投影。 */
export type DlsiteDetailRendererProjection = {
  readonly officialPage?: string;
  readonly dlsite?: {
    readonly title: string;
    readonly cover?: string;
    readonly releaseDate?: string;
    readonly introduction?: string;
    readonly circle?: string;
    readonly priceJpy?: string;
    readonly languages: readonly string[];
    readonly classifications: readonly string[];
    readonly credits: readonly DlsiteRendererCreditGroup[];
    readonly series?: {
      readonly name: string;
      readonly position?: string;
    };
  };
};
