package id.my.anciety.codever.client.command

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

enum class CommandState(val wireName: String) {
    QUEUED("queued"),
    TRANSMITTING("transmitting"),
    ACCEPTED("accepted"),
    RUNNING("running"),
    NEEDS_REVIEW("needs_review"),
    RECOVERY_REQUIRED("recovery_required"),
    SUCCEEDED("succeeded"),
    FAILED("failed"),
    CANCELLED("cancelled"),
    ;

    val isTerminal: Boolean
        get() = this == SUCCEEDED || this == FAILED || this == CANCELLED

    companion object {
        fun fromWireName(value: String): CommandState = entries.firstOrNull { it.wireName == value }
            ?: throw IllegalArgumentException("Command state is invalid.")
    }
}

enum class CommandOutcome(val wireName: String) {
    SUCCEEDED("succeeded"),
    FAILED("failed"),
    CANCELLED("cancelled"),
    ;

    companion object {
        fun fromWireName(value: String): CommandOutcome = entries.firstOrNull { it.wireName == value }
            ?: throw IllegalArgumentException("Command outcome is invalid.")
    }
}

data class PublicCommandError(
    val code: String,
    val message: String,
    val retryable: Boolean,
) {
    init {
        require(code.isNotBlank() && code.length <= 128) { "Command error code is invalid." }
        require(message.length <= 4_096) { "Command error message is too large." }
    }

    override fun toString(): String =
        "PublicCommandError(code=$code, message=<redacted>, retryable=$retryable)"
}

data class CommandCompletion(
    val commandId: String,
    val sequence: Long,
    val revision: Long,
    val outcome: CommandOutcome,
    val sessionId: String? = null,
    val result: JsonElement? = null,
    val error: PublicCommandError? = null,
) {
    init {
        requireOpaqueId(commandId, "commandId")
        requirePositiveJsonInteger(sequence, "Command sequence")
        requireNonnegativeJsonInteger(revision, "Command revision")
        sessionId?.let { requireOpaqueId(it, "sessionId") }
        require(result == null || result.toString().toByteArray(Charsets.UTF_8).size <= MAX_RESULT_BYTES) {
            "Command result is too large."
        }
    }

    override fun toString(): String =
        "CommandCompletion(commandId=$commandId, sequence=$sequence, revision=$revision, " +
            "outcome=$outcome, sessionId=$sessionId, result=<redacted>, error=$error)"
}

data class CommandView(
    val operationId: String,
    val commandId: String,
    val idempotencyKey: String,
    val state: CommandState,
    val submittedAt: Long,
    val updatedAt: Long,
    val sessionId: String? = null,
    val sequence: Long,
    val revision: Long? = null,
    val cancelRequested: Boolean = false,
    val completion: CommandCompletion? = null,
) {
    init {
        requireOpaqueId(operationId, "operationId")
        requireOpaqueId(commandId, "commandId")
        requireUuid(idempotencyKey)
        requireNonnegativeJsonInteger(submittedAt, "Command submitted timestamp")
        requireNonnegativeJsonInteger(updatedAt, "Command updated timestamp")
        require(updatedAt >= submittedAt) { "Command timestamps are invalid." }
        requirePositiveJsonInteger(sequence, "Command sequence")
        revision?.let { requireNonnegativeJsonInteger(it, "Command revision") }
        sessionId?.let { requireOpaqueId(it, "sessionId") }
        require(completion == null || completion.commandId == commandId) {
            "Command completion does not belong to this command."
        }
        require(completion == null || completion.sequence == sequence) {
            "Command completion sequence does not match."
        }
        require(state.isTerminal == (completion != null)) {
            "Terminal commands must contain exactly one completion."
        }
    }
}

data class CommandReceipt(
    val operationId: String,
    val commandId: String,
    val idempotencyKey: String,
    val state: CommandState,
    val submittedAt: Long,
    val updatedAt: Long,
    val sessionId: String? = null,
    val sequence: Long,
    val revision: Long? = null,
) {
    init {
        requireOpaqueId(operationId, "operationId")
        requireOpaqueId(commandId, "commandId")
        requireUuid(idempotencyKey)
        requireNonnegativeJsonInteger(submittedAt, "Command submitted timestamp")
        requireNonnegativeJsonInteger(updatedAt, "Command updated timestamp")
        require(updatedAt >= submittedAt) { "Command timestamps are invalid." }
        sessionId?.let { requireOpaqueId(it, "sessionId") }
        requirePositiveJsonInteger(sequence, "Command sequence")
        revision?.let { requireNonnegativeJsonInteger(it, "Command revision") }
    }
}

data class CommandTransmission(
    val operationId: String,
    val commandId: String,
    val idempotencyKey: String,
    val sequence: Long,
    val baseRevision: Long,
    val payload: JsonObject,
    val recovery: Boolean,
) {
    init {
        requireOpaqueId(operationId, "operationId")
        requireOpaqueId(commandId, "commandId")
        requireUuid(idempotencyKey)
        requirePositiveJsonInteger(sequence, "Command sequence")
        requireNonnegativeJsonInteger(baseRevision, "Command base revision")
        require(payload.toString().toByteArray(Charsets.UTF_8).size <= MAX_PAYLOAD_BYTES) {
            "Command payload is too large."
        }
    }

    override fun toString(): String =
        "CommandTransmission(operationId=$operationId, commandId=$commandId, " +
            "idempotencyKey=$idempotencyKey, sequence=$sequence, baseRevision=$baseRevision, " +
            "payload=<redacted>, recovery=$recovery)"
}

enum class RevisionConflictAction {
    RETRY,
    DISCARD,
}

class CommandBusyException(
    val blockingCommandId: String,
    val blockingState: CommandState,
    val blockingOperation: CommandOperation,
    val expectedRevision: Long?,
) : IllegalStateException(
    if (blockingState == CommandState.NEEDS_REVIEW) {
        "The previous Codever action needs review before another action can start."
    } else {
        "Codever is restoring the previous queued action."
    },
)

class CommandIdempotencyConflictException(message: String) : IllegalArgumentException(message)

class ReleasedCommandException(message: String) : IllegalStateException(message)

class CommandRevisionConflictException(
    val commandId: String,
    val expectedRevision: Long,
) : IllegalStateException("Command $commandId requires review at revision $expectedRevision.")

internal const val MAX_PAYLOAD_BYTES = 256 * 1024
internal const val MAX_RESULT_BYTES = 256 * 1024
internal const val MAX_SAFE_JSON_INTEGER = 9_007_199_254_740_991L

internal fun requireOpaqueId(value: String, field: String) {
    require(value.isNotBlank() && value.length <= 512 && !value.any(Char::isISOControl)) {
        "$field is invalid."
    }
}

internal fun requireUuid(value: String) {
    val parsed = runCatching { java.util.UUID.fromString(value) }.getOrNull()
    require(parsed != null && parsed.toString().equals(value, ignoreCase = true)) {
        "idempotencyKey must be a UUID."
    }
}

internal fun requirePositiveJsonInteger(value: Long, field: String) {
    require(value in 1..MAX_SAFE_JSON_INTEGER) { "$field must be a positive safe JSON integer." }
}

internal fun requireNonnegativeJsonInteger(value: Long, field: String) {
    require(value in 0..MAX_SAFE_JSON_INTEGER) { "$field must be a nonnegative safe JSON integer." }
}

internal fun CommandView.toReceipt() = CommandReceipt(
    operationId = operationId,
    commandId = commandId,
    idempotencyKey = idempotencyKey,
    state = state,
    submittedAt = submittedAt,
    updatedAt = updatedAt,
    sessionId = sessionId,
    sequence = sequence,
    revision = revision,
)
