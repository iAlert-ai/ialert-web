import type { KeyValueStorage } from "./types.ts";

/** In-memory storage for environments without localStorage (private mode, workers, tests). */
export class MemoryStorage implements KeyValueStorage {
    private readonly items = new Map<string, string>();

    getItem(key: string): string | null {
        return this.items.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.items.set(key, value);
    }

    removeItem(key: string): void {
        this.items.delete(key);
    }
}

/** localStorage when it works, otherwise memory (it throws in some private windows). */
export function defaultStorage(): KeyValueStorage {
    try {
        const storage = globalThis.localStorage;
        const probe = "__ialert_probe__";
        storage.setItem(probe, "1");
        storage.removeItem(probe);

        return storage;
    } catch {
        return new MemoryStorage();
    }
}

/** Namespaced JSON helpers over a KeyValueStorage; never throws. */
export class Store {
    private readonly storage: KeyValueStorage;
    private readonly prefix: string;

    constructor(storage: KeyValueStorage, namespace: string) {
        this.storage = storage;
        this.prefix = `ialert:${namespace}:`;
    }

    get<T>(key: string): T | null {
        try {
            const raw = this.storage.getItem(this.prefix + key);

            return raw === null ? null : (JSON.parse(raw) as T);
        } catch {
            return null;
        }
    }

    set(key: string, value: unknown): void {
        try {
            this.storage.setItem(this.prefix + key, JSON.stringify(value));
        } catch {
            // Storage full or blocked: the SDK keeps working for this page load.
        }
    }

    remove(key: string): void {
        try {
            this.storage.removeItem(this.prefix + key);
        } catch {
            // ignore
        }
    }
}
