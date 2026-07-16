import { z } from 'zod'
import { IsoDateTimeSchema, OpaqueIdSchema, parseWithSchema } from './common'

export const CLIENT_EVENT_PROTOCOL = 'codever.events.v1'

export const AccountRoleSchema = z.enum(['viewer', 'operator', 'gateway_admin', 'admin'])

export const AccountProfileSchema = z.object({
    id: OpaqueIdSchema,
    username: z.string().trim().min(1),
    workspaceId: OpaqueIdSchema,
    roles: z.array(AccountRoleSchema),
}).strict()

export const LoginDtoSchema = z.object({
    username: z.string().trim().min(1),
    password: z.string().min(1),
    deviceName: z.string().trim().min(1).max(120).optional(),
}).strict()

export const AuthSessionDtoSchema = z.object({
    expiresAt: IsoDateTimeSchema,
    user: AccountProfileSchema,
}).strict()

export const LoginResultDtoSchema = AuthSessionDtoSchema.extend({
    accessToken: z.string().min(20),
}).strict()

export type AccountRole = z.infer<typeof AccountRoleSchema>
export type AccountProfile = z.infer<typeof AccountProfileSchema>
export type LoginDto = z.infer<typeof LoginDtoSchema>
export type AuthSessionDto = z.infer<typeof AuthSessionDtoSchema>
export type LoginResultDto = z.infer<typeof LoginResultDtoSchema>

export const parseLoginDto = (value: unknown): LoginDto => parseWithSchema(LoginDtoSchema, value)
export const parseAuthSessionDto = (value: unknown): AuthSessionDto => parseWithSchema(AuthSessionDtoSchema, value)
export const parseLoginResultDto = (value: unknown): LoginResultDto => parseWithSchema(LoginResultDtoSchema, value)
