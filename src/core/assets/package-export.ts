import { unified } from 'unified';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import type { AssetRecord, AssetPackageManifest, AssetExportEntry } from './types';

function getExtensionForMime(mime: string): string {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/jpeg':
    case 'image/jpg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'image/svg+xml': return 'svg';
    default: return 'png';
  }
}

interface ReplaceRange {
  start: number;
  end: number;
  replacement: string;
}

export function exportPackageManifestImpl(
  content: string,
  records: Map<string, AssetRecord>,
  binaryData: Map<string, Uint8Array>
): AssetPackageManifest {
  const assets: AssetExportEntry[] = [];
  const usedPaths = new Set<string>();
  const assetIdToExportPath = new Map<string, string>();
  const assetIdToEncodedUrl = new Map<string, string>();

  // Parse markdown into AST to target only images, links, and definitions
  const tree = unified().use(remarkParse).parse(content);
  const ranges: ReplaceRange[] = [];

  visit(tree, (node: any) => {
    if (node.type === 'image' || node.type === 'link' || node.type === 'definition') {
      const url = typeof node.url === 'string' ? node.url : '';
      if (url.startsWith('morph-asset://')) {
        const id = url.replace('morph-asset://', '').split('?')[0].split('#')[0];
        const record = records.get(id);
        if (!record) return;

        let exportPath = assetIdToExportPath.get(id);
        let encodedUrl = assetIdToEncodedUrl.get(id);

        if (!exportPath || !encodedUrl) {
          const ext = getExtensionForMime(record.mimeType);
          let rawBase = (record.fileName || `${record.id}.${ext}`)
            .replace(/^.*[\\\/]/, '')
            .replace(/[\r\n\0]+/g, '')
            .replace(/\.\.+/g, '')
            .trim();
          if (!rawBase) rawBase = `${record.id}.${ext}`;

          const baseWithoutExt = rawBase.replace(new RegExp(`\\.${ext}$`, 'i'), '');
          let safeFileName = rawBase;
          exportPath = `./assets/${safeFileName}`;

          let counter = 1;
          while (usedPaths.has(exportPath)) {
            if (counter === 1) {
              safeFileName = `${baseWithoutExt}-${record.id}.${ext}`;
            } else {
              safeFileName = `${baseWithoutExt}-${record.id}-${counter}.${ext}`;
            }
            exportPath = `./assets/${safeFileName}`;
            counter++;
          }

          usedPaths.add(exportPath);
          assetIdToExportPath.set(id, exportPath);

          // Percent-encode filename for markdown destination while keeping ./assets/
          encodedUrl = './assets/' + encodeURIComponent(safeFileName).replace(/\(/g, '%28').replace(/\)/g, '%29');
          assetIdToEncodedUrl.set(id, encodedUrl);

          const binary = binaryData.get(id);
          assets.push({
            assetId: id,
            originalUri: `morph-asset://${id}`,
            exportPath,
            mimeType: record.mimeType,
            data: binary ? binary.slice() : new Uint8Array(),
          });
        }

        if (node.position && typeof node.position.start.offset === 'number' && typeof node.position.end.offset === 'number') {
          const nodeSlice = content.slice(node.position.start.offset, node.position.end.offset);

          if (node.type === 'definition') {
            const defMatch = nodeSlice.match(/\]:\s*(<[^>]*>|[^\s]+)/);
            if (defMatch) {
              const destToken = defMatch[1];
              const tokenStart = defMatch[0].lastIndexOf(destToken);
              const start = node.position.start.offset + defMatch.index! + tokenStart;
              const end = start + destToken.length;
              ranges.push({ start, end, replacement: encodedUrl });
            }
          } else {
            // image or link: destination starts after the matching closing ](
            let openParenIdx = -1;
            const bracketStart = nodeSlice.indexOf('[');
            if (bracketStart !== -1) {
              let depth = 0;
              for (let i = bracketStart; i < nodeSlice.length; i++) {
                if (nodeSlice[i] === '\\' && i + 1 < nodeSlice.length) {
                  i++;
                  continue;
                }
                if (i > bracketStart && nodeSlice[i] === '<') {
                  const htmlMatch = nodeSlice
                    .slice(i)
                    .match(
                      /^(?:<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![A-Za-z][^>]*>|<!\[CDATA\[[\s\S]*?\]\]>|<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[a-zA-Z_:][a-zA-Z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>)/
                    );
                  if (htmlMatch) {
                    i += htmlMatch[0].length - 1;
                    continue;
                  }
                }
                if (nodeSlice[i] === '`') {
                  let ticks = 0;
                  while (i + ticks < nodeSlice.length && nodeSlice[i + ticks] === '`') ticks++;
                  let closer = -1;
                  let j = i + ticks;
                  while (j < nodeSlice.length) {
                    if (nodeSlice[j] === '`') {
                      let runLen = 0;
                      while (j + runLen < nodeSlice.length && nodeSlice[j + runLen] === '`') runLen++;
                      if (runLen === ticks) {
                        closer = j;
                        break;
                      }
                      j += runLen;
                    } else {
                      j++;
                    }
                  }
                  if (closer !== -1) {
                    i = closer + ticks - 1;
                  } else {
                    i += ticks - 1;
                  }
                  continue;
                }
                if (nodeSlice[i] === '[') {
                  depth++;
                } else if (nodeSlice[i] === ']') {
                  depth--;
                  if (depth === 0 && nodeSlice[i + 1] === '(') {
                    openParenIdx = i;
                    break;
                  }
                }
              }
            }

            if (openParenIdx !== -1) {
              const parenPart = nodeSlice.slice(openParenIdx + 2);
              const destMatch = parenPart.match(/^\s*(<[^>]*>|[^\s)]+)/);
              if (destMatch) {
                const destToken = destMatch[1];
                const tokenStartInSlice = openParenIdx + 2 + destMatch[0].indexOf(destToken);
                const start = node.position.start.offset + tokenStartInSlice;
                const end = start + destToken.length;
                ranges.push({ start, end, replacement: encodedUrl });
              }
            } else {
              const linkMatch = nodeSlice.match(/\]\(\s*(<[^>]*>|[^\s)]+)/);
              if (linkMatch) {
                const destToken = linkMatch[1];
                const tokenStartInSlice = linkMatch.index! + linkMatch[0].indexOf(destToken);
                const start = node.position.start.offset + tokenStartInSlice;
                const end = start + destToken.length;
                ranges.push({ start, end, replacement: encodedUrl });
              }
            }
          }
        }
      }
    }
  });

  // Sort ranges descending to replace from end to start without offset shifting
  ranges.sort((a, b) => b.start - a.start);

  let rewrittenContent = content;
  for (const { start, end, replacement } of ranges) {
    rewrittenContent = rewrittenContent.slice(0, start) + replacement + rewrittenContent.slice(end);
  }

  return { rewrittenContent, assets };
}
