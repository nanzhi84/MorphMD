import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const ROOT_DIR = resolve(__dirname, '..');

describe('TestBrandAssetsAndReadme', () => {
  it('test_brand_logo_svg_exists_and_uses_warm_paper_squircle_and_terracotta_palette', () => {
    const logoPath = resolve(ROOT_DIR, 'images/logo.svg');
    expect(existsSync(logoPath)).toBe(true);

    const svgText = readFileSync(logoPath, 'utf-8');
    expect(svgText.trim().length).toBeGreaterThan(200);
    expect(svgText).toContain('<svg');
    expect(svgText).toContain('viewBox="0 0 512 512"');
    expect(svgText.toUpperCase()).toContain('#FAF9F5');
    expect(svgText.toUpperCase()).toContain('#141413');
    expect(svgText.toUpperCase()).toContain('#D97757');
  });

  it('test_demo_video_and_gif_assets_have_valid_headers_and_widescreen_dimensions', () => {
    const mp4Path = resolve(ROOT_DIR, 'images/demo.mp4');
    const gifPath = resolve(ROOT_DIR, 'images/demo.gif');

    expect(existsSync(mp4Path)).toBe(true);
    expect(existsSync(gifPath)).toBe(true);

    const mp4Bytes = readFileSync(mp4Path);
    expect(mp4Bytes.byteLength).toBeGreaterThan(10000);
    expect(mp4Bytes.subarray(0, 16).toString('latin1')).toContain('ftyp');

    const gifBytes = readFileSync(gifPath);
    expect(gifBytes.byteLength).toBeGreaterThan(10000);
    expect(gifBytes.subarray(0, 6).toString('ascii')).toBe('GIF89a');

    const gifWidth = gifBytes.readUInt16LE(6);
    const gifHeight = gifBytes.readUInt16LE(8);
    expect(gifWidth).toBeGreaterThanOrEqual(960);
    expect(Math.abs(gifWidth / gifHeight - 1.6)).toBeLessThanOrEqual(0.08);
  });

  it('test_readme_banner_and_sections_follow_glint_pattern_and_cover_core_capabilities', () => {
    const readmePath = resolve(ROOT_DIR, 'README.md');
    expect(existsSync(readmePath)).toBe(true);

    const content = readFileSync(readmePath, 'utf-8');
    const topBanner = content.split('\n').slice(0, 35).join('\n');

    expect(topBanner).toContain('<div align="center">');
    expect(topBanner).toContain('images/logo.svg');
    expect(topBanner).toContain('# MorphMD');
    expect(topBanner).toContain('images/demo.gif');
    expect(topBanner).toContain('images/demo.mp4');

    expect(content).toContain('## Core ideas');
    expect(content).toContain('## Get started');
    expect(content).toContain('## Learn more');

    expect(content).toContain('wechat');
    expect(content).toContain('x-article');
    expect(content).toContain('cards');
    expect(content).toContain('Design Tokens');
    expect(content).toMatch(/\|\s*场景\s*\|/);
    expect(content.toLowerCase()).not.toContain('nanzhi');
  });
});

describe('TestPublicLandingPage', () => {
  it('test_landing_page_html_has_semantic_structure_warm_paper_tokens_and_bilingual_copy', () => {
    const indexPath = resolve(ROOT_DIR, 'index.html');
    expect(existsSync(indexPath)).toBe(true);

    const html = readFileSync(indexPath, 'utf-8');
    const upper = html.toUpperCase();

    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html).toContain('<header');
    expect(html).toContain('<main');
    expect(html).toContain('<footer');
    expect(html).toMatch(/<title>[^<]*MorphMD[^<]*<\/title>/);
    expect(html).toContain('<meta name="description"');

    // Warm paper tokens & typography
    expect(upper).toContain('#FAF9F5');
    expect(upper).toContain('#F5F4EF');
    expect(upper).toContain('#D97757');
    expect(upper).toContain('#4A6B82');
    expect(upper).toContain('#141413');
    expect(upper).toContain('#2D2D2A');
    expect(html).toMatch(/Newsreader|Georgia|Noto Serif SC/);

    // Bilingual attributes & no external repo author residue
    expect(html).toContain('data-lang="zh"');
    expect(html).toContain('data-lang="en"');
    expect(html.toLowerCase()).not.toContain('nanzhi');
  });

  it('test_landing_page_implements_editorial_studio_without_glint_template_cloning', () => {
    const indexPath = resolve(ROOT_DIR, 'index.html');
    const html = readFileSync(indexPath, 'utf-8');
    const dom = new JSDOM(html, { url: 'https://morph.test/' });
    const doc = dom.window.document;

    // 1. No 1:1 cloning of Glint's LLM provider box or squiggle underline
    expect(doc.querySelector('.providers-box')).toBeNull();
    expect(doc.querySelector('.accent-underline')).toBeNull();

    // 2. Editorial Studio header
    const header = doc.querySelector('header.site-header');
    expect(header).not.toBeNull();
    expect(header!.querySelector('#lang-toggle-btn')).not.toBeNull();
    expect(header!.querySelector('#theme-toggle-btn')).not.toBeNull();
    expect(header!.querySelector('a[href*="github.com"]')).not.toBeNull();

    // 3. Hero section with launch button and 16:10 showcase video
    const hero = doc.querySelector('.hero-section');
    expect(hero).not.toBeNull();
    expect(hero!.querySelector('#launch-workbench-btn')).not.toBeNull();

    const showcase = hero!.querySelector('.hero-showcase');
    expect(showcase).not.toBeNull();
    const video = showcase!.querySelector('video.showcase-video');
    expect(video).not.toBeNull();
    const videoSrc =
      video!.getAttribute('src') || video!.querySelector('source')?.getAttribute('src') || '';
    expect(videoSrc).toContain('images/demo.mp4');

    // 4. Split-screen Isomorphic Studio sandbox
    const studioSection = doc.querySelector(
      '.isomorphic-studio-section, .hero-interactive-preview'
    );
    expect(studioSection).not.toBeNull();
    expect(studioSection!.querySelector('.studio-source-pane')).not.toBeNull();
    expect(studioSection!.querySelector('#demo-btn-wechat')).not.toBeNull();
    expect(studioSection!.querySelector('#demo-btn-x')).not.toBeNull();
    expect(studioSection!.querySelector('#demo-btn-cards')).not.toBeNull();
    expect(studioSection!.querySelector('#demo-output-wechat')).not.toBeNull();
    expect(studioSection!.querySelector('#demo-output-x')).not.toBeNull();
    expect(studioSection!.querySelector('#demo-output-cards')).not.toBeNull();

    // 5. Why MorphMD: 4 feature cards with concise Chinese descriptions (20-62 chars)
    const whySection = doc.querySelector('.why-section');
    expect(whySection).not.toBeNull();
    const featureCards = Array.from(whySection!.querySelectorAll('.feature-card'));
    expect(featureCards).toHaveLength(4);
    for (const card of featureCards) {
      const zhDesc = card.querySelector('p [data-lang="zh"]');
      expect(zhDesc).not.toBeNull();
      const charLen = (zhDesc!.textContent || '').replace(/\s+/g, '').length;
      expect(charLen).toBeGreaterThanOrEqual(20);
      expect(charLen).toBeLessThanOrEqual(62);
    }

    // 6. Walkthrough section: 4 rows covering Anthropic & Yoryon presets
    const walkthroughSection = doc.querySelector('.walkthrough-section');
    expect(walkthroughSection).not.toBeNull();
    const walkthroughRows = Array.from(walkthroughSection!.querySelectorAll('.walkthrough-row'));
    expect(walkthroughRows).toHaveLength(4);
    expect(walkthroughSection!.textContent).toContain('Anthropic');
    expect(walkthroughSection!.textContent).toContain('Yoryon');

    // 7. Quick Start guide (#install-guide) with 3 install-step-card items & #root
    const installGuide = doc.querySelector('section#install-guide');
    expect(installGuide).not.toBeNull();
    expect(installGuide!.querySelectorAll('.install-step-card')).toHaveLength(3);
    expect(doc.querySelector('#root')).not.toBeNull();
  });

  it('test_workbench_css_protects_preview_pane_from_sidebar_compression_and_vertical_tab_wrapping', () => {
    const cssPath = resolve(ROOT_DIR, 'src/styles/workbench.css');
    const cssText = readFileSync(cssPath, 'utf-8');

    const previewPaneRule = cssText.match(/\.morph-preview-pane\s*\{([^}]*)\}/);
    expect(previewPaneRule).not.toBeNull();
    expect(previewPaneRule![1]).toContain('min-width: 520px');

    const subtabRule = cssText.match(/\.morph-subtab\s*\{([^}]*)\}/);
    expect(subtabRule).not.toBeNull();
    expect(subtabRule![1]).toContain('white-space: nowrap');
  });
});
