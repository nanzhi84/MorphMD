export type {
  DraftBlockType,
  DraftInlineStyle,
  DraftJsInlineStyleRange,
  DraftJsEntityRange,
  DraftJsSimulatedBlock,
  DraftJsSimulatedEntity,
  XArticleViolationItem,
  XArticleViolationEntry,
  XArticleVerifyOpts,
  XArticleVerifyResult,
} from './types';
export { xArticlePropertyRules } from './rules-text';
export {
  simulateDraftJsConvertFromHtml,
  verifyXArticleStructure,
  verifyXArticleHtml,
} from './verifier';

