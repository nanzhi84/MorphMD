import type {
  CardAspectRatio,
  CardPresetConfig,
  CardViewportGeometry,
  CardViewportOptions,
} from './types';

export const CARD_RATIO_PRESETS: Readonly<Record<CardAspectRatio, CardPresetConfig>> = Object.freeze({
  '3:4': Object.freeze({
    ratio: '3:4',
    label: '3:4 竖版图文卡片',
    exportWidth: 1440,
    exportHeight: 1920,
    layoutWidth: 720,
    layoutHeight: 960,
    exportScale: 2,
    padding: Object.freeze({ top: 48, right: 56, bottom: 48, left: 56 }),
    headerHeight: 0,
    footerHeight: 0,
  }),
  '4:5': Object.freeze({
    ratio: '4:5',
    label: '4:5 社交贴图卡片',
    exportWidth: 1440,
    exportHeight: 1800,
    layoutWidth: 720,
    layoutHeight: 900,
    exportScale: 2,
    padding: Object.freeze({ top: 48, right: 56, bottom: 48, left: 56 }),
    headerHeight: 0,
    footerHeight: 0,
  }),
  '1:1': Object.freeze({
    ratio: '1:1',
    label: '1:1 方形图文卡片',
    exportWidth: 1440,
    exportHeight: 1440,
    layoutWidth: 720,
    layoutHeight: 720,
    exportScale: 2,
    padding: Object.freeze({ top: 44, right: 56, bottom: 44, left: 56 }),
    headerHeight: 0,
    footerHeight: 0,
  }),
  '16:9': Object.freeze({
    ratio: '16:9',
    label: '16:9 横版演示卡片',
    exportWidth: 1920,
    exportHeight: 1080,
    layoutWidth: 960,
    layoutHeight: 540,
    exportScale: 2,
    padding: Object.freeze({ top: 40, right: 64, bottom: 40, left: 64 }),
    headerHeight: 0,
    footerHeight: 0,
  }),
});

export function getCardPreset(ratio: CardAspectRatio = '3:4'): CardPresetConfig {
  return CARD_RATIO_PRESETS[ratio] ?? CARD_RATIO_PRESETS['3:4'];
}

export function computeCardViewportGeometry(
  ratio: CardAspectRatio = '3:4',
  options: CardViewportOptions = {},
): CardViewportGeometry {
  const preset = getCardPreset(ratio);
  const {
    layoutWidth,
    layoutHeight,
    exportWidth,
    exportHeight,
    exportScale,
    padding,
    headerHeight,
    footerHeight,
  } = preset;

  const availableContentWidth = Math.max(1, layoutWidth - padding.left - padding.right);
  const defaultContentHeight = Math.max(
    1,
    layoutHeight - padding.top - padding.bottom - headerHeight - footerHeight,
  );
  const availableContentHeight =
    typeof options.contentHeightOverride === 'number' && options.contentHeightOverride > 0
      ? options.contentHeightOverride
      : defaultContentHeight;

  let previewScale = 1;
  if (options.renderAtExportSize) {
    previewScale = exportScale;
  } else {
    const scaleX =
      typeof options.containerWidth === 'number' && options.containerWidth > 0
        ? options.containerWidth / layoutWidth
        : Infinity;
    const scaleY =
      typeof options.containerHeight === 'number' && options.containerHeight > 0
        ? options.containerHeight / layoutHeight
        : Infinity;

    if (scaleX !== Infinity || scaleY !== Infinity) {
      previewScale = Math.min(scaleX, scaleY);
    }

    const maxScale = options.maxPreviewScale ?? exportScale;
    const minScale = options.minPreviewScale ?? 0.1;
    previewScale = Math.max(minScale, Math.min(maxScale, previewScale));

    if (typeof options.containerWidth === 'number' && options.containerWidth > 0) {
      previewScale = Math.min(previewScale, options.containerWidth / layoutWidth);
    }
    if (typeof options.containerHeight === 'number' && options.containerHeight > 0) {
      previewScale = Math.min(previewScale, options.containerHeight / layoutHeight);
    }
  }

  const previewWidth = Number((layoutWidth * previewScale).toFixed(4));
  const previewHeight = Number((layoutHeight * previewScale).toFixed(4));

  return {
    ratio: preset.ratio,
    layoutWidth,
    layoutHeight,
    exportWidth,
    exportHeight,
    exportScale,
    previewScale,
    previewWidth,
    previewHeight,
    availableContentWidth,
    availableContentHeight,
    padding,
    headerHeight,
    footerHeight,
  };
}
