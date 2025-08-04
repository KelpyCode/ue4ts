
interface Fixer {
    fileName?: string
    textProcessor?: (text: string) => string
}

export const FIXERS: Fixer[] = [
    {
        // fileName: "WBP_VideoMenu_ValueSwitcher.lua",
        textProcessor: (text: string) => {
            return text.replaceAll("function(self, )", "function(self)")
        }
    },

    {
        fileName: "BP_Flora_InteractibleObjects.lua",
        textProcessor: (text: string) => {
            // Remove lines with hard to parse content
            return text.split("\n").filter(x => !x.includes("['Pod  |")).join("\n")
        }
    }
]