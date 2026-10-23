import type { Nodes, RootContent } from 'hast';
import type { Options } from 'hast-util-to-html';
import type { DeepReadonly } from './types';

declare module 'hast-util-to-html' {
  export function toHtml(
    tree: DeepReadonly<Nodes> | ReadonlyArray<DeepReadonly<RootContent>>,
    options?: Options | null | undefined
  ): string;
}
