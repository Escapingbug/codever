package id.my.anciety.codever.e2e

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.AtomicFile
import id.my.anciety.codever.BuildConfig
import id.my.anciety.codever.client.NativeRuntimeFiles
import id.my.anciety.codever.client.command.DurableCommandOutbox
import id.my.anciety.codever.security.AndroidKeystoreSecretCipher
import id.my.anciety.codever.security.SecretEnvelope
import id.my.anciety.codever.security.codever.AndroidKeystoreP256Identity
import java.security.MessageDigest
import java.util.UUID
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put

/**
 * Seeds encrypted outbox states that cannot be created deterministically from UI automation.
 *
 * This receiver only exists in the separately signed `.e2e` package. Keeping
 * the fixture on-device exercises the production Android Keystore key,
 * associated data, AtomicFile, process restart, and cover-install boundaries.
 */
class LegacyOutboxSeederReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        check(BuildConfig.ALLOW_INSECURE_E2E_LOOPBACK) {
            "The legacy outbox fixture is available only in E2E builds."
        }
        val runId = requireNotNull(intent.getStringExtra(EXTRA_RUN_ID)) {
            "The legacy outbox fixture requires a run id."
        }.also {
            require(it.length in 1..256 && !it.any(Char::isISOControl))
        }
        val deviceId = AndroidKeystoreP256Identity().publicIdentity.keyId
        val commandsFile = NativeRuntimeFiles(context, deviceId).commands
        val atomicFile = AtomicFile(commandsFile)
        check(atomicFile.baseFile.exists()) { "The current encrypted outbox is missing." }
        val cipher = AndroidKeystoreSecretCipher()
        if (intent.getStringExtra(EXTRA_MODE) == MODE_CURRENT_QUEUED) {
            val cwd = requireNotNull(intent.getStringExtra(EXTRA_CWD)) {
                "The queued outbox fixture requires a cwd."
            }
            val projectName = requireNotNull(intent.getStringExtra(EXTRA_PROJECT_NAME)) {
                "The queued outbox fixture requires a project name."
            }
            val outbox = DurableCommandOutbox.encrypted(commandsFile, cipher, deviceId)
            val receipt = outbox.enqueue(
                UUID.nameUUIDFromBytes("queued:$runId".toByteArray()).toString(),
                buildJsonObject {
                    put("operation", "session.create")
                    put("cwd", cwd)
                    put("projectName", projectName)
                },
            )
            resultCode = Activity.RESULT_OK
            resultData = receipt.commandId
            return
        }
        val associatedData = "codever.command.outbox.v1\u0000$deviceId".toByteArray(Charsets.UTF_8)
        val encrypted = atomicFile.readFully()
        val envelope = try {
            SecretEnvelope.decode(encrypted)
        } finally {
            encrypted.fill(0)
        }
        val plaintext = try {
            cipher.decrypt(envelope, associatedData)
        } finally {
            envelope.iv.fill(0)
            envelope.ciphertext.fill(0)
        }
        val current = try {
            Json.parseToJsonElement(plaintext.toString(Charsets.UTF_8)).jsonObject
        } finally {
            plaintext.fill(0)
        }
        check(current.getValue("schemaVersion").jsonPrimitive.long == 4L) {
            "The fixture requires a current schema-4 outbox."
        }
        val currentCommands = current.getValue("commands").jsonArray
        val terminalStates = setOf("succeeded", "failed", "cancelled")
        check(currentCommands.all { element ->
            element.jsonObject.getValue("state").jsonPrimitive.content in terminalStates
        }) {
            "The fixture requires every retained current command to be terminal."
        }

        val commandId = "legacy-upgrade-${sha256(runId).take(24)}"
        val operationId = "legacy-operation-${sha256("operation:$runId").take(24)}"
        val now = System.currentTimeMillis()
        val sequence = current.getValue("lastAcknowledgedSequence").jsonPrimitive.long + 1L
        val released = current.getValue("released").jsonArray.map { element ->
            JsonObject(element.jsonObject.filterKeys { key -> key != "retiredCommandIds" })
        }
        val legacyCommands = currentCommands.map { element ->
            JsonObject(element.jsonObject.filterKeys { key ->
                key != "revisionEpoch" && key != "revisionEpochGeneration"
            })
        }
        val legacy = buildJsonObject {
            put("schemaVersion", 2)
            put("lastAcknowledgedSequence", sequence - 1L)
            put("lastRevision", current.getValue("lastRevision"))
            put("commands", buildJsonArray {
                legacyCommands.forEach(::add)
                add(buildJsonObject {
                    put("operationId", operationId)
                    put("commandId", commandId)
                    put("retiredCommandIds", buildJsonArray {})
                    put("idempotencyKey", UUID.nameUUIDFromBytes(runId.toByteArray()).toString())
                    put("requestFingerprint", sha256("request:$runId"))
                    put("state", "recovery_required")
                    put("submittedAt", now)
                    put("updatedAt", now)
                    put("sessionId", JsonNull)
                    put("sequence", sequence)
                    put("baseRevision", current.getValue("lastRevision"))
                    put("authenticationIssuedAt", JsonNull)
                    put("authenticationNonce", JsonNull)
                    put("revision", JsonNull)
                    put("cancelRequested", false)
                    put("completion", JsonNull)
                    put("expectedRevision", JsonNull)
                    put("payload", buildJsonObject { put("operation", "session.create") })
                })
            })
            put("released", buildJsonArray { released.forEach(::add) })
        }.toString().toByteArray(Charsets.UTF_8)
        val replacement = try {
            val payload = cipher.encrypt(legacy, associatedData)
            try {
                SecretEnvelope.encode(payload)
            } finally {
                payload.iv.fill(0)
                payload.ciphertext.fill(0)
            }
        } finally {
            legacy.fill(0)
        }
        val output = atomicFile.startWrite()
        try {
            output.write(replacement)
            output.fd.sync()
            atomicFile.finishWrite(output)
        } catch (error: Exception) {
            atomicFile.failWrite(output)
            throw error
        } finally {
            replacement.fill(0)
        }
        resultCode = Activity.RESULT_OK
        resultData = commandId
    }

    private fun sha256(value: String): String = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8))
        .joinToString("") { byte -> "%02x".format(byte) }

    private companion object {
        const val EXTRA_RUN_ID = "run_id"
        const val EXTRA_MODE = "mode"
        const val EXTRA_CWD = "cwd"
        const val EXTRA_PROJECT_NAME = "project_name"
        const val MODE_CURRENT_QUEUED = "current_queued"
    }
}
