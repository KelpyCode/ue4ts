import * as Lua from "npm:luaparse"
import * as Annotation from "./annotation-parser.ts"
import { globSync as glob } from "npm:glob";
import { parse } from "./lua-parser.ts"

type TSType = TSTypeRefExpression | TSFunctionExpression | TSOrTypeExpression  | TSConstValueExpression

interface TSConstValueExpression {
    type: "ConstValueExpression"
    value: string | number | boolean
}

interface TSTypeRefExpression {
    type: "TypeRefExpression"
    name: string
    generics?: string[]
}

interface TSFunctionExpression {
    type: "FunctionExpression"
    name: string
    generics?: string[]
    static: boolean
    params: Map<string, TSType>
}

interface TSOrTypeExpression {
    type: "OrTypeExpression"
    types: TSType[]
}

type TSStatement = TSFunctionStatement | TSEnumStatement | TSClassStatement | TSAliasStatement

interface TSEnumStatement {
    type: "EnumStatement"
    name: string
    entries: [string, string][]
}

interface TSFunctionStatement {
    type: "FunctionStatement"
    name: string
    static: boolean
    baseType?: string
    generics: string[]
    params: Map<string, TSType>
    returnType?: TSType
}

interface TSClassStatement {
    type: "ClassStatement"
    name: string
    generics: string[]
    extends?: TSType
    fields: Map<string, TSType>
}

interface TSAliasStatement {
    type: "AliasStatement"
    name: string
    typeName: string
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

function readComments(comments: Annotation.ASTNode[]) {
    const ret = {
        isEnum: false,
        isClass: false
    }

    comments.forEach(comment => {
        switch (comment.kind) {
            case "enum":
                ret.isEnum = true;
                break;
            case "class":
                ret.isClass = true;
                break;
            default:
                break;
        }
    })

    return ret
}

// Collect all used types in a Set
const usedTypes = new Set<string>();

// Replace renderNode to return key/value AST entries
function renderNode(node: Lua.Node, comments: Annotation.ASTNode[] = []): [string, TSType] {
    const _meta = readComments(comments);
    let result: [string, TSType] = ["", { type: "ConstValueExpression", value: "" }];
    $route(node, {
        "TableKeyString": t => { result = [t.key.name, renderExpression(t.value)]; },
        "TableKey": t => {
            const keyExpr = renderExpression(t.key) as TSTypeRefExpression;
            result = [keyExpr.name, renderExpression(t.value)];
        }
    });
    return result;
}

// Replace renderExpression to build and return TSType and collect used types
function renderExpression(node: Lua.Expression, _comments: Annotation.ASTNode[] = []): TSType {
    let typeNode: TSType | undefined;
    $route(node, {
        "Identifier": i => {
            typeNode = { type: "TypeRefExpression", name: i.name };
            usedTypes.add(i.name);
        },
        "MemberExpression": m => {
            const base = renderExpression(m.base) as TSTypeRefExpression;
            const name = `${base.name}${m.indexer}${(m.identifier as Lua.Identifier).name}`;
            typeNode = { type: "TypeRefExpression", name };
            usedTypes.add(name);
        },
        "StringLiteral": s => {
            typeNode = { type: "ConstValueExpression", value: s.value };
            usedTypes.add("string");
        },
        "NumericLiteral": n => {
            typeNode = { type: "ConstValueExpression", value: n.value };
            usedTypes.add("number");
        },
        "BooleanLiteral": b => {
            typeNode = { type: "ConstValueExpression", value: b.value };
            usedTypes.add("boolean");
        }
    });
    if (!typeNode) throw new Error(`Unsupported expression type: ${node.type}`);
    return typeNode;
}

// Replace renderStatement to return AST statements and utilize usedTypes
function renderStatement(node: Lua.Statement, comments: Annotation.ASTNode[]): TSStatement | null {
    let stmt: TSStatement | null = null;
    const _meta = readComments(comments);
    $route(node, {
        "AssignmentStatement": assignment => {
            const varName = assignment.variables.map(x => (x as Lua.Identifier).name).join(", ");
            const entries: Array<[string, TSType]> = [];
            assignment.init.forEach(init => $route(init, {
                "TableConstructorExpression": table => {
                    table.fields.forEach(field => { entries.push(renderNode(field, comments)); });
                }
            }));
            if (_meta.isClass) {
                stmt = { type: "ClassStatement", name: varName, generics: [], fields: new Map(entries) };
            } else if (_meta.isEnum) {
                stmt = { type: "EnumStatement", name: varName,
                    entries: entries.map(([k, v]) => [k, v.type === "ConstValueExpression" ? v.value.toString() : JSON.stringify(v)])
                };
            }
        }
    });
    return stmt;
}

export function transpile(path: string[]): { statements: TSStatement[]; types: string[]; commentBlocks: Annotation.ASTNode[][] } {

    // Clear previously collected types
    usedTypes.clear();
    const statements: TSStatement[] = [];
    const commentBlocks = new Set<Annotation.ASTNode[]>();
    const paths = new Set(path.flatMap(p => glob(p)));

    paths.forEach(p => {
        const source = Deno.readFileSync(p);
        const sourceString = new TextDecoder().decode(source);

        Deno.writeTextFileSync("./debug.annotations.json", JSON.stringify(Annotation.parseAnnotations(sourceString.split("\n")), null, 2))

        const { parsedCommentMap, commentBlocks: localBlocks } = parse(sourceString);
        // Process node-specific comment annotations
        parsedCommentMap.entries().forEach(([node, comments]) => {
            const stmt = renderStatement(node, comments);
            if (stmt) {
                statements.push(stmt);
            }
        });
        // Merge unattached comment blocks
        localBlocks.forEach(b => commentBlocks.add(b));
    });

    // Return collected AST statements, used types, and commentBlocks
    return { statements, types: Array.from(usedTypes), commentBlocks: Array.from(commentBlocks) };
}

console.log(transpile(["./shared/types/Types.lua"]))

setInterval(() => { }, 50000)