// Ambient declaration so `import SCHEMA_SQL from "./schema.sql" with { type: "text" }`
// (Bun bundler text-import) typechecks under TypeScript. The runtime value
// is the file's contents as a string; Bun's bundler inlines it at build
// time so `bun build --compile` embeds the SQL in the binary.
declare module "*.sql" {
  const content: string;
  export default content;
}
