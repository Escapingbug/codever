package id.my.anciety.codever.update

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import id.my.anciety.codever.R
import id.my.anciety.codever.web.MainActivity

internal class NativeUpdateNotifier(private val context: Context) {
    fun createChannel() {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.update_notification_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = context.getString(R.string.update_notification_channel_description)
                setShowBadge(false)
            },
        )
    }

    @SuppressLint("MissingPermission")
    fun showReady(versionName: String) {
        createChannel()
        val open = PendingIntent.getActivity(
            context,
            READY_NOTIFICATION_ID,
            Intent(context, MainActivity::class.java)
                .setAction(MainActivity.ACTION_INSTALL_NATIVE_UPDATE)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        NotificationManagerCompat.from(context).notify(
            READY_NOTIFICATION_ID,
            NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_codever_notification)
                .setContentTitle(context.getString(R.string.update_ready_title))
                .setContentText(context.getString(R.string.update_ready_body, versionName))
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setAutoCancel(false)
                .setOnlyAlertOnce(true)
                .setContentIntent(open)
                .build(),
        )
    }

    @SuppressLint("MissingPermission")
    fun showConfirmation(confirmation: Intent) {
        createChannel()
        val action = PendingIntent.getActivity(
            context,
            INSTALL_CONFIRMATION_REQUEST_ID,
            confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        NotificationManagerCompat.from(context).notify(
            READY_NOTIFICATION_ID,
            NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_codever_notification)
                .setContentTitle(context.getString(R.string.update_confirmation_title))
                .setContentText(context.getString(R.string.update_confirmation_body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_STATUS)
                .setAutoCancel(false)
                .setContentIntent(action)
                .build(),
        )
    }

    @SuppressLint("MissingPermission")
    fun showFailed() {
        createChannel()
        val open = PendingIntent.getActivity(
            context,
            FAILED_NOTIFICATION_ID,
            Intent(context, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        NotificationManagerCompat.from(context).notify(
            FAILED_NOTIFICATION_ID,
            NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_codever_notification)
                .setContentTitle(context.getString(R.string.update_failed_title))
                .setContentText(context.getString(R.string.update_failed_body))
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .setAutoCancel(true)
                .setContentIntent(open)
                .build(),
        )
    }

    fun clear() {
        NotificationManagerCompat.from(context).cancel(READY_NOTIFICATION_ID)
        NotificationManagerCompat.from(context).cancel(FAILED_NOTIFICATION_ID)
    }

    private companion object {
        const val CHANNEL_ID = "codever-native-updates"
        const val READY_NOTIFICATION_ID = 1_901
        const val FAILED_NOTIFICATION_ID = 1_902
        const val INSTALL_CONFIRMATION_REQUEST_ID = 1_903
    }
}
