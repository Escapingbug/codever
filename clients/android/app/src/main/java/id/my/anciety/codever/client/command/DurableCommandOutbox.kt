package id.my.anciety.codever.client.command

import id.my.anciety.codever.security.SecretCipher
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

fun interface CommandClock {
    fun now(): Long
}

fun interface CommandIdFactory {
    fun newId(): String
}

/**
 * Durable, single-writer command lifecycle.
 *
 * A transmission lease never allocates a replacement command. If delivery is
 * uncertain, the exact same command id and sequence move to recovery_required
 * and can be sent again through the transport's idempotent recovery path.
 */
class DurableCommandOutbox internal constructor(
    private val store: CommandOutboxStore,
    private val clock: CommandClock = CommandClock(System::currentTimeMillis),
    private val idFactory: CommandIdFactory = CommandIdFactory { UUID.randomUUID().toString() },
) {
    private var snapshot: CommandOutboxSnapshot

    init {
        val loaded = store.load() ?: CommandOutboxSnapshot()
        val recovered = loaded.copy(
            commands = loaded.commands.map { command ->
                if (command.state == CommandState.TRANSMITTING) {
                    command.copy(
                        state = CommandState.RECOVERY_REQUIRED,
                        updatedAt = monotonicNow(command.updatedAt),
                    )
                } else {
                    command
                }
            },
        )
        if (recovered != loaded) store.save(recovered)
        snapshot = recovered
    }

    @Synchronized
    fun enqueue(
        idempotencyKey: String,
        payload: JsonObject,
        sessionId: String? = null,
    ): CommandReceipt {
        requireUuid(idempotencyKey)
        sessionId?.let { requireOpaqueId(it, "sessionId") }
        val validatedPayload = CommandPayloadValidator.validate(payload)
        require(sessionId == null || sessionId == validatedPayload.sessionId) {
            "The command session id does not match its payload."
        }
        val effectiveSessionId = validatedPayload.sessionId
        val fingerprint = requestFingerprint(payload, effectiveSessionId)
        snapshot.commands.firstOrNull { it.idempotencyKey == idempotencyKey }?.let { existing ->
            if (existing.requestFingerprint != fingerprint) {
                throw CommandIdempotencyConflictException(
                    "The idempotency key is already associated with a different command.",
                )
            }
            return existing.toView().toReceipt()
        }
        snapshot.released.firstOrNull { it.idempotencyKey == idempotencyKey }?.let { released ->
            if (released.requestFingerprint != fingerprint) {
                throw CommandIdempotencyConflictException(
                    "The released idempotency key belongs to a different command.",
                )
            }
            throw ReleasedCommandException(
                "Command ${released.commandId} was already completed and released; it will not be executed again.",
            )
        }
        val blocking = snapshot.commands.firstOrNull {
            it.belongsTo(snapshot) &&
                it.sequence > snapshot.lastAcknowledgedSequence &&
                !it.state.isTerminal
        }
        if (blocking != null) {
            throw CommandBusyException(
                blockingCommandId = blocking.commandId,
                blockingState = blocking.state,
                blockingOperation = CommandPayloadValidator.validate(blocking.payload).operation,
                expectedRevision = blocking.expectedRevision,
            )
        }
        require(snapshot.commands.size < MAX_ACTIVE_COMMANDS) {
            "Release completed commands before adding another command."
        }
        val now = nonnegativeNow()
        val operationId = newUniqueId("operationId")
        val command = PersistedCommand(
            operationId = operationId,
            commandId = newUniqueId("commandId", setOf(operationId)),
            retiredCommandIds = emptyList(),
            idempotencyKey = idempotencyKey,
            requestFingerprint = fingerprint,
            state = CommandState.QUEUED,
            submittedAt = now,
            updatedAt = now,
            sessionId = effectiveSessionId,
            sequence = Math.addExact(snapshot.lastAcknowledgedSequence, 1L),
            baseRevision = snapshot.lastRevision,
            revisionEpoch = snapshot.revisionEpoch,
            revisionEpochGeneration = snapshot.revisionEpochGeneration,
            authenticationIssuedAt = null,
            authenticationNonce = null,
            revision = null,
            cancelRequested = false,
            completion = null,
            expectedRevision = null,
            payload = payload,
        )
        commit(snapshot.copy(commands = snapshot.commands + command))
        return command.toView().toReceipt()
    }

    @Synchronized
    fun claimForTransmission(commandId: String): CommandTransmission? {
        val command = findCurrent(commandId) ?: return null
        if (command.state != CommandState.QUEUED) return null
        val now = monotonicNow(command.updatedAt)
        val next = command.copy(
            state = CommandState.TRANSMITTING,
            updatedAt = now,
            authenticationIssuedAt = command.authenticationIssuedAt ?: now,
            authenticationNonce = command.authenticationNonce
                ?: authenticationNonce(command.commandId),
        )
        replaceAndCommit(command, next)
        return next.toTransmission(recovery = false)
    }

    @Synchronized
    fun claimRecovery(commandId: String): CommandTransmission? {
        val command = findCurrent(commandId) ?: return null
        if (command.state != CommandState.RECOVERY_REQUIRED) return null
        val now = monotonicNow(command.updatedAt)
        val next = command.copy(
            state = CommandState.TRANSMITTING,
            updatedAt = now,
            authenticationIssuedAt = requireNotNull(command.authenticationIssuedAt) {
                "Recoverable command authentication time is missing."
            },
            authenticationNonce = requireNotNull(command.authenticationNonce) {
                "Recoverable command nonce is missing."
            },
        )
        replaceAndCommit(command, next)
        return next.toTransmission(recovery = true)
    }

    /**
     * Replays an already acknowledged command only to recover its terminal
     * result. The accepted/running state is deliberately preserved: this is a
     * read-through probe against the Gateway's durable replay ledger, not a
     * second logical execution or a new command sequence.
     */
    @Synchronized
    fun claimCompletionRecovery(commandId: String): CommandTransmission? {
        val command = findCurrent(commandId) ?: return null
        if (command.state != CommandState.ACCEPTED && command.state != CommandState.RUNNING) {
            return null
        }
        return command.copy(
            authenticationIssuedAt = requireNotNull(command.authenticationIssuedAt) {
                "Accepted command authentication time is missing."
            },
            authenticationNonce = requireNotNull(command.authenticationNonce) {
                "Accepted command nonce is missing."
            },
        ).toTransmission(recovery = true)
    }

    @Synchronized
    fun markAcknowledgementTimedOut(commandId: String): CommandView? {
        val command = findCurrent(commandId) ?: return null
        if (command.state != CommandState.TRANSMITTING) return command.toView()
        val next = command.copy(
            state = CommandState.RECOVERY_REQUIRED,
            updatedAt = monotonicNow(command.updatedAt),
        )
        replaceAndCommit(command, next)
        return next.toView()
    }

    @Synchronized
    fun recordAcknowledgement(commandId: String, sequence: Long, revision: Long): Boolean {
        requirePositiveJsonInteger(sequence, "Command sequence")
        requireNonnegativeJsonInteger(revision, "Command revision")
        val command = findCurrent(commandId) ?: return false
        if (command.sequence != sequence || command.state == CommandState.NEEDS_REVIEW) return false
        if (command.state.isTerminal) return false
        val next = command.copy(
            state = if (command.state == CommandState.RUNNING) CommandState.RUNNING else CommandState.ACCEPTED,
            updatedAt = monotonicNow(command.updatedAt),
            revision = maxOf(command.revision ?: 0, revision),
        )
        commit(
            snapshot.copy(
                lastAcknowledgedSequence = if (command.belongsTo(snapshot)) {
                    maxOf(snapshot.lastAcknowledgedSequence, sequence)
                } else {
                    snapshot.lastAcknowledgedSequence
                },
                lastRevision = if (command.belongsTo(snapshot)) {
                    maxOf(snapshot.lastRevision, revision)
                } else {
                    snapshot.lastRevision
                },
                commands = replace(snapshot.commands, command, next),
            ),
        )
        return true
    }

    @Synchronized
    fun recordRunning(
        commandId: String,
        sequence: Long,
        revision: Long,
        sessionId: String? = null,
    ): Boolean {
        requirePositiveJsonInteger(sequence, "Command sequence")
        requireNonnegativeJsonInteger(revision, "Command revision")
        sessionId?.let { requireOpaqueId(it, "sessionId") }
        val command = findCurrent(commandId) ?: return false
        if (command.sequence != sequence || command.state.isTerminal || command.state == CommandState.NEEDS_REVIEW) {
            return false
        }
        val next = command.copy(
            state = CommandState.RUNNING,
            updatedAt = monotonicNow(command.updatedAt),
            revision = maxOf(command.revision ?: 0, revision),
            sessionId = sessionId ?: command.sessionId,
        )
        commit(
            snapshot.copy(
                lastAcknowledgedSequence = if (command.belongsTo(snapshot)) {
                    maxOf(snapshot.lastAcknowledgedSequence, sequence)
                } else {
                    snapshot.lastAcknowledgedSequence
                },
                lastRevision = if (command.belongsTo(snapshot)) {
                    maxOf(snapshot.lastRevision, revision)
                } else {
                    snapshot.lastRevision
                },
                commands = replace(snapshot.commands, command, next),
            ),
        )
        return true
    }

    @Synchronized
    fun recordCompletion(completion: CommandCompletion): Boolean {
        val command = findCurrent(completion.commandId) ?: return false
        if (command.sequence != completion.sequence) return false
        if (command.revision != null && completion.revision < command.revision) return false
        command.completion?.let { existing ->
            if (existing == completion) return false
            throw IllegalStateException("A different terminal result is already stored for this command.")
        }
        if (command.state == CommandState.NEEDS_REVIEW) return false
        val terminalState = when (completion.outcome) {
            CommandOutcome.SUCCEEDED -> CommandState.SUCCEEDED
            CommandOutcome.FAILED -> CommandState.FAILED
            CommandOutcome.CANCELLED -> CommandState.CANCELLED
        }
        val next = command.copy(
            state = terminalState,
            updatedAt = monotonicNow(command.updatedAt),
            revision = maxOf(command.revision ?: 0, completion.revision),
            sessionId = completion.sessionId ?: command.sessionId,
            completion = completion,
        )
        commit(
            snapshot.copy(
                lastAcknowledgedSequence = if (command.belongsTo(snapshot)) {
                    maxOf(snapshot.lastAcknowledgedSequence, completion.sequence)
                } else {
                    snapshot.lastAcknowledgedSequence
                },
                lastRevision = if (command.belongsTo(snapshot)) {
                    maxOf(snapshot.lastRevision, completion.revision)
                } else {
                    snapshot.lastRevision
                },
                commands = replace(snapshot.commands, command, next),
            ),
        )
        return true
    }

    @Synchronized
    fun recordRevisionConflict(commandId: String, sequence: Long, expectedRevision: Long): CommandView? {
        requirePositiveJsonInteger(sequence, "Command sequence")
        requireNonnegativeJsonInteger(expectedRevision, "Expected command revision")
        val command = findCurrent(commandId) ?: return null
        if (command.sequence != sequence || command.state.isTerminal) return command.toView()
        val next = command.copy(
            state = CommandState.NEEDS_REVIEW,
            updatedAt = monotonicNow(command.updatedAt),
            expectedRevision = expectedRevision,
        )
        // The authenticated conflict is also an authoritative observation of
        // the current revision. Persist it with the review state so either
        // resolution path (retry or discard) leaves the next command based on
        // the revision the Gateway actually reported.
        commit(
            snapshot.copy(
                lastRevision = if (command.belongsTo(snapshot)) {
                    maxOf(snapshot.lastRevision, expectedRevision)
                } else {
                    snapshot.lastRevision
                },
                commands = replace(snapshot.commands, command, next),
            ),
        )
        return next.toView()
    }

    @Synchronized
    fun resolveRevisionConflict(commandId: String, action: RevisionConflictAction): CommandReceipt {
        val command = findCurrent(commandId)
            ?: throw IllegalArgumentException("Command $commandId is not available.")
        require(command.state == CommandState.NEEDS_REVIEW && command.expectedRevision != null) {
            "Command $commandId does not have a revision conflict."
        }
        val now = monotonicNow(command.updatedAt)
        val next = when (action) {
            RevisionConflictAction.RETRY -> command.copy(
                commandId = newUniqueId("commandId"),
                retiredCommandIds = command.retiredCommandIds + command.commandId,
                state = CommandState.QUEUED,
                updatedAt = now,
                baseRevision = command.expectedRevision,
                authenticationIssuedAt = null,
                authenticationNonce = null,
                revision = null,
                completion = null,
                expectedRevision = null,
            )

            RevisionConflictAction.DISCARD -> command.copy(
                state = CommandState.CANCELLED,
                updatedAt = now,
                revision = command.expectedRevision,
                completion = CommandCompletion(
                    commandId = command.commandId,
                    sequence = command.sequence,
                    revision = command.expectedRevision,
                    outcome = CommandOutcome.CANCELLED,
                    sessionId = command.sessionId,
                    error = PublicCommandError(
                        code = "revision_conflict_discarded",
                        message = "The command was discarded after a revision conflict.",
                        retryable = false,
                    ),
                ),
                expectedRevision = null,
            )
        }
        replaceAndCommit(command, next)
        return next.toView().toReceipt()
    }

    @Synchronized
    fun markCancelRequested(commandId: String): CommandView? {
        val command = findCurrent(commandId) ?: return null
        if (command.state.isTerminal || command.cancelRequested) return command.toView()
        val next = command.copy(
            cancelRequested = true,
            updatedAt = monotonicNow(command.updatedAt),
        )
        replaceAndCommit(command, next)
        return next.toView()
    }

    /**
     * Atomically binds the durable command cursor to authenticated Gateway
     * Room State. Sequence numbers are monotonic only inside one revision
     * epoch. A higher epoch generation therefore replaces, rather than
     * compares with, the previous cursor.
     *
     * A command that was not acknowledged in the retired epoch is assigned a
     * fresh command id, sequence, revision, nonce, and signature lease. The
     * stable operation/idempotency identity is retained so the Web layer sees
     * one logical action. Commands already accepted by the retired Gateway are
     * never replayed automatically.
     */
    @Synchronized
    internal fun reconcileGatewayScope(
        revisionEpoch: String,
        revisionEpochGeneration: Long,
        acknowledgedSequence: Long,
        revision: Long,
    ): GatewayCommandScopeReconciliation {
        requireOpaqueId(revisionEpoch, "revisionEpoch")
        requirePositiveJsonInteger(revisionEpochGeneration, "Revision epoch generation")
        requireNonnegativeJsonInteger(acknowledgedSequence, "Known Gateway command sequence")
        requireNonnegativeJsonInteger(revision, "Known Gateway revision")

        val previousEpoch = snapshot.revisionEpoch
        val previousGeneration = snapshot.revisionEpochGeneration
        if (previousEpoch != null && previousGeneration != null) {
            if (revisionEpochGeneration < previousGeneration) {
                return GatewayCommandScopeReconciliation(false, emptyList())
            }
            require(
                revisionEpochGeneration != previousGeneration || revisionEpoch == previousEpoch,
            ) { "Gateway revision epoch changed without advancing its generation." }
            require(
                revisionEpochGeneration == previousGeneration || revisionEpoch != previousEpoch,
            ) { "Gateway revision epoch generation advanced without changing its epoch." }
        }

        val scopeChanged = previousEpoch == null ||
            previousGeneration == null ||
            revisionEpochGeneration > previousGeneration
        if (!scopeChanged) {
            val commands = if (
                snapshot.commands.any { !it.state.isTerminal && it.state != CommandState.QUEUED }
            ) {
                snapshot.commands
            } else {
                snapshot.commands.map { command ->
                    if (command.state == CommandState.QUEUED && command.belongsTo(snapshot)) {
                        command.copy(baseRevision = revision)
                    } else {
                        command
                    }
                }
            }
            val next = snapshot.copy(
                lastAcknowledgedSequence = maxOf(
                    snapshot.lastAcknowledgedSequence,
                    acknowledgedSequence,
                ),
                lastRevision = maxOf(snapshot.lastRevision, revision),
                commands = commands,
            )
            if (next != snapshot) commit(next)
            return GatewayCommandScopeReconciliation(false, emptyList())
        }

        val migratable = snapshot.commands.filter { command ->
            !command.state.isTerminal &&
                command.state in MIGRATABLE_EPOCH_STATES &&
                !command.belongsTo(revisionEpoch, revisionEpochGeneration) &&
                // Schema 3 did not persist the epoch. If the authoritative
                // cursor already includes this sequence, the command was
                // accepted in the current Gateway scope: bind it in place so
                // exact recovery can retrieve the result. Only a sequence
                // beyond the authoritative cursor needs a fresh identity.
                (command.revisionEpoch != null || command.sequence > acknowledgedSequence)
        }
        require(migratable.size <= 1) {
            "More than one unacknowledged command cannot cross a Gateway revision epoch."
        }
        val allocatedIds = mutableSetOf<String>()
        val migrations = mutableListOf<CommandEpochMigration>()
        val commands = snapshot.commands.map { command ->
            when {
                command in migratable -> {
                    val currentCommandId = newUniqueId("commandId", allocatedIds).also(allocatedIds::add)
                    migrations += CommandEpochMigration(command.commandId, currentCommandId)
                    command.copy(
                        commandId = currentCommandId,
                        retiredCommandIds = command.retiredCommandIds + command.commandId,
                        state = CommandState.QUEUED,
                        updatedAt = monotonicNow(command.updatedAt),
                        sequence = Math.addExact(acknowledgedSequence, 1L),
                        baseRevision = revision,
                        revisionEpoch = revisionEpoch,
                        revisionEpochGeneration = revisionEpochGeneration,
                        authenticationIssuedAt = null,
                        authenticationNonce = null,
                        revision = null,
                        cancelRequested = false,
                        completion = null,
                        expectedRevision = null,
                    )
                }

                command.revisionEpoch == null && command.sequence <= acknowledgedSequence -> {
                    command.copy(
                        revisionEpoch = revisionEpoch,
                        revisionEpochGeneration = revisionEpochGeneration,
                    )
                }

                else -> command
            }
        }
        commit(
            snapshot.copy(
                lastAcknowledgedSequence = acknowledgedSequence,
                lastRevision = revision,
                revisionEpoch = revisionEpoch,
                revisionEpochGeneration = revisionEpochGeneration,
                commands = commands,
            ),
        )
        return GatewayCommandScopeReconciliation(true, migrations)
    }

    @Synchronized
    fun updateKnownRevision(
        revisionEpoch: String,
        revisionEpochGeneration: Long,
        revision: Long,
    ): Boolean {
        requireOpaqueId(revisionEpoch, "revisionEpoch")
        requirePositiveJsonInteger(revisionEpochGeneration, "Revision epoch generation")
        requireNonnegativeJsonInteger(revision, "Known Gateway revision")
        if (
            snapshot.revisionEpoch != revisionEpoch ||
            snapshot.revisionEpochGeneration != revisionEpochGeneration
        ) return false
        if (snapshot.commands.any { !it.state.isTerminal && it.state != CommandState.QUEUED }) {
            return false
        }
        val commands = snapshot.commands.map { command ->
            if (command.state == CommandState.QUEUED && command.belongsTo(snapshot)) {
                command.copy(baseRevision = revision)
            } else {
                command
            }
        }
        if (snapshot.lastRevision >= revision && commands == snapshot.commands) return false
        commit(snapshot.copy(lastRevision = maxOf(snapshot.lastRevision, revision), commands = commands))
        return true
    }

    @Synchronized
    fun get(commandId: String): CommandView? = findCurrent(commandId)?.toView()

    /**
     * Resolves the current durable command from either its active identity or
     * any identity retired during a Gateway revision-epoch migration. The
     * operation remains idempotent across that re-key, and callers recovering
     * a persisted UI marker must be rebound to the current command instead of
     * mistaking the retired ID for a command that never existed.
     */
    @Synchronized
    fun resolveCurrent(commandId: String): CommandView? = snapshot.commands
        .firstOrNull { command ->
            command.commandId == commandId || commandId in command.retiredCommandIds
        }
        ?.toView()

    @Synchronized
    fun operation(commandId: String): CommandOperation? =
        findCurrent(commandId)?.payload?.let(CommandPayloadValidator::validate)?.operation

    @Synchronized
    fun list(): List<CommandView> = snapshot.commands.map(PersistedCommand::toView)

    @Synchronized
    fun release(commandId: String): Boolean {
        val command = findCurrent(commandId) ?: return false
        require(command.state.isTerminal) { "Only completed commands can be released." }
        val tombstone = ReleasedCommandTombstone(
            operationId = command.operationId,
            commandId = command.commandId,
            retiredCommandIds = command.retiredCommandIds,
            idempotencyKey = command.idempotencyKey,
            requestFingerprint = command.requestFingerprint,
            releasedAt = nonnegativeNow(),
        )
        require(snapshot.released.size < MAX_RELEASED_TOMBSTONES) {
            "The released-command safety ledger is full; revoke this native account before clearing it."
        }
        commit(snapshot.copy(commands = snapshot.commands - command, released = snapshot.released + tombstone))
        return true
    }

    @Synchronized
    fun clear() {
        store.clear()
        snapshot = CommandOutboxSnapshot()
    }

    private fun findCurrent(commandId: String): PersistedCommand? =
        snapshot.commands.firstOrNull { it.commandId == commandId }

    private fun replaceAndCommit(before: PersistedCommand, after: PersistedCommand) {
        commit(snapshot.copy(commands = replace(snapshot.commands, before, after)))
    }

    private fun commit(next: CommandOutboxSnapshot) {
        store.save(next)
        snapshot = next
    }

    private fun nonnegativeNow(): Long = clock.now().also {
        requireNonnegativeJsonInteger(it, "Command clock timestamp")
    }

    private fun monotonicNow(previous: Long): Long = maxOf(nonnegativeNow(), previous)

    private fun newUniqueId(
        field: String,
        additionallyForbidden: Set<String> = emptySet(),
    ): String = idFactory.newId().also { candidate ->
        requireOpaqueId(candidate, field)
        require(
            candidate !in additionallyForbidden && snapshot.commands.none {
                it.operationId == candidate || it.commandId == candidate || candidate in it.retiredCommandIds
            } && snapshot.released.none {
                it.operationId == candidate || it.commandId == candidate || candidate in it.retiredCommandIds
            },
        ) { "$field collides with an existing durable identifier." }
    }

    companion object {
        private const val MAX_ACTIVE_COMMANDS = 128
        private const val MAX_RELEASED_TOMBSTONES = 4_096
        private val MIGRATABLE_EPOCH_STATES = setOf(
            CommandState.QUEUED,
            CommandState.TRANSMITTING,
            CommandState.RECOVERY_REQUIRED,
            CommandState.NEEDS_REVIEW,
        )

        internal fun encrypted(
            file: File,
            cipher: SecretCipher,
            accountScope: String,
            onMigration: (CommandOutboxMigration) -> Unit = {},
        ): DurableCommandOutbox = DurableCommandOutbox(
            EncryptedAtomicCommandOutboxStore(file, cipher, accountScope, onMigration),
        )
    }
}

private fun replace(
    commands: List<PersistedCommand>,
    before: PersistedCommand,
    after: PersistedCommand,
): List<PersistedCommand> = commands.map { if (it === before || it == before) after else it }

private fun PersistedCommand.toTransmission(recovery: Boolean) = CommandTransmission(
    operationId = operationId,
    commandId = commandId,
    idempotencyKey = idempotencyKey,
    sequence = sequence,
    baseRevision = baseRevision,
    revisionEpoch = revisionEpoch,
    revisionEpochGeneration = revisionEpochGeneration,
    issuedAt = authenticationIssuedAt
        ?: error("A transmission lease has no durable authentication timestamp."),
    nonce = authenticationNonce
        ?: error("A transmission lease has no durable authentication nonce."),
    payload = payload,
    recovery = recovery,
)

private fun PersistedCommand.belongsTo(snapshot: CommandOutboxSnapshot): Boolean =
    belongsTo(snapshot.revisionEpoch, snapshot.revisionEpochGeneration)

private fun PersistedCommand.belongsTo(epoch: String?, generation: Long?): Boolean =
    revisionEpoch == epoch && revisionEpochGeneration == generation

private fun requestFingerprint(payload: JsonObject, sessionId: String?): String {
    val canonical = JsonObject(
        buildMap {
            put("payload", canonicalize(payload))
            put("sessionId", sessionId?.let(::JsonPrimitive) ?: JsonNull)
        },
    ).toString().toByteArray(Charsets.UTF_8)
    return try {
        sha256Hex(canonical)
    } finally {
        canonical.fill(0)
    }
}

private fun authenticationNonce(commandId: String): String = sha256Hex(
    "codever.command.nonce.v1\u0000$commandId".toByteArray(Charsets.UTF_8),
)

private fun sha256Hex(value: ByteArray): String {
    val alphabet = "0123456789abcdef"
    val digest = MessageDigest.getInstance("SHA-256").digest(value)
    return try {
        buildString(digest.size * 2) {
            digest.forEach { byte ->
                val octet = byte.toInt() and 0xff
                append(alphabet[octet ushr 4])
                append(alphabet[octet and 0x0f])
            }
        }
    } finally {
        digest.fill(0)
    }
}

private fun canonicalize(value: JsonElement): JsonElement = when (value) {
    is JsonObject -> JsonObject(value.entries.sortedBy { it.key }.associate { (key, item) ->
        key to canonicalize(item)
    })
    is JsonArray -> JsonArray(value.map(::canonicalize))
    else -> value
}
