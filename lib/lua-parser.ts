import * as Lua from "npm:luaparse"
import * as Annotation from "./annotation-parser.ts"

export function parse(source: string) {
    const parsedCommentMap = new Map<Lua.Statement, Annotation.ASTNode[]>()
    const commentBlocks = new Set<Annotation.ASTNode[]>();
    const commentGroupRange = new Map<Annotation.ASTNode[], { from: number, to: number }>();
    const statementComments = new Set<Annotation.ASTNode[]>();

    const ast = Lua.parse(source, { comments: true, ranges: true, locations: true, scope: true, luaVersion: "5.3" })

    // First off, group all comments into blocks
    // This is done by checking if the comments are adjacent to each other
    if (ast.comments) {
        const handledComments = new Set<Lua.Comment>();
        let currentBlock: Lua.Comment[] = [];
        let fromLine = -1;
        let toLine = -1;

        for (const comment of ast.comments as unknown as Lua.Comment[]) {
            if (handledComments.has(comment)) continue;

            const line = comment.loc!.start.line;

            if (currentBlock.length === 0 || line === toLine + 1) {
                if (currentBlock.length === 0) fromLine = line;
                toLine = line;
                currentBlock.push(comment);
                handledComments.add(comment);
            } else {
                if (currentBlock.length > 0) {
                    const astNodes = Annotation.parseAnnotations(currentBlock.map(c => c.raw));
                    commentBlocks.add(astNodes);
                    commentGroupRange.set(astNodes, { from: fromLine, to: toLine });
                }
                currentBlock = [comment];
                fromLine = line;
                toLine = line;
                handledComments.add(comment);
            }
        }

        // Handle the last block
        if (currentBlock.length > 0) {
            const astNodes = Annotation.parseAnnotations(currentBlock.map(c => c.raw));
            commentBlocks.add(astNodes);
            commentGroupRange.set(astNodes, { from: fromLine, to: toLine });
        }
    }


    for (const node of ast.body) {
        // Find comments right above the node
        const line = node.loc!.start.line;

        // Find comment block that is right above the node
        const commentBlock = Array.from(commentBlocks).find(block => {
            const range = commentGroupRange.get(block);
            if (!range) return false;
            return range.to === line - 1 || (range.from === range.to && range.to === line - 1);
        });

        if (commentBlock) {
            parsedCommentMap.set(node, commentBlock);
            statementComments.add(commentBlock);
        } else {
            parsedCommentMap.set(node, []);
        }

        // Find comment blocks unrelated to statements

    }
    const standaloneComments = Array.from(commentBlocks).filter(block => !statementComments.has(block)).filter(x => x.length > 0)

    return { parsedCommentMap, commentBlocks, standaloneComments };

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