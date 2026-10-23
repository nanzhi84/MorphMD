export const xArticlePropertyRules: Record<string, string> = {
  'heading-level':
    'X Articles 仅支持 H1（header-one）与 H2（header-two）两级标题，h3~h6 粘贴后会丢失标题层级退化为普通正文（参考规范 #1.1 heading-level）',
  'callout-structure':
    'Callout 容器未降级为 <blockquote> 引用块，普通 <div> 容器在 Draft.js convertFromHTML 中会被拍平为无缩进正文（参考规范 #1.2 callout-structure）',
  'unrasterized-table':
    'X Articles 不支持原生 <table> 表格块，裸表格粘贴会导致单元格标签剥离与文字粘连，必须前置光栅化为图像块（参考规范 #1.3 unrasterized-table）',
  'unsupported-element':
    '存在超出 X Articles Draft.js 粘贴白名单的标签或未包裹在 <ul>/<ol> 内的孤立 <li> 节点（参考规范 #1.4 unsupported-element）',
  'unrasterized-math':
    '数学公式节点残留裸 <math> 或 .katex-mathml/.katex-html 双重子树，粘贴至 X Articles 会造成三倍重影乱码，必须光栅化降级（参考规范 #2.1 unrasterized-math）',
  'unrasterized-svg':
    '存在裸 <svg> 矢量节点，X Articles convertFromHTML 会直接丢弃 <svg> 图形，必须前置光栅化为图像块（参考规范 #2.2 unrasterized-svg）',
  'unsafe-media-or-link':
    '图片或超链接包含未就绪协议（如 morph-asset://、blob:、非加密 http: 或危险脚本协议），无法在 X Articles 中安全持久化（参考规范 #2.3 unsafe-media-or-link）',
  'native-inline-style':
    '原生非光栅化文本节点上残留 style 内联样式，X Articles 粘贴时会强制清洗所有行内样式导致所见非所得（参考规范 #3.1 native-inline-style）',
};
