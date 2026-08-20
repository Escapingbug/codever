package id.my.anciety.codever.matrix

import java.security.MessageDigest
import kotlinx.coroutines.CancellationException

internal data class MatrixApplicationEventBatchResult(
    val committed: Int,
    val quarantined: Int,
)

/**
 * Commits a Matrix application-control page event by event.
 *
 * A single historical event may belong to an older Codever protocol or may be
 * malformed independently of the Matrix cursor surrounding it. Treating the
 * whole page as atomic makes that event a permanent head-of-line blocker: the
 * cursor never advances, so later command completions and notifications are
 * never observed. Security failures remain rejected by the event decoder; the
 * Later events in the same page are applied before each failed event receives
 * one retry, so an out-of-order dependency can still converge without being
 * discarded. The caller records any remaining bounded fingerprint and
 * converges from authoritative Room State after the page has advanced.
 */
internal suspend fun processMatrixApplicationEventBatch(
    events: List<MatrixDecryptedEvent>,
    onEvent: suspend (MatrixDecryptedEvent) -> Unit,
    onCommitted: (MatrixDecryptedEvent) -> Unit = {},
    onQuarantined: (MatrixDecryptedEvent, Exception) -> Unit = { _, _ -> },
): MatrixApplicationEventBatchResult {
    var committed = 0
    val retry = mutableListOf<MatrixDecryptedEvent>()
    for (event in events) {
        try {
            onEvent(event)
            committed += 1
            onCommitted(event)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            retry += event
        }
    }
    var quarantined = 0
    for (event in retry) {
        try {
            onEvent(event)
            committed += 1
            onCommitted(event)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            quarantined += 1
            onQuarantined(event, error)
        }
    }
    return MatrixApplicationEventBatchResult(committed, quarantined)
}

internal fun matrixApplicationEventFingerprint(event: MatrixDecryptedEvent): String =
    MessageDigest.getInstance("SHA-256")
        .digest(event.rawJson.toByteArray(Charsets.UTF_8))
        .take(FINGERPRINT_BYTES)
        .joinToString("") { byte -> "%02x".format(byte) }

private const val FINGERPRINT_BYTES = 8
