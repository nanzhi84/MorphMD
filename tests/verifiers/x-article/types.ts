export type DraftBlockType =
  | 'header-one'
  | 'header-two'
  | 'unstyled'
  | 'blockquote'
  | 'unordered-list-item'
  | 'ordered-list-item'
  | 'code-block'
  | 'atomic';

export type DraftInlineStyle =
  | 'BOLD'
  | 'ITALIC'
  | 'UNDERLINE'
  | 'STRIKETHROUGH'
  | 'CODE';

export type XArticleRuleKey =
  | 'heading-level'
  | 'callout-structure'
  | 'unrasterized-table'
  | 'unsupported-element'
  | 'unrasterized-math'
  | 'unrasterized-svg'
  | 'unsafe-media-or-link'
  | 'native-inline-style'
  | 'list-depth-exceeded'
  | 'entity-conflict'
  | 'content-loss';

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
  nodeId?: string;
  sourceRange?: string;
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
  /**
   * Maximum allowed list nesting depth (0-indexed). Draft.js RichUtils defaults to 4.
   */
  maxListDepth?: number;
}

export interface XArticleVerifyResult {
  isValid: boolean;
  inValidInfo: Partial<Record<XArticleRuleKey, XArticleViolationEntry>> & Record<string, XArticleViolationEntry>;
  draftState: {
    blocks: DraftJsSimulatedBlock[];
    entityMap: Record<number, DraftJsSimulatedEntity>;
  };
}
