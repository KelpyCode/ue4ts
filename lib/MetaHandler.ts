export type MetaDataEntry = {
    path: string;
    imports: string[];
    missingDeps: string[];
    exports: string[];
    fnHash: string;
    fcHash: string;
};
export interface MetaData {
    entries: MetaDataEntry[];
}
export type MetaDataCompressedEntry = {
    path: string;
    imports: string;
    missingDeps: string;
    exports: string;
    fnHash: string;
    fcHash: string;
};
export interface MetaDataCompressed {
    entries: MetaDataCompressedEntry[];
}
export class MetaHandler {
    private metaData: MetaData;

    constructor() {
        this.metaData = {
            entries: []
        };
    }

    load() {
        try {
            const t = Deno.readTextFileSync("./ue4ts-meta.json");
            const md = JSON.parse(t) as MetaDataCompressed;
            const md2: MetaData = {
                entries: md.entries.map(x => ({
                    path: x.path,
                    imports: x.imports.split(","),
                    missingDeps: x.missingDeps.split(","),
                    exports: x.exports.split(","),
                    fnHash: x.fnHash,
                    fcHash: x.fcHash
                } as MetaDataEntry)),
            };
            this.metaData = md2;
            console.log("Loaded meta.json with", this.metaData.entries.length, "entries");
        }
        catch (e) {
            console.error("Failed to parse meta.json", e);
            this.metaData = { entries: [] };
        }
    }

    save() {
        // Compress and save
        const compressed: MetaDataCompressed = {
            entries: this.metaData.entries.map(x => ({
                path: x.path,
                imports: x.imports.join(","),
                missingDeps: x.missingDeps.join(","),
                exports: x.exports.join(","),
                fcHash: x.fcHash,
                fnHash: x.fnHash
            }))
        };
        Deno.writeTextFileSync("./ue4ts-meta.json", JSON.stringify(compressed, null, 2));
    }

    findExport(name: string): MetaDataEntry[] {
        const entry = this.metaData.entries.filter(x => x.exports.includes(name));
        if (entry) {
            return entry;
        }
        return [];
    }

    findImport(name: string): MetaDataEntry[] {
        const entry = this.metaData.entries.filter(x => x.imports.includes(name));
        if (entry) {
            return entry;
        }
        return [];
    }

    findPath(path: string): MetaDataEntry | undefined {
        return this.metaData.entries.find(x => x.path === path);
    }

    findFile(fileName: string): MetaDataEntry | undefined {
        return this.metaData.entries.find(x => x.path.endsWith(fileName));
    }

    update(md: MetaDataEntry) {
        // Update or add the metadata, match by path
        const existingIndex = this.metaData.entries.findIndex(x => x.path === md.path);
        if (existingIndex !== -1) {
            this.metaData.entries[existingIndex] = md;
        } else {
            this.metaData.entries.push(md);
        }
    }
}
