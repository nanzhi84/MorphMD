import type { Root, Element } from 'hast';
import { visit } from 'unist-util-visit';

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

export function transformCallouts(tree: Root): void {
  visit(tree, 'element', (node: Element, index, parent) => {
    if (node.tagName === 'blockquote' && parent && typeof index === 'number') {
      let isCallout = false;
      let calloutType = '';
      let titleText = '';

      let hasMeaningfulTextBefore = false;
      let firstElem: Element | undefined;
      for (const child of node.children) {
        if (child.type === 'element') {
          firstElem = child;
          break;
        }
        if (child.type === 'text' && child.value.trim() !== '') {
          hasMeaningfulTextBefore = true;
          break;
        }
      }

      if (!hasMeaningfulTextBefore && firstElem && firstElem.tagName === 'p') {
        const firstPElem = firstElem;
        if (firstPElem.children.length > 0) {
          const firstTextChild = firstPElem.children[0];
          if (firstTextChild && firstTextChild.type === 'text') {
            const match = firstTextChild.value.match(
              /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:[ \t]+([^\r\n]*))?(?:\r?\n)?/i
            );
            if (match) {
              isCallout = true;
              calloutType = match[1].toLowerCase();
              titleText = (match[2] || '').trim() || capitalize(calloutType);

              // Strip only the [!TYPE] line from the leading text node
              const remaining = firstTextChild.value.slice(match[0].length);
              if (remaining.length > 0) {
                firstTextChild.value = remaining;
              } else {
                firstPElem.children.shift();
              }
            }
          }
        }
      }

      if (isCallout) {
        const bodyChildren = [...node.children].filter(
          (c) => !(c.type === 'element' && c.tagName === 'p' && c.children.length === 0)
        );

        const calloutElement: Element = {
          type: 'element',
          tagName: 'div',
          properties: {
            className: ['morph-callout', `morph-callout-${calloutType}`],
            dataCalloutType: calloutType,
          },
          children: [
            {
              type: 'element',
              tagName: 'div',
              properties: { className: ['morph-callout-title'] },
              children: [{ type: 'text', value: titleText }],
            },
            {
              type: 'element',
              tagName: 'div',
              properties: { className: ['morph-callout-body'] },
              children: bodyChildren,
            },
          ],
          position: node.position,
        };

        parent.children[index] = calloutElement;
      } else {
        const props = (node.properties || (node.properties = {})) as Record<string, unknown>;
        const currentClass = props.className;
        if (Array.isArray(currentClass)) {
          if (!currentClass.includes('morph-quote')) currentClass.push('morph-quote');
        } else if (typeof currentClass === 'string') {
          props.className = [currentClass, 'morph-quote'];
        } else {
          props.className = ['morph-quote'];
        }
      }
    }
  });
}
