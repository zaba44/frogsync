import { emptyRestoreTree, RESTORE_ROOTS, type RestoreNode, type RestoreRoot, type RestoreTree } from './core/restore.js';

export type BookmarkHtmlSource = 'auto' | 'firefox' | 'chromium';

const SYSTEM_FOLDERS = new Set([
  'kosz',
  'trash',
  'pinboard',
  'unsynchronized pinboard',
  'nieuporządkowane',
  'nieuporzadkowane',
  'speed dials',
  'zakładki sprzed frogsync',
  'zakladki sprzed frogsync',
]);

function flag(element: Element, name: string): boolean {
  if (!element.hasAttribute(name)) return false;
  const value = element.getAttribute(name)?.trim().toLowerCase();
  return value !== 'false' && value !== '0';
}

function folderRoot(heading: Element): RestoreRoot | undefined {
  const explicit = heading.getAttribute('data-frogsync-root');
  if (RESTORE_ROOTS.some(root => root === explicit)) return explicit as RestoreRoot;
  if (flag(heading, 'personal_toolbar_folder')) return 'root:toolbar';
  if (flag(heading, 'unfiled_bookmarks_folder')) return 'root:unsorted';
  if (flag(heading, 'mobile_bookmarks_folder')) return 'root:mobile';
  return undefined;
}

// Opera i Vivaldi eksportuja korzenie przegladarki jako zwykle foldery najwyzszego poziomu,
// bez atrybutow. Folder o nazwie korzenia to sam korzen, a nie podfolder do utworzenia.
const ROOT_BY_TITLE = new Map<string, RestoreRoot>([
  ['pasek zakładek', 'root:toolbar'], ['bookmarks bar', 'root:toolbar'], ['bookmarks toolbar', 'root:toolbar'],
  ['inne zakładki', 'root:unsorted'], ['other bookmarks', 'root:unsorted'],
  ['zakładki na telefonie', 'root:mobile'], ['zakładki z telefonu', 'root:mobile'], ['mobile bookmarks', 'root:mobile'],
]);

function firstList(doc: Document): Element | null {
  return doc.body.querySelector('dl');
}

/**
 * Czyta wylacznie tekst, URL i strukture. Nie wstawia elementow importu do UI.
 * Opcja source rozstrzyga eksport Firefoksa bez znacznikow jego korzeni.
 */
export function parseBookmarkHtml(html: string, source: BookmarkHtmlSource = 'auto'): RestoreTree {
  if (!/<!doctype\s+netscape-bookmark-file-1\b/i.test(html)) {
    throw new Error('Wybierz plik HTML wyeksportowany z menedżera zakładek przeglądarki.');
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');
  const top = firstList(doc);
  if (!top) throw new Error('Plik nie zawiera drzewa zakładek.');

  const firefox = source === 'firefox' || (source === 'auto' &&
    doc.querySelector('[unfiled_bookmarks_folder], [mobile_bookmarks_folder], [places_root]') !== null);
  const defaultRoot: RestoreRoot = firefox ? 'root:menu' : 'root:unsorted';
  const tree = emptyRestoreTree();

  function read(list: Element, into: RestoreNode[], depth: number): void {
    if (depth > 256) throw new Error('Plik zawiera zbyt głęboko zagnieżdżone foldery.');

    const items = Array.from(list.children);
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      if (item.tagName === 'HR') {
        into.push({ kind: 'separator', title: '' });
        continue;
      }
      if (item.tagName !== 'DT') continue;

      const heading = Array.from(item.children).find(child => child.tagName === 'H3');
      if (heading) {
        const title = heading.textContent ?? '';
        const root = depth === 0 ? folderRoot(heading) ?? ROOT_BY_TITLE.get(title.trim().toLowerCase()) : undefined;
        const nested = Array.from(item.children).find(child => child.tagName === 'DL') ??
          (items[i + 1]?.tagName === 'DL' ? items[++i] : undefined);

        if (root) {
          if (nested) read(nested, tree[root], depth + 1);
          continue;
        }
        if (SYSTEM_FOLDERS.has(title.trim().toLowerCase())) continue;

        const children: RestoreNode[] = [];
        if (nested) read(nested, children, depth + 1);
        into.push({ kind: 'folder', title, children });
        continue;
      }

      const anchor = Array.from(item.children).find(child => child.tagName === 'A');
      if (anchor) {
        const url = anchor.getAttribute('href')?.trim();
        if (!url) throw new Error('Plik zawiera zakładkę bez adresu.');
        into.push({ kind: 'bookmark', title: anchor.textContent ?? '', url });
        continue;
      }

      if (Array.from(item.children).some(child => child.tagName === 'HR')) {
        into.push({ kind: 'separator', title: '' });
      }
    }
  }

  read(top, tree[defaultRoot], 0);
  return tree;
}

const ROOT_TITLES: Record<RestoreRoot, string> = {
  'root:toolbar': 'Pasek zakładek',
  'root:menu': 'Menu zakładek',
  'root:unsorted': 'Inne zakładki',
  'root:mobile': 'Zakładki mobilne',
};

const ROOT_ATTRIBUTES: Partial<Record<RestoreRoot, string>> = {
  'root:toolbar': ' PERSONAL_TOOLBAR_FOLDER="true"',
  'root:unsorted': ' UNFILED_BOOKMARKS_FOLDER="true"',
  'root:mobile': ' MOBILE_BOOKMARKS_FOLDER="true"',
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Eksport Netscape. Wlasny atrybut pozwala zachowac wszystkie cztery korzenie. */
export function formatBookmarkHtml(tree: RestoreTree): string {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Zakładki FrogSync</TITLE>',
    '<H1>Zakładki FrogSync</H1>',
    '<DL><p>',
  ];

  function write(nodes: RestoreNode[], indent: string): void {
    for (const node of nodes) {
      if (node.kind === 'folder') {
        lines.push(`${indent}<DT><H3>${escapeHtml(node.title)}</H3>`, `${indent}<DL><p>`);
        write(node.children, `${indent}    `);
        lines.push(`${indent}</DL><p>`);
      } else if (node.kind === 'bookmark') {
        lines.push(`${indent}<DT><A HREF="${escapeHtml(node.url)}">${escapeHtml(node.title)}</A>`);
      } else {
        lines.push(`${indent}<HR>`);
      }
    }
  }

  for (const root of RESTORE_ROOTS) {
    lines.push(
      `    <DT><H3 DATA-FROGSYNC-ROOT="${root}"${ROOT_ATTRIBUTES[root] ?? ''}>${ROOT_TITLES[root]}</H3>`,
      '    <DL><p>',
    );
    write(tree[root], '        ');
    lines.push('    </DL><p>');
  }
  lines.push('</DL><p>', '');
  return lines.join('\n');
}
