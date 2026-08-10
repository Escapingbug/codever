package id.my.anciety.codever.client

internal data class GatewayHistoryPagePosition(
    val headEventId: String?,
    val eventIds: Set<String>,
    val nextBefore: String?,
    val complete: Boolean,
)

internal sealed interface GatewayHistoryConvergenceDecision {
    data class Continue(val before: String) : GatewayHistoryConvergenceDecision
    data class Complete(val headEventId: String?) : GatewayHistoryConvergenceDecision
}

/**
 * Converges history against the last head that was confirmed by the Gateway.
 * Local timeline events are deliberately not anchors: a limited sync can keep
 * the newest events while silently dropping an arbitrarily large middle gap.
 */
internal class GatewayHistoryConvergence(
    private val previousHeadEventId: String?,
    private val requireCompleteWithoutCheckpoint: Boolean = false,
) {
    private var newestHeadEventId: String? = null
    private val continuationCursors = mutableSetOf<String>()

    fun accept(page: GatewayHistoryPagePosition): GatewayHistoryConvergenceDecision {
        if (newestHeadEventId == null) newestHeadEventId = page.headEventId
        val legacyGatewayWithoutHeads = newestHeadEventId == null
        val firstBaselineIsComplete = previousHeadEventId == null && (
            !requireCompleteWithoutCheckpoint ||
                // A rolling upgrade can temporarily pair a newer APK with a
                // legacy Gateway. It cannot establish the new checkpoint yet,
                // but it must not download the entire history on every view.
                legacyGatewayWithoutHeads
            )
        if (
            legacyGatewayWithoutHeads ||
            firstBaselineIsComplete ||
            previousHeadEventId == newestHeadEventId ||
            previousHeadEventId in page.eventIds ||
            page.complete
        ) {
            return GatewayHistoryConvergenceDecision.Complete(newestHeadEventId)
        }
        val before = checkNotNull(page.nextBefore) {
            "An incomplete Gateway history page omitted its continuation cursor."
        }
        check(continuationCursors.add(before)) {
            "Gateway history pagination repeated a continuation cursor."
        }
        return GatewayHistoryConvergenceDecision.Continue(before)
    }
}
