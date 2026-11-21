export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: { currentRevision?: number },
  ) {
    super(message);
  }
}
