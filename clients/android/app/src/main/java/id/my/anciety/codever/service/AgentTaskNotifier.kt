package id.my.anciety.codever.service

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import id.my.anciety.codever.R
import id.my.anciety.codever.client.command.CommandCompletion
import id.my.anciety.codever.web.MainActivity

class AgentTaskNotifier(private val context: Context) {
    fun createChannel() {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.task_notification_channel_name),
                NotificationManager.IMPORTANCE_DEFAULT,
            ).apply {
                description = context.getString(R.string.task_notification_channel_description)
                setShowBadge(true)
            },
        )
    }

    @SuppressLint("MissingPermission")
    fun show(kind: TaskNotificationKind, completion: CommandCompletion) {
        val notificationId = notificationId(completion.sessionId ?: completion.commandId)
        val openSession = Intent(context, MainActivity::class.java)
            .setAction(MainActivity.ACTION_OPEN_SESSION)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        completion.sessionId?.let { openSession.putExtra(MainActivity.EXTRA_SESSION_ID, it) }
        val contentIntent = PendingIntent.getActivity(
            context,
            notificationId,
            openSession,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_codever_notification)
            .setContentTitle(context.getString(kind.titleResource()))
            .setContentText(context.getString(kind.bodyResource()))
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setGroup(TASK_NOTIFICATION_GROUP)
            .setOnlyAlertOnce(true)
            .setAutoCancel(true)
            .setContentIntent(contentIntent)
            .build()
        NotificationManagerCompat.from(context).notify(notificationId, notification)
    }

    private fun TaskNotificationKind.titleResource(): Int = when (this) {
        TaskNotificationKind.SUCCEEDED -> R.string.task_notification_succeeded_title
        TaskNotificationKind.FAILED -> R.string.task_notification_failed_title
        TaskNotificationKind.CANCELLED -> R.string.task_notification_cancelled_title
    }

    private fun TaskNotificationKind.bodyResource(): Int = when (this) {
        TaskNotificationKind.SUCCEEDED -> R.string.task_notification_succeeded_body
        TaskNotificationKind.FAILED -> R.string.task_notification_failed_body
        TaskNotificationKind.CANCELLED -> R.string.task_notification_cancelled_body
    }

    private fun notificationId(value: String): Int =
        TASK_NOTIFICATION_ID_BASE + (value.hashCode() and TASK_NOTIFICATION_ID_MASK)

    companion object {
        const val CHANNEL_ID = "codever-agent-tasks"
        private const val TASK_NOTIFICATION_GROUP = "codever-agent-task-updates"
        private const val TASK_NOTIFICATION_ID_BASE = 20_000_000
        private const val TASK_NOTIFICATION_ID_MASK = 0x00ffffff
    }
}
