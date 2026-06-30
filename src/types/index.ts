export type PublisherPayload = {
  publisherId: string
  email: string
  role: 'publisher'
}

export type ReaderPayload = {
  articleId: string
  readerFingerprint: string
}

export type AppEnv = {
  Variables: {
    publisher: PublisherPayload
  }
}
