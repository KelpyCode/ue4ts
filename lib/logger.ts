import chalk from "npm:chalk"

export class Logger {
    private static instance: Logger;
    private logs: string[] = [];

    private constructor() { }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    public log(message: string): void {
        this.logs.push(message);
        console.log(message);
    }

    public getLogs(): string[] {
        return this.logs;
    }

    public clearLogs(): void {
        this.logs = [];
    }
}