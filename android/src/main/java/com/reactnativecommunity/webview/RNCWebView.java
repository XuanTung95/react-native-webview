package com.reactnativecommunity.webview;

import android.annotation.SuppressLint;
import android.graphics.Rect;
import android.net.Uri;
import android.text.TextUtils;
import android.view.ActionMode;
import android.view.Menu;
import android.view.MenuItem;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.ScriptHandler;
import androidx.webkit.WebMessageCompat;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import com.facebook.common.logging.FLog;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.CatalystInstance;
import com.facebook.react.bridge.JavaScriptModule;
import com.facebook.react.bridge.LifecycleEventListener;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.bridge.WritableNativeArray;
import com.facebook.react.bridge.WritableNativeMap;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.UIManagerHelper;
import com.facebook.react.uimanager.events.ContentSizeChangeEvent;
import com.facebook.react.uimanager.events.Event;
import com.facebook.react.views.scroll.OnScrollDispatchHelper;
import com.facebook.react.views.scroll.ScrollEvent;
import com.facebook.react.views.scroll.ScrollEventType;
import com.reactnativecommunity.webview.events.TopCustomMenuSelectionEvent;
import com.reactnativecommunity.webview.events.TopMessageEvent;

import org.json.JSONException;
import org.json.JSONObject;
import org.json.JSONTokener;
import java.util.Iterator;
import java.util.ArrayList;

import java.util.List;
import java.util.Map;
import java.util.Set;

public class RNCWebView extends WebView implements LifecycleEventListener {
    protected @Nullable
    String injectedJS;
    protected @Nullable
    String injectedJSBeforeContentLoaded;
    protected static final String JAVASCRIPT_INTERFACE = "ReactNativeWebView";
    protected @Nullable
    RNCWebViewBridge fallbackBridge;
    protected @Nullable
    WebViewCompat.WebMessageListener bridgeListener = null;
    protected Set<String> messagingOriginRules = Set.of("*");
    protected boolean nativeProxyEnabled = false;
    protected Set<String> nativeProxyAllowedHosts = Set.of();

    /**
     * android.webkit.WebChromeClient fundamentally does not support JS injection into frames other
     * than the main frame, so these two properties are mostly here just for parity with iOS & macOS.
     */
    protected boolean injectedJavaScriptForMainFrameOnly = true;
    protected boolean injectedJavaScriptBeforeContentLoadedForMainFrameOnly = true;

    protected boolean messagingEnabled = false;
    protected @Nullable
    String messagingModuleName;
    protected @Nullable
    RNCWebViewMessagingModule mMessagingJSModule;
    protected @Nullable
    RNCWebViewClient mRNCWebViewClient;
    protected boolean sendContentSizeChangeEvents = false;
    private OnScrollDispatchHelper mOnScrollDispatchHelper;
    protected boolean hasScrollEvent = false;
    protected boolean nestedScrollEnabled = false;
    protected ProgressChangedFilter progressChangedFilter;

    /**
     * WebView must be created with an context of the current activity
     * <p>
     * Activity Context is required for creation of dialogs internally by WebView
     * Reactive Native needed for access to ReactNative internal system functionality
     */
    public RNCWebView(ThemedReactContext reactContext) {
        super(reactContext);
        mMessagingJSModule = ((ThemedReactContext) this.getContext()).getReactApplicationContext().getJSModule(RNCWebViewMessagingModule.class);
        progressChangedFilter = new ProgressChangedFilter();
    }

    public void setBasicAuthCredential(RNCBasicAuthCredential credential) {
        mRNCWebViewClient.setBasicAuthCredential(credential);
    }

    public void setSendContentSizeChangeEvents(boolean sendContentSizeChangeEvents) {
        this.sendContentSizeChangeEvents = sendContentSizeChangeEvents;
    }

    public void setHasScrollEvent(boolean hasScrollEvent) {
        this.hasScrollEvent = hasScrollEvent;
    }

    public void setNestedScrollEnabled(boolean nestedScrollEnabled) {
        this.nestedScrollEnabled = nestedScrollEnabled;
    }

    @Override
    public void onHostResume() {
        // do nothing
    }

    @Override
    public void onHostPause() {
        // do nothing
    }

    @Override
    public void onHostDestroy() {
        cleanupCallbacksAndDestroy();
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        if (this.nestedScrollEnabled) {
            requestDisallowInterceptTouchEvent(true);
        }
        return super.onTouchEvent(event);
    }

    @Override
    protected void onSizeChanged(int w, int h, int ow, int oh) {
        super.onSizeChanged(w, h, ow, oh);

        if (sendContentSizeChangeEvents) {
            dispatchEvent(
                    this,
                    new ContentSizeChangeEvent(
                            UIManagerHelper.getSurfaceId(this),
                            RNCWebViewWrapper.getReactTagFromWebView(this),
                            w,
                            h
                    )
            );
        }
    }

    protected @Nullable
    List<Map<String, String>> menuCustomItems;

    public void setMenuCustomItems(List<Map<String, String>> menuCustomItems) {
      this.menuCustomItems = menuCustomItems;
    }

    @Override
    public ActionMode startActionMode(ActionMode.Callback callback, int type) {
      if(menuCustomItems == null ){
        return super.startActionMode(callback, type);
      }

      return super.startActionMode(new ActionMode.Callback2() {
        @Override
        public boolean onCreateActionMode(ActionMode mode, Menu menu) {
          for (int i = 0; i < menuCustomItems.size(); i++) {
            menu.add(Menu.NONE, i, i, (menuCustomItems.get(i)).get("label"));
          }
          return true;
        }

        @Override
        public boolean onPrepareActionMode(ActionMode actionMode, Menu menu) {
          return false;
        }

        @Override
        public boolean onActionItemClicked(ActionMode mode, MenuItem item) {
          WritableMap wMap = Arguments.createMap();
          RNCWebView.this.evaluateJavascript(
            "(function(){return {selection: window.getSelection().toString()} })()",
            new ValueCallback<String>() {
              @Override
              public void onReceiveValue(String selectionJson) {
                Map<String, String> menuItemMap = menuCustomItems.get(item.getItemId());
                wMap.putString("label", menuItemMap.get("label"));
                wMap.putString("key", menuItemMap.get("key"));
                String selectionText = "";
                try {
                  selectionText = new JSONObject(selectionJson).getString("selection");
                } catch (JSONException ignored) {}
                wMap.putString("selectedText", selectionText);
                dispatchEvent(RNCWebView.this, new TopCustomMenuSelectionEvent(UIManagerHelper.getSurfaceId(RNCWebView.this), RNCWebViewWrapper.getReactTagFromWebView(RNCWebView.this), wMap));
                mode.finish();
              }
            }
          );
          return true;
        }

        @Override
        public void onDestroyActionMode(ActionMode mode) {
          mode = null;
        }

        @Override
        public void onGetContentRect (ActionMode mode,
                View view,
                Rect outRect){
            if (callback instanceof ActionMode.Callback2) {
                ((ActionMode.Callback2) callback).onGetContentRect(mode, view, outRect);
            } else {
                super.onGetContentRect(mode, view, outRect);
            }
          }
      }, type);
    }

    @Override
    public void setWebViewClient(WebViewClient client) {
        super.setWebViewClient(client);
        if (client instanceof RNCWebViewClient) {
            mRNCWebViewClient = (RNCWebViewClient) client;
            mRNCWebViewClient.setProgressChangedFilter(progressChangedFilter);
        }
    }

    WebChromeClient mWebChromeClient;
    @Override
    public void setWebChromeClient(WebChromeClient client) {
        this.mWebChromeClient = client;
        super.setWebChromeClient(client);
        if (client instanceof RNCWebChromeClient) {
            ((RNCWebChromeClient) client).setProgressChangedFilter(progressChangedFilter);
        }
    }

    public WebChromeClient getWebChromeClient() {
        return this.mWebChromeClient;
    }

    public @Nullable
    RNCWebViewClient getRNCWebViewClient() {
        return mRNCWebViewClient;
    }

    public boolean getMessagingEnabled() {
        return this.messagingEnabled;
    }

    protected void createRNCWebViewBridge(RNCWebView webView) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)){
          if (this.bridgeListener == null) {
            this.bridgeListener = new WebViewCompat.WebMessageListener() {
              @Override
              public void onPostMessage(@NonNull WebView view, @NonNull WebMessageCompat message, @NonNull Uri sourceOrigin, boolean isMainFrame, @NonNull JavaScriptReplyProxy replyProxy) {
                RNCWebView.this.onMessage(message.getData(), sourceOrigin.toString());
              }
            };
            WebViewCompat.addWebMessageListener(
              webView,
              JAVASCRIPT_INTERFACE,
              messagingOriginRules,
              this.bridgeListener
            );
          }
        } else {
          if (fallbackBridge == null) {
            fallbackBridge = new RNCWebViewBridge(webView);
            addJavascriptInterface(fallbackBridge, JAVASCRIPT_INTERFACE);
          }
        }
        injectJavascriptObject();
    }

    private void injectJavascriptObject() {
      if (getSettings().getJavaScriptEnabled()) {
        String js = "(function(){\n" +
          "    window." + JAVASCRIPT_INTERFACE + " = window." + JAVASCRIPT_INTERFACE + " || {};\n" +
          "    window." + JAVASCRIPT_INTERFACE + ".injectedObjectJson = function () { return " + (injectedJavaScriptObject == null ? null : ("`" + injectedJavaScriptObject + "`")) + "; };\n" +
          "})();";
        evaluateJavascriptWithFallback(js);
      }
    }

    @SuppressLint("AddJavascriptInterface")
    public void setMessagingEnabled(boolean enabled) {
        if (messagingEnabled == enabled) {
            return;
        }

        messagingEnabled = enabled;

        if (enabled) {
            createRNCWebViewBridge(this);
        }
    }

    public void setMessagingOriginRules(@Nullable List<String> originRules) {
        Set<String> nextRules = originRules == null || originRules.isEmpty()
                ? Set.of("*")
                : Set.copyOf(originRules);
        if (messagingOriginRules.equals(nextRules)) {
            return;
        }
        messagingOriginRules = nextRules;
        if (bridgeListener != null && WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.removeWebMessageListener(this, JAVASCRIPT_INTERFACE);
            bridgeListener = null;
            if (messagingEnabled) {
                createRNCWebViewBridge(this);
            }
        }
    }

    public void setNativeProxyEnabled(boolean enabled) {
        nativeProxyEnabled = enabled;
    }

    public void setNativeProxyAllowedHosts(@Nullable List<String> allowedHosts) {
        nativeProxyAllowedHosts = allowedHosts == null ? Set.of() : Set.copyOf(allowedHosts);
    }

    private ScriptHandler documentStartScript;

    public void setInjectedJSBeforeContentLoaded(@Nullable String script) {
        injectedJSBeforeContentLoaded = script;
        if (documentStartScript != null) {
            documentStartScript.remove();
            documentStartScript = null;
        }
        if (script != null && !script.isEmpty() && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            // Match the existing main-frame injection behavior. Native messaging is installed first.
            documentStartScript = WebViewCompat.addDocumentStartJavaScript(this,
                "if (window === window.top) { (function() {\n" + script + "\n})(); }", Set.of("*"));
        }
    }

    private void emitJavaScriptResult(double id, Object value, String error) {
        try {
            JSONObject result = new JSONObject();
            result.put("kind", "__rnc_inappwebview_bridge__");
            result.put("type", "async-result");
            result.put("id", id);
            result.put("ok", error == null);
            result.put(error == null ? "value" : "error", error == null ? (value == null ? JSONObject.NULL : value) : error);
            onMessage(result.toString(), getUrl());
        } catch (JSONException exception) {
            throw new IllegalStateException(exception);
        }
    }

    public void executeJavaScript(double id, String source, String argumentsJSON, boolean asynchronous) {
        if (!getSettings().getJavaScriptEnabled()) {
            emitJavaScriptResult(id, null, "JavaScript is disabled.");
            return;
        }
        if (!asynchronous) {
            // Android supplies a JSON-encoded result directly, independently of page messaging.
            evaluateJavascript(source, raw -> {
                try { emitJavaScriptResult(id, raw == null ? JSONObject.NULL : new JSONTokener(raw).nextValue(), null); }
                catch (JSONException error) { emitJavaScriptResult(id, null, error.getMessage()); }
            });
            return;
        }
        try {
            JSONObject arguments = new JSONObject(argumentsJSON);
            ArrayList<String> names = new ArrayList<>();
            ArrayList<String> values = new ArrayList<>();
            for (Iterator<String> keys = arguments.keys(); keys.hasNext();) {
                String key = keys.next();
                // Public TS API also rejects reserved words before dispatching this command.
                if (!key.matches("[$A-Za-z_][$A-Za-z_0-9]*")) throw new IllegalArgumentException("Invalid JavaScript argument name.");
                names.add(key);
                values.add("args[" + JSONObject.quote(key) + "]");
            }
            String script = "(function(args) { (async function(" + TextUtils.join(",", names) + ") {\n" + source +
                "\n}).call(window" + (values.isEmpty() ? "" : "," + TextUtils.join(",", values)) + ")" +
                ".then(function(value) { window.ReactNativeWebView.postMessage(JSON.stringify({kind:'__rnc_inappwebview_bridge__',type:'async-result',id:" + id + ",ok:true,value:value == null ? null : value})); })" +
                ".catch(function(error) { window.ReactNativeWebView.postMessage(JSON.stringify({kind:'__rnc_inappwebview_bridge__',type:'async-result',id:" + id + ",ok:false,error:String(error)})); }); })(" + argumentsJSON + "); true;";
            evaluateJavascript(script, started -> {
                if (!"true".equals(started)) emitJavaScriptResult(id, null, "Could not start async JavaScript. Check function syntax and arguments.");
            });
        } catch (Exception error) {
            emitJavaScriptResult(id, null, error.getMessage());
        }
    }

    protected void evaluateJavascriptWithFallback(String script) {
        evaluateJavascript(script, null);
    }

    public void callInjectedJavaScript() {
        if (getSettings().getJavaScriptEnabled() &&
                injectedJS != null &&
                !TextUtils.isEmpty(injectedJS)) {
            evaluateJavascriptWithFallback("(function() {\n" + injectedJS + ";\n})();");
            injectJavascriptObject(); // re-inject the Javascript object in case it has been overwritten.
        }
    }

    public void callInjectedJavaScriptBeforeContentLoaded() {
        if (documentStartScript == null && getSettings().getJavaScriptEnabled() &&
                injectedJSBeforeContentLoaded != null &&
                !TextUtils.isEmpty(injectedJSBeforeContentLoaded)) {
            evaluateJavascriptWithFallback("(function() {\n" + injectedJSBeforeContentLoaded + ";\n})();");
            injectJavascriptObject();  // re-inject the Javascript object in case it has been overwritten.
        }
    }

    protected String injectedJavaScriptObject = null;

    public void setInjectedJavaScriptObject(String obj) {
      this.injectedJavaScriptObject = obj;
      injectJavascriptObject();
    }

    public void onMessage(String message, String sourceUrl) {
        if (nativeProxyEnabled && RNCWebViewNativeProxy.tryHandle(this, message, nativeProxyAllowedHosts)) {
            return;
        }
        ThemedReactContext reactContext = getThemedReactContext();
        RNCWebView mWebView = this;

        if (mRNCWebViewClient != null) {
            WebView webView = this;
            webView.post(new Runnable() {
                @Override
                public void run() {
                    if (mRNCWebViewClient == null) {
                        return;
                    }
                    WritableMap data = mRNCWebViewClient.createWebViewEvent(webView, sourceUrl);
                    data.putString("data", message);

                    if (mMessagingJSModule != null) {
                        dispatchDirectMessage(data);
                    } else {
                        dispatchEvent(webView, new TopMessageEvent(UIManagerHelper.getSurfaceId(webView), RNCWebViewWrapper.getReactTagFromWebView(webView), data));
                    }
                }
            });
        } else {
            WritableMap eventData = Arguments.createMap();
            eventData.putString("data", message);

            if (mMessagingJSModule != null) {
                dispatchDirectMessage(eventData);
            } else {
                dispatchEvent(this, new TopMessageEvent(UIManagerHelper.getSurfaceId(this), RNCWebViewWrapper.getReactTagFromWebView(this), eventData));
            }
        }
    }

    protected void dispatchDirectMessage(WritableMap data) {
        WritableNativeMap event = new WritableNativeMap();
        event.putMap("nativeEvent", data);
        event.putString("messagingModuleName", messagingModuleName);

        mMessagingJSModule.onMessage(event);
    }

    protected boolean dispatchDirectShouldStartLoadWithRequest(WritableMap data) {
        WritableNativeMap event = new WritableNativeMap();
        event.putMap("nativeEvent", data);
        event.putString("messagingModuleName", messagingModuleName);

        mMessagingJSModule.onShouldStartLoadWithRequest(event);
        return true;
    }

    protected void onScrollChanged(int x, int y, int oldX, int oldY) {
        super.onScrollChanged(x, y, oldX, oldY);

        if (!hasScrollEvent) {
            return;
        }

        if (mOnScrollDispatchHelper == null) {
            mOnScrollDispatchHelper = new OnScrollDispatchHelper();
        }

        if (mOnScrollDispatchHelper.onScrollChanged(x, y)) {
            ScrollEvent event = ScrollEvent.obtain(
                    UIManagerHelper.getSurfaceId(this),
                    RNCWebViewWrapper.getReactTagFromWebView(this),
                    ScrollEventType.SCROLL,
                    x,
                    y,
                    mOnScrollDispatchHelper.getXFlingVelocity(),
                    mOnScrollDispatchHelper.getYFlingVelocity(),
                    this.computeHorizontalScrollRange(),
                    this.computeVerticalScrollRange(),
                    this.getWidth(),
                    this.getHeight());

            dispatchEvent(this, event);
        }
    }

    protected void dispatchEvent(WebView webView, Event event) {
        ThemedReactContext reactContext = getThemedReactContext();
        int reactTag = RNCWebViewWrapper.getReactTagFromWebView(webView);
        UIManagerHelper.getEventDispatcherForReactTag(reactContext, reactTag).dispatchEvent(event);
    }

    protected void cleanupCallbacksAndDestroy() {
        setWebViewClient(null);
        destroy();
    }

    @Override
    public void destroy() {
        if (documentStartScript != null) {
            documentStartScript.remove();
            documentStartScript = null;
        }
        if (mWebChromeClient != null) {
            mWebChromeClient.onHideCustomView();
        }
        super.destroy();
    }

  public ThemedReactContext getThemedReactContext() {
    return (ThemedReactContext) this.getContext();
  }

  public ReactApplicationContext getReactApplicationContext() {
      return this.getThemedReactContext().getReactApplicationContext();
  }

  protected class RNCWebViewBridge {
        private String TAG = "RNCWebViewBridge";
        RNCWebView mWebView;

        RNCWebViewBridge(RNCWebView c) {
          mWebView = c;
        }

        /**
         * This method is called whenever JavaScript running within the web view calls:
         * - window[JAVASCRIPT_INTERFACE].postMessage
         */
        @JavascriptInterface
        public void postMessage(String message) {
            if (mWebView.getMessagingEnabled()) {
                // Post to main thread because `mWebView.getUrl()` requires to be executed on main.
                mWebView.post(() -> mWebView.onMessage(message, mWebView.getUrl()));
            } else {
                FLog.w(TAG, "ReactNativeWebView.postMessage method was called but messaging is disabled. Pass an onMessage handler to the WebView.");
            }
        }
    }


    protected static class ProgressChangedFilter {
        private boolean waitingForCommandLoadUrl = false;

        public void setWaitingForCommandLoadUrl(boolean isWaiting) {
            waitingForCommandLoadUrl = isWaiting;
        }

        public boolean isWaitingForCommandLoadUrl() {
            return waitingForCommandLoadUrl;
        }
    }
}
