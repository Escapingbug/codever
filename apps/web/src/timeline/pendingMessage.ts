export interface PendingUserAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
}

export interface PendingUserMessage {
  clientMessageId: string
  sessionId: string
  text: string
  attachments: PendingUserAttachment[]
  createdAt: string
  status: 'sending' | 'accepted'
}
