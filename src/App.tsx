import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AssetStore } from './core/assets/store';
import type { AssetPackageManifest } from './core/assets/types';
import { exportCardsZipPackage } from './core/cards/exporter';
import type { CardAspectRatio, CardsZipExportResult } from './core/cards/types';
import { normalizeSelectionRange, serializeFullSnapshot } from './core/selection/normalizer';
import type { ClipboardPayload } from './core/selection/types';
import { createEditorSession, EditorSessionController } from './core/session/controller';
import { createDeliverySnapshotSync } from './core/snapshot/builder';
import type { DeliverySnapshot, DiagnosticItem, TargetId } from './core/snapshot/types';
import type { DesignTokens } from './core/style/tokens';
import {
  buildDefaultShowcaseMarkdown,
  createShowcaseCoverPng,
  CSS_SELECTOR_REFERENCE,
  CSS_TUTORIAL_GUIDE_LINES,
  DEFAULT_SAVED_CSS_PRESETS,
  FONT_MONO_OPTIONS,
  FONT_SANS_OPTIONS,
  FONT_SERIF_OPTIONS,
  HEADING_SCALE_OPTIONS,
  HEADING_STYLE_OPTIONS,
  IMAGE_RADIUS_OPTIONS,
  NOTION_ACCENT_SWATCHES,
  PAPER_SURFACE_PRESETS,
  QUOTE_STYLE_OPTIONS,
  THEME_PRESETS,
  type HeadingScaleId,
  type HeadingStyleId,
  type ImageRadiusId,
  type PaperPresetId,
  type QuoteStyleId,
  type SavedCssPresetItem,
  type ThemePresetId,
} from './ui/presets';
import './styles/workbench.css';

export interface AppProps {
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

type StyleDrawerTab = 'theme' | 'typography' | 'css';
type DiagnosticFilter = 'all' | 'warning' | 'error';

interface StyleTuningState {
  paperId: PaperPresetId;
  headingStyle: HeadingStyleId;
  quoteStyle: QuoteStyleId;
  imageRadius: ImageRadiusId;
  cardHeaderText: string;
  cardFooterMode: 'slash' | 'verbose' | 'hidden';
  headingScale: HeadingScaleId;
  letterSpacing: string;
  textAlign: 'left' | 'justify';
  paragraphIndent: boolean;
  codeSize: string;
  listGap: string;
}

const DEFAULT_STYLE_TUNING: StyleTuningState = {
  paperId: 'pure',
  headingStyle: 'bar',
  quoteStyle: 'classic',
  imageRadius: '8px',
  cardHeaderText: 'MorphMD',
  cardFooterMode: 'slash',
  headingScale: 'standard',
  letterSpacing: '0px',
  textAlign: 'left',
  paragraphIndent: false,
  codeSize: '13px',
  listGap: '6px',
};

function buildTuningCss(tuning: StyleTuningState): string {
  const rules: string[] = [];

  const hStyle = HEADING_STYLE_OPTIONS.find((item) => item.id === tuning.headingStyle);
  if (hStyle?.css) rules.push(hStyle.css);

  const qStyle = QUOTE_STYLE_OPTIONS.find((item) => item.id === tuning.quoteStyle);
  if (qStyle?.css) rules.push(qStyle.css);

  const imgStyle = IMAGE_RADIUS_OPTIONS.find((item) => item.id === tuning.imageRadius);
  if (imgStyle?.css) rules.push(imgStyle.css);

  const scaleStyle = HEADING_SCALE_OPTIONS.find((item) => item.id === tuning.headingScale);
  if (scaleStyle?.css) rules.push(scaleStyle.css);

  const pDecls: string[] = [];
  if (tuning.letterSpacing && tuning.letterSpacing !== '0' && tuning.letterSpacing !== '0px') {
    pDecls.push(`letter-spacing: ${tuning.letterSpacing};`);
  }
  if (tuning.textAlign === 'justify') {
    pDecls.push('text-align: justify;');
  }
  if (tuning.paragraphIndent) {
    pDecls.push('text-indent: 2em;');
  }
  if (pDecls.length > 0) {
    rules.push(`.morph-p { ${pDecls.join(' ')} }`);
  }

  if (tuning.codeSize) {
    rules.push(`.morph-code { font-size: ${tuning.codeSize}; }`);
  }
  if (tuning.listGap) {
    rules.push(`li { margin-bottom: ${tuning.listGap}; }`);
  }

  return rules.join('\n');
}

function extractReferencedAssetIds(markdown: string): string[] {
  const ids = new Set<string>();
  const regex = /morph-asset:\/\/([a-zA-Z0-9_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(markdown)) !== null) {
    if (match[1]) {
      ids.add(match[1]);
    }
  }
  return [...ids];
}

function normalizePxValue(raw: string, fallbackPx: number): string {
  const trimmed = raw.trim();
  if (!trimmed) return `${fallbackPx}px`;
  if (/^\d+(\.\d+)?px$/i.test(trimmed)) return trimmed.toLowerCase();
  if (/^\d+(\.\d+)?(rem|em|%)$/i.test(trimmed)) return trimmed.toLowerCase();
  const numeric = parseFloat(trimmed);
  if (!Number.isNaN(numeric) && numeric > 0) {
    return `${numeric}px`;
  }
  return `${fallbackPx}px`;
}

function parseNumericPx(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const num = parseFloat(raw);
  return Number.isNaN(num) ? fallback : num;
}

async function readFileAsUint8Array(file: File): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    const buffer = await file.arrayBuffer();
    return new Uint8Array(buffer);
  }
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(new Uint8Array(reader.result as ArrayBuffer));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error('Failed to read file'));
    };
    reader.readAsArrayBuffer(file);
  });
}

function triggerBrowserDownload(filename: string, data: Uint8Array | string, mimeType: string): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (navigator.userAgent?.includes('jsdom')) return;
  try {
    const blob =
      typeof data === 'string'
        ? new Blob([data], { type: mimeType })
        : new Blob([new Uint8Array(data)], { type: mimeType });
    if (typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {
    // Ignore download errors in headless test environments
  }
}

export const App: React.FC<AppProps> = ({
  initialMarkdown,
  initialTargetId = 'wechat',
  initialDrawerOpen = true,
  session: externalSession,
  assetStore: externalAssetStore,
  debounceMs = 60,
  onCopyPayload,
  onExportPackage,
  onExportCardsZip,
}) => {
  // 1. Initialize AssetStore & EditorSessionController
  const initBundle = useMemo(() => {
    const store = externalAssetStore ?? new AssetStore();
    let resolvedInitialMd = initialMarkdown;

    if (externalSession) {
      const existingMd =
        externalSession.getDraftMarkdown() || externalSession.getCommittedMarkdown();
      if (resolvedInitialMd === undefined) {
        resolvedInitialMd = existingMd || buildDefaultShowcaseMarkdown();
      }
      const initialSnap =
        externalSession.getSnapshot() && externalSession.getSnapshot()!.ready
          ? externalSession.getSnapshot()!
          : createDeliverySnapshotSync(resolvedInitialMd, initialTargetId, store, {
              cardsOptions: { ratio: '3:4' },
            });
      return {
        store,
        session: externalSession,
        ownsSession: false,
        initialMd: resolvedInitialMd,
        initialSnap,
      };
    }

    if (resolvedInitialMd === undefined) {
      const showcaseRecord = store.ingestSync(createShowcaseCoverPng(), {
        fileName: 'alpine-sunset.png',
        mimeType: 'image/png',
      });
      resolvedInitialMd = buildDefaultShowcaseMarkdown(showcaseRecord.uri);
    }

    const defaultPresetCss =
      initialTargetId === 'x-article' ? undefined : THEME_PRESETS.default.presetCss;
    const defaultTokens =
      initialTargetId === 'x-article' ? undefined : THEME_PRESETS.default.tokens;

    const createdSession = createEditorSession({
      assetStore: store,
      targetId: initialTargetId,
      initialMarkdown: resolvedInitialMd,
      debounceMs,
      customCss: defaultPresetCss,
      tokens: defaultTokens,
      cardsOptions: { ratio: '3:4' },
    });

    const initialSnap = createDeliverySnapshotSync(resolvedInitialMd, initialTargetId, store, {
      customCss: defaultPresetCss,
      tokens: defaultTokens,
      cardsOptions: { ratio: '3:4' },
    });

    return {
      store,
      session: createdSession,
      ownsSession: true,
      initialMd: resolvedInitialMd,
      initialSnap,
    };
  }, [externalSession, externalAssetStore]);

  const { store, session } = initBundle;

  // 2. Workbench UI States
  const [markdown, setMarkdown] = useState<string>(initBundle.initialMd);
  const [targetId, setTargetId] = useState<TargetId>(initialTargetId);
  const [snapshot, setSnapshot] = useState<DeliverySnapshot>(initBundle.initialSnap);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(initialDrawerOpen);
  const [activeStyleTab, setActiveStyleTab] = useState<StyleDrawerTab>('theme');
  const [activePresetId, setActivePresetId] = useState<ThemePresetId>('default');
  const [tokens, setTokens] = useState<DesignTokens>(() => ({
    ...THEME_PRESETS.default.tokens,
  }));
  const [hasCustomizedTokens, setHasCustomizedTokens] = useState<boolean>(false);
  const [customCss, setCustomCss] = useState<string>('');
  const [savedCssPresets, setSavedCssPresets] = useState<SavedCssPresetItem[]>(() => [
    ...DEFAULT_SAVED_CSS_PRESETS,
  ]);
  const [activeCssPresetId, setActiveCssPresetId] = useState<string>('default');
  const [cssViewMode, setCssViewMode] = useState<'list' | 'editor'>('list');
  const [editingCssPresetId, setEditingCssPresetId] = useState<string | null>('default');
  const [draftCssPresetName, setDraftCssPresetName] = useState<string>(
    DEFAULT_SAVED_CSS_PRESETS[0].name
  );
  const [tuning, setTuning] = useState<StyleTuningState>(() => ({ ...DEFAULT_STYLE_TUNING }));
  const [hasCustomizedTuning, setHasCustomizedTuning] = useState<boolean>(false);
  const [cardRatio, setCardRatio] = useState<CardAspectRatio>('3:4');
  const [canvasPreset, setCanvasPreset] = useState<string>(
    initialTargetId === 'cards' ? '3:4' : initialTargetId === 'x-article' ? '680px' : '720px'
  );
  const [deviceMode, setDeviceMode] = useState<'desktop' | 'mobile'>('desktop');
  const [zoomPercent, setZoomPercent] = useState<string>('100%');
  const [previewMode, setPreviewMode] = useState<'render' | 'sourcemap'>('render');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState<boolean>(false);
  const [diagFilter, setDiagFilter] = useState<DiagnosticFilter>('all');
  const [cursorPos, setCursorPos] = useState<{ line: number; col: number }>({ line: 1, col: 1 });
  const [activeHighlightLine, setActiveHighlightLine] = useState<number | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [assetTick, setAssetTick] = useState<number>(0);
  const [editorWidth, setEditorWidth] = useState<number>(390);
  const [drawerWidth, setDrawerWidth] = useState<number>(444);
  const [cssGuideOpen, setCssGuideOpen] = useState<boolean>(false);

  const appRootRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previewStageRef = useRef<HTMLDivElement | null>(null);
  const cssGuideDialogRef = useRef<HTMLDialogElement | null>(null);
  const snapshotRef = useRef<DeliverySnapshot>(snapshot);
  snapshotRef.current = snapshot;
  const editorWidthRef = useRef<number>(editorWidth);
  editorWidthRef.current = editorWidth;
  const drawerWidthRef = useRef<number>(drawerWidth);
  drawerWidthRef.current = drawerWidth;
  const activeResizeRef = useRef<{
    target: 'editor' | 'drawer';
    startX: number;
    startWidth: number;
  } | null>(null);
  const markdownRef = useRef<string>(markdown);
  markdownRef.current = markdown;
  const customCssRef = useRef<string>(customCss);
  customCssRef.current = customCss;
  const draftCssPresetNameRef = useRef<string>(draftCssPresetName);
  draftCssPresetNameRef.current = draftCssPresetName;
  const cssBeforeEditRef = useRef<string>('');
  const tokensRef = useRef<DesignTokens>(tokens);
  tokensRef.current = tokens;
  const tuningRef = useRef<StyleTuningState>(tuning);
  tuningRef.current = tuning;
  const hasCustomizedTuningRef = useRef<boolean>(hasCustomizedTuning);
  hasCustomizedTuningRef.current = hasCustomizedTuning;
  const onCopyPayloadRef = useRef(onCopyPayload);
  onCopyPayloadRef.current = onCopyPayload;

  // Compose effective CSS and tokens for session updates
  const buildEffectiveCss = useCallback(
    (
      nextTarget: TargetId,
      presetId: ThemePresetId,
      userCss: string,
      includePresetCss: boolean,
      tuningState: StyleTuningState = tuningRef.current,
      includeTuningCss: boolean = hasCustomizedTuningRef.current
    ): string => {
      const trimmedUser = userCss.trim();
      if (nextTarget === 'x-article') {
        return trimmedUser;
      }
      const presetCss = includePresetCss ? THEME_PRESETS[presetId].presetCss : '';
      const extraTuningCss = includeTuningCss ? buildTuningCss(tuningState) : '';
      return [presetCss, extraTuningCss, trimmedUser].filter(Boolean).join('\n\n');
    },
    []
  );

  // Subscribe to session and asset store updates
  useEffect(() => {
    const unsubSession = session.subscribe((renderedSnap) => {
      setSnapshot(renderedSnap);
      const latestDraft = session.getDraftMarkdown();
      if (latestDraft) {
        setMarkdown(latestDraft);
      }
      setIsSaving(false);
    });

    const unsubAssets = store.subscribe(() => {
      setAssetTick((t) => t + 1);
    });

    let active = true;
    void session.waitForIdle().then((idleSnap) => {
      if (active && idleSnap) {
        setSnapshot(idleSnap);
      }
    });

    return () => {
      active = false;
      unsubSession();
      unsubAssets();
    };
  }, [session, store]);

  // Native copy event listener on previewStageRef for partial selection context normalization
  useEffect(() => {
    const stageEl = previewStageRef.current;
    if (!stageEl) return;

    const handleNativeCopy = (event: Event) => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (range.collapsed) return;

      const docRoot = stageEl.querySelector<HTMLElement>('.morph-doc') ?? stageEl;
      const payload = normalizeSelectionRange(range, docRoot, snapshotRef.current, store);

      const clipData = (event as ClipboardEvent).clipboardData;
      if (clipData && typeof clipData.setData === 'function') {
        clipData.setData('text/html', payload.html);
        clipData.setData('text/plain', payload.plainText);
        event.preventDefault();
      }
      onCopyPayloadRef.current?.(payload);
    };

    stageEl.addEventListener('copy', handleNativeCopy);
    return () => {
      stageEl.removeEventListener('copy', handleNativeCopy);
    };
  }, [store]);

  // 3. Target View & Canvas Ratio Handlers
  const handleSwitchTarget = useCallback(
    async (nextTarget: TargetId) => {
      setTargetId(nextTarget);
      if (nextTarget === 'cards') {
        setCanvasPreset(cardRatio);
      } else if (nextTarget === 'x-article') {
        setCanvasPreset(deviceMode === 'mobile' ? '390px' : '680px');
      } else {
        setCanvasPreset(deviceMode === 'mobile' ? '375px' : '720px');
      }

      const effectiveCss = buildEffectiveCss(
        nextTarget,
        activePresetId,
        customCss,
        nextTarget !== 'x-article' || hasCustomizedTokens
      );
      await session.updateStyle({
        customCss: effectiveCss || undefined,
        tokens: nextTarget !== 'x-article' || hasCustomizedTokens ? tokens : undefined,
        cardsOptions: {
          ratio: cardRatio,
          headerText: tuningRef.current.cardHeaderText,
        },
      });
      const snap = await session.setTarget(nextTarget);
      setSnapshot(snap);
    },
    [activePresetId, buildEffectiveCss, cardRatio, customCss, deviceMode, hasCustomizedTokens, session, tokens]
  );

  const handleCanvasPresetChange = useCallback(
    async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const val = e.target.value;
      setCanvasPreset(val);

      if (targetId === 'cards' || ['3:4', '4:5', '1:1', '16:9'].includes(val)) {
        const nextRatio = (
          ['3:4', '4:5', '1:1', '16:9'].includes(val) ? val : '3:4'
        ) as CardAspectRatio;
        setCardRatio(nextRatio);
        const snap = await session.updateStyle({
          cardsOptions: { ratio: nextRatio },
        });
        setSnapshot(snap);
      } else {
        setDeviceMode(val === '375px' || val === '390px' ? 'mobile' : 'desktop');
      }
    },
    [session, targetId]
  );

  // 4. Editor Input, Toolbar Actions, Undo/Redo, and Image Paste
  const updateCursorMetrics = useCallback((textarea: HTMLTextAreaElement) => {
    const pos = textarea.selectionStart ?? 0;
    const slice = textarea.value.slice(0, pos);
    const lines = slice.split('\n');
    setCursorPos({
      line: lines.length,
      col: (lines[lines.length - 1]?.length ?? 0) + 1,
    });
  }, []);

  const applyMarkdownInput = useCallback(
    (nextMd: string, textarea?: HTMLTextAreaElement | null) => {
      if (nextMd === markdownRef.current) return;
      markdownRef.current = nextMd;
      setMarkdown(nextMd);
      setIsSaving(true);
      if (textarea) {
        updateCursorMetrics(textarea);
      }

      void session.inputDoc(nextMd).then((snap) => {
        setSnapshot(snap);
        setIsSaving(false);
      });
    },
    [session, updateCursorMetrics]
  );

  const handleMarkdownChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      applyMarkdownInput(e.target.value, e.target);
    },
    [applyMarkdownInput]
  );

  const insertSnippetAndCommit = useCallback(
    async (snippet: string) => {
      const base = session.getDraftMarkdown() || markdown;
      const prefix = base.endsWith('\n') || base.length === 0 ? '' : '\n\n';
      const nextMd = `${base}${prefix}${snippet}\n`;
      setMarkdown(nextMd);
      const snap = await session.commitDoc(nextMd);
      setSnapshot(snap);
      setIsSaving(false);
    },
    [markdown, session]
  );

  const handleInsertSampleImage = useCallback(async () => {
    const rec = store.ingestSync(createShowcaseCoverPng(), {
      fileName: 'inserted-cover.png',
      mimeType: 'image/png',
    });
    setAssetTick((t) => t + 1);
    await insertSnippetAndCommit(`![插图](${rec.uri})`);
  }, [insertSnippetAndCommit, store]);

  const handleEditorPaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const clipData = e.clipboardData;
      if (!clipData) return;

      const candidateFiles: File[] = [];
      if (clipData.files && clipData.files.length > 0) {
        for (let i = 0; i < clipData.files.length; i++) {
          const f = clipData.files[i];
          if (f && (!f.type || f.type.startsWith('image/'))) {
            candidateFiles.push(f);
          }
        }
      }
      if (candidateFiles.length === 0 && clipData.items) {
        for (let i = 0; i < clipData.items.length; i++) {
          const item = clipData.items[i];
          if (item.kind === 'file' && (!item.type || item.type.startsWith('image/'))) {
            const f = item.getAsFile?.();
            if (f) candidateFiles.push(f);
          }
        }
      }

      if (candidateFiles.length === 0) return;
      e.preventDefault();

      const insertedLinks: string[] = [];
      for (const file of candidateFiles) {
        const bytes = await readFileAsUint8Array(file);
        const rec = store.ingestSync(bytes, {
          fileName: file.name || 'clipboard-image.png',
          mimeType: file.type || 'image/png',
        });
        const altLabel = (file.name || '粘贴图片').replace(/\.[^.]+$/, '');
        insertedLinks.push(`![${altLabel}](${rec.uri})`);
      }

      setAssetTick((t) => t + 1);
      const currentMd = session.getDraftMarkdown() || markdown;
      const sep = currentMd.endsWith('\n') || currentMd.length === 0 ? '' : '\n\n';
      const nextMd = `${currentMd}${sep}${insertedLinks.join('\n\n')}\n`;
      setMarkdown(nextMd);
      const snap = await session.commitDoc(nextMd);
      setSnapshot(snap);
    },
    [markdown, session, store]
  );

  const handleUndo = useCallback(async () => {
    await session.flush();
    const snap = await session.undo();
    const restoredMd = session.getDraftMarkdown();
    setMarkdown(restoredMd);
    if (snap) {
      setSnapshot(snap);
    }
  }, [session]);

  const handleRedo = useCallback(async () => {
    await session.flush();
    const snap = await session.redo();
    const restoredMd = session.getDraftMarkdown();
    setMarkdown(restoredMd);
    if (snap) {
      setSnapshot(snap);
    }
  }, [session]);

  // 5. Style Settings Drawer Handlers
  const handleSelectPreset = useCallback(
    async (presetId: ThemePresetId) => {
      const preset = THEME_PRESETS[presetId];
      const nextTokens: DesignTokens = { ...preset.tokens };
      setActivePresetId(presetId);
      setTokens(nextTokens);
      setHasCustomizedTokens(true);

      const effectiveCss = buildEffectiveCss(targetId, presetId, customCss, true);
      const snap = await session.updateStyle({
        tokens: nextTokens,
        customCss: effectiveCss || undefined,
      });
      setSnapshot(snap);
    },
    [buildEffectiveCss, customCss, session, targetId]
  );

  const applyTokenPatch = useCallback(
    async (patch: Partial<DesignTokens>, forceIncludePresetCss = true) => {
      const nextTokens: DesignTokens = {
        ...tokensRef.current,
        ...(patch as Record<string, string>),
      };
      tokensRef.current = nextTokens;
      setTokens(nextTokens);
      setHasCustomizedTokens(true);

      const effectiveCss = buildEffectiveCss(
        targetId,
        activePresetId,
        customCssRef.current,
        forceIncludePresetCss
      );
      const snap = await session.updateStyle({
        tokens: nextTokens,
        customCss: effectiveCss || undefined,
      });
      setSnapshot(snap);
    },
    [activePresetId, buildEffectiveCss, session, targetId]
  );

  const handleAccentChange = useCallback(
    async (hexValue: string) => {
      const cleaned = hexValue.trim();
      if (tokensRef.current['--morph-accent'] === cleaned) return;
      await applyTokenPatch({ '--morph-accent': cleaned }, true);
    },
    [applyTokenPatch]
  );

  const handleBodySizeChange = useCallback(
    async (rawVal: string) => {
      const formatted = normalizePxValue(rawVal, 15);
      if (tokensRef.current['--morph-body-size'] === formatted) return;
      await applyTokenPatch({ '--morph-body-size': formatted }, false);
    },
    [applyTokenPatch]
  );

  const handleLineHeightChange = useCallback(
    async (rawVal: string) => {
      const trimmed = rawVal.trim() || '1.8';
      if (tokensRef.current['--morph-line-height'] === trimmed) return;
      await applyTokenPatch({ '--morph-line-height': trimmed }, false);
    },
    [applyTokenPatch]
  );

  const handleBlockGapChange = useCallback(
    async (rawVal: string) => {
      const formatted = normalizePxValue(rawVal, 16);
      if (tokensRef.current['--morph-block-gap'] === formatted) return;
      await applyTokenPatch({ '--morph-block-gap': formatted }, false);
    },
    [applyTokenPatch]
  );

  const applyCustomCssValue = useCallback(
    async (nextCss: string) => {
      if (customCssRef.current === nextCss) return;
      customCssRef.current = nextCss;
      setCustomCss(nextCss);
      const effectiveCss = buildEffectiveCss(
        targetId,
        activePresetId,
        nextCss,
        hasCustomizedTokens
      );
      const snap = await session.updateStyle({
        customCss: effectiveCss,
        tokens: hasCustomizedTokens ? tokensRef.current : undefined,
      });
      setSnapshot(snap);
    },
    [activePresetId, buildEffectiveCss, hasCustomizedTokens, session, targetId]
  );

  const handleCustomCssChange = useCallback(
    async (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      await applyCustomCssValue(e.target.value);
    },
    [applyCustomCssValue]
  );

  const applyTuningPatch = useCallback(
    async (patch: Partial<StyleTuningState>) => {
      const nextTuning: StyleTuningState = {
        ...tuningRef.current,
        ...patch,
      };
      tuningRef.current = nextTuning;
      hasCustomizedTuningRef.current = true;
      setTuning(nextTuning);
      setHasCustomizedTuning(true);

      const effectiveCss = buildEffectiveCss(
        targetId,
        activePresetId,
        customCssRef.current,
        targetId !== 'x-article' || hasCustomizedTokens,
        nextTuning,
        true
      );
      const footerFormat =
        nextTuning.cardFooterMode === 'verbose'
          ? (page: number, total: number) => `第 ${page} 页 · 共 ${total} 页`
          : nextTuning.cardFooterMode === 'hidden'
            ? () => ''
            : ('number-slash-total' as const);

      const snap = await session.updateStyle({
        customCss: effectiveCss || undefined,
        tokens: targetId !== 'x-article' || hasCustomizedTokens ? tokensRef.current : undefined,
        cardsOptions: {
          ratio: cardRatio,
          headerText: nextTuning.cardHeaderText,
          footerFormat,
        },
      });
      setSnapshot(snap);
    },
    [activePresetId, buildEffectiveCss, cardRatio, hasCustomizedTokens, session, targetId]
  );

  const handleSelectPaperPreset = useCallback(
    async (paperId: PaperPresetId) => {
      const paper = PAPER_SURFACE_PRESETS.find((p) => p.id === paperId);
      if (!paper) return;
      tuningRef.current = { ...tuningRef.current, paperId };
      setTuning((prev) => ({ ...prev, paperId }));
      await applyTokenPatch(
        {
          '--morph-bg': paper.bg,
          '--morph-ink': paper.ink,
        },
        true
      );
    },
    [applyTokenPatch]
  );

  const handleCardHeaderChange = useCallback(
    async (headerVal: string) => {
      if (tuningRef.current.cardHeaderText === headerVal) return;
      await applyTuningPatch({ cardHeaderText: headerVal });
    },
    [applyTuningPatch]
  );

  const handleLetterSpacingChange = useCallback(
    async (spacingVal: string) => {
      const cleaned = spacingVal.trim() || '0px';
      if (tuningRef.current.letterSpacing === cleaned) return;
      await applyTuningPatch({ letterSpacing: cleaned });
    },
    [applyTuningPatch]
  );

  const handleDraftCssPresetNameChange = useCallback((nextName: string) => {
    draftCssPresetNameRef.current = nextName;
    setDraftCssPresetName(nextName);
  }, []);

  const handleSelectCssPresetItem = useCallback(
    async (item: SavedCssPresetItem) => {
      cssBeforeEditRef.current = customCssRef.current;
      setActiveCssPresetId(item.id);
      setEditingCssPresetId(item.id);
      draftCssPresetNameRef.current = item.name;
      setDraftCssPresetName(item.name);
      setCssViewMode('editor');
      await applyCustomCssValue(item.css);
    },
    [applyCustomCssValue]
  );

  const handleStartNewCssPreset = useCallback(async () => {
    cssBeforeEditRef.current = customCssRef.current;
    setEditingCssPresetId(null);
    draftCssPresetNameRef.current = '';
    setDraftCssPresetName('');
    setCssViewMode('editor');
    await applyCustomCssValue('');
  }, [applyCustomCssValue]);

  const handleBackToCssList = useCallback(() => {
    setCssViewMode('list');
  }, []);

  const handleCancelCssPreset = useCallback(async () => {
    setCssViewMode('list');
    await applyCustomCssValue(cssBeforeEditRef.current);
  }, [applyCustomCssValue]);

  const handleSaveCssPreset = useCallback(async () => {
    const finalName = draftCssPresetNameRef.current.trim() || '未命名样式';
    const finalCss = customCssRef.current;

    if (editingCssPresetId) {
      setSavedCssPresets((prev) =>
        prev.map((item) =>
          item.id === editingCssPresetId
            ? { ...item, name: finalName, css: finalCss, updatedLabel: '刚刚更新' }
            : item
        )
      );
      setActiveCssPresetId(editingCssPresetId);
    } else {
      const nextId = `custom-${Date.now().toString(36)}`;
      const swatch =
        NOTION_ACCENT_SWATCHES[savedCssPresets.length % NOTION_ACCENT_SWATCHES.length];
      const newPreset: SavedCssPresetItem = {
        id: nextId,
        name: finalName,
        updatedLabel: '刚刚保存',
        dotColor: swatch.hex,
        css: finalCss,
      };
      setSavedCssPresets((prev) => [newPreset, ...prev]);
      setActiveCssPresetId(nextId);
      setEditingCssPresetId(nextId);
    }

    await applyCustomCssValue(finalCss);
    setCssViewMode('list');
  }, [applyCustomCssValue, editingCssPresetId, savedCssPresets.length]);

  const handleDeleteCssPreset = useCallback(async () => {
    if (!editingCssPresetId) {
      await applyCustomCssValue(cssBeforeEditRef.current);
      setCssViewMode('list');
      return;
    }
    setSavedCssPresets((prev) => {
      if (prev.length <= 1) return prev;
      const filtered = prev.filter((item) => item.id !== editingCssPresetId);
      const nextActive = filtered[0];
      if (nextActive) {
        setActiveCssPresetId(nextActive.id);
        setEditingCssPresetId(nextActive.id);
        void applyCustomCssValue(nextActive.css);
      }
      return filtered;
    });
    setCssViewMode('list');
  }, [applyCustomCssValue, editingCssPresetId]);

  const handleInsertCssGuideExample = useCallback(
    async (exampleCss: string) => {
      const current = customCssRef.current.trim();
      const nextCss = current ? `${current}\n\n${exampleCss}` : exampleCss;
      await applyCustomCssValue(nextCss);
      setCssGuideOpen(false);
    },
    [applyCustomCssValue]
  );

  useEffect(() => {
    const dialogEl = cssGuideDialogRef.current;
    if (!dialogEl) return;
    if (cssGuideOpen) {
      if (typeof dialogEl.showModal === 'function' && !dialogEl.open) {
        try {
          dialogEl.showModal();
        } catch {
          dialogEl.setAttribute('open', '');
        }
      } else {
        dialogEl.setAttribute('open', '');
      }
    } else if (dialogEl.open) {
      if (typeof dialogEl.close === 'function') {
        try {
          dialogEl.close();
        } catch {
          dialogEl.removeAttribute('open');
        }
      } else {
        dialogEl.removeAttribute('open');
      }
    }
  }, [cssGuideOpen]);

  const handleCssGuideDialogClick = useCallback(
    (event: React.MouseEvent<HTMLDialogElement>) => {
      const dialog = event.currentTarget;
      // Fallback for browsers without <dialog closedby="any"> support:
      // 1. When clicking the backdrop, the event target is the dialog element itself.
      if (event.target !== dialog) return;
      // 2. Check if the click coordinates fall within the dialog's content box.
      const rect = dialog.getBoundingClientRect();
      const isDialogContent =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (isDialogContent) return;
      // 3. Since the click was outside the content area (on the backdrop), close the dialog.
      setCssGuideOpen(false);
    },
    []
  );

  // Native delegated input/change listener to guarantee cross-realm JSDOM & browser compatibility
  useEffect(() => {
    const rootEl = appRootRef.current;
    if (!rootEl) return;

    const handleNativeInputOrChange = (event: Event) => {
      const target = event.target as HTMLElement | null;
      if (!target || typeof target.getAttribute !== 'function') return;
      const testId = target.getAttribute('data-testid');
      if (!testId) return;

      const val = (target as HTMLInputElement | HTMLTextAreaElement).value ?? '';
      switch (testId) {
        case 'markdown-input':
          applyMarkdownInput(val, target as HTMLTextAreaElement);
          break;
        case 'accent-hex-input':
          void handleAccentChange(val);
          break;
        case 'body-size-input':
          void handleBodySizeChange(val);
          break;
        case 'line-height-input':
          void handleLineHeightChange(val);
          break;
        case 'block-gap-input':
          void handleBlockGapChange(val);
          break;
        case 'card-header-input':
          void handleCardHeaderChange(val);
          break;
        case 'letter-spacing-input':
          void handleLetterSpacingChange(val);
          break;
        case 'css-preset-name-input':
          handleDraftCssPresetNameChange(val);
          break;
        case 'custom-css-input':
          void applyCustomCssValue(val);
          break;
        default:
          break;
      }
    };

    rootEl.addEventListener('input', handleNativeInputOrChange);
    rootEl.addEventListener('change', handleNativeInputOrChange);
    return () => {
      rootEl.removeEventListener('input', handleNativeInputOrChange);
      rootEl.removeEventListener('change', handleNativeInputOrChange);
    };
  }, [
    applyCustomCssValue,
    applyMarkdownInput,
    handleAccentChange,
    handleBlockGapChange,
    handleBodySizeChange,
    handleCardHeaderChange,
    handleDraftCssPresetNameChange,
    handleLetterSpacingChange,
    handleLineHeightChange,
  ]);

  const startColumnResize = useCallback((target: 'editor' | 'drawer', clientX: number) => {
    activeResizeRef.current = {
      target,
      startX: clientX,
      startWidth: target === 'editor' ? editorWidthRef.current : drawerWidthRef.current,
    };
  }, []);

  useEffect(() => {
    const rootEl = appRootRef.current;
    const win =
      rootEl?.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);
    if (!rootEl || !win) return;

    const handleNativeMouseDown = (event: MouseEvent) => {
      const targetEl = (event.target as HTMLElement | null)?.closest?.('[data-testid]');
      const testId = targetEl?.getAttribute('data-testid');
      if (testId === 'resizer-editor-preview') {
        startColumnResize('editor', event.clientX);
      } else if (testId === 'resizer-preview-drawer') {
        startColumnResize('drawer', event.clientX);
      }
    };

    const handleWindowMouseMove = (event: MouseEvent) => {
      const active = activeResizeRef.current;
      if (!active) return;
      const deltaX = event.clientX - active.startX;
      if (active.target === 'editor') {
        const nextWidth = Math.min(720, Math.max(260, Math.round(active.startWidth + deltaX)));
        editorWidthRef.current = nextWidth;
        setEditorWidth(nextWidth);
      } else {
        const nextWidth = Math.min(660, Math.max(330, Math.round(active.startWidth - deltaX)));
        drawerWidthRef.current = nextWidth;
        setDrawerWidth(nextWidth);
      }
    };

    const handleWindowMouseUp = () => {
      activeResizeRef.current = null;
    };

    rootEl.addEventListener('mousedown', handleNativeMouseDown);
    win.addEventListener('mousemove', handleWindowMouseMove);
    win.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      rootEl.removeEventListener('mousedown', handleNativeMouseDown);
      win.removeEventListener('mousemove', handleWindowMouseMove);
      win.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [startColumnResize]);

  // 6. Delivery Copy & Export Handlers
  const handlePrimaryDelivery = useCallback(async () => {
    const latestSnap = (await session.flush()) ?? snapshot;
    setSnapshot(latestSnap);

    if (targetId === 'cards') {
      const zipResult = await exportCardsZipPackage(latestSnap, store, {
        ratio: cardRatio,
        filePrefix: 'morphmd',
      });
      onExportCardsZip?.(zipResult);
      triggerBrowserDownload(zipResult.zipFileName, zipResult.zipData, zipResult.mimeType);
      return;
    }

    const payload = serializeFullSnapshot(latestSnap, store);
    onCopyPayload?.(payload);

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload.plainText);
      }
    } catch {
      // Clipboard API permission fallback in non-secure/headless context
    }

    setCopyFeedback(true);
    setTimeout(() => setCopyFeedback(false), 1800);
  }, [cardRatio, onCopyPayload, onExportCardsZip, session, snapshot, store, targetId]);

  const handleExportPackage = useCallback(async () => {
    await session.flush();
    const committedMd = session.getCommittedMarkdown() || markdown;
    const manifest = store.exportPackageManifest(committedMd);
    onExportPackage?.(manifest);
    triggerBrowserDownload('article.md', manifest.rewrittenContent, 'text/markdown;charset=utf-8');
  }, [markdown, onExportPackage, session, store]);

  // 7. Diagnostics & Status Calculations
  const diagnostics = snapshot.diagnostics ?? [];
  const warningDiagnostics = useMemo(
    () => diagnostics.filter((d) => d.severity === 'warning'),
    [diagnostics]
  );
  const errorDiagnostics = useMemo(
    () => diagnostics.filter((d) => d.severity === 'error'),
    [diagnostics]
  );
  const actionableDiagnosticsCount = warningDiagnostics.length + errorDiagnostics.length;
  const filteredDiagnostics = useMemo(() => {
    if (diagFilter === 'warning') return warningDiagnostics;
    if (diagFilter === 'error') return errorDiagnostics;
    return diagnostics;
  }, [diagFilter, diagnostics, errorDiagnostics, warningDiagnostics]);

  const handleDiagnosticItemClick = useCallback((item: DiagnosticItem) => {
    const targetLine = item.sourceRange?.[0] ?? 1;
    setActiveHighlightLine(targetLine);
    setCursorPos({ line: targetLine, col: 1 });
    if (textareaRef.current && !navigator.userAgent?.includes('jsdom')) {
      textareaRef.current.focus();
    }
  }, []);

  const assetStats = useMemo(() => {
    void assetTick;
    const refIds = extractReferencedAssetIds(markdown);
    let readyCount = 0;
    for (const id of refIds) {
      const rec = store.get(id);
      if (rec && (rec.status === 'delivery-ready' || rec.status === 'preview-ready')) {
        readyCount++;
      }
    }
    return {
      total: refIds.length,
      ready: readyCount,
    };
  }, [assetTick, markdown, store]);

  const lineCount = useMemo(() => Math.max(1, markdown.split('\n').length), [markdown]);
  const lineNumbers = useMemo(
    () => Array.from({ length: lineCount }, (_, idx) => idx + 1),
    [lineCount]
  );

  const cardPageCount = useMemo(() => {
    if (targetId !== 'cards') return 0;
    const matches = snapshot.html.match(/class="[^"]*\bmorph-card-page\b/g);
    return matches ? matches.length : 1;
  }, [snapshot.html, targetId]);

  const adapterStatusLabel = useMemo(() => {
    if (targetId === 'wechat') return '微信适配器 · 正常';
    if (targetId === 'x-article') return 'X 长文适配器 · 正常';
    return `卡片分页适配器 · 共 ${cardPageCount} 页`;
  }, [cardPageCount, targetId]);

  const stageMaxWidth = useMemo(() => {
    if (targetId === 'cards') return '100%';
    if (deviceMode === 'mobile') return targetId === 'x-article' ? '390px' : '375px';
    return targetId === 'x-article' ? '680px' : '720px';
  }, [deviceMode, targetId]);

  const stageZoomScale = useMemo(() => {
    const num = parseFloat(zoomPercent);
    const baseZoom = Number.isNaN(num) ? 1 : num / 100;
    return targetId === 'cards' ? Number((baseZoom * 0.68).toFixed(3)) : baseZoom;
  }, [targetId, zoomPercent]);

  const bodySizePx = parseNumericPx(tokens['--morph-body-size'], 15);
  const blockGapPx = parseNumericPx(tokens['--morph-block-gap'], 16);

  return (
    <div ref={appRootRef} className="morph-app">
      {/* 1. Top Global Header */}
      <header className="morph-header" data-testid="workbench-header">
        <div className="morph-brand">
          <span className="morph-logo-badge" aria-hidden="true">
            M
          </span>
          <div className="morph-brand-text">
            <div className="morph-brand-row">
              <h1 className="morph-brand-title" data-testid="brand-title">
                MorphMD
              </h1>
              <span className="morph-beta-pill">Beta</span>
            </div>
            <p className="morph-brand-subtitle">一份 Markdown，多种发布形态</p>
          </div>
        </div>

        <nav
          className="morph-target-switcher"
          aria-label="目标视图切换"
          data-testid="target-switcher"
        >
          <button
            type="button"
            className="morph-target-tab"
            data-testid="target-tab-wechat"
            data-target="wechat"
            aria-pressed={targetId === 'wechat' ? 'true' : 'false'}
            onClick={() => void handleSwitchTarget('wechat')}
          >
            微信公众号
          </button>
          <button
            type="button"
            className="morph-target-tab"
            data-testid="target-tab-x-article"
            data-target="x-article"
            aria-pressed={targetId === 'x-article' ? 'true' : 'false'}
            onClick={() => void handleSwitchTarget('x-article')}
          >
            X 长文
          </button>
          <button
            type="button"
            className="morph-target-tab"
            data-testid="target-tab-cards"
            data-target="cards"
            aria-pressed={targetId === 'cards' ? 'true' : 'false'}
            onClick={() => void handleSwitchTarget('cards')}
          >
            图文卡片
          </button>
        </nav>

        <div className="morph-header-actions">
          <select
            className="morph-select"
            aria-label="缩放比例"
            data-testid="zoom-select"
            value={zoomPercent}
            onChange={(e) => setZoomPercent(e.target.value)}
          >
            <option value="75%">75%</option>
            <option value="100%">100%</option>
            <option value="125%">125%</option>
            <option value="150%">150%</option>
          </select>

          <button
            type="button"
            className="morph-btn-secondary morph-btn-icon"
            data-testid="undo-btn"
            aria-label="撤销"
            title="撤销 (Undo)"
            onClick={() => void handleUndo()}
          >
            ↶
          </button>
          <button
            type="button"
            className="morph-btn-secondary morph-btn-icon"
            data-testid="redo-btn"
            aria-label="重做"
            title="重做 (Redo)"
            onClick={() => void handleRedo()}
          >
            ↷
          </button>

          <button
            type="button"
            className="morph-btn-secondary"
            data-testid="export-package-btn"
            onClick={() => void handleExportPackage()}
          >
            导出 .md + assets
          </button>

          <button
            type="button"
            className="morph-btn-primary"
            data-testid="primary-delivery-btn"
            onClick={() => void handlePrimaryDelivery()}
          >
            {targetId === 'cards'
              ? '导出高清卡片'
              : copyFeedback
                ? '✓ 已复制富文本'
                : '复制富文本'}
          </button>

          <button
            type="button"
            className="morph-btn-secondary"
            data-testid="toggle-style-drawer-btn"
            aria-expanded={drawerOpen ? 'true' : 'false'}
            onClick={() => setDrawerOpen((prev) => !prev)}
          >
            样式设置
          </button>
        </div>
      </header>

      {/* 2. Three-Column Main Workspace */}
      <main
        className={`morph-main ${drawerOpen ? 'drawer-open' : 'drawer-closed'}`}
        data-testid="workbench-main"
      >
        {/* Left Pane: Markdown Source Editor */}
        <section
          className="morph-pane morph-editor-pane"
          data-testid="editor-pane"
          aria-label="Markdown 源码编辑区"
          style={{ width: `${editorWidth}px` }}
        >
          <div className="morph-pane-toolbar">
            <div className="morph-doc-meta" data-testid="doc-status">
              <span>article.md</span>
              <span className="morph-save-badge">
                <span className="morph-save-dot" aria-hidden="true" />
                {isSaving ? '编译中...' : '已保存'}
              </span>
            </div>

            <div className="morph-format-toolbar" role="toolbar" aria-label="Markdown 快捷格式工具栏">
              <button
                type="button"
                className="morph-tool-btn"
                data-testid="toolbar-insert-image"
                aria-label="插入图片"
                title="插入图片 (morph-asset://)"
                onClick={() => void handleInsertSampleImage()}
              >
                🖼
              </button>
              <button
                type="button"
                className="morph-tool-btn"
                data-testid="toolbar-insert-link"
                aria-label="插入链接"
                title="插入链接"
                onClick={() => void insertSnippetAndCommit('[链接文本](https://morphmd.dev)')}
              >
                🔗
              </button>
              <button
                type="button"
                className="morph-tool-btn"
                data-testid="toolbar-insert-table"
                aria-label="插入表格"
                title="插入 GFM 表格"
                onClick={() =>
                  void insertSnippetAndCommit(
                    '| 视图目标 | 排版特性 | 输出结果 |\n| :--- | :--- | :--- |\n| 微信公众号 | 受控 CSS 内联 | 富文本复制 |\n| 图文卡片 | 多比例分页 | PNG / ZIP |'
                  )
                }
              >
                ⊞
              </button>
              <button
                type="button"
                className="morph-tool-btn"
                data-testid="toolbar-insert-ul"
                aria-label="插入无序列表"
                title="插入无序列表"
                onClick={() => void insertSnippetAndCommit('- 列表项一\n- 列表项二')}
              >
                •
              </button>
              <button
                type="button"
                className="morph-tool-btn"
                data-testid="toolbar-insert-ol"
                aria-label="插入有序列表"
                title="插入有序列表"
                onClick={() => void insertSnippetAndCommit('1. 第一步\n2. 第二步')}
              >
                1.
              </button>
              <button
                type="button"
                className="morph-tool-btn"
                data-testid="toolbar-insert-code"
                aria-label="插入代码块"
                title="插入代码块"
                onClick={() =>
                  void insertSnippetAndCommit(
                    '```ts\nconst snapshot = await buildDeliverySnapshot(md, "wechat", store);\n```'
                  )
                }
              >
                {'<>'}
              </button>
            </div>
          </div>

          <div className="morph-editor-body" data-testid="markdown-editor">
            <div
              className="morph-line-gutter"
              data-testid="editor-line-numbers"
              aria-hidden="true"
            >
              {lineNumbers.map((num) => (
                <div
                  key={num}
                  className={`morph-line-num ${activeHighlightLine === num ? 'is-active' : ''}`}
                >
                  {num}
                </div>
              ))}
            </div>
            <textarea
              ref={textareaRef}
              className="morph-textarea"
              data-testid="markdown-input"
              aria-label="Markdown 源码编辑器"
              value={markdown}
              onChange={handleMarkdownChange}
              onPaste={(e) => void handleEditorPaste(e)}
              onClick={(e) => updateCursorMetrics(e.currentTarget)}
              onKeyUp={(e) => updateCursorMetrics(e.currentTarget)}
              spellCheck={false}
            />
          </div>

          <div className="morph-pane-footer" data-testid="editor-footer">
            <span>
              行 {cursorPos.line}, 列 {cursorPos.col}
            </span>
            <span>{markdown.length} 个字符</span>
            <span>Markdown</span>
          </div>
        </section>

        {/* Left-Center Column Resizer */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整编辑区与预览区宽度"
          className="morph-col-resizer"
          data-testid="resizer-editor-preview"
          onMouseDown={(e) => startColumnResize('editor', e.clientX)}
        />

        {/* Center Pane: Isomorphic Preview Stage */}
        <section
          className="morph-pane morph-preview-pane"
          data-testid="preview-pane"
          aria-label="同构预览舞台"
        >
          <div className="morph-pane-toolbar">
            <div className="morph-preview-tabs">
              <button
                type="button"
                className={`morph-subtab ${previewMode === 'render' ? 'is-active' : ''}`}
                data-testid="preview-mode-render"
                onClick={() => setPreviewMode('render')}
              >
                预览
              </button>
              <button
                type="button"
                className={`morph-subtab ${previewMode === 'sourcemap' ? 'is-active' : ''}`}
                data-testid="preview-mode-sourcemap"
                onClick={() => setPreviewMode('sourcemap')}
              >
                源码映射
              </button>
            </div>

            <div className="morph-preview-controls">
              <div className="morph-device-group" role="group" aria-label="画布设备模式">
                <button
                  type="button"
                  className={`morph-device-btn ${deviceMode === 'desktop' ? 'is-active' : ''}`}
                  data-testid="viewport-desktop-btn"
                  aria-label="桌面宽屏预览"
                  onClick={() => setDeviceMode('desktop')}
                >
                  🖥
                </button>
                <button
                  type="button"
                  className={`morph-device-btn ${deviceMode === 'mobile' ? 'is-active' : ''}`}
                  data-testid="viewport-mobile-btn"
                  aria-label="移动窄屏预览"
                  onClick={() => setDeviceMode('mobile')}
                >
                  📱
                </button>
              </div>

              <select
                className="morph-select"
                aria-label="画布规格"
                data-testid="canvas-preset-select"
                value={targetId === 'cards' ? cardRatio : canvasPreset}
                onChange={(e) => void handleCanvasPresetChange(e)}
              >
                {targetId === 'cards' ? (
                  <>
                    <option value="3:4">3:4 竖版卡片 (1440×1920)</option>
                    <option value="4:5">4:5 社交贴图 (1440×1800)</option>
                    <option value="1:1">1:1 方形卡片 (1440×1440)</option>
                    <option value="16:9">16:9 横版演示 (1920×1080)</option>
                  </>
                ) : targetId === 'x-article' ? (
                  <>
                    <option value="680px">X 长文画布 (680px)</option>
                    <option value="390px">移动端视图 (390px)</option>
                    <option value="3:4">3:4 竖版卡片</option>
                    <option value="4:5">4:5 社交贴图</option>
                    <option value="1:1">1:1 方形卡片</option>
                    <option value="16:9">16:9 横版演示</option>
                  </>
                ) : (
                  <>
                    <option value="720px">公众号画布 (720px)</option>
                    <option value="375px">手机视图 (375px)</option>
                    <option value="3:4">3:4 竖版卡片</option>
                    <option value="4:5">4:5 社交贴图</option>
                    <option value="1:1">1:1 方形卡片</option>
                    <option value="16:9">16:9 横版演示</option>
                  </>
                )}
              </select>
            </div>
          </div>

          <div className="morph-preview-scroll">
            <div
              ref={previewStageRef}
              className={`morph-preview-stage ${previewMode === 'sourcemap' ? 'show-sourcemap' : ''}`}
              data-testid="preview-stage"
              data-target-view={targetId}
              data-card-ratio={cardRatio}
              style={
                {
                  '--stage-max-width': stageMaxWidth,
                  '--stage-zoom': stageZoomScale,
                } as React.CSSProperties
              }
              dangerouslySetInnerHTML={{ __html: snapshot.html }}
            />
          </div>
        </section>

        {/* Center-Right Column Resizer */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整预览区与样式设置宽度"
          className="morph-col-resizer"
          data-testid="resizer-preview-drawer"
          hidden={!drawerOpen}
          onMouseDown={(e) => startColumnResize('drawer', e.clientX)}
        />

        {/* Right Pane: Collapsible Style Settings Drawer */}
        <aside
          className="morph-style-drawer"
          data-testid="style-drawer"
          data-open={drawerOpen ? 'true' : 'false'}
          aria-hidden={drawerOpen ? 'false' : 'true'}
          hidden={!drawerOpen}
          aria-label="样式设置面板"
          style={{ width: `${drawerOpen ? drawerWidth : 0}px` }}
        >
          <div className="morph-drawer-header">
            <h2 className="morph-drawer-title">样式设置</h2>
            <button
              type="button"
              className="morph-tool-btn"
              data-testid="close-style-drawer-btn"
              aria-label="关闭样式设置"
              onClick={() => setDrawerOpen(false)}
            >
              ✕
            </button>
          </div>

          <div className="morph-drawer-tabs" role="tablist" aria-label="样式设置分组">
            <button
              type="button"
              role="tab"
              aria-selected={activeStyleTab === 'theme'}
              className={`morph-drawer-tab ${activeStyleTab === 'theme' ? 'is-active' : ''}`}
              data-testid="style-tab-theme"
              onClick={() => setActiveStyleTab('theme')}
            >
              主题
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeStyleTab === 'typography'}
              className={`morph-drawer-tab ${activeStyleTab === 'typography' ? 'is-active' : ''}`}
              data-testid="style-tab-typography"
              onClick={() => setActiveStyleTab('typography')}
            >
              排版
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeStyleTab === 'css'}
              className={`morph-drawer-tab ${activeStyleTab === 'css' ? 'is-active' : ''}`}
              data-testid="style-tab-css"
              onClick={() => setActiveStyleTab('css')}
            >
              自定义 CSS
            </button>
          </div>

          <div className="morph-drawer-content">
            {/* TAB PANEL 1: THEME (主题预设、主题色、纸张底色、组件装饰、卡片页眉页脚、预览) */}
            {activeStyleTab === 'theme' && (
              <div
                className="morph-drawer-panel"
                role="tabpanel"
                data-testid="style-panel-theme"
                aria-label="主题设置面板"
              >
                <div className="morph-style-section" data-section="theme">
                  <div className="morph-section-header">
                    <h3 className="morph-section-label">主题预设</h3>
                    <span className="morph-section-hint">
                      {THEME_PRESETS[activePresetId].description}
                    </span>
                  </div>
                  <div className="morph-preset-grid">
                    {(Object.keys(THEME_PRESETS) as ThemePresetId[]).map((presetKey) => {
                      const preset = THEME_PRESETS[presetKey];
                      const isActive = activePresetId === presetKey;
                      return (
                        <button
                          key={presetKey}
                          type="button"
                          className={`morph-preset-card ${isActive ? 'is-active' : ''}`}
                          data-testid={`preset-card-${presetKey}`}
                          aria-pressed={isActive ? 'true' : 'false'}
                          onClick={() => void handleSelectPreset(presetKey)}
                        >
                          <div
                            className="morph-preset-thumb"
                            style={
                              {
                                '--preset-bg': preset.previewBg,
                                '--preset-ink': preset.darkPreview ? '#e2e8f0' : preset.previewInk,
                                '--preset-accent': preset.previewAccent,
                              } as React.CSSProperties
                            }
                            aria-hidden="true"
                          >
                            <span className="morph-preset-line" />
                            <span className="morph-preset-line" />
                            <span className="morph-preset-line short" />
                          </div>
                          <span className="morph-preset-name">{preset.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="morph-style-section" data-section="accent">
                  <h3 className="morph-section-label">主题色</h3>
                  <div className="morph-swatch-row">
                    <div className="morph-swatches" role="group" aria-label="Notion 主题色板">
                      {NOTION_ACCENT_SWATCHES.map((swatch) => {
                        const isSelected =
                          tokens['--morph-accent'].toLowerCase() === swatch.hex.toLowerCase();
                        return (
                          <button
                            key={swatch.hex}
                            type="button"
                            className={`morph-swatch-btn ${isSelected ? 'is-active' : ''}`}
                            data-testid={`accent-swatch-${swatch.hex}`}
                            aria-label={swatch.label}
                            title={`${swatch.label} (${swatch.hex})`}
                            style={{ '--swatch-color': swatch.hex } as React.CSSProperties}
                            onClick={() => void handleAccentChange(swatch.hex)}
                          />
                        );
                      })}
                    </div>
                    <input
                      type="text"
                      className="morph-hex-input"
                      data-testid="accent-hex-input"
                      aria-label="主题色十六进制值"
                      value={tokens['--morph-accent']}
                      onChange={(e) => void handleAccentChange(e.target.value)}
                    />
                  </div>
                </div>

                <div className="morph-style-section" data-section="paper">
                  <div className="morph-section-header">
                    <h3 className="morph-section-label">画布与纸张底色</h3>
                    <span className="morph-section-hint">{tokens['--morph-bg']}</span>
                  </div>
                  <div className="morph-paper-grid">
                    {PAPER_SURFACE_PRESETS.map((paper) => {
                      const isActive =
                        tokens['--morph-bg'].toLowerCase() === paper.bg.toLowerCase();
                      return (
                        <button
                          key={paper.id}
                          type="button"
                          className={`morph-paper-btn ${isActive ? 'is-active' : ''}`}
                          data-testid={`paper-preset-${paper.id}`}
                          aria-pressed={isActive ? 'true' : 'false'}
                          onClick={() => void handleSelectPaperPreset(paper.id)}
                        >
                          <span
                            className="morph-paper-dot"
                            style={{ backgroundColor: paper.bg }}
                            aria-hidden="true"
                          />
                          <span>{paper.label}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="morph-style-section" data-section="decorations">
                  <h3 className="morph-section-label">组件视觉风格</h3>

                  <div className="morph-field-row">
                    <label className="morph-field-label" htmlFor="morph-heading-style-select">
                      二级标题
                    </label>
                    <select
                      id="morph-heading-style-select"
                      className="morph-field-select"
                      data-testid="heading-style-select"
                      value={tuning.headingStyle}
                      onChange={(e) =>
                        void applyTuningPatch({
                          headingStyle: e.target.value as HeadingStyleId,
                        })
                      }
                    >
                      {HEADING_STYLE_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="morph-field-row">
                    <label className="morph-field-label" htmlFor="morph-quote-style-select">
                      引用容器
                    </label>
                    <select
                      id="morph-quote-style-select"
                      className="morph-field-select"
                      data-testid="quote-style-select"
                      value={tuning.quoteStyle}
                      onChange={(e) =>
                        void applyTuningPatch({
                          quoteStyle: e.target.value as QuoteStyleId,
                        })
                      }
                    >
                      {QUOTE_STYLE_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="morph-field-row">
                    <label className="morph-field-label" htmlFor="morph-image-radius-select">
                      插图圆角
                    </label>
                    <select
                      id="morph-image-radius-select"
                      className="morph-field-select"
                      data-testid="image-radius-select"
                      value={tuning.imageRadius}
                      onChange={(e) =>
                        void applyTuningPatch({
                          imageRadius: e.target.value as ImageRadiusId,
                        })
                      }
                    >
                      {IMAGE_RADIUS_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="morph-style-section" data-section="card-branding">
                  <div className="morph-section-header">
                    <h3 className="morph-section-label">卡片画布装修</h3>
                    <span className="morph-section-hint">图文卡片视图</span>
                  </div>

                  <div className="morph-field-row">
                    <label className="morph-field-label" htmlFor="morph-card-header-input">
                      页眉署名
                    </label>
                    <input
                      id="morph-card-header-input"
                      type="text"
                      className="morph-field-input"
                      data-testid="card-header-input"
                      value={tuning.cardHeaderText}
                      placeholder="MorphMD"
                      onChange={(e) => void handleCardHeaderChange(e.target.value)}
                    />
                  </div>

                  <div className="morph-field-row">
                    <label className="morph-field-label" htmlFor="morph-card-footer-select">
                      页码格式
                    </label>
                    <select
                      id="morph-card-footer-select"
                      className="morph-field-select"
                      data-testid="card-footer-select"
                      value={tuning.cardFooterMode}
                      onChange={(e) =>
                        void applyTuningPatch({
                          cardFooterMode: e.target.value as StyleTuningState['cardFooterMode'],
                        })
                      }
                    >
                      <option value="slash">1 / N 极简斜杠</option>
                      <option value="verbose">第 1 页 · 共 N 页</option>
                      <option value="hidden">隐藏底部页码</option>
                    </select>
                  </div>
                </div>

                <div className="morph-style-section">
                  <h3 className="morph-section-label">预览效果</h3>
                  <div
                    className="morph-mini-preview"
                    data-testid="typography-mini-preview"
                    style={{
                      backgroundColor: tokens['--morph-bg'],
                      color: tokens['--morph-ink'],
                      borderLeft: `3px solid ${tokens['--morph-accent']}`,
                    }}
                  >
                    <span className="morph-mini-aa" style={{ color: tokens['--morph-accent'] }}>
                      Aa
                    </span>
                    <div className="morph-mini-lines" style={{ color: tokens['--morph-ink'] }}>
                      <span>永远相信美好的事情即将发生</span>
                      <span className="morph-mini-sub">The best is yet to come.</span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB PANEL 2: TYPOGRAPHY (字体组合、基础排版、标题与段落细节、代码与列表、预览) */}
            {activeStyleTab === 'typography' && (
              <div
                className="morph-drawer-panel"
                role="tabpanel"
                data-testid="style-panel-typography"
                aria-label="排版设置面板"
              >
                <div className="morph-style-section" data-section="fonts">
                  <h3 className="morph-section-label">字体组合</h3>
                  <div className="morph-field-row">
                    <label className="morph-field-label" htmlFor="morph-font-sans-select">
                      中文字体
                    </label>
                    <select
                      id="morph-font-sans-select"
                      className="morph-field-select"
                      data-testid="font-sans-select"
                      value={tokens['--morph-font-sans']}
                      onChange={(e) =>
                        void applyTokenPatch({ '--morph-font-sans': e.target.value }, false)
                      }
                    >
                      {FONT_SANS_OPTIONS.map((opt) => (
                        <option key={opt.label} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="morph-field-row">
                    <label className="morph-field-label" htmlFor="morph-font-serif-select">
                      西文字体
                    </label>
                    <select
                      id="morph-font-serif-select"
                      className="morph-field-select"
                      data-testid="font-serif-select"
                      value={tokens['--morph-font-serif']}
                      onChange={(e) =>
                        void applyTokenPatch({ '--morph-font-serif': e.target.value }, false)
                      }
                    >
                      {FONT_SERIF_OPTIONS.map((opt) => (
                        <option key={opt.label} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="morph-field-row">
                    <label className="morph-field-label" htmlFor="morph-font-mono-select">
                      等宽字体
                    </label>
                    <select
                      id="morph-font-mono-select"
                      className="morph-field-select"
                      data-testid="font-mono-select"
                      value={tokens['--morph-font-mono']}
                      onChange={(e) =>
                        void applyTokenPatch({ '--morph-font-mono': e.target.value }, false)
                      }
                    >
                      {FONT_MONO_OPTIONS.map((opt) => (
                        <option key={opt.label} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="morph-style-section" data-section="typography">
                  <h3 className="morph-section-label">基础排版</h3>

                  <div className="morph-field-row">
                    <label className="morph-field-label" htmlFor="morph-body-size-input">
                      字号
                    </label>
                    <div className="morph-slider-group">
                      <input
                        type="range"
                        className="morph-range"
                        min={12}
                        max={22}
                        step={1}
                        aria-label="字号滑块"
                        value={bodySizePx}
                        onChange={(e) => void handleBodySizeChange(`${e.target.value}px`)}
                      />
                      <input
                        id="morph-body-size-input"
                        type="text"
                        className="morph-value-input"
                        data-testid="body-size-input"
                        value={tokens['--morph-body-size']}
                        onChange={(e) => void handleBodySizeChange(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="morph-field-row">
                    <label className="morph-field-label" htmlFor="morph-line-height-input">
                      行高
                    </label>
                    <div className="morph-slider-group">
                      <input
                        type="range"
                        className="morph-range"
                        min={1.3}
                        max={2.2}
                        step={0.05}
                        aria-label="行高滑块"
                        value={parseFloat(tokens['--morph-line-height']) || 1.8}
                        onChange={(e) => void handleLineHeightChange(e.target.value)}
                      />
                      <input
                        id="morph-line-height-input"
                        type="text"
                        className="morph-value-input"
                        data-testid="line-height-input"
                        value={tokens['--morph-line-height']}
                        onChange={(e) => void handleLineHeightChange(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="morph-field-row">
                    <label className="morph-field-label" htmlFor="morph-block-gap-input">
                      段落间距
                    </label>
                    <div className="morph-slider-group">
                      <input
                        type="range"
                        className="morph-range"
                        min={8}
                        max={32}
                        step={2}
                        aria-label="段落间距滑块"
                        value={blockGapPx}
                        onChange={(e) => void handleBlockGapChange(`${e.target.value}px`)}
                      />
                      <input
                        id="morph-block-gap-input"
                        type="text"
                        className="morph-value-input"
                        data-testid="block-gap-input"
                        value={tokens['--morph-block-gap']}
                        onChange={(e) => void handleBlockGapChange(e.target.value)}
                      />
                    </div>
                  </div>
                </div>

                <div className="morph-style-section" data-section="paragraph-details">
                  <h3 className="morph-section-label">段落与字距细节</h3>

                  <div className="morph-field-row">
                    <label className="morph-field-label" htmlFor="morph-heading-scale-select">
                      标题倍率
                    </label>
                    <select
                      id="morph-heading-scale-select"
                      className="morph-field-select"
                      data-testid="heading-scale-select"
                      value={tuning.headingScale}
                      onChange={(e) =>
                        void applyTuningPatch({
                          headingScale: e.target.value as HeadingScaleId,
                        })
                      }
                    >
                      {HEADING_SCALE_OPTIONS.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="morph-field-row">
                    <label className="morph-field-label" htmlFor="morph-letter-spacing-input">
                      正文字距
                    </label>
                    <div className="morph-slider-group">
                      <input
                        type="range"
                        className="morph-range"
                        min={0}
                        max={2}
                        step={0.2}
                        aria-label="字距滑块"
                        value={parseFloat(tuning.letterSpacing) || 0}
                        onChange={(e) => void handleLetterSpacingChange(`${e.target.value}px`)}
                      />
                      <input
                        id="morph-letter-spacing-input"
                        type="text"
                        className="morph-value-input"
                        data-testid="letter-spacing-input"
                        value={tuning.letterSpacing}
                        onChange={(e) => void handleLetterSpacingChange(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="morph-field-row">
                    <span className="morph-field-label">正文对齐</span>
                    <div className="morph-segmented-row" role="group" aria-label="正文对齐方式">
                      <button
                        type="button"
                        className={`morph-seg-btn ${tuning.textAlign === 'left' ? 'is-active' : ''}`}
                        data-testid="text-align-left"
                        onClick={() => void applyTuningPatch({ textAlign: 'left' })}
                      >
                        左对齐
                      </button>
                      <button
                        type="button"
                        className={`morph-seg-btn ${tuning.textAlign === 'justify' ? 'is-active' : ''}`}
                        data-testid="text-align-justify"
                        onClick={() => void applyTuningPatch({ textAlign: 'justify' })}
                      >
                        两端对齐
                      </button>
                    </div>
                  </div>

                  <div className="morph-field-row">
                    <span className="morph-field-label">首行缩进</span>
                    <div className="morph-segmented-row" role="group" aria-label="首行缩进设置">
                      <button
                        type="button"
                        className={`morph-seg-btn ${!tuning.paragraphIndent ? 'is-active' : ''}`}
                        onClick={() => void applyTuningPatch({ paragraphIndent: false })}
                      >
                        无缩进
                      </button>
                      <button
                        type="button"
                        className={`morph-seg-btn ${tuning.paragraphIndent ? 'is-active' : ''}`}
                        data-testid="paragraph-indent-toggle"
                        aria-pressed={tuning.paragraphIndent ? 'true' : 'false'}
                        onClick={() =>
                          void applyTuningPatch({ paragraphIndent: !tuning.paragraphIndent })
                        }
                      >
                        缩进 2 字符
                      </button>
                    </div>
                  </div>
                </div>

                <div className="morph-style-section" data-section="code-and-list">
                  <h3 className="morph-section-label">代码与列表排版</h3>

                  <div className="morph-field-row">
                    <label className="morph-field-label" htmlFor="morph-code-size-select">
                      代码字号
                    </label>
                    <select
                      id="morph-code-size-select"
                      className="morph-field-select"
                      data-testid="code-size-select"
                      value={tuning.codeSize}
                      onChange={(e) => void applyTuningPatch({ codeSize: e.target.value })}
                    >
                      <option value="12px">紧凑 (12px)</option>
                      <option value="13px">标准 (13px)</option>
                      <option value="14px">舒适 (14px)</option>
                      <option value="15px">醒目 (15px)</option>
                    </select>
                  </div>

                  <div className="morph-field-row">
                    <label className="morph-field-label" htmlFor="morph-list-gap-select">
                      列表间距
                    </label>
                    <select
                      id="morph-list-gap-select"
                      className="morph-field-select"
                      data-testid="list-gap-select"
                      value={tuning.listGap}
                      onChange={(e) => void applyTuningPatch({ listGap: e.target.value })}
                    >
                      <option value="4px">紧凑 (4px)</option>
                      <option value="6px">标准 (6px)</option>
                      <option value="10px">宽松 (10px)</option>
                    </select>
                  </div>
                </div>

                <div className="morph-style-section">
                  <h3 className="morph-section-label">排版节奏预览</h3>
                  <div className="morph-mini-preview" data-testid="typography-mini-preview">
                    <span className="morph-mini-aa">Aa</span>
                    <div
                      className="morph-mini-lines"
                      style={{
                        lineHeight: tokens['--morph-line-height'],
                        letterSpacing: tuning.letterSpacing,
                      }}
                    >
                      <span>永远相信美好的事情即将发生</span>
                      <span className="morph-mini-sub">
                        字号 {tokens['--morph-body-size']} · 行高 {tokens['--morph-line-height']} · 段距{' '}
                        {tokens['--morph-block-gap']}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* TAB PANEL 3: CUSTOM CSS (In-place Drill-down Navigation: 列表层 <-> 原地右滑编辑层) */}
            {activeStyleTab === 'css' && (
              <div
                className="morph-drawer-panel"
                role="tabpanel"
                data-testid="style-panel-css"
                data-view-mode={cssViewMode}
                aria-label="自定义 CSS 面板"
              >
                <div className="morph-css-slider-viewport">
                  <div
                    className={`morph-css-slider-track ${cssViewMode === 'editor' ? 'is-editor' : ''}`}
                  >
                    {/* SLIDE PANE 1: MASTER STYLE LIST */}
                    <div
                      className="morph-css-slide-pane"
                      data-testid="css-list-view"
                      aria-hidden={cssViewMode !== 'list'}
                    >
                      <div className="morph-css-list-top">
                        <p className="morph-css-list-intro">
                          通过自定义 CSS 精细调整输出样式，支持保存多套样式方案并随时切换。
                        </p>
                        <button
                          type="button"
                          className="morph-new-css-btn"
                          data-testid="new-css-preset-btn"
                          onClick={() => void handleStartNewCssPreset()}
                        >
                          + 新建样式
                        </button>
                      </div>

                      <div className="morph-css-preset-list" data-testid="css-preset-list">
                        {savedCssPresets.map((item) => {
                          const isSelected = activeCssPresetId === item.id;
                          return (
                            <button
                              key={item.id}
                              type="button"
                              className={`morph-css-preset-card ${isSelected ? 'is-active' : ''}`}
                              data-testid={`css-preset-item-${item.id}`}
                              onClick={() => void handleSelectCssPresetItem(item)}
                            >
                              <div className="morph-css-preset-left">
                                <span
                                  className="morph-css-preset-dot"
                                  style={{ backgroundColor: item.dotColor }}
                                  aria-hidden="true"
                                />
                                <div className="morph-css-preset-meta">
                                  <span className="morph-css-preset-title">{item.name}</span>
                                  <span className="morph-css-preset-sub">
                                    自定义样式 · {item.updatedLabel}
                                  </span>
                                </div>
                              </div>
                              <span className="morph-css-preset-chevron" aria-hidden="true">
                                ›
                              </span>
                            </button>
                          );
                        })}
                      </div>

                      <div className="morph-capability-card">
                        <span className="morph-capability-title">
                          {targetId === 'wechat'
                            ? '✓ 微信公众号：全量白名单 CSS 自动内联'
                            : targetId === 'cards'
                              ? '✓ 图文卡片：支持内联样式与高清分页栅格化'
                              : '⚠ X 长文：原生富文本不支持内联 CSS（自动降级）'}
                        </span>
                        <span className="morph-capability-desc">
                          点击上方任意样式方案可从右侧滑入代码编辑器，修改或新建专属样式。
                        </span>
                      </div>
                    </div>

                    {/* SLIDE PANE 2: IN-PLACE DRILL-DOWN CSS EDITOR */}
                    <div
                      className="morph-css-slide-pane"
                      data-testid="css-drilldown-view"
                      aria-hidden={cssViewMode !== 'editor'}
                    >
                      <div className="morph-css-drilldown-header">
                        <button
                          type="button"
                          className="morph-back-icon-btn"
                          data-testid="back-to-css-list-btn"
                          aria-label="返回样式列表"
                          title="返回样式列表"
                          onClick={handleBackToCssList}
                        >
                          ←
                        </button>
                        <span className="morph-drilldown-title">
                          {editingCssPresetId ? '编辑样式' : '新建样式'}
                        </span>
                      </div>

                      <div className="morph-field-col">
                        <label
                          className="morph-field-col-label"
                          htmlFor="morph-css-preset-name-input"
                        >
                          样式名称 <span className="morph-required-star">*</span>
                        </label>
                        <input
                          id="morph-css-preset-name-input"
                          type="text"
                          className="morph-field-input morph-css-name-input"
                          data-testid="css-preset-name-input"
                          placeholder="输入样式名称，如：阅读增强"
                          value={draftCssPresetName}
                          onChange={(e) => handleDraftCssPresetNameChange(e.target.value)}
                        />
                      </div>

                      <div className="morph-css-code-section">
                        <div className="morph-section-header">
                          <span className="morph-field-col-label">CSS 代码</span>
                          <button
                            type="button"
                            className="morph-css-guide-btn"
                            data-testid="toggle-css-guide-btn"
                            aria-haspopup="dialog"
                            aria-expanded={cssGuideOpen ? 'true' : 'false'}
                            onClick={() => setCssGuideOpen(true)}
                          >
                            <span className="morph-css-guide-icon" aria-hidden="true">
                              ?
                            </span>
                            <span>查看编写指南</span>
                          </button>
                        </div>

                        <div className="morph-css-code-box">
                          <div className="morph-css-gutter" aria-hidden="true">
                            {Array.from(
                              {
                                length: Math.max(
                                  10,
                                  customCss
                                    ? customCss.split('\n').length
                                    : CSS_TUTORIAL_GUIDE_LINES.length
                                ),
                              },
                              (_, idx) => (
                                <span key={idx + 1}>{idx + 1}</span>
                              )
                            )}
                          </div>

                          <div className="morph-css-editor-wrap">
                            {customCss.length === 0 && (
                              <div
                                className="morph-css-tutorial-overlay"
                                data-testid="css-tutorial-overlay"
                              >
                                {CSS_TUTORIAL_GUIDE_LINES.map((line, idx) => (
                                  <div
                                    key={idx}
                                    className={
                                      line.startsWith('.morph-')
                                        ? 'morph-tutorial-line is-selector'
                                        : 'morph-tutorial-line'
                                    }
                                  >
                                    {line}
                                  </div>
                                ))}
                              </div>
                            )}
                            <textarea
                              className="morph-css-textarea"
                              data-testid="custom-css-input"
                              aria-label="自定义 CSS 规则"
                              value={customCss}
                              onChange={(e) => void handleCustomCssChange(e)}
                              spellCheck={false}
                            />
                          </div>
                        </div>
                      </div>

                      <div
                        className={`morph-css-drilldown-footer ${
                          editingCssPresetId ? 'has-delete' : 'no-delete'
                        }`}
                      >
                        {editingCssPresetId && (
                          <button
                            type="button"
                            className="morph-danger-outline-btn"
                            data-testid="delete-css-preset-btn"
                            onClick={() => void handleDeleteCssPreset()}
                          >
                            删除
                          </button>
                        )}
                        <div className="morph-css-footer-right">
                          <button
                            type="button"
                            className="morph-btn morph-drilldown-action-btn"
                            data-testid="cancel-css-preset-btn"
                            onClick={() => void handleCancelCssPreset()}
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            className="morph-btn morph-btn-primary morph-drilldown-action-btn"
                            data-testid="save-css-preset-btn"
                            onClick={() => void handleSaveCssPreset()}
                          >
                            保存
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </aside>
      </main>

      {/* 3. Bottom Status Bar & Overleaf / VS Code Bottom-Left Diagnostic Popover */}
      <footer className="morph-statusbar" data-testid="workbench-statusbar">
        {diagnosticsOpen && (
          <div
            className="morph-diagnostics-popover"
            data-testid="diagnostics-popover"
            role="region"
            aria-label="编译与适配诊断"
          >
            <div className="morph-diag-header">
              <div className="morph-diag-title-group">
                <span>⚠ 诊断与平台兼容提示</span>
              </div>
              <div className="morph-diag-filters">
                <button
                  type="button"
                  className={`morph-diag-filter-btn ${diagFilter === 'all' ? 'is-active' : ''}`}
                  data-testid="diag-filter-all"
                  onClick={() => setDiagFilter('all')}
                >
                  全部 ({diagnostics.length})
                </button>
                <button
                  type="button"
                  className={`morph-diag-filter-btn ${diagFilter === 'warning' ? 'is-active' : ''}`}
                  data-testid="diag-filter-warning"
                  onClick={() => setDiagFilter('warning')}
                >
                  警告 ({warningDiagnostics.length})
                </button>
                <button
                  type="button"
                  className={`morph-diag-filter-btn ${diagFilter === 'error' ? 'is-active' : ''}`}
                  data-testid="diag-filter-error"
                  onClick={() => setDiagFilter('error')}
                >
                  错误 ({errorDiagnostics.length})
                </button>
                <button
                  type="button"
                  className="morph-tool-btn"
                  data-testid="close-diagnostics-btn"
                  aria-label="关闭诊断浮层"
                  onClick={() => setDiagnosticsOpen(false)}
                >
                  ✕
                </button>
              </div>
            </div>

            <ul className="morph-diag-list" data-testid="diagnostics-list">
              {filteredDiagnostics.length === 0 ? (
                <li className="morph-diag-empty" data-testid="diagnostics-empty">
                  当前文档无兼容性警告，所有样式与资源均已就绪。
                </li>
              ) : (
                filteredDiagnostics.map((item, idx) => (
                  <li
                    key={`${item.code}-${idx}`}
                    className="morph-diag-item"
                    data-testid="diagnostic-item"
                    data-severity={item.severity}
                    data-code={item.code}
                    onClick={() => handleDiagnosticItemClick(item)}
                  >
                    <div className="morph-diag-main">
                      <span className="morph-diag-msg">{item.message}</span>
                      <div className="morph-diag-meta">
                        <span>{item.code}</span>
                        {item.property && <span>· 属性: {item.property}</span>}
                        {item.sourceRange && <span>· 行 {item.sourceRange[0]}</span>}
                      </div>
                    </div>
                    <span className={`morph-diag-badge ${item.severity}`}>
                      {item.severity === 'error'
                        ? 'ERROR'
                        : item.severity === 'warning'
                          ? 'WARN'
                          : 'INFO'}
                    </span>
                  </li>
                ))
              )}
            </ul>
          </div>
        )}

        <div className="morph-status-left">
          <span className="morph-status-item" data-testid="status-render-state">
            <span className="morph-save-dot" aria-hidden="true" />
            {snapshot.ready ? '渲染就绪' : '编译中'}
          </span>
          <span className="morph-status-divider" aria-hidden="true">
            |
          </span>
          <span className="morph-status-item" data-testid="status-asset-count">
            🖼 图片 {assetStats.ready}/{assetStats.total} 已加载
          </span>
          <span className="morph-status-divider" aria-hidden="true">
            |
          </span>
          <button
            type="button"
            className={`morph-diag-trigger ${
              errorDiagnostics.length > 0
                ? 'has-errors'
                : actionableDiagnosticsCount > 0
                  ? 'has-warnings'
                  : ''
            }`}
            data-testid="status-diagnostics-trigger"
            aria-expanded={diagnosticsOpen ? 'true' : 'false'}
            onClick={() => setDiagnosticsOpen((prev) => !prev)}
          >
            <span>⚠</span>
            <span>{actionableDiagnosticsCount} 个警告</span>
          </button>
          <span className="morph-status-divider" aria-hidden="true">
            |
          </span>
          <span className="morph-status-item" data-testid="status-adapter-info">
            ⚓ {adapterStatusLabel}
          </span>
        </div>

        <div className="morph-status-right">
          <span className="morph-status-item">
            v{snapshot.version.doc}.{snapshot.version.style}.{snapshot.version.assets}
          </span>
        </div>
      </footer>

      {/* 4. Detailed Custom CSS Writing Guide Modal Dialog */}
      {cssGuideOpen && (
        <div
          className="morph-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setCssGuideOpen(false);
            }
          }}
        >
          <dialog
            ref={cssGuideDialogRef}
            open
            className="morph-css-guide-dialog"
            data-testid="css-guide-modal"
            aria-labelledby="morph-css-guide-title"
            {...({ closedby: 'any' } as React.HTMLAttributes<HTMLDialogElement>)}
            onClose={() => setCssGuideOpen(false)}
            onClick={handleCssGuideDialogClick}
          >
            <div className="morph-guide-modal-header">
              <div className="morph-guide-modal-title-wrap">
                <h2 id="morph-css-guide-title" className="morph-guide-modal-title">
                  自定义 CSS 编写指南
                </h2>
                <p className="morph-guide-modal-subtitle">
                  使用标准语义化选择器与 Design Tokens 变量，编写一套跨微信公众号、图文卡片通用的排版样式。
                </p>
              </div>
              <button
                type="button"
                className="morph-tool-btn morph-guide-close-btn"
                data-testid="close-css-guide-modal-btn"
                aria-label="关闭编写指南"
                onClick={() => setCssGuideOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="morph-guide-modal-body">
              <section className="morph-guide-section">
                <h3 className="morph-guide-section-title">1. 语义化元素选择器</h3>
                <p className="morph-guide-section-desc">
                  MorphMD 会为编译后的文档节点自动注入统一的 <code>.morph-*</code> 语义类名：
                </p>
                <div className="morph-guide-selector-grid">
                  {CSS_SELECTOR_REFERENCE.map((item) => (
                    <div key={item.token} className="morph-guide-selector-card">
                      <code className="morph-guide-selector-code">{item.token}</code>
                      <span className="morph-guide-selector-label">{item.label}</span>
                    </div>
                  ))}
                  <div className="morph-guide-selector-card">
                    <code className="morph-guide-selector-code">strong / em</code>
                    <span className="morph-guide-selector-label">加粗重点 / 斜体强调</span>
                  </div>
                  <div className="morph-guide-selector-card">
                    <code className="morph-guide-selector-code">::before / ::after</code>
                    <span className="morph-guide-selector-label">伪元素装饰（自动物化）</span>
                  </div>
                </div>
              </section>

              <section className="morph-guide-section">
                <h3 className="morph-guide-section-title">2. 内置主题变量 (Design Tokens)</h3>
                <p className="morph-guide-section-desc">
                  在自定义 CSS 中直接引用以下变量，切换「主题」或「排版」设置时会自动联动生效：
                </p>
                <div className="morph-guide-token-list">
                  <div className="morph-guide-token-row">
                    <code>var(--morph-accent)</code>
                    <span>当前选中的主题强调色（如标题左框线、重点标色）</span>
                  </div>
                  <div className="morph-guide-token-row">
                    <code>var(--morph-ink)</code>
                    <span>正文主墨水色（随纸张浅色/深色模式自动适配）</span>
                  </div>
                  <div className="morph-guide-token-row">
                    <code>var(--morph-bg)</code>
                    <span>画布与纸张背景底色</span>
                  </div>
                  <div className="morph-guide-token-row">
                    <code>var(--morph-body-size) / var(--morph-line-height)</code>
                    <span>基础正文字号与行高基准值</span>
                  </div>
                </div>
              </section>

              <section className="morph-guide-section">
                <h3 className="morph-guide-section-title">3. 常用排版代码示例</h3>
                <div className="morph-guide-example-list">
                  <div className="morph-guide-example-card">
                    <div className="morph-guide-example-head">
                      <span>示例一：二级标题左侧强调竖线</span>
                      <button
                        type="button"
                        className="morph-guide-insert-btn"
                        onClick={() =>
                          void handleInsertCssGuideExample(
                            '.morph-h2 {\n  border-left: 3px solid var(--morph-accent);\n  padding-left: 10px;\n  margin: 16px 0;\n}'
                          )
                        }
                      >
                        填入编辑器
                      </button>
                    </div>
                    <pre className="morph-guide-pre" tabIndex={0}>
                      <code>{`.morph-h2 {\n  border-left: 3px solid var(--morph-accent);\n  padding-left: 10px;\n  margin: 16px 0;\n}`}</code>
                    </pre>
                  </div>

                  <div className="morph-guide-example-card">
                    <div className="morph-guide-example-head">
                      <span>示例二：引用容器暖灰卡片与圆角左框</span>
                      <button
                        type="button"
                        className="morph-guide-insert-btn"
                        onClick={() =>
                          void handleInsertCssGuideExample(
                            '.morph-quote {\n  border: 1px solid #e9e9e7;\n  border-left: 4px solid var(--morph-accent);\n  background-color: #f7f7f5;\n  padding: 12px 16px;\n  border-radius: 8px;\n}'
                          )
                        }
                      >
                        填入编辑器
                      </button>
                    </div>
                    <pre className="morph-guide-pre" tabIndex={0}>
                      <code>{`.morph-quote {\n  border: 1px solid #e9e9e7;\n  border-left: 4px solid var(--morph-accent);\n  background-color: #f7f7f5;\n  padding: 12px 16px;\n  border-radius: 8px;\n}`}</code>
                    </pre>
                  </div>

                  <div className="morph-guide-example-card">
                    <div className="morph-guide-example-head">
                      <span>示例三：正文粗体荧光笔高亮标记</span>
                      <button
                        type="button"
                        className="morph-guide-insert-btn"
                        onClick={() =>
                          void handleInsertCssGuideExample(
                            '.morph-p strong {\n  background-color: #faebdd;\n  padding: 1px 5px;\n  border-radius: 3px;\n}'
                          )
                        }
                      >
                        填入编辑器
                      </button>
                    </div>
                    <pre className="morph-guide-pre" tabIndex={0}>
                      <code>{`.morph-p strong {\n  background-color: #faebdd;\n  padding: 1px 5px;\n  border-radius: 3px;\n}`}</code>
                    </pre>
                  </div>
                </div>
              </section>

              <section className="morph-guide-section">
                <h3 className="morph-guide-section-title">4. 平台安全白名单与兼容规范</h3>
                <ul className="morph-guide-notes">
                  <li>
                    <strong>微信公众号 & 图文卡片</strong>：支持字号、颜色、内外边距、边框、圆角、背景色等排版属性自动计算并内联至节点 <code>style</code>；<code>::before</code> / <code>::after</code> 伪元素会自动物化为真实内联节点。
                  </li>
                  <li>
                    <strong>禁用属性拦截</strong>：为防止破坏宿主页面布局，<code>position: fixed</code>、<code>z-index</code>、外部 <code>@import</code> 等属性会被安全沙箱自动过滤，并在左下角诊断浮层中给出行号提示。
                  </li>
                </ul>
              </section>
            </div>

            <div className="morph-guide-modal-footer">
              <button
                type="button"
                className="morph-btn morph-btn-primary morph-drilldown-action-btn"
                onClick={() => setCssGuideOpen(false)}
              >
                我知道了
              </button>
            </div>
          </dialog>
        </div>
      )}
    </div>
  );
};

export default App;
