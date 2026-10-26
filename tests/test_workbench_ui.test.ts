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

  it('test_notion_charcoal_palette_excludes_purple_swatches_and_exposes_charcoal_primary_swatch', async () => {
    const { container } = await mountWorkbench();

    const themeTab = container.querySelector<HTMLElement>('[data-testid="style-tab-theme"]');
    if (themeTab) {
      await clickTestId(container, 'style-tab-theme');
    }

    const charcoalSwatch = getByTestId(container, 'accent-swatch-#37352f');
    expect(charcoalSwatch).toBeTruthy();
    expect(container.querySelector('[data-testid="accent-swatch-#6657dc"]')).toBeNull();

    const swatches = Array.from(
      container.querySelectorAll<HTMLElement>('[data-testid^="accent-swatch-"]')
    );
    expect(swatches.length).toBeGreaterThanOrEqual(4);
    for (const swatch of swatches) {
      const id = (swatch.getAttribute('data-testid') || '').toLowerCase();
      expect(id).not.toContain('6657dc');
      expect(id).not.toContain('7c3aed');
      expect(id).not.toContain('8b5cf6');
    }
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
      initialMarkdown: '# 跨端同构发布\n\n支持公众号、X 长文与多比例卡片。',
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

    await clickTestId(container, 'target-tab-cards');
    expect(cardsTab.getAttribute('aria-pressed')).toBe('true');
    expect(xTab.getAttribute('aria-pressed')).toBe('false');
    expect(previewStage.getAttribute('data-target-view')).toBe('cards');
    expect(primaryBtn.textContent).toContain('导出高清卡片');
    expect(previewStage.querySelectorAll('.morph-card-page').length).toBeGreaterThanOrEqual(1);
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
  it('test_editing_markdown_input_and_clicking_toolbar_actions_update_preview_and_footer_stats', async () => {
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

    await clickTestId(container, 'toolbar-insert-table');
    const markdownInput = getByTestId<HTMLTextAreaElement>(container, 'markdown-input');
    expect(markdownInput.value).toContain('|');
    expect(previewStage.querySelector('table')).not.toBeNull();

    await clickTestId(container, 'toolbar-insert-code');
    expect(markdownInput.value).toContain('```');
    expect(previewStage.querySelector('pre, code')).not.toBeNull();
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
  it('test_selecting_theme_presets_and_accent_color_updates_compiled_preview_styles', async () => {
    const { container } = await mountWorkbench({
      initialMarkdown: '# 主题定制标题\n\n> 引用块样式验证\n\n正文包含 **重点强调** 文字。',
    });

    const themeTab = container.querySelector<HTMLElement>('[data-testid="style-tab-theme"]');
    if (themeTab) {
      await clickTestId(container, 'style-tab-theme');
    }

    const previewStage = getByTestId(container, 'preview-stage');
    const beforePresetHtml = previewStage.innerHTML;

    await clickTestId(container, 'preset-card-magazine');
    expect(previewStage.innerHTML).not.toBe(beforePresetHtml);

    await setControlValue(container, 'accent-hex-input', '#0f7b6c');
    const normalizedHtml = previewStage.innerHTML.toLowerCase();
    expect(
      normalizedHtml.includes('#0f7b6c') || normalizedHtml.includes('rgb(15, 123, 108)')
    ).toBe(true);
  });

  it('test_updating_typography_size_and_line_height_controls_updates_preview_inline_styles', async () => {
    const { container } = await mountWorkbench({
      initialMarkdown: '# 排版参数调节\n\n用于验证正文字号与行高实时内联。',
    });

    const typographyTab = container.querySelector<HTMLElement>(
      '[data-testid="style-tab-typography"]'
    );
    if (typographyTab) {
      await clickTestId(container, 'style-tab-typography');
    }

    await setControlValue(container, 'body-size-input', '18px');
    await setControlValue(container, 'line-height-input', '1.9');

    const previewStage = getByTestId(container, 'preview-stage');
    const docEl = previewStage.querySelector<HTMLElement>('.morph-doc');
    const pEl = previewStage.querySelector<HTMLElement>('.morph-p, p');
    expect(docEl).not.toBeNull();
    expect(docEl!.style.fontSize).toBe('18px');
    expect(pEl?.style.lineHeight || docEl!.style.lineHeight).toBe('1.9');
  });

  it('test_switching_style_drawer_tabs_exclusively_displays_active_panel_and_applies_extended_settings', async () => {
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
        '# 样式抽屉三栏面板验证\n\n## 二级标题装饰测试\n\n> 引用块容器测试\n\n正文段落包含 **高亮重点** 文本内容。',
    });

    const previewStage = getByTestId(container, 'preview-stage');

    // 1. Theme tab is active initially; typography and css panels are hidden/unmounted
    expect(isPanelVisible(container, 'style-panel-theme')).toBe(true);
    expect(isPanelVisible(container, 'style-panel-typography')).toBe(false);
    expect(isPanelVisible(container, 'style-panel-css')).toBe(false);

    // Apply sepia paper preset in theme panel
    await clickTestId(container, 'paper-preset-sepia');
    const afterSepiaHtml = previewStage.innerHTML.toLowerCase();
    expect(
      afterSepiaHtml.includes('#f6f1e7') || afterSepiaHtml.includes('rgb(246, 241, 231)')
    ).toBe(true);

    // Switch to cards view and verify card-header-input updates rendered card header
    await clickTestId(container, 'target-tab-cards');
    await setControlValue(container, 'card-header-input', 'MorphMD 专栏卡片');
    expect(previewStage.querySelector('.morph-card-header')?.textContent).toContain(
      'MorphMD 专栏卡片'
    );
    await clickTestId(container, 'target-tab-wechat');

    // 2. Switch to Typography tab: only style-panel-typography is visible
    await clickTestId(container, 'style-tab-typography');
    expect(isPanelVisible(container, 'style-panel-theme')).toBe(false);
    expect(isPanelVisible(container, 'style-panel-typography')).toBe(true);
    expect(isPanelVisible(container, 'style-panel-css')).toBe(false);

    await clickTestId(container, 'paragraph-indent-toggle');
    await setControlValue(container, 'letter-spacing-input', '0.05em');
    const afterTypoHtml = previewStage.innerHTML.toLowerCase();
    expect(afterTypoHtml).toContain('text-indent');
    expect(afterTypoHtml).toContain('0.05em');

    // 3. Switch to Custom CSS tab: only style-panel-css is visible, starting in list mode
    await clickTestId(container, 'style-tab-css');
    expect(isPanelVisible(container, 'style-panel-theme')).toBe(false);
    expect(isPanelVisible(container, 'style-panel-typography')).toBe(false);
    expect(isPanelVisible(container, 'style-panel-css')).toBe(true);

    const cssPanel = getByTestId(container, 'style-panel-css');
    expect(cssPanel.getAttribute('data-view-mode')).toBe('list');
    expect(getByTestId(cssPanel, 'css-list-view')).toBeTruthy();
    expect(getByTestId(cssPanel, 'css-preset-list')).toBeTruthy();
    expect(getByTestId(cssPanel, 'css-preset-item-default')).toBeTruthy();
    expect(getByTestId(cssPanel, 'css-preset-item-reading')).toBeTruthy();

    // Top 3 tabs remain fixed and mounted
    expect(getByTestId(container, 'style-tab-theme')).toBeTruthy();
    expect(getByTestId(container, 'style-tab-typography')).toBeTruthy();
    expect(getByTestId(container, 'style-tab-css')).toBeTruthy();

    // Click preset item -> in-place right-to-left slide into editor drilldown view
    const beforeReadingHtml = previewStage.innerHTML;
    await clickTestId(container, 'css-preset-item-reading');
    expect(cssPanel.getAttribute('data-view-mode')).toBe('editor');
    expect(getByTestId(cssPanel, 'css-drilldown-view')).toBeTruthy();
    expect(cssPanel.querySelector('[data-testid="css-quick-insert-bar"]')).toBeNull();
    expect(getByTestId(cssPanel, 'toggle-css-guide-btn')).toBeTruthy();
    expect(cssPanel.querySelector('[data-testid="delete-css-preset-btn"]')).toBeTruthy();

    await clickTestId(container, 'toggle-css-guide-btn');
    const guideModal = getByTestId(container, 'css-guide-modal');
    expect(guideModal.textContent).toContain('.morph-h2');
    expect(guideModal.textContent).toContain('.morph-quote');
    expect(guideModal.textContent).toContain('var(--morph-accent)');
    await clickTestId(container, 'close-css-guide-modal-btn');
    expect(isPanelVisible(container, 'css-guide-modal')).toBe(false);

    const presetNameInput = getByTestId<HTMLInputElement>(cssPanel, 'css-preset-name-input');
    const customCssInput = getByTestId<HTMLTextAreaElement>(cssPanel, 'custom-css-input');
    expect(presetNameInput.value.trim().length).toBeGreaterThan(0);
    expect(customCssInput.value.trim().length).toBeGreaterThan(0);
    expect(previewStage.innerHTML).not.toBe(beforeReadingHtml);

    // Click back button -> slide back to list view while top 3 tabs remain fixed
    await clickTestId(container, 'back-to-css-list-btn');
    expect(cssPanel.getAttribute('data-view-mode')).toBe('list');
    expect(getByTestId(container, 'style-tab-theme')).toBeTruthy();

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
    expect(getByTestId(cssPanel, 'css-preset-list').textContent).toContain('自定义强调样式');
    expect(previewStage.innerHTML.toLowerCase()).toMatch(/#faebdd|rgb\(250,\s*235,\s*221\)/);
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
    expect(wechatDoc.querySelector('blockquote')?.textContent).toContain('写一次，自由发布。');
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
    expect(firstDoc.querySelector('blockquote')?.textContent).toContain('引用段落内容。');
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
