import * as fs from "node:fs";
import * as path from "node:path";
import { globSync as glob } from "npm:glob";


const HARD_MAP = {
  "integer": "number",
  "nil": "null",
  "function": "() => void",
  "table": "Record<string, any>",
  "UFunctionParams": "any[]"
} as Record<string, string>

const REPLACERS = {
  "TArray": def => {
    delete def.extends
    def.fields?.push({ name: "[index: number]", types: ["T"] });

    return def
  },
  "TSet": def => {
    delete def.extends
    def.fields?.push({ name: "[index: any]", types: ["null"] });

    return def
  }
} as Record<string, (def: DefinitionEntry) => DefinitionEntry>

const INTERNAL_TYPES = [
  "string",
  "number",
  "boolean",
  "any",
  "void",
  "null",
  "undefined",
  "object",
  "Record",
  "fun",
  "self",
  "() => void",
] 

interface FieldEntry {
  name: string;
  types: string[];
  comment?: string;
}


interface DefinitionEntry {
  type: "enum" | "class" | "function" | "variable" | "alias";
  name: string;
  aliases?: string[]
  comments?: string[];
  generics?: string[];
  fields?: FieldEntry[];
  returnType?: string;
  extends?: string
  enumEntires?: Array<[string, string]>
  static?: boolean
}

function generateDefault() {
  return { comments: [], fields: [], enumEntires: [], aliases: [], generics: [] }
}

function getMappedType(type: string): string {
  if (type?.startsWith("fun(")) {
    // fun(self: UObject, ...)
    const regex = /fun\((.*?)\)/gm
    const match = regex.exec(type);
    if (match) {
      if (!match[1]) return "() => any"
      const args = match[1].split(",").map(arg => arg.trim().split(":").map(a => a.trim()));

      let str = "(";
      str += args.map(arg => {
        if (arg[0] === "...") return "...args: any[]"
        return `${arg[0]}: ${getMappedType(arg[1])}`
      }).join(", ");

      str += ") => any"
      return str
    }
  }

  if (type?.endsWith("?")) {
    if (HARD_MAP[type]) {
      return HARD_MAP[type] + " | null"
    }
    return type.slice(0, -1) + " | null"
  }

  if (HARD_MAP[type]) {
    return HARD_MAP[type]
  }
  return type
}

function getUsedTypes(type: string): string[] {
  // Extract all types from the string
  // Something<T, U, V> -> [Something, T, U, V]
  // A|B|C -> [A, B, C]
  // Something[] -> [Something]
  // Something<T, U, V>[] -> [Something, T, U, V]
  // fun(test: string, test2: number): Something -> [test, test2, Something]
  // fun(test: string, test2: number): Something[] -> [test, test2, Something]
  // fun(test: string, test2: number) -> [test, test2]
  
  const arrayRegex = /^(.*)\[\]$/;
  const genericRegex = /(\w+)<([^>]+)>/g;
  const unionRegex = /(\w+)/g;
  const funRegex = /^(fun\((.*?)\)|(\w+)<([^>]+)>|(\w+)\[\]|(\w+)(?:\s*\|\s*(\w+))*)/;
  const funMatch = funRegex.exec(type);
  const usedTypes: Set<string> = new Set();

  let found = false

  if (funMatch) {
    found = true;
    if (funMatch[1]) {
      // Function type
      const args = funMatch[2]?.split(",").map(arg => arg.trim().split(":").map(a => a.trim())) || [];
      args.forEach(arg => getUsedTypes(arg[1]) .forEach(x => usedTypes.add(x)));
    } else if (funMatch[3]) {
      // Generic type
      usedTypes.add(funMatch[3]);
      funMatch[4]?.split(",").forEach(g => usedTypes.add(g.trim()));
    } else if (funMatch[5]) {
      // Array type
      usedTypes.add(funMatch[5]);
    } else if (funMatch[6]) {
      // Union type
      type.split("|").map(t => t.trim()).forEach(t => usedTypes.add(t));
    }
  }


  if(!found) {
    if (arrayRegex.test(type)) {
      const match = arrayRegex.exec(type);
      if (match) {
        found = true
        usedTypes.add(match[1]);
      }
    }
  }

  if(!found) {
    type.replace(genericRegex, (match: string, p1: string, p2: string) => {
    found = true
    usedTypes.add(p1);
    p2.split(",").forEach(g => usedTypes.add(g.trim()));
    return match;
  });
  }

  if (!found) {
    type.replace(unionRegex, (match: string) => {
      found = true
      usedTypes.add(match);
      return match;
    });
  }

  return Array.from(usedTypes);
}

function getMappedTypes(types: string): string[] {
  return types.split("|").map(t => getMappedType(t))
}

class Timer {
  private start: number;
  private end: number;

  getIndent() {
    return Array(this.indent).fill("  ").join("");
  }

  constructor(public name: string, public indent = 0) {
    this.start = Date.now();
    this.end = 0;
    console.log(`${this.getIndent()}🔵 ${this.name}`);
  }

  stop() {
    this.end = Date.now();
    const ms = this.end - this.start;
    const seconds = Math.floor(ms / 1000);

    console.log(`${this.getIndent()}🟢 ${this.name}: ${seconds < 2 ? ms + 'ms' : seconds + 's'}`);
  }
}

function runReplacer(def: DefinitionEntry): DefinitionEntry {
  for (const key in REPLACERS) {
    if (removeGenerics(def.name) === key) {
      const replacer = REPLACERS[key];
      def = replacer(def);
    }
  }
  return def;
}

function removeGenerics(type: string): string {
  if (!type) return type
  const idx = type.indexOf("<");
  if (idx !== -1) {
    return type.substring(0, idx);
  }
  return type;
}

function setDefinition(definitions: Map<string, DefinitionEntry>, def: Partial<DefinitionEntry>): void {
  if (def.name) {
    definitions.set(def.name, runReplacer(def as DefinitionEntry));
  }
}

function generateDefinitions(luaFilePath: string) {
  const definitions = new Map<string, DefinitionEntry>();

  const luaContent = fs.readFileSync(luaFilePath, "utf-8");
  const lines = luaContent.split("\n");

  let insideType = false;
  let insideFn = false;
  let currentDefinition: Partial<DefinitionEntry> = generateDefault();
  let usedTypes = new Set<string>();

  for (const line of lines) {
    // Check if starts with ---
    if (line.startsWith("---")) {
      const trimmedLine = line.trim().substring(3).trim();
      const parts = trimmedLine.split(" ");
      const def = parts[0];
      const name = parts[1];
      const third = parts[2];
      const fourth = parts[3];
      const thirdRest = parts.slice(2).join(" ").trim();

      if (def === "@class") {
        if (currentDefinition.type) {
          setDefinition(definitions, currentDefinition);
          currentDefinition = generateDefault();
        }

        const regex = /\s+(\w+)(?:<([\w, ]+?)>)/gm
        const match = regex.exec(line);
        if (match) {
          currentDefinition.name = match[1];
          currentDefinition.generics = match[2] ? match[2].split(",").map(g => g.trim()) : [];
        }
        currentDefinition.type = "class"
        currentDefinition.name = removeGenerics(name)

        if (third === ":") {
          let rest = line.substring(line.indexOf(":") + 1).trim();
          currentDefinition.extends = rest;
          getUsedTypes(rest).forEach(type => usedTypes.add(getMappedType(type)));
        }

      } else if (def === "@enum") {
        if (currentDefinition.type && currentDefinition.name) {
          setDefinition(definitions, currentDefinition);
          currentDefinition = generateDefault();
        }

        currentDefinition.type = "enum"
        currentDefinition.name = name;
      } else if (def === "@field") {
        const comment = parts.slice(3).join(" ")
        const typeData = readType(thirdRest);
        typeData.usedTypes.forEach(type => usedTypes.add(getMappedType(type)));
        currentDefinition.fields!.push({ name, types: [typeData.type], comment });

        const genericRegex = /(\w+)<(.+)>/;
        const genericMatch = genericRegex.exec(thirdRest);

        if (genericMatch) {
          const baseType = genericMatch[1];
          const genericTypes = genericMatch[2].split(",").map(t => t.trim());

          genericTypes.forEach(type => usedTypes.add(getMappedType(type)));
          
          usedTypes.add(removeGenerics(baseType));
          genericTypes.forEach(type => usedTypes.add(getMappedType(type)));
        } else {
          const typeData = readType(thirdRest);
          typeData.usedTypes.forEach(type => usedTypes.add(getMappedType(type)));
        }
      } else if (def === "@param") {
        const rest = line.substring(`---@param ${name} `.length).trim();
        const regex = /--- *@param (?:(\w+) *(fun\((?:.*?)\)|(?:\(?(?:\w+ *\| *)*(?: *\w+)\)?\??))(?::\s*([A-Za-z?|<>]+))?)( *.*$)/gm
        const match = regex.exec(line);

        if (name === "self") {
          currentDefinition.fields!.push({ name: "this", types: ['void'] });
          getUsedTypes(third).forEach(type => usedTypes.add(getMappedType(type)));
        } else if (name === "...") {
          currentDefinition.fields!.push({ name: "...args", types: [getMappedType(removeGenerics(third))] });
          getUsedTypes(third).forEach(type => usedTypes.add(getMappedType(type)));
        } else {
          if (match) {
            const fnDef = match[2].startsWith("fun(")
            const types = !fnDef ? getMappedTypes(match[2]) : [getMappedType(match[2]) + (match[3] ?? '')];
            
            currentDefinition.fields!.push({ name, types, comment: match[4]?.trim() ?? '' });
            
            getUsedTypes(match[2]).forEach(type => usedTypes.add(getMappedType(type)));

          } else {
            currentDefinition.fields!.push({ name, types: [getMappedType(third)] });
          }
          getUsedTypes(third).forEach(type => usedTypes.add(getMappedType(type)));
        }
      } else if (def === "|") {
        // ---| `PropertyTypes.ObjectProperty`
        currentDefinition.aliases?.push(name);
      } else if (def === "@alias") {
        currentDefinition.type = "alias"
        currentDefinition.name = name;

        if (third) {
          currentDefinition.aliases?.push(getMappedType(third));
          getUsedTypes(third).forEach(type => usedTypes.add(getMappedType(type)));

          setDefinition(definitions, currentDefinition);
          currentDefinition = generateDefault();
        }

      } else if (def === "@return") {
        let line2 = line.substring("---@return".length).trim()
        // Remove  everything after # (comment)
        const index = line2.indexOf("#");
        if (index !== -1) {
          line2 = line2.substring(0, index);
        }
        line2 = line2.trim();


        const l = line2.split(", ")
        l.forEach(t => getUsedTypes(t).forEach(type => usedTypes.add(getMappedType(type))))
        if (l.length > 1) {
          currentDefinition.returnType = "[" + l.map(t => getMappedType(t.trim())).join(", ") + "]";
        } else
          currentDefinition.returnType = getMappedType(name);
      } else if (def === "@generic") {
        currentDefinition.generics!.push(name);
      } else if (def === "@meta") {
        continue
      } else if (!def.startsWith("@")) {
        currentDefinition.comments?.push(line.substring(3).trim());
      } else {
        throw new Error(`Unknown type: ${def}`);
      }

    } else {
      if (line.trim().length === 0) continue

      if (insideFn && line.startsWith("end")) {
        insideFn = false;
        setDefinition(definitions, currentDefinition);
        currentDefinition = generateDefault();
        continue
      } else if (insideFn) {
        continue
      }


      // Finish type definition
      if (insideType && line.trim() === "}") {
        insideType = false;
        setDefinition(definitions, currentDefinition);
        currentDefinition = generateDefault();
        continue
      }

      if (insideType) {
        if (currentDefinition.type === "enum") {
          const [key, value] = line.split("=");
          if (key && value && value.trim() !== "{") {
            currentDefinition.enumEntires!.push([key.trim(), value.trim()]);
          }
        }
        continue;
      }

      // local something = { ...}
      let regex = /(?:local )?([\w]+) *= *{/gm;
      let match = regex.exec(line);
      if (match) {
        const autoCloses = line.trim().split("").reverse()[0] === "}"
        insideType = !autoCloses
        currentDefinition.name = match[1];
        if (autoCloses) {
          if (!currentDefinition.type)
            currentDefinition.type = "class";
          setDefinition(definitions, currentDefinition);
          currentDefinition = generateDefault();
        }
        continue
      }

      // function something(...) end | something['name'] = function(...) end
      regex = /(?:function *([\w]+)(?:(?::|\.)([\w]+))?\(.*?\) *(?:end)?|([\w]+)\['(.+?)'] = function\(.+?\) * (?:end)?)/gm
      match = regex.exec(line);
      if (match) {
        let _class = match[1] || match[3];
        let fnName = match[2] || match[4];
        let end = line.trim().endsWith(" end")

        if (!end) {
          insideFn = true
        }

        let _static = !line.includes(":") || _class === undefined;

        if (_class && fnName) {
          currentDefinition.name = `${_class}:${fnName}`;
          currentDefinition.type = "function";
          currentDefinition.static = _static;

          handleDuplicateFns(definitions, currentDefinition);
          currentDefinition = generateDefault();
          continue;
        } else if (!fnName && _class) {
          currentDefinition.name = _class
          currentDefinition.type = "function";
          currentDefinition.static = _static;

          handleDuplicateFns(definitions, currentDefinition);
          currentDefinition = generateDefault();
          continue;
        }
      }

      if (line.startsWith("--")) {
        continue;
      }

      // SOMETHING = TEST(...)
      regex = /([\w]+) *= *([\w]+)\((.*)\)/gm;
      match = regex.exec(line);
      if (match) {
        const name = match[1];
        const type = match[2];

        currentDefinition.type = "variable";
        currentDefinition.name = name;
        currentDefinition.returnType = type;
        continue;
      }


      console.warn(`Unhandled line: ${line}`);
      // throw new Error(`Unhandled line: ${line}`);
    }


  }
  return { definitions, usedTypes }
}




function handleDuplicateFns(definitions: Map<string, DefinitionEntry>, currentDefinition: Partial<DefinitionEntry>) {
  const existing = definitions.get(currentDefinition.name!);
  if (existing) {
    // Merge params (fields)
    const newTypes = [] as FieldEntry[];
    for (let i = 0; i < Math.max(currentDefinition.fields?.length ?? 0, existing.fields?.length ?? 0); i++) {
      const field = currentDefinition.fields?.[i];
      const existingField = existing.fields?.[i];

      let types: string[] = [];

      if (field?.types.length) {
        types.push('(' + field?.types.join(" | ") + ")");
      }

      if (existingField?.types.length) {
        types.push('(' + existingField?.types.join(" | ") + ")");
      }

      if (!existingField?.types.length || !field?.types.length) {
        field!.name += "?"
      }

      newTypes.push({
        name: field?.name && existingField?.name ? `${existingField?.name}_or_${field?.name}` : field?.name ?? existingField?.name ?? '__ERROR__',
        types
      });
    }
    currentDefinition.fields = newTypes;
    setDefinition(definitions, currentDefinition);
  } else {
    setDefinition(definitions, currentDefinition);
  }
}

function renderComments(comments: string[]): string {
  if (comments.length === 0) return ""
  return `/**\n * ${comments.join("\n * ")}\n */\n`;
}

function definitionToTypeScript(def: DefinitionEntry, all: Map<string, DefinitionEntry>): string {
  let result = ""

  // Render comments
  // if (def.comments) {
  //   result += `/**\n * ${def.comments.join("\n * ")}\n */\n`;
  // }
  if (def.type === "class") {
    result += renderComments(def.comments ?? [])
    result += `export class ${def.name}`;

    if (!def.generics?.length) {
      // If extends has generics, add them to the class
      const regex = /<([\w\s,]+?)>/gm;
      const match = regex.exec(def.extends ?? "");
      if (match) {
        result += `<${match[1].split(",").map(g => g + " = any").join(", ")}>`;
      }
    } else if (!def.name.includes("<")) {
      result += `<${def.generics!.map(g => g + " = any").join(", ")}>`;
    }

    if (def.extends) {
      result += ` extends ${def.extends.split(" ").map(t => getMappedType(t)).join(" ")}`;
    }
    result += " {\n";
    if (def.fields) {
      for (const field of def.fields) {
        if (field.comment) {
          result += renderComments([field.comment])
        }
        result += `  ${field.name}: ${field.types.join(" | ")};\n`;
      }
    }

    // Get functions
    const funcs = all.values().filter(def2 => def2.type === "function" && def2.name.startsWith(def.name + ":"))

    for (const func of funcs) {
      let realName = func.name.split(":")[1]

      if (realName.includes(" ")) {
        realName = `['${realName}']`
      }

      result += renderComments(func.comments ?? [])
      result += `  ${func.static ? 'static ' : ''}${realName}(${func.fields!.map(f => `${f.name}: ${f.types.join(" | ")}`).join(", ")}): ${func.returnType ?? 'void'};\n`
    }

    result += "}\n";
  } else if (def.type === "enum") {
    result += renderComments(def.comments ?? [])
    result += `export enum ${def.name} {\n`;
    if (def.enumEntires) {
      for (const [key, value] of def.enumEntires) {
        result += `  ${key} = ${value}\n`;
      }
    }
    result += "}\n";
  } else if (def.type === "function") {
    if (def.name.includes(":")) return result // Handled in class
    result += renderComments(def.comments ?? [])

    const args = def.fields?.map(f => f.name + ": " + f.types.join(" | ")).join(", ") ?? ""

    result += `export function ${def.name}(${args}): ${def.returnType ?? 'void'};\n`;
  } else if (def.type === "variable") {
    result += renderComments(def.comments ?? [])
    result += `export const ${def.name} = ${def.returnType};\n`;
  } else if (def.type === "alias") {
    result += `export type ${def.name} = ${def.aliases!.map(alias => alias).join(" | ")};\n`;
  } else {
    throw new Error(`Unhandled type conversion: ${def.type}`);
  }

  return result;
}

const MODULE = false

function parseLuaFile(luaFilePath: string, definitions: Map<string, DefinitionEntry>, usedType: Set<string>, definitionLocations: Map<string, string>) {
  // let result = "declare global {\n";
  let result = ""

  // Generate imports
  const types = [...usedType].filter(type => !INTERNAL_TYPES.includes(type));
  const importsMap = new Map<string, Set<string>>();

  types.forEach(type => {
    const location = definitionLocations.get(type);
    if (location && location !== luaFilePath) {
      const relativePath = path.relative(path.dirname(luaFilePath), location).replace(/\.lua$/, "");
      if (!importsMap.has(relativePath)) {
        importsMap.set(relativePath, new Set());
      }
      importsMap.get(relativePath)!.add(type);
    }
  });

  const unusedTypes = new Set<string>();

  const imports = Array.from(importsMap.entries()).map(([relativePath, types]) => {
    return `import type { ${Array.from(types).join(", ")} } from "./${relativePath.replaceAll("\\", "/")}.d.ts";`;
    // return `/// <reference path="./${relativePath.replaceAll("\\", "/")}.d.ts" />`;
  });

  const invalidTypes = types.filter(type => !definitionLocations.has(type));

    invalidTypes.forEach(type => unusedTypes.add(type));

  //   return `import type { ${validTypes.join(", ")} } from "./${relativePath.replaceAll("\\", "/")}.d.ts";`;
  // });

  
  result += imports.join("\n") + "\n\n";
  
  if (unusedTypes.size > 0) {
    console.warn("⚠️ Unused types detected:");
    console.warn(Array.from(unusedTypes).join(", "));

    // Generate any type definitions for those files
    unusedTypes.forEach(type => {
      result += `declare type ${type} = any; // Not found in definitions\n`;
    });
  }
  if (MODULE)
    result += "export {};\ndeclare global {\n";

  definitions.forEach(def => {
    result += definitionToTypeScript(def, definitions)
  })

  if (MODULE)
    result += "}\n"
  // result += "}\n\nexport {};\n";
  // Write the result to a .d.ts file
  const relativePath = path.relative(path.join(import.meta.dirname!, "shared"), luaFilePath);
  const outputFilePath = path.join("tstypes", relativePath.replace(/\.lua$/, ".d.ts"));
  if (fs.existsSync(outputFilePath)) {
    const existingContent = fs.readFileSync(outputFilePath, "utf-8");
    if (existingContent === result) {
      console.log(`🟡 Skipping ${outputFilePath} (no changes)`);
      return;
    }
  }
  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  fs.writeFileSync(outputFilePath, result, "utf-8");
  // console.log(`🟢 ${outputFilePath}`);
}


/**  ----------------------------------------------------------------- */
// Define paths
const sharedDir = path.join(import.meta.dirname!, "shared");
const outputDir = path.join(import.meta.dirname!, "tstypes");

// Generate type map
// const typeMap = generateTypeMap(sharedDir);

// Process each Lua file
// const luaFiles = glob("**/*.lua", { cwd: sharedDir });
const luaFiles = glob(process.argv[2] || "**/*.lua", { cwd: sharedDir });
const definitionLocations = new Map<string, string>();
const locationDefinitions = new Map<string, Map<string, DefinitionEntry>>();
const locationUsedTypes = new Map<string, Set<string>>();

const transpilationTimer = new Timer("Transpiling types");
const processTimer = new Timer(`Process ${luaFiles.length} Lua files`, 1);
luaFiles.forEach((file) => {
  const baseDir = import.meta.dirname!;
  const luaFilePath = path.join(sharedDir, file);
  const luaFileTimer = new Timer(`Processing ${file}`, 2);
  try {

    const { definitions: defs, usedTypes } = generateDefinitions(luaFilePath);

    const luaFilePathRelative = path.relative(path.join(baseDir, "shared"), luaFilePath);

    defs.forEach(def => {
      if (!luaFilePath.endsWith("Type.lua") && definitionLocations.has(def.name)) {
        return; // Skip overwriting if the file is "Type.lua" and a definition already exists
      }
      definitionLocations.set(def.name, luaFilePath);
    });
    if (!locationDefinitions.has(luaFilePath)) {
      locationDefinitions.set(luaFilePath, new Map<string, DefinitionEntry>());
    }
    locationDefinitions.set(luaFilePath, defs);
    locationUsedTypes.set(luaFilePath, usedTypes);
  } catch (e) {
    console.error(`Error processing file ${file}`);
    throw e;
  } finally {
    luaFileTimer.stop();
  }
});
processTimer.stop();
const generationTimer = new Timer(`Generating ${luaFiles.length} TypeScript files`, 1);
luaFiles.forEach((file) => {
  const luaFilePath = path.join(sharedDir, file);
  const luaFileTimer = new Timer(`Generating ${file}`, 2);
  const defs = locationDefinitions.get(luaFilePath);
  if (defs) {
    const usedTypes = locationUsedTypes.get(luaFilePath);
    parseLuaFile(luaFilePath, defs, usedTypes ?? new Set(), definitionLocations);
  }
  luaFileTimer.stop();

});
generationTimer.stop();

// Generate index.d.ts that imports and exports all the types
const indexFilePath = path.join(outputDir, "index.d.ts");
const indexContent = luaFiles.map(file => {
  const relativePath = file.replace(/\.lua$/, ".d.ts").replaceAll("\\", "/");
  // return `/// <reference path="./${relativePath}" />`
  return `export type * from "./${relativePath}"`
}).join("\n");

fs.writeFileSync(indexFilePath, indexContent, "utf-8");

fs.writeFileSync("./debug.definitionLocations.json", Array.from(definitionLocations.entries()).filter(x => !x[0].includes(":")).map(x => x[0] + " : " + path.relative(sharedDir,x[1])).join("\n"), "utf-8");

transpilationTimer.stop()
console.log(`🟢 ${indexFilePath}`);

console.log('👍 Done')



function readType(str: string): { type: string, usedTypes: string[], comment: string } {
  // Read fun, generic, array, union types.
  // fun: fun(test: string, test2: number) Some comment
  // generic: Something<T, U> Some comment
  // array: Something[] Some comment
  // union: Something | Something2 Some comment
  // type: Full type string without comment
  // usedTypes: Array of types used in the type string
  // comment: Comment string


  const regex = /^(fun\((.*?)\)|(\w+)<([^>]+)>|(\w+)\[\]|(\w+)(?:\s*\|\s*(\w+))*)/gm;
  const match = regex.exec(str);
  if (match) {
    const type = match[0];
    const usedTypes = getUsedTypes(type);
    const comment = str.substring(type.length).trim();
    return { type, usedTypes, comment };
  }
  return { type: str, usedTypes: [], comment: "" };

}
