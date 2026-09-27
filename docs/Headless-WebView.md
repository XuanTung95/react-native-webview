# Headless WebView (iOS and Android)

`HeadlessWebView` creates a native-owned WebView without rendering a React
component. It uses the local fork's existing WebView implementation and cookie
store. The native view stays attached behind the application UI: invisible on
Android, with alpha 0.01 and touch handling disabled on iOS. This follows the
native hosting approach used by Flutter InAppWebView.

```ts
import { HeadlessWebView } from 'react-native-webview';

const webview = new HeadlessWebView({
  source: { uri: 'https://example.com', headers: { 'X-Client': 'OneTube' } },
  initialSize: { width: 1, height: 1 },
  inAppWebViewJavaScriptHandlers: {
    sendToApp: async (...args) => ({ received: args }),
  },
  onWebViewCreated: controller => {
    // The native instance exists. Wait for onLoadStop before evaluating page JS.
    console.log(controller.isRunning());
  },
  onLoadStop: async ({ url }) => {
    try {
      const title = await webview.callAsyncJavaScript<string>('return document.title;');
      console.log(url, title);
    } catch (error) {
      console.error(error);
    }
  },
  onReceivedError: event => console.error(event),
  onProcessTerminated: event => {
    // The failed native instance is disposed. The owner can decide when to run again.
    console.warn(event);
  },
});

await webview.run();
// No <WebView /> needs to be mounted.
await webview.setSize({ width: 320, height: 240 });
const size = await webview.getSize();
// When the owning service no longer needs the WebView:
await webview.dispose();
```

Rebuild the native app after updating the local dependency. An OTA JavaScript
update alone cannot install the new TurboModule methods.

## Lifecycle

- `run()` is idempotent while running. It resolves after native creation and
  starting the initial load. Page readiness is reported by `onLoadStop`.
- `onWebViewCreated` runs before the initial URL is submitted. Its return value
  is not awaited. Register handlers in the options before calling `run()`.
- `dispose()` is idempotent and is queued behind an in-flight `run()`. It removes
  native views, callbacks, event subscriptions, and pending JS requests.
- Calling `run()` after disposal creates a new instance and loads the initial URL.
- `isRunning()` reports whether this controller owns a native instance, not
  whether the page has finished loading.
- Android Activity destruction disposes its headless instances. Renderer/content
  process termination on either platform disposes the failed instance and invokes
  `onProcessTerminated`; `run()` may then create a replacement.
- The application must have an active Activity/window when calling `run()`.
  Headless hosting does not bypass OS background suspension or process eviction.

## Size and events

Sizes are logical pixels (dp on Android, points on iOS). Default size is 1 x 1.
Use -1 for either dimension to use the current hosting window dimension. Call
`setSize` again if a window-relative size should follow an orientation change.

Callbacks receive plain event data, without React's `nativeEvent` wrapper:
`onLoadStart`, `onLoadStop`, `onProgressChanged` (0..1), `onReceivedError`,
`onReceivedHttpError`, `onMessage`, and `onProcessTerminated`. `isMainFrame` is
included for Android resource errors when the platform provides it.

## JavaScript

The compatibility bridge is always enabled. Page code can call
`window.flutter_inappwebview.callHandler(name, ...args)` and await the handler's
JSON-compatible return value. Responses are scoped to the document that called
the handler, so a late result cannot resolve a new page's request after reload.

Both normal and headless WebViews automatically install the bridge; the normal
component no longer needs `inAppWebViewJavaScriptHandlers={{}}` to enable it.
Register a callback with `controller.addJavaScriptHandler('sendToApp', (...args) => result)`.
The callback receives separate arguments, unlike Flutter's legacy single List.
`removeJavaScriptHandler(name)` removes a dynamically registered callback; a
handler supplied by the options/props remains available as a fallback.

`evaluateJavascript<T>(source, {timeoutMs}?)` returns the native evaluation result.
For example, `await controller.evaluateJavascript('1 + 1')` returns `2`.
It does not await a JavaScript Promise. Android's native evaluator returns null
for execution errors/unsupported results; iOS can reject with WebKit's error.
This reflects the underlying Flutter-style native evaluation APIs.

`callAsyncJavaScript<T>(body, {arguments, timeoutMs}?)` executes an async function
with named parameters and awaits its result. iOS uses WKWebView.callAsyncJavaScript;
Android uses an async wrapper and a correlated bridge response. This fork keeps
its existing Promise<T> return contract: failures reject, rather than returning
Flutter's `{value, error}` object. Arguments/results must be JSON-compatible.
Both methods default to a 20-second timeout, and pending calls reject on navigation,
disposal/unmount, or process termination. A timeout stops waiting for the result;
it does not stop JavaScript execution in the page. Execution uses the page world;
custom ContentWorlds and iframe targeting are not exposed.

`injectJavaScript(script)` remains available for scripts whose results are not needed.

The bridge dispatches `flutterInAppWebViewPlatformReady` once per document and sets
`window.flutter_inappwebview._platformReady = true` before dispatch. iOS installs
it at document start. Android uses DOCUMENT_START_SCRIPT when supported and falls
back to page-start/page-finish injection on older WebViews. To cover both paths:

```js
function send() {
  window.flutter_inappwebview.callHandler('sendToApp', {message: 'hello'});
}
if (window.flutter_inappwebview?._platformReady) send();
else window.addEventListener('flutterInAppWebViewPlatformReady', send, {once: true});
```

This bridge covers the main frame by default. It does not implement every field
and internal handler in Flutter's bridge object.

Other commands are `loadUrl({uri, headers})`, `reload()`, and `stopLoading()`.
This initial implementation supports GET URL sources; inline HTML, converting a
headless instance into a mounted component, and Flutter's keep-alive token API
are not exposed.
