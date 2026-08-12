package id.my.anciety.codever.client.command

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

internal object CommandOutboxCodec {
    private const val LEGACY_SCHEMA_VERSION = 1
    private const val SCHEMA_VERSION = 2
    private const val MAX_PLAINTEXT_BYTES = 3 * 1024 * 1024
    private const val MAX_COMMANDS = 128
    private const val MAX_TOMBSTONES = 4_096
    private val json = Json { explicitNulls = true }

    fun encode(value: CommandOutboxSnapshot): ByteArray {
        validateSnapshot(value)
        val encoded = buildJsonObject {
            put("schemaVersion", SCHEMA_VERSION)
            put("lastAcknowledgedSequence", value.lastAcknowledgedSequence)
            put("lastRevision", value.lastRevision)
            put("commands", buildJsonArray { value.commands.forEach { add(encodeCommand(it)) } })
            put("released", buildJsonArray { value.released.forEach { add(encodeTombstone(it)) } })
        }.toString().toByteArray(Charsets.UTF_8)
        require(encoded.size <= MAX_PLAINTEXT_BYTES) { "Command outbox is too large." }
        return encoded
    }

    fun decode(bytes: ByteArray): CommandOutboxSnapshot {
        require(bytes.size <= MAX_PLAINTEXT_BYTES) { "Command outbox is too large." }
        val root = json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
        root.requireExactKeys(
            setOf(
                "schemaVersion",
                "lastAcknowledgedSequence",
                "lastRevision",
                "commands",
                "released",
            ),
        )
        val schemaVersion = root.requiredLong("schemaVersion")
        require(schemaVersion in LEGACY_SCHEMA_VERSION.toLong()..SCHEMA_VERSION.toLong()) {
            "Command outbox schema is unsupported."
        }
        val commands = root.requiredArray("commands").also {
            require(it.size <= MAX_COMMANDS) { "Command outbox contains too many commands." }
        }.map { decodeCommand(it.jsonObject, schemaVersion.toInt()) }
        val released = root.requiredArray("released").also {
            require(it.size <= MAX_TOMBSTONES) { "Command outbox contains too many tombstones." }
        }.map { decodeTombstone(it.jsonObject) }
        val snapshot = CommandOutboxSnapshot(
            lastAcknowledgedSequence = root.requiredLong("lastAcknowledgedSequence"),
            lastRevision = root.requiredLong("lastRevision"),
            commands = commands,
            released = released,
        )
        validateSnapshot(snapshot)
        return snapshot
    }

    private fun encodeCommand(value: PersistedCommand): JsonObject = buildJsonObject {
        put("operationId", value.operationId)
        put("commandId", value.commandId)
        put("retiredCommandIds", buildJsonArray {
            value.retiredCommandIds.forEach { add(JsonPrimitive(it)) }
        })
        put("idempotencyKey", value.idempotencyKey)
        put("requestFingerprint", value.requestFingerprint)
        put("state", value.state.wireName)
        put("submittedAt", value.submittedAt)
        put("updatedAt", value.updatedAt)
        putNullableString("sessionId", value.sessionId)
        put("sequence", value.sequence)
        put("baseRevision", value.baseRevision)
        putNullableLong("authenticationIssuedAt", value.authenticationIssuedAt)
        putNullableString("authenticationNonce", value.authenticationNonce)
        putNullableLong("revision", value.revision)
        put("cancelRequested", value.cancelRequested)
        put("completion", value.completion?.let(::encodeCompletion) ?: JsonNull)
        putNullableLong("expectedRevision", value.expectedRevision)
        put("payload", value.payload)
    }

    private fun decodeCommand(value: JsonObject, schemaVersion: Int): PersistedCommand {
        val keys = setOf(
            "operationId",
            "commandId",
            "retiredCommandIds",
            "idempotencyKey",
            "requestFingerprint",
            "state",
            "submittedAt",
            "updatedAt",
            "sessionId",
            "sequence",
            "baseRevision",
            "revision",
            "cancelRequested",
            "completion",
            "expectedRevision",
            "payload",
        ) + if (schemaVersion >= SCHEMA_VERSION) {
            setOf("authenticationIssuedAt", "authenticationNonce")
        } else {
            emptySet()
        }
        value.requireExactKeys(
            keys,
        )
        return PersistedCommand(
            operationId = value.requiredString("operationId"),
            commandId = value.requiredString("commandId"),
            retiredCommandIds = value.requiredArray("retiredCommandIds").map { it.requiredStringValue() },
            idempotencyKey = value.requiredString("idempotencyKey"),
            requestFingerprint = value.requiredString("requestFingerprint"),
            state = CommandState.fromWireName(value.requiredString("state")),
            submittedAt = value.requiredLong("submittedAt"),
            updatedAt = value.requiredLong("updatedAt"),
            sessionId = value.optionalString("sessionId"),
            sequence = value.requiredLong("sequence"),
            baseRevision = value.requiredLong("baseRevision"),
            authenticationIssuedAt = if (schemaVersion >= SCHEMA_VERSION) {
                value.optionalLong("authenticationIssuedAt")
            } else {
                null
            },
            authenticationNonce = if (schemaVersion >= SCHEMA_VERSION) {
                value.optionalString("authenticationNonce")
            } else {
                null
            },
            revision = value.optionalLong("revision"),
            cancelRequested = value.requiredBoolean("cancelRequested"),
            completion = value.optionalObject("completion")?.let(::decodeCompletion),
            expectedRevision = value.optionalLong("expectedRevision"),
            payload = value.getValue("payload").jsonObject,
        )
    }

    private fun encodeCompletion(value: CommandCompletion): JsonObject = buildJsonObject {
        put("commandId", value.commandId)
        put("sequence", value.sequence)
        put("revision", value.revision)
        put("outcome", value.outcome.wireName)
        putNullableString("sessionId", value.sessionId)
        put("result", value.result ?: JsonNull)
        put("error", value.error?.let(::encodeError) ?: JsonNull)
    }

    private fun decodeCompletion(value: JsonObject): CommandCompletion {
        value.requireExactKeys(
            setOf("commandId", "sequence", "revision", "outcome", "sessionId", "result", "error"),
        )
        return CommandCompletion(
            commandId = value.requiredString("commandId"),
            sequence = value.requiredLong("sequence"),
            revision = value.requiredLong("revision"),
            outcome = CommandOutcome.fromWireName(value.requiredString("outcome")),
            sessionId = value.optionalString("sessionId"),
            result = value.getValue("result").takeUnless { it is JsonNull },
            error = value.optionalObject("error")?.let(::decodeError),
        )
    }

    private fun encodeError(value: PublicCommandError): JsonObject = buildJsonObject {
        put("code", value.code)
        put("message", value.message)
        put("retryable", value.retryable)
    }

    private fun decodeError(value: JsonObject): PublicCommandError {
        value.requireExactKeys(setOf("code", "message", "retryable"))
        return PublicCommandError(
            code = value.requiredString("code"),
            message = value.requiredString("message", allowEmpty = true),
            retryable = value.requiredBoolean("retryable"),
        )
    }

    private fun encodeTombstone(value: ReleasedCommandTombstone): JsonObject = buildJsonObject {
        put("operationId", value.operationId)
        put("commandId", value.commandId)
        put("idempotencyKey", value.idempotencyKey)
        put("requestFingerprint", value.requestFingerprint)
        put("releasedAt", value.releasedAt)
    }

    private fun decodeTombstone(value: JsonObject): ReleasedCommandTombstone {
        value.requireExactKeys(
            setOf("operationId", "commandId", "idempotencyKey", "requestFingerprint", "releasedAt"),
        )
        return ReleasedCommandTombstone(
            operationId = value.requiredString("operationId"),
            commandId = value.requiredString("commandId"),
            idempotencyKey = value.requiredString("idempotencyKey"),
            requestFingerprint = value.requiredString("requestFingerprint"),
            releasedAt = value.requiredLong("releasedAt"),
        )
    }

    private fun validateSnapshot(value: CommandOutboxSnapshot) {
        requireNonnegativeJsonInteger(value.lastAcknowledgedSequence, "Last acknowledged sequence")
        requireNonnegativeJsonInteger(value.lastRevision, "Last revision")
        require(value.commands.size <= MAX_COMMANDS && value.released.size <= MAX_TOMBSTONES) {
            "Command outbox capacity is exceeded."
        }
        require(value.commands.map { it.commandId }.distinct().size == value.commands.size) {
            "Command outbox contains duplicate command ids."
        }
        require(value.commands.map { it.idempotencyKey }.distinct().size == value.commands.size) {
            "Command outbox contains duplicate idempotency keys."
        }
        val durableIds = buildList {
            value.commands.forEach {
                add(it.operationId)
                add(it.commandId)
                addAll(it.retiredCommandIds)
            }
            value.released.forEach {
                add(it.operationId)
                add(it.commandId)
            }
        }
        require(durableIds.distinct().size == durableIds.size) {
            "Command outbox contains duplicate durable identifiers."
        }
        require(value.released.map { it.idempotencyKey }.distinct().size == value.released.size) {
            "Command outbox contains duplicate released idempotency keys."
        }
        require(value.commands.none { command -> value.released.any { it.idempotencyKey == command.idempotencyKey } }) {
            "Active and released commands overlap."
        }
        value.commands.forEach(::validateCommand)
        value.released.forEach {
            requireOpaqueId(it.operationId, "operationId")
            requireOpaqueId(it.commandId, "commandId")
            requireUuid(it.idempotencyKey)
            requireFingerprint(it.requestFingerprint)
            requireNonnegativeJsonInteger(it.releasedAt, "Released command timestamp")
        }
        val unacknowledged = value.commands.filter { it.sequence > value.lastAcknowledgedSequence }
        require(unacknowledged.map { it.sequence }.distinct().size <= 1) {
            "Command outbox contains more than one unacknowledged sequence."
        }
    }

    private fun validateCommand(value: PersistedCommand) {
        requireOpaqueId(value.operationId, "operationId")
        requireOpaqueId(value.commandId, "commandId")
        value.retiredCommandIds.forEach { requireOpaqueId(it, "retiredCommandId") }
        require(value.commandId !in value.retiredCommandIds && value.retiredCommandIds.distinct().size == value.retiredCommandIds.size) {
            "Retired command ids are invalid."
        }
        requireUuid(value.idempotencyKey)
        requireFingerprint(value.requestFingerprint)
        requireNonnegativeJsonInteger(value.submittedAt, "Command submitted timestamp")
        requireNonnegativeJsonInteger(value.updatedAt, "Command updated timestamp")
        require(value.updatedAt >= value.submittedAt) { "Command timestamps are invalid." }
        requirePositiveJsonInteger(value.sequence, "Command sequence")
        requireNonnegativeJsonInteger(value.baseRevision, "Command base revision")
        value.authenticationIssuedAt?.let {
            requireNonnegativeJsonInteger(it, "Command authentication timestamp")
        }
        value.authenticationNonce?.let {
            require(it.length in 16..256 && !it.any(Char::isISOControl)) {
                "Command authentication nonce is invalid."
            }
        }
        require((value.authenticationIssuedAt == null) == (value.authenticationNonce == null)) {
            "Command authentication metadata is incomplete."
        }
        value.revision?.let { requireNonnegativeJsonInteger(it, "Command revision") }
        value.expectedRevision?.let { requireNonnegativeJsonInteger(it, "Expected command revision") }
        require(value.payload.toString().toByteArray(Charsets.UTF_8).size <= MAX_PAYLOAD_BYTES) {
            "Command payload is too large."
        }
        require(value.payload["operation"]?.jsonPrimitive?.contentOrNull?.isNotBlank() == true) {
            "Command payload operation is invalid."
        }
        val view = value.toView()
        require(view.state == value.state)
        require((value.state == CommandState.NEEDS_REVIEW) == (value.expectedRevision != null)) {
            "Revision conflict metadata is inconsistent."
        }
    }

    private fun requireFingerprint(value: String) {
        require(value.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' }) {
            "Command request fingerprint is invalid."
        }
    }

    private fun JsonObject.requireExactKeys(expected: Set<String>) {
        require(keys == expected) { "Command outbox shape is invalid." }
    }

    private fun JsonObject.requiredArray(key: String): JsonArray = get(key)?.let {
        runCatching { it.jsonArray }.getOrNull()
    } ?: throw IllegalArgumentException("Command outbox field $key is invalid.")

    private fun JsonObject.requiredLong(key: String): Long {
        val primitive = get(key)?.jsonPrimitive
            ?: throw IllegalArgumentException("Command outbox field $key is invalid.")
        if (primitive.isString) throw IllegalArgumentException("Command outbox field $key is invalid.")
        return primitive.longOrNull
            ?: throw IllegalArgumentException("Command outbox field $key is invalid.")
    }

    private fun JsonObject.optionalLong(key: String): Long? {
        val element = get(key)
            ?: throw IllegalArgumentException("Command outbox field $key is missing.")
        if (element is JsonNull) return null
        val primitive = element.jsonPrimitive
        if (primitive.isString) throw IllegalArgumentException("Command outbox field $key is invalid.")
        return primitive.longOrNull
            ?: throw IllegalArgumentException("Command outbox field $key is invalid.")
    }

    private fun JsonObject.requiredString(key: String, allowEmpty: Boolean = false): String =
        get(key)?.requiredStringValue()?.takeIf { (allowEmpty || it.isNotEmpty()) && it.length <= 4_096 }
            ?: throw IllegalArgumentException("Command outbox field $key is invalid.")

    private fun JsonElement.requiredStringValue(): String = runCatching {
        jsonPrimitive.takeIf { it.isString }?.contentOrNull
    }.getOrNull() ?: throw IllegalArgumentException("Command outbox string is invalid.")

    private fun JsonObject.optionalString(key: String): String? {
        val element = get(key)
            ?: throw IllegalArgumentException("Command outbox field $key is missing.")
        return if (element is JsonNull) null else element.requiredStringValue()
    }

    private fun JsonObject.requiredBoolean(key: String): Boolean {
        val primitive = get(key)?.jsonPrimitive
            ?: throw IllegalArgumentException("Command outbox field $key is invalid.")
        if (primitive.isString) throw IllegalArgumentException("Command outbox field $key is invalid.")
        return primitive.booleanOrNull
            ?: throw IllegalArgumentException("Command outbox field $key is invalid.")
    }

    private fun JsonObject.optionalObject(key: String): JsonObject? {
        val element = get(key)
            ?: throw IllegalArgumentException("Command outbox field $key is missing.")
        if (element is JsonNull) return null
        return runCatching { element.jsonObject }.getOrNull()
            ?: throw IllegalArgumentException("Command outbox field $key is invalid.")
    }

    private fun kotlinx.serialization.json.JsonObjectBuilder.putNullableString(key: String, value: String?) {
        put(key, value?.let(::JsonPrimitive) ?: JsonNull)
    }

    private fun kotlinx.serialization.json.JsonObjectBuilder.putNullableLong(key: String, value: Long?) {
        put(key, value?.let(::JsonPrimitive) ?: JsonNull)
    }
}

internal fun PersistedCommand.toView() = CommandView(
    operationId = operationId,
    commandId = commandId,
    idempotencyKey = idempotencyKey,
    state = state,
    submittedAt = submittedAt,
    updatedAt = updatedAt,
    sessionId = sessionId,
    sequence = sequence,
    revision = revision,
    cancelRequested = cancelRequested,
    completion = completion,
)
