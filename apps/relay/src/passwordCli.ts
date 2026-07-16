import { stdin, stdout } from 'node:process'
import { hashPassword } from './accountAuth'

if (stdin.isTTY) {
    throw new Error('Pipe the password to this command on stdin; command-line password arguments are intentionally unsupported')
}

const chunks: Buffer[] = []
for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
stdout.write(`${await hashPassword(password)}\n`)
