import * as Lua from "npm:luaparse"
import * as Annotation from "./annotation-parser.ts"

export function parse(source: string): { parsedCommentMap: Map<Lua.Statement, Annotation.ASTNode[]>; commentBlocks: Set<Annotation.ASTNode[]> } {
    const commentMap = new Map<Lua.Statement, Lua.Comment[]>()
    const parsedCommentMap = new Map<Lua.Statement, Annotation.ASTNode[]>()
    const commentBlocks = new Set<Annotation.ASTNode[]>();

    const ast = Lua.parse(source, {comments: true, ranges: true, locations: true, scope: true, luaVersion: "5.3"})
    for (const node of ast.body) {
        // Find comments right above the node
        const line = node.loc!.start.line;

        const comments: Lua.Comment[] = [];
        let lastSafeLine = -1;
            
        // Get all comments that are above the node. If there is a line missing between, ignore all above
        (ast.comments as unknown as Lua.Comment[]).reverse()?.forEach((comment) => {
            const commentLine = comment.loc!.start.line;
            if (line - 1 === commentLine || commentLine === lastSafeLine - 1) {
                comments.push(comment);
                lastSafeLine = commentLine
            } else {
                lastSafeLine = -1
            }

        })

        commentMap.set(node, comments.reverse())

        const astComments = Annotation.parseAnnotations(comments.reverse().map((comment) => comment.raw))
        parsedCommentMap.set(node, astComments)
        // console.log(node);
    }
    // Collect all comments and map by line
    const allComments = ast.comments as unknown as Lua.Comment[];
    const commentByLine = new Map<number, Lua.Comment>();
    allComments.forEach(c => commentByLine.set(c.loc!.start.line, c));
    // Mark assigned comments: for each statement, walk contiguous comments immediately above it (tags or pure)
    const assignedComments = new Set<Lua.Comment>();
    for (const node of commentMap.keys()) {
        let line = (node.loc!.start.line || 0) - 1;
        while (true) {
            const c = commentByLine.get(line);
            if (!c) break;
            assignedComments.add(c);
            line--;
        }
    }
    // Orphan pure comments: pure '---' lines not assigned and not annotation tags
    const unassigned = allComments.filter(c => {
        const raw = c.raw.trim();
        return raw.startsWith('---') && !raw.startsWith('---@') && !assignedComments.has(c);
    });
    // Group contiguous unassigned comments into blocks
    const sorted = unassigned.slice().sort((a, b) => a.loc!.start.line - b.loc!.start.line);
    let block: Lua.Comment[] = [];
    let prevLine = -Infinity;
    const flush = (b: Lua.Comment[]) => {
        if (b.length === 0) return;
        const astNodes = Annotation.parseAnnotations(b.map(cm => cm.raw));
        commentBlocks.add(astNodes);
    };
    for (const c of sorted) {
        const ln = c.loc!.start.line;
        if (ln === prevLine + 1) {
            block.push(c);
        } else {
            flush(block);
            block = [c];
        }
        prevLine = ln;
    }
    flush(block);
    return { parsedCommentMap, commentBlocks };

}

export function traverseAst(ast: Lua.Chunk, callback: (node: Lua.Node) => void) {
    ast.body.forEach((node) => {
        traverse(node, callback);
    })
}

export function traverse(node: Lua.Node, callback: (node: Lua.Node) => void) {
    callback(node);
    for (const key in node) {
        const child = (node as unknown as Record<string, unknown>)[key];
        if (Array.isArray(child)) {
            child.forEach((n) => traverse(n, callback));
        } else if (typeof child === "object" && child !== null) {
            traverse(child as Lua.Node, callback);
        }
    
    }
}

// const source = await Deno.readFile("./shared/types/Types.lua")

// const sourceString = new TextDecoder().decode(source);

// console.log(sourceString);
// console.log(parse(sourceString))
// Deno.writeFileSync("./output.json", new TextEncoder().encode(JSON.stringify(parse(sourceString), null, 2)));