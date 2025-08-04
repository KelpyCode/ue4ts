/*
 * A Lua annotations parser as per https://github.com/LuaLS/lua-language-server/wiki/Annotations
 */

// AST node definitions
export type ASTNode = ParamNode | ReturnNode | ClassNode | AliasNode | FieldNode | EnumNode | MetaNode | CommentNode;

export interface ParamNode { kind: 'param'; name: string; type: TypeNode; description?: string; line: number; }
export interface ReturnNode { kind: 'return'; type: TypeNode; description?: string; line: number; }
export interface ClassNode { kind: 'class'; name: string; generics: string[]; extends?: string; tableType?: TableTypeNode; line: number; }
export interface AliasNode { kind: 'alias'; name: string; type: TypeNode; line: number; }
export interface FieldNode { kind: 'field'; name: string; type: TypeNode; description?: string; line: number; }
export interface EnumNode { kind: 'enum'; name: string; line: number; }
export interface MetaNode { kind: 'meta'; line: number; }
export interface CommentNode { kind: 'comment'; text: string; line: number; }

// Type AST nodes
export type TypeNode = SimpleTypeNode | GenericTypeNode | UnionTypeNode | FunctionTypeNode | TableTypeNode | ArrayTypeNode | StaticArrayTypeNode | OptionalTypeNode;
export interface SimpleTypeNode { kind: 'simple'; name: string; }
export interface OptionalTypeNode { kind: 'optional'; type: TypeNode; }
export interface GenericTypeNode { kind: 'generic'; base: string; parameters: TypeNode[]; }
export interface UnionTypeNode { kind: 'union'; options: TypeNode[]; }
export interface FunctionTypeNode { kind: 'function'; parameters: { name?: string; type: TypeNode }[]; returnType: TypeNode; }
export interface TableTypeNode { kind: 'table'; fields: { key: TypeNode; value: TypeNode }[]; }
export interface ArrayTypeNode { kind: 'array'; elementType: TypeNode; }
export interface StaticArrayTypeNode { kind: 'staticArray'; elementType: TypeNode[]; }

// Main parser entrypoint
let currentLine = 0
let currentLineText = ''
export function parseAnnotations(lines: string[]): ASTNode[] {
    const nodes: ASTNode[] = [];
    for (let i = 0; i < lines.length; i++) {
        currentLine = i
        const rawLine = lines[i];
        const raw = rawLine.trim();
        const lineNo = i + 1;
        currentLineText = rawLine

        // comment nodes
        if (raw.startsWith('---') && !raw.startsWith('---@') && !raw.startsWith('---|')) {
            nodes.push({ kind: 'comment', text: raw.slice(3).trim(), line: lineNo });
            continue;
        }
        // only annotation tags
        if (!raw.startsWith('---@')) continue;

        const txt = raw.slice(4).trim();
        const [tag, rest] = splitOnce(txt, ' ');
        switch (tag) {
            case 'meta':
                nodes.push({ kind: 'meta', line: lineNo });
                break;
            case 'enum':
                nodes.push({ kind: 'enum', name: rest, line: lineNo });
                break;
            case 'alias': {
                const name = rest;
                const variants: string[] = [];
                let j = i + 1;
                while (j < lines.length && lines[j].trim().startsWith('---|')) {
                    const lineVariant = lines[j].trim().slice(4).trim();
                    variants.push(lineVariant);
                    j++;
                }
                if (variants.length) {
                    nodes.push({ kind: 'alias', name, type: { kind: 'union', options: variants.map(v => parseType(v)) }, line: lineNo });
                    i = j - 1;
                } else {
                    const node = parseAlias(rest, lineNo);
                    nodes.push(node);
                }
                break;
            }
            case 'param': {
                const [name, rem] = splitOnce(rest, ' ');
                const [typeRaw, desc] = extractTypeAndDesc(rem);
                nodes.push({ kind: 'param', name, type: parseType(typeRaw), description: desc, line: lineNo });
                break;
            }
            case 'field': {
                const [name, rem] = splitOnce(rest, ' ');
                const [typeRaw, desc] = extractTypeAndDesc(rem);
                nodes.push({ kind: 'field', name, type: parseType(typeRaw), description: desc, line: lineNo });
                break;
            }
            case 'return': {
                const [typeRaw, desc] = extractTypeAndDesc(rest);
                nodes.push({ kind: 'return', type: parseType(typeRaw), description: desc, line: lineNo });
                break;
            }
            case 'class': {
                const node = parseClass(rest, lineNo);
                nodes.push(node);
                break;
            }
            default:
                // ignore unknown tags
                break;
        }
    }
    return nodes;
}

// Utilities
function splitOnce(str: string, delim: string): [string, string] {
    const idx = str.indexOf(delim);
    if (idx < 0) return [str, ''];
    return [str.slice(0, idx), str.slice(idx + delim.length).trim()];
}

function extractTypeAndDesc(str: string): [string, string] {
    let depth = 0;
    let i = 0;
    for (; i < str.length; i++) {
        const c = str[i];
        if ('<{('.includes(c)) depth++;
        else if ('>})'.includes(c)) depth--;
        // If at top level and see a space after a comma-separated type list, break
        else if (c === ' ' && depth === 0) {
            // Only break if the previous character is not a comma (to allow comma-separated types)
            let prev = i - 1;
            while (prev >= 0 && str[prev] === ' ') prev--;
            if (prev < 0 || str[prev] !== ',') break;
        }
    }
    return [str.slice(0, i).trim(), str.slice(i).trim()];
}

function splitTopLevel(input: string, sep: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    for (const c of input) {
        if ('<{('.includes(c)) depth++;
        else if ('>})'.includes(c)) depth--;
        if (c === sep && depth === 0) {
            parts.push(cur.trim());
            cur = '';
        } else cur += c;
    }
    if (cur) parts.push(cur.trim());
    return parts.filter(Boolean);
}

// tag-specific parsers now include line
function parseAlias(text: string, line: number): AliasNode {
    const [name, rem] = splitOnce(text, ' ');
    return { kind: 'alias', name, type: parseType(rem), line };
}

function parseClass(text: string, line: number): ClassNode {
    const [decl, rest] = splitOnce(text, ':');
    const m = /^([\w$]+)(?:<(.+)>)?$/.exec(decl.trim());
    if (!m) throw new Error(`[${currentLine}: ${currentLineText}] Invalid @class declaration: ${text}`);
    const name = m[1];
    const generics = m[2] ? m[2].split(',').map(s => s.trim()) : [];
    if (rest) {
        const ext = rest.trim();
        if (ext.startsWith('{')) {
            return { kind: 'class', name, generics, tableType: parseTableType(ext), line };
        }
        return { kind: 'class', name, generics, extends: ext, line };
    }
    return { kind: 'class', name, generics, line };
}

// Type parsers unchanged
function parseType(input: string): TypeNode {
    const opts = splitTopLevel(input, '|');
    return opts.length > 1
        ? { kind: 'union', options: opts.map(o => parseType(o)) }
        : parseSingle(opts[0]);
}

function parseSingle(typeStr: string): TypeNode {
    let str = typeStr?.trim();
    if (str && str.endsWith('?')) {
        return { kind: 'optional', type: parseType(str.slice(0, -1).trim()) };
    }
    // Support for tuple types like "integer, integer, integer"
    if (str && str.includes(',') && !str.startsWith('{') && !str.startsWith('fun') && !str.endsWith('[]')) {
        const tupleTypes = splitTopLevel(str, ',');
        if (tupleTypes.length > 1) {
            return {
                kind: 'staticArray',
                elementType: tupleTypes.map(t => parseType(t))
            };
        }
    }
    if (!str) throw new Error(`[${currentLine}: ${currentLineText}] Empty type`);
    if (str.endsWith('[]')) {
        const inner = str.slice(0, -2).trim();
        return { kind: 'array', elementType: parseType(inner) };
    }
    if (str.startsWith('{') && str.endsWith('}')) return parseTableType(str);
    if (str.startsWith('fun')) return parseFunctionType(str);
    const gm = /^([\w$]+)<(.+)>$/.exec(str);
    if (gm) return { kind: 'generic', base: gm[1], parameters: splitTopLevel(gm[2], ',').map(p => parseType(p)) };
    return { kind: 'simple', name: str };
}

function parseFunctionType(str: string): FunctionTypeNode {
    const trimmed = str.trim();
    if (trimmed === 'function') {
        return { kind: 'function', parameters: [], returnType: { kind: 'simple', name: 'void' } };
    }
    const headerMatch = /^fun\s*\([^)]*\)/.exec(trimmed);
    if (!headerMatch) throw new Error(`[${currentLine}: ${currentLineText}] Invalid function type: ${str}`);
    const header = headerMatch[0];
    const tail = trimmed.slice(header.length).trim();
    let retRaw: string | undefined;
    if (tail.startsWith(':')) {
        const idx = tail.indexOf(' ');
        retRaw = idx < 0 ? tail.slice(1) : tail.slice(1, idx);
    }
    const paramsRaw = header.slice(header.indexOf('(') + 1, header.lastIndexOf(')'));
    const params = splitTopLevel(paramsRaw, ',').filter(Boolean).map(p => {
        const trimmed = p.trim();
        const qm = /^([\w$]+)\s*:\s*(.+)$/.exec(trimmed);
        if (qm) {
            return { name: qm[1], type: parseType(qm[2]) };
        } else if (trimmed === '...') {
            return { name: '...', type: parseType('any') };
        } else if (trimmed) {
            return { name: trimmed, type: parseType('any') };
        }
        return { type: parseType('any') };
    });
    const returnType: TypeNode = retRaw ? parseType(retRaw) : { kind: 'simple', name: 'void' };
    return { kind: 'function', parameters: params, returnType };
}

function parseTableType(raw: string): TableTypeNode {
    const content = raw.slice(1, -1).trim();
    if (!content) return { kind: 'table', fields: [] };
    return {
        kind: 'table', fields: splitTopLevel(content, ',').map(part => {
            const tm = /^\s*\[(.+)\]\s*:\s*(.+)$/.exec(part);
            if (!tm) throw new Error(`[${currentLine}: ${currentLineText}] Invalid table field: ${part}`);
            return { key: parseType(tm[1]), value: parseType(tm[2]) };
        })
    };
}


// console.log(
//     parseAnnotations(`
// ---Just a normal comment
// ----just a normal comment 2
// ---@meta
// ---@enum Key
// ---@alias PropertyTypes
// ---| \`PropertyTypes.ObjectProperty\`
// ---| \`PropertyTypes.ObjectPtrProperty\`
// ---| \`PropertyTypes.Int8Property\`
// ---@param Data Something<A, B, C>
// ---@param PortFlags integer
// ---@field Type PropertyTypes[] PropertyTypes
// ---@class OffsetInternalInfo
// ---@param OwnerObject UObject
// ---@alias int8 integer
// ---@alias int16 integer
// ---@param Callback fun(Context: RemoteUnrealParam<AGameModeBase>)
// ---@param Callback fun(index: integer, element: RemoteUnrealParam) comment
// ---@return boolean
// local TMap = {}
// ---@class TSet<K> : { [K]: nil }
// function UEnum:GetNameByValue(Value) end
// ---@return 'RemoteUnrealParam'
// ---@class TSoftClassPtr<T> : string
// ---@class TSoftObjectPtr<T> : string
// ---@class TSubclassOf<T> : UClass
// ---@param Index integer
// function UEnum:GetEnumNameByIndex(Index) end
// ---@param Name string
// ---@param Value integer
//    ---@param Index integer
// function UEnum:InsertIntoNames(Name, Value, Index) end
//     `.trim().split('\n'))
// )