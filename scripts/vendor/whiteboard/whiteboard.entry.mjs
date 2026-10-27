// Entry of the vendored whiteboard (public/vendor/whiteboard/whiteboard.js): React + ReactDOM + Excalidraw in ONE pinned
// ES module (+ lazy chunks). The app has NO build step: this is bundled ONCE and committed to the repo.
// Rebuild (only when upgrading a version): scripts/vendor/build-whiteboard.sh
// The app (public/class-board.js, vanilla JS) renders the component with React.createElement — no JSX anywhere.
export { default as React } from 'react';
export { createRoot } from 'react-dom/client';
export { flushSync } from 'react-dom';
export {
  Excalidraw, MainMenu, WelcomeScreen, CaptureUpdateAction, exportToBlob, exportToSvg, reconcileElements, restoreElements,
  getSceneVersion, hashElementsVersion, getNonDeletedElements, convertToExcalidrawElements, THEME,
} from '@excalidraw/excalidraw';
export const VERSIONS = { react: '18.3.1', 'react-dom': '18.3.1', '@excalidraw/excalidraw': '0.18.1' };
