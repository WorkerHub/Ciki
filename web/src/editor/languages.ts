/**
 * 代码块的语言选项。lowlight 的 common 包已经注册了这些语言，
 * 这里的顺序就是用户在语言下拉里看到的顺序（常用语言在前）。
 */

export const COMMON_LANGUAGES: { value: string; label: string }[] = [
  { value: "java", label: "Java" },
  { value: "sql", label: "SQL" },
  { value: "javascript", label: "JavaScript" },
  { value: "typescript", label: "TypeScript" },
  { value: "json", label: "JSON" },
  { value: "bash", label: "Bash" },
  { value: "shell", label: "Shell" },
  { value: "python", label: "Python" },
  { value: "go", label: "Go" },
  { value: "rust", label: "Rust" },
  { value: "c", label: "C" },
  { value: "cpp", label: "C++" },
  { value: "csharp", label: "C#" },
  { value: "kotlin", label: "Kotlin" },
  { value: "swift", label: "Swift" },
  { value: "php", label: "PHP" },
  { value: "ruby", label: "Ruby" },
  { value: "objectivec", label: "Objective-C" },
  { value: "xml", label: "XML / HTML" },
  { value: "css", label: "CSS" },
  { value: "scss", label: "SCSS" },
  { value: "less", label: "Less" },
  { value: "yaml", label: "YAML" },
  { value: "ini", label: "INI" },
  { value: "markdown", label: "Markdown" },
  { value: "graphql", label: "GraphQL" },
  { value: "diff", label: "Diff" },
  { value: "makefile", label: "Makefile" },
  { value: "plaintext", label: "纯文本" }
]

export function languageLabel(language: string | null | undefined): string {
  if (!language) return "纯文本"
  return (
    COMMON_LANGUAGES.find((item) => item.value === language)?.label ?? language
  )
}
