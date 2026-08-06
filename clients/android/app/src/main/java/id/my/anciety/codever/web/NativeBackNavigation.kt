package id.my.anciety.codever.web

internal const val NATIVE_BACK_DISPATCH_SCRIPT = """
    (() => {
      const event = new Event('codever:native-back', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })()
"""

internal const val NATIVE_BACK_RESPONSE_TIMEOUT_MS = 500L

internal fun nativeBackWasHandled(javascriptResult: String?): Boolean =
    javascriptResult?.trim() == "true"

internal enum class NativeBackFallbackAction {
    WEB_HISTORY,
    BACKGROUND_TASK,
}

internal fun nativeBackFallbackAction(canGoBack: Boolean): NativeBackFallbackAction =
    if (canGoBack) {
        NativeBackFallbackAction.WEB_HISTORY
    } else {
        NativeBackFallbackAction.BACKGROUND_TASK
    }
