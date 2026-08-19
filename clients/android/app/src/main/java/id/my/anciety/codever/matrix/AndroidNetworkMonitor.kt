package id.my.anciety.codever.matrix

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities

interface NetworkMonitor {
    fun isAvailable(): Boolean

    fun start(onChanged: (Boolean) -> Unit)

    fun stop()
}

class AndroidNetworkMonitor(context: Context) : NetworkMonitor {
    private val manager = context.getSystemService(ConnectivityManager::class.java)
    private var callback: ConnectivityManager.NetworkCallback? = null
    private var listener: ((Boolean) -> Unit)? = null
    private var lastValue: Boolean? = null

    override fun isAvailable(): Boolean {
        val active = manager.activeNetwork ?: return false
        val capabilities = manager.getNetworkCapabilities(active) ?: return false
        // VALIDATED means Android's public-internet probe succeeded; it does
        // not mean the configured Matrix homeserver is reachable. Enterprise
        // networks, VPNs, captive portals, and LAN-hosted homeservers can all
        // lack VALIDATED while Matrix itself is available. Let the SDK's real
        // request and retry path decide endpoint reachability.
        return hasUsableMatrixNetwork(
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
        )
    }

    @Synchronized
    override fun start(onChanged: (Boolean) -> Unit) {
        if (callback != null) return
        listener = onChanged
        lastValue = isAvailable()
        callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = publish()

            override fun onLost(network: Network) = publish()

            override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) =
                publish()
        }.also(manager::registerDefaultNetworkCallback)
    }

    @Synchronized
    override fun stop() {
        callback?.let { runCatching { manager.unregisterNetworkCallback(it) } }
        callback = null
        listener = null
        lastValue = null
    }

    private fun publish() {
        val available = isAvailable()
        val target = synchronized(this) {
            if (lastValue == available) null else {
                lastValue = available
                listener
            }
        }
        target?.invoke(available)
    }
}

internal fun hasUsableMatrixNetwork(hasInternetCapability: Boolean): Boolean =
    hasInternetCapability
