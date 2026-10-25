import type { Root, Element } from 'hast';
import * as csstree from 'css-tree';
import type { DiagnosticItem } from '../snapshot/types';

const DANGEROUS_TAGS = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'style',
  'link',
  'meta',
  'base',
  'form',
  'applet',
  'set',
  'discard',
  'foreignobject',
]);

const SVG_ANIMATION_TAGS = new Set(['animate', 'animatetransform', 'animatemotion']);

const DANGEROUS_PROTOCOLS = ['javascript:', 'vbscript:', 'data:text/html'];

export function decodeCssEscapes(input: string): string {
  if (!input) return '';
  return input.replace(/\\([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|\\([^\r\n\f])/gu, (_, hex, char) => {
    if (hex) {
      const cp = parseInt(hex, 16);
      if (Number.isNaN(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
        return '\uFFFD';
      }
      return String.fromCodePoint(cp);
    }
    return char || '';
  });
}

function isDangerousUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  // On HTML URL attributes, do NOT apply CSS escape decoding (only strip control chars/whitespace and check URL scheme)
  const clean = url
    .trim()
    .toLowerCase()
    .replace(/[\x00-\x1f\s]/g, '');
  return DANGEROUS_PROTOCOLS.some((proto) => clean.startsWith(proto));
}

function sanitizeInlineStyle(styleText: string, diagnostics: DiagnosticItem[]): string | undefined {
  if (!styleText.trim()) return undefined;
  try {
    const declList = csstree.parse(styleText, { context: 'declarationList' });
    let hadDangerous = false;

    // Collect local custom properties
    const localVars = new Map<string, string>();
    csstree.walk(declList, (node) => {
      if (node.type === 'Declaration' && node.property.startsWith('--')) {
        const propName = decodeCssEscapes(node.property).trim();
        const rawVal = csstree.generate(node.value).trim();
        localVars.set(propName, rawVal);
      }
    });

    csstree.walk(declList, (node, item, list) => {
      if (node.type === 'Declaration') {
        const isCustom = node.property.startsWith('--');
        const decodedProp = isCustom
          ? decodeCssEscapes(node.property).trim()
          : decodeCssEscapes(node.property).toLowerCase().trim();
        node.property = decodedProp;
        const rawVal = csstree.generate(node.value);
        const decodedVal = decodeCssEscapes(rawVal).toLowerCase();

        let resolvedVal = decodedVal;
        if (decodedVal.includes('var(')) {
          resolvedVal = decodedVal.replace(
            /var\((--[a-zA-Z0-9_-]+)(?:,\s*([^)]+))?\)/g,
            (_, vName, fb) => localVars.get(vName) || fb || ''
          );
        }

        if (
          (decodedProp === 'position' && /\bfixed\b/.test(resolvedVal)) ||
          decodedVal.includes('javascript:') ||
          decodedVal.includes('expression(') ||
          decodedVal.includes('-moz-binding')
        ) {
          hadDangerous = true;
          diagnostics.push({
            code: 'security/disallowed-style',
            message: `Disallowed inline style declaration "${decodedProp}: ${decodedVal}" removed.`,
            severity: 'error',
            property: decodedProp,
          });
          list.remove(item);
        }
      }
    });

    const clean = csstree.generate(declList).trim();
    if (hadDangerous && !clean) return undefined;
    return clean || undefined;
  } catch {
    // If CSS parsing fails, remove the untrusted style
    diagnostics.push({
      code: 'security/invalid-inline-style',
      message: 'Unparseable inline style removed for security.',
      severity: 'warning',
    });
    return undefined;
  }
}

function sanitizeElement(el: Element, diagnostics: DiagnosticItem[]): void {
  const props = (el.properties || (el.properties = {})) as Record<string, unknown>;

  // 1. Strip untrusted identity, range & pipeline attributes from raw HTML input
  delete props.dataNodeId;
  delete props['data-node-id'];
  delete props.dataSourceRange;
  delete props['data-source-range'];
  delete props.dataMorphGenerated;
  delete props['data-morph-generated'];
  delete props.dataMorphSnapshotSrc;
  delete props['data-morph-snapshot-src'];
  delete props.dataMorphPseudo;
  delete props['data-morph-pseudo'];

  // 2. Strip all inline event handlers (onclick, onerror, onload, etc.)
  for (const key of Object.keys(props)) {
    if (/^on[a-z]+/i.test(key)) {
      diagnostics.push({
        code: 'security/disallowed-attribute',
        message: `Inline event handler attribute "${key}" removed.`,
        severity: 'error',
      });
      delete props[key];
    }
  }

  // 3. Check and sanitize URL attributes (including xlink:href, form action, values/to/from, etc.)
  const urlAttrs = ['href', 'src', 'xlink:href', 'xLinkHref', 'xlinkHref', 'action', 'formaction', 'data', 'values', 'to', 'from'];
  for (const attr of urlAttrs) {
    if (typeof props[attr] === 'string') {
      const val = props[attr] as string;
      if (isDangerousUrl(val)) {
        diagnostics.push({
          code: 'security/dangerous-url',
          message: `Dangerous URL blocked in attribute "${attr}": "${val}"`,
          severity: 'error',
          property: attr,
        });
        if (el.tagName === 'a' && attr === 'href') {
          props[attr] = '#';
        } else {
          delete props[attr];
        }
      }
    }
  }

  // 4. Sanitize raw inline style attributes
  if (typeof props.style === 'string') {
    const cleaned = sanitizeInlineStyle(props.style, diagnostics);
    if (cleaned) {
      props.style = cleaned;
    } else {
      delete props.style;
    }
  }
}

export function sanitizeHast(
  tree: Root,
  diagnostics: DiagnosticItem[]
): void {
  function walkChildren(parent: { children: any[] }) {
    for (let i = parent.children.length - 1; i >= 0; i--) {
      const child = parent.children[i];
      if (child.type === 'element') {
        const tag = (child.tagName || '').toLowerCase();
        if (DANGEROUS_TAGS.has(tag)) {
          diagnostics.push({
            code: 'security/disallowed-tag',
            message: `Disallowed HTML tag <${tag}> stripped for security.`,
            severity: 'error',
          });
          parent.children.splice(i, 1);
          continue;
        }

        if (SVG_ANIMATION_TAGS.has(tag)) {
          const props = (child.properties || {}) as Record<string, unknown>;
          const attrName = String(props.attributeName || props.attributename || '').trim().toLowerCase();
          if (/^(?:href|xlink:href|src|action|formaction|data|on[a-z]+)$/i.test(attrName)) {
            diagnostics.push({
              code: 'security/disallowed-tag',
              message: `Disallowed SVG animation targeting "${attrName}" stripped for security.`,
              severity: 'error',
            });
            parent.children.splice(i, 1);
            continue;
          }
        }

        sanitizeElement(child, diagnostics);
        walkChildren(child);
      }
    }
  }

  walkChildren(tree);
}
