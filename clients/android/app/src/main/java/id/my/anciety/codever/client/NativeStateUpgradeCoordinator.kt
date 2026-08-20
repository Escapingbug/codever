package id.my.anciety.codever.client

import android.util.AtomicFile
import id.my.anciety.codever.diagnostics.DiagnosticRecorder
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

internal enum class NativePersistedStateClass(val wireValue: String) {
    SECURITY_CRITICAL("security-critical"),
    DURABLE_COMMAND("durable-command"),
    REBUILDABLE_PROJECTION("rebuildable-projection"),
    EPHEMERAL_UI("ephemeral-ui");

    val discardable: Boolean
        get() = this == REBUILDABLE_PROJECTION || this == EPHEMERAL_UI
}

internal data class NativeStateCatalogEntry(
    val id: String,
    val stateClass: NativePersistedStateClass,
    /** Version this APK writes. */
    val schemaVersion: Int,
    /** Version already deployed before the first manifest-aware APK. */
    val legacySchemaVersion: Int = schemaVersion,
    /** Every value N declares an implemented, idempotent N -> N+1 step. */
    val migrationFromVersions: Set<Int> = emptySet(),
)

/**
 * Adding or changing native persistence is incomplete until this catalog and
 * the owning codec are updated together. The manifest records these versions
 * so the next APK knows the actual starting version of every store.
 */
internal val NATIVE_STATE_CATALOG = listOf(
    NativeStateCatalogEntry("gateway-trust", NativePersistedStateClass.SECURITY_CRITICAL, 2),
    NativeStateCatalogEntry("replay-ledger", NativePersistedStateClass.SECURITY_CRITICAL, 1),
    NativeStateCatalogEntry("timeline-key-ring", NativePersistedStateClass.SECURITY_CRITICAL, 2),
    NativeStateCatalogEntry(
        "matrix-v3-project-keys",
        NativePersistedStateClass.SECURITY_CRITICAL,
        1,
    ),
    NativeStateCatalogEntry(
        "command-outbox",
        NativePersistedStateClass.DURABLE_COMMAND,
        4,
        migrationFromVersions = setOf(1, 2, 3),
    ),
    NativeStateCatalogEntry("pairing-transaction", NativePersistedStateClass.DURABLE_COMMAND, 1),
    NativeStateCatalogEntry(
        "matrix-v3-raw-inbox",
        NativePersistedStateClass.DURABLE_COMMAND,
        1,
    ),
    NativeStateCatalogEntry(
        "matrix-v3-command-content",
        NativePersistedStateClass.DURABLE_COMMAND,
        1,
    ),
    NativeStateCatalogEntry(
        "client-event-projection",
        NativePersistedStateClass.REBUILDABLE_PROJECTION,
        1,
    ),
    NativeStateCatalogEntry(
        "attachment-transfer-scratch",
        NativePersistedStateClass.REBUILDABLE_PROJECTION,
        1,
    ),
    NativeStateCatalogEntry(
        "matrix-v3-projection",
        NativePersistedStateClass.REBUILDABLE_PROJECTION,
        1,
    ),
)

internal const val NATIVE_STATE_MANIFEST_SCHEMA_VERSION = 1
internal val NATIVE_STATE_MANIFEST_MIGRATIONS =
    emptyMap<Int, (NativeStateManifest) -> NativeStateManifest>()

internal interface NativeStateManifestBlobStore {
    fun read(): ByteArray?
    fun write(bytes: ByteArray)
}

private class AtomicNativeStateManifestBlobStore(file: File) : NativeStateManifestBlobStore {
    private val atomic = AtomicFile(file)

    override fun read(): ByteArray? =
        atomic.baseFile.takeIf(File::isFile)?.let { atomic.readFully() }

    override fun write(bytes: ByteArray) {
        val output = atomic.startWrite()
        try {
            output.write(bytes)
            output.fd.sync()
            atomic.finishWrite(output)
        } catch (error: Exception) {
            atomic.failWrite(output)
            throw error
        }
    }
}

internal class NativeStateUpgradeBlockedException(
    message: String,
    cause: Throwable? = null,
) : IllegalStateException(message, cause)

internal class NativeStateUpgradeCoordinator(
    private val blobs: NativeStateManifestBlobStore,
    private val catalog: List<NativeStateCatalogEntry> = NATIVE_STATE_CATALOG,
    private val diagnostics: DiagnosticRecorder = DiagnosticRecorder.None,
    private val now: () -> Long = System::currentTimeMillis,
) {
    constructor(
        file: File,
        diagnostics: DiagnosticRecorder = DiagnosticRecorder.None,
        now: () -> Long = System::currentTimeMillis,
    ) : this(AtomicNativeStateManifestBlobStore(file), NATIVE_STATE_CATALOG, diagnostics, now)

    constructor(
        file: File,
        catalog: List<NativeStateCatalogEntry>,
        diagnostics: DiagnosticRecorder = DiagnosticRecorder.None,
        now: () -> Long = System::currentTimeMillis,
    ) : this(AtomicNativeStateManifestBlobStore(file), catalog, diagnostics, now)

    init {
        require(catalog.isNotEmpty())
        require(catalog.map { it.id }.distinct().size == catalog.size)
        catalog.forEach { entry ->
            require(entry.id.length in 1..160)
            require(entry.schemaVersion >= 1)
            require(entry.legacySchemaVersion in 1..entry.schemaVersion)
            require(entry.migrationFromVersions.all { it in 1 until entry.schemaVersion })
        }
    }

    @Synchronized
    fun begin(runtimeBuild: String): NativeStateUpgradeRun {
        require(runtimeBuild.length in 1..256)
        val encoded = try {
            blobs.read()
        } catch (error: Exception) {
            diagnostics.record("state.upgrade.manifest_blocked", mapOf("reason" to "read"))
            throw NativeStateUpgradeBlockedException(
                "The native state upgrade journal could not be read; protected state was preserved.",
                error,
            )
        }
        val previous = encoded?.let { bytes ->
            try {
                NativeStateManifestCodec.decode(bytes)
            } catch (error: NativeStateUpgradeBlockedException) {
                throw error
            } catch (error: Exception) {
                diagnostics.record("state.upgrade.manifest_blocked", mapOf("reason" to "decode"))
                throw NativeStateUpgradeBlockedException(
                    "The native state upgrade journal is damaged; protected state was preserved.",
                    error,
                )
            } finally {
                bytes.fill(0)
            }
        }
        val migratedManifest = migrateManifest(previous)
        val priorStores = migratedManifest?.stores.orEmpty().associateBy { it.id }
        val manifest = NativeStateManifest(
            version = NATIVE_STATE_MANIFEST_SCHEMA_VERSION,
            phase = NativeUpgradePhase.RUNNING,
            runtimeBuild = runtimeBuild,
            startedAt = migratedManifest
                ?.takeIf { it.phase == NativeUpgradePhase.RUNNING }
                ?.startedAt
                ?: now(),
            completedAt = null,
            migratedFrom = migratedManifest?.version
                ?.takeIf { it < NATIVE_STATE_MANIFEST_SCHEMA_VERSION }
                ?: if (migratedManifest == null) 0 else null,
            stores = catalog.map { entry ->
                priorStores[entry.id] ?: ManifestStore(
                    entry.id,
                    entry.stateClass,
                    entry.legacySchemaVersion,
                )
            },
            activeMigration = migratedManifest?.activeMigration,
            invalidated = migratedManifest
                ?.takeIf { it.phase == NativeUpgradePhase.RUNNING }
                ?.invalidated
                .orEmpty(),
            blocked = emptyList(),
        )
        persist(manifest)
        diagnostics.record(
            "state.upgrade.started",
            mapOf(
                "schema" to NATIVE_STATE_MANIFEST_SCHEMA_VERSION.toString(),
                "source" to (manifest.migratedFrom?.toString() ?: "current"),
            ),
        )
        return NativeStateUpgradeRun(manifest, catalog, ::persist, diagnostics, now)
    }

    private fun migrateManifest(value: NativeStateManifest?): NativeStateManifest? {
        if (value == null) return null
        if (value.version > NATIVE_STATE_MANIFEST_SCHEMA_VERSION) {
            throw NativeStateUpgradeBlockedException(
                "Native state schema ${value.version} was written by a newer APK.",
            )
        }
        var current: NativeStateManifest = value
        while (current.version < NATIVE_STATE_MANIFEST_SCHEMA_VERSION) {
            val migration = NATIVE_STATE_MANIFEST_MIGRATIONS[current.version]
                ?: throw NativeStateUpgradeBlockedException(
                    "Native state has no manifest migration from ${current.version} to ${current.version + 1}.",
                )
            val from = current.version
            current = migration(current)
            check(current.version == from + 1) {
                "Native manifest migration $from must produce ${from + 1}."
            }
        }
        return current
    }

    private fun persist(manifest: NativeStateManifest) {
        val bytes = NativeStateManifestCodec.encode(manifest)
        try {
            blobs.write(bytes)
        } finally {
            bytes.fill(0)
        }
    }

}

internal class NativeStateUpgradeRun(
    initial: NativeStateManifest,
    private val catalog: List<NativeStateCatalogEntry>,
    private val persist: (NativeStateManifest) -> Unit,
    private val diagnostics: DiagnosticRecorder,
    private val now: () -> Long,
) {
    private var manifest = initial

    /**
     * Opens security/command state through an explicit adjacent migration
     * chain. A missing step or validation failure preserves the source and
     * makes the runtime repair-only.
     */
    @Synchronized
    fun recoverPreserved(
        storeId: String,
        migrate: (fromVersion: Int, toVersion: Int) -> Unit = { _, _ -> },
        validate: () -> Unit = {},
    ) {
        val entry = requireEntry(storeId)
        require(!entry.stateClass.discardable)
        val recorded = requireStore(storeId)
        if (recorded.stateClass != entry.stateClass || recorded.schemaVersion > entry.schemaVersion) {
            blockPreserved(storeId)
            throw NativeStateUpgradeBlockedException(
                "Native store $storeId was written by an incompatible APK and was preserved.",
            )
        }
        var fromVersion = recorded.schemaVersion
        while (fromVersion < entry.schemaVersion) {
            if (fromVersion !in entry.migrationFromVersions) {
                blockPreserved(storeId)
                throw NativeStateUpgradeBlockedException(
                    "Native store $storeId has no $fromVersion -> ${fromVersion + 1} migration and was preserved.",
                )
            }
            checkpoint(manifest.copy(
                activeMigration = ActiveStoreMigration(storeId, fromVersion, fromVersion + 1),
            ))
            try {
                migrate(fromVersion, fromVersion + 1)
            } catch (error: Exception) {
                blockPreserved(storeId)
                throw error
            }
            fromVersion += 1
            checkpointStore(entry, fromVersion, invalidated = false)
            diagnostics.record(
                "state.upgrade.store_migrated",
                mapOf(
                    "kind" to storeId,
                    "schema" to "${fromVersion - 1}-$fromVersion",
                ),
            )
        }
        try {
            validate()
        } catch (error: Exception) {
            blockPreserved(storeId)
            throw error
        }
    }

    /**
     * Projection/UI state is reset when its version changes or validation
     * fails. Matrix/native authority reconstructs it; commands and trust are
     * never touched by this path.
     */
    @Synchronized
    fun recoverRebuildable(
        storeId: String,
        validate: () -> Unit,
        reset: () -> Unit,
    ) {
        val entry = requireEntry(storeId)
        require(entry.stateClass.discardable)
        val recorded = requireStore(storeId)
        val resetRequired = recorded.stateClass != entry.stateClass ||
            recorded.schemaVersion != entry.schemaVersion ||
            runCatching(validate).isFailure
        if (resetRequired) {
            reset()
            checkpointStore(entry, entry.schemaVersion, invalidated = true)
            diagnostics.record("state.upgrade.invalidated", mapOf("kind" to storeId))
        }
    }

    /** Security/durable state is preserved and surfaced as repair, never reset. */
    @Synchronized
    fun blockPreserved(storeId: String) {
        val entry = requireEntry(storeId)
        require(!entry.stateClass.discardable)
        checkpoint(manifest.copy(
            phase = NativeUpgradePhase.BLOCKED,
            activeMigration = null,
            blocked = (manifest.blocked + storeId).distinct().sorted(),
        ))
        diagnostics.record("state.upgrade.blocked", mapOf("kind" to storeId))
    }

    @Synchronized
    fun complete() {
        if (manifest.blocked.isNotEmpty()) return
        val pending = catalog.filter { entry ->
            manifest.stores.none { stored ->
                stored.id == entry.id &&
                    stored.stateClass == entry.stateClass &&
                    stored.schemaVersion == entry.schemaVersion
            }
        }
        if (pending.isNotEmpty()) {
            throw NativeStateUpgradeBlockedException(
                "Native stores were not upgraded: ${pending.joinToString { it.id }}",
            )
        }
        checkpoint(manifest.copy(
            phase = NativeUpgradePhase.COMPLETE,
            completedAt = now(),
            activeMigration = null,
        ))
        diagnostics.record(
            "state.upgrade.completed",
            mapOf("count" to manifest.invalidated.size.toString()),
        )
    }

    private fun checkpointStore(
        entry: NativeStateCatalogEntry,
        schemaVersion: Int,
        invalidated: Boolean,
    ) = checkpoint(manifest.copy(
        stores = manifest.stores.map { stored ->
            if (stored.id == entry.id) ManifestStore(entry.id, entry.stateClass, schemaVersion)
            else stored
        },
        activeMigration = null,
        invalidated = if (invalidated) {
            (manifest.invalidated + entry.id).distinct().sorted()
        } else {
            manifest.invalidated
        },
    ))

    private fun checkpoint(next: NativeStateManifest) {
        persist(next)
        manifest = next
    }

    private fun requireEntry(storeId: String): NativeStateCatalogEntry =
        catalog.singleOrNull { it.id == storeId }
            ?: throw IllegalArgumentException("Unknown native state store: $storeId")

    private fun requireStore(storeId: String): ManifestStore =
        manifest.stores.singleOrNull { it.id == storeId }
            ?: throw IllegalStateException("Native state manifest omitted $storeId.")
}

internal enum class NativeUpgradePhase(val wireValue: String) {
    RUNNING("running"),
    BLOCKED("blocked"),
    COMPLETE("complete");

    companion object {
        fun parse(value: String): NativeUpgradePhase = entries.singleOrNull {
            it.wireValue == value
        } ?: throw IllegalArgumentException("Native upgrade phase is invalid.")
    }
}

internal data class ManifestStore(
    val id: String,
    val stateClass: NativePersistedStateClass,
    val schemaVersion: Int,
)

internal data class ActiveStoreMigration(
    val id: String,
    val fromVersion: Int,
    val toVersion: Int,
)

internal data class NativeStateManifest(
    val version: Int,
    val phase: NativeUpgradePhase,
    val runtimeBuild: String,
    val startedAt: Long,
    val completedAt: Long?,
    val migratedFrom: Int?,
    val stores: List<ManifestStore>,
    val activeMigration: ActiveStoreMigration?,
    val invalidated: List<String>,
    val blocked: List<String>,
)

internal object NativeStateManifestCodec {
    private val json = Json { isLenient = false; allowSpecialFloatingPointValues = false }

    fun encode(value: NativeStateManifest): ByteArray = buildJsonObject {
        put("version", value.version)
        put("phase", value.phase.wireValue)
        put("runtimeBuild", value.runtimeBuild)
        put("startedAt", value.startedAt)
        value.completedAt?.let { put("completedAt", it) } ?: put("completedAt", JsonNull)
        value.migratedFrom?.let { put("migratedFrom", it) } ?: put("migratedFrom", JsonNull)
        put("stores", buildJsonArray {
            value.stores.forEach { store ->
                add(buildJsonObject {
                    put("id", store.id)
                    put("stateClass", store.stateClass.wireValue)
                    put("schemaVersion", store.schemaVersion)
                })
            }
        })
        value.activeMigration?.let { migration ->
            put("activeMigration", buildJsonObject {
                put("id", migration.id)
                put("fromVersion", migration.fromVersion)
                put("toVersion", migration.toVersion)
            })
        } ?: put("activeMigration", JsonNull)
        put("invalidated", stringArray(value.invalidated))
        put("blocked", stringArray(value.blocked))
    }.toString().toByteArray(Charsets.UTF_8)

    fun decode(bytes: ByteArray): NativeStateManifest {
        require(bytes.size <= MAX_BYTES) { "Native state manifest is too large." }
        val root = json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
        val version = root["version"]?.jsonPrimitive?.intOrNull
            ?: throw IllegalArgumentException("Native state manifest version is invalid.")
        if (version > CURRENT_SCHEMA_VERSION) {
            throw NativeStateUpgradeBlockedException(
                "Native state schema $version was written by a newer APK.",
            )
        }
        require(root.keys == setOf(
            "version", "phase", "runtimeBuild", "startedAt", "completedAt",
            "migratedFrom", "stores", "activeMigration", "invalidated", "blocked",
        )) { "Native state manifest shape is invalid." }
        require(version == CURRENT_SCHEMA_VERSION) { "Native state manifest version is invalid." }
        val stores = root.getValue("stores").jsonArray.map { value ->
            val store = value.jsonObject
            require(store.keys == setOf("id", "stateClass", "schemaVersion"))
            ManifestStore(
                id = store.requiredString("id"),
                stateClass = store.requiredStateClass("stateClass"),
                schemaVersion = store.requiredVersion("schemaVersion"),
            )
        }.also { require(it.map(ManifestStore::id).distinct().size == it.size) }
        val active = root.getValue("activeMigration").takeUnless { it is JsonNull }?.jsonObject
            ?.let { migration ->
                require(migration.keys == setOf("id", "fromVersion", "toVersion"))
                ActiveStoreMigration(
                    migration.requiredString("id"),
                    migration.requiredVersion("fromVersion"),
                    migration.requiredVersion("toVersion"),
                ).also { require(it.toVersion == it.fromVersion + 1) }
            }
        return NativeStateManifest(
            version = version,
            phase = NativeUpgradePhase.parse(root.requiredString("phase")),
            runtimeBuild = root.requiredString("runtimeBuild"),
            startedAt = root.requiredLong("startedAt"),
            completedAt = root.optionalLong("completedAt"),
            migratedFrom = root.optionalInt("migratedFrom"),
            stores = stores,
            activeMigration = active,
            invalidated = root.stringList("invalidated"),
            blocked = root.stringList("blocked"),
        )
    }

    private fun stringArray(values: List<String>): JsonArray = buildJsonArray {
        values.forEach { add(JsonPrimitive(it)) }
    }

    private fun JsonObject.requiredString(key: String): String = get(key)
        ?.jsonPrimitive?.contentOrNull?.takeIf { it.length in 1..256 }
        ?: throw IllegalArgumentException("$key is invalid.")

    private fun JsonObject.requiredStateClass(key: String): NativePersistedStateClass =
        requiredString(key).let { value ->
            NativePersistedStateClass.entries.singleOrNull { it.wireValue == value }
                ?: throw IllegalArgumentException("$key is invalid.")
        }

    private fun JsonObject.requiredVersion(key: String): Int = get(key)
        ?.jsonPrimitive?.intOrNull?.also { require(it >= 1) }
        ?: throw IllegalArgumentException("$key is invalid.")

    private fun JsonObject.requiredLong(key: String): Long = get(key)
        ?.jsonPrimitive?.longOrNull?.also { require(it >= 0) }
        ?: throw IllegalArgumentException("$key is invalid.")

    private fun JsonObject.optionalLong(key: String): Long? = get(key)
        ?.takeUnless { it is JsonNull }?.jsonPrimitive?.longOrNull?.also { require(it >= 0) }

    private fun JsonObject.optionalInt(key: String): Int? = get(key)
        ?.takeUnless { it is JsonNull }?.jsonPrimitive?.intOrNull?.also { require(it >= 0) }

    private fun JsonObject.stringList(key: String): List<String> = getValue(key)
        .jsonArray.map { item ->
            item.jsonPrimitive.contentOrNull ?: throw IllegalArgumentException("$key is invalid.")
        }.also { values ->
            require(values.size <= 128)
            require(values.distinct().size == values.size)
        }

    private const val CURRENT_SCHEMA_VERSION = 1
    private const val MAX_BYTES = 64 * 1024
}
