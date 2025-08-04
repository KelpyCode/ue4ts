import * as Lua from "npm:luaparse"
import * as Annotation from "./annotation-parser.ts"
import { globSync as glob } from "npm:glob";
import { parse } from "./lua-parser.ts"
import { FIXERS } from './fixers.ts';
import { relative, dirname, join } from "https://deno.land/std@0.224.0/path/mod.ts";
import { encodeHex } from "jsr:@std/encoding/hex";
import packageInfo from "../deno.json" with { type: "json" };
import { hash } from "node:crypto";
import { MetaHandler } from "./MetaHandler.ts";
const INTERNALS = [
    "string", "number", "boolean", "function", "unknown", "any", "void", "null", "undefined"
]


const TYPE_REPLACERS = {
    "integer": "number",
    "float": "number",
    "string": "string",
    "boolean": "boolean",
    "nil": "null",
    "lightuserdata": "Record<string, any>",
    "table": "Record<string, any>",
}

const FALLBACK_DEFS = {
    "TWeakObjectPtr": "type TWeakObjectPtr<T = any> = unknown",
    "TObjectPtr": "type TObjectPtr<T = any> = unknown",
    "TFieldPath": "type TFieldPath<T = any> = unknown",
    "TLazyObjectPtr": "type TLazyObjectPtr<T = any> = unknown",
    "RemoteObject": ""
} as Record<string, string>;

const DEBUG_FORCE_REBUILD = true

async function generateHash(str: string) {
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return encodeHex(new Uint8Array(hashBuffer));
}

async function generateFnHash(path: string): Promise<string> {
    return await generateHash(`${packageInfo.version}::${path}`);
}

async function generateFcHash(path: string, render: string): Promise<string> {
    const x = await generateHash(`${packageInfo.version}::${path}::${render}`);
    // console.log("Generated fc hash ", path, render.length)
    // console.log(x)
    return x

}



const metadataHandler = new MetaHandler()


type TSType = TSTypeRefExpression | TSFunctionExpression | TSOrTypeExpression | TSConstValueExpression | TSUnaryExpression

interface TSBase {
    comments?: string[]
}

interface TSConstValueExpression extends TSBase {
    type: "ConstValueExpression"
    value: string | number | boolean
}

interface TSUnaryExpression extends TSBase {
    type: "UnaryExpression"
    operator: "minus" | "not"
    argument: TSType
}

interface TSTypeRefExpression extends TSBase {
    type: "TypeRefExpression"
    name: string
    generics?: string[]
}

interface TSFunctionExpression extends TSBase {
    type: "FunctionExpression"
    name: string
    generics?: string[]
    static: boolean
    params: Map<string, string>
}

interface TSOrTypeExpression extends TSBase {
    type: "OrTypeExpression"
    types: string[]
}

type TSStatement = TSFunctionStatement | TSEnumStatement | TSClassStatement | TSAliasStatement | TSDeclareObjectStatement | TSExportStatement

interface TSEnumStatement extends TSBase {
    type: "EnumStatement"
    name: string
    entries: [string, string][]
}

interface TSExportStatement extends TSBase {
    type: "ExportStatement"
    name: string
}

interface TSFunctionStatement extends TSBase {
    type: "FunctionStatement"
    name: string
    static: boolean
    baseType?: string
    generics: string[]
    params: Map<string, { type: string, description?: string }>
    returnType?: string
}

interface TSClassStatement extends TSBase {
    type: "ClassStatement"
    name: string
    generics: string[]
    extends?: string
    fields: {
        name: string;
        type: string;
        description?: string;
    }[]
    tableType?: string
    useType: boolean
}

interface TSDeclareObjectStatement extends TSBase {
    type: "DeclareObjectStatement"
    name: string
}


interface TSAliasStatement extends TSBase {
    type: "AliasStatement"
    name: string
    typeName: string
}


function replaceType(type: string): string {
    type = type.replace("::Type", "")

    return TYPE_REPLACERS[type as keyof typeof TYPE_REPLACERS] || type;
}

export function $route<
    Statement extends Lua.Statement | Lua.Expression | Lua.Node,
    Type extends Statement["type"],
    Value extends Statement & { type: Type }
>(
    statement: Statement,
    routes: Partial<{ [K in Statement["type"]]: (node: Extract<Statement, { type: K }>) => void }>
) {
    const handler = routes[statement.type as Type];
    if (handler) {
        // @ts-expect-error: handler parameter typing mismatch
        handler(statement as Extract<Statement, { type: typeof statement.type }>);
    }
}

function readComments(types: string[], comments: Annotation.ASTNode[]) {
    const ret = {
        isEnum: false,
        classes: [] as Array<{ name: string, generics?: string[], extends?: string, tableType?: string, useType?: boolean }>,
        fields: [] as Array<{ name: string, type: string, description?: string }>,
        params: [] as Array<{ name: string, type: string, description?: string }>,
        returnType: undefined as string | undefined,
        comments: [] as string[],
        aliases: [] as Array<{ name: string, type: string }>,
    }

    comments.forEach(comment => {
        switch (comment.kind) {
            case "enum":
                ret.isEnum = true;
                break;
            case "class": {
                const extender = comment.extends
                let useType = false
                if (extender === "string") {
                    useType = true
                }

                ret.classes.push({
                    name: comment.name,
                    generics: comment.generics,
                    extends: comment.extends,
                    tableType: comment.tableType ? renderTypeNode(types, comment.tableType) : undefined,
                    useType
                });
                break;
            }
            case "field":
                ret.fields.push({
                    name: comment.name,
                    type: renderTypeNode(types, comment.type),
                    description: comment.description
                });
                break;
            case "param":
                ret.params.push({
                    name: comment.name,
                    type: renderTypeNode(types, comment.type),
                    description: comment.description
                });
                break;
            case "return": {
                ret.returnType = renderTypeNode(types, comment.type);
                break;
            }
            case "comment": {
                ret.comments.push(comment.text);
                break;
            }
            case "alias": {
                const type = renderTypeNode(types, comment.type);
                ret.aliases.push({
                    name: comment.name,
                    type: type
                })
                break
            }
            default:
                break;
        }
    })

    return ret
}

function shouldAddUsedType(type: string): string[] {
    if (type.length <= 1) return []; // Avoid generics
    if (INTERNALS.includes(type)) return []; // Skip internal types
    if (/^[a-zA-Z0-9_]+$/gm.test(type)) return [type]; // Skip single character types
    return []
}

function renderTypeNode(types: string[], node: Annotation.TypeNode): string {
    //Render as Typescript
    switch (node.kind) {
        case "simple": {
            const type = replaceType(node.name);
            types.push(...shouldAddUsedType(type));
            return type;
        }
        case "generic": {
            const type = replaceType(node.base);
            types.push(...shouldAddUsedType(type));
            return `${type}<${node.parameters.map(x => renderTypeNode(types, x)).join(", ")}>`;
        }
        case "union": {
            return node.options.map(x => renderTypeNode(types, x)).join(" | ");
        }
        case "function": {
            const retType = renderTypeNode(types, node.returnType ?? { kind: "simple", name: "void" });
            const params = node.parameters.map(x => {
                const paramType = renderTypeNode(types, x.type);
                if (x.name === "...") {
                    return `...args: any[]`;
                }

                if (x.name) {
                    return `${x.name}: ${paramType}`;
                } else {
                    return paramType;
                }
            }
            ).join(", ");
            return `(${params}) => ${retType}`;
        }
        case "table": {
            let s = ""
            node.fields.map(field => {
                const key = renderTypeNode(types, field.key);
                const value = renderTypeNode(types, field.value);
                if (s.length > 0) s += ", ";
                s += `[${key}: number | string]: ${value}`;
            });
            return s;
        }
        case "array": {
            return `Array<${renderTypeNode(types, node.elementType)}>`;
        }
        case "staticArray": {
            return `[${node.elementType.map(x => renderTypeNode(types, x)).join(", ")}]`;
        }
        case "optional": {
            const type = renderTypeNode(types, node.type);
            return `${type} | undefined`;
        }
    }
}

// Collect all used types in a Set
const usedTypes = new Set<string>();

// Replace renderNode to return key/value AST entries
function renderNode(types: string[], node: Lua.Node, comments: Annotation.ASTNode[] = []): [string, TSType] {
    const _meta = readComments(types, comments);
    let result: [string, TSType] = ["", { type: "ConstValueExpression", value: "" }];
    $route(node, {
        "TableKeyString": t => {
            result = [t.key.name, renderExpression(types, t.value)];
        },
        "TableKey": t => {
            const keyExpr = renderExpression(types, t.key) as TSTypeRefExpression;
            result = [keyExpr.name, renderExpression(types, t.value)];
        }
    });
    return result;
}

// Replace renderExpression to build and return TSType and collect used types
function renderExpression(types: string[], node: Lua.Expression, comments: string[] = []): TSType {
    let typeNode: TSType | undefined;
    $route(node, {
        "Identifier": i => {
            typeNode = { type: "TypeRefExpression", name: i.name, comments };
            usedTypes.add(i.name);
        },
        "MemberExpression": m => {
            const base = renderExpression(types, m.base) as TSTypeRefExpression;
            const name = `${base.name}${m.indexer}${(m.identifier as Lua.Identifier).name}`;
            typeNode = { type: "TypeRefExpression", name, comments };
            usedTypes.add(name);
        },
        "StringLiteral": s => {
            typeNode = { type: "ConstValueExpression", value: s.value, comments };
            usedTypes.add("string");
        },
        "NumericLiteral": n => {
            typeNode = { type: "ConstValueExpression", value: n.value, comments };
            usedTypes.add("number");
        },
        "BooleanLiteral": b => {
            typeNode = { type: "ConstValueExpression", value: b.value, comments };
            usedTypes.add("boolean");
        },
        "UnaryExpression": u => {
            const expr = renderExpression(types, u.argument);
            // Handle minus
            if (u.operator === "-") {
                typeNode = { type: "UnaryExpression", operator: "minus", argument: expr };
            }
        }
    });
    if (!typeNode) throw new Error(`Unsupported expression type: ${node.type}`);
    return typeNode;
}

// Replace renderStatement to return AST statements and utilize usedTypes
function renderStatement(types: string[], node: Lua.Statement | null, comments: Annotation.ASTNode[]): TSStatement[] {
    const statements: TSStatement[] = [];
    const meta = readComments(types, comments);
    if (node) {
        $route(node, {
            "ReturnStatement": ret => {
                ret.arguments.forEach(arg => {
                    $route(arg, {
                        "Identifier": id => {
                            statements.push({
                                type: "ExportStatement",
                                name: id.name,
                            })
                        }
                    })
                })
            },
            "LocalStatement": local => {
                if (!meta.isEnum) {
                    local.init.forEach(init => {
                        $route(init, {
                            "TableConstructorExpression": table => {
                                if (meta.classes.length) {
                                    const _extends = meta.classes.flatMap(x => x.extends ?? [])?.[0] ?? undefined;
                                    if (_extends) types.push(_extends)
                                    const generics = meta.classes.flatMap(x => x.generics ?? []);
                                    statements.push({
                                        type: "ClassStatement",
                                        name: meta.classes[0].name,
                                        generics,
                                        extends: _extends,
                                        fields: meta.fields,
                                        comments: meta.comments,
                                        useType: false
                                    });
                                } else {
                                    const x: TSDeclareObjectStatement = {
                                        type: "DeclareObjectStatement",
                                        name: local.variables[0].name,
                                    };
                                    statements.push(x)
                                }
                            }
                        });
                    });
                    return
                }

                // local enum
                const varName = local.variables[0]
                if (varName.type === "Identifier") {
                    const name = varName.name

                    local.init.forEach(init => {
                        $route(init, {
                            "TableConstructorExpression": table => {


                                statements.push({
                                    type: "EnumStatement",
                                    name,
                                    entries: table.fields.map(field => {
                                        const [key, value] = renderNode(types, field);


                                        return [key, value.type === "ConstValueExpression"
                                            ? value.value.toString()
                                            : value.type === "UnaryExpression" && value.operator === "minus" && value.argument.type === "ConstValueExpression" ? "-" + value.argument.value.toString()
                                                : JSON.stringify(value)];
                                    })
                                })
                            }
                        })
                    })
                }
            },
            "FunctionDeclaration": func => {
                let name = (renderExpression(types, func.identifier as Lua.Identifier, meta.comments) as any).name
                // name = (func.identifier as Lua.Identifier).name;
                const params = new Map<string, { type: string, description?: string }>();

                let hasSelf = false
                if (meta.params.length) {
                    meta.params.forEach(param => {
                        if (param.name === "self") {
                            hasSelf = true
                            return
                        }
                        if (param.name !== "...") {
                            params.set(param.name, { type: param.type, description: param.description });
                        } else {
                            params.set("...args", { type: "any[]" });
                        }
                    });
                } else {
                    func.parameters.forEach(param => {
                        if (param.type === "Identifier") {
                            if (param.name === "self") {
                                hasSelf = true
                                return
                            }
                            params.set((param as Lua.Identifier).name, { type: "any" });
                        } else if (param.type === "VarargLiteral") {
                            params.set("...args", { type: "any[]" });
                        }
                    });
                }
                const returnType = meta.returnType
                statements.push({
                    type: "FunctionStatement",
                    name,
                    static: !hasSelf,
                    generics: meta.classes.flatMap(x => x.generics ?? []),
                    params,
                    comments: meta.comments,
                    returnType,
                });
            },
            "AssignmentStatement": assignment => {
                const varName = assignment.variables.map(x => (x as Lua.Identifier).name).join(", ");
                const entries: Array<[string, TSType]> = [];
                assignment.init.forEach(init => $route(init, {
                    "TableConstructorExpression": table => {
                        table.fields.forEach(field => { entries.push(renderNode(types, field, comments)); });
                    }
                }));
                if (meta.classes.length) {
                    statements.push({
                        type: "ClassStatement",
                        name: varName,
                        generics: [],
                        fields: meta.fields,
                        useType: false,
                        comments: meta.comments,

                    });
                } else if (meta.isEnum) {
                    statements.push({
                        type: "EnumStatement", name: varName,
                        comments: meta.comments,

                        entries: entries.map(([key, value]) => {

                            return [key, value.type === "ConstValueExpression"
                                ? value.value.toString()
                                : value.type === "UnaryExpression" && value.operator === "minus" && value.argument.type === "ConstValueExpression" ? "-" + value.argument.value.toString()
                                    : JSON.stringify(value)];
                        })
                    });
                } else if (meta.aliases.length) {
                    statements.push({
                        type: "AliasStatement",
                        name: varName,
                        comments: meta.comments,
                        typeName: meta.aliases[0].type
                    })
                }
            }
        });
    } else {
        meta.classes.forEach(cls => {

            statements.push({
                type: "ClassStatement",
                name: cls.name,
                fields: meta.fields,
                generics: cls.generics ?? [],
                extends: cls.extends,
                tableType: cls.tableType,
                comments: meta.comments,
                useType: cls.useType ?? false
            })
        })

        meta.aliases.forEach(alias => {
            statements.push({
                type: "AliasStatement",
                name: alias.name,
                typeName: alias.type,
                comments: meta.comments
            })
        })
    }
    return statements;
}

export async function process(path: string[]) {
    metadataHandler.load();


    // Clear previously collected types
    const paths = new Set(path.flatMap(p => glob(p)));
    console.log("PATHS", [...paths].join(", "))
    const resultsUnfiltered = await Promise.all([...paths].map(async p => {
        console.log("Transpiling", p)
        const statements: TSStatement[] = [];
        const types: string[] = []
        const source = Deno.readFileSync(p);
        let sourceString = new TextDecoder().decode(source);
        const exportDefs = new Set<string>();

        // Deno.writeTextFileSync("./debug.annotations.json", JSON.stringify(Annotation.parseAnnotations(sourceString.split("\n")), null, 2))

        const previous = metadataHandler.findPath(p);
        if (!DEBUG_FORCE_REBUILD && previous) {
            const fcHash = await generateFcHash(p, sourceString);
            if (previous.fcHash === fcHash) {
                console.log(`Skipping ${p} as it has not changed.`);
                return {
                    path: p,
                    imports: previous.imports!,
                    missingDeps: previous.missingDeps!,
                    exports: previous.exports!,
                    fnHash: previous.fnHash!,
                    fcHash: previous.fcHash!,
                    sourceString,
                    skip: true
                };
            }
        }

        // Run fixer
        FIXERS.forEach(fixer => {
            if ((fixer.fileName && p.endsWith(fixer.fileName)) || !fixer.fileName) {
                if (fixer.textProcessor) {
                    // console.log(`Applying fixer for ${fixer.fileName}`);
                    sourceString = fixer.textProcessor(sourceString);
                }
            }
        })

        const { parsedCommentMap, standaloneComments } = parse(sourceString);
        // Process node-specific comment annotations
        parsedCommentMap.entries().forEach(([node, comments]) => {
            const stmt = renderStatement(types, node, comments);
            if (stmt) {
                statements.push(...stmt);
            }
        });
        // Process standalone comments
        standaloneComments.forEach(comments => {
            const stmt = renderStatement(types, null, comments);
            if (stmt) {
                statements.push(...stmt);
            }
        })
        const usedTypes = [...new Set(types)]

        const renderComments = (comments: string[]): void => {
            if (!comments.length) return
            render += `\n/**\n`;
            comments.forEach(comment => {
                render += `* ${comment}\n`;
            });
            render += `*/\n`;
        }


        const renderFunction = (func: TSStatement, globalFn = false, objectType = false): void => {
            if (func.type !== "FunctionStatement") return;
            const isStatic = !globalFn && func.name.includes(".");
            const name = globalFn ? func.name : isStatic ? func.name.split(".")[1] : func.name.split(":")[1];

            renderComments(func.comments || []);
            const params = Array.from(func.params.entries()).map(([k, v]) => `${k}: ${v.type}`);

            if (isStatic) {
                params.unshift("this: void");
            }
            const returnType = func.returnType ? `${func.returnType}` : "void";

            if (objectType) {
                render += `    ${name}(${params.join(", ")}): ${returnType},\n`;
                return
            }

            if (!globalFn)
                render += `    ${isStatic ? "static " : ""}${name}(${params.join(", ")}): ${returnType};\n`;
            else {
                exportDefs.add(name);
                render += `export function ${name}(${params.join(", ")}): ${func.returnType ?? "void"};\n`;
            }
        };

        let render = ""

        // Enums
        statements.filter(x => x.type === "EnumStatement").forEach(enumStmt => {
            if (enumStmt.type !== "EnumStatement") return
            exportDefs.add(enumStmt.name);
            renderComments(enumStmt.comments || []);

            render += `export enum ${enumStmt.name} {\n`
            enumStmt.entries.forEach(([key, value]) => {
                render += `    ${key} = ${value},\n`
            })
            render += `}\n\n`
        })

        // Aliases
        statements.filter(x => x.type === "AliasStatement").forEach(alias => {
            if (alias.type !== "AliasStatement") return
            renderComments(alias.comments || []);

            exportDefs.add(alias.name);
            render += `export type ${alias.name} = ${alias.typeName};\n`
        })

        // Global Functions
        statements.filter(x => x.type === "FunctionStatement" && !x.name.includes(":") && !x.name.includes(".")).forEach(func => {
            if (func.type !== "FunctionStatement") return
            renderFunction(func, true)
        })

        statements.filter(x => x.type === "DeclareObjectStatement").forEach(decl => {
            const funcs = statements.filter(x => x.type === "FunctionStatement" && (x.name.startsWith(decl.name + ":") || x.name.startsWith(decl.name + ".")));

            if (!funcs.length) {
                render += `declare const ${decl.name} = any;\n`
                return
            }
            render += `declare const ${decl.name}: {\n`
            funcs.forEach(func => {
                renderFunction(func, false, true);
            });
            render += "}\n\n"
        })

        // Classes
        statements.filter(x => x.type === "ClassStatement").forEach(cls => {
            exportDefs.add(cls.name);
            renderComments(cls.comments || []);

            if (cls.useType) {
                render += `export type ${cls.name}${cls.generics.length ? `<${cls.generics.join(", ")}>` : ""} = ${cls.extends}\n`
                return
            }

            render += `export class ${cls.name}${cls.generics.length ? `<${cls.generics.map(x => x + ' = unknown').join(", ")}>` : ""}${cls.extends ? ` extends ${cls.extends}` : ""} {\n`
            if (cls.tableType) {
                render += `    ${cls.tableType}\n`
            }


            // Functions
            statements.filter(x => x.type === "FunctionStatement" && (x.name.startsWith(cls.name + ":") || x.name.startsWith(cls.name + ".")))
                .forEach(x => renderFunction(x, false))

            cls.fields.forEach(field => {
                render += `    ${field.name}: ${field.type};\n`
            })
            render += `}\n\n`
        })

        statements.filter(x => x.type === "ExportStatement").forEach(exportStmt => {
            if (exportStmt.type !== "ExportStatement") return
            render += `export default ${exportStmt.name};\n\n`
        })

        render = `/**\n ** UE4TS generated file\n*/\n\n\n` + render


        const foreignTypes = usedTypes.filter(x => !exportDefs.has(x) && !INTERNALS.includes(x));


        // Deno.writeTextFileSync("./debug.output.d.ts", render)

        return { path: p, statements, exportDefs, usedTypes, foreignTypes, notFound: new Set<string>(), render, imports: new Map<string, string[]>(), sourceString, skip: false };
    }));

    const results = resultsUnfiltered.filter(x => !x.skip)

    // Add imports for foreign types
    results.forEach(result => {
        result.foreignTypes?.forEach(type => {
            // Find a result that exports this type
            const foreign = results.find(r => r.exportDefs?.has(type));
            if (foreign) {
                if (!result.imports.has(foreign.path)) {
                    result.imports.set(foreign.path, []);
                }
                result.imports.get(foreign.path)?.push(type);
            } else {
                const metaEntries = metadataHandler.findExport(type);
                if (metaEntries.length > 0) {
                    // If we have metadata, we can use it to find the path
                    const metaEntry = metaEntries[0];
                    const path = metaEntry.path;
                    if (!result.imports.has(path)) {
                        result.imports.set(path, []);
                    }
                    result.imports.get(path)?.push(type);
                } else {
                    // If no result exports this type, add it to notFound
                    result.notFound.add(type);
                    console.warn(`Foreign type ${type} not found in any result.`);
                }
            }
        });

        // If there are not found types, declare them with unknown
        if (result.notFound!.size > 0) {
            result.render += "// Unresolved dependencies\n";
            [...result.notFound].forEach(type => {
                if (FALLBACK_DEFS[type]) {
                    result.render += `${FALLBACK_DEFS[type]}\n`;
                } else
                    result.render += `type ${type} = unknown;\n`
            })
            result.render += "// -------------\n\n"
        }
    });
    // Generate import statements
    results.forEach(result => {
        const outputPath = "./output/" + result.path.replace(/^[a-zA-Z]:[\\/]/, "").replace(/\\/g, "/").replace(/\.lua$/, ".d.ts");
        const outputDir = outputPath.substring(0, outputPath.lastIndexOf("/"));
        const imports = Array.from(result.imports.entries()).map(([path, types]) => {
            const importFilePath = "./output/" + path.replace(/^[a-zA-Z]:[\\/]/, "").replace(/\\/g, "/").replace(/\.lua$/, ".d.ts");
            let relPath = relative(outputDir, importFilePath).replaceAll("\\", "/");
            if (!relPath.startsWith(".")) relPath = "./" + relPath;
            return `import type { ${types.join(", ")} } from "${relPath}";`;
        }).join("\n");
        result.render = imports + (imports ? "\n\n" : "") + result.render;
    });

    // Write each result to a file
    results.forEach(result => {
        const outputPath = "./output/" + result.path.replace(/^[a-zA-Z]:[\\/]/, "").replace(/\\/g, "/").replace(/\.lua$/, ".d.ts");
        // Ensure the output directory exists
        const outputDir = outputPath.substring(0, outputPath.lastIndexOf("/"));
        Deno.mkdirSync(outputDir, { recursive: true });
        Deno.writeTextFileSync(outputPath, result.render!);
        console.log(`Generated ${outputPath} with ${result.statements!.length} statements and ${result.usedTypes!.length} used types.`);
    });

    // Generate meta json

    await Promise.all(results.map(async (result) => {
        return metadataHandler.update({
            path: result.path,
            imports: result.foreignTypes!,
            missingDeps: [...result.notFound!],
            exports: [...result.exportDefs!],
            fnHash: await generateFnHash(result.path),
            fcHash: await generateFcHash(result.path, result.sourceString!),
        });
    }));

    metadataHandler.save()


    console.log("Done")
    // Return collected AST statements, used types, and commentBlocks
    return {};
}



console.log(process(["./**/*.lua"]))


// console.log(process(["./shared/**/*.lua"]))



// setInterval(() => { }, 50000)