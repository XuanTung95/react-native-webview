import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react';
import { Image, View, ImageSourcePropType, HostComponent } from 'react-native';
import invariant from 'invariant';

import RNCWebView, { Commands, NativeProps } from './RNCWebViewNativeComponent';
import RNCWebViewModule from './NativeRNCWebViewModule';

import {
  defaultOriginWhitelist,
  defaultRenderError,
  defaultRenderLoading,
  useWebViewLogic,
} from './WebViewShared';
import { IOSWebViewProps, DecelerationRateConstant, WebViewSourceUri } from './WebViewTypes';
import type { WebViewMessageEvent } from './WebViewTypes';
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
const processDecelerationRate = (
  decelerationRate: DecelerationRateConstant | number | undefined,
) => {
  let newDecelerationRate = decelerationRate;
  if (newDecelerationRate === 'normal') {
    newDecelerationRate = 0.998;
  } else if (newDecelerationRate === 'fast') {
    newDecelerationRate = 0.99;
  }
  return newDecelerationRate;
};

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-constraint
const useWarnIfChanges = <T extends unknown>(value: T, name: string) => {
  const ref = useRef(value);
  useEffect(() => {
    if (ref.current !== value) {
      console.warn(`Changes to property ${name} do nothing after the initial render.`);
      ref.current = value;
    }
  }, [value, name]);
};

const WebViewComponent = forwardRef<unknown, IOSWebViewProps>(
  (
    {
      fraudulentWebsiteWarningEnabled = true,
      javaScriptEnabled = true,
      cacheEnabled = true,
      originWhitelist = defaultOriginWhitelist,
      useSharedProcessPool = true,
      textInteractionEnabled = true,
      injectedJavaScript,
      injectedJavaScriptBeforeContentLoaded,
      injectedJavaScriptForMainFrameOnly = true,
      injectedJavaScriptBeforeContentLoadedForMainFrameOnly = true,
      injectedJavaScriptObject,
      startInLoadingState,
      onNavigationStateChange,
      onLoadStart,
      onError,
      onLoad,
      onLoadEnd,
      onLoadProgress,
      onContentProcessDidTerminate: onContentProcessDidTerminateProp,
      onFileDownload,
      onHttpError: onHttpErrorProp,
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
      allowsInlineMediaPlayback,
      allowsPictureInPictureMediaPlayback = true,
      allowsAirPlayForMediaPlayback,
      mediaPlaybackRequiresUserAction,
      dataDetectorTypes,
      incognito,
      decelerationRate: decelerationRateProp,
      onShouldStartLoadWithRequest: onShouldStartLoadWithRequestProp,
      removeIosKeyboardObserver,
      ...otherProps
    },
    ref,
  ) => {
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
      (shouldStart: boolean, _url: string, lockIdentifier = 0) => {
        RNCWebViewModule.shouldStartLoadWithLockIdentifier(shouldStart, lockIdentifier);
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
      onLoadingFinish,
      onLoadingProgress,
      onOpenWindow,
      onContentProcessDidTerminate,
    } = useWebViewLogic({
      onNavigationStateChange,
      onLoad,
      onError,
      onHttpErrorProp,
      onLoadEnd,
      onLoadProgress,
      onLoadStart,
      onMessageProp: bridgeOnMessage,
      onOpenWindowProp,
      startInLoadingState,
      originWhitelist,
      onShouldStartLoadWithRequestProp,
      onShouldStartLoadWithRequestCallback,
      onContentProcessDidTerminateProp,
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
        clearCache: (includeDiskFiles: boolean) =>
          webViewRef.current && Commands.clearCache(webViewRef.current, includeDiskFiles),
      }),
      [setViewState, webViewRef],
    );

    useWarnIfChanges(allowsInlineMediaPlayback, 'allowsInlineMediaPlayback');
    useWarnIfChanges(allowsPictureInPictureMediaPlayback, 'allowsPictureInPictureMediaPlayback');
    useWarnIfChanges(allowsAirPlayForMediaPlayback, 'allowsAirPlayForMediaPlayback');
    useWarnIfChanges(incognito, 'incognito');
    useWarnIfChanges(mediaPlaybackRequiresUserAction, 'mediaPlaybackRequiresUserAction');
    useWarnIfChanges(dataDetectorTypes, 'dataDetectorTypes');
    useWarnIfChanges(removeIosKeyboardObserver, 'removeIosKeyboardObserver');

    let otherView = null;
    if (viewState === 'LOADING') {
      otherView = (renderLoading || defaultRenderLoading)();
    } else if (viewState === 'ERROR') {
      invariant(lastErrorEvent != null, 'lastErrorEvent expected to be non-null');
      otherView = (renderError || defaultRenderError)(
        lastErrorEvent?.domain,
        lastErrorEvent?.code ?? 0,
        lastErrorEvent?.description ?? '',
      );
    }

    const webViewStyles = [styles.container, styles.webView, style];
    const webViewContainerStyle = [styles.container, containerStyle];

    const decelerationRate = processDecelerationRate(decelerationRateProp);

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
        fraudulentWebsiteWarningEnabled={fraudulentWebsiteWarningEnabled}
        javaScriptEnabled={javaScriptEnabled}
        cacheEnabled={cacheEnabled}
        useSharedProcessPool={useSharedProcessPool}
        textInteractionEnabled={textInteractionEnabled}
        decelerationRate={decelerationRate}
        messagingEnabled={typeof onMessageProp === 'function' || compatibilityBridgeEnabled}
        messagingModuleName="" // android ONLY
        messagingOriginRules={messagingOriginRules}
        nativeProxyEnabled={nativeProxyEnabled}
        nativeProxyAllowedHosts={nativeProxyAllowedHosts}
        onLoadingError={onLoadingError}
        onLoadingFinish={onLoadingFinish}
        onLoadingProgress={onLoadingProgress}
        onFileDownload={onFileDownload}
        onLoadingStart={onLoadingStart}
        onHttpError={onHttpError}
        onMessage={onMessage}
        onOpenWindow={onOpenWindowProp && onOpenWindow}
        hasOnOpenWindowEvent={onOpenWindowProp !== undefined}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onContentProcessDidTerminate={onContentProcessDidTerminate}
        injectedJavaScript={`${
          compatibilityBridgeEnabled ? buildInAppWebViewBridgeBootstrap() : ''
        }\n${injectedJavaScript ?? ''}`}
        injectedJavaScriptBeforeContentLoaded={`${
          compatibilityBridgeEnabled ? buildInAppWebViewBridgeBootstrap() : ''
        }\n${injectedJavaScriptBeforeContentLoaded ?? ''}`}
        injectedJavaScriptForMainFrameOnly={injectedJavaScriptForMainFrameOnly}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly={
          injectedJavaScriptBeforeContentLoadedForMainFrameOnly
        }
        injectedJavaScriptObject={JSON.stringify(injectedJavaScriptObject)}
        dataDetectorTypes={
          !dataDetectorTypes || Array.isArray(dataDetectorTypes)
            ? dataDetectorTypes
            : [dataDetectorTypes]
        }
        allowsAirPlayForMediaPlayback={allowsAirPlayForMediaPlayback}
        allowsInlineMediaPlayback={allowsInlineMediaPlayback}
        allowsPictureInPictureMediaPlayback={allowsPictureInPictureMediaPlayback}
        incognito={incognito}
        mediaPlaybackRequiresUserAction={mediaPlaybackRequiresUserAction}
        removeIosKeyboardObserver={removeIosKeyboardObserver}
        newSource={newSource}
        style={webViewStyles}
        hasOnFileDownload={!!onFileDownload}
        ref={webViewRef}
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

// no native implementation for iOS, depends only on permissions
const isFileUploadSupported: () => Promise<boolean> = async () => true;

const WebView = Object.assign(WebViewComponent, { isFileUploadSupported });

export default WebView;
