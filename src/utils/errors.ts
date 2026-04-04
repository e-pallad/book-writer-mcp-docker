export class BookMCPError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookMCPError";
  }
}

export function requireRegistry() {
  throw new BookMCPError(
    "No book project found. Run book_init first to initialize a project."
  );
}
