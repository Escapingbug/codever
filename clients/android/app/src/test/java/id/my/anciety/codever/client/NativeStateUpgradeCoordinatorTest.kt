package id.my.anciety.codever.client

import id.my.anciety.codever.matrix.MATRIX_STATE_CATALOG
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.int
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class NativeStateUpgradeCoordinatorTest {
    @Test
    fun `current APK covers every store in the released catalog`() {
        val fixture = checkNotNull(javaClass.classLoader?.getResourceAsStream(
            "state-upgrade/released-native-catalog-v1.json",
        )).bufferedReader().use { reader ->
            Json.parseToJsonElement(reader.readText()).jsonObject
        }
        val releasedManifestVersion = fixture.getValue("manifestVersion").jsonPrimitive.int
        assertTrue(NATIVE_STATE_MANIFEST_SCHEMA_VERSION >= releasedManifestVersion)
        for (version in releasedManifestVersion until NATIVE_STATE_MANIFEST_SCHEMA_VERSION) {
            assertTrue(
                "Native state manifest has no $version -> ${version + 1} migration.",
                version in NATIVE_STATE_MANIFEST_MIGRATIONS,
            )
        }
        assertReleasedCoverage(fixture.getValue("native").jsonArray, NATIVE_STATE_CATALOG)
        assertReleasedCoverage(fixture.getValue("matrix").jsonArray, MATRIX_STATE_CATALOG)
    }

    @Test
    fun `CVP3 durable and rebuildable stores are all migration catalogued`() {
        val expected = mapOf(
            "matrix-v3-project-keys" to (NativePersistedStateClass.SECURITY_CRITICAL to 1),
            "matrix-v3-raw-inbox" to (NativePersistedStateClass.DURABLE_COMMAND to 1),
            "matrix-v3-command-content" to (NativePersistedStateClass.DURABLE_COMMAND to 1),
            "matrix-v3-projection" to (NativePersistedStateClass.REBUILDABLE_PROJECTION to 2),
        )

        expected.forEach { (id, expectedState) ->
            val entry = NATIVE_STATE_CATALOG.single { it.id == id }
            assertEquals(expectedState.first, entry.stateClass)
            assertEquals(expectedState.second, entry.schemaVersion)
        }
    }
    @Test
    fun `future preserved state runs every adjacent migration and records actual version`() {
        val blobs = MemoryManifestBlobs()
        val versionOne = preservedCatalog(1)
        NativeStateUpgradeCoordinator(blobs, versionOne, now = { 1L })
            .begin("build-1")
            .also { run ->
                run.recoverPreserved("fixture")
                run.complete()
            }

        var persistedStoreVersion = 1
        val steps = mutableListOf<Pair<Int, Int>>()
        val versionThree = preservedCatalog(3, setOf(1, 2))
        NativeStateUpgradeCoordinator(blobs, versionThree, now = { 2L })
            .begin("build-2")
            .also { run ->
                run.recoverPreserved(
                    "fixture",
                    migrate = { from, to ->
                        assertEquals(from, persistedStoreVersion)
                        persistedStoreVersion = to
                        steps += from to to
                    },
                    validate = { assertEquals(3, persistedStoreVersion) },
                )
                run.complete()
            }

        assertEquals(listOf(1 to 2, 2 to 3), steps)
        assertEquals(3, persistedStoreVersion)
        val manifest = NativeStateManifestCodec.decode(checkNotNull(blobs.value))
        assertEquals(NativeUpgradePhase.COMPLETE, manifest.phase)
        assertEquals(3, manifest.stores.single().schemaVersion)
    }

    @Test
    fun `missing future durable migration blocks without touching source state`() {
        val blobs = MemoryManifestBlobs()
        NativeStateUpgradeCoordinator(blobs, preservedCatalog(1), now = { 1L })
            .begin("build-1")
            .also { run ->
                run.recoverPreserved("fixture")
                run.complete()
            }
        val source = "durable-command-payload"
        val run = NativeStateUpgradeCoordinator(
            blobs,
            preservedCatalog(2, emptySet()),
            now = { 2L },
        ).begin("build-2")

        assertThrows(NativeStateUpgradeBlockedException::class.java) {
            run.recoverPreserved("fixture", migrate = { _, _ -> error("must not run") })
        }

        assertEquals("durable-command-payload", source)
        val manifest = NativeStateManifestCodec.decode(checkNotNull(blobs.value))
        assertEquals(NativeUpgradePhase.BLOCKED, manifest.phase)
        assertEquals(listOf("fixture"), manifest.blocked)
        assertEquals(1, manifest.stores.single().schemaVersion)
    }

    @Test
    fun `future projection schema is reset without touching preserved stores`() {
        val blobs = MemoryManifestBlobs()
        val versionOne = listOf(
            NativeStateCatalogEntry(
                "projection",
                NativePersistedStateClass.REBUILDABLE_PROJECTION,
                1,
            ),
        )
        NativeStateUpgradeCoordinator(blobs, versionOne, now = { 1L })
            .begin("build-1")
            .also { run ->
                run.recoverRebuildable("projection", validate = {}, reset = {})
                run.complete()
            }
        var reset = false
        val versionTwo = listOf(versionOne.single().copy(schemaVersion = 2))

        NativeStateUpgradeCoordinator(blobs, versionTwo, now = { 2L })
            .begin("build-2")
            .also { run ->
                run.recoverRebuildable(
                    "projection",
                    validate = { error("old projection must not be accepted") },
                    reset = { reset = true },
                )
                run.complete()
            }

        assertTrue(reset)
        val manifest = NativeStateManifestCodec.decode(checkNotNull(blobs.value))
        assertEquals(2, manifest.stores.single().schemaVersion)
        assertEquals(listOf("projection"), manifest.invalidated)
    }

    @Test
    fun `process death after store write replays the idempotent step`() {
        val blobs = MemoryManifestBlobs()
        NativeStateUpgradeCoordinator(blobs, preservedCatalog(1), now = { 1L })
            .begin("build-1")
            .also { run ->
                run.recoverPreserved("fixture")
                run.complete()
            }
        var persistedStoreVersion = 1
        var migrationCalls = 0
        val versionTwo = preservedCatalog(2, setOf(1))
        val interrupted = NativeStateUpgradeCoordinator(blobs, versionTwo, now = { 2L })
            .begin("build-2")
        blobs.failWriteNumber = blobs.writeCount + 2 // active journal succeeds; checkpoint fails
        assertThrows(IllegalStateException::class.java) {
            interrupted.recoverPreserved("fixture", migrate = { _, to ->
                migrationCalls += 1
                persistedStoreVersion = maxOf(persistedStoreVersion, to)
            })
        }

        val resumed = NativeStateUpgradeCoordinator(blobs, versionTwo, now = { 3L })
            .begin("build-2")
        resumed.recoverPreserved("fixture", migrate = { _, to ->
            migrationCalls += 1
            persistedStoreVersion = maxOf(persistedStoreVersion, to)
        })
        resumed.complete()

        assertEquals(2, migrationCalls)
        assertEquals(2, persistedStoreVersion)
        assertEquals(
            NativeUpgradePhase.COMPLETE,
            NativeStateManifestCodec.decode(checkNotNull(blobs.value)).phase,
        )
    }

    @Test
    fun `older APK refuses to downgrade future security state`() {
        val blobs = MemoryManifestBlobs()
        val versionTwo = preservedCatalog(2, setOf(1))
        NativeStateUpgradeCoordinator(blobs, versionTwo, now = { 1L })
            .begin("build-2")
            .also { run ->
                run.recoverPreserved("fixture", migrate = { _, _ -> })
                run.complete()
            }

        val older = NativeStateUpgradeCoordinator(blobs, preservedCatalog(1), now = { 2L })
            .begin("build-1")
        assertThrows(NativeStateUpgradeBlockedException::class.java) {
            older.recoverPreserved("fixture")
        }

        val manifest = NativeStateManifestCodec.decode(checkNotNull(blobs.value))
        assertEquals(NativeUpgradePhase.BLOCKED, manifest.phase)
        assertEquals(2, manifest.stores.single().schemaVersion)
    }

    @Test
    fun `damaged migration journal fails closed without replacing it`() {
        val blobs = MemoryManifestBlobs().apply {
            value = "not-a-manifest".toByteArray()
        }

        assertThrows(NativeStateUpgradeBlockedException::class.java) {
            NativeStateUpgradeCoordinator(blobs, preservedCatalog(1)).begin("repair-build")
        }

        assertEquals("not-a-manifest", checkNotNull(blobs.value).toString(Charsets.UTF_8))
        assertEquals(0, blobs.writeCount)
    }

    private fun preservedCatalog(
        version: Int,
        migrations: Set<Int> = emptySet(),
    ) = listOf(
        NativeStateCatalogEntry(
            "fixture",
            NativePersistedStateClass.DURABLE_COMMAND,
            version,
            legacySchemaVersion = 1,
            migrationFromVersions = migrations,
        ),
    )

    private fun assertReleasedCoverage(
        released: kotlinx.serialization.json.JsonArray,
        current: List<NativeStateCatalogEntry>,
    ) {
        released.forEach { element ->
            val value = element.jsonObject
            val id = value.getValue("id").jsonPrimitive.content
            val stateClass = value.getValue("stateClass").jsonPrimitive.content
            val schemaVersion = value.getValue("schemaVersion").jsonPrimitive.int
            val next = current.singleOrNull { it.id == id }
                ?: throw AssertionError("Released native store $id was removed without retirement.")
            assertEquals(stateClass, next.stateClass.wireValue)
            assertTrue("Released native store $id was downgraded.", next.schemaVersion >= schemaVersion)
            if (!next.stateClass.discardable) {
                for (version in schemaVersion until next.schemaVersion) {
                    assertTrue(
                        "Released native store $id has no $version -> ${version + 1} migration.",
                        version in next.migrationFromVersions,
                    )
                }
            }
        }
    }

    private class MemoryManifestBlobs : NativeStateManifestBlobStore {
        var value: ByteArray? = null
        var writeCount = 0
        var failWriteNumber: Int? = null

        override fun read(): ByteArray? = value?.copyOf()

        override fun write(bytes: ByteArray) {
            writeCount += 1
            if (failWriteNumber == writeCount) {
                failWriteNumber = null
                throw IllegalStateException("simulated process death")
            }
            value = bytes.copyOf()
        }
    }
}
