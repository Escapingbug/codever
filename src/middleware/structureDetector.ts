/**
 * StructureDetector — Finds structure-respecting split points in text buffers.
 *
 * Used by the pipeline to split long messages at safe boundaries
 * (between paragraphs, tables, code blocks, etc.) instead of mid-structure.
 *
 * Supports: code blocks (``` and ~~~), tables, lists, blockquotes.
 */

export interface StructureState {
    inCodeBlock: boolean
    inTable: boolean
    inList: boolean
    inBlockquote: boolean
}

export class StructureDetector {
    /**
     * Find the best split point within maxLen that respects structure boundaries.
     * Priority of split points (high to low):
     * 1. Blank line (paragraph/table/list boundary) — \n\n
     * 2. Table end (|...|\n followed by non-| line or blank line)
     * 3. Heading line (# ...)
     * 4. Line break (\n)
     * 5. Hard cut at maxLen (last resort)
     */
    findStructureBoundary(buffer: string, maxLen: number): number {
        if (buffer.length <= maxLen) return maxLen

        const searchRegion = buffer.slice(0, maxLen + 200) // look slightly ahead for better boundaries

        // Priority 1: Blank line (\n\n) — paragraph boundary
        const blankLinePos = this.findLastInRange(searchRegion, /\n\n/, maxLen)
        if (blankLinePos !== -1) return blankLinePos + 2 // include the \n\n

        // Priority 2: End of a structure that's safe to split after
        // (heading start means previous section ended)
        const headingPos = this.findLastInRange(searchRegion, /\n(?=#{1,6}\s)/, maxLen)
        if (headingPos !== -1) return headingPos + 1 // split before heading

        // Priority 3: Line break
        const lineBreakPos = this.findLastInRange(searchRegion, /\n/, maxLen)
        if (lineBreakPos !== -1) return lineBreakPos + 1 // include the \n

        // Priority 4: Hard cut
        return maxLen
    }

    /**
     * Detect the current structure state of the buffer.
     */
    detect(buffer: string): StructureState {
        const lines = buffer.split('\n')
        let inCodeBlock = false
        let codeFence = '' // tracks ``` or ~~~
        let inTable = false
        let inList = false
        let inBlockquote = false

        // Track the "last meaningful line" state for list/table/blockquote
        // These structures are considered "open" if the buffer ends with
        // lines belonging to that structure, without a closing blank line.

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]

            // Code blocks take absolute priority — inside a code block,
            // we don't parse any other structures
            if (this.isCodeFence(line)) {
                const fenceChar = line.trimStart()[0]
                if (!inCodeBlock) {
                    inCodeBlock = true
                    codeFence = fenceChar === '~' ? '~' : '`'
                } else if (codeFence === fenceChar || fenceChar === '`') {
                    // Close code block if same fence type (``` closes ```, ~~~ closes ~~~)
                    // Also allow ``` to close ~~~ (commonmark allows this)
                    inCodeBlock = false
                    codeFence = ''
                }
                continue
            }

            if (inCodeBlock) continue

            // Non-code-block lines: check for table, list, blockquote

            // Track table/list/blockquote state based on current line
            const isTableLine = /^\s*\|.*\|\s*$/.test(line)
            const isTableSeparator = /^\s*\|[\s\-:]+\|\s*$/.test(line)
            const isListItem = /^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)
            const isBlockquoteLine = /^\s*>/.test(line)
            const isBlank = line.trim() === ''

            if (isTableLine || isTableSeparator) {
                inTable = true
                inList = false
                inBlockquote = false
            } else if (isListItem) {
                inList = true
                inTable = false
                inBlockquote = false
            } else if (isBlockquoteLine) {
                inBlockquote = true
                inTable = false
                inList = false
            } else if (isBlank) {
                // Blank line closes any open structure
                inTable = false
                inList = false
                inBlockquote = false
            } else {
                // Non-blank, non-structure line closes table/list/blockquote
                inTable = false
                inList = false
                inBlockquote = false
            }
        }

        return { inCodeBlock, inTable, inList, inBlockquote }
    }

    /**
     * Check if a line is a code fence (``` or ~~~)
     */
    private isCodeFence(line: string): boolean {
        const trimmed = line.trimStart()
        // Must start with at least 3 backticks or tildes
        return /^(`{3,}|~{3,})/.test(trimmed)
    }

    /**
     * Find the last occurrence of a regex within the first maxLen characters.
     * Returns the start position of the match, or -1 if not found.
     */
    private findLastInRange(text: string, regex: RegExp, maxLen: number): number {
        let lastPos = -1
        const searchIn = text.slice(0, maxLen)

        // Reset regex state
        const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g')
        let match: RegExpExecArray | null

        while ((match = re.exec(searchIn)) !== null) {
            if (match.index > maxLen) break
            lastPos = match.index
        }

        return lastPos
    }
}
