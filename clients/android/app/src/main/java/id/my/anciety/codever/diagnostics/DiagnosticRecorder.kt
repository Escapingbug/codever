package id.my.anciety.codever.diagnostics

interface DiagnosticRecorder {
    fun record(event: String, attributes: Map<String, String> = emptyMap())

    data object None : DiagnosticRecorder {
        override fun record(event: String, attributes: Map<String, String>) = Unit
    }
}

internal object DiagnosticLine {
    private val safeToken = Regex("^[A-Za-z0-9._:+/-]{1,160}$")
    private val allowedAttributes = setOf(
        "accepted",
        "action",
        "appended",
        "available",
        "candidates",
        "code",
        "detail",
        "error",
        "phase",
        "reason",
        "running",
        "source",
        "stage",
    )

    fun encode(timestamp: String, event: String, attributes: Map<String, String>): String {
        val safeEvent = requireSafe(event, "event")
        val fields = attributes.toSortedMap().map { (key, value) ->
            require(key in allowedAttributes) { "attribute name is not approved for diagnostics." }
            "$key=${requireSafe(value, "attribute value")}"
        }
        return (listOf(timestamp, safeEvent) + fields).joinToString(" ")
    }

    private fun requireSafe(value: String, label: String): String {
        require(safeToken.matches(value)) { "$label is not safe for diagnostic output." }
        return value
    }
}
