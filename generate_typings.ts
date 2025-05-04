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
      if(!match[1]) return "() => any"
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

  if(HARD_MAP[type]) {
    return HARD_MAP[type]
  }
  return type
}

function getMappedTypes(types: string): string[] {
  return types.split("|").map(t => getMappedType(t))
}


function parseLuaToTypeScript(luaFilePath: string, outputDir: string, typeMap: Map<string, string>) {
  const definitions = new Map<string, DefinitionEntry>();

  const luaContent = fs.readFileSync(luaFilePath, "utf-8");
  const lines = luaContent.split("\n");

  let result = "";
  let insideType = false;
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


      if (def === "@class") {
        if (currentDefinition.type) {
          definitions.set(currentDefinition.name!, currentDefinition as DefinitionEntry);
          currentDefinition = generateDefault();
        }
        
        const regex = /\s+(\w+)(?:<([\w, ]+?)>)/gm
        const match = regex.exec(line);
        if (match) {
          currentDefinition.name = match[1];
          currentDefinition.generics = match[2] ? match[2].split(",").map(g => g.trim()) : [];
        }
        currentDefinition.type = "class"
        currentDefinition.name = name

        if (third === ":") {
          let rest = line.substring(line.indexOf(":") + 1).trim();
          currentDefinition.extends = rest;
          usedTypes.add(rest);
        }

      } else if (def === "@enum") {
        if (currentDefinition.type && currentDefinition.name) {
          definitions.set(currentDefinition.name!, currentDefinition as DefinitionEntry);
          currentDefinition = generateDefault();
        }

        currentDefinition.type = "enum"
        currentDefinition.name = name;
      } else if (def === "@field") {
        const comment = parts.slice(3).join(" ")
        currentDefinition.fields!.push({ name, types: getMappedTypes(third), comment });
        usedTypes.add(getMappedType(third));
      } else if (def === "@param") {
        const rest = line.substring(`---@param ${name} `.length).trim();
        const regex = /--- *@param (?:(\w+) *(fun\((?:.*?)\)|(?:\(?(?:\w+ *\| *)*(?: *\w+)\)?\??)))( *.*$)/gm
        const match = regex.exec(line);

        if (name === "...") {
          currentDefinition.fields!.push({ name: "...args", types: [getMappedType(third)] });
          usedTypes.add(getMappedType(third));
        } else {
          if (match) {
            const fnDef = match[2].startsWith("fun(")
            const types = !fnDef ? getMappedTypes(match[2]) : [getMappedType(match[2])];
            currentDefinition.fields!.push({ name, types, comment: match[3]?.trim() ?? '' });
            usedTypes.add(getMappedType(match[2]));
          } else {
            currentDefinition.fields!.push({ name, types: [getMappedType(third)] });
          }
          usedTypes.add(getMappedType(third));
        }
      } else if (def === "|") {
        // ---| `PropertyTypes.ObjectProperty`
        currentDefinition.aliases?.push(name);
      } else if (def === "@alias") {
        currentDefinition.type = "alias"
        currentDefinition.name = name;

        if (third) {
          currentDefinition.aliases?.push(getMappedType(third));
          usedTypes.add(getMappedType(third));
          definitions.set(name, currentDefinition as DefinitionEntry);
          currentDefinition = generateDefault();
        }

      } else if (def === "@return") {
        const l = line.substring("---@return".length).split(", ")
        l.forEach(t => usedTypes.add(getMappedType(t)))
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

      console.log(line)


      // Finish type definition
      if (insideType && line.trim() === "}") {
        insideType = false;
        if(currentDefinition.name) {
          definitions.set(currentDefinition.name!, currentDefinition as DefinitionEntry);
          currentDefinition = generateDefault();
        }
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
          definitions.set(currentDefinition.name, currentDefinition as DefinitionEntry);
          currentDefinition = generateDefault();
        }
        continue
      }

      // function something(...) end | something['name'] = function(...) end
      regex = /(?:function *([\w]+)(?:(?::|.)([\w]+))?\(.*?\) *end|([\w]+)\['(.+?)'] = function\(.+?\) * end)/gm
      match = regex.exec(line);
      if (match) {
        let _class = match[1] || match[3];
        let fnName = match[2] || match[4];
        let _static = !line.includes(":") || _class === undefined;

        if (_class && fnName) {
          currentDefinition.name = `${_class}:${fnName}`;
          currentDefinition.type = "function";
          currentDefinition.static = _static;

          definitions.set(currentDefinition.name, currentDefinition as DefinitionEntry);
          currentDefinition = generateDefault();
          continue;
        } else if (!fnName && _class) {
          currentDefinition.name = _class
          currentDefinition.type = "function";
          currentDefinition.static = _static;

          definitions.set(currentDefinition.name, currentDefinition as DefinitionEntry);
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


      throw new Error(`Unhandled line: ${line}`);
    }


  }
  definitions.forEach(def => {
    result += definitionToTypeScript(def, definitions)
  })

  // Write the result to a .d.ts file
  const relativePath = path.relative(path.join(import.meta.dirname!, "shared"), luaFilePath);
  const outputFilePath = path.join("tstypes", relativePath.replace(/\.lua$/, ".d.ts"));
  fs.mkdirSync(path.dirname(outputFilePath), { recursive: true });
  fs.writeFileSync(outputFilePath, result, "utf-8");
  console.log(`🟢 ${outputFilePath}`);
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
    result += `declare class ${def.name}`;

    if (!def.generics?.length) {
      // If extends has generics, add them to the class
      const regex = /<([\w\s,]+?)>/gm;
      const match = regex.exec(def.extends ?? "");
      if (match) {
        result += `<${match[1]}>`;
      }
    } else if(!def.name.includes("<")) {
      result += `<${def.generics!.join(", ")}>`;
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
      const realName = func.name.split(":")[1]

      result += renderComments(func.comments ?? [])
      result += `  ${func.static ? 'static ' : ''}${realName}(${func.fields!.map(f => `${f.name}: ${f.types.join(" | ")}`).join(", ")}): ${func.returnType ?? 'void'};\n`
    }

    result += "}\n";
  } else if (def.type === "enum") {
    result += renderComments(def.comments ?? [])
    result += `declare enum ${def.name} {\n`;
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

    result += `declare function ${def.name}(${args}): ${def.returnType ?? 'void'};\n`;
  } else if (def.type === "variable") {
    result += renderComments(def.comments ?? [])
    result += `declare const ${def.name} = ${def.returnType};\n`;
  } else if (def.type === "alias") {
    result += `declare type ${def.name} = ${def.aliases!.map(alias => alias).join(" | ")};\n`;
  } else {
    throw new Error(`Unhandled type conversion: ${def.type}`);
  }

  return result;
}


function generateTypeMap(sharedDir: string): Map<string, string> {
  const typeMap = new Map<string, string>();
  const files = glob("**/*.lua", { cwd: sharedDir });

  files.forEach((file) => {
    const filePath = path.join(sharedDir, file);
    const luaContent = fs.readFileSync(filePath, "utf-8");
    const classRegex = /---@class\s+(\w+)(?:<([\w, ]+?)>)?/g;
    let match;
    while ((match = classRegex.exec(luaContent)) !== null) {
      const className = match[1];
      const generics = match[2] ? match[2].split(",").map(g => g.trim()) : [];
      typeMap.set(className, filePath);
    }
  });

  return typeMap;
}

// Define paths
const sharedDir = path.join(import.meta.dirname!, "shared");
const outputDir = path.join(import.meta.dirname!, "tstypes");

// Generate type map
const typeMap = generateTypeMap(sharedDir);

// Process each Lua file
// const luaFiles = glob("**/*.lua", { cwd: sharedDir });
const luaFiles = glob("**/Types.lua", { cwd: sharedDir });
luaFiles.forEach((file) => {
  const luaFilePath = path.join(sharedDir, file);
  parseLuaToTypeScript(luaFilePath, outputDir, typeMap);
});

console.log('👍 Done')
