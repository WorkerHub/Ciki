/**
 * 代码块的语言选项。lowlight 的 common 包已经注册了这些语言，
 * 这里的顺序就是用户在语言下拉里看到的顺序（常用语言在前）。
 * 语言名是专有名词，不随界面语言变化；唯一可翻译的「纯文本」在 locale 里
 * （editor.languages.plaintext），由调用方渲染时给出。
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
  { value: "makefile", label: "Makefile" }
]

/**
 * 语言代码 → 显示名。空值返回 null，交调用方回落「纯文本」的本地化文案；
 * 不在表里的代码原样返回（导入页面里可能出现未收录的语言）。
 */
export function languageLabel(
  language: string | null | undefined
): string | null {
  if (!language) return null
  return (
    COMMON_LANGUAGES.find((item) => item.value === language)?.label ?? language
  )
}
