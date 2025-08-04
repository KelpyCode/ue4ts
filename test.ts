import { expect } from "jsr:@std/expect";
import * as AnnotationParser from "./lib/annotation-parser.ts"
await Deno.test("Annotation parser", async (t) => {
    await t.step("Parse class", async (t2) => {
        const input = `
        ---@class TestClass
        ---@field testField integer
        
        ---@class TestClassExtended : TestClass
        `

        const result = AnnotationParser.parseAnnotations(input.split("\n"))
        console.log(result)
        await t2.step("Has class TestClass at index 0", async t3 => {
            expect(result.at(0)).toMatchObject({ kind: "class", name: "TestClass", generics: [] })
        })

        await t2.step("Has field testField at index 1", async t3 => {
            expect(result.at(1)).toMatchObject({ kind: "field", name: "testField", type: { kind: "simple", name: "integer" } })
        })

        await t2.step("Has class TestClassExtended with extends TestClass at index 2", async t3 => {
            expect(result.at(2)).toMatchObject({ kind: "class", name: "TestClassExtended", generics: [], extends: "TestClass" })
        })
    })
})