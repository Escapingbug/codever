package id.my.anciety.codever.web

internal enum class WebHostBindingAction {
    CREATE,
    RELOAD,
}

/**
 * A retained WebView can resume before the asynchronous Android service bind
 * completes. Its first native RPC then observes an empty binder and enters a
 * persistent recovery state. Reloading only after onServiceConnected makes
 * the WebView bootstrap against an already available native host.
 */
internal fun webHostActionAfterServiceConnected(
    hasExistingWebHost: Boolean,
): WebHostBindingAction = if (hasExistingWebHost) {
    WebHostBindingAction.RELOAD
} else {
    WebHostBindingAction.CREATE
}
