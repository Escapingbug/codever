package id.my.anciety.codever.web

internal enum class WebHostBindingAction {
    CREATE,
    KEEP,
    RELOAD,
}

/**
 * Normal background transitions retain the Activity-to-service binding so a
 * visible WebView never races a new native handshake against an asynchronous
 * rebind. If Android disconnects the service or recreates the Activity, reload
 * only after onServiceConnected so bootstrap sees an available native host.
 */
internal fun webHostActionAfterServiceConnected(
    hasExistingWebHost: Boolean,
    recoveringFromDisconnect: Boolean = false,
): WebHostBindingAction = if (!hasExistingWebHost) {
    WebHostBindingAction.CREATE
} else if (recoveringFromDisconnect) {
    WebHostBindingAction.RELOAD
} else {
    WebHostBindingAction.KEEP
}
