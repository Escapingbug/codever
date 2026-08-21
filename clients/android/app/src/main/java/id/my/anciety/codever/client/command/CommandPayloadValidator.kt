package id.my.anciety.codever.client.command

import id.my.anciety.codever.security.codever.PairingOperation
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

enum class CommandOperation(val wireName: String) {
    PROMPT("prompt"),
    CANCEL("cancel"),
    DECISION("decision"),
    SESSION_SETTINGS("session.settings"),
    SESSION_CREATE("session.create"),
    SESSION_ARCHIVE("session.archive"),
    SESSION_RESTORE("session.restore"),
    SESSION_DELETE("session.delete"),
    DEVICE_INVITE("device.invite"),
    ;

    companion object {
        fun fromWireName(value: String): CommandOperation = entries.firstOrNull { it.wireName == value }
            ?: throw IllegalArgumentException("Command operation is invalid.")
    }
}

sealed interface ValidatedCommandPayload {
    val operation: CommandOperation
    val sessionId: String?
}

data class EncryptedMediaPayload(
    val url: String,
    val key: String,
    val iv: String,
    val sha256: String,
    val size: Long,
) {
    override fun toString(): String =
        "EncryptedMediaPayload(url=<redacted>, key=<redacted>, iv=<redacted>, " +
            "sha256=<redacted>, size=$size)"
}

data class CommandAttachmentPayload(
    val id: String,
    val name: String,
    val mimeType: String,
    val size: Long,
    val sha256: String,
    val media: EncryptedMediaPayload,
) {
    override fun toString(): String =
        "CommandAttachmentPayload(id=$id, name=<redacted>, mimeType=$mimeType, size=$size, " +
            "sha256=<redacted>, media=$media)"
}

data class PromptCommandPayload(
    override val sessionId: String,
    val text: String,
    val attachments: List<CommandAttachmentPayload>,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.PROMPT

    override fun toString(): String =
        "PromptCommandPayload(sessionId=$sessionId, text=<redacted>, attachments=$attachments)"
}

data class CancelCommandPayload(
    override val sessionId: String,
    val targetCommandId: String?,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.CANCEL
}

data class DecisionCommandPayload(
    override val sessionId: String,
    val requestId: String,
    val decision: String,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.DECISION
}

enum class CommandPermissionMode(val wireName: String) {
    DEFAULT("default"),
    ACCEPT_EDITS("accept_edits"),
    PLAN("plan"),
    BYPASS_PERMISSIONS("bypass_permissions"),
    ;

    companion object {
        fun fromWireName(value: String): CommandPermissionMode = entries.firstOrNull { it.wireName == value }
            ?: throw IllegalArgumentException("Command permission mode is invalid.")
    }
}

data class SessionSettingsCommandPayload(
    override val sessionId: String,
    val model: String?,
    val provider: String?,
    val reasoningEffort: String?,
    val permissionMode: CommandPermissionMode?,
    val cwd: String?,
    val projectName: String?,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.SESSION_SETTINGS

    override fun toString(): String =
        "SessionSettingsCommandPayload(sessionId=$sessionId, model=$model, provider=$provider, " +
            "reasoningEffort=$reasoningEffort, permissionMode=$permissionMode, cwd=<redacted>, " +
            "projectName=<redacted>)"
}

data class SessionCreateCommandPayload(
    val cwd: String?,
    val projectName: String?,
    val provider: String?,
    val model: String?,
    val reasoningEffort: String?,
    val permissionMode: CommandPermissionMode?,
    val extensions: List<SessionExtensionBindingPayload>,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.SESSION_CREATE
    override val sessionId: String? = null

    override fun toString(): String =
        "SessionCreateCommandPayload(cwd=<redacted>, projectName=<redacted>, provider=$provider, " +
            "model=$model, reasoningEffort=$reasoningEffort, permissionMode=$permissionMode, " +
            "extensions=${extensions.map { it.id }})"
}

data class SessionExtensionBindingPayload(
    val id: String,
    val config: JsonObject?,
) {
    override fun toString(): String =
        "SessionExtensionBindingPayload(id=$id, config=<redacted>)"
}

data class SessionLifecycleCommandPayload(
    override val operation: CommandOperation,
    override val sessionId: String,
) : ValidatedCommandPayload {
    init {
        require(
            operation == CommandOperation.SESSION_ARCHIVE ||
                operation == CommandOperation.SESSION_RESTORE ||
                operation == CommandOperation.SESSION_DELETE,
        ) { "Session lifecycle operation is invalid." }
    }
}

data class DeviceInviteCommandPayload(
    val lifetimeMs: Long?,
) : ValidatedCommandPayload {
    override val operation = CommandOperation.DEVICE_INVITE
    override val sessionId: String? = null
}

object CommandPayloadValidator {
    const val MAX_ATTACHMENT_BYTES = 50L * 1024 * 1024
    const val MAX_ATTACHMENTS = 10
    const val MAX_PROMPT_ATTACHMENT_BYTES = 100L * 1024 * 1024

    fun validate(value: JsonObject): ValidatedCommandPayload {
        val operation = CommandOperation.fromWireName(value.requiredString("operation", 128))
        return when (operation) {
            CommandOperation.PROMPT -> validatePrompt(value)
            CommandOperation.CANCEL -> validateCancel(value)
            CommandOperation.DECISION -> validateDecision(value)
            CommandOperation.SESSION_SETTINGS -> validateSessionSettings(value)
            CommandOperation.SESSION_CREATE -> validateSessionCreate(value)
            CommandOperation.SESSION_ARCHIVE,
            CommandOperation.SESSION_RESTORE,
            CommandOperation.SESSION_DELETE,
            -> validateSessionLifecycle(value, operation)
            CommandOperation.DEVICE_INVITE -> validateDeviceInvite(value)
        }
    }

    private fun validatePrompt(value: JsonObject): PromptCommandPayload {
        value.requireExactKeys(
            required = setOf("operation", "sessionId", "text"),
            optional = setOf("attachments"),
        )
        val attachments = value.optionalArray("attachments")?.also {
            require(it.size <= MAX_ATTACHMENTS) { "Prompt contains too many attachments." }
        }?.map(::validateAttachment) ?: emptyList()
        val totalBytes = attachments.fold(0L) { total, attachment ->
            Math.addExact(total, attachment.size)
        }
        require(totalBytes <= MAX_PROMPT_ATTACHMENT_BYTES) {
            "Prompt attachments exceed $MAX_PROMPT_ATTACHMENT_BYTES bytes."
        }
        val text = value.requiredString("text", Int.MAX_VALUE, allowEmpty = true)
        require(text.isNotEmpty() || attachments.isNotEmpty()) {
            "A prompt requires text or at least one attachment."
        }
        return PromptCommandPayload(
            sessionId = value.requiredOpaqueId("sessionId"),
            text = text,
            attachments = attachments,
        )
    }

    private fun validateCancel(value: JsonObject): CancelCommandPayload {
        value.requireExactKeys(
            required = setOf("operation", "sessionId"),
            optional = setOf("targetCommandId"),
        )
        return CancelCommandPayload(
            sessionId = value.requiredOpaqueId("sessionId"),
            targetCommandId = value.optionalOpaqueId("targetCommandId"),
        )
    }

    private fun validateDecision(value: JsonObject): DecisionCommandPayload {
        value.requireExactKeys(setOf("operation", "sessionId", "requestId", "decision"))
        val decision = value.requiredString("decision", 32)
        require(ACTION_ID.matches(decision)) { "Command decision is invalid." }
        return DecisionCommandPayload(
            sessionId = value.requiredOpaqueId("sessionId"),
            requestId = value.requiredOpaqueId("requestId"),
            decision = decision,
        )
    }

    private fun validateSessionSettings(value: JsonObject): SessionSettingsCommandPayload {
        val settings = setOf("model", "provider", "reasoningEffort", "permissionMode", "cwd", "projectName")
        value.requireExactKeys(required = setOf("operation", "sessionId"), optional = settings)
        require(value.keys.any(settings::contains)) { "At least one session setting is required." }
        return SessionSettingsCommandPayload(
            sessionId = value.requiredOpaqueId("sessionId"),
            model = value.optionalBoundedString("model", 256),
            provider = value.optionalBoundedString("provider", 256),
            reasoningEffort = value.optionalBoundedString("reasoningEffort", 64),
            permissionMode = value.optionalString("permissionMode")?.let(CommandPermissionMode::fromWireName),
            cwd = value.optionalBoundedString("cwd", 4_096),
            projectName = value.optionalBoundedString("projectName", 256),
        )
    }

    private fun validateSessionCreate(value: JsonObject): SessionCreateCommandPayload {
        value.requireExactKeys(
            required = setOf("operation"),
            optional = setOf(
                "cwd",
                "projectName",
                "provider",
                "model",
                "reasoningEffort",
                "permissionMode",
                "extensions",
            ),
        )
        val extensions = value.optionalArray("extensions")?.also {
            require(it.size <= 8) { "Session contains too many extensions." }
        }?.map(::validateSessionExtension) ?: emptyList()
        require(extensions.map { it.id }.toSet().size == extensions.size) {
            "Session extension IDs must be unique."
        }
        return SessionCreateCommandPayload(
            cwd = value.optionalBoundedString("cwd", 4_096),
            projectName = value.optionalBoundedString("projectName", 256),
            provider = value.optionalBoundedString("provider", 256),
            model = value.optionalBoundedString("model", 256),
            reasoningEffort = value.optionalBoundedString("reasoningEffort", 64),
            permissionMode = value.optionalString("permissionMode")?.let(CommandPermissionMode::fromWireName),
            extensions = extensions,
        )
    }

    private fun validateSessionExtension(element: JsonElement): SessionExtensionBindingPayload {
        val value = element.asObject("Session extension binding")
        value.requireExactKeys(required = setOf("id"), optional = setOf("config"))
        val config = if ("config" in value) {
            value.getValue("config") as? JsonObject
                ?: throw IllegalArgumentException("Session extension config must be an object.")
        } else {
            null
        }
        if (config != null) {
            require(config.size <= 32) { "Session extension config has too many settings." }
            require(config.keys.all { it.isNotEmpty() && it.length <= 128 }) {
                "Session extension config setting ID is invalid."
            }
            require(config.toString().length <= 32 * 1024) {
                "Session extension config is too large."
            }
        }
        return SessionExtensionBindingPayload(
            id = value.requiredOpaqueId("id"),
            config = config,
        )
    }

    private fun validateSessionLifecycle(
        value: JsonObject,
        operation: CommandOperation,
    ): SessionLifecycleCommandPayload {
        value.requireExactKeys(setOf("operation", "sessionId"))
        return SessionLifecycleCommandPayload(operation, value.requiredOpaqueId("sessionId"))
    }

    private fun validateDeviceInvite(value: JsonObject): DeviceInviteCommandPayload {
        value.requireExactKeys(required = setOf("operation"), optional = setOf("lifetimeMs"))
        val lifetime = value.optionalLong("lifetimeMs")
        require(lifetime == null || lifetime in 30_000..600_000) {
            "Device invitation lifetime is invalid."
        }
        return DeviceInviteCommandPayload(lifetime)
    }

    private fun validateAttachment(element: JsonElement): CommandAttachmentPayload {
        val value = element.asObject("Command attachment")
        value.requireExactKeys(setOf("id", "name", "mimeType", "size", "sha256", "media"))
        val size = value.requiredLong("size")
        require(size in 0..MAX_ATTACHMENT_BYTES) { "Command attachment size is invalid." }
        return CommandAttachmentPayload(
            id = value.requiredOpaqueId("id"),
            name = value.requiredString("name", 1_024),
            mimeType = value.requiredString("mimeType", 256),
            size = size,
            sha256 = value.requiredBase64Url("sha256", 43),
            media = validateMedia(value.getValue("media")),
        )
    }

    private fun validateMedia(element: JsonElement): EncryptedMediaPayload {
        val value = element.asObject("Encrypted media")
        value.requireExactKeys(setOf("url", "key", "iv", "sha256", "size"))
        val size = value.requiredLong("size")
        require(size in 1..(MAX_ATTACHMENT_BYTES + 16)) { "Encrypted media size is invalid." }
        val url = value.requiredString("url", Int.MAX_VALUE)
        require(isMxcUrl(url)) { "Encrypted media URL is invalid." }
        return EncryptedMediaPayload(
            url = url,
            key = value.requiredBase64Url("key", 43),
            iv = value.requiredBase64Url("iv", 16),
            sha256 = value.requiredBase64Url("sha256", 43),
            size = size,
        )
    }

    private val BASE64_URL = Regex("^[A-Za-z0-9_-]+$")
    private val ACTION_ID = Regex("^[a-z][a-z0-9._-]*$")

    private fun isMxcUrl(value: String): Boolean {
        if (!value.startsWith("mxc://")) return false
        val body = value.removePrefix("mxc://")
        val separator = body.indexOf('/')
        if (separator <= 0 || separator == body.lastIndex || body.indexOf('/', separator + 1) >= 0) {
            return false
        }
        return body.none { it.isWhitespace() || Character.isSpaceChar(it) || it == '\uFEFF' }
    }

    private fun JsonObject.requireExactKeys(
        required: Set<String>,
        optional: Set<String> = emptySet(),
    ) {
        require(keys.containsAll(required) && keys.all { it in required || it in optional }) {
            "Command payload has missing or unexpected fields."
        }
    }

    private fun JsonObject.requiredOpaqueId(key: String): String = requiredString(key, 256)

    private fun JsonObject.optionalOpaqueId(key: String): String? =
        optionalBoundedString(key, 256)

    private fun JsonObject.requiredString(
        key: String,
        maxLength: Int,
        allowEmpty: Boolean = false,
    ): String {
        val primitive = get(key) as? JsonPrimitive
            ?: throw IllegalArgumentException("Command field $key is invalid.")
        require(primitive.isString) { "Command field $key must be a string." }
        val result = primitive.content
        require((allowEmpty || result.isNotEmpty()) && result.length <= maxLength) {
            "Command field $key has an invalid length."
        }
        return result
    }

    private fun JsonObject.optionalString(key: String): String? {
        if (key !in this) return null
        return requiredString(key, Int.MAX_VALUE, allowEmpty = true)
    }

    private fun JsonObject.optionalBoundedString(key: String, maxLength: Int): String? {
        if (key !in this) return null
        return requiredString(key, maxLength)
    }

    private fun JsonObject.requiredLong(key: String): Long {
        val primitive = get(key) as? JsonPrimitive
            ?: throw IllegalArgumentException("Command field $key is invalid.")
        require(!primitive.isString) { "Command field $key must be a number." }
        return primitive.longOrNull
            ?: throw IllegalArgumentException("Command field $key must be an integer.")
    }

    private fun JsonObject.optionalLong(key: String): Long? =
        if (key in this) requiredLong(key) else null

    private fun JsonObject.optionalArray(key: String): List<JsonElement>? {
        if (key !in this) return null
        return runCatching { getValue(key) as kotlinx.serialization.json.JsonArray }.getOrElse {
            throw IllegalArgumentException("Command field $key must be an array.")
        }
    }

    private fun JsonObject.requiredBase64Url(key: String, length: Int): String =
        requiredString(key, length).also {
            require(it.length == length && BASE64_URL.matches(it)) { "Command field $key is invalid." }
        }

    private fun JsonElement.asObject(label: String): JsonObject = this as? JsonObject
        ?: throw IllegalArgumentException("$label must be an object.")
}

enum class CommandAuthorizationSource {
    CERTIFICATE_GRANT,
    DENIED,
}

data class CommandAuthorizationDecision(
    val authorized: Boolean,
    val source: CommandAuthorizationSource,
)

object CommandAuthorizationPolicy {
    /**
     * Evaluates command authority after certificate signature, binding,
     * status, and expiry have already been verified by the pairing layer.
     */
    fun evaluate(
        operation: CommandOperation,
        certificateGrants: Collection<PairingOperation>,
    ): CommandAuthorizationDecision {
        val granted = certificateGrants.any { grant -> grant.wireName == operation.wireName }
        return if (granted) {
            CommandAuthorizationDecision(true, CommandAuthorizationSource.CERTIFICATE_GRANT)
        } else {
            CommandAuthorizationDecision(false, CommandAuthorizationSource.DENIED)
        }
    }

    fun requireAuthorized(
        payload: ValidatedCommandPayload,
        certificateGrants: Collection<PairingOperation>,
    ) {
        val decision = evaluate(payload.operation, certificateGrants)
        require(decision.authorized) {
            "The pairing certificate does not authorize ${payload.operation.wireName}."
        }
    }
}
