import WebViewDefault from './WebView';
export { HeadlessWebView } from './HeadlessWebView';
export type {
  HeadlessWebViewOptions,
  HeadlessWebViewSize,
  HeadlessWebViewSource,
  HeadlessWebViewEvent,
} from './HeadlessWebView';

export { WebViewDefault as WebView };
export type {
  CallAsyncJavaScriptOptions,
  JavaScriptEvaluationOptions,
  InAppWebViewJavaScriptHandler,
  InAppWebViewJavaScriptHandlers,
  PostWebMessage,
} from './InAppWebViewBridge';
export default WebViewDefault;
