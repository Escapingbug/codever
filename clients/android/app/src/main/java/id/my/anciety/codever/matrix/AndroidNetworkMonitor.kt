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
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
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
