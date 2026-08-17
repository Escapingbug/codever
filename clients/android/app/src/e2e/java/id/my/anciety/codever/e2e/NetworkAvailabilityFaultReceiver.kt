package id.my.anciety.codever.e2e

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import id.my.anciety.codever.BuildConfig
import id.my.anciety.codever.service.CodeverConnectionService
import id.my.anciety.codever.service.ServiceActions

/**
 * Delivers deterministic connectivity callbacks to the E2E runtime. Emulator
 * ADB networking can remain validated in airplane mode, so an OS toggle alone
 * cannot reproduce vendor ConnectivityManager callback sequences reliably.
 * This receiver does not exist in production APKs.
 */
class NetworkAvailabilityFaultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        check(BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK) {
            "The network availability fixture is available only in E2E builds."
        }
        check(intent.hasExtra(CodeverConnectionService.E2E_NETWORK_AVAILABLE_EXTRA)) {
            "The network availability fixture requires an explicit value."
        }
        ContextCompat.startForegroundService(
            context,
            Intent(context, CodeverConnectionService::class.java)
                .setAction(ServiceActions.E2E_NETWORK_AVAILABILITY)
                .putExtra(
                    CodeverConnectionService.E2E_NETWORK_AVAILABLE_EXTRA,
                    intent.getBooleanExtra(
                        CodeverConnectionService.E2E_NETWORK_AVAILABLE_EXTRA,
                        false,
                    ),
                ),
        )
        resultCode = Activity.RESULT_OK
        resultData = "network-availability-injected"
    }
}
