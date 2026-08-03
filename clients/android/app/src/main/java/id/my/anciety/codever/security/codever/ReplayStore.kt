package id.my.anciety.codever.security.codever

data class ReplayClaim(val key: String, val expiresAt: Long)

/** Implementations must atomically claim every key or none of them. */
fun interface ReplayStore {
    fun claimAll(claims: List<ReplayClaim>, now: Long): Boolean
}

class InMemoryReplayStore : ReplayStore {
    private val claims = mutableMapOf<String, Long>()

    @Synchronized
    override fun claimAll(claims: List<ReplayClaim>, now: Long): Boolean {
        this.claims.entries.removeIf { it.value <= now }
        if (claims.any { it.key in this.claims }) return false
        claims.forEach { this.claims[it.key] = it.expiresAt }
        return true
    }
}
