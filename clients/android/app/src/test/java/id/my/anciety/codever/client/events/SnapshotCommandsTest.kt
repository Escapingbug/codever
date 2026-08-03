package id.my.anciety.codever.client.events

import java.util.UUID
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SnapshotCommandsTest {
    @Test
    fun `snapshot keeps active commands and terminal identities within budget`() {
        val active = command(CommandState.RUNNING, updatedAt = 40)
        val completed = (1L..3L).map { updatedAt ->
            command(CommandState.SUCCEEDED, updatedAt, completionBytes = 8_000)
        }

        val compacted = compactSnapshotCommands(completed + active, maxBytes = 2_000)
        val encodedBytes = compacted.joinToString(",", "[", "]") {
            PublicClientJson.encodeCommand(it).toString()
        }.toByteArray(Charsets.UTF_8).size

        assertTrue(encodedBytes <= 2_000)
        assertTrue(compacted.any { it.operationId == active.operationId })
        assertEquals(4, compacted.size)
        compacted.filter { it.state == CommandState.SUCCEEDED }.forEach {
            assertNull(it.completion)
        }
    }

    @Test
    fun `snapshot uses remaining budget for newest complete results`() {
        val older = command(CommandState.SUCCEEDED, updatedAt = 1, completionBytes = 300)
        val newer = command(CommandState.SUCCEEDED, updatedAt = 2, completionBytes = 300)
        val summaryBytes = wireBytes(listOf(older.copy(completion = null), newer.copy(completion = null)))
        val newestCompletionBytes = wireBytes(listOf(newer)) - wireBytes(listOf(newer.copy(completion = null)))

        val summaries = compactSnapshotCommands(
            listOf(older, newer),
            maxBytes = summaryBytes + newestCompletionBytes,
        )

        assertNull(summaries.single { it.operationId == older.operationId }.completion)
        assertTrue(summaries.single { it.operationId == newer.operationId }.completion != null)
    }

    private fun command(
        state: CommandState,
        updatedAt: Long,
        completionBytes: Int = 0,
    ): CommandView {
        val commandId = UUID.randomUUID().toString()
        return CommandView(
            operationId = UUID.randomUUID().toString(),
            idempotencyKey = UUID.randomUUID().toString(),
            state = state,
            submittedAt = 0,
            updatedAt = updatedAt,
            commandId = commandId,
            sequence = 1,
            revision = 0,
            completion = if (completionBytes == 0) null else CommandCompletion(
                commandId = commandId,
                sequence = 1,
                revision = 0,
                outcome = CommandOutcome.SUCCEEDED,
                result = JsonPrimitive("x".repeat(completionBytes)),
            ),
        )
    }

    private fun wireBytes(commands: List<CommandView>): Int = commands.joinToString(",", "[", "]") {
        PublicClientJson.encodeCommand(it).toString()
    }.toByteArray(Charsets.UTF_8).size
}
