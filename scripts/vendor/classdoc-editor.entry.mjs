// Entry of the vendored class-document editor (public/vendor/classdoc-editor.js).
// The app has NO build step: this file is bundled ONCE into a single ES module that is committed to the repo.
// Rebuild (only when upgrading a version): scripts/vendor/build-classdoc.sh
// One copy of Yjs and ProseMirror is shared by every export (y-prosemirror needs the same instances).
export * as Y from 'yjs';
export { Awareness } from 'y-protocols/awareness';
export { Editor } from '@tiptap/core';
export { default as StarterKit } from '@tiptap/starter-kit';
export { default as Link } from '@tiptap/extension-link';
export { default as Table } from '@tiptap/extension-table';
export { default as TableRow } from '@tiptap/extension-table-row';
export { default as TableHeader } from '@tiptap/extension-table-header';
export { default as TableCell } from '@tiptap/extension-table-cell';
export { default as Collaboration } from '@tiptap/extension-collaboration';
export { default as CollaborationCursor } from '@tiptap/extension-collaboration-cursor';
export { default as Placeholder } from '@tiptap/extension-placeholder';
export { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
export const VERSIONS = { yjs: '13.6.32', 'y-protocols': '1.0.6', 'y-prosemirror': '1.3.7', tiptap: '2.27.2' };
