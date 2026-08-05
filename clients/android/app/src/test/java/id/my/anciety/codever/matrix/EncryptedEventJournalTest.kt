package id.my.anciety.codever.matrix

import java.io.IOException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EncryptedEventJournalTest {
    @Test
    fun `encrypted batch appends once and preserves per event dedupe results`() {
        val storage = FailingBlobStore()
        val journal = EncryptedBoundedEventJournal(
            blobStore = storage,
            cipher = JvmAesGcmCipher(),
            accountScope = "a".repeat(64),
            maxEvents = 10,
            maxPlaintextBytes = 64 * 1024,
        )

        val cursors = journal.appendAll(
            listOf(
                JournalEventInput("!room:test", "event-1", 1, raw("event-1")),
                JournalEventInput("!room:test", "event-2", 2, raw("event-2")),
                JournalEventInput("!room:test", "event-1", 3, raw("event-1")),
            ),
        )

        assertEquals(listOf(1L, 2L, null), cursors)
        assertEquals(1, storage.writeCount)
        assertEquals(listOf("event-1", "event-2"), journal.readAfter(null, 10).events.map { it.eventId })
    }

    @Test
    fun `application control batch deduplicates changing unsigned data by event id`() {
        val storage = FailingBlobStore()
        val journal = EncryptedBoundedEventJournal(
            blobStore = storage,
            cipher = JvmAesGcmCipher(),
            accountScope = "a".repeat(64),
            maxEvents = 10,
            maxPlaintextBytes = 64 * 1024,
        )
        assertEquals(1L, journal.append("!room:test", "event-1", 1, raw("event-1")))

        val cursors = journal.appendAll(
            listOf(
                JournalEventInput(
                    "!room:test",
                    "event-1",
                    2,
                    """{"event_id":"event-1","unsigned":{"age":2000}}""",
                    dedupeByEventId = true,
                ),
            ),
        )

        assertEquals(listOf<Long?>(null), cursors)
        assertEquals(1, storage.writeCount)
        assertEquals(1L, journal.latestCursor())
    }

    @Test
    fun `bounded journal reports expired cursor and releases trimmed dedupe entries`() {
        val journal = InMemoryBoundedEventJournal(maxEvents = 2)
        assertEquals(1L, journal.append("!room:test", "event-1", 1, raw("event-1")))
        assertEquals(2L, journal.append("!room:test", "event-2", 2, raw("event-2")))
        assertEquals(3L, journal.append("!room:test", "event-3", 3, raw("event-3")))

        val expired = journal.readAfter(0, 2)
        assertTrue(expired.cursorExpired)
        assertTrue(expired.events.isEmpty())
        assertEquals(2L, expired.oldestAvailableCursor)

        assertEquals(4L, journal.append("!room:test", "event-1", 4, raw("event-1")))
        assertEquals(4L, journal.latestCursor())
        assertFalse(journal.readAfter(3, 2).cursorExpired)
    }

    @Test
    fun `failed encrypted write rolls back cursor and dedupe state`() {
        val storage = FailingBlobStore()
        val journal = EncryptedBoundedEventJournal(
            blobStore = storage,
            cipher = JvmAesGcmCipher(),
            accountScope = "a".repeat(64),
            maxEvents = 10,
            maxPlaintextBytes = 64 * 1024,
        )
        storage.failWrites = true

        val failure = runCatching {
            journal.append("!room:test", "event-1", 1, raw("event-1"))
        }.exceptionOrNull()

        assertTrue(failure is IOException)
        assertEquals(0L, journal.latestCursor())
        assertTrue(journal.readAfter(null, 10).events.isEmpty())

        storage.failWrites = false
        assertEquals(1L, journal.append("!room:test", "event-1", 1, raw("event-1")))
        assertEquals(1L, journal.latestCursor())
    }

    private fun raw(eventId: String) =
        """{"event_id":"$eventId","type":"m.room.message","content":{"body":"ok"}}"""

    private class FailingBlobStore : JournalBlobStore {
        var failWrites = false
        var writeCount = 0
        private var value: ByteArray? = null

        override fun exists(): Boolean = value != null

        override fun read(): ByteArray = checkNotNull(value).copyOf()

        override fun write(bytes: ByteArray) {
            if (failWrites) throw IOException("injected write failure")
            writeCount += 1
            value = bytes.copyOf()
        }

        override fun delete() {
            value = null
        }
    }
}
