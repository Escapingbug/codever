import type { SessionExtensionDescriptor } from '@codever/protocol'

export const HAS_SESSION_EXTENSION_ID = 'has-privacy'

export const hasSessionExtensionDescriptor: SessionExtensionDescriptor = {
    id: HAS_SESSION_EXTENSION_ID,
    name: 'HaS privacy',
    description: 'Sanitize prompts locally before Agent egress and restore Agent output locally.',
    version: '1',
    settings: [
        {
            id: 'contextId',
            type: 'text',
            label: 'Privacy context',
            description: 'Stable Metapp/app instance ID used to scope the encrypted mapping.',
            placeholder: 'payroll-system-id',
            required: true,
        },
        {
            id: 'reviewRequired',
            type: 'boolean',
            label: 'Review every sanitized prompt before sending',
            defaultValue: true,
        },
    ],
}
