import { Component } from 'react';
export { HeadlessWebView } from './lib/HeadlessWebView';
export type {
  HeadlessWebViewOptions,
  HeadlessWebViewSize,
  HeadlessWebViewSource,
  HeadlessWebViewEvent,
} from './lib/HeadlessWebView';
import { IOSWebViewProps, AndroidWebViewProps, WindowsWebViewProps } from './lib/WebViewTypes';
import type {
  CallAsyncJavaScriptOptions,
  JavaScriptEvaluationOptions,
  PostWebMessage,
} from './lib/InAppWebViewBridge';
import type { InAppWebViewJavaScriptHandler } from './lib/InAppWebViewBridge';

export type {
  CallAsyncJavaScriptOptions,
  JavaScriptEvaluationOptions,
  InAppWebViewJavaScriptHandler,
  InAppWebViewJavaScriptHandlers,
} from './lib/InAppWebViewBridge';

export { FileDownload, WebViewMessageEvent, WebViewNavigation } from './lib/WebViewTypes';

export type WebViewProps = IOSWebViewProps & AndroidWebViewProps & WindowsWebViewProps;

// `{}` is the identity for intersections: `WebViewProps & undefined` would
// collapse the props to `never` (https://github.com/react-native-webview/react-native-webview/issues/3977).
// oxlint-disable-next-line @typescript-eslint/no-empty-object-type
declare class WebView<P = {}> extends Component<WebViewProps & P> {
  /**
   * Go back one page in the webview's history.
   */
  goBack: () => void;

  /**
   * Go forward one page in the webview's history.
   */
  goForward: () => void;

  /**
   * Reloads the current page.
   */
  reload: () => void;

  /**
   * Stop loading the current page.
   */
  stopLoading(): void;

  /**
   * Executes the JavaScript string.
   */
  injectJavaScript: (script: string) => void;

  /** iOS and Android. Returns the native evaluation result; does not await JS Promises. */
  evaluateJavascript: <T = unknown>(
    source: string,
    options?: JavaScriptEvaluationOptions,
  ) => Promise<T>;

  /**
   * Focuses on WebView rendered page.
   */
  requestFocus: () => void;

  /**
   * Posts a message to WebView.
   */
  postMessage: (message: string) => void;

  /**
   * Android and iOS. Executes an async JavaScript function body and resolves its
   * returned JSON-compatible value.
   */
  callAsyncJavaScript: <T = unknown>(
    functionBody: string,
    options?: CallAsyncJavaScriptOptions,
  ) => Promise<T>;

  addJavaScriptHandler: (name: string, callback: InAppWebViewJavaScriptHandler) => void;
  removeJavaScriptHandler: (name: string) => void;

  /**
   * Android and iOS. Posts a string or Base64-encoded ArrayBuffer to the page.
   */
  postWebMessage: (message: PostWebMessage) => void;

  /**
   * (Android only)
   * Removes the autocomplete popup from the currently focused form field, if present.
   */
  clearFormData?: () => void;

  /**
   * Clears the resource cache. Note that the cache is per-application, so this will clear the cache for all WebViews used.
   */
  clearCache: (includeDiskFiles: boolean) => void;

  /**
   * (Android only)
   * Tells this WebView to clear its internal back/forward list.
   */
  clearHistory?: () => void;
}

export { WebView };
export default WebView;
