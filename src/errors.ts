// An error the HTTP API answers with its status: 400 for what you sent, 404, 409 for a state that refuses it, 502 for GitHub.
export class DeskError extends Error {
  status: number;
  candidates?: string[];
  constructor(status: number, message: string, candidates?: string[]) {
    super(message);
    this.status = status;
    this.candidates = candidates;
  }
}
