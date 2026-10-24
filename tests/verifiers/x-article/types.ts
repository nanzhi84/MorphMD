export type DraftBlockType =
  | 'header-one'
  | 'header-two'
  | 'unstyled'
  | 'blockquote'
  | 'unordered-list-item'
  | 'ordered-list-item'
  | 'code-block'
  | 'atomic';

export type DraftInlineStyle = 'BOLD' | 'ITALIC' | 'STRIKETHROUGH' | 'CODE';

export interface DraftJsInlineStyleRange {
  offset: number;
  length: number;
  style: DraftInlineStyle;
}

export interface DraftJsEntityRange {
  offset: number;
  length: number;
  key: number;
}

export interface DraftJsSimulatedBlock {
  key: string;
  type: DraftBlockType;
  text: string;
  depth: number;
  inlineStyleRanges: DraftJsInlineStyleRange[];
  entityRanges: DraftJsEntityRange[];
  data?: Record<string, unknown>;
}

export interface DraftJsSimulatedEntity {
  type: 'LINK' | 'IMAGE' | 'DIVIDER';
  mutability: 'MUTABLE' | 'IMMUTABLE';
  data: Record<string, unknown>;
}

export interface XArticleViolationItem {
  blockIndex: number;
  outerHTML: string;
  rules: string;
  tagName?: string;
}

export interface XArticleViolationEntry {
  violateRules: string;
  items: XArticleViolationItem[];
}

export interface XArticleVerifyOpts {
  /**
   * Whether `pre.morph-code` blocks are allowed to retain syntax-highlighting inline styles
   * as declared raster candidates. Defaults to true.
   */
  allowCodeBlockStyles?: boolean;
}

export interface XArticleVerifyResult {
  isValid: boolean;
  inValidInfo: Record<string, XArticleViolationEntry>;
  draftState: {
    blocks: DraftJsSimulatedBlock[];
    entityMap: Record<number, DraftJsSimulatedEntity>;
  };
}
