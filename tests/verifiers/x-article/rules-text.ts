import type { XArticleRuleKey } from './types';

export const xArticlePropertyRules: Record<XArticleRuleKey, string> = {
  'heading-level':
    'X Articles 仅支持 H1（header-one）与 H2（header-two）两级标题，h3~h6 粘贴后会丢失标题层级退化为普通正文（参考规范 #1.1 heading-level）',
  'callout-structure':
    'Callout 容器未降级为带加粗首段标题的 <blockquote> 引用块、残留 .morph-callout-title/.morph-callout-body 包装层或未清洗 GFM [!NOTE]/[!WARNING] 原始标记，普通 <div> 容器在 Draft.js convertFromHTML 中会被拍平为无缩进正文（参考规范 #1.2 callout-structure）',
  'unrasterized-table':
    'X Articles 不支持原生 <table> 表格块，裸表格或孤立单元格粘贴会导致标签剥离与文字粘连，必须前置光栅化为有效图像块（参考规范 #1.3 unrasterized-table）',
  'unsupported-element':
    '存在超出 X Articles Draft.js 粘贴白名单的标签、孤立 <li>、列表内非 <li> 子节点或非法嵌套块（如嵌套 blockquote / 列表项内嵌套复杂块）（参考规范 #1.4 unsupported-element）',
  'unrasterized-math':
    '数学公式节点残留裸 <math>、.katex-mathml/.katex-html 双重子树或未完成位图替换的 .morph-math 容器，粘贴至 X Articles 会造成重影乱码或空块，必须光栅化降级（参考规范 #2.1 unrasterized-math）',
  'unrasterized-svg':
    '存在裸 <svg> 矢量节点，X Articles convertFromHTML 会直接丢弃 <svg> 图形，必须前置光栅化为有效位图块（参考规范 #2.2 unrasterized-svg）',
  'unsafe-media-or-link':
    '图片或超链接包含未就绪协议（如 morph-asset://、blob:、非加密图片 http:、危险脚本协议）、损坏/空占位位图数据、缺失光栅化 alt 替代文本或冲突属性（参考规范 #2.3 unsafe-media-or-link）',
  'native-inline-style':
    '原生非光栅化文本或容器节点上残留 style 内联样式，X Articles 粘贴时会清洗行内样式导致所见非所得（参考规范 #3.1 native-inline-style）',
  'list-depth-exceeded':
    '列表嵌套深度超出 Draft.js / X Articles 支持上限（depth > 4），深层嵌套列表在粘贴或保存时会被强制拍平（参考规范 #1.5 list-depth-exceeded）',
  'entity-conflict':
    'Draft.js 单个字符位置存在重叠 Entity（如 <a> 内包裹 <img> 导致 LINK 与 IMAGE 实体冲突）或越界区间，违反 CharacterMetadata 单实体契约（参考规范 #4.1 entity-conflict）',
  'content-loss':
    'DOM 转换至 Draft.js ContentState 后发生正文字符丢失、空块坍塌或结构顺序错乱，违反原稿语义零篡改红线（参考规范 #4.2 content-loss）',
};
