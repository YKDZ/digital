/**
 * Read-only consumer inputs for DLsite child renderers. These contracts are
 * deliberately separate from view construction, Information Requirements,
 * fulfillment, and delivery actions so a renderer cannot acquire data or
 * enlarge its parent's demand.
 */
export type DlsiteRendererCreditGroup = {
  readonly heading: string;
  readonly names: readonly string[];
};

/** The compact DLsite card's complete supplied projection. */
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

/** The DLsite detail renderer's complete supplied projection. */
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
