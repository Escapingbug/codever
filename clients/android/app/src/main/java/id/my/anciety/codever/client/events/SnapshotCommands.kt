package id.my.anciety.codever.client.events

/**
 * Keeps reconnect snapshots comfortably below the RPC result budget. Every
 * selected command retains its durable identity and state; terminal payloads
 * are added only while space remains and can always be recovered individually
 * through codever.command.get.
 */
internal fun compactSnapshotCommands(
    commands: List<CommandView>,
    maxBytes: Int = MAX_SNAPSHOT_COMMAND_BYTES,
): List<CommandView> {
    require(maxBytes >= 2)
    val terminalStates = setOf(
        CommandState.SUCCEEDED,
        CommandState.FAILED,
        CommandState.CANCELLED,
    )
    val prioritized = commands.sortedWith(
        compareBy<CommandView> { it.state in terminalStates }
            .thenByDescending { it.updatedAt }
            .thenBy { it.operationId },
    )
    val selected = mutableListOf<CommandView>()
    var usedBytes = 2 // JSON array brackets.

    prioritized.forEach { command ->
        val summary = if (command.state in terminalStates) command.copy(completion = null) else command
        val encodedBytes = encodedCommandBytes(summary)
        val separatorBytes = if (selected.isEmpty()) 0 else 1
        if (usedBytes + separatorBytes + encodedBytes <= maxBytes) {
            selected += summary
            usedBytes += separatorBytes + encodedBytes
        }
    }

    val originalByOperation = commands.associateBy(CommandView::operationId)
    selected.indices.forEach { index ->
        val summary = selected[index]
        val complete = originalByOperation.getValue(summary.operationId)
        if (complete.completion == null) return@forEach
        val extraBytes = encodedCommandBytes(complete) - encodedCommandBytes(summary)
        if (usedBytes + extraBytes <= maxBytes) {
            selected[index] = complete
            usedBytes += extraBytes
        }
    }

    val selectedByOperation = selected.associateBy(CommandView::operationId)
    return commands.mapNotNull { selectedByOperation[it.operationId] }
}

private fun encodedCommandBytes(command: CommandView): Int =
    PublicClientJson.encodeCommand(command).toString().toByteArray(Charsets.UTF_8).size

private const val MAX_SNAPSHOT_COMMAND_BYTES = 192 * 1024
