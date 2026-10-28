import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { AssetStore } from '../src/core/assets';
import type { AssetPackageManifest } from '../src/core/assets';
import { parseZipArchive } from '../src/core/cards';
import type { CardsZipExportResult } from '../src/core/cards';
import type { ClipboardPayload } from '../src/core/selection';
import { createEditorSession, EditorSessionController } from '../src/core/session';
import type { TargetId } from '../src/core/snapshot';
import { assetStore, documentOf, evidence } from './support/contracts';
import { png } from './support/fixtures';

interface MountedWorkbench {
  container: HTMLElement;
  root: Root;
  store: AssetStore;
  session?: EditorSessionController;
  unmount: () => Promise<void>;
}

interface MountWorkbenchOptions {
  initialMarkdown?: string;
  initialTargetId?: TargetId;
  initialDrawerOpen?: boolean;
  session?: EditorSessionController;
  assetStore?: AssetStore;
  debounceMs?: number;
  onCopyPayload?: (payload: ClipboardPayload) => void;
  onExportPackage?: (manifest: AssetPackageManifest) => void;
  onExportCardsZip?: (result: CardsZipExportResult) => void;
}

let activeDom: JSDOM | null = null;
const mountedInstances: MountedWorkbench[] = [];

function installDomGlobals(dom: JSDOM): void {
  const win = dom.window;

  if (typeof globalThis.URL?.createObjectURL === 'function') {
    win.URL.createObjectURL = globalThis.URL.createObjectURL.bind(globalThis.URL);
  }
  if (typeof globalThis.URL?.revokeObjectURL === 'function') {
    win.URL.revokeObjectURL = globalThis.URL.revokeObjectURL.bind(globalThis.URL);
  }

  win.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(Date.now()), 0) as unknown as number);
  win.cancelAnimationFrame = ((id: number) => {
    clearTimeout(id);
  });

  const globalsToInstall: Record<string, unknown> = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    HTMLSelectElement: win.HTMLSelectElement,
    HTMLButtonElement: win.HTMLButtonElement,
    Element: win.Element,
    Node: win.Node,
    Text: win.Text,
    Range: win.Range,
    Selection: win.Selection,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    MouseEvent: win.MouseEvent,
    KeyboardEvent: win.KeyboardEvent,
    DOMParser: win.DOMParser,
    XMLSerializer: win.XMLSerializer,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    IS_REACT_ACT_ENVIRONMENT: true,
  };

  for (const [key, value] of Object.entries(globalsToInstall)) {
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
}

beforeEach(() => {
  activeDom = new JSDOM(
    '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="app-root"></div></body></html>',
    {
      url: 'https://morph.test/',
      pretendToBeVisual: true,
    }
  );
  installDomGlobals(activeDom);
});

afterEach(async () => {
  while (mountedInstances.length > 0) {
    const instance = mountedInstances.pop()!;
    await instance.unmount();
  }
  if (activeDom) {
    activeDom.window.close();
    activeDom = null;
  }
});

async function flushWorkbench(session?: EditorSessionController, waitMs = 35): Promise<void> {
  await act(async () => {
    if (session) {
      await session.flush();
      await session.waitForIdle();
      session.flushRenderFrame();
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    if (session) {
      await session.waitForIdle();
      session.flushRenderFrame();
    }
  });
}

async function mountWorkbench(options: MountWorkbenchOptions = {}): Promise<MountedWorkbench> {
  const container = document.getElementById('app-root')!;
  const store = options.assetStore ?? assetStore();
  const root = createRoot(container);
  const props = {
    debounceMs: 10,
    assetStore: store,
    ...options,
  };

  await act(async () => {
    root.render(React.createElement(App as React.ComponentType<any>, props));
  });
  await flushWorkbench(options.session, 40);

  const mounted: MountedWorkbench = {
    container,
    root,
    store,
    session: options.session,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      options.session?.dispose();
    },
  };
  mountedInstances.push(mounted);
  return mounted;
}

function getByTestId<T extends HTMLElement = HTMLElement>(
  container: HTMLElement,
  testId: string
): T {
  const el = container.querySelector<T>(`[data-testid="${testId}"]`);
  expect(el, `Expected element [data-testid="${testId}"] to exist`).not.toBeNull();
  return el!;
}

function isDrawerOpen(container: HTMLElement): boolean {
  const drawer = container.querySelector<HTMLElement>('[data-testid="style-drawer"]');
  if (!drawer) return false;
  if (
    drawer.hidden ||
    drawer.getAttribute('aria-hidden') === 'true' ||
    drawer.getAttribute('data-open') === 'false'
  ) {
    return false;
  }
  return true;
}

async function clickTestId(
  container: HTMLElement,
  testId: string,
  session?: EditorSessionController
): Promise<HTMLElement> {
  const el = getByTestId(container, testId);
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await flushWorkbench(session);
  return el;
}

async function setControlValue(
  container: HTMLElement,
  testId: string,
  value: string,
  session?: EditorSessionController
): Promise<HTMLElement> {
  const el = getByTestId(container, testId);
  await act(async () => {
    const proto =
      el instanceof window.HTMLTextAreaElement
        ? window.HTMLTextAreaElement.prototype
        : el instanceof window.HTMLSelectElement
          ? window.HTMLSelectElement.prototype
          : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor?.set) {
      descriptor.set.call(el, value);
    } else {
      (el as HTMLInputElement).value = value;
    }
    el.dispatchEvent(new window.Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new window.Event('change', { bubbles: true, cancelable: true }));
  });
  await flushWorkbench(session);
  return el;
}

describe('TestWorkbenchLayoutAndTheme', () => {
  it('test_initial_workbench_mounts_three_column_regions_and_single_h1_brand_header', async () => {
    const { container } = await mountWorkbench();

    const header = getByTestId(container, 'workbench-header');
    const editorPane = getByTestId(container, 'editor-pane');
    const previewPane = getByTestId(container, 'preview-pane');
    const styleDrawer = getByTestId(container, 'style-drawer');
    const statusBar = getByTestId(container, 'workbench-statusbar');

    expect(editorPane).toBeTruthy();
    expect(previewPane).toBeTruthy();
    expect(styleDrawer).toBeTruthy();
    expect(statusBar).toBeTruthy();

    const brandTitle = getByTestId(header, 'brand-title');
    expect(brandTitle.tagName).toBe('H1');
    expect(brandTitle.textContent).toContain('MorphMD');
    expect(header.querySelectorAll('h1')).toHaveLength(1);

    const wechatTab = getByTestId(header, 'target-tab-wechat');
    const xTab = getByTestId(header, 'target-tab-x-article');
    const cardsTab = getByTestId(header, 'target-tab-cards');
    expect(wechatTab.getAttribute('aria-pressed')).toBe('true');
    expect(xTab.getAttribute('aria-pressed')).toBe('false');
    expect(cardsTab.getAttribute('aria-pressed')).toBe('false');

    const previewStage = getByTestId(previewPane, 'preview-stage');
    expect(previewStage.getAttribute('data-target-view')).toBe('wechat');
    expect(previewStage.innerHTML.length).toBeGreaterThan(20);
    expect(previewStage.querySelector('.morph-doc')).not.toBeNull();
  });

  it('test_style_drawer_omits_tabs_and_renders_only_custom_css_panel_with_single_anthropic_preset', async () => {
    const { container } = await mountWorkbench();

    expect(container.querySelector('[data-testid="style-tab-theme"]')).toBeNull();
    expect(container.querySelector('[data-testid="style-tab-typography"]')).toBeNull();
    expect(container.querySelector('[data-testid="style-tab-css"]')).toBeNull();
    expect(container.querySelector('[data-testid="style-panel-theme"]')).toBeNull();
    expect(container.querySelector('[data-testid="style-panel-typography"]')).toBeNull();

    const cssPanel = getByTestId(container, 'style-panel-css');
    expect(cssPanel.hidden).toBe(false);
    expect(cssPanel.getAttribute('aria-hidden')).not.toBe('true');
    expect(cssPanel.getAttribute('data-view-mode')).toBe('list');

    const presetItems = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid^="css-preset-item-"]')
    );
    expect(presetItems).toHaveLength(2);
    expect(getByTestId(container, 'css-preset-item-default')).toBeTruthy();
    expect(getByTestId(container, 'css-preset-item-yoryon')).toBeTruthy();
    expect(container.querySelector('[data-testid="css-preset-item-reading"]')).toBeNull();
    expect(container.querySelector('[data-testid="css-preset-item-minimal"]')).toBeNull();
    expect(container.querySelector('[data-testid="css-preset-item-editorial"]')).toBeNull();
  });

  it('test_toggle_and_close_style_drawer_buttons_control_right_drawer_visibility', async () => {
    const { container } = await mountWorkbench({ initialDrawerOpen: true });

    expect(isDrawerOpen(container)).toBe(true);

    const closeBtn = container.querySelector<HTMLElement>('[data-testid="close-style-drawer-btn"]');
    if (closeBtn) {
      await clickTestId(container, 'close-style-drawer-btn');
      expect(isDrawerOpen(container)).toBe(false);

      await clickTestId(container, 'toggle-style-drawer-btn');
      expect(isDrawerOpen(container)).toBe(true);
    }

    await clickTestId(container, 'toggle-style-drawer-btn');
    expect(isDrawerOpen(container)).toBe(false);

    await clickTestId(container, 'toggle-style-drawer-btn');
    expect(isDrawerOpen(container)).toBe(true);
  });

  it('test_dragging_column_resizers_dynamically_adjusts_editor_and_style_drawer_widths', async () => {
    const { container } = await mountWorkbench({ initialDrawerOpen: true });

    const editorPane = getByTestId(container, 'editor-pane');
    const styleDrawer = getByTestId(container, 'style-drawer');
    const resizerLeft = getByTestId(container, 'resizer-editor-preview');
    const resizerRight = getByTestId(container, 'resizer-preview-drawer');

    const initialEditorWidth = parseInt(editorPane.style.width || '0', 10);
    const initialDrawerWidth = parseInt(styleDrawer.style.width || '0', 10);
    expect(initialEditorWidth).toBeGreaterThanOrEqual(300);
    expect(initialDrawerWidth).toBeGreaterThanOrEqual(360);

    await act(async () => {
      resizerLeft.dispatchEvent(
        new window.MouseEvent('mousedown', { clientX: 420, bubbles: true, cancelable: true })
      );
      window.dispatchEvent(
        new window.MouseEvent('mousemove', { clientX: 500, bubbles: true, cancelable: true })
      );
      window.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    });
    expect(parseInt(editorPane.style.width || '0', 10)).toBeGreaterThan(initialEditorWidth);

    await act(async () => {
      resizerRight.dispatchEvent(
        new window.MouseEvent('mousedown', { clientX: 1000, bubbles: true, cancelable: true })
      );
      window.dispatchEvent(
        new window.MouseEvent('mousemove', { clientX: 920, bubbles: true, cancelable: true })
      );
      window.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    });
    expect(parseInt(styleDrawer.style.width || '0', 10)).toBeGreaterThan(initialDrawerWidth);
  });
});

describe('TestTargetSwitchingAndCardsReflow', () => {
  it('test_switching_target_tabs_updates_aria_pressed_preview_stage_adapter_status_and_primary_cta', async () => {
    const { container } = await mountWorkbench({
      initialMarkdown:
        '# 跨端同构发布\n\n支持公众号、X 长文与 [MorphMD 卡片](https://morphmd.dev)。',
    });

    const wechatTab = getByTestId(container, 'target-tab-wechat');
    const xTab = getByTestId(container, 'target-tab-x-article');
    const cardsTab = getByTestId(container, 'target-tab-cards');
    const previewStage = getByTestId(container, 'preview-stage');
    const primaryBtn = getByTestId(container, 'primary-delivery-btn');
    const adapterInfo = getByTestId(container, 'status-adapter-info');

    expect(wechatTab.getAttribute('aria-pressed')).toBe('true');
    expect(previewStage.getAttribute('data-target-view')).toBe('wechat');
    expect(primaryBtn.textContent).toContain('复制富文本');
    expect(adapterInfo.textContent?.length).toBeGreaterThan(0);

    await clickTestId(container, 'target-tab-x-article');
    expect(xTab.getAttribute('aria-pressed')).toBe('true');
    expect(wechatTab.getAttribute('aria-pressed')).toBe('false');
    expect(previewStage.getAttribute('data-target-view')).toBe('x-article');
    expect(primaryBtn.textContent).toContain('复制富文本');
    expect(previewStage.querySelector('a[href="https://morphmd.dev"]')).not.toBeNull();

    await clickTestId(container, 'target-tab-cards');
    expect(cardsTab.getAttribute('aria-pressed')).toBe('true');
    expect(xTab.getAttribute('aria-pressed')).toBe('false');
    expect(previewStage.getAttribute('data-target-view')).toBe('cards');
    expect(primaryBtn.textContent).toContain('导出高清卡片');
    expect(previewStage.querySelectorAll('.morph-card-page').length).toBeGreaterThanOrEqual(1);
    expect(previewStage.querySelector('.morph-card-page a[href="https://morphmd.dev"]')).toBeNull();
    const cardLinkText = previewStage.querySelector<HTMLElement>(
      '.morph-card-page .morph-link-text[data-original-href="https://morphmd.dev"]'
    );
    expect(cardLinkText).not.toBeNull();
    expect(cardLinkText!.textContent).toBe('MorphMD 卡片 (https://morphmd.dev)');
    const cardLinkUrl = cardLinkText!.querySelector<HTMLElement>('.morph-link-url.link-url');
    expect(cardLinkUrl).not.toBeNull();
    expect(cardLinkUrl!.textContent).toBe(' (https://morphmd.dev)');
  });

  it('test_changing_canvas_preset_in_cards_view_reflows_card_pages_across_all_aspect_ratios', async () => {
    const { container } = await mountWorkbench({
      initialTargetId: 'cards',
      initialMarkdown: [
        '# 多比例卡片排版',
        '',
        '第一段正文内容，用于验证不同画布比例下的卡片容器尺寸与自动分页。',
        '',
        '## 第二小节',
        '',
        '- 列表项 A',
        '- 列表项 B',
      ].join('\n'),
    });

    const previewStage = getByTestId(container, 'preview-stage');
    expect(previewStage.getAttribute('data-target-view')).toBe('cards');
    expect(previewStage.getAttribute('data-card-ratio')).toBe('3:4');

    const expectedGeometries: Array<{ ratio: string; width: string; height: string }> = [
      { ratio: '3:4', width: '720px', height: '960px' },
      { ratio: '4:5', width: '720px', height: '900px' },
      { ratio: '1:1', width: '720px', height: '720px' },
      { ratio: '16:9', width: '960px', height: '540px' },
    ];

    for (const expected of expectedGeometries) {
      await setControlValue(container, 'canvas-preset-select', expected.ratio);
      expect(previewStage.getAttribute('data-card-ratio')).toBe(expected.ratio);

      const pageEl = previewStage.querySelector<HTMLElement>('.morph-card-page');
      expect(pageEl).not.toBeNull();
      expect(pageEl!.getAttribute('data-ratio')).toBe(expected.ratio);
      expect(pageEl!.style.width).toBe(expected.width);
      expect(pageEl!.style.height).toBe(expected.height);
    }
  });

  it('test_x_article_preview_stage_applies_platform_blockquote_border_style_without_inline_style_leakage', async () => {
    const cssText = readFileSync(resolve(__dirname, '../src/styles/workbench.css'), 'utf-8');
    const styleEl = document.createElement('style');
    styleEl.textContent = cssText;
    document.head.appendChild(styleEl);

    const { container } = await mountWorkbench({
      initialTargetId: 'x-article',
      initialMarkdown: [
        '# 让内容自由流动',
        '',
        '> 写一次，自由发布。让优秀的内容被更多人看见。',
      ].join('\n'),
    });

    const previewStage = getByTestId(container, 'preview-stage');
    expect(previewStage.getAttribute('data-target-view')).toBe('x-article');

    const blockquote = previewStage.querySelector<HTMLElement>('blockquote.morph-quote');
    expect(blockquote).not.toBeNull();
    expect(blockquote!.textContent).toContain('写一次，自由发布。让优秀的内容被更多人看见。');
    expect(blockquote!.getAttribute('style') ?? '').toBe('');

    const computed = window.getComputedStyle(blockquote!);
    expect(computed.borderLeftStyle).toBe('solid');
    expect(parseFloat(computed.borderLeftWidth)).toBeGreaterThan(0);
    expect(computed.marginLeft).toBe('0px');
  });
});

describe('TestEditorInputToolbarAndAssetPaste', () => {
  it('test_editing_markdown_input_updates_preview_footer_stats_without_format_toolbar_buttons', async () => {
    const { container } = await mountWorkbench({
      initialMarkdown: '# 初始标题',
    });

    await setControlValue(
      container,
      'markdown-input',
      '# 实时更新标题\n\n第二行新增正文段落。\n\n第三行补充内容。'
    );

    const previewStage = getByTestId(container, 'preview-stage');
    expect(previewStage.querySelector('h1')?.textContent).toBe('实时更新标题');
    expect(previewStage.textContent).toContain('第二行新增正文段落。');

    const lineNumbers = getByTestId(container, 'editor-line-numbers');
    expect(lineNumbers.textContent).toContain('5');

    const footer = getByTestId(container, 'editor-footer');
    expect(footer.textContent).toBeTruthy();

    expect(container.querySelector('.morph-format-toolbar')).toBeNull();
    for (const testId of [
      'toolbar-insert-image',
      'toolbar-insert-link',
      'toolbar-insert-table',
      'toolbar-insert-ul',
      'toolbar-insert-ol',
      'toolbar-insert-code',
    ]) {
      expect(container.querySelector(`[data-testid="${testId}"]`)).toBeNull();
    }
  });

  it('test_undo_and_redo_buttons_revert_and_restore_committed_document_states', async () => {
    const store = assetStore();
    const session = createEditorSession({
      assetStore: store,
      initialMarkdown: '# 历史状态一',
      debounceMs: 10,
    });

    const { container } = await mountWorkbench({
      session,
      assetStore: store,
      debounceMs: 10,
    });

    const previewStage = getByTestId(container, 'preview-stage');
    expect(previewStage.textContent).toContain('历史状态一');

    await setControlValue(
      container,
      'markdown-input',
      '# 历史状态二\n\n新增的可撤销段落。',
      session
    );
    expect(previewStage.textContent).toContain('历史状态二');

    await clickTestId(container, 'undo-btn', session);
    const markdownInput = getByTestId<HTMLTextAreaElement>(container, 'markdown-input');
    expect(markdownInput.value).toContain('历史状态一');
    expect(previewStage.textContent).toContain('历史状态一');

    await clickTestId(container, 'redo-btn', session);
    expect(markdownInput.value).toContain('历史状态二');
    expect(previewStage.textContent).toContain('历史状态二');
  });

  it('test_pasting_image_file_into_editor_ingests_into_asset_store_and_inserts_morph_asset_uri', async () => {
    const store = assetStore();
    const session = createEditorSession({
      assetStore: store,
      initialMarkdown: '# 贴图测试\n\n',
      debounceMs: 10,
    });

    const { container } = await mountWorkbench({
      session,
      assetStore: store,
      debounceMs: 10,
    });

    const markdownInput = getByTestId<HTMLTextAreaElement>(container, 'markdown-input');
    const rawPng = png(1, 24, 16);
    const imageFile = new File([new Uint8Array(rawPng)], 'clipboard-chart.png', {
      type: 'image/png',
    });

    await act(async () => {
      const pasteEvent = new window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, 'clipboardData', {
        value: {
          files: [imageFile],
          items: [
            {
              kind: 'file',
              type: 'image/png',
              getAsFile: () => imageFile,
            },
          ],
          getData: () => '',
        },
      });
      markdownInput.dispatchEvent(pasteEvent);
    });
    await flushWorkbench(session, 60);

    expect(markdownInput.value).toMatch(/morph-asset:\/\/[a-zA-Z0-9_-]+/);
    expect(markdownInput.value).not.toContain('data:image/png;base64,');

    const previewStage = getByTestId(container, 'preview-stage');
    const renderedImg = previewStage.querySelector<HTMLImageElement>('img');
    expect(renderedImg).not.toBeNull();
    expect(renderedImg!.getAttribute('src')).toMatch(/^data:image\/png;base64,/);

    const statusAssetCount = getByTestId(container, 'status-asset-count');
    expect(statusAssetCount.textContent).toMatch(/[1-9]/);
  });
});

describe('TestStyleDrawerCustomization', () => {
  it('test_default_anthropic_editorial_preset_applies_warm_paper_serif_headings_italic_quote_and_academic_table', async () => {
    const store = assetStore();
    const cover = await store.ingest(png(5, 24, 16), { fileName: 'editorial-cover.png' });
    const markdown = [
      '# 一级社论标题',
      '',
      '## 二级章节标题',
      '',
      '### 三级小节标题',
      '',
      '#### 四级无衬线小标题',
      '',
      '正文包含 **核心加粗重点**、*强调文本*、`inline_token` 与 [Anthropic Research](https://anthropic.com)。',
      '',
      '> 学术与社论风正体衬线引文，左侧赤陶色竖线装饰。',
      '',
      '> [!TIP] 样式内联提示',
      '> 提示正文段落。',
      '',
      '```ts',
      'const model = "claude";',
      '```',
      '',
      '| 评估维度 | 基准得分 |',
      '| :--- | :--- |',
      '| 排版还原度 | `99.8%` |',
      '',
      '---',
      '',
      `![社论配图](${cover.uri})`,
    ].join('\n');

    const { container } = await mountWorkbench({
      assetStore: store,
      initialMarkdown: markdown,
    });

    const previewStage = getByTestId(container, 'preview-stage');
    const docEl = previewStage.querySelector<HTMLElement>('.morph-doc');
    expect(docEl).not.toBeNull();
    // 1. No local #FAF8F5 background box on .morph-doc
    expect(docEl!.style.backgroundColor.toLowerCase()).not.toMatch(
      /#faf8f5|rgb\(250,\s*248,\s*245\)/
    );
    expect(['', 'transparent', '#ffffff', 'rgb(255, 255, 255)']).toContain(
      docEl!.style.backgroundColor.toLowerCase()
    );
    expect(docEl!.style.color.toLowerCase()).toMatch(/#1f1e1d|rgb\(31,\s*30,\s*29\)/);
    expect(docEl!.style.fontSize).toBe('15px');
    expect(docEl!.style.lineHeight).toBe('1.75');
    expect(docEl!.style.letterSpacing).toBe('0.01em');
    expect(docEl!.style.fontFamily.replace(/^["']|["']$/g, '')).toMatch(/^Inter\b/);

    // 2. Chinese & English Typography Hierarchy (h1, h2, h3, strong, em, blockquote)
    const h1 = previewStage.querySelector<HTMLElement>('h1.morph-h1');
    const h2 = previewStage.querySelector<HTMLElement>('h2.morph-h2');
    const h3 = previewStage.querySelector<HTMLElement>('h3.morph-h3');
    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
    expect(h3).not.toBeNull();

    expect(h1!.style.fontFamily).toContain('Newsreader');
    expect(h1!.style.fontFamily).toContain('Noto Serif SC');
    expect(h1!.style.fontFamily.replace(/^["']|["']$/g, '')).toMatch(/^Newsreader\b/);
    expect(h1!.style.fontSize).toBe('24px');
    expect(h1!.style.lineHeight).toBe('1.35');
    expect(h1!.style.fontWeight).toBe('500');
    expect(h1!.style.letterSpacing).toBe('-0.01em');
    expect(h1!.style.marginTop).toBe('0px');
    expect(h1!.style.marginBottom).toBe('22px');
    expect(h1!.style.color.toLowerCase()).toMatch(/#141413|rgb\(20,\s*20,\s*19\)/);

    expect(h2!.style.fontFamily).toContain('Newsreader');
    expect(h2!.style.fontFamily).toContain('Noto Serif SC');
    expect(h2!.style.fontSize).toBe('20px');
    expect(h2!.style.lineHeight).toBe('1.4');
    expect(h2!.style.fontWeight).toBe('500');
    expect(h2!.style.letterSpacing).toBe('-0.01em');
    expect(h2!.style.marginTop).toBe('28px');
    expect(h2!.style.marginBottom).toBe('16px');

    expect(h3!.style.fontFamily).toContain('Inter');
    expect(h3!.style.fontSize).toBe('17px');
    expect(h3!.style.lineHeight).toBe('1.45');
    expect(h3!.style.fontWeight).toBe('600');
    expect(h3!.style.marginTop).toBe('22px');
    expect(h3!.style.marginBottom).toBe('12px');

    const bodyPara = previewStage.querySelector<HTMLElement>('p.morph-p');
    expect(bodyPara).not.toBeNull();
    expect(bodyPara!.style.fontSize).toBe('15px');
    expect(bodyPara!.style.lineHeight).toBe('1.75');
    expect(bodyPara!.style.fontFamily).toContain('Inter');
    expect(bodyPara!.style.color.toLowerCase()).toMatch(/#1f1e1d|rgb\(31,\s*30,\s*29\)/);

    const strong = previewStage.querySelector<HTMLElement>('p strong');
    expect(strong).not.toBeNull();
    expect(strong!.style.fontWeight).toBe('600');
    expect(strong!.style.color.toLowerCase()).toMatch(/#141413|rgb\(20,\s*20,\s*19\)/);

    const em = previewStage.querySelector<HTMLElement>('p em');
    expect(em).not.toBeNull();
    expect(em!.style.fontStyle).toBe('normal');
    expect(em!.style.fontFamily).toContain('LXGW WenKai');
    expect(em!.style.fontFamily).toContain('Kaiti SC');
    expect(['', 'none']).toContain(em!.style.borderBottom || em!.style.borderBottomStyle || '');
    expect(em!.style.color.toLowerCase()).toMatch(/#32383f|rgb\(50,\s*56,\s*63\)/);

    expect(previewStage.querySelector('p a')).toBeNull();
    const linkText = previewStage.querySelector<HTMLElement>('p .morph-link-text');
    expect(linkText).not.toBeNull();
    expect(linkText!.getAttribute('data-original-href')).toBe('https://anthropic.com');
    expect(linkText!.textContent).toBe('Anthropic Research (https://anthropic.com)');
    expect(linkText!.style.color.toLowerCase()).toMatch(
      /#b85a3a|#c86446|rgb\(184,\s*90,\s*58\)|rgb\(200,\s*100,\s*70\)/
    );
    const linkUrl = linkText!.querySelector<HTMLElement>('.morph-link-url.link-url');
    expect(linkUrl).not.toBeNull();
    expect(linkUrl!.tagName).toBe('SPAN');
    expect(linkUrl!.textContent).toBe(' (https://anthropic.com)');
    expect(linkUrl!.style.color.toLowerCase()).toMatch(/#8c857b|rgb\(140,\s*133,\s*123\)/);
    expect(linkUrl!.style.fontSize).toMatch(/^(0\.85em|12\.75px)$/i);
    expect(linkUrl!.style.fontFamily).toMatch(/JetBrains Mono|SF Mono|monospace/i);

    const quote = previewStage.querySelector<HTMLElement>('.morph-quote');
    expect(quote).not.toBeNull();
    expect(quote!.tagName).toBe('P');
    expect(previewStage.querySelector('blockquote.morph-quote')).toBeNull();
    expect(quote!.querySelectorAll('p, div, section, blockquote')).toHaveLength(0);
    expect(quote!.style.fontStyle).toBe('normal');
    expect(quote!.style.fontFamily).toContain('Newsreader');
    expect(quote!.style.fontFamily).toContain('Noto Serif SC');
    expect((quote!.style.borderLeft || quote!.style.borderLeftColor).toLowerCase()).toMatch(
      /#c86446|rgb\(200,\s*100,\s*70\)/
    );
    expect(quote!.style.borderLeftWidth || quote!.style.borderLeft).toContain('2px');
    expect(quote!.style.color.toLowerCase()).toMatch(/#3d3c3a|rgb\(61,\s*60,\s*58\)/);
    expect(quote!.style.marginTop).toBe('0px');
    expect(quote!.style.marginBottom).toBe('20px');
    expect(quote!.style.marginLeft).toBe('0px');
    expect(quote!.style.marginRight).toBe('0px');

    const quotePara = quote!.querySelector<HTMLElement>('.morph-p');
    expect(quotePara).not.toBeNull();
    expect(quotePara!.tagName).toBe('SPAN');
    expect(quotePara!.style.fontFamily).toContain('Newsreader');
    expect(quotePara!.style.fontFamily).toContain('Noto Serif SC');
    expect(quotePara!.style.fontSize).toBe('15px');
    expect(quotePara!.style.lineHeight).toBe('1.7');
    expect(quotePara!.style.color.toLowerCase()).toMatch(/#3d3c3a|rgb\(61,\s*60,\s*58\)/);

    // 3. Inline code, Code block, and Callout
    const inlineCode = previewStage.querySelector<HTMLElement>('p > code');
    const codeBlock = previewStage.querySelector<HTMLElement>('pre.morph-code');
    expect(inlineCode).not.toBeNull();
    expect(codeBlock).not.toBeNull();
    expect(inlineCode!.style.fontFamily).toContain('JetBrains Mono');
    expect(inlineCode!.style.fontFamily.replace(/^["']|["']$/g, '')).toMatch(/^JetBrains Mono\b/);
    expect(inlineCode!.style.backgroundColor.toLowerCase()).toMatch(
      /#eae6df|rgb\(234,\s*230,\s*223\)/
    );
    expect(inlineCode!.style.whiteSpace).toBe('nowrap');

    expect(codeBlock!.style.fontFamily).toContain('JetBrains Mono');
    expect(codeBlock!.style.fontFamily.replace(/^["']|["']$/g, '')).toMatch(/^JetBrains Mono\b/);
    expect(codeBlock!.style.backgroundColor.toLowerCase()).toMatch(
      /#f2efe9|rgb\(242,\s*239,\s*233\)/
    );
    expect(codeBlock!.style.whiteSpace).toBe('pre');
    expect(codeBlock!.style.textAlign).toBe('left');
    expect(codeBlock!.style.wordBreak).toBe('normal');
    expect(codeBlock!.style.overflowWrap).toBe('normal');
    expect(codeBlock!.style.fontSize).toBe('13px');

    const callout = previewStage.querySelector<HTMLElement>('.morph-callout');
    expect(callout).not.toBeNull();
    expect(callout!.tagName).toBe('P');
    expect(callout!.querySelectorAll('p, div, section')).toHaveLength(0);
    expect(callout!.querySelector(':scope > br')).not.toBeNull();
    expect(callout!.style.marginTop).toBe('0px');
    expect(callout!.style.marginBottom).toBe('16px');
    expect(callout!.previousSibling?.nodeType).toBe(window.Node.ELEMENT_NODE);
    expect(callout!.nextSibling?.nodeType).toBe(window.Node.ELEMENT_NODE);
    expect(callout!.style.backgroundColor.toLowerCase()).toMatch(
      /#f2efe9|rgb\(242,\s*239,\s*233\)/
    );
    expect(callout!.style.borderRadius).toBe('0px 8px 8px 0px');
    expect(callout!.style.borderLeftWidth || callout!.style.borderLeft).toContain('3px');
    expect((callout!.style.borderLeft || callout!.style.borderLeftColor).toLowerCase()).toMatch(
      /#c86446|rgb\(200,\s*100,\s*70\)/
    );
    expect(callout!.style.fontFamily).toContain('Inter');
    expect(callout!.style.fontSize).toBe('14.5px');
    expect(callout!.style.lineHeight).toBe('1.65');

    const calloutTitle = callout!.querySelector<HTMLElement>('.morph-callout-title');
    expect(calloutTitle).not.toBeNull();
    expect(calloutTitle!.tagName).toBe('SPAN');
    const calloutTitleText = calloutTitle!.querySelector<HTMLElement>('.morph-callout-title-text');
    expect(calloutTitleText).not.toBeNull();
    expect(calloutTitleText!.style.fontWeight).toBe('600');

    const calloutBody = callout!.querySelector<HTMLElement>('.morph-callout-body');
    expect(calloutBody).not.toBeNull();
    expect(calloutBody!.tagName).toBe('SPAN');
    const calloutPara = calloutBody!.querySelector<HTMLElement>('.morph-p');
    expect(calloutPara).not.toBeNull();
    expect(calloutPara!.tagName).toBe('SPAN');
    expect(calloutPara!.style.fontFamily).toContain('Inter');
    expect(calloutPara!.style.fontSize).toBe('14.5px');
    expect(calloutPara!.style.lineHeight).toBe('1.65');
    for (const child of Array.from(calloutBody!.childNodes)) {
      if (child.nodeType === window.Node.TEXT_NODE) {
        expect((child.textContent || '').trim().length).toBeGreaterThan(0);
      }
    }

    const table = previewStage.querySelector<HTMLElement>('table.morph-table');
    expect(table).not.toBeNull();
    expect(table!.style.fontSize).toBe('13px');
    const th = table!.querySelector<HTMLElement>('th');
    const td = table!.querySelector<HTMLElement>('td');
    expect(th).not.toBeNull();
    expect(td).not.toBeNull();
    expect(th!.style.padding).toBe('8px 6px');
    expect(td!.style.padding).toBe('8px 6px');
    const tableCode = table!.querySelector<HTMLElement>('code');
    expect(tableCode).not.toBeNull();
    expect(tableCode!.style.fontSize).toBe('12px');
    expect(tableCode!.style.whiteSpace).toBe('normal');
    expect((th!.style.borderBottom || th!.style.borderBottomColor).toLowerCase()).toMatch(
      /#141413|rgb\(20,\s*20,\s*19\)/
    );
    expect(th!.style.borderBottomWidth || th!.style.borderBottom).toContain('2px');
    expect((td!.style.borderBottom || td!.style.borderBottomColor).toLowerCase()).toMatch(
      /#e2dfd7|rgb\(226,\s*223,\s*215\)/
    );
    expect(td!.style.borderBottomWidth || td!.style.borderBottom).toContain('1px');

    for (const cell of [th!, td!]) {
      const topSpec = cell.style.borderTop || cell.style.borderTopStyle || cell.style.borderTopWidth;
      const leftSpec = cell.style.borderLeft || cell.style.borderLeftStyle || cell.style.borderLeftWidth;
      const rightSpec = cell.style.borderRight || cell.style.borderRightStyle || cell.style.borderRightWidth;
      expect(topSpec).toMatch(/none|0px|^0$/i);
      expect(leftSpec).toMatch(/none|0px|^0$/i);
      expect(rightSpec).toMatch(/none|0px|^0$/i);
    }

    const img = previewStage.querySelector<HTMLElement>('img.morph-img');
    expect(img).not.toBeNull();
    expect(img!.style.borderRadius).toBe('6px');
  });

  it('test_clicking_single_preset_drills_down_to_css_editor_and_creating_new_custom_css_preset_updates_preview', async () => {
    const isPanelVisible = (root: HTMLElement, testId: string): boolean => {
      const panel = root.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      if (!panel) return false;
      if (
        panel.hidden ||
        panel.getAttribute('aria-hidden') === 'true' ||
        panel.style.display === 'none'
      ) {
        return false;
      }
      return true;
    };

    const { container } = await mountWorkbench({
      initialMarkdown:
        '# 样式抽屉单面板验证\n\n## 二级标题装饰测试\n\n> 引用块容器测试\n\n正文段落包含 **高亮重点** 文本内容。',
    });

    const previewStage = getByTestId(container, 'preview-stage');
    const cssPanel = getByTestId(container, 'style-panel-css');
    expect(isPanelVisible(container, 'style-panel-css')).toBe(true);
    expect(cssPanel.getAttribute('data-view-mode')).toBe('list');
    expect(getByTestId(cssPanel, 'css-list-view')).toBeTruthy();
    expect(getByTestId(cssPanel, 'css-preset-list')).toBeTruthy();
    expect(getByTestId(cssPanel, 'css-preset-item-default')).toBeTruthy();
    expect(getByTestId(cssPanel, 'css-preset-item-yoryon')).toBeTruthy();
    expect(cssPanel.querySelectorAll('[data-testid^="css-preset-item-"]')).toHaveLength(2);

    // Click default preset item -> slide into editor drilldown view
    await clickTestId(container, 'css-preset-item-default');
    expect(cssPanel.getAttribute('data-view-mode')).toBe('editor');
    expect(getByTestId(cssPanel, 'css-drilldown-view')).toBeTruthy();
    expect(getByTestId(cssPanel, 'toggle-css-guide-btn')).toBeTruthy();

    const presetNameInput = getByTestId<HTMLInputElement>(cssPanel, 'css-preset-name-input');
    const customCssInput = getByTestId<HTMLTextAreaElement>(cssPanel, 'custom-css-input');
    expect(presetNameInput.value.trim().length).toBeGreaterThan(0);
    expect(customCssInput.value).toContain('Newsreader');

    await clickTestId(container, 'toggle-css-guide-btn');
    const guideModal = getByTestId(container, 'css-guide-modal');
    const guideMarkdown = getByTestId(guideModal, 'css-guide-markdown');
    expect(guideMarkdown).toBeTruthy();
    expect(guideModal.textContent).toContain('.morph-h2');
    expect(guideModal.textContent).toContain('.morph-quote');
    expect(guideModal.textContent).toContain('--morph-accent');
    expect(guideModal.querySelector('.morph-guide-selector-grid')).toBeNull();
    expect(guideModal.querySelector('.morph-guide-selector-card')).toBeNull();
    await clickTestId(container, 'close-css-guide-modal-btn');
    expect(isPanelVisible(container, 'css-guide-modal')).toBe(false);

    // Click back button -> slide back to list view
    await clickTestId(container, 'back-to-css-list-btn');
    expect(cssPanel.getAttribute('data-view-mode')).toBe('list');

    // Click "+ 新建样式" -> slide into editor view with empty code and visible grey tutorial overlay
    await clickTestId(container, 'new-css-preset-btn');
    expect(cssPanel.getAttribute('data-view-mode')).toBe('editor');
    expect(cssPanel.querySelector('[data-testid="delete-css-preset-btn"]')).toBeNull();
    const newCssInput = getByTestId<HTMLTextAreaElement>(cssPanel, 'custom-css-input');
    expect(newCssInput.value).toBe('');
    expect(isPanelVisible(cssPanel, 'css-tutorial-overlay')).toBe(true);

    // Typing custom CSS immediately hides/unmounts the grey tutorial overlay
    await setControlValue(
      container,
      'custom-css-input',
      '.morph-doc strong { background-color: #faebdd; padding: 1px 4px; }'
    );
    expect(isPanelVisible(cssPanel, 'css-tutorial-overlay')).toBe(false);

    // Name and save the custom CSS preset -> returns to list mode and adds to css-preset-list
    await setControlValue(container, 'css-preset-name-input', '自定义强调样式');
    await clickTestId(container, 'save-css-preset-btn');
    expect(cssPanel.getAttribute('data-view-mode')).toBe('list');
    expect(cssPanel.querySelectorAll('[data-testid^="css-preset-item-"]')).toHaveLength(3);
    expect(getByTestId(cssPanel, 'css-preset-list').textContent).toContain('自定义强调样式');
    expect(previewStage.innerHTML.toLowerCase()).toMatch(/#faebdd|rgb\(250,\s*235,\s*221\)/);
  });

  it('test_selecting_yoryon_editorial_preset_applies_book_serif_body_centered_h1_slate_blue_accent_and_wysiwyg_table', async () => {
    const copiedPayloads: ClipboardPayload[] = [];
    const { container } = await mountWorkbench({
      onCopyPayload: (payload) => copiedPayloads.push(payload),
    });

    await clickTestId(container, 'css-preset-item-yoryon');
    await clickTestId(container, 'primary-delivery-btn');

    expect(copiedPayloads.length).toBeGreaterThanOrEqual(1);
    const copiedDoc = documentOf(copiedPayloads[0].html);
    const previewStage = getByTestId(container, 'preview-stage');

    for (const root of [previewStage, copiedDoc.body]) {
      // a) .morph-doc book-serif body typography & color
      const docEl = root.querySelector<HTMLElement>('.morph-doc');
      expect(docEl).not.toBeNull();
      expect(docEl!.style.fontFamily).toMatch(/Iowan Old Style|Palatino|Songti SC/i);
      expect(docEl!.style.fontSize).toBe('15px');
      expect(docEl!.style.lineHeight).toBe('1.75');
      expect(docEl!.style.color.toLowerCase()).toMatch(/#282828|rgb\(40,\s*40,\s*40\)/);

      // b) h1.morph-h1 centered 24px title
      const h1 = root.querySelector<HTMLElement>('h1.morph-h1');
      expect(h1).not.toBeNull();
      expect(h1!.style.fontSize).toBe('24px');
      expect(h1!.style.lineHeight).toBe('1.35');
      expect(h1!.style.fontWeight).toBe('600');
      expect(h1!.style.textAlign).toBe('center');
      expect(h1!.style.marginTop).toBe('0px');
      expect(h1!.style.marginBottom).toBe('22px');

      // c) h2.morph-h2 and h3.morph-h3 hierarchy & vertical spacing
      const h2 = root.querySelector<HTMLElement>('h2.morph-h2');
      const h3 = root.querySelector<HTMLElement>('h3.morph-h3');
      expect(h2).not.toBeNull();
      expect(h3).not.toBeNull();
      expect(h2!.style.fontSize).toBe('20px');
      expect(h2!.style.lineHeight).toBe('1.4');
      expect(h2!.style.fontWeight).toBe('600');
      expect(h2!.style.marginTop).toBe('28px');
      expect(h2!.style.marginBottom).toBe('16px');
      expect(h3!.style.fontSize).toBe('17px');
      expect(h3!.style.lineHeight).toBe('1.45');
      expect(h3!.style.fontWeight).toBe('600');
      expect(h3!.style.marginTop).toBe('22px');
      expect(h3!.style.marginBottom).toBe('12px');

      const bodyPara = root.querySelector<HTMLElement>('p.morph-p');
      expect(bodyPara).not.toBeNull();
      expect(bodyPara!.style.fontSize).toBe('15px');
      expect(bodyPara!.style.lineHeight).toBe('1.75');
      expect(bodyPara!.style.fontFamily).toMatch(/Iowan Old Style|Palatino|Songti SC/i);
      expect(bodyPara!.style.color.toLowerCase()).toMatch(/#282828|rgb\(40,\s*40,\s*40\)/);

      const ol = root.querySelector<HTMLElement>('ol.morph-list');
      expect(ol).not.toBeNull();
      expect(ol!.style.marginTop).toBe('0px');
      expect(ol!.style.marginBottom).toBe('0px');
      const liSections = Array.from(ol!.querySelectorAll<HTMLElement>(':scope > li > section'));
      expect(liSections.length).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < liSections.length; i++) {
        const sec = liSections[i];
        expect(sec.style.fontSize).toBe('15px');
        expect(sec.style.lineHeight).toBe('1.75');
        expect(sec.style.marginTop).toBe('0px');
        expect(sec.style.marginBottom).toBe(i === liSections.length - 1 ? '16px' : '6px');
      }

      // d) strong keeps deep ink (#282828) and em uses neutral charcoal (#32383F) + Kaiti serif stack (font-style: normal)
      const strong = root.querySelector<HTMLElement>('p strong');
      expect(strong).not.toBeNull();
      expect(strong!.style.fontWeight).toBe('600');
      expect(strong!.style.color.toLowerCase()).toMatch(/#282828|rgb\(40,\s*40,\s*40\)/);

      const em = root.querySelector<HTMLElement>('p em');
      expect(em).not.toBeNull();
      expect(em!.style.fontStyle).toBe('normal');
      expect(em!.style.fontFamily).toContain('LXGW WenKai');
      expect(em!.style.fontFamily).toContain('Kaiti SC');
      expect(em!.style.color.toLowerCase()).toMatch(/#32383f|rgb\(50,\s*56,\s*63\)/);

      // e) p.morph-quote slate-blue left border & ink (native <p> with inline <span class="morph-p">)
      const quote = root.querySelector<HTMLElement>('.morph-quote');
      expect(quote).not.toBeNull();
      expect(quote!.tagName).toBe('P');
      expect(root.querySelector('blockquote.morph-quote')).toBeNull();
      expect(quote!.querySelectorAll('p, div, section, blockquote')).toHaveLength(0);
      expect(quote!.style.borderLeftWidth || quote!.style.borderLeft).toContain('2px');
      expect((quote!.style.borderLeft || quote!.style.borderLeftColor).toLowerCase()).toMatch(
        /#47758f|rgb\(71,\s*117,\s*143\)/
      );
      expect(quote!.style.fontStyle).toBe('normal');
      expect(quote!.style.color.toLowerCase()).toMatch(/#253947|rgb\(37,\s*57,\s*71\)/);
      expect(quote!.style.marginTop).toBe('0px');
      expect(quote!.style.marginBottom).toBe('20px');

      const quotePara = quote!.querySelector<HTMLElement>('.morph-p');
      expect(quotePara).not.toBeNull();
      expect(quotePara!.tagName).toBe('SPAN');
      expect(quotePara!.style.fontFamily).toMatch(/Iowan Old Style|Palatino|Songti SC/i);
      expect(quotePara!.style.fontSize).toBe('15px');
      expect(quotePara!.style.lineHeight).toBe('1.7');
      expect(quotePara!.style.color.toLowerCase()).toMatch(/#253947|rgb\(37,\s*57,\s*71\)/);

      // f) external link degraded to .morph-link-text in wechat target with color #47758f and .link-url secondary muted gray
      expect(root.querySelector('p a')).toBeNull();
      const linkText = root.querySelector<HTMLElement>('p .morph-link-text');
      expect(linkText).not.toBeNull();
      expect(linkText!.getAttribute('data-original-href')).toBe('https://morphmd.dev');
      expect(linkText!.textContent).toBe('MorphMD 跨端排版系统 (https://morphmd.dev)');
      expect(linkText!.style.color.toLowerCase()).toMatch(/#47758f|rgb\(71,\s*117,\s*143\)/);
      const linkUrl = linkText!.querySelector<HTMLElement>('.morph-link-url.link-url');
      expect(linkUrl).not.toBeNull();
      expect(linkUrl!.tagName).toBe('SPAN');
      expect(linkUrl!.textContent).toBe(' (https://morphmd.dev)');
      expect(linkUrl!.style.color.toLowerCase()).toMatch(/#8c857b|rgb\(140,\s*133,\s*123\)/);
      expect(linkUrl!.style.fontSize).toMatch(/^(0\.85em|12\.75px)$/i);
      expect(linkUrl!.style.fontFamily).toMatch(/JetBrains Mono|SF Mono|monospace/i);

      // g) Callout modern left-straight right-rounded geometry & native <p> with inline <span>+<br>
      const callout = root.querySelector<HTMLElement>('.morph-callout');
      expect(callout).not.toBeNull();
      expect(callout!.tagName).toBe('P');
      expect(callout!.querySelectorAll('p, div, section')).toHaveLength(0);
      expect(callout!.querySelector(':scope > br')).not.toBeNull();
      expect(callout!.style.marginTop).toBe('0px');
      expect(callout!.style.marginBottom).toBe('16px');
      expect(callout!.previousSibling?.nodeType).toBe(window.Node.ELEMENT_NODE);
      expect(callout!.nextSibling?.nodeType).toBe(window.Node.ELEMENT_NODE);
      expect(callout!.style.borderRadius).toBe('0px 8px 8px 0px');
      expect(callout!.style.borderLeftWidth || callout!.style.borderLeft).toContain('3px');
      expect((callout!.style.borderLeft || callout!.style.borderLeftColor).toLowerCase()).toMatch(
        /#47758f|rgb\(71,\s*117,\s*143\)/
      );
      expect(callout!.style.fontFamily).toMatch(
        /-apple-system|BlinkMacSystemFont|PingFang SC|sans-serif/i
      );
      expect(callout!.style.fontFamily).not.toMatch(/Iowan Old Style|Palatino|Songti SC/i);
      expect(callout!.style.fontSize).toBe('14.5px');
      expect(callout!.style.lineHeight).toBe('1.65');

      const calloutTitle = callout!.querySelector<HTMLElement>('.morph-callout-title');
      expect(calloutTitle).not.toBeNull();
      expect(calloutTitle!.tagName).toBe('SPAN');
      const calloutTitleText = calloutTitle!.querySelector<HTMLElement>(
        '.morph-callout-title-text'
      );
      expect(calloutTitleText).not.toBeNull();
      expect(calloutTitleText!.style.fontWeight).toBe('600');

      const calloutBody = callout!.querySelector<HTMLElement>('.morph-callout-body');
      expect(calloutBody).not.toBeNull();
      expect(calloutBody!.tagName).toBe('SPAN');
      const calloutPara = calloutBody!.querySelector<HTMLElement>('.morph-p');
      expect(calloutPara).not.toBeNull();
      expect(calloutPara!.tagName).toBe('SPAN');
      expect(calloutPara!.style.fontFamily).toMatch(
        /-apple-system|BlinkMacSystemFont|PingFang SC|sans-serif/i
      );
      expect(calloutPara!.style.fontSize).toBe('14.5px');
      expect(calloutPara!.style.lineHeight).toBe('1.65');

      // h) inline code and pre.morph-code
      const inlineCode = root.querySelector<HTMLElement>('p > code');
      const codeBlock = root.querySelector<HTMLElement>('pre.morph-code');
      expect(inlineCode).not.toBeNull();
      expect(codeBlock).not.toBeNull();
      for (const codeEl of [inlineCode!, codeBlock!]) {
        expect(codeEl.style.fontFamily).toMatch(/SF Mono|SFMono-Regular|Menlo/i);
        expect(codeEl.style.backgroundColor.toLowerCase()).toMatch(
          /#f3f3f2|rgb\(243,\s*243,\s*242\)/
        );
        expect(codeEl.style.color.toLowerCase()).toMatch(/#3d3936|rgb\(61,\s*57,\s*54\)/);
      }
      expect(codeBlock!.style.whiteSpace).toBe('pre');
      expect(codeBlock!.style.textAlign).toBe('left');
      expect(codeBlock!.style.wordBreak).toBe('normal');
      expect(codeBlock!.style.overflowWrap).toBe('normal');
      expect(codeBlock!.style.fontSize).toBe('13px');

      // i) table.morph-table fixed layout, compact 13px font-size, 8px 6px cell padding, and slate-tinted academic borders
      const table = root.querySelector<HTMLElement>('table.morph-table');
      expect(table).not.toBeNull();
      expect(table!.style.tableLayout).toBe('fixed');
      expect(table!.style.marginTop).toBe('0px');
      expect(table!.style.fontSize).toBe('13px');

      const tableCode = table!.querySelector<HTMLElement>('code');
      expect(tableCode).not.toBeNull();
      expect(tableCode!.style.fontSize).toBe('12px');
      expect(tableCode!.style.whiteSpace).toBe('normal');

      const ths = Array.from(table!.querySelectorAll<HTMLElement>('th'));
      const tds = Array.from(table!.querySelectorAll<HTMLElement>('td'));
      expect(ths.length).toBeGreaterThan(0);
      expect(tds.length).toBeGreaterThan(0);
      for (const th of ths) {
        expect(th.style.padding).toBe('8px 6px');
        expect(th.style.borderTopWidth || th.style.borderTop).toContain('0px');
        expect(th.style.borderLeftWidth || th.style.borderLeft).toContain('0px');
        expect(th.style.borderRightWidth || th.style.borderRight).toContain('0px');
        expect(th.style.borderBottomWidth || th.style.borderBottom).toContain('2px');
        expect((th.style.borderBottom || th.style.borderBottomColor).toLowerCase()).toMatch(
          /#dfeaf0|rgb\(223,\s*234,\s*240\)/
        );
      }
      for (const td of tds) {
        expect(td.style.padding).toBe('8px 6px');
        expect(td.style.borderTopWidth || td.style.borderTop).toContain('0px');
        expect(td.style.borderLeftWidth || td.style.borderLeft).toContain('0px');
        expect(td.style.borderRightWidth || td.style.borderRight).toContain('0px');
        expect(td.style.borderBottomWidth || td.style.borderBottom).toContain('1px');
        expect((td.style.borderBottom || td.style.borderBottomColor).toLowerCase()).toMatch(
          /#dfeaf0|rgb\(223,\s*234,\s*240\)/
        );
      }

      // h) Flow blocks have single-direction vertical margin (marginTop === '0px')
      const flowBlocks = Array.from(
        root.querySelectorAll<HTMLElement>(
          'p.morph-p, p.morph-quote, pre.morph-code, .morph-callout, .morph-math-display, ul.morph-list, ol.morph-list'
        )
      );
      expect(flowBlocks.length).toBeGreaterThan(0);
      for (const block of flowBlocks) {
        expect(block.style.marginTop).toBe('0px');
      }
    }
  });
});

describe('TestBottomLeftDiagnosticsPopover', () => {
  it('test_x_article_and_custom_css_warnings_update_bottom_left_badge_and_open_overleaf_style_popover', async () => {
    const { container } = await mountWorkbench({
      initialTargetId: 'x-article',
      initialMarkdown: '# X 平台能力守卫诊断\n\n第三行正文段落。',
    });

    const cssTab = container.querySelector<HTMLElement>('[data-testid="style-tab-css"]');
    if (cssTab) {
      await clickTestId(container, 'style-tab-css');
    }

    const newCssBtn = container.querySelector<HTMLElement>('[data-testid="new-css-preset-btn"]');
    if (newCssBtn) {
      await clickTestId(container, 'new-css-preset-btn');
    }

    await setControlValue(
      container,
      'custom-css-input',
      '.morph-p { color: #d9730d; position: fixed; }'
    );

    const diagTrigger = getByTestId(container, 'status-diagnostics-trigger');
    expect(diagTrigger.textContent).toMatch(/[1-9]/);
    expect(diagTrigger.getAttribute('aria-expanded')).toBe('false');

    await clickTestId(container, 'status-diagnostics-trigger');
    expect(diagTrigger.getAttribute('aria-expanded')).toBe('true');

    const popover = getByTestId(container, 'diagnostics-popover');
    expect(popover).toBeTruthy();

    const diagList = getByTestId(popover, 'diagnostics-list');
    const items = Array.from(diagList.querySelectorAll<HTMLElement>('[data-testid="diagnostic-item"]'));
    expect(items.length).toBeGreaterThanOrEqual(2);

    const codes = items.map((item) => item.getAttribute('data-code') || '');
    expect(codes).toContain('style/disallowed-position');
    expect(codes).toContain('style/platform-unsupported-custom-css');

    await clickTestId(popover, 'diag-filter-warning');
    const warningItems = Array.from(
      diagList.querySelectorAll<HTMLElement>('[data-testid="diagnostic-item"]')
    );
    expect(warningItems.length).toBeGreaterThanOrEqual(1);
    for (const item of warningItems) {
      expect(item.getAttribute('data-severity')).toBe('warning');
    }

    await clickTestId(popover, 'diag-filter-all');
    await clickTestId(popover, 'diagnostic-item');

    await clickTestId(popover, 'close-diagnostics-btn');
    expect(diagTrigger.getAttribute('aria-expanded')).toBe('false');
  });
});

describe('TestDeliveryCopyAndExport', () => {
  it('test_clicking_primary_delivery_in_wechat_and_export_package_invokes_callbacks_with_valid_payloads', async () => {
    const store = assetStore();
    const asset = await store.ingest(png(2, 20, 14), { fileName: 'cover-banner.png' });
    const session = createEditorSession({
      assetStore: store,
      initialMarkdown: `# 交付快照测试\n\n![封面图](${asset.uri})\n\n用于验证富文本复制与源码资产包导出。`,
      debounceMs: 10,
    });

    const copiedPayloads: ClipboardPayload[] = [];
    const exportedManifests: AssetPackageManifest[] = [];

    const { container } = await mountWorkbench({
      session,
      assetStore: store,
      debounceMs: 10,
      onCopyPayload: (payload) => copiedPayloads.push(payload),
      onExportPackage: (manifest) => exportedManifests.push(manifest),
    });

    await clickTestId(container, 'primary-delivery-btn', session);
    expect(copiedPayloads).toHaveLength(1);
    expect(copiedPayloads[0].unresolvedAssetIds).toEqual([]);
    expect(copiedPayloads[0].plainText).toContain('交付快照测试');
    expect(documentOf(copiedPayloads[0].html).querySelector('img')?.getAttribute('src')).toBe(
      asset.dataUrl
    );

    await clickTestId(container, 'export-package-btn', session);
    expect(exportedManifests).toHaveLength(1);
    expect(exportedManifests[0].rewrittenContent).toContain('./assets/');
    expect(exportedManifests[0].rewrittenContent).not.toContain(asset.uri);
    expect(exportedManifests[0].assets).toHaveLength(1);
    expect(exportedManifests[0].assets[0].data.byteLength).toBeGreaterThan(0);
  });

  it('test_clicking_primary_delivery_in_cards_mode_exports_valid_zip_archive_with_png_pages', async () => {
    const zipResults: CardsZipExportResult[] = [];

    const { container } = await mountWorkbench({
      initialTargetId: 'cards',
      initialMarkdown: '# 卡片导出测试\n\n第一页图文卡片内容。\n\n## 第二节\n\n更多卡片正文。',
      onExportCardsZip: (res) => zipResults.push(res),
    });

    await clickTestId(container, 'primary-delivery-btn');
    expect(zipResults).toHaveLength(1);

    const exported = zipResults[0];
    expect(exported.mimeType).toBe('application/zip');
    expect(exported.pages.length).toBeGreaterThanOrEqual(1);
    expect(exported.zipData.byteLength).toBeGreaterThan(100);

    const entries = parseZipArchive(exported.zipData);
    const entryPaths = entries.map((e) => e.path);
    expect(entryPaths).toContain('manifest.json');
    expect(entryPaths.some((p) => p.endsWith('.png'))).toBe(true);

    evidence('workbench-ui-cards-zip-export', {
      zipFileName: exported.zipFileName,
      pageCount: exported.pages.length,
      entryPaths,
    });
  });

  it('test_copying_partial_selection_inside_preview_stage_normalizes_ancestor_heading_and_invokes_callback', async () => {
    const copiedPayloads: ClipboardPayload[] = [];

    const { container } = await mountWorkbench({
      initialTargetId: 'wechat',
      initialMarkdown: '# 主标题\n\n## 局部选区二级标题\n\n普通段落文本。',
      onCopyPayload: (payload) => copiedPayloads.push(payload),
    });

    const previewStage = getByTestId(container, 'preview-stage');
    const h2 = previewStage.querySelector<HTMLElement>('h2');
    expect(h2).not.toBeNull();

    const textNode = h2!.firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, (textNode.textContent || '').length);

    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const clipboardStore = new Map<string, string>();
    await act(async () => {
      const copyEvent = new window.Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(copyEvent, 'clipboardData', {
        value: {
          setData: (type: string, data: string) => {
            clipboardStore.set(type, data);
          },
          getData: (type: string) => clipboardStore.get(type) ?? '',
        },
      });
      h2!.dispatchEvent(copyEvent);
    });
    await flushWorkbench();

    expect(copiedPayloads).toHaveLength(1);
    expect(copiedPayloads[0].plainText).toContain('局部选区二级标题');
    expect(documentOf(copiedPayloads[0].html).querySelector('h2')?.textContent).toContain(
      '局部选区二级标题'
    );
    expect(clipboardStore.get('text/html')).toContain('<h2');
  });

  it('test_clicking_primary_delivery_in_wechat_and_x_article_writes_dual_channel_clipboard_item_with_rich_html_and_clean_plain_text', async () => {
    const store = assetStore();
    const asset = await store.ingest(png(3, 24, 16), { fileName: 'sample-figure.png' });
    const markdown = [
      '# 让内容自由流动',
      '',
      '一份 Markdown，**三种发布形态**。',
      '',
      '> 写一次，自由发布。',
      '',
      '## 核心功能',
      '',
      '- 多平台适配',
      '- 统一样式系统',
      '',
      `![示例图片](${asset.uri})`,
    ].join('\n');

    const writtenClipboardItems: Array<Record<string, Blob>> = [];
    class MockClipboardItem {
      readonly items: Record<string, Blob>;
      constructor(items: Record<string, Blob>) {
        this.items = items;
      }
      get types(): string[] {
        return Object.keys(this.items);
      }
      async getType(type: string): Promise<Blob> {
        const blob = this.items[type];
        if (!blob) throw new Error(`Missing MIME type: ${type}`);
        return blob;
      }
    }

    Object.defineProperty(globalThis, 'ClipboardItem', {
      value: MockClipboardItem,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'ClipboardItem', {
      value: MockClipboardItem,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        write: async (items: MockClipboardItem[]) => {
          for (const item of items) {
            writtenClipboardItems.push(item.items);
          }
        },
        writeText: async () => {
          /* should not rely solely on writeText when ClipboardItem is available */
        },
      },
      configurable: true,
      writable: true,
    });

    const session = createEditorSession({
      assetStore: store,
      initialMarkdown: markdown,
      debounceMs: 10,
    });

    const { container } = await mountWorkbench({
      session,
      assetStore: store,
      initialTargetId: 'wechat',
      debounceMs: 10,
    });

    // 1. Click primary delivery in wechat view
    await clickTestId(container, 'primary-delivery-btn', session);
    expect(writtenClipboardItems).toHaveLength(1);

    const wechatHtmlBlob = writtenClipboardItems[0]['text/html'];
    const wechatPlainBlob = writtenClipboardItems[0]['text/plain'];
    expect(wechatHtmlBlob).toBeDefined();
    expect(wechatPlainBlob).toBeDefined();

    const wechatHtml = await wechatHtmlBlob.text();
    const wechatPlain = await wechatPlainBlob.text();
    const wechatDoc = documentOf(wechatHtml);
    expect(wechatDoc.querySelector('h1')?.textContent).toContain('让内容自由流动');
    expect(wechatDoc.querySelector('h2')?.textContent).toContain('核心功能');
    expect(wechatDoc.querySelector('strong')?.textContent).toBe('三种发布形态');
    expect(wechatDoc.querySelector('p.morph-quote')?.textContent).toContain('写一次，自由发布。');
    expect(wechatDoc.querySelectorAll('ul li')).toHaveLength(2);
    expect(wechatDoc.querySelector('img')?.getAttribute('src')).toBe(asset.dataUrl);
    expect(wechatPlain).not.toMatch(/\n{3,}/);
    expect(wechatPlain).toContain('让内容自由流动\n一份 Markdown，三种发布形态。\n写一次，自由发布。\n核心功能');

    // 2. Switch to x-article view and click primary delivery
    await clickTestId(container, 'target-tab-x-article', session);
    await clickTestId(container, 'primary-delivery-btn', session);
    expect(writtenClipboardItems).toHaveLength(2);

    const xHtmlBlob = writtenClipboardItems[1]['text/html'];
    const xPlainBlob = writtenClipboardItems[1]['text/plain'];
    expect(xHtmlBlob).toBeDefined();
    expect(xPlainBlob).toBeDefined();

    const xHtml = await xHtmlBlob.text();
    const xPlain = await xPlainBlob.text();
    const xDoc = documentOf(xHtml);
    expect(xDoc.querySelector('h1, h2')?.textContent).toContain('让内容自由流动');
    expect(xDoc.querySelector('strong')?.textContent).toBe('三种发布形态');
    expect(xDoc.querySelector('blockquote')?.textContent).toContain('写一次，自由发布。');
    expect(xDoc.querySelectorAll('ul li')).toHaveLength(2);
    expect(xDoc.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(xPlain).not.toMatch(/\n{3,}/);
    expect(xPlain).toContain('让内容自由流动\n一份 Markdown，三种发布形态。\n写一次，自由发布。\n核心功能');
  });

  it('test_clicking_primary_delivery_falls_back_to_dom_copy_event_with_dual_mime_data_when_clipboard_item_is_unavailable_or_throws', async () => {
    const store = assetStore();
    const asset = await store.ingest(png(4, 20, 20), { fileName: 'fallback-figure.png' });
    const markdown = [
      '# 降级复制测试',
      '',
      '正文包含 **加粗强调**。',
      '',
      '> 引用段落内容。',
      '',
      '- 列表项 A',
      '- 列表项 B',
      '',
      `![示例图片](${asset.uri})`,
    ].join('\n');

    const fallbackCopyEvents: Array<Map<string, string>> = [];
    document.execCommand = ((commandId: string): boolean => {
      if (commandId.toLowerCase() === 'copy') {
        const mimeMap = new Map<string, string>();
        const copyEvent = new window.Event('copy', { bubbles: true, cancelable: true });
        Object.defineProperty(copyEvent, 'clipboardData', {
          value: {
            setData: (type: string, data: string) => {
              mimeMap.set(type, data);
            },
            getData: (type: string) => mimeMap.get(type) ?? '',
          },
        });
        const sel = window.getSelection();
        const targetNode =
          (sel && sel.rangeCount > 0 ? sel.getRangeAt(0).commonAncestorContainer : null) ||
          document.activeElement ||
          document.body;
        const targetEl =
          targetNode.nodeType === window.Node.ELEMENT_NODE
            ? (targetNode as Element)
            : targetNode.parentElement || document.body;
        targetEl.dispatchEvent(copyEvent);
        fallbackCopyEvents.push(mimeMap);
        return true;
      }
      return false;
    }) as typeof document.execCommand;

    // Case 1: ClipboardItem is undefined
    Object.defineProperty(globalThis, 'ClipboardItem', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'ClipboardItem', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    const session = createEditorSession({
      assetStore: store,
      initialMarkdown: markdown,
      debounceMs: 10,
    });

    const { container } = await mountWorkbench({
      session,
      assetStore: store,
      initialTargetId: 'x-article',
      debounceMs: 10,
    });

    await clickTestId(container, 'primary-delivery-btn', session);
    expect(fallbackCopyEvents).toHaveLength(1);
    const firstCopy = fallbackCopyEvents[0];
    expect(firstCopy.get('text/html')).toBeTruthy();
    expect(firstCopy.get('text/plain')).toBeTruthy();

    const firstDoc = documentOf(firstCopy.get('text/html')!);
    expect(firstDoc.querySelector('strong')?.textContent).toBe('加粗强调');
    expect(firstDoc.querySelector('p.morph-quote')?.textContent).toContain('引用段落内容。');
    expect(firstDoc.querySelectorAll('ul li')).toHaveLength(2);
    expect(firstDoc.querySelector('img')?.getAttribute('src')).toBe(asset.dataUrl);
    expect(firstCopy.get('text/plain')).not.toMatch(/\n{3,}/);
    expect(firstCopy.get('text/plain')).toContain('降级复制测试\n正文包含 加粗强调。\n引用段落内容。');

    // Case 2: ClipboardItem exists but navigator.clipboard.write rejects
    class ThrowingClipboardItem {
      constructor(public readonly items: Record<string, Blob>) {}
    }
    Object.defineProperty(globalThis, 'ClipboardItem', {
      value: ThrowingClipboardItem,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, 'ClipboardItem', {
      value: ThrowingClipboardItem,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        write: async () => {
          throw new Error('NotAllowedError: Clipboard write blocked');
        },
        writeText: async () => {},
      },
      configurable: true,
      writable: true,
    });

    await clickTestId(container, 'primary-delivery-btn', session);
    expect(fallbackCopyEvents).toHaveLength(2);
    const secondCopy = fallbackCopyEvents[1];
    expect(secondCopy.get('text/html')).toContain('<strong');
    expect(secondCopy.get('text/plain')).not.toMatch(/\n{3,}/);
  });
});

describe('class TestWorkbenchUi', () => {
  it('test_wechat_default_preview_and_copy_payload_inline_heading_hierarchy_quote_margins_and_image_radius', async () => {
    const cssText = readFileSync(resolve(__dirname, '../src/styles/workbench.css'), 'utf-8');
    const styleEl = document.createElement('style');
    styleEl.textContent = cssText;
    document.head.appendChild(styleEl);

    const copiedPayloads: ClipboardPayload[] = [];
    const { container } = await mountWorkbench({
      onCopyPayload: (payload) => copiedPayloads.push(payload),
    });

    const copyBtn = container.querySelector<HTMLElement>(
      '[data-testid="copy-full-btn"], [data-testid="primary-delivery-btn"]'
    );
    expect(copyBtn).not.toBeNull();
    await act(async () => {
      copyBtn!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flushWorkbench();

    expect(copiedPayloads.length).toBeGreaterThanOrEqual(1);
    const copiedHtml = copiedPayloads[0].html;
    const copiedDoc = documentOf(copiedHtml);

    const previewContainer = container.querySelector<HTMLElement>(
      '[data-testid="preview-scroll-container"], [data-testid="preview-stage"]'
    );
    expect(previewContainer).not.toBeNull();

    for (const root of [previewContainer!, copiedDoc.body]) {
      const h1 = root.querySelector<HTMLElement>('h1.morph-h1');
      const h2 = root.querySelector<HTMLElement>('h2.morph-h2');
      const h3 = root.querySelector<HTMLElement>('h3.morph-h3');
      const p = root.querySelector<HTMLElement>('p.morph-p, p');

      expect(h1).not.toBeNull();
      expect(h2).not.toBeNull();
      expect(h3).not.toBeNull();
      expect(p).not.toBeNull();

      expect(h1!.style.fontSize).toMatch(/px$/i);
      expect(h2!.style.fontSize).toMatch(/px$/i);
      expect(h3!.style.fontSize).toMatch(/px$/i);
      expect(h1!.style.lineHeight).toBeTruthy();
      expect(h2!.style.lineHeight).toBeTruthy();
      expect(h3!.style.lineHeight).toBeTruthy();

      const h1Size = parseFloat(h1!.style.fontSize);
      const h2Size = parseFloat(h2!.style.fontSize);
      const h3Size = parseFloat(h3!.style.fontSize);
      const pSize = parseFloat(p!.style.fontSize || '16');

      expect(h1Size).toBeGreaterThanOrEqual(24);
      expect(h2Size).toBeGreaterThanOrEqual(20);
      expect(h3Size).toBeGreaterThanOrEqual(17);
      expect(h1Size).toBeGreaterThan(h2Size);
      expect(h2Size).toBeGreaterThan(h3Size);
      expect(h3Size).toBeGreaterThan(pSize);
    }

    const previewQuote = previewContainer!.querySelector<HTMLElement>('p.morph-quote');
    expect(previewQuote).not.toBeNull();
    expect(previewContainer!.querySelector('blockquote.morph-quote')).toBeNull();
    expect(previewQuote!.style.marginLeft).toBe('0px');
    expect(previewQuote!.style.marginRight).toBe('0px');

    const computedQuote = window.getComputedStyle(previewQuote!);
    expect(computedQuote.marginLeft).toBe('0px');
    expect(computedQuote.marginRight).toBe('0px');

    const quoteParagraphs = previewQuote!.querySelectorAll<HTMLElement>('span.morph-p');
    expect(quoteParagraphs.length).toBeGreaterThanOrEqual(1);
    expect(previewQuote!.querySelectorAll('p, div, section, blockquote')).toHaveLength(0);

    const copiedImg = copiedDoc.querySelector<HTMLElement>('img.morph-img');
    expect(copiedImg).not.toBeNull();
    expect(parseFloat(copiedImg!.style.borderRadius)).toBeGreaterThanOrEqual(6);
  });

  it('test_default_showcase_markdown_renders_all_core_editorial_elements', async () => {
    const { container } = await mountWorkbench();

    const previewContainer = container.querySelector<HTMLElement>(
      '[data-testid="preview-scroll-container"], [data-testid="preview-stage"]'
    );
    expect(previewContainer).not.toBeNull();

    // Headings
    expect(previewContainer!.querySelector('h1.morph-h1')).not.toBeNull();
    expect(previewContainer!.querySelector('h2.morph-h2')).not.toBeNull();
    expect(previewContainer!.querySelector('h3.morph-h3')).not.toBeNull();

    // Inline formatting inside paragraphs: strong, em, inline code, degraded external link in wechat
    expect(previewContainer!.querySelector('p strong')).not.toBeNull();
    expect(previewContainer!.querySelector('p em')).not.toBeNull();
    const inlineCode = previewContainer!.querySelector<HTMLElement>(':not(pre) > code');
    expect(inlineCode).not.toBeNull();
    expect(inlineCode!.style.backgroundColor).toBeTruthy();
    expect(inlineCode!.style.borderRadius).toBeTruthy();
    expect(previewContainer!.querySelector('p a')).toBeNull();
    const degradedLink = previewContainer!.querySelector<HTMLElement>('p .morph-link-text');
    expect(degradedLink).not.toBeNull();
    expect(degradedLink!.getAttribute('data-original-href')).toBe('https://morphmd.dev');
    expect(degradedLink!.textContent).toBe('MorphMD 跨端排版系统 (https://morphmd.dev)');

    // Quote block (converted to native <p class="morph-quote"> in wechat view)
    expect(previewContainer!.querySelector('p.morph-quote')).not.toBeNull();
    expect(previewContainer!.querySelector('blockquote.morph-quote')).toBeNull();

    // Callout block
    const callout = previewContainer!.querySelector<HTMLElement>('.morph-callout');
    expect(callout).not.toBeNull();
    expect(callout!.querySelector('.morph-callout-title')).not.toBeNull();
    expect(callout!.querySelector('.morph-callout-body')).not.toBeNull();

    // Both unordered list and ordered list
    expect(previewContainer!.querySelector('ul.morph-list')).not.toBeNull();
    expect(previewContainer!.querySelector('ol.morph-list')).not.toBeNull();

    // Code block
    expect(previewContainer!.querySelector('pre.morph-code')).not.toBeNull();

    // Table with inline border and padding on th and td
    const table = previewContainer!.querySelector<HTMLElement>('table.morph-table');
    expect(table).not.toBeNull();
    const th = table!.querySelector<HTMLElement>('th');
    const td = table!.querySelector<HTMLElement>('td');
    expect(th).not.toBeNull();
    expect(td).not.toBeNull();
    expect(th!.style.border || th!.style.borderTop || th!.style.borderBottom).toBeTruthy();
    expect(th!.style.padding || th!.style.paddingTop).toBeTruthy();
    expect(td!.style.border || td!.style.borderTop || td!.style.borderBottom).toBeTruthy();
    expect(td!.style.padding || td!.style.paddingTop).toBeTruthy();

    // Image
    expect(previewContainer!.querySelector('img.morph-img')).not.toBeNull();

    // Math formula
    expect(previewContainer!.querySelector('[data-math-tex]')).not.toBeNull();

    // Horizontal rule
    expect(previewContainer!.querySelector('hr')).not.toBeNull();
  });

  it('test_wechat_list_items_wrap_inline_content_in_section_and_math_formulas_render_as_vector_svg_without_annotation_leakage', async () => {
    const copiedPayloads: ClipboardPayload[] = [];
    const { container } = await mountWorkbench({
      onCopyPayload: (payload) => copiedPayloads.push(payload),
    });

    const copyBtn = container.querySelector<HTMLElement>(
      '[data-testid="copy-full-btn"], [data-testid="primary-delivery-btn"]'
    );
    expect(copyBtn).not.toBeNull();
    await act(async () => {
      copyBtn!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flushWorkbench();

    expect(copiedPayloads.length).toBeGreaterThanOrEqual(1);
    const copiedDoc = documentOf(copiedPayloads[0].html);

    const previewContainer = container.querySelector<HTMLElement>(
      '[data-testid="preview-scroll-container"], [data-testid="preview-stage"]'
    );
    expect(previewContainer).not.toBeNull();

    for (const root of [previewContainer!, copiedDoc.body]) {
      // 1. List item <section> wrapping
      const orderedItems = Array.from(root.querySelectorAll<HTMLElement>('ol.morph-list > li'));
      expect(orderedItems.length).toBeGreaterThanOrEqual(3);

      for (const li of orderedItems) {
        const section = li.querySelector<HTMLElement>(':scope > section');
        expect(section).not.toBeNull();
        const strong = section!.querySelector<HTMLElement>('strong');
        expect(strong).not.toBeNull();
        const fullText = (section!.textContent || '').trim();
        const strongText = (strong!.textContent || '').trim();
        expect(fullText.startsWith(strongText)).toBe(true);
        const remainder = fullText.slice(strongText.length);
        expect(remainder.startsWith('：')).toBe(true);
      }

      // 2. Math formulas rendered as vector <svg> without <math> or <annotation> leakage
      const inlineMath = root.querySelector<HTMLElement>('.morph-math-inline[data-math-tex]');
      const displayMath = root.querySelector<HTMLElement>('.morph-math-display[data-math-tex]');
      expect(inlineMath).not.toBeNull();
      expect(displayMath).not.toBeNull();

      for (const mathEl of [inlineMath!, displayMath!]) {
        expect(mathEl.querySelector('svg')).not.toBeNull();
        expect(mathEl.querySelector('svg path')).not.toBeNull();
        expect(mathEl.querySelector('svg g[fill="currentColor"]')).not.toBeNull();
        const leakedText = mathEl.textContent || '';
        expect(leakedText).not.toContain('\\mathcal');
        expect(leakedText).not.toContain('\\frac');
        expect(leakedText).not.toContain('\\sum');
      }

      expect(root.querySelectorAll('math, annotation')).toHaveLength(0);
      expect(displayMath!.style.textAlign).toBe('center');

      const displaySvg = displayMath!.querySelector<SVGSVGElement>('svg');
      expect(displaySvg).not.toBeNull();
      expect(displaySvg!.style.display).toBe('block');
      expect(displaySvg!.style.marginLeft).toBe('auto');
      expect(displaySvg!.style.marginRight).toBe('auto');

      const inlineSvg = inlineMath!.querySelector<SVGSVGElement>('svg');
      expect(inlineSvg).not.toBeNull();
      expect(inlineSvg!.style.display).not.toBe('block');
    }
  });

  it('test_wechat_copy_payload_and_preview_preserve_wysiwyg_table_borders_fixed_layout_and_single_direction_block_spacing', async () => {
    const copiedPayloads: ClipboardPayload[] = [];
    const { container } = await mountWorkbench({
      onCopyPayload: (payload) => copiedPayloads.push(payload),
    });

    const copyBtn = container.querySelector<HTMLElement>(
      '[data-testid="copy-full-btn"], [data-testid="primary-delivery-btn"]'
    );
    expect(copyBtn).not.toBeNull();
    await act(async () => {
      copyBtn!.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await flushWorkbench();

    expect(copiedPayloads.length).toBeGreaterThanOrEqual(1);
    const copiedDoc = documentOf(copiedPayloads[0].html);
    const previewStage = getByTestId(container, 'preview-stage');

    for (const root of [previewStage, copiedDoc.body]) {
      const table = root.querySelector<HTMLElement>('table.morph-table');
      expect(table).not.toBeNull();

      // a) No foster-parented multi-newline text node immediately preceding <table class="morph-table">
      const prevNode = table!.previousSibling;
      if (prevNode && prevNode.nodeType === window.Node.TEXT_NODE) {
        expect(/\n\s*\n/.test(prevNode.textContent || '')).toBe(false);
      }

      // b) Table uses fixed layout and single-direction vertical margin
      expect(table!.style.tableLayout).toBe('fixed');
      expect(table!.style.marginTop).toBe('0px');
      expect(parseFloat(table!.style.marginBottom)).toBeLessThanOrEqual(24);

      // c) Every th and td has explicit 0px top/left/right border width and expected bottom border
      const ths = Array.from(table!.querySelectorAll<HTMLElement>('th'));
      const tds = Array.from(table!.querySelectorAll<HTMLElement>('td'));
      expect(ths.length).toBeGreaterThan(0);
      expect(tds.length).toBeGreaterThan(0);

      for (const th of ths) {
        expect(th.style.borderTopWidth || th.style.borderTop).toContain('0px');
        expect(th.style.borderLeftWidth || th.style.borderLeft).toContain('0px');
        expect(th.style.borderRightWidth || th.style.borderRight).toContain('0px');
        expect(th.style.borderBottomWidth || th.style.borderBottom).toContain('2px');
        expect((th.style.borderBottom || th.style.borderBottomColor).toLowerCase()).toMatch(
          /#141413|rgb\(20,\s*20,\s*19\)/
        );
      }

      for (const td of tds) {
        expect(td.style.borderTopWidth || td.style.borderTop).toContain('0px');
        expect(td.style.borderLeftWidth || td.style.borderLeft).toContain('0px');
        expect(td.style.borderRightWidth || td.style.borderRight).toContain('0px');
        expect(td.style.borderBottomWidth || td.style.borderBottom).toContain('1px');
        expect((td.style.borderBottom || td.style.borderBottomColor).toLowerCase()).toMatch(
          /#e2dfd7|rgb\(226,\s*223,\s*215\)/
        );
      }

      // d) Flow blocks all have single-direction vertical margin (marginTop === '0px')
      const flowBlocks = Array.from(
        root.querySelectorAll<HTMLElement>(
          'p.morph-p, p.morph-quote, pre.morph-code, .morph-callout, .morph-math-display, ul.morph-list, ol.morph-list'
        )
      );
      expect(flowBlocks.length).toBeGreaterThan(0);
      for (const block of flowBlocks) {
        expect(block.style.marginTop).toBe('0px');
      }
    }
  });
});
