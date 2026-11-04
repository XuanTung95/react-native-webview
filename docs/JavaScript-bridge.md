# JavaScript injection and request/response handlers

Android, iOS and macOS support named handlers through `javaScriptHandlers`.
Like Flutter InAppWebView's `callHandler`, a web page passes a handler name and
JSON arguments and receives a Promise containing the app's JSON response.

```tsx
import React, { useRef } from 'react';
import { Button, View } from 'react-native';
import WebView from 'react-native-webview';

export default function BridgeExample() {
  const webView = useRef<WebView>(null);
  return (
    <View style={{ flex: 1 }}>
      <Button
        title="Inject JavaScript"
        onPress={() =>
          webView.current?.injectJavaScript("document.body.style.backgroundColor = '#eef'; true;")
        }
      />
      <WebView
        ref={webView}
        originWhitelist={['*']}
        source={{
          html: '<html><body><h1>Bridge example</h1><pre id="result"></pre></body></html>',
        }}
        javaScriptHandlers={{
          getProfile: async (id) => ({ id, name: 'Tung' }),
          sum: (a, b) => Number(a) + Number(b),
        }}
        injectedJavaScriptBeforeContentLoaded="window.appVersion = '1.0'; true;"
        injectedJavaScript={`
          window.ReactNativeWebView.callHandler('getProfile', 123)
            .then(function (profile) {
              document.getElementById('result').textContent = JSON.stringify(profile);
            })
            .catch(function (error) {
              document.getElementById('result').textContent = error.message;
            });
          true;
        `}
        onMessage={(event) => console.log('Ordinary message:', event.nativeEvent.data)}
      />
    </View>
  );
}
```

- `ref.injectJavaScript(code)` executes code on the current page.
- `injectedJavaScriptBeforeContentLoaded` runs during document initialization.
- `injectedJavaScript` runs at the existing document-end injection point on every load, including `source={{ html }}`.
- `javaScriptHandlers` enables messaging without requiring an `onMessage` callback. Handler arguments are positional; handlers can return a value or Promise. `undefined` becomes `null`.

The bridge is installed before your injected scripts at both injection points.
Android document-start injection has the same timing limitations as the existing
`injectedJavaScriptBeforeContentLoaded` API. For reliable calls from injected code,
use `injectedJavaScript`. Page scripts can check
`window.ReactNativeWebView && window.ReactNativeWebView.callHandler`, or listen
for `ReactNativeWebViewReady` on `window` before calling the bridge.

Calls reject for unknown handlers, thrown errors, non-JSON results, or after a
60-second timeout. Arguments and results must be JSON-serializable; normal JSON
conversion rules apply. Responses belong to their originating document, so a late
response cannot resolve a request on a page loaded later. Navigation destroys
the previous page's JavaScript context; outstanding calls do not survive it.

Handlers run for the main frame only. Windows is not supported by this API.
Existing `postMessage` / `onMessage` calls continue to work. Only register handlers
for content you trust, and restrict navigation to the origins allowed to call them.
The wildcard in the example is for local HTML.
