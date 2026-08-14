package id.my.anciety.codever.client.events

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

enum class ClientEventType(val wireValue: String) {
    STATUS_CHANGED("client.status.changed"),
    TRUST_CHANGED("trust.changed"),
    GATEWAY_STATE_CHANGED("gateway.state.changed"),
    MESSAGE_UPSERTED("message.upserted"),
    MESSAGE_REMOVED("message.removed"),
    COMMAND_CHANGED("command.changed"),
    ATTACHMENT_CHANGED("attachment.changed"),
    PAIRING_CHANGED("pairing.changed");

    companion object {
        fun fromWire(value: String): ClientEventType = entries.singleOrNull { it.wireValue == value }
            ?: throw IllegalArgumentException("Unknown client event type.")
    }
}

data class ClientEvent(
    val schemaVersion: Int = 1,
    val eventId: String,
    val cursor: String,
    val occurredAt: Long,
    val type: ClientEventType,
    val payload: JsonElement,
) {
    init {
        require(schemaVersion == 1)
        requireOpaqueId(eventId, "eventId")
        requireOpaqueId(cursor, "cursor")
        require(occurredAt >= 0)
        requireWireBytes("ClientEvent", MAX_BRIDGE_EVENT_BYTES) {
            PublicClientJson.encodeEvent(this)
        }
    }
}

enum class ClientMessageKind(val wireValue: String) {
    NOTICE("notice"),
    USER("user"),
    AGENT("agent"),
    TOOL("tool"),
    PERMISSION("permission"),
    ERROR("error");

    companion object {
        fun fromWire(value: String): ClientMessageKind = entries.singleOrNull { it.wireValue == value }
            ?: throw IllegalArgumentException("Unknown client message kind.")
    }
}

enum class ClientMessageFormat(val wireValue: String) {
    PLAIN("plain"),
    MARKDOWN("markdown"),
    HTML("html");

    companion object {
        fun fromWire(value: String): ClientMessageFormat = entries.singleOrNull { it.wireValue == value }
            ?: throw IllegalArgumentException("Unknown client message format.")
    }
}

/**
 * Public, already-authenticated Codever message. It deliberately cannot carry
 * a raw Matrix event or any Matrix session secret.
 */
data class ClientMessage(
    val eventId: String,
    val sender: String,
    val timestamp: Long,
    val encrypted: Boolean,
    val kind: ClientMessageKind,
    val format: ClientMessageFormat,
    val text: String? = null,
    val sessionId: String? = null,
    val historical: Boolean? = null,
    val operationId: String? = null,
    val requestId: String? = null,
    val replacesEventId: String? = null,
    val commandId: String? = null,
    val revision: Long? = null,
    val originDeviceId: String? = null,
    val originDeviceName: String? = null,
    val activeDeviceCount: Int? = null,
    val attachments: List<CodeverAttachment>? = null,
    val toolGroup: ToolGroupPresentation? = null,
    val semantic: JsonObject? = null,
) {
    init {
        requireOpaqueId(eventId, "eventId")
        requireOpaqueId(sender, "sender")
        require(timestamp >= 0)
        require(text == null || text.length <= 2_000_000)
        optionalOpaqueId(sessionId, "sessionId")
        optionalOpaqueId(operationId, "operationId")
        optionalOpaqueId(requestId, "requestId")
        optionalOpaqueId(replacesEventId, "replacesEventId")
        optionalOpaqueId(commandId, "commandId")
        optionalOpaqueId(originDeviceId, "originDeviceId")
        require(originDeviceName == null || originDeviceName.length in 1..256)
        require(revision == null || revision >= 0)
        require(activeDeviceCount == null || activeDeviceCount > 0)
        require(attachments == null || attachments.size <= 10)
        require((kind == ClientMessageKind.TOOL) == (toolGroup != null)) {
            "toolGroup must be present only for tool messages."
        }
        requireWireBytes("ClientMessage", MAX_BRIDGE_EVENT_PAYLOAD_BYTES) {
            PublicClientJson.encodeMessage(this)
        }
    }
}

data class EncryptedMedia(
    val url: String,
    val key: String,
    val iv: String,
    val sha256: String,
    val size: Long,
) {
    init {
        require(MXC_URL.matches(url))
        require(key.length in 1..128 && iv.length in 1..128)
        requireBase64UrlSha256(sha256, "media.sha256")
        require(size > 0)
    }
}

data class CodeverAttachment(
    val id: String,
    val name: String,
    val mimeType: String,
    val size: Long,
    val sha256: String,
    val media: EncryptedMedia,
) {
    init {
        requireOpaqueId(id, "attachment.id")
        require(name.length in 1..1_024 && mimeType.length in 1..256)
        require(size in 0..MAX_ATTACHMENT_BYTES)
        requireBase64UrlSha256(sha256, "attachment.sha256")
    }
}

enum class ToolCategory(val wireValue: String) {
    READ("read"), EDIT("edit"), WRITE("write"), EXECUTE("execute"), SEARCH("search"),
    AGENT("agent"), UNKNOWN("unknown");

    companion object {
        fun fromWire(value: String): ToolCategory = entries.singleOrNull { it.wireValue == value }
            ?: throw IllegalArgumentException("Unknown tool category.")
    }
}

enum class ToolPhase(val wireValue: String) {
    STARTED("started"), UPDATED("updated"), COMPLETED("completed"), FAILED("failed");

    companion object {
        fun fromWire(value: String): ToolPhase = entries.singleOrNull { it.wireValue == value }
            ?: throw IllegalArgumentException("Unknown tool phase.")
    }
}

data class ToolPresentationItem(
    val id: String,
    val name: String,
    val title: String,
    val category: ToolCategory,
    val phase: ToolPhase,
    val isError: Boolean,
    val startedAt: Long,
    val updatedAt: Long,
    val detail: String? = null,
    val result: String? = null,
) {
    init {
        requireOpaqueId(id, "tool.id")
        require(name.length in 1..512 && title.length in 1..512)
        require(detail == null || detail.length <= 4_096)
        require(result == null || result.length <= 64 * 1_024)
        require(startedAt >= 0 && updatedAt >= 0)
    }
}

data class ToolGroupPresentation(
    val kind: String = "tool_group",
    val version: Int = 1,
    val groupId: String,
    val tools: List<ToolPresentationItem>,
) {
    init {
        require(kind == "tool_group" && version == 1)
        requireOpaqueId(groupId, "toolGroup.groupId")
        require(tools.size <= 200)
    }
}

enum class LifecyclePhase(val wireValue: String) {
    STOPPED("stopped"),
    STARTING("starting"),
    UNPAIRED("unpaired"),
    CONNECTING("connecting"),
    SECURING("securing"),
    READY("ready"),
    RECONNECTING("reconnecting"),
    OFFLINE("offline"),
    BLOCKED("blocked");

    companion object {
        fun fromWire(value: String): LifecyclePhase = entries.singleOrNull { it.wireValue == value }
            ?: throw IllegalArgumentException("Unknown lifecycle phase.")
    }
}

data class ClientLifecycle(
    val phase: LifecyclePhase,
    val since: Long,
    val detailCode: String? = null,
) {
    init {
        require(since >= 0)
        require(detailCode == null || detailCode.length in 1..128)
    }
}

data class ForegroundServiceState(
    val required: Boolean = true,
    val active: Boolean,
    val notificationVisible: Boolean,
) {
    init {
        require(required) { "The Android native runtime always requires its foreground service." }
    }
}

enum class CommandState(val wireValue: String) {
    QUEUED("queued"), TRANSMITTING("transmitting"), ACCEPTED("accepted"), RUNNING("running"),
    NEEDS_REVIEW("needs_review"), RECOVERY_REQUIRED("recovery_required"), SUCCEEDED("succeeded"),
    FAILED("failed"), CANCELLED("cancelled");

    companion object {
        fun fromWire(value: String): CommandState = entries.singleOrNull { it.wireValue == value }
            ?: throw IllegalArgumentException("Unknown command state.")
    }
}

enum class CommandOutcome(val wireValue: String) {
    SUCCEEDED("succeeded"), FAILED("failed"), CANCELLED("cancelled");

    companion object {
        fun fromWire(value: String): CommandOutcome = entries.singleOrNull { it.wireValue == value }
            ?: throw IllegalArgumentException("Unknown command outcome.")
    }
}

data class PublicCommandError(
    val code: String,
    val message: String,
    val retryable: Boolean,
) {
    init {
        require(code.length in 1..128 && message.length in 1..2_048)
    }
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
        require(sequence > 0 && revision >= 0)
        optionalOpaqueId(sessionId, "sessionId")
        requireWireBytes("CommandCompletion", MAX_BRIDGE_EVENT_PAYLOAD_BYTES) {
            PublicClientJson.encodeCommandCompletion(this)
        }
    }
}

data class CommandView(
    val operationId: String,
    val idempotencyKey: String,
    val state: CommandState,
    val submittedAt: Long,
    val updatedAt: Long,
    val commandId: String? = null,
    val sessionId: String? = null,
    val sequence: Long? = null,
    val revision: Long? = null,
    val cancelRequested: Boolean? = null,
    val completion: CommandCompletion? = null,
) {
    init {
        requireOpaqueId(operationId, "operationId")
        require(UUID.matches(idempotencyKey)) { "idempotencyKey is invalid." }
        optionalOpaqueId(commandId, "commandId")
        optionalOpaqueId(sessionId, "sessionId")
        require(submittedAt >= 0 && updatedAt >= 0)
        require(sequence == null || sequence > 0)
        require(revision == null || revision >= 0)
        requireWireBytes("CommandView", MAX_BRIDGE_EVENT_PAYLOAD_BYTES) {
            PublicClientJson.encodeCommand(this)
        }
    }
}

sealed interface PublicTrustState {
    data object Unpaired : PublicTrustState

    data class Pairing(val pairingId: String, val expiresAt: Long) : PublicTrustState {
        init {
            requireOpaqueId(pairingId, "pairingId")
            require(expiresAt >= 0)
        }
    }

    data class Trusted(
        val gatewayId: String,
        val gatewayName: String,
        val certificateId: String,
        val pairedAt: Long,
        val activeDeviceCount: Int? = null,
    ) : PublicTrustState {
        init {
            requireOpaqueId(gatewayId, "gatewayId")
            require(gatewayName.length in 1..256)
            requireOpaqueId(certificateId, "certificateId")
            require(pairedAt >= 0)
            require(activeDeviceCount == null || activeDeviceCount > 0)
        }
    }

    data class Blocked(val reasonCode: String) : PublicTrustState {
        init {
            require(reasonCode.length in 1..128)
        }
    }
}

/**
 * Strict public snapshot. Command/pairing/gateway payloads are public semantic
 * JSON DTOs; no Matrix access token, device keys, or raw event is accepted by
 * the typed message/event surface.
 */
data class ClientSnapshot(
    val schemaVersion: Int = 1,
    val deviceId: String,
    val cursor: String,
    val generatedAt: Long,
    val lifecycle: ClientLifecycle,
    val foregroundService: ForegroundServiceState,
    val trust: PublicTrustState,
    val gatewayState: JsonObject? = null,
    val commands: List<CommandView> = emptyList(),
    val pairing: JsonObject? = null,
) {
    init {
        require(schemaVersion == 1)
        requireOpaqueId(deviceId, "deviceId")
        requireOpaqueId(cursor, "cursor")
        require(generatedAt >= 0)
        require(commands.size <= 1_000)
        requireWireBytes("ClientSnapshot", MAX_BRIDGE_RPC_BYTES) {
            PublicClientJson.encodeSnapshot(this)
        }
    }
}

internal fun requireOpaqueId(value: String, label: String) {
    require(value.length in 1..512 && value.none(Char::isWhitespace)) { "$label is invalid." }
}

private fun optionalOpaqueId(value: String?, label: String) {
    if (value != null) requireOpaqueId(value, label)
}

private fun requireBase64UrlSha256(value: String, label: String) {
    require(BASE64_URL_SHA256.matches(value)) { "$label is invalid." }
}

private inline fun requireWireBytes(
    label: String,
    maxBytes: Int,
    encoded: () -> JsonElement,
) {
    val size = encoded().toString().toByteArray(Charsets.UTF_8).size
    require(size <= maxBytes) { "$label exceeds the native bridge UTF-8 byte limit." }
}

private val BASE64_URL_SHA256 = Regex("^[A-Za-z0-9_-]{43}$")
private val MXC_URL = Regex("^mxc://[^/\\s]+/[^/\\s]+$")
private val UUID = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")
private const val MAX_ATTACHMENT_BYTES = 50L * 1024 * 1024
internal const val MAX_BRIDGE_EVENT_BYTES = 256 * 1024
internal const val MAX_BRIDGE_EVENT_PAYLOAD_BYTES = MAX_BRIDGE_EVENT_BYTES - 4 * 1024
internal const val MAX_BRIDGE_RPC_BYTES = 480 * 1024
