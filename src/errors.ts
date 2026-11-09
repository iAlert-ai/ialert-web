/** Error returned by the iAlert API: `{ message, code, errors? }`. */
export class IAlertError extends Error {
    readonly status: number;
    readonly code: string;
    readonly errors: Record<string, string[]> | undefined;

    constructor(status: number, code: string, message: string, errors?: Record<string, string[]>) {
        super(message);
        this.name = "IAlertError";
        this.status = status;
        this.code = code;
        this.errors = errors;
    }
}
