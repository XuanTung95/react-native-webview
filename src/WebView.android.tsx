import React, {
  forwardRef,
  ReactElement,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
} from 'react';

import {
  Image,
  View,
  ImageSourcePropType,
  HostComponent,
  registerCallableModule,
} from 'react-native';

import EventEmitter from 'react-native/Libraries/vendor/emitter/EventEmitter';

import invariant from 'invariant';

import RNCWebView, { Commands, NativeProps } from './RNCWebViewNativeComponent';
import RNCWebViewModule from './NativeRNCWebViewModule';
import {
  defaultOriginWhitelist,
  defaultRenderError,
  defaultRenderLoading,
  useWebViewLogic,
} from './WebViewShared';
import {
  AndroidWebViewProps,
  WebViewSourceUri,
  type WebViewMessageEvent,
  type ShouldStartLoadRequestEvent,
} from './WebViewTypes';
import {
  buildCallAsyncJavaScriptScript,
  buildHandlerResolutionScript,
  buildInAppWebViewBridgeBootstrap,
  parseInAppWebViewBridgeEnvelope,
  type CallAsyncJavaScriptOptions,
  type PostWebMessage,
} from './InAppWebViewBridge';

import styles from './WebView.styles';

const resolveAssetSource = (source: ImageSourcePropType) => Image.resolveAssetSource(source);

const directEventEmitter = new EventEmitter();

registerCallableModule('RNCWebViewMessagingModule', {
  onShouldStartLoadWithRequest: (
    event: ShouldStartLoadRequestEvent & { messagingModuleName?: string },
  ) => {
    directEventEmitter.emit('onShouldStartLoadWithRequest', event);
  },
  onMessage: (event: WebViewMessageEvent & { messagingModuleName?: string }) => {
    directEventEmitter.emit('onMessage', event);
  },
});

const WebViewComponent = forwardRef<unknown, AndroidWebViewProps>(
  (
    {
      overScrollMode = 'always',
      javaScriptEnabled = true,
      thirdPartyCookiesEnabled = true,
      scalesPageToFit = true,
      allowsFullscreenVideo = false,
      allowFileAccess = false,
      saveFormDataDisabled = false,
      cacheEnabled = true,
      androidLayerType = 'none',
      originWhitelist = defaultOriginWhitelist,
      setSupportMultipleWindows = true,
      setBuiltInZoomControls = true,
      setDisplayZoomControls = false,
      nestedScrollEnabled = false,
      startInLoadingState,
      onNavigationStateChange,
      onLoadStart,
      onError,
      onLoad,
      onLoadEnd,
      onLoadSubResourceError,
      onLoadProgress,
      onHttpError: onHttpErrorProp,
      onRenderProcessGone: onRenderProcessGoneProp,
      onMessage: onMessageProp,
      inAppWebViewJavaScriptHandlers,
      messagingOriginRules,
      nativeProxyEnabled,
      nativeProxyAllowedHosts,
      onOpenWindow: onOpenWindowProp,
      renderLoading,
      renderError,
      style,
      containerStyle,
      source,
      nativeConfig,
      onShouldStartLoadWithRequest: onShouldStartLoadWithRequestProp,
      injectedJavaScriptObject,
      injectedJavaScript,
      injectedJavaScriptBeforeContentLoaded,
      ...otherProps
    },
    ref,
  ) => {
    const id = useId();
    const messagingModuleName = `WebViewMessageHandler${id}`;
    const webViewRef = useRef<React.ComponentRef<HostComponent<NativeProps>> | null>(null);
    const compatibilityBridgeEnabled =
      inAppWebViewJavaScriptHandlers !== undefined || nativeProxyEnabled === true;
    const asyncRequestCounter = useRef(1);
    const asyncRequests = useRef(
      new Map<
        number,
        {
          resolve: (value: unknown) => void;
          reject: (reason: Error) => void;
          timeout: ReturnType<typeof setTimeout>;
        }
      >(),
    );
    const bridgeOnMessage = useCallback(
      (event: WebViewMessageEvent) => {
        const envelope = parseInAppWebViewBridgeEnvelope(event.nativeEvent.data);
        if (!envelope) {
          onMessageProp?.(event);
          return;
        }
        if (envelope.type === 'async-result') {
          const pending = asyncRequests.current.get(envelope.id);
          if (!pending) return;
          asyncRequests.current.delete(envelope.id);
          clearTimeout(pending.timeout);
          if (envelope.ok) pending.resolve(envelope.value);
          else pending.reject(new Error(String(envelope.error ?? 'JavaScript execution failed.')));
          return;
        }
        const handler = inAppWebViewJavaScriptHandlers?.[envelope.handlerName];
        if (!handler) {
          if (webViewRef.current) {
            Commands.injectJavaScript(
              webViewRef.current,
              buildHandlerResolutionScript(
                envelope.id,
                false,
                `JavaScript handler '${envelope.handlerName}' is not registered.`,
              ),
            );
          }
          return;
        }
        Promise.resolve()
          .then(() => handler(...envelope.args))
          .then(
            (value) => {
              if (webViewRef.current) {
                Commands.injectJavaScript(
                  webViewRef.current,
                  buildHandlerResolutionScript(envelope.id, true, value),
                );
              }
            },
            (error) => {
              if (webViewRef.current) {
                Commands.injectJavaScript(
                  webViewRef.current,
                  buildHandlerResolutionScript(
                    envelope.id,
                    false,
                    error instanceof Error ? error.message : String(error),
                  ),
                );
              }
            },
          );
      },
      [inAppWebViewJavaScriptHandlers, onMessageProp],
    );

    useEffect(
      () => () => {
        asyncRequests.current.forEach((request) => {
          clearTimeout(request.timeout);
          request.reject(new Error('WebView was unmounted.'));
        });
        asyncRequests.current.clear();
      },
      [],
    );

    const onShouldStartLoadWithRequestCallback = useCallback(
      (shouldStart: boolean, url: string, lockIdentifier?: number) => {
        if (lockIdentifier) {
          RNCWebViewModule.shouldStartLoadWithLockIdentifier(shouldStart, lockIdentifier);
        } else if (shouldStart && webViewRef.current) {
          Commands.loadUrl(webViewRef.current, url);
        }
      },
      [],
    );

    const {
      onLoadingStart,
      onShouldStartLoadWithRequest,
      onMessage,
      viewState,
      setViewState,
      lastErrorEvent,
      onHttpError,
      onLoadingError,
      onLoadingSubResourceError,
      onLoadingFinish,
      onLoadingProgress,
      onOpenWindow,
      onRenderProcessGone,
    } = useWebViewLogic({
      onNavigationStateChange,
      onLoad,
      onError,
      onHttpErrorProp,
      onLoadSubResourceError,
      onLoadEnd,
      onLoadProgress,
      onLoadStart,
      onRenderProcessGoneProp,
      onMessageProp: bridgeOnMessage,
      onOpenWindowProp,
      startInLoadingState,
      originWhitelist,
      onShouldStartLoadWithRequestProp,
      onShouldStartLoadWithRequestCallback,
    });

    useImperativeHandle(
      ref,
      () => ({
        goForward: () => webViewRef.current && Commands.goForward(webViewRef.current),
        goBack: () => webViewRef.current && Commands.goBack(webViewRef.current),
        reload: () => {
          setViewState('LOADING');
          if (webViewRef.current) {
            Commands.reload(webViewRef.current);
          }
        },
        stopLoading: () => webViewRef.current && Commands.stopLoading(webViewRef.current),
        postMessage: (data: string) =>
          webViewRef.current && Commands.postMessage(webViewRef.current, data),
        postWebMessage: (message: PostWebMessage) =>
          webViewRef.current &&
          Commands.postWebMessage(
            webViewRef.current,
            message.data,
            message.type ?? 'string',
            message.targetOrigin ?? '',
          ),
        callAsyncJavaScript: <T,>(
          functionBody: string,
          options: CallAsyncJavaScriptOptions = {},
        ): Promise<T> => {
          if (!webViewRef.current) {
            return Promise.reject(new Error('WebView is not attached.'));
          }
          const requestId = asyncRequestCounter.current;
          asyncRequestCounter.current += 1;
          const timeoutMs = Math.max(1, options.timeoutMs ?? 20_000);
          let script: string;
          try {
            script = buildCallAsyncJavaScriptScript(requestId, functionBody, options.arguments);
          } catch (error) {
            return Promise.reject(error);
          }
          const result = new Promise<T>((resolve, reject) => {
            const timeout = setTimeout(() => {
              asyncRequests.current.delete(requestId);
              reject(new Error(`Async JavaScript request ${requestId} timed out.`));
            }, timeoutMs);
            asyncRequests.current.set(requestId, {
              resolve: (value) => resolve(value as T),
              reject,
              timeout,
            });
          });
          Commands.injectJavaScript(webViewRef.current, script);
          return result;
        },
        injectJavaScript: (data: string) =>
          webViewRef.current && Commands.injectJavaScript(webViewRef.current, data),
        requestFocus: () => webViewRef.current && Commands.requestFocus(webViewRef.current),
        clearFormData: () => webViewRef.current && Commands.clearFormData(webViewRef.current),
        clearCache: (includeDiskFiles: boolean) =>
          webViewRef.current && Commands.clearCache(webViewRef.current, includeDiskFiles),
        clearHistory: () => webViewRef.current && Commands.clearHistory(webViewRef.current),
      }),
      [setViewState, webViewRef],
    );

    useEffect(() => {
      const onShouldStartLoadWithRequestSubscription = directEventEmitter.addListener(
        'onShouldStartLoadWithRequest',
        (
          event: ShouldStartLoadRequestEvent & {
            messagingModuleName?: string;
          },
        ) => {
          if (event.messagingModuleName === messagingModuleName) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { messagingModuleName: _, ...rest } = event;
            onShouldStartLoadWithRequest(rest);
          }
        },
      );

      const onMessageSubscription = directEventEmitter.addListener(
        'onMessage',
        (event: WebViewMessageEvent & { messagingModuleName?: string }) => {
          if (event.messagingModuleName === messagingModuleName) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { messagingModuleName: _, ...rest } = event;
            onMessage(rest);
          }
        },
      );

      return () => {
        onShouldStartLoadWithRequestSubscription.remove();
        onMessageSubscription.remove();
      };
    }, [messagingModuleName, onMessage, onShouldStartLoadWithRequest]);

    let otherView: ReactElement | undefined;
    if (viewState === 'LOADING') {
      otherView = (renderLoading || defaultRenderLoading)();
    } else if (viewState === 'ERROR') {
      invariant(lastErrorEvent != null, 'lastErrorEvent expected to be non-null');
      if (lastErrorEvent) {
        otherView = (renderError || defaultRenderError)(
          lastErrorEvent.domain,
          lastErrorEvent.code,
          lastErrorEvent.description,
        );
      }
    }

    const webViewStyles = [styles.container, styles.webView, style];
    const webViewContainerStyle = [styles.container, containerStyle];

    if (typeof source !== 'number' && source && 'method' in source) {
      if (source.method === 'POST' && source.headers) {
        console.warn('WebView: `source.headers` is not supported when using POST.');
      } else if (source.method === 'GET' && source.body) {
        console.warn('WebView: `source.body` is not supported when using GET.');
      }
    }

    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const NativeWebView = (nativeConfig?.component as typeof RNCWebView | undefined) || RNCWebView;

    // oxlint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
    const sourceResolved = resolveAssetSource(source as ImageSourcePropType);
    const newSource =
      typeof sourceResolved === 'object'
        ? Object.entries(sourceResolved as WebViewSourceUri).reduce(
            (prev, [currKey, currValue]) => {
              return {
                ...prev,
                [currKey]:
                  currKey === 'headers' && currValue && typeof currValue === 'object'
                    ? Object.entries(currValue).map(([key, value]) => {
                        return {
                          name: key,
                          value,
                        };
                      })
                    : currValue,
              };
            },
            {},
          )
        : sourceResolved;

    const webView = (
      <NativeWebView
        key="webViewKey"
        {...otherProps}
        // decelerationRate is iOS-only but may arrive through untyped props;
        // the codegen spec types it as a Double, so forwarding the "normal" /
        // "fast" string shortcuts would throw during Fabric prop conversion.
        decelerationRate={undefined}
        messagingEnabled={typeof onMessageProp === 'function' || compatibilityBridgeEnabled}
        messagingModuleName={messagingModuleName}
        messagingOriginRules={messagingOriginRules}
        nativeProxyEnabled={nativeProxyEnabled}
        nativeProxyAllowedHosts={nativeProxyAllowedHosts}
        hasOnScroll={!!otherProps.onScroll}
        onLoadingError={onLoadingError}
        onLoadingSubResourceError={onLoadingSubResourceError}
        onLoadingFinish={onLoadingFinish}
        onLoadingProgress={onLoadingProgress}
        onLoadingStart={onLoadingStart}
        onHttpError={onHttpError}
        onRenderProcessGone={onRenderProcessGone}
        onMessage={onMessage}
        onOpenWindow={onOpenWindow}
        hasOnOpenWindowEvent={onOpenWindowProp !== undefined}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        ref={webViewRef}
        newSource={newSource}
        style={webViewStyles}
        overScrollMode={overScrollMode}
        javaScriptEnabled={javaScriptEnabled}
        thirdPartyCookiesEnabled={thirdPartyCookiesEnabled}
        scalesPageToFit={scalesPageToFit}
        allowsFullscreenVideo={allowsFullscreenVideo}
        allowFileAccess={allowFileAccess}
        saveFormDataDisabled={saveFormDataDisabled}
        cacheEnabled={cacheEnabled}
        androidLayerType={androidLayerType}
        setSupportMultipleWindows={setSupportMultipleWindows}
        setBuiltInZoomControls={setBuiltInZoomControls}
        setDisplayZoomControls={setDisplayZoomControls}
        nestedScrollEnabled={nestedScrollEnabled}
        injectedJavaScriptObject={JSON.stringify(injectedJavaScriptObject)}
        injectedJavaScript={`${
          compatibilityBridgeEnabled ? buildInAppWebViewBridgeBootstrap() : ''
        }\n${injectedJavaScript ?? ''}`}
        injectedJavaScriptBeforeContentLoaded={`${
          compatibilityBridgeEnabled ? buildInAppWebViewBridgeBootstrap() : ''
        }\n${injectedJavaScriptBeforeContentLoaded ?? ''}`}
        {...nativeConfig?.props}
      />
    );

    return (
      <View style={webViewContainerStyle}>
        {webView}
        {otherView}
      </View>
    );
  },
);

const isFileUploadSupported = async () => true;

const WebView = Object.assign(WebViewComponent, { isFileUploadSupported });

export default WebView;
