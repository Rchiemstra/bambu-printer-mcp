import type { Readable } from "node:stream";
export interface ArchiveLimits {
    maxArchiveBytes: number;
    maxEntries: number;
    maxDeclaredExpansionBytes: number;
    maxGcodeBytes: number;
    maxMetadataBytes: number;
    maxCompressionRatio: number;
}
export declare const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits;
export interface SafeArchiveEntry {
    name: string;
    compressedSize: number;
    uncompressedSize: number;
    crc32: number;
}
export declare class SecureGcode3mfReader {
    readonly sourcePath: string;
    readonly plateIndex: number;
    readonly plateNumber: number;
    readonly gcodeEntryName: string;
    readonly limits: ArchiveLimits;
    readonly entries: ReadonlyMap<string, SafeArchiveEntry>;
    private constructor();
    static open(sourcePath: string, plateIndex?: number, options?: {
        signal?: AbortSignal;
        deadlineMs?: number;
        limits?: Partial<ArchiveLimits>;
    }): Promise<SecureGcode3mfReader>;
    hasEntry(name: string): boolean;
    openEntryStream(name: string, signal?: AbortSignal, deadlineMs?: number): Promise<Readable>;
    openGcodeStream(signal?: AbortSignal, deadlineMs?: number): Promise<Readable>;
    readEntryBuffer(name: string, signal?: AbortSignal, deadlineMs?: number): Promise<Buffer>;
    readOptionalEntryBuffer(name: string, signal?: AbortSignal, deadlineMs?: number): Promise<Buffer | null>;
    private verifyMd5IfPresent;
}
