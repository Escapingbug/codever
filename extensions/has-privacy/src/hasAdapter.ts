import { createHash } from 'node:crypto'
import { canonicalMapping } from './mapping.js'
import type { HasAdapter, HasEngineIdentity, HasMapping } from './types.js'

const PROMPT_TEMPLATE = [
    'Recognize the following entity types in the text.',
    'Specified types:{types_json_array}',
    '<text>{text}</text>',
].join('\n')
const PROMPT_REVISION = sha256(PROMPT_TEMPLATE)
const RECOGNITION_MAX_CHARS = 2_000
const RECOGNITION_OVERLAP_CHARS = 256

export interface LlamaHasAdapterOptions {
    endpoint?: string
    model: string
    modelRevision: string
    timeoutMs?: number
    fetch?: typeof fetch
}

export class LlamaHasAdapter implements HasAdapter {
    readonly identity: HasEngineIdentity
    private readonly endpoint: string
    private readonly timeoutMs: number
    private readonly fetchImpl: typeof fetch
    private completionTail: Promise<void> = Promise.resolve()

    constructor(options: LlamaHasAdapterOptions) {
        const endpoint = new URL(
            options.endpoint ?? 'http://127.0.0.1:18080/v1/chat/completions',
        )
        if (
            endpoint.protocol !== 'http:'
            || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
            || endpoint.username
            || endpoint.password
            || endpoint.search
            || endpoint.hash
        ) {
            throw new Error('HaS endpoint must use loopback HTTP')
        }
        this.endpoint = endpoint.toString()
        this.timeoutMs = options.timeoutMs ?? 120_000
        this.fetchImpl = options.fetch ?? fetch
        this.identity = {
            adapter: 'llama.cpp-openai-compatible+readable-pseudonym-v1',
            model: options.model,
            modelRevision: options.modelRevision,
            promptRevision: PROMPT_REVISION,
        }
    }

    async hide(request: {
        text: string
        entityTypes: readonly string[]
        mapping: HasMapping
    }): Promise<{ anonymizedText: string; mappingDelta: HasMapping; identity: HasEngineIdentity }> {
        if (!request.text.trim()) {
            return { anonymizedText: request.text, mappingDelta: {}, identity: this.identity }
        }
        const entities = new Map<string, RecognizedEntity>()
        for (const chunk of recognitionChunks(request.text)) {
            for (const entity of await this.recognizeChunk(chunk, request.entityTypes)) {
                if (request.text.includes(entity.value)) entities.set(entity.value, entity)
            }
        }

        const existing = canonicalMapping(request.mapping)
        const reservedPseudonym = Object.keys(existing).find(pseudonym =>
            request.text.includes(pseudonym))
        if (reservedPseudonym) {
            throw new Error('Source text contains a reserved privacy pseudonym')
        }
        const ownerByOriginal = new Map<string, string>()
        const used = new Set(Object.keys(existing))
        for (const [pseudonym, originals] of Object.entries(existing)) {
            for (const original of originals) ownerByOriginal.set(original, pseudonym)
        }
        let anonymizedText = request.text
        const mappingDelta: Record<string, readonly string[]> = {}
        const appliedMapping: Record<string, readonly string[]> = {}
        const selected = [...new Set([
            ...ownerByOriginal.keys(),
            ...entities.keys(),
        ])].filter(value => request.text.includes(value)).sort((a, b) => b.length - a.length)

        for (const original of selected) {
            const entity = entities.get(original)
            let pseudonym = ownerByOriginal.get(original)
            if (!pseudonym && entity) {
                const kind = readableEntityKind(entity.entityType, original)
                if (/金额|工资|薪资|amount|salary|money/iu.test(entity.entityType)) {
                    throw new Error('HaS attempted to replace a protected business amount')
                }
                if (
                    isStandaloneNumber(original)
                    && !['phone', 'identity', 'bank', 'employee'].includes(kind)
                ) {
                    throw new Error('HaS attempted to replace a protected numeric fact')
                }
                pseudonym = nextPseudonym(
                    kind,
                    original,
                    used,
                    request.text,
                )
                used.add(pseudonym)
                mappingDelta[pseudonym] = [original]
            }
            if (pseudonym) {
                anonymizedText = anonymizedText.split(original).join(pseudonym)
                appliedMapping[pseudonym] = [original]
            }
        }
        assertProtectedNumericFacts(request.text, anonymizedText, appliedMapping)
        return {
            anonymizedText,
            mappingDelta: canonicalMapping(mappingDelta),
            identity: this.identity,
        }
    }

    private async recognizeChunk(
        text: string,
        entityTypes: readonly string[],
    ): Promise<readonly RecognizedEntity[]> {
        const prompt = `Recognize the following entity types in the text.\nSpecified types:${JSON.stringify([...new Set(entityTypes)])}\n<text>${text}</text>`
        const completion = await this.complete(prompt, recognitionTokenBudget(text))
        return parseRecognizedEntities(completion, text)
    }

    private async complete(prompt: string, maxTokens: number): Promise<string> {
        let release!: () => void
        const predecessor = this.completionTail
        this.completionTail = new Promise(resolve => { release = resolve })
        await predecessor
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)
        try {
            let response: Response
            try {
                response = await this.fetchImpl(this.endpoint, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({
                        model: this.identity.model,
                        temperature: 0,
                        stream: false,
                        max_tokens: maxTokens,
                        messages: [{ role: 'user', content: prompt }],
                    }),
                    signal: controller.signal,
                })
            } catch (error) {
                throw new Error(
                    controller.signal.aborted
                        ? 'Local HaS inference timed out'
                        : `Local HaS connection failed: ${safeError(error)}`,
                )
            }
            if (!response.ok) throw new Error(`Local HaS rejected inference (HTTP ${response.status})`)
            const body = await response.json() as {
                choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }>
            }
            const choice = body.choices?.[0]
            if (choice?.finish_reason === 'length') throw new Error('Local HaS output was truncated')
            if (typeof choice?.message?.content !== 'string') {
                throw new Error('Local HaS returned an invalid response envelope')
            }
            return choice.message.content.trim()
        } finally {
            clearTimeout(timer)
            release()
        }
    }
}

export class DeterministicHasAdapter implements HasAdapter {
    readonly identity: HasEngineIdentity = {
        adapter: 'deterministic-test-adapter',
        model: 'fixture',
        modelRevision: '1',
        promptRevision: PROMPT_REVISION,
    }

    constructor(private readonly entities: Readonly<Record<string, string>>) {}

    async hide(request: {
        text: string
        entityTypes: readonly string[]
        mapping: HasMapping
    }): Promise<{ anonymizedText: string; mappingDelta: HasMapping; identity: HasEngineIdentity }> {
        const existing = canonicalMapping(request.mapping)
        const ownerByOriginal = new Map<string, string>()
        for (const [pseudonym, originals] of Object.entries(existing)) {
            for (const original of originals) ownerByOriginal.set(original, pseudonym)
        }
        let anonymizedText = request.text
        const delta: Record<string, readonly string[]> = {}
        for (const [original, pseudonym] of Object.entries(this.entities)
            .sort(([left], [right]) => right.length - left.length)) {
            if (!anonymizedText.includes(original)) continue
            const selected = ownerByOriginal.get(original) ?? pseudonym
            anonymizedText = anonymizedText.split(original).join(selected)
            if (!ownerByOriginal.has(original)) delta[selected] = [original]
        }
        return { anonymizedText, mappingDelta: delta, identity: this.identity }
    }
}

interface RecognizedEntity {
    entityType: string
    value: string
}

function parseRecognizedEntities(value: string, source: string): RecognizedEntity[] {
    const seen = new Set<string>()
    const entities: RecognizedEntity[] = []
    let recognizedEnvelope = false
    const add = (entityType: string, original: string): void => {
        const normalizedType = entityType.trim().replace(/^["'`<\[]+|["'`>\]]+$/gu, '')
        const normalizedOriginal = original.trim().replace(/^["'`\[]+|["'`\]]+$/gu, '')
        if (
            normalizedType
            && normalizedOriginal
            && source.includes(normalizedOriginal)
            && !seen.has(normalizedOriginal)
        ) {
            seen.add(normalizedOriginal)
            entities.push({ entityType: normalizedType, value: normalizedOriginal })
        }
    }

    const normalizedEnvelope = value
        .replace(/^```(?:json)?\s*/u, '')
        .replace(/\s*```$/u, '')
        .trim()
    try {
        const parsed = JSON.parse(normalizedEnvelope) as unknown
        if (Array.isArray(parsed) && parsed.length === 0) return []
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const entries = Object.entries(parsed as Record<string, unknown>)
            if (entries.length === 0) return []
            for (const [entityType, originals] of entries) {
                if (Array.isArray(originals)) {
                    recognizedEnvelope = true
                    for (const original of originals) {
                        if (typeof original === 'string') add(entityType, original)
                    }
                }
            }
        }
    } catch {
        // Continue with the tolerant scanner used for quantized-model output.
    }

    for (const candidate of [value, value.replaceAll('\\"', '"')]) {
        const tokens = [...candidate.matchAll(/"((?:\\.|[^"\\])*)"/gu)]
        let currentType: string | undefined
        for (const token of tokens) {
            const decoded = decodeGeneratedString(token[1] ?? '')
            const after = candidate.slice((token.index ?? 0) + token[0].length)
            if (/^\s*:\s*(?:\[|\{)/u.test(after)) {
                currentType = decoded
                recognizedEnvelope = true
            } else if (currentType) {
                add(currentType, decoded)
            }
        }
        for (const line of candidate.split(/\r?\n/u)) {
            const match = line.match(/^\s*["'`<\[]?([^"'`<>\[\]:：]{1,80})["'`>\]]?\s*[:：]\s*(.+?)\s*$/u)
            if (!match) continue
            recognizedEnvelope = true
            for (const original of (match[2] ?? '').split(/[,，;；|]/u)) {
                add(match[1] ?? '', original)
            }
        }
    }
    if (!recognizedEnvelope) throw new Error('Local HaS returned unrecognizable entity output')
    return entities
}

function decodeGeneratedString(value: string): string {
    try {
        return JSON.parse(`"${value}"`) as string
    } catch {
        return value.replaceAll('\\"', '"').replaceAll('\\n', '\n').replaceAll('\\\\', '\\')
    }
}

type EntityKind = 'person' | 'employee' | 'phone' | 'identity' | 'bank' | 'email' | 'organization' | 'location' | 'generic'

function readableEntityKind(tag: string, original: string): EntityKind {
    if (/^\d{17}[\dX]$/iu.test(original)) return 'identity'
    if (/^1\d{10}$/u.test(original)) return 'phone'
    if (/^\d{15,23}$/u.test(original)) return 'bank'
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/u.test(original)) return 'email'
    if (/^[A-Z]{2,}(?:[-_ ]?[A-Z0-9]+)+$/u.test(original)) return 'employee'
    if (/银行卡|bank\s*card/iu.test(tag)) return 'bank'
    if (/身份证|identity|id\s*card|citizen/iu.test(tag)) return 'identity'
    if (/手机|电话|phone|mobile|telephone/iu.test(tag)) return 'phone'
    if (/邮箱|邮件|email/iu.test(tag)) return 'email'
    if (/员工编号|^employee$|employee[.\s_-]*id|staff[.\s_-]*id/iu.test(tag)) return 'employee'
    if (/个人姓名|姓名|person|employee\.name|\.name/iu.test(tag)) return 'person'
    if (/组织|公司|机构|organization|company/iu.test(tag)) return 'organization'
    if (/地址|地点|location|address/iu.test(tag)) return 'location'
    return 'generic'
}

function nextPseudonym(
    kind: EntityKind,
    original: string,
    used: ReadonlySet<string>,
    source: string,
): string {
    for (let index = 1; index < 100_000; index += 1) {
        const candidate = renderPseudonym(kind, index)
        if (!used.has(candidate) && candidate !== original && !source.includes(candidate)) return candidate
    }
    throw new Error(`Pseudonym space exhausted for ${kind}`)
}

const surnames = ['李', '王', '赵', '陈', '刘', '杨', '黄', '周', '吴', '徐', '孙', '胡']
const givenNames = ['四', '芳', '伟', '静', '磊', '敏', '浩然', '雨桐', '嘉宁', '思远']
const organizations = ['远山科技', '青禾教育', '星海咨询', '云川服务', '明川实业', '新岸文化']
const locations = ['杭州市西湖区', '南京市鼓楼区', '成都市武侯区', '武汉市江汉区', '西安市雁塔区']

function renderPseudonym(kind: EntityKind, index: number): string {
    if (kind === 'person') {
        const capacity = surnames.length * givenNames.length
        return index <= capacity
            ? `${surnames[(index - 1) % surnames.length]}${givenNames[Math.floor((index - 1) / surnames.length) % givenNames.length]}`
            : `匿名员工${String(index).padStart(6, '0')}`
    }
    if (kind === 'employee') return `员工${String.fromCharCode(65 + (index - 1) % 26)}${String(index).padStart(3, '0')}`
    if (kind === 'phone') return `${['186', '185', '188', '176', '166'][(index - 1) % 5]}${String((10_000_000 + index * 7_919) % 100_000_000).padStart(8, '0')}`
    if (kind === 'identity') return citizenId(index)
    if (kind === 'bank') return bankCard(index)
    if (kind === 'email') return `contact${String(index).padStart(3, '0')}@example.cn`
    if (kind === 'organization') return organizations[index - 1] ?? `虚构机构${String(index).padStart(4, '0')}`
    if (kind === 'location') return locations[index - 1] ?? `虚构地点${String(index).padStart(4, '0')}`
    return `替代内容${index}`
}

function isStandaloneNumber(value: string): boolean {
    return /^[¥￥$€£]?\s*-?\d[\d,]*(?:\.\d+)?\s*(?:元|万元|%|％)?$/u.test(value.trim())
}

function citizenId(index: number): string {
    const areas = ['110101', '310101', '320106', '330106', '420103', '510107']
    const base = `${areas[(index - 1) % areas.length]}${1980 + index % 25}${String(index % 12 + 1).padStart(2, '0')}${String(index % 27 + 1).padStart(2, '0')}${String(100 + index % 899).padStart(3, '0')}`
    const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
    const checks = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']
    const sum = [...base].reduce((total, digit, position) => total + Number(digit) * (weights[position] ?? 0), 0)
    return `${base}${checks[sum % 11]}`
}

function bankCard(index: number): string {
    const body = `622202${String(10_000_000_000 + index * 104_729).padStart(12, '0').slice(-12)}`
    let sum = 0
    let double = true
    for (let position = body.length - 1; position >= 0; position -= 1) {
        let digit = Number(body[position])
        if (double) {
            digit *= 2
            if (digit > 9) digit -= 9
        }
        sum += digit
        double = !double
    }
    return `${body}${(10 - sum % 10) % 10}`
}

function assertProtectedNumericFacts(
    original: string,
    sanitized: string,
    delta: HasMapping,
): void {
    let originalFacts = original
    let sanitizedFacts = sanitized
    for (const [pseudonym, originals] of Object.entries(delta)) {
        sanitizedFacts = sanitizedFacts.split(pseudonym).join(' ')
        for (const value of originals) originalFacts = originalFacts.split(value).join(' ')
    }
    const tokens = (value: string): string[] => value.match(/-?\d[\d,]*(?:\.\d+)?/gu)?.sort() ?? []
    if (JSON.stringify(tokens(originalFacts)) !== JSON.stringify(tokens(sanitizedFacts))) {
        throw new Error('HaS changed a protected numeric fact; the request was blocked')
    }
}

function recognitionChunks(text: string): string[] {
    if (text.length <= RECOGNITION_MAX_CHARS) return [text]
    const chunks: string[] = []
    let start = 0
    while (start < text.length) {
        const end = Math.min(text.length, start + RECOGNITION_MAX_CHARS)
        chunks.push(text.slice(start, end))
        if (end >= text.length) break
        start = Math.max(start + 1, end - RECOGNITION_OVERLAP_CHARS)
    }
    return chunks
}

function recognitionTokenBudget(text: string): number {
    return Math.min(768, Math.max(256, Math.ceil(text.length * 1.25)))
}

function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex')
}

function safeError(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 300)
}
